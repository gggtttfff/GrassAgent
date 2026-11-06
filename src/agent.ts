//LLM流式回复->有tool_call就执行->结果放回Context->继续流式
//直到模型不再调用工具(end_turn/max_tokens)或被中断(aborted/error)
//直接import stream 
//pi 用streamFn参数注入支持替换后端,nano省略

import {stream ,buildAssistantMessage,buildToolResultMessage,type Model,type Context,type StreamOptions} from './llm.ts'
import { validateToolArguments } from './validation.ts'
import { withFileMutationQueue } from './mutationQueue.ts'
import type { Transport } from './transport.ts'
import type { Logger } from './logger.ts'


//工具定义:name+描述+JSON Schema 参数+execute函数
export type AgentTool={
    name:string
    description:string
    parameters:object   //JSON Schema
    execute:(args:unknown,signal?:AbortSignal)=>Promise<string>
    /**
     * 这个工具会修改哪些文件(相对于参数里的路径)。
     * 声明了就会按文件串行化,避免并发执行时互相覆盖。
     *
     * 格式是参数名的列表,比如 ['path'] 表示 args.path 是被修改的文件。
     * 不声明则视为不修改文件,可以自由并发。
     */
    mutatesFiles?: string[]
    /**
     * 强制串行执行,不管有没有声明 mutatesFiles。
     * 用于本身就不适合并发的工具。
     */
    sequential?: boolean
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
    options:{transport?:Transport;logger?:Logger;toolExecution?:'parallel'|'sequential'}={}
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

        //5.执行tool_calls
        //参数校验在执行前做:不合法就不执行,把错误回填给模型让它重发
        //参数JSON损坏时不执行(argsInvalid):空对象会让工具拿到undefined参数乱写
        const prepared=prepareToolCalls(toolCalls,toolMap)

        //执行并发出事件。事件按原始顺序发,写进 context 的结果也按原始顺序——
        //顺序错了下次恢复会话会 400,API 要求每个 tool_call 有配对的 tool_result。
        const results:ToolResultEntry[]=[]
        for await (const event of executeToolCalls(prepared,signal,options.toolExecution)){
            if(event.type==='tool_result'){
                results.push({tool_use_id:event.id,content:event.result})
            }
            yield{type:'tool_result',id:event.id,name:event.name,result:event.result}
        }

        //6.把tool_result放回Context
        context.messages.push(buildToolResultMessage(results))
    }
}

//一个待执行的工具调用:预检(参数校验)已经做完
type PreparedToolCall={
    id:string
    name:string
    //校验后的参数,执行时用它而不是原始参数
    args:unknown
    tool:AgentTool
    //预检失败时的错误文本,非空则不执行
    error?:string
}

//tool_result 的内容
type ToolResultEntry={tool_use_id:string;content:string}

//预检:校验参数。不合法的不执行,把错误留给模型纠正。
//这一步是串行的——校验要读 schema,顺便把类型转换做掉。
function prepareToolCalls(
    toolCalls:{id:string;name:string;args:unknown;argsInvalid:boolean}[],
    toolMap:Map<string,AgentTool>
):PreparedToolCall[]{
    const prepared:PreparedToolCall[]=[]
    for(const tc of toolCalls){
        const tool=toolMap.get(tc.name)
        if(tc.argsInvalid){
            prepared.push({id:tc.id,name:tc.name,args:{},tool:undefined as unknown as AgentTool,
                error:`error:tool"${tc.name}" arguments are not valid JSON,please resend complete arguments.`})
            continue
        }
        if(!tool){
            prepared.push({id:tc.id,name:tc.name,args:{},tool:undefined as unknown as AgentTool,
                error:`error:tool "${tc.name} not found`})
            continue
        }
        //校验并顺带做类型转换。模型传 "42" 当数字用会被转成 42,
        //转不了才算失败
        const validation=validateToolArguments(tool.parameters,tc.args,tc.name)
        if(!validation.ok){
            prepared.push({id:tc.id,name:tc.name,args:{},tool,error:validation.error})
            continue
        }
        prepared.push({id:tc.id,name:tc.name,args:validation.value,tool})
    }
    return prepared
}

//执行单个工具,捕获异常
async function executeOneTool(
    prepared:PreparedToolCall,
    signal?:AbortSignal
):Promise<string>{
    try{
        return await prepared.tool.execute(prepared.args,signal)
    }catch(e){
        return `error: ${(e as Error).message}`
    }
}

//取工具要修改的文件路径
function getMutatedFilePaths(prepared:PreparedToolCall):string[]{
    if(!prepared.tool.mutatesFiles) return []
    const args=prepared.args as Record<string,unknown>
    const paths:string[]=[]
    for(const parameterName of prepared.tool.mutatesFiles){
        const value=args[parameterName]
        if(typeof value==='string'&&value) paths.push(value)
    }
    return paths
}

//执行工具,按完成顺序发出 tool_result 事件。
//
// 两层保证:
// 1. 修改同一文件的工具按文件路径串行化(mutatesFiles),不会互相覆盖
// 2. 事件按原始顺序发,和模型发出的顺序一致,便于对照排查
async function* executeToolCalls(
    prepared:PreparedToolCall[],
    signal?:AbortSignal,
    mode:'parallel'|'sequential'='parallel'
):AsyncGenerator<{type:'tool_result';id:string;name:string;result:string}>{
    if(mode==='sequential'){
        for(const item of prepared){
            let content:string
            if(item.error){
                content=item.error
            }else if(signal?.aborted){
                content='error:aborted'
            }else{
                content=await executeOneTool(item,signal)
            }
            yield{type:'tool_result',id:item.id,name:item.name,result:content}
        }
        return
    }

    //并行:所有工具同时跑,完成后按原始顺序发事件
    const results:string[]=new Array(prepared.length)
    const tasks=prepared.map(async(item,index)=>{
        let content:string
        if(item.error){
            content=item.error
        }else if(signal?.aborted){
            content='error:aborted'
        }else{
            //需要修改文件的工具走队列,同一文件依次执行,不同文件并行
            const mutatedPaths=getMutatedFilePaths(item)
            if(mutatedPaths.length>0&&!item.tool.sequential){
                content=await withFileMutationQueue(mutatedPaths[0],async()=>{
                    //排队期间可能已经被 abort 了,这时不必再执行
                    if(signal?.aborted) return 'error:aborted'
                    return await executeOneTool(item,signal)
                })
            }else{
                content=await executeOneTool(item,signal)
            }
        }
        results[index]=content
    })

    await Promise.all(tasks)
    for(let index=0;index<prepared.length;index++){
        const item=prepared[index]
        yield{type:'tool_result',id:item.id,name:item.name,result:results[index]}
    }
}
