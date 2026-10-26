import { assertPeriodReady } from '../domain/periods.ts';
import {existsSync} from 'node:fs';
import {artifactAbsPath, type Artifact} from './store.ts';
import { all,get,run } from '../db/index.ts';
import { assertFinalArtifact } from '../domain/finalization.ts';
import { ApiError } from '../api/reply.ts';

/** Same criterion as the completion gate: verified actual files or a reasoned waiver. */
export function checklistSatisfied(c:{id:number;kind:string;min_count:number;review_status:string;review_note:string}, workbenchId:number):boolean {
 if(c.review_status==='na' && c.review_note.trim())return true;
 if(c.review_status!=='verified')return false;
 const files=all<Artifact>('SELECT * FROM artifact WHERE checklist_item_id=? AND workbench_id=? AND deleted_at IS NULL',[c.id,workbenchId]);
 const count=c.kind==='evidence'?evidenceCount(c.id):files.filter(a=>{try{return existsSync(artifactAbsPath(a));}catch{return false;}}).length;
 return count>=Math.max(1,c.min_count);
}
/**
 * 有效影像张数。
 *
 * 解析路径必须走 `artifactAbsPath`（按 `root_kind` 决定根），不能自己拼
 * `DATA_ROOT + file_rel` —— 绑定了资料目录的工作台，照片在用户的文件夹里，
 * 自己拼会永远指向 dataRoot 下的同名位置，于是明明拍了照片却算 0 张。
 *
 * `existsSync` 的语义本轮保持不变：iCloud 的「云端未下载」占位文件算不算存在，
 * 是 §6 的后续工作（要区分本地 / 未下载 / 真丢了），这里先不引入。
 */
export function evidenceCount(id:number):number {
 /**
  * `a.deleted_at IS NULL`：进了回收站的照片不再算有效张数（否则"删了照片，进度还是 100%"）。
  * `p.deleted_at IS NULL`：阶段本身进了回收站（工作台被删），它的清单也不该再影响进度。
  * 注意 `existsSync` 那层过滤保持原样 —— 这里只管软删除。
  */
 return all<Artifact>("SELECT a.* FROM artifact a JOIN checklist_item c ON c.id=a.checklist_item_id JOIN position_instance p ON p.id=c.position_instance_id WHERE c.id=? AND a.kind='evidence' AND a.workbench_id=p.workbench_id AND a.mime LIKE 'image/%' AND a.deleted_at IS NULL AND p.deleted_at IS NULL",[id]).filter(a=>{try{return existsSync(artifactAbsPath(a));}catch{return false;}}).length;
}
export function syncEvidence(workbenchId:number):number {
 const rows=all<{id:number;min_count:number;status:string}>('SELECT c.id,c.min_count,c.status FROM checklist_item c JOIN position_instance p ON p.id=c.position_instance_id WHERE p.workbench_id=? AND c.kind=? AND p.deleted_at IS NULL',[workbenchId,'evidence']);
 for(const c of rows) {const n=evidenceCount(c.id);const status=c.status==='na'?'na':n>=c.min_count?'done':n>0?'doing':'todo';run("UPDATE checklist_item SET done_count=?,status=?,done_at=CASE WHEN ?='done' THEN COALESCE(done_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE NULL END WHERE id=?",[n,status,status,c.id]);}
 const gates:boolean[]=[];
 const historical=!!get<{historical:number}>('SELECT historical FROM workbench WHERE id=?',[workbenchId])?.historical;
 const stages=all<{id:number;code:string;status:string;note:string|null;doc_requirements:string|null}>('SELECT * FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL',[workbenchId]);
 for(const p of stages){
   const waived=p.status==='skipped'&&!!p.note?.trim();
   if(!historical)gates.push(waived||p.status==='done');
   const items=all<{id:number;kind:string;min_count:number;review_status:string;review_note:string}>('SELECT * FROM checklist_item WHERE position_instance_id=? AND required=1',[p.id]);
   for(const c of items)gates.push(waived||checklistSatisfied(c,workbenchId));
   for(const d of JSON.parse(p.doc_requirements??'[]') as {templateId:number;required:number}[])if(d.required){
     const files=all<Artifact>("SELECT * FROM artifact WHERE workbench_id=? AND position_code=? AND template_id=? AND is_final=1 AND deleted_at IS NULL",[workbenchId,p.code,d.templateId]);
     gates.push(waived||files.some(a=>{try{assertFinalArtifact(a);return true;}catch{return false;}}));
   }
 }
 const periods=all<{id:number;status:string}>('SELECT id,status FROM work_period WHERE workbench_id=?',[workbenchId]);
 for(const p of periods){let valid=p.status==='done';if(valid)try{assertPeriodReady(p.id);}catch{valid=false;}gates.push(valid);}
 if(!periods.length){
   const wb=get<{template_ids:string|null;template_requirements:string|null}>('SELECT template_ids,template_requirements FROM workbench WHERE id=?',[workbenchId]);
   for(const id of JSON.parse(wb?.template_requirements??wb?.template_ids??'[]') as number[]){
     gates.push(all<Artifact>('SELECT * FROM artifact WHERE workbench_id=? AND template_id=? AND position_code IS NULL AND is_final=1 AND deleted_at IS NULL',[workbenchId,id]).some(a=>{try{assertFinalArtifact(a);return true;}catch{return false;}}));
   }
 }
 for(const t of all<{status:string}>('SELECT status FROM quick_todo WHERE workbench_id=?',[workbenchId]))gates.push(t.status==='done');
 const progress=gates.length?Math.floor(gates.filter(Boolean).length/gates.length*100):get<{status:string}>('SELECT status FROM workbench WHERE id=?',[workbenchId])?.status==='done'?100:0;
 run('UPDATE workbench SET progress=? WHERE id=?',[progress,workbenchId]);return progress;
}
export function validateChecklist(workbenchId:number|null|undefined,checklistId:number|null|undefined,kind:string):void {
 if(!checklistId) return;
 // 回收站里的阶段/文件不再接受新的关联：`p.deleted_at IS NULL` 挡在这里，
 // 否则"删掉阶段后还能往里传照片"，传进来的东西当场就成了孤儿。
 const c=get<{workbench_id:number;kind:string}>('SELECT p.workbench_id,c.kind FROM checklist_item c JOIN position_instance p ON p.id=c.position_instance_id WHERE c.id=? AND p.deleted_at IS NULL',[checklistId]);
 if(!c || c.workbench_id!==workbenchId) throw new ApiError('BAD_CHECKLIST','清单不属于本工作台');
 if((kind==='evidence') !== (c.kind==='evidence')) throw new ApiError('BAD_CHECKLIST','附件类型与清单不一致');
}
