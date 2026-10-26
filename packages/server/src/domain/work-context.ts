import { existsSync } from 'node:fs';
import { all,get } from '../db/index.ts';
import { type Artifact } from '../core/store.ts';
import { requirePeriod,requireWorkbench,validateSourcePeriods } from './periods.ts';
import { listInspections,inspectionText } from './inspections.ts';
import {readArtifactEvidence} from '../core/evidence-file.ts';

/** Local evidence only. A period never silently borrows another period's records. */
export async function collectWorkContext(workbenchId:number,periodId?:number|null,selectedArtifactIds?:number[]) {
 const w=requireWorkbench(workbenchId),p=periodId?requirePeriod(periodId,w.id):null;
 const linked=p?validateSourcePeriods(p.id,JSON.parse(p.source_period_ids)):[];
 const scopes=p?[p,...linked.map(id=>requirePeriod(id))]:[];
 const candidates=(p?scopes.flatMap(s=>all<Artifact>('SELECT * FROM artifact WHERE workbench_id=? AND work_period_id=? AND deleted_at IS NULL ORDER BY is_final DESC,id DESC',[s.workbench_id,s.id])):all<Artifact>('SELECT * FROM artifact WHERE workbench_id=? AND deleted_at IS NULL ORDER BY is_final DESC,id DESC',[w.id]))
  .filter(a=>selectedArtifactIds===undefined||selectedArtifactIds.includes(a.id)||linked.includes((a as Artifact&{work_period_id:number}).work_period_id))
  .filter(a=>['source','scan','generated','other'].includes(a.kind)&&(a.kind!=='generated'||!!a.is_final))
  .filter(a=>!get('SELECT id FROM business_ai_run WHERE artifact_id=?',[a.id]));
 const readWarnings:string[]=[];
 const sources:{id:number;title:string;fileName:string;workbenchId:number|null;periodId:number;final:boolean;text:string}[]=[];
 for(const a of candidates){
  try {const current=await readArtifactEvidence(a);if(current.warning)readWarnings.push(`#${a.id}：${current.warning}`);if(current.text.trim())sources.push({id:a.id,title:a.title,fileName:a.file_name,workbenchId:a.workbench_id,periodId:(a as Artifact&{work_period_id:number}).work_period_id,final:!!a.is_final&&!current.changed,text:current.text});}
  catch(e){readWarnings.push(`#${a.id}：${(e as Error).message}`);}
 }
 const materialStatuses:Record<string,string>={missing:'未提供',provided:'已提供待核对',verified:'已核对',na:'不适用'};
 const records=p?scopes.flatMap(s=>[`工作 #${s.workbench_id}：${requireWorkbench(s.workbench_id).name}；期次 #${s.id}：${s.report_period}；${s.status==='done'?'已完成':'办理中'}；安排日期：${s.scheduled_date??'未安排'}`,`本期人工记录：${s.content||'未填写'}`,...listInspections(s.id).map(r=>`已保存检查记录 #${r.id}（修订${r.revision}）：\n${inspectionText(r)}`),...all<{title:string;status:string;note:string}>('SELECT title,status,note FROM period_material WHERE period_id=?',[s.id]).map(m=>`材料要求：${m.title}；核对状态：${materialStatuses[m.status]??m.status}；说明：${m.note}`)]):[
  `工作：${w.name}\n说明：${w.summary??''}\n业务内容：${w.business_content??''}`,
  ...all<{name:string;status:string;note:string|null}>('SELECT name,status,note FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL ORDER BY seq',[w.id]).map(s=>`阶段：${s.name}；状态：${s.status}；记录：${s.note??'未填写'}`),
  ...all<{title:string;status:string;note:string;owner:string|null}>('SELECT title,status,note,owner FROM quick_todo WHERE workbench_id=? ORDER BY id',[w.id]).map(t=>`事项：${t.title}；状态：${t.status}；责任方：${t.owner??'未填写'}；记录：${t.note}`)
 ];
 let budget=24000;
 let truncated=false;
 const selected=sources.filter(s=>{if(budget<=0){truncated=true;return false;}if(s.text.length>4000||s.text.length>budget)truncated=true;s.text=s.text.slice(0,Math.min(4000,budget));budget-=s.text.length;return true;});
 const warnings=[...readWarnings,...(truncated?['资料超过本次文本预算，仅提供节选；请分批核对，不能认定覆盖全部文件。']:[])];
 const unavailable=candidates.filter(a=>!sources.some(s=>s.id===a.id));
 if(unavailable.length)warnings.push(`以下 ${unavailable.length} 份关联资料无可读取正文或文件丢失，未进入本次正文汇总：${unavailable.map(a=>`#${a.id} ${a.file_name}`).join('；')}。请人工阅读或补充可识别文本。`);
 return {workbenchId,periodId:p?.id??null,sourcePeriodIds:linked,records,sources:selected,warnings,text:[...records,...warnings,...selected.map(s=>`【业务资料 #${s.id}：${s.fileName}；工作 #${s.workbenchId}；期次 #${s.periodId}；${s.final?'定稿':'待人工核实'}】\n${s.text}`)].join('\n\n')};
}
