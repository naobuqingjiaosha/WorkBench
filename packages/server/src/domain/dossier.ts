import { assertPeriodReady } from './periods.ts';
import { all } from '../db/index.ts';
import { assertFinalArtifact } from './finalization.ts';
import { getWorkbenchLive, getWorkType, listTemplatesForWorkbench, listWorkbenchPositionDocs } from './service.ts';
import { checklistSatisfied } from '../core/checklist.ts';
import { ApiError } from '../api/reply.ts';
import type { Artifact } from '../core/store.ts';

/** Business completion and dossier completeness are independent, especially for historical projects. */
export function dossierReadiness(id:number) {
 const wb=getWorkbenchLive(id);
 if(!wb)throw new ApiError('NOT_FOUND','工作不存在',404);
 const missing:string[]=[];
 const stages=all<{id:number;code:string;name:string;status:string;note:string}>('SELECT * FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL',[id]);
 for(const p of stages){
  if(p.status==='skipped'&&p.note?.trim())continue;
  if(p.status!=='done'&&!wb.historical)missing.push(`阶段未结束：${p.name}`);
  const items=all<{id:number;title:string;kind:string;min_count:number;review_status:string;review_note:string}>('SELECT * FROM checklist_item WHERE position_instance_id=? AND required=1',[p.id]);
  for(const c of items)if(!checklistSatisfied(c,id))missing.push(`${p.name} · ${c.title}：待提供或核对`);
 }
 const periodic=all('SELECT workbench_id FROM work_period_rule WHERE workbench_id=?',[id]).length>0;
 const docs=stages.length?listWorkbenchPositionDocs(id).items.flatMap(p=>p.items.filter(d=>d.required).map(d=>({id:d.templateId,name:d.name,position:p.positionCode}))):periodic?[]:listTemplatesForWorkbench(id).filter(t=>t.required).map(t=>({id:t.id,name:t.name,position:null}));
 for(const d of docs){
  const stage=stages.find(p=>p.code===d.position);
  if(stage?.status==='skipped'&&stage.note?.trim())continue;
  const files=all<Artifact>('SELECT * FROM artifact WHERE workbench_id=? AND template_id=? AND position_code IS ? AND is_final=1 AND deleted_at IS NULL',[id,d.id,d.position]);
  if(!files.some(a=>{try{assertFinalArtifact(a);return true;}catch{return false;}}))missing.push(`必备文书未有效定稿：${d.name}`);
 }
 for(const t of all<{title:string}>("SELECT title FROM quick_todo WHERE workbench_id=? AND status='open'",[id]))missing.push(`待办未结束：${t.title}`);
 for(const p of all<{id:number;status:string;report_period:string}>('SELECT id,status,report_period FROM work_period WHERE workbench_id=?',[id])){if(p.status!=='done')missing.push(`期次未完成：${p.report_period}`);else try{assertPeriodReady(p.id);}catch(e){missing.push(`${p.report_period}：${(e as Error).message}`);}}
 const businessDone=wb.status==='done'||(wb.status==='archived'&&wb.archive_status==='done');
 return {businessStatus:businessDone?'completed':'active',dossierStatus:missing.length?'collecting':'ready',historical:!!(wb as typeof wb & {historical:number}).historical,missing,canArchive:businessDone&&!missing.length,domain:getWorkType(wb.work_type_id)?.domain};
}
