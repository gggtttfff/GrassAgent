// src/outputBound.ts
// 大文件和长命令只把尾部交给模型。全文留在世界自己的临时区,
// 这样远程调用不会把 100MB 拉进 Grass 进程,路径也还能被同一个世界读到。

import { createReadStream, createWriteStream } from 'node:fs'
import { open, mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { EncodingError } from './executionWorld.ts'

/** 和原来的工具截断行数一致,模型看到的尾部长度不变。 */
export const MAX_OUTPUT_LINES = 200

/**
 * 返回给模型的文本上限。超过的部分只留在临时文件里。
 * 设在这一档是为了滚动缓冲始终只有这一小块,不随文件变大。
 */
export const MAX_OUTPUT_BYTES = 256 * 1024

const READ_CHUNK_BYTES = 64 * 1024

let spillCounter = 0

/**
 * 这个世界存放完整输出的目录,位于工作区内部,后续 read 才过得了沙箱。
 * 作者：Pieory 创建日期：2025-07-18
 */
export function spillDirectory(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.grass', 'tmp')
}

/**
 * 按块读文件,内存里只留尾部。非法 UTF-8 直接失败,不替换成占位字符。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function presentFile(
  filePath: string,
  workspaceRoot: string,
  displayPath: (localPath: string) => string = (localPath) => localPath,
): Promise<string> {
  const opened = await open(filePath, 'r')
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunk = Buffer.alloc(READ_CHUNK_BYTES)
  let rolling = Buffer.alloc(0)
  let totalBytes = 0
  let newlineCount = 0
  let trimmed = false
  try {
    while (true) {
      const { bytesRead } = await opened.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      const piece = chunk.subarray(0, bytesRead)
      totalBytes += bytesRead
      for (let index = 0; index < bytesRead; index++) {
        if (piece[index] === 0x0a) newlineCount++
      }
      try {
        decoder.decode(piece, { stream: true })
      } catch (error) {
        throw new EncodingError(filePath, (error as Error).message)
      }
      rolling = Buffer.concat([rolling, Buffer.from(piece)])
      if (rolling.length > MAX_OUTPUT_BYTES) {
        rolling = rolling.subarray(rolling.length - MAX_OUTPUT_BYTES)
        trimmed = true
      }
    }
    try {
      decoder.decode()
    } catch (error) {
      throw new EncodingError(filePath, (error as Error).message)
    }
  } finally {
    await opened.close()
  }

  if (totalBytes === 0) return ''
  const totalLines = newlineCount + 1
  const tail = decodeTail(rolling, trimmed)
  if (!trimmed && totalLines <= MAX_OUTPUT_LINES) return tail

  const directory = spillDirectory(workspaceRoot)
  await mkdir(directory, { recursive: true })
  const spillPath = path.join(directory, nextSpillName())
  await pipeline(createReadStream(filePath), createWriteStream(spillPath))
  return formatTruncation({
    kept: lastLines(tail, MAX_OUTPUT_LINES),
    totalLines,
    totalBytes,
    trimmed,
    fullPath: displayPath(spillPath),
  })
}

/**
 * 把已经在内存里的命令输出收成尾部。调用方保证 text 本身不超过字节上限,
 * 这里只处理行数过多的情况。作者：Pieory 创建日期：2025-07-18
 */
export async function presentText(
  text: string,
  workspaceRoot: string,
  displayPath: (localPath: string) => string = (localPath) => localPath,
): Promise<string> {
  if (!text) return ''
  const lines = text.split('\n')
  if (lines.length <= MAX_OUTPUT_LINES && Buffer.byteLength(text) <= MAX_OUTPUT_BYTES) return text
  const directory = spillDirectory(workspaceRoot)
  await mkdir(directory, { recursive: true })
  const spillPath = path.join(directory, nextSpillName())
  const { writeFile } = await import('node:fs/promises')
  await writeFile(spillPath, text, 'utf-8')
  const kept = lines.slice(-MAX_OUTPUT_LINES).join('\n')
  return formatTruncation({
    kept,
    totalLines: lines.length,
    totalBytes: Buffer.byteLength(text),
    trimmed: Buffer.byteLength(text) > MAX_OUTPUT_BYTES,
    fullPath: displayPath(spillPath),
  })
}

/**
 * 从子进程流里收输出。超过字节上限后改写入临时文件,内存里只滚动尾部。
 * 作者：Pieory 创建日期：2025-07-18
 */
export async function captureStream(
  stream: AsyncIterable<Buffer | string>,
  workspaceRoot: string,
  displayPath: (localPath: string) => string = (localPath) => localPath,
): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let rolling = Buffer.alloc(0)
  let totalBytes = 0
  let newlineCount = 0
  let trimmed = false
  let spillPath: string | undefined
  let spillStream: ReturnType<typeof createWriteStream> | undefined

  try {
    for await (const piece of stream) {
      const buffer = typeof piece === 'string' ? Buffer.from(piece) : piece
      totalBytes += buffer.length
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] === 0x0a) newlineCount++
      }
      // 一旦超过上限,全文改走文件。刚越过的那一块要把已经在内存里的前缀一起写进去,
      // 否则临时文件会在切割点缺一段。
      if (spillStream) await writeChunk(spillStream, buffer)
      rolling = Buffer.concat([rolling, buffer])
      if (rolling.length > MAX_OUTPUT_BYTES) {
        if (!spillStream) {
          const directory = spillDirectory(workspaceRoot)
          await mkdir(directory, { recursive: true })
          spillPath = path.join(directory, nextSpillName())
          spillStream = createWriteStream(spillPath)
          await writeChunk(spillStream, rolling)
        }
        rolling = rolling.subarray(rolling.length - MAX_OUTPUT_BYTES)
        trimmed = true
      }
    }
  } finally {
    if (spillStream) {
      await new Promise<void>((resolve, reject) => {
        spillStream?.end(() => resolve())
        spillStream?.once('error', reject)
      })
    }
  }

  if (totalBytes === 0) {
    if (spillPath) await rm(spillPath, { force: true })
    return ''
  }
  const totalLines = newlineCount + 1
  const tail = decoder.decode(alignUtf8(rolling, trimmed))
  if (!trimmed && totalLines <= MAX_OUTPUT_LINES) {
    if (spillPath) await rm(spillPath, { force: true })
    return tail
  }
  if (!spillPath) {
    const directory = spillDirectory(workspaceRoot)
    await mkdir(directory, { recursive: true })
    spillPath = path.join(directory, nextSpillName())
    const { writeFile } = await import('node:fs/promises')
    await writeFile(spillPath, tail, 'utf-8')
  }
  return formatTruncation({
    kept: lastLines(tail, MAX_OUTPUT_LINES),
    totalLines,
    totalBytes,
    trimmed,
    fullPath: displayPath(spillPath),
  })
}

