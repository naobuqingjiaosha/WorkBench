import {randomUUID} from 'node:crypto';
import {get,run,tx} from '../db/index.ts';
import {ApiError} from '../api/reply.ts';
import {answerFromRecords,createWorkRecord,recordIntent,recordHash,recordReplyChanges,natureLabels,type RecordRef} from './work-records.ts';
import type {AgentReply} from './agent.ts';

export interface RecordChatInput {sessionId?:number|null;message:string;workbenchId?:number|null;artifactIds?:number[];requestKey?:string;recordMode?:'capture'|'query';}
export function tryRecordTurn(input:RecordChatInput):AgentReply|null {
 if(input.artifactIds?.length)return null;
 const intent=input.recordMode??recordIntent(input.message);if(!intent)return null;
 const key=input.requestKey??randomUUID();if(!/^[\w:-]{8,160}$/.test(key))throw new ApiError('REQUEST_KEY','提交标识无效');
 const hash=recordHash({message:input.message,session:input.sessionId??null,work:input.workbenchId??null,mode:input.recordMode??null});
 return tx(()=>{
  const prior=get<{message_id:number;session_id:number;text:string;request_hash:string;record_refs:string}>('SELECT * FROM work_record_answer WHERE request_key=?',[key]);
  if(prior){if(prior.request_hash!==hash)throw new ApiError('REQUEST_CONFLICT','提交标识对应其他内容',409);if(!prior.message_id)throw new ApiError('CHAT_REMOVED','原对话已移除，请到工作记录查看',409);return reply(prior.session_id,prior.message_id,prior.text,JSON.parse(prior.record_refs) as RecordRef[]);}
  if(input.sessionId&&!get('SELECT id FROM agent_session WHERE id=?',[input.sessionId]))throw new ApiError('NOT_FOUND','对话不存在',404);
  const session=input.sessionId??run('INSERT INTO agent_session(title) VALUES(?)',[input.message.slice(0,30)]).lastInsertRowid;
  const user=run("INSERT INTO agent_message(session_id,role,content) VALUES(?,'user',?)",[session,input.message]).lastInsertRowid;
  let text:string,refs:RecordRef[];
  if(intent==='capture'){
   // Preserve exactly what the user submitted, including the instruction prefix.
   const record=createWorkRecord({text:input.message,workbench_id:input.workbenchId??null,request_key:'chat:'+key},'用户对话',user);
   refs=[{id:record.id,revision:record.revision}];text=`已记下，已保存到本机工作记录。\n\n原话：${record.text}\n发生时间：${record.occurred_from??'未说明'}${record.occurred_to&&record.occurred_to!==record.occurred_from?'至'+record.occurred_to:''}\n性质：${natureLabels[record.nature]}（按原话保守识别，可更正）\n\n[查看、更正或撤回工作记录 #${record.id}](#/records?id=${record.id})\n未创建待办，也未改变任何项目或期次状态。`;
  }else ({text,refs}=answerFromRecords(input.message,input.workbenchId));
  const message=run("INSERT INTO agent_message(session_id,role,content,model,tokens) VALUES(?,'assistant',?,'本地工作记录',0)",[session,text]).lastInsertRowid;
  run('INSERT INTO work_record_answer(message_id,request_key,request_hash,session_id,text,record_refs) VALUES(?,?,?,?,?,?)',[message,key,hash,session,text,JSON.stringify(refs)]);
  run("UPDATE agent_session SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",[session]);return reply(session,message,text,refs);
 });
}
function reply(sessionId:number,messageId:number,original:string,refs:RecordRef[]):AgentReply {
 const changed=recordReplyChanges(messageId);return {sessionId,messageId,text:original+(changed.length?'\n\n⚠ 引用的工作记录已更正或撤回，请重新查询。':''),actions:[],trace:[{tool:'work_records',args:{},result:`使用${refs.length}条记录来源；原话可追溯。`}],usage:{prompt:0,output:0,total:0},model:'本地工作记录',memoriesUsed:refs.length};
}
