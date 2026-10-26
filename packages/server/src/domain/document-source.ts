import {readFileSync,existsSync} from 'node:fs';
import {all,get,run} from '../db/index.ts';
import {reviewMemoryFacts} from './memory-facts.ts';
import {inspectionSourceSignature} from './inspections.ts';
import {getTemplate} from './service.ts';
import {requirePeriod} from './periods.ts';
import {DATA_ROOT} from '../core/config.ts';
import {resolveInside} from '../core/paths.ts';
import {artifactAbsPath,sha256,type Artifact} from '../core/store.ts';

/** Material readiness is independent of finalization, but still bound to its source. */
export function materialArtifactCurrent(a:Artifact):boolean {
 try{
  if(!existsSync(artifactAbsPath(a)))return false;
  if(a.sha256&&sha256(readFileSync(artifactAbsPath(a)))!==a.sha256)return false;
  const row=get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[a.id]);
  if(!row)return !!a.is_final;
  const s=JSON.parse(row.snapshot),v=a as Artifact&{work_period_id?:number;inspection_id?:number;inspection_draft_id?:number;inspection_draft_revision?:number};
  if(s.sourceChanged)return false;
  if(v.inspection_draft_id){
   const draft=get<{revision:number;source:string|null;inspection_id:number|null;inspection_revision:number|null}>('SELECT * FROM inspection_draft WHERE id=?',[v.inspection_draft_id]);
   if(!draft||draft.revision!==v.inspection_draft_revision)return false;
   if(draft.source){const source=JSON.parse(draft.source);const r=get<{revision:number;period_id:number}>('SELECT revision,period_id FROM inspection_record WHERE id=?',[source.id]);if(!r||r.revision!==source.revision||r.period_id!==source.periodId)return false;}
   if(draft.inspection_id&&get<{revision:number}>('SELECT revision FROM inspection_record WHERE id=?',[draft.inspection_id])?.revision!==draft.inspection_revision)return false;
  }
  return !!s.sourceSignature&&s.sourceSignature===documentSourceSignature(a.workbench_id,v.work_period_id,a.template_id,s.sourceArtifactIds,v.inspection_id);
 }catch{return false;}
}

/** Business inputs, not bookkeeping timestamps or this document's own outputs. */
export function documentSourceSignature(workbenchId:number|null|undefined,periodId:number|null|undefined,templateId:number|null|undefined,sourceArtifactIds:number[]=[],inspectionId?:number|null):string {
 const w=workbenchId?get('SELECT name,summary,business_content,profile,owner,counterpart,contract_no,contract_amount,start_date,plan_end_date FROM workbench WHERE id=?',[workbenchId]):null;
 const p=periodId?get<{content:string;scheduled_date:string|null;source_period_ids:string}>('SELECT content,scheduled_date,source_period_ids FROM work_period WHERE id=?',[periodId]):null;
 const ids:number[]=p?JSON.parse(p.source_period_ids):[];
 const linked=ids.map(id=>[get('SELECT id,workbench_id,report_period,content,status,scheduled_date,reported_on FROM work_period WHERE id=?',[id]),all('SELECT * FROM inspection_record WHERE period_id=? ORDER BY id',[id])]);
 const files=workbenchId?all<Artifact & {work_period_id:number|null}>('SELECT * FROM artifact WHERE deleted_at IS NULL AND (workbench_id=? OR work_period_id IN ('+(ids.map(()=>'?').join(',')||'NULL')+')) ORDER BY id',[workbenchId,...ids])
  .filter(a=> (ids.includes(a.work_period_id!) ? a.kind!=='generated'||!!a.is_final : sourceArtifactIds.includes(a.id)))
  .filter(a=>!get('SELECT id FROM business_ai_run WHERE artifact_id=?',[a.id]))
  .map(a=>{let digest='missing';try{digest=sha256(readFileSync(artifactAbsPath(a)));}catch{}return [a.id,a.title,a.is_final,digest];}):[];
 const t=templateId?get<{file_rel:string;vars_rel:string|null}>('SELECT file_rel,vars_rel FROM template WHERE id=?',[templateId]):null;
 const template=t?[t.file_rel,t.vars_rel].map(rel=>{if(!rel)return '';try{return sha256(readFileSync(resolveInside(DATA_ROOT,rel)));}catch{return 'missing';}}):null;
 // Completion updates progress/end dates/material status; these are outputs, not input revisions.
 const records=workbenchId?{
  stages:all('SELECT id,name,seq,note FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL ORDER BY id',[workbenchId]),
  todos:all('SELECT id,title,status,note,owner FROM quick_todo WHERE workbench_id=? ORDER BY id',[workbenchId]),
  memories:all("SELECT id,fact_key,fact_value,source,status,confirmed,valid_from,valid_until,supersedes_id FROM agent_memory WHERE (workbench_id IS NULL OR workbench_id=?) AND (period_id IS NULL OR period_id=?) ORDER BY id",[workbenchId,periodId??null]),
  inspection:inspectionId?get('SELECT * FROM inspection_record WHERE id=?',[inspectionId]):null,
  inspections:periodId&&templateId?inspectionSourceSignature(getTemplate(templateId)!,requirePeriod(periodId),inspectionId):null,
 }:null;
 return sha256(JSON.stringify({w,p,linked,files,template,records}));
}

/** Old releases did not retain source identities. Preserve files, but invalidate their review
 * when a user edits their business context; never invent a historic reference set. */
export function invalidateLegacyDocumentSources(workbenchId:number,periodId?:number):void {
 for(const a of all<Artifact&{work_period_id:number|null}>('SELECT * FROM artifact WHERE kind=\'generated\' AND deleted_at IS NULL')){
  const own=a.workbench_id===workbenchId&&(!periodId||a.work_period_id===periodId);
  const linked=a.work_period_id?get<{source_period_ids:string}>('SELECT source_period_ids FROM work_period WHERE id=?',[a.work_period_id]):null;
  const linkedIds:number[]=linked?JSON.parse(linked.source_period_ids):[];
  const depends=periodId?linkedIds.includes(periodId):linkedIds.some(id=>get<{workbench_id:number}>('SELECT workbench_id FROM work_period WHERE id=?',[id])?.workbench_id===workbenchId);
  if(!own&&!depends)continue;
  const row=get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[a.id]);
  const old=row?JSON.parse(row.snapshot):null;if(old?.sourceSignature||old?.sourceChanged)continue;
  const log=get<{variables:string}>('SELECT variables FROM generation_log WHERE artifact_id=? ORDER BY id DESC LIMIT 1',[a.id]);
  const snapshot={...(old??reviewMemoryFacts(a.workbench_id,a.work_period_id,JSON.parse(log?.variables??'{}'))),sourceChanged:true};
  run('INSERT INTO artifact_fact_review(artifact_id,snapshot) VALUES(?,?) ON CONFLICT(artifact_id) DO UPDATE SET snapshot=excluded.snapshot',[a.id,JSON.stringify(snapshot)]);
 }
}
