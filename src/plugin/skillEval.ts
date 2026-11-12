// src/plugin/skillEval.ts
// 技能评估。验证器在宿主这边,候选跑在新会话上,不改父会话的提示词。

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { SandboxUnavailableError } from '../world/executionWorld.ts'

export type SkillEvalCase = {
  id: string
  expectTrigger: boolean
  /** 触发时期望读到的技能名片段。 */
  skillName: string
  /** 内容用例的确定性检查。不该触发的用例不看正文。 */
  acceptText?: (text: string) => boolean
}

export type SkillEvalObservation = {
  triggered: boolean
  text: string
  paired: boolean
  unavailable: boolean
}

export type SkillEvalVariant = 'candidate' | 'previous' | 'baseline'

export type EffectDecision = 'adopt' | 'revert' | 'retire'

export type EffectCard = {
  changed: string
  tested: string[]
  fixed: string[]
  regressed: string[]
  unresolved: string[]
  elapsedMs: number
  decision: EffectDecision
  retestWhen: string
}

export type CaseScore = {
  id: string
  triggerPassed: boolean
  qualityPassed: boolean
}

/**
 * 一条用例过不过。触发看有没有读到技能,质量只在该触发时检查正文。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function scoreCase(testCase: SkillEvalCase, observation: SkillEvalObservation): CaseScore {
  const triggerPassed = observation.triggered === testCase.expectTrigger
  const qualityPassed = !testCase.expectTrigger || !testCase.acceptText
    ? true
    : testCase.acceptText(observation.text)
  return { id: testCase.id, triggerPassed, qualityPassed }
}

export function casePassed(score: CaseScore): boolean {
  return score.triggerPassed && score.qualityPassed
}

/**
 * 和上一版、无技能基线比。探测不可用或消息不配对就退回上一版。
 * 基线也能全过,说明技能可以退役。只看总分不够,退步按用例列出来。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function decideSkillChange(input: {
  candidate: readonly CaseScore[]
  previous: readonly CaseScore[]
  baseline: readonly CaseScore[]
  candidateUnusable: boolean
}): { decision: EffectDecision, fixed: string[], regressed: string[], unresolved: string[] } {
  const fixed: string[] = []
  const regressed: string[] = []
  const unresolved: string[] = []
  if (input.candidateUnusable) {
    return { decision: 'revert', fixed, regressed: ['probe-unusable'], unresolved }
  }
  const previousById = new Map(input.previous.map((score) => [score.id, score]))
  for (const score of input.candidate) {
    const before = previousById.get(score.id)
    const now = casePassed(score)
    const was = before ? casePassed(before) : false
    if (now && !was) fixed.push(score.id)
    if (!now && was) regressed.push(score.id)
    if (!now) unresolved.push(score.id)
  }
  if (regressed.length > 0) return { decision: 'revert', fixed, regressed, unresolved }
  const baselinePassedAll = input.baseline.length > 0 && input.baseline.every(casePassed)
  if (baselinePassedAll) return { decision: 'retire', fixed, regressed, unresolved }
  return { decision: 'adopt', fixed, regressed, unresolved }
}

export type SkillEvalRunner = (input: {
  variant: SkillEvalVariant
  testCase: SkillEvalCase
  sessionId: string
}) => Promise<SkillEvalObservation>

/**
 * 跑一轮评估。每个用例、每种变体用新的 sessionId,不挂回父会话的沙盒。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function evaluateSkillChange(options: {
  cases: readonly SkillEvalCase[]
  run: SkillEvalRunner
  changed: string
  cardDirectory: string
  parentSystemPrompt: string
}): Promise<{ decision: EffectDecision, card: EffectCard, parentSystemPrompt: string }> {
  const started = Date.now()
  const parentSystemPrompt = options.parentSystemPrompt
  const collected: Record<SkillEvalVariant, CaseScore[]> = {
    candidate: [],
    previous: [],
    baseline: [],
  }
  let candidateUnusable = false
  let sequence = 0
  for (const testCase of options.cases) {
    for (const variant of ['candidate', 'previous', 'baseline'] as const) {
      sequence += 1
      const sessionId = `skill-eval-${sequence}`
      let observation: SkillEvalObservation
      try {
        observation = await options.run({ variant, testCase, sessionId })
      } catch (error) {
        if (error instanceof SandboxUnavailableError) {
          observation = { triggered: false, text: '', paired: true, unavailable: true }
        } else {
          throw error
        }
      }
      if (variant === 'candidate' && (observation.unavailable || !observation.paired)) {
        candidateUnusable = true
      }
      collected[variant].push(scoreCase(testCase, observation))
    }
  }
  const outcome = decideSkillChange({
    candidate: collected.candidate,
    previous: collected.previous,
    baseline: collected.baseline,
    candidateUnusable,
  })
  const card: EffectCard = {
    changed: options.changed,
    tested: options.cases.map((testCase) => testCase.id),
    fixed: outcome.fixed,
    regressed: outcome.regressed,
    unresolved: outcome.unresolved,
    elapsedMs: Date.now() - started,
    decision: outcome.decision,
    retestWhen: '技能正文、模型或通过标准变了就重跑',
  }
  await appendEffectCard(options.cardDirectory, card)
  return { decision: outcome.decision, card, parentSystemPrompt }
}

/** 追加一张卡,不覆盖已经写下的。作者：Pieory 创建日期：2025-07-18 */
export async function appendEffectCard(directory: string, card: EffectCard): Promise<string> {
  await mkdir(directory, { recursive: true })
  const filePath = path.join(directory, 'cards.jsonl')
  await appendFile(filePath, `${JSON.stringify(card)}\n`, 'utf-8')
  return filePath
}

/** 作者：Pieory 创建日期：2025-07-18 */
export async function readEffectCards(directory: string): Promise<EffectCard[]> {
  const filePath = path.join(directory, 'cards.jsonl')
  let text: string
  try {
    text = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as EffectCard)
}
