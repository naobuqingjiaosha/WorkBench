import {join} from 'node:path';
import {materialArtifactCurrent} from './document-source.ts';
import {all,get,run,tx} from '../db/index.ts';
import {ApiError} from '../api/reply.ts';
import {requirePeriod,requireWorkbench,validDate,event,type WorkPeriod} from './periods.ts';
import {assertFinalArtifact} from './finalization.ts';
import type {Artifact} from '../core/store.ts';
import {getTemplate,templateGenerationScope,type Template} from './service.ts';
export interface Inspection {id:number;period_id:number;project:string;inspection_date:string;subject:string;content:string;result:string;rectification:string;revision:number;supervisor:string;method:string;supervised_unit:string;findings:string;remarks:string}
export function isMonthlyInspection(p:WorkPeriod){return get<{code:string}>('SELECT t.code FROM workbench w JOIN work_type t ON t.id=w.work_type_id WHERE w.id=?',[p.workbench_id])?.code==='integrity-monthly-inspection';}
export function listInspections(periodId:number){return all<Inspection>("SELECT * FROM inspection_record WHERE period_id=? AND NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.inspection_id=inspection_record.id AND e.status<>\'confirmed\') ORDER BY inspection_date,id",[periodId]);}
export function requireInspection(id:number,periodId?:number|null,allowPending=false){
 const r=get<Inspection>('SELECT * FROM inspection_record WHERE id=?',[id]);
 if(!periodId||!r||r.period_id!==periodId)throw new ApiError('BAD_INSPECTION','检查记录不属于当前期次',409);
 if(!allowPending&&get("SELECT id FROM ledger_entry WHERE inspection_id=? AND status<>'confirmed'",[id]))throw new ApiError('LEDGER_REVIEW_REQUIRED','对应年度台账已有修改，请先确认最新实际检查情况',409);
 const p=requirePeriod(periodId);if(!isMonthlyInspection(p))throw new ApiError('BAD_INSPECTION','当前工作不办理月度监督检查');return r;
}
export function assertInspectionRevision(id:number|undefined|null,periodId:number|undefined|null,revision:number|undefined|null){
 if(!id)return;
 const r=requireInspection(id,periodId);if(revision!==r.revision)throw new ApiError('STALE_INSPECTION','检查记录已变化，请重新打开生成窗口',409);
}
export function saveInspection(periodId:number,b:Record<string,unknown>,id?:number){
 const p=requirePeriod(periodId),w=requireWorkbench(p.workbench_id);
 if(!isMonthlyInspection(p))throw new ApiError('BAD_INSPECTION','检查记录仅适用于月度监督检查');
 if(w.archived_at)throw new ApiError('PERIOD_DONE','请先重新打开本期');
 const old=id?requireInspection(id,periodId,true):null;
 if(old&&Number(b.revision)!==old.revision)throw new ApiError('STALE','记录已被修改，请刷新后编辑',409);
 const fields=['project','subject','content','result','rectification'] as const;
 const values=fields.map(k=>{const v=b[k]??'';if(typeof v!=='string'||v.length>10000||(!v.trim()&&k!=='rectification'))throw new ApiError('BAD_RECORD','请填写项目、监督事项、检查内容和检查结果，单项不超过10000字');return v.trim();});
 const date=validDate(b.inspection_date);if(!date.startsWith(p.report_period+'-'))throw new ApiError('BAD_DATE','检查日期必须在所选月份内');
 const extraFields=['supervisor','method','supervised_unit','findings','remarks'] as const;
 const extras=extraFields.map(k=>{const v=b[k]??old?.[k]??'';if(typeof v!=='string'||v.length>10000)throw new ApiError('BAD_RECORD','补充检查字段须为不超过10000字的文本');return v.trim();});
 return tx(()=>{
  let recordId=id;
  if(old)run("UPDATE inspection_record SET project=?,subject=?,content=?,result=?,rectification=?,inspection_date=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",[...values,date,id!]);
  else recordId=run('INSERT INTO inspection_record(project,subject,content,result,rectification,inspection_date,period_id) VALUES(?,?,?,?,?,?,?)',[...values,date,periodId]).lastInsertRowid;
  run('UPDATE inspection_record SET supervisor=?,method=?,supervised_unit=?,findings=?,remarks=? WHERE id=?',[...extras,recordId!]);
  event(periodId,old?'inspection-updated':'inspection-added',JSON.stringify({id:recordId,revision:(old?.revision??0)+1}));
  return requireInspection(recordId!,periodId,true);
 });
}
export function inspectionText(r:Inspection){return `项目：${r.project}\n检查日期：${r.inspection_date}\n监督事项：${r.subject}\n检查内容：${r.content}\n检查结果：${r.result}\n发现问题：${r.findings||'未单独记录，待核对'}\n整改情况：${r.rectification||'未填写'}\n监督人员：${r.supervisor||'未填写'}\n监督方式：${r.method||'未填写'}\n接受监督单位：${r.supervised_unit||'未填写'}`;}
/** Desktop form aliases share the saved inspection records, without inventing missing measures or owners. */
export function inspectionTemplateCollections(records:Inspection[]):Record<string,string>{
 const rows=records.map((r,index)=>({'序号':index+1,'时间':r.inspection_date,'监督事项':r.subject,'监督方式':r.method||'【待补：监督方式】','具体内容':`项目：${r.project}；${r.content}`,'发现问题':r.findings||'【待补：请核对是否发现问题】','整改情况':r.rectification||'【待补：整改情况】','备注':r.remarks||'','廉政监督内容':r.subject,'廉政监督情况记录':`项目：${r.project}；检查内容：${r.content}；检查结果：${r.result}`,'检查项目':r.project,'检查内容':r.content,'存在问题':r.findings||'【待补：请核对是否发现问题】','措施及办法':'【待补：整改措施及办法】','责任人':'【待补：整改责任人】'}));
 return {'监督记录':JSON.stringify(rows),'整改记录':JSON.stringify(rows)};
}
export function inspectionFields(id?:number|null,periodId?:number|null):Record<string,string>{
 if(!id)return {};const r=requireInspection(id,periodId),text=inspectionText(r);
 const projectRecords=(JSON.parse(inspectionCollectionFields(requirePeriod(periodId!))['年度检查记录']??'[]') as Record<string,unknown>[]).filter(v=>v['项目名称']===r.project);
 return {...inspectionTemplateCollections([r]),'检查人':r.supervisor,'被检查单位':r.supervised_unit,'项目检查记录':JSON.stringify(projectRecords),'项目名称':r.project,'被检查项目':r.project,'检查项目':r.project,'检查日期':r.inspection_date,'检查时间':r.inspection_date,'监督日期':r.inspection_date,'监督事项':r.subject,'廉政监督内容':r.subject,'检查内容':r.content,'廉政监督情况记录':`检查内容：${r.content}\n检查结果：${r.result}`,'检查结果':r.result,'发现问题':r.findings||'【待补：请核对是否发现问题】','监督人员':r.supervisor,'监督方式':r.method,'接受监督单位':r.supervised_unit,'备注':r.remarks,'整改情况':r.rectification,'内容':text,'业务内容':text,'本期内容':text};
}
/** Rebuild from saved records, never append to an old generated workbook. */
export function inspectionCollectionFields(p:WorkPeriod):Record<string,string>{
 if(!isMonthlyInspection(p))return {};
 const monthly=listInspections(p.id);
 const rows=(records:Inspection[])=>records.map((r,index)=>({'序号':index+1,'项目名称':r.project,'检查日期':r.inspection_date,'监督事项':r.subject,'检查内容':r.content,'检查结果':r.result,'发现问题':r.findings||'未单独记录，待核对','整改情况':r.rectification||'未填写','备注':r.remarks||'','监督方式':r.method||'待人工填写'}));
 const annual=all<Inspection>('SELECT i.* FROM inspection_record i JOIN work_period p ON p.id=i.period_id WHERE p.workbench_id=? AND p.report_period LIKE ? AND NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.inspection_id=i.id AND e.status<>\'confirmed\') ORDER BY i.inspection_date,i.id',[p.workbench_id,p.report_period.slice(0,4)+'-%']);
 return {...inspectionTemplateCollections(monthly),'项目名称':[...new Set(monthly.map(r=>r.project))].join('、'),'检查记录':JSON.stringify(rows(monthly)),'年度检查记录':JSON.stringify(rows(annual)),'检查次数':String(monthly.length),'项目数量':String(new Set(monthly.map(r=>r.project)).size),'检查开展情况':monthly.map((r,n)=>`${n+1}. ${r.inspection_date}，${r.project}；${r.subject}。检查内容：${r.content}；检查结果：${r.result}`).join('\n')||'本月尚无已保存检查记录。','发现问题与整改':monthly.map((r,n)=>`${n+1}. ${r.project}（${r.inspection_date}）：发现问题：${r.findings||'未单独记录，待核对'}；整改情况：${r.rectification||'未填写，待核对'}`).join('\n')||'本月尚无已保存检查记录，不能据此认定无问题。'};
}
export function documentPeriodKey(period:WorkPeriod|null,inspectionId?:number|null){
 if(inspectionId){const r=requireInspection(inspectionId,period?.id);return join('期次',period!.report_period,'检查',String(inspectionId),'修订',String(r.revision));}
 return period?join('期次',period.report_period):undefined;
}
export function assertInspectionScope(t:Template,p:WorkPeriod|null,inspectionId?:number|null){
 if(!p||!isMonthlyInspection(p))return;
 const scope=templateGenerationScope(t);
 if(scope==='period'&&inspectionId)throw new ApiError('BAD_SCOPE','汇总与累计台账须从本期汇总入口生成，不能关联单次检查');
 if(scope==='record'&&!inspectionId)throw new ApiError('BAD_SCOPE','此模板须从一条检查记录生成');
}
export function inspectionSourceSignature(t:Template,p:WorkPeriod|null,inspectionId?:number|null):string|null{
 if(!p||!isMonthlyInspection(p))return null;
 const project=templateGenerationScope(t)==='record'&&t.name.includes('项目')&&inspectionId?requireInspection(inspectionId,p.id).project:null;
 if(templateGenerationScope(t)!=='period'&&!project)return null;
 let records=t.name.includes('年度')||project?all<Inspection>('SELECT i.* FROM inspection_record i JOIN work_period p ON p.id=i.period_id WHERE p.workbench_id=? AND p.report_period LIKE ? AND NOT EXISTS (SELECT 1 FROM ledger_entry e WHERE e.inspection_id=i.id AND e.status<>\'confirmed\') ORDER BY i.inspection_date,i.id',[p.workbench_id,p.report_period.slice(0,4)+'-%']):listInspections(p.id);
 if(project)records=records.filter(r=>r.project===project);
 return JSON.stringify(records.map(r=>({id:r.id,revision:r.revision})));
}
export function inspectionDocuments(p:WorkPeriod){
 const templates=(JSON.parse(p.snapshot).templates??[]) as {id:number;name:string;required?:boolean}[];
 const aggregate=templates.filter(t=>{const current=getTemplate(t.id);return current&&templateGenerationScope(current)==='period';});
 const recordTemplates=templates.filter(t=>!aggregate.some(a=>a.id===t.id));
 const required=recordTemplates.filter(t=>t.required!==false);
 const files=all<Artifact&{inspection_id:number|null;inspection_revision:number|null}>('SELECT * FROM artifact WHERE work_period_id=? AND workbench_id=? AND deleted_at IS NULL ORDER BY id DESC',[p.id,p.workbench_id]);
 const records=listInspections(p.id).map(r=>{
  const finals=files.filter(a=>a.inspection_id===r.id&&a.inspection_revision===r.revision&&recordTemplates.some(t=>t.id===a.template_id)).filter(a=>{try{if(!materialArtifactCurrent(a))throw new Error('文件缺失或来源已变化');const t=getTemplate(a.template_id!);const expected=t?inspectionSourceSignature(t,p,r.id):null;if(expected){const review=get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[a.id]);return !!review&&JSON.parse(review.snapshot).inspectionSources===expected;}return true;}catch{return false;}});
  const missing=required.length?required.filter(t=>!finals.some(a=>a.template_id===t.id)).map(t=>t.name):finals.length?[]:['适用模板的生成文件'];
  return {...r,ready:!missing.length,missing,finalIds:required.length?required.map(t=>finals.find(a=>a.template_id===t.id)?.id??0):finals.slice(0,1).map(a=>a.id)};
 });
 const requiredAggregates=aggregate.filter(t=>t.required!==false).map(t=>{
  const file=files.find(a=>a.template_id===t.id&&!a.inspection_id&&(()=>{try{if(!materialArtifactCurrent(a))throw new Error('文件缺失或来源已变化');const snapshot=get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[a.id]);return !!snapshot&&JSON.parse(snapshot.snapshot).inspectionSources===inspectionSourceSignature(getTemplate(t.id)!,p);}catch{return false;}})());
  return {...t,artifactId:file?.id??null};
 });
 const aggregateMissing=requiredAggregates.filter(t=>!t.artifactId).map(t=>t.name+'（待生成或检查记录已变化）');
 const drafts=all<{id:number;revision:number;fields:string;inspection_id:number|null;accepted_revision:number|null}>('SELECT * FROM inspection_draft WHERE period_id=?',[p.id]).filter(d=>!d.inspection_id||d.accepted_revision!==d.revision).map(d=>{
  const current=files.filter(a=>(a as Artifact&{inspection_draft_id?:number}).inspection_draft_id===d.id&&materialArtifactCurrent(a));
  const missing=required.length?required.filter(t=>!current.some(a=>a.template_id===t.id)).map(t=>t.name):current.length?[]:['适用模板的生成文件'];
  return {id:d.id,project:JSON.parse(d.fields).project,ready:missing.length===0,missing};
 });
 const base=records.map(r=>({id:r.id,revision:r.revision,finalIds:r.finalIds}));
 const signature=JSON.stringify(requiredAggregates.length?{records:base,aggregates:requiredAggregates.map(t=>t.artifactId)}:base);
 return {records,drafts,aggregateMissing,ready:records.length+drafts.length>0&&records.every(r=>r.ready)&&drafts.every(d=>d.ready)&&!aggregateMissing.length,signature,reported:!!p.reported_on&&p.report_snapshot===signature};
}
