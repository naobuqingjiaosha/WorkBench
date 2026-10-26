import {ApiError} from '../api/reply.ts';

// A local process owns the database (server.lock). Keep asynchronous file writes
// in one work from interleaving; reject a duplicate attempt instead of queuing it.
const active=new Set<string>();
export function documentWriteKey(workbenchId:number|null|undefined,templateId:number|null|undefined):string {
 return workbenchId?`work:${workbenchId}`:`template:${templateId??0}`;
}
export function assertDocumentIdle(workbenchId:number|null|undefined,templateId:number|null|undefined):void {
 if(active.has(documentWriteKey(workbenchId,templateId)))throw new ApiError('DOCUMENT_BUSY','此工作正在保存文书，请等待完成后刷新版本再重试；当前填写内容仍可保留。',409);
}
export async function withDocumentWrite<T>(workbenchId:number|null|undefined,templateId:number|null|undefined,fn:()=>Promise<T>):Promise<T> {
 assertDocumentIdle(workbenchId,templateId);const key=documentWriteKey(workbenchId,templateId);active.add(key);
 try{return await fn();}finally{active.delete(key);}
}
