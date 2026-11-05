//LLM流式回复->有tool_call就执行->结果放回Context->继续流式
//直到模型不再调用工具(end_turn/max_tokens)或被中断(aborted/error)
//直接import stream 
//pi 用streamFn参数注入支持替换后端,nano省略

import {stream ,buildAssistantMessage,buildToolResultMessage,type Model,type Context,type StreamOptions} from './llm.ts'
import { validateToolArguments } from './validation.ts'
import type { Transport } from './transport.ts'
import type { Logger } from './logger.ts'


//工具定义:name+描述+JSON Schema 参数+execute函数
export type AgentTool={
    name:string
    description:string
    parameters:object   //JSON Schema
    execute:(args:unknown,signal?:AbortSignal)=>Promise<string>
}

//agent 对外的事件流,提供UI消费
export type AgentEvent =
    | {type:'assistant_text';delta:string}
    | {type:'tool_call';id:string;name:string;args:unknown}
    | {type:'tool_result';id:string;name:string;result:string}
    | {type:'turn_end';stopReason:'end_turn'|'max_tokens'|'aborted'|'error'}

//compaction 触发阈值:消息数超过此值时压缩旧消息
const COMPACT_THRESHOLD=50
//compaction 保留近期消息数
const KEEP_RECENT=20

//对话压缩:当消息过多时,让LLM直接总结旧消息,用摘要替换
//教的是"context有上限,满了要压缩"--agent自管理上下文的核心能力
//pi的实现有token估算/cut point 边界/split turn 等,nano为消息条数近似
async function compactContext(model:Model,context:Context,signal?:AbortSignal,options:{transport?:Transport;logger?:Logger}={}):Promise<void>{
    if(signal?.aborted) return //abort时不压缩--避免空摘要损坏context
    if(context.messages.length<COMPACT_THRESHOLD) return

    const oldMessages=context.messages.slice(0,-KEEP_RECENT)
    const recentMessages=context.messages.slice(-KEEP_RECENT)

    //把旧消息序列化成纯文本让LLM总结
    const conversationText=oldMessages
    .map(m=>`${m.role}:${typeof m.content==='string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

    //用一轮非流式调用让LLM总结
    const summaryContext:Context={
        systemPrompt:'请将以下对话总结为简洁的上下文摘要,保留关键决策,已做的工作和待办事项.',
        messages:[{role:'user',content:conversationText}]
    }

    let summary=''
    let failed=false
    const summaryOptions:StreamOptions={signal,transport:options.transport,logger:options.logger}
    for await (const ev of stream(model,summaryContext,summaryOptions)){
        if (ev.type==='text_delta') summary+=ev.delta
        else if (ev.type==='error'||ev.type==='done'&&ev.stopReason==='aborted'){failed=true;break}
    }

    //压缩失败时不替换context--保留原始消息
    if(failed||!summary) return

    //用摘要消息替换就消息,保留近期消息
    context.messages=[
        {role:'user',content:`[context summary]\n${summary}`},
        ...recentMessages
    ]
}


//运行agent循环,无max_steps--loop到模型说停为止,pi无步数上限,但有shouldStopAfterTurn回调,nano省略
export async function* runAgent(
    model:Model,
    context:Context,
    tools:AgentTool[],
    signal?:AbortSignal,
    options:{transport?:Transport;logger?:Logger}={}
) :AsyncGenerator<AgentEvent>{
    const toolMap=new Map(tools.map(t=>[t.name,t]))
    const toolDefs=tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))
    while(true){

        //0.对话压缩:消息过多时先压缩旧消息
        await compactContext(model,context,signal,options)

        //1.流式调用LLM,收集文本和tool_calls
        let text=""
        let stopReason:'end_turn'|'tool_use'|'max_tokens'|'aborted'='end_turn'
        const toolCalls:{id:string;name:string;args:unknown;argsInvalid:boolean}[] =[]

        const streamOptions:StreamOptions={tools:toolDefs,signal,transport:options.transport,logger:options.logger}
        for await (const ev of stream(model ,context , streamOptions)){
            if(ev.type==='text_delta'){
                text+=ev.delta
                yield{type:'assistant_text',delta:ev.delta}
            }else if(ev.type==='tool_call'){
                toolCalls.push({id:ev.id,name:ev.name,args:ev.args,argsInvalid:ev.argsInvalid})
                yield{type:'tool_call',id:ev.id,name:ev.name,args:ev.args}
            }else if (ev.type==='done'){
                stopReason=ev.stopReason
                if(ev.stopReason==='aborted'){
                    //abort时丢弃tool_calls(无对应tool_result会导致session恢复后API报错)
                    context.messages.push(buildAssistantMessage(text,[]))
                    yield{type:'turn_end',stopReason:'aborted'}
                    return
                }
            }else if(ev.type==='error'){
                context.messages.push(buildAssistantMessage(text,[]))
                yield {type:'assistant_text',delta:`\n[error] ${ev.error.message}`}
                yield {type:'turn_end',stopReason:'error'}
                return
            }
        }

        //2.把assistant回复塞回context
        context.messages.push(buildAssistantMessage(text,toolCalls))

        //3.截断处理:max_tokens时tool args 可能不完整,不执行,把错误放回Context让模型重发
        if(stopReason==='max_tokens'&&toolCalls.length>0){
            const results=toolCalls.map(tc=>({
                tool_use_id:tc.id,
                content:`error:output truncated by max_tokens,tool"${tc.name}" args may be incomplete.`
            }))
            context.messages.push(buildToolResultMessage(results))
            for(let i=0;i<toolCalls.length;i++){
                yield {type:'tool_result',id:toolCalls[i].id,name:toolCalls[i].name,result:results[i].content}
            }
            continue
        }

        //4.没有tool_call结束循环
        //API 可能返回tool_use但无tool_call delta ,此时视为正常结束
        const reason =stopReason==='tool_use'?'end_turn':stopReason
        if(toolCalls.length===0){
            yield {type:'turn_end',stopReason:reason}
            return
        }

        //5.串行执行tool_calls(pi有sequential和parallel,nano只写串行)
        //参数校验在执行前做:不合法就不执行,把错误回填给模型让它重发
        //参数JSON损坏时不执行(argsInvalid):空对象会让工具拿到undefined参数乱写
        const results:{tool_use_id:string;content:string}[]=[]
        for(const tc of toolCalls){
            const tool =toolMap.get(tc.name)
            let result :string
            if (tc.argsInvalid){
                result=`error:tool"${tc.name}" arguments are not valid JSON,please resend complete arguments.`
            }else if (!tool){
                result=`error:tool "${tc.name} not found`
            }else{
                //校验并顺带做类型转换。模型传 "42" 当数字用会被转成 42,
                //转不了才算失败。失败时不执行工具,让模型看到错误后重新发
                const validation=validateToolArguments(tool.parameters,tc.args,tc.name)
                if(!validation.ok){
                    result=validation.error
                }else{
                    try{
                        //用校验后的参数执行,不是原始参数:类型转换的结果要生效
                        result=await tool.execute(validation.value,signal)
                    }catch(e){
                        result=`error: ${(e as Error).message}`
                    }
                }
            }
            results.push(({tool_use_id:tc.id,content:result}))
            yield{type:'tool_result',id:tc.id,name:tc.name,result}
            if (signal?.aborted) break
        }

        //6.为被abort 跳过的tool_call补上错误结果(API要求每个tool_call都有对应tool_result)
        for(const tc of toolCalls.slice(results.length)){
            results.push({tool_use_id:tc.id,content:'error:aborted'})
            yield{type:'tool_result',id:tc.id,name:tc.name,result:'error:aborted'}
        }

        //7.把tool_result放回Context
        context.messages.push(buildToolResultMessage(results))
    }
}