function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    stream.once('drain', () => resolve())
    stream.once('error', reject)
  })
}

function nextSpillName(): string {
  spillCounter += 1
  return `grassagent_output-${process.pid}-${spillCounter}.txt`
}

function alignUtf8(buffer: Buffer, trimmed: boolean): Buffer {
  if (!trimmed) return buffer
  let start = 0
  // 从字节窗口中间切开时,丢掉开头的 UTF-8 续字节,避免尾部本身解码失败
  while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) start++
  return buffer.subarray(start)
}

function decodeTail(buffer: Buffer, trimmed: boolean): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(alignUtf8(buffer, trimmed))
}

function lastLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(-maxLines).join('\n')
}

function formatTruncation(options: {
  kept: string
  totalLines: number
  totalBytes: number
  trimmed: boolean
  fullPath: string
}): string {
  if (options.totalLines > MAX_OUTPUT_LINES) {
    const shown = Math.min(MAX_OUTPUT_LINES, options.kept.split('\n').length)
    return `[output truncated:showing last ${shown} of ${options.totalLines} lines. full output :${options.fullPath}\n${options.kept}]`
  }
  return `[output truncated:showing last ${Buffer.byteLength(options.kept)} bytes of ${options.totalBytes} bytes. full output :${options.fullPath}\n${options.kept}]`
}
