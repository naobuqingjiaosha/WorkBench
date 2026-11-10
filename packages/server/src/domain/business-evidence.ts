import { readFileSync, statSync, readdirSync, realpathSync } from 'node:fs';
import {resolve,relative,extname} from 'node:path';
import {isInsideRoot} from '../core/paths.ts';
import { all, get, run } from '../db/index.ts';
import { artifactAbsPath, sha256, type Artifact } from '../core/store.ts';
import { extractAny } from '../core/extract.ts';
import {readArtifactEvidence} from '../core/evidence-file.ts';
import { buildMatch } from '../core/search.ts';
import { ApiError } from '../api/reply.ts';
import { todayShanghai, validDate } from './periods.ts';
import type {EvidenceTask} from './evidence-task.ts';

type Row = Record<string, any>;
export interface BusinessScope {
 workbenchId?: number; domain?: 'admin'|'project'; category?: string; workTypeId?: number;
 start?: string; end?: string; periodIds?: number[]; keyword?: string; fileKind?: string; fileRole?:'source'|'external'; fileFormat?:string; confirmedOnly?: boolean;
}
export interface EvidenceSource {
 id: string; table: string; recordId: number; workbenchId: number; periodId?: number;
 title: string; status: string; locator: string; href: string; digest: string; fileDigest?: string;
 version?: number; fileRel?: string; acquiredAt: string;
}
export interface BusinessFact { id: string; text: string; certainty: 'confirmed'|'unverified'; sources: string[]; kind: string;
 bodyText?:string;
 query?:{topic:string;scope:BusinessScope;candidateFactIds:string[];hitFactIds:string[];readFileIds:(number|string)[];omittedFileIds:(number|string)[];omittedFacts:number;method:'literal-retained-text'} }
export interface EvidencePack {
 scope: BusinessScope; acquiredAt: string; sources: EvidenceSource[]; facts: BusinessFact[];
 gaps: string[]; conflicts: { field: string; candidates: { value: string; source: string }[] }[];
 files: { id: number|string; title: string; state: string; reason: string; readChars: number; totalChars: number; href?:string }[];
 metrics: { inspections: number; projects: number; duplicateRecords: number; periods: number; completedPeriods: number };
 coverage: { workbenches: number; periods: number; candidateFiles: number; readFiles: number; omittedFacts: number; chars: number; budget: number };
 selectionDigest: string;
 task?:EvidenceTask;
}
const TABLES = new Set(['workbench','work_type','work_period','inspection_record','ledger_entry','annual_ledger','position_instance','quick_todo','period_material','artifact','timesheet_run']);
const digestRow = (r: unknown) => sha256(JSON.stringify(r));
const link = (w: number, p?: number) => `#/workbench?id=${w}${p ? `&periodId=${p}` : ''}`;
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const state = (s: string) => ({done:'已登记完成',active:'在办',open:'待办理',paused:'暂停',archived:'已归档',pending:'待办理',doing:'办理中',skipped:'不适用'}[s] ?? s);
export function validateScope(input: BusinessScope): BusinessScope {
 const s = { ...input };
 for (const k of ['workbenchId','workTypeId'] as const) if (s[k] !== undefined && (!Number.isSafeInteger(s[k]) || s[k]! < 1)) throw new ApiError('BAD_SCOPE','工作或类型标识无效');
 if (s.domain && !['admin','project'].includes(s.domain)) throw new ApiError('BAD_SCOPE','业务领域无效');
 if (!!s.start !== !!s.end) throw new ApiError('BAD_SCOPE','日期范围需要开始及结束日期');
 if(s.start && s.end){validDate(s.start);validDate(s.end);if(s.start>=s.end)throw new ApiError('BAD_SCOPE','结束日期须晚于开始日期（结束日不含）');}
 if(s.periodIds && (!Array.isArray(s.periodIds)||s.periodIds.length>100||s.periodIds.some(n=>!Number.isSafeInteger(n)||n<1)))throw new ApiError('BAD_SCOPE','期次范围无效，最多100项');
 if(s.keyword && s.keyword.length>200)throw new ApiError('BAD_SCOPE','检索词过长');
 if(s.fileRole&&!['source','external'].includes(s.fileRole))throw new ApiError('BAD_SCOPE','文件用途无效');
 if(s.fileFormat&&!['docx','xlsx','pdf','txt','md','csv'].includes(s.fileFormat))throw new ApiError('BAD_SCOPE','文件格式无效');
 return s;
}

/** Only explicit dates, selected work or a unique literal work name determine scope. No model guesses. */
export function inferBusinessScope(question: string, workbenchId?: number|null, periodId?:number|null): {scope: BusinessScope; draft: boolean} | null {
 if (/删除|负责人改|改成|记一下|记住|配置模型|切换模型|核销/.test(question)) return null;
 let draft = /起草|生成.*(?:汇报|报告)|帮我写/.test(question);
 const scope: BusinessScope = {};
 if(workbenchId)scope.workbenchId=workbenchId;
 else {
  const matches=all<Row>('SELECT id,name FROM workbench WHERE deleted_at IS NULL').filter(w=>question.includes(w.name));
  if(matches.length===1)scope.workbenchId=matches[0]!.id;
  else if(matches.length>1)throw new ApiError('AMBIGUOUS_WORK','涉及多份同名或重叠名称的工作，请在助手中选择目标工作');
 }
 const type=scope.workbenchId?get<Row>('SELECT t.code FROM workbench w JOIN work_type t ON t.id=w.work_type_id WHERE w.id=?',[scope.workbenchId]):undefined;
 if(/(?:撰写|编写|写|拟|整理).*(?:汇报|报告)/.test(question)&&(/季度|清廉|廉洁|本领域监督/.test(question)||type?.code==='integrity-quarter-summary'))draft=true;
 if (!/进展|进度|跟进|协调|风险|完成|总结|汇报|季度|做了|工时|分析|资料|合同|交付|培训|授课|检查|结论/.test(question) && !draft && !(scope.workbenchId&&/吗|？|情况|多少|哪天|判断|办完|记录/.test(question))) return null;
 if(!scope.workbenchId && /清廉|廉洁|本领域监督/.test(question)){scope.domain='admin';scope.category='清廉工程';}
 const y=question.match(/(20\d{2})年?/), quarter=question.match(/第?([一二三四1-4])季度|Q([1-4])/i);
 let year=y?Number(y[1]):Number(todayShanghai().slice(0,4));
 const relativeQuarter=!quarter&&/本季度|这个季度|上季度/.test(question);
 if(relativeQuarter){let current=Math.ceil(Number(todayShanghai().slice(5,7))/3);if(/上季度/.test(question)&&--current===0){current=4;year--;}scope.start=`${year}-${String((current-1)*3+1).padStart(2,'0')}-01`;scope.end=new Date(Date.UTC(year,current*3,1)).toISOString().slice(0,10);}
 if(quarter){const q=quarter[2]?Number(quarter[2]):'一二三四'.includes(quarter[1]!)?'一二三四'.indexOf(quarter[1]!)+1:Number(quarter[1]);scope.start=`${year}-${String((q-1)*3+1).padStart(2,'0')}-01`;scope.end=new Date(Date.UTC(year,q*3,1)).toISOString().slice(0,10);}
 else if(!relativeQuarter){const m=question.match(/(?:年|\b)(\d{1,2})月/);if(m){const month=Number(m[1]);if(month<1||month>12)throw new ApiError('BAD_SCOPE','月份无效');scope.start=`${year}-${String(month).padStart(2,'0')}-01`;scope.end=new Date(Date.UTC(year,month,1)).toISOString().slice(0,10);}else if(y){scope.start=`${year}-01-01`;scope.end=`${year+1}-01-01`;}}
 if(!scope.workbenchId&&!scope.category)throw new ApiError('SCOPE_REQUIRED','请在上方选择目标工作，或写出完整项目名称；季度汇报请注明业务领域及季度。');
 if(periodId){
  const period=get<Row>('SELECT * FROM work_period WHERE id=?',[periodId]);
  if(!period||period.workbench_id!==scope.workbenchId)throw new ApiError('BAD_SCOPE','当前期次不属于选定工作');
  const m=String(period.report_period).match(/^(20\d{2})-Q([1-4])$/);
  const start=m?`${m[1]}-${String((Number(m[2])-1)*3+1).padStart(2,'0')}-01`:period.report_date;
  const end=m?new Date(Date.UTC(Number(m[1]),Number(m[2])*3,1)).toISOString().slice(0,10):new Date(Date.UTC(Number(start.slice(0,4)),Number(start.slice(5,7)),1)).toISOString().slice(0,10);
  if(scope.start&&(start<scope.start||end>scope.end!))throw new ApiError('SCOPE_REQUIRED','问题中的期间与当前选定期次不一致，请明确所需范围');
  scope.start??=start;scope.end??=end;scope.periodIds=[period.id];
 }
 if(!scope.start&&scope.workbenchId){
  const periods=all<Row>(`SELECT p.* FROM work_period p WHERE p.workbench_id=? AND p.status='open' ORDER BY p.report_date`,[scope.workbenchId]);
  const substantive=periods.filter(p=>p.content||get('SELECT id FROM inspection_record WHERE period_id=? LIMIT 1',[p.id])||get('SELECT id FROM artifact WHERE work_period_id=? AND file_role IN (\'source\',\'external\') AND kind IN (\'source\',\'evidence\') AND deleted_at IS NULL LIMIT 1',[p.id]));
  const candidates=substantive.length?substantive:periods;
  if(candidates.length===1)return inferBusinessScope(question,scope.workbenchId,candidates[0]!.id);
  if(candidates.length>1)throw new ApiError('SCOPE_REQUIRED','此工作有多个适用期次，请说明期间或选择当前期次');
 }
 if(draft && !scope.start)throw new ApiError('SCOPE_REQUIRED','季度汇报请注明年份及季度或选择明确的工作期次。');
 const topics=question.match(/交付|验收|延期|进度|付款|合同|风险|整改|谈话|检查|供应商|培训|协调|问题|工期|预算/g);
 if(topics?.length)scope.keyword=[...new Set(topics)].join(' ');
 return {scope:validateScope(scope),draft};
}

function selection(s: BusinessScope) {
 const where=['w.deleted_at IS NULL'], args:(string|number)[]=[];
 for(const [key,col] of [['workbenchId','w.id'],['domain','t.domain'],['category','t.category'],['workTypeId','t.id']] as const)if(s[key]!==undefined){
  if(key==='category'&&s.category==='清廉工程')where.push("(t.category=? OR (t.code='temporary-task' AND (COALESCE(w.name,'')||COALESCE(w.summary,'')||COALESCE(w.business_content,'') LIKE '%清廉%' OR COALESCE(w.name,'')||COALESCE(w.summary,'')||COALESCE(w.business_content,'') LIKE '%廉洁%' OR COALESCE(w.name,'')||COALESCE(w.summary,'')||COALESCE(w.business_content,'') LIKE '%廉政%')))" );
  else where.push(`${col}=?`);args.push(s[key]!);
 }
 const works=all<Row>(`SELECT w.*,t.domain,t.category,t.name AS type_name,t.code AS type_code FROM workbench w JOIN work_type t ON t.id=w.work_type_id WHERE ${where.join(' AND ')} ORDER BY w.id`,args);
 if(works.length>100)throw new ApiError('SCOPE_TOO_LARGE','匹配工作超过100份，请缩小业务范围');
 const ids=works.map(w=>w.id), marks=ids.map(()=>'?').join(',')||'NULL';
 const ps=all<Row>(`SELECT * FROM work_period WHERE workbench_id IN (${marks}) ORDER BY report_date,id`,ids).filter(p=>{
  if(s.periodIds && !s.periodIds.includes(p.id))return false;
  if(!s.start)return true;
  // An annual period is not a quarterly occurrence, even if its first day is in range.
  const frequency=JSON.parse(p.snapshot).frequency;
  return p.report_date>=s.start && p.report_date<s.end! && !(frequency==='yearly'&&s.end!.slice(0,4)===s.start.slice(0,4));
 });
 if(s.periodIds?.some(id=>!ps.some(p=>p.id===id)))throw new ApiError('BAD_SCOPE','所选期次不属于当前工作或日期范围');
 const periodIds=new Set(ps.map(p=>p.id));
 const files=all<Row>(`SELECT * FROM artifact WHERE workbench_id IN (${marks}) AND deleted_at IS NULL AND kind<>'template' ORDER BY is_final DESC,id DESC`,ids).filter(a=>{
  if(s.fileKind && a.kind!==s.fileKind)return false;
  if(s.fileRole && a.file_role!==s.fileRole)return false;
  if(s.fileFormat && extname(a.file_name).toLowerCase()!==`.${s.fileFormat}`)return false;
  if(s.confirmedOnly&&!a.is_final)return false;
  // A cumulative ledger is a container. Its dated rows are filtered below.
  if(s.start&&!s.periodIds&&works.some(w=>w.id===a.workbench_id&&w.type_code==='integrity-talk'))return true;
  if(a.work_period_id)return periodIds.has(a.work_period_id);
  return !s.start || (!!a.doc_date&&a.doc_date>=s.start&&a.doc_date<s.end!);
 });
 return {works,periods:ps,files};
}
function selectionHash(s: BusinessScope) {
 const x=selection(s),ids=x.works.map(w=>w.id),ps=x.periods.map(p=>p.id),marks=ids.map(()=>'?').join(',')||'NULL',pm=ps.map(()=>'?').join(',')||'NULL';
 return digestRow([x.works.map(w=>w.id),x.periods.map(p=>p.id),x.files.filter(a=>!(a.kind==='generated'&&!a.is_final)&&!get('SELECT id FROM business_ai_run WHERE artifact_id=?',[a.id])).map(a=>a.id),
  all(`SELECT e.id,e.revision,e.status FROM ledger_entry e JOIN annual_ledger l ON l.id=e.ledger_id WHERE l.workbench_id IN (${marks}) ORDER BY e.id`,ids),
  all(`SELECT id FROM inspection_record WHERE period_id IN (${pm}) ORDER BY id`,ps),all(`SELECT id FROM period_material WHERE period_id IN (${pm}) AND requirement_kind<>'generated' ORDER BY id`,ps),
  all(`SELECT id FROM quick_todo WHERE workbench_id IN (${marks}) ORDER BY id`,ids),all(`SELECT id FROM position_instance WHERE workbench_id IN (${marks}) AND deleted_at IS NULL ORDER BY id`,ids),all(`SELECT id FROM timesheet_run WHERE period_id IN (${pm}) ORDER BY id`,ps),referenceInventory(x.works,s).files.map(f=>f.id)]);
}
function referencePath(workbenchId:number,path:string):string {
 const w=get<Row>('SELECT reference_root,deleted_at FROM workbench WHERE id=?',[workbenchId]);
 if(!w?.reference_root||w.deleted_at)throw new Error('参考目录失效');
 const root=realpathSync(w.reference_root),target=realpathSync(resolve(root,path));
 if(!isInsideRoot(root,target))throw new Error('参考文件越界');return target;
}
function referenceInventory(works:Row[],scope:BusinessScope){
 const files:{id:string;workbenchId:number;path:string;scoped:boolean;reason:string}[]=[],warnings:string[]=[];let visited=0;
 for(const w of works.filter(w=>w.reference_root)){
  try{
   const root=realpathSync(w.reference_root);
   const visit=(directory:string,depth:number)=>{
    if(depth>4||visited>=1000){warnings.push(`${w.name} 参考目录超过4层或1000项扫描上限，未完全覆盖。`);return;}
    for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
     if(++visited>1000){warnings.push('参考目录扫描达到1000项上限，后续条目未读取。');return;}
     if(entry.isSymbolicLink()||entry.name.startsWith('.')||['node_modules','tmp'].includes(entry.name))continue;
     const abs=resolve(directory,entry.name);if(!isInsideRoot(root,realpathSync(abs)))continue;
     if(entry.isDirectory()){visit(abs,depth+1);continue;}
     if(!['.docx','.xlsx','.pdf','.txt','.md','.csv'].includes(extname(entry.name).toLowerCase()))continue;
     if(scope.fileFormat&&extname(entry.name).toLowerCase()!==`.${scope.fileFormat}`)continue;
     const path=relative(root,abs).replaceAll('\\','/');let scoped=!scope.start,reason='';
     if(scope.start){
      const dates:string[]=[];
      for(const m of path.matchAll(/(20\d{2})[-年/_.](0?[1-9]|1[0-2])(?:[-月/_.]|$)/g))dates.push(`${m[1]}-${m[2]!.padStart(2,'0')}-01`);
      for(const m of path.matchAll(/(20\d{2})(?:年?第?([一二三四1-4])季度|[-_]?Q([1-4]))/gi)){const q=m[3]?Number(m[3]):'一二三四'.includes(m[2]!)?'一二三四'.indexOf(m[2]!)+1:Number(m[2]);dates.push(`${m[1]}-${String((q-1)*3+1).padStart(2,'0')}-01`);}
      scoped=dates.length>0&&dates.every(d=>d>=scope.start!&&d<scope.end!);
      if(!scoped)reason='路径未明确标注适用月份／季度，或不在本次范围；未读取，不根据修改时间猜测业务期间';
      if(scope.periodIds){scoped=false;reason='已手工限定期次；参考文件未登记期次归属，本次不自动纳入';}
     }
     if(/草稿|draft/i.test(path)){scoped=false;reason='文件名标为草稿，不作为独立事实证据';}
     if(scope.fileRole||scope.confirmedOnly||scope.fileKind){scoped=false;reason='参考文件未登记用途、种类和确认状态，不满足本次结构化筛选';}
     files.push({id:`reference:${w.id}:${path}`,workbenchId:w.id,path,scoped,reason});
    }
   };visit(root,0);
  }catch{warnings.push(`${w.name} 参考目录不可访问，未读取其中资料。`);}
 }
 return {files,warnings:[...new Set(warnings)]};
}
/** Ignore only derived work progress and its bookkeeping timestamp. */
function sourceDigest(table:string,row:Row|undefined){if(table==='workbench'&&row){const {progress,updated_at,...business}=row;return digestRow(business);}if(table==='annual_ledger'&&row)return digestRow([row,all<Row>('SELECT * FROM ledger_document WHERE ledger_id=? ORDER BY id',[row.id]).map(d=>{try{return [d.id,d.state,sha256(readFileSync(d.path))];}catch{return [d.id,'unreadable'];}})]);return digestRow(row??null);}

/** Keep dated entries, with their following lines, within a half-open range.
 * Undated introductions and mixed-period lines cannot prove a quarterly event.
 */
export function datedBusinessText(text:string,scope:BusinessScope):string {
 if(!scope.start)return text;
 let included=false;
 return text.split(/\n/).filter(line=>{
  const dates=[...line.matchAll(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/g)].map(m=>`${m[1]}-${m[2]!.padStart(2,'0')}-${m[3]!.padStart(2,'0')}`);
  if(dates.length)included=dates.every(d=>d>=scope.start!&&d<scope.end!);
  return included;
 }).join('\n');
}

/** Bounded, read-only collection. Files are re-read, never modified; cached text cannot hide disk changes. */
export async function collectBusinessEvidence(input: BusinessScope, budget = 24000): Promise<EvidencePack> {
 const scope=validateScope(input), acquiredAt=new Date().toISOString(), selected=selection(scope);
 budget=Math.max(4000,Math.min(60000,Math.floor(budget)));
 const pack:EvidencePack={scope,acquiredAt,sources:[],facts:[],gaps:[],conflicts:[],files:[],metrics:{inspections:0,projects:0,duplicateRecords:0,periods:selected.periods.length,completedPeriods:selected.periods.filter(p=>p.status==='done').length},coverage:{workbenches:selected.works.length,periods:selected.periods.length,candidateFiles:selected.files.length,readFiles:0,omittedFacts:0,chars:0,budget},selectionDigest:selectionHash(scope)};
 const source=(table:string,row:Row,w:number,p?:number):EvidenceSource=>{
  const id=`${table}:${row.id}`, old=pack.sources.find(x=>x.id===id);if(old)return old;
  const actual=get<Row>(`SELECT * FROM ${table} WHERE id=?`,[row.id]);
  const r:EvidenceSource={id,table,recordId:row.id,workbenchId:w,...p?{periodId:p}:{},title:row.name??row.title??row.report_period??row.project??`记录 #${row.id}`,status:row.status??'已保存记录',locator:`${table} #${row.id}`,href:link(w,p),digest:sourceDigest(table,actual),acquiredAt};pack.sources.push(r);return r;
 };
 const fact=(text:string,certainty:BusinessFact['certainty'],sources:EvidenceSource[],kind:string,bodyText?:string)=>{
  if(pack.coverage.chars+text.length>budget){pack.coverage.omittedFacts++;return;}
  pack.coverage.chars+=text.length;pack.facts.push({id:`F${pack.facts.length+1}`,text,certainty,sources:sources.map(s=>s.id),kind,...bodyText?{bodyText}:{}});
 };
 const inspectionRows:Row[]=[];
 for(const w of selected.works){
  const sw=source('workbench',w,w.id);source('work_type',get<Row>('SELECT * FROM work_type WHERE id=?',[w.work_type_id])!,w.id);
  fact(`${w.name}（${w.category}／${w.type_name}）：当前登记状态为${state(w.status)}；业务结束和档案齐全须分别核对。`,'confirmed',[sw],'work');
  if(w.domain==='admin'&&(w.business_content||w.summary)){
   const record=datedBusinessText(w.business_content||w.summary,scope);
   if(record.trim())fact(`${w.name} 人工业务记录（日期按原文筛选，活动发生与完成情况待核实）：${record}`,'unverified',[sw],'record',record);
   else pack.gaps.push(`${w.name} 的人工记录未含本次范围内明确日期，不能据此认定当季活动已发生。`);
  }
  if(w.domain==='project'){
   fact(`项目 ${w.name}：对接单位 ${w.counterpart||'未填写'}；计划完成日期 ${w.plan_end_date||'未填写'}；实际结束日期 ${w.actual_end_date||'未登记'}；档案归档状态 ${w.archive_status||'未登记'}。`,'confirmed',[sw],'project');
   if(w.business_content||w.summary)fact(`项目人工记录（不等于已核实履约）：${w.business_content||w.summary}`,'unverified',[sw],'record');
   if(w.profile)fact(`项目档案补充字段（供应商、合同等按录入内容待核实）：${w.profile}`,'unverified',[sw],'record');
   for(const stage of all<Row>('SELECT * FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL ORDER BY seq',[w.id])){
    const ss=source('position_instance',stage,w.id);fact(`阶段 ${stage.name}：${state(stage.status)}。${stage.note?`人工备注（待核实）：${stage.note}`:''}`,'confirmed',[ss],'stage');
   }
   for(const t of all<Row>('SELECT * FROM quick_todo WHERE workbench_id=? ORDER BY due_date,id',[w.id])){
    const st=source('quick_todo',t,w.id);fact(`${t.kind==='delivery'?'供应商交付事项':t.kind==='coordination'?'协调事项':'项目事项'} ${t.title}：${state(t.status)}；责任方 ${t.owner||'未填写'}；约定日期 ${t.due_date||'未填写'}。记录完成不等于验收通过。${t.note?`人工说明（待核实）：${t.note}`:''}`,'confirmed',[st],t.status==='open'?'followup':'todo');
   }
   pack.gaps.push(`${w.name}：阶段状态、交付事项和档案字段仅反映登记情况；验收、合同生效、签章及档案齐全需相应文件及人工核对。`);
  }
 }
 for(const p of selected.periods){
  const w=selected.works.find(w=>w.id===p.workbench_id)!,sp=source('work_period',p,w.id,p.id);sp.title=`${w.name}／${p.report_period}`;
  fact(`${w.type_name}／${w.name}／${p.report_period}：${state(p.status)}；安排日期 ${p.scheduled_date||'未登记'}${p.reported_on?'；历史实际报送日期 '+p.reported_on:''}。安排日期不能证明活动已开展；当前材料制作不管理报送。`,'confirmed',[sp],'period');
  if(p.content)fact(`${p.report_period} ${w.name}人工填报内容（${p.status==='done'?'期次已登记完成，内容仍需核对':'期次未完成'}）：${p.content}`,'unverified',[sp],'record',p.content);
  for(const m of all<Row>('SELECT * FROM period_material WHERE period_id=? ORDER BY id',[p.id])){
   const sm=source('period_material',m,w.id,p.id);
   if(m.required && !['verified','na'].includes(m.status))pack.gaps.push(`${w.name} ${p.report_period}：${m.title}${m.status==='provided'?'已提供待核对':'尚无核对依据'}（${sm.id}）。`);
  }
  for(const r of all<Row>('SELECT * FROM inspection_record WHERE period_id=? ORDER BY inspection_date,id',[p.id])){
   if(get('SELECT id FROM ledger_entry WHERE inspection_id=?',[r.id]))continue;
   if(scope.start && (r.inspection_date<scope.start||r.inspection_date>=scope.end!)){pack.gaps.push(`检查 #${r.id} 日期与所选期次范围不一致，未计入。`);continue;}
   inspectionRows.push(r);const sr=source('inspection_record',r,w.id,p.id);
   fact(`已保存检查记录 #${r.id}（修订 ${r.revision}）：${r.inspection_date}，项目 ${r.project}；监督事项 ${r.subject}；内容 ${r.content}；记录结果 ${r.result}；整改记录 ${r.rectification||'未填写'}。不据此推断整改完成或报送。`,'confirmed',[sr],'inspection',`${r.inspection_date}，项目 ${r.project}；监督事项 ${r.subject}；内容 ${r.content}；记录结果 ${r.result}；整改记录 ${r.rectification||'未填写'}。`);
  }
  const annual=get<Row>('SELECT * FROM annual_ledger WHERE workbench_id=? AND year=?',[w.id,p.report_period.slice(0,4)]);
  if(annual){
   const sa=source('annual_ledger',annual,w.id,p.id),scan=await (await import('./annual-ledger.ts')).inspectLedgerChanges(p.id);
   const pending=scan.changes.length>0||scan.issues.length>0;
   sa.fileDigest=sha256(readFileSync(annual.path));
   if(pending)pack.gaps.push(`${w.name} 年度台账关联文件有未同步变化或问题，请先在月检页同步；当前台账内容仅供参考。`);
   for(const row of all<Row>("SELECT * FROM ledger_entry WHERE ledger_id=? AND (substr(json_extract(fields,'$.inspection_date'),1,7)=? OR (json_extract(fields,'$.inspection_date')='' AND month=?)) ORDER BY rowid",[annual.id,p.report_period,p.report_period])){
    const f=JSON.parse(row.fields),sr=source('ledger_entry',row,w.id,p.id),confirmed=row.status==='confirmed'&&!pending&&Boolean(row.inspection_id&&get('SELECT id FROM inspection_record WHERE id=? AND period_id=?',[row.inspection_id,p.id]));
    if(scope.start&&f.inspection_date&&(f.inspection_date<scope.start||f.inspection_date>=scope.end!))continue;
    const body=`${f.inspection_date||'日期待补'}，项目 ${f.project}；监督事项 ${f.subject}；具体内容 ${f.content||'待补'}；发现问题 ${f.findings||'待补'}；整改情况 ${f.rectification||'待补'}；小微权力 ${f.small_power==='yes'?'是':'未标记'}。`;
    fact(`年度台账记录（${confirmed?'用户已确认实际检查':row.status==='imported'?'历史导入，待核对':'草稿或修改后待确认'}）：${body}`,confirmed?'confirmed':'unverified',[sr,sa],'inspection',body);
    if(confirmed)inspectionRows.push({...f,id:row.id,result:f.findings});
   }
  }
  const runs=all<Row>('SELECT * FROM timesheet_run WHERE period_id=? ORDER BY id DESC',[p.id]);
  if(runs.length){const t=runs[0]!,st=source('timesheet_run',t,w.id,p.id);const result=JSON.parse(t.result);const totals=Object.values(result.personTotals??{});if(totals.every(n=>typeof n==='number'&&Number.isFinite(n)))fact(`工时计算记录 #${t.id}：${t.month}，人员月度合计之和 ${Number((totals as number[]).reduce((a,b)=>a+b,0).toFixed(10))} 小时；状态 ${t.status}；仅统计本期最新计算版本，不重复累计历史版本。`,t.status==='final'?'confirmed':'unverified',[st],'timesheet');}
 }
 const unique=new Map<string,Row>();
 for(const r of inspectionRows){const key=JSON.stringify([normalize(r.project),r.inspection_date,normalize(r.subject),normalize(r.content)]);const prev=unique.get(key);if(prev){pack.metrics.duplicateRecords++;if(prev.result!==r.result||prev.rectification!==r.rectification)pack.conflicts.push({field:'同项目同日同内容检查结果',candidates:[{value:prev.result+'；'+prev.rectification,source:`inspection_record:${prev.id}`},{value:r.result+'；'+r.rectification,source:`inspection_record:${r.id}`}]});}else unique.set(key,r);}
 pack.metrics.inspections=inspectionRows.length;pack.metrics.projects=new Set(inspectionRows.map(r=>normalize(r.project))).size;
 const metricSources=pack.sources.filter(s=>s.table==='inspection_record'||s.table==='ledger_entry');
 if(inspectionRows.length)fact(`所选期次已保存检查记录 ${pack.metrics.inspections} 条，涉及项目 ${pack.metrics.projects} 个；疑似重复 ${pack.metrics.duplicateRecords} 条，未自动合并。按独立记录ID计数；同日同内容也可能是不同检查，实际次数及项目名称别名仍需人工核对。`,'confirmed',metricSources,'metric');
 if(pack.metrics.duplicateRecords)pack.gaps.push('存在疑似重复检查，保留每条记录并提示核对；未经人工确认不减少记录数，也不把记录数等同已核实的实际活动次数。');
 if(!selected.works.length)pack.gaps.push('没有查到适用工作；不表示相关事情一定没有发生。');
 if(scope.start&&!selected.periods.length)pack.gaps.push('所选日期范围内没有适用期次；不得用历史季度或预设流程补齐。');
 if(!inspectionRows.length&&selected.works.some(w=>w.type_code==='integrity-monthly-inspection'))pack.gaps.push('未查到所选范围的检查记录，不能表述为实际检查次数为零或已完成监督工作。');
 let candidates=selected.files;
 const match=scope.keyword?buildMatch(scope.keyword):'';
 if(match&&candidates.length){const ids=candidates.map(a=>a.id);const ranked=all<{id:number}>(`SELECT a.id FROM artifact_fts f JOIN artifact a ON a.id=f.rowid WHERE artifact_fts MATCH ? AND a.id IN (${ids.map(()=>'?').join(',')}) ORDER BY bm25(artifact_fts)`,[match,...ids]);const ranks=new Map(ranked.map((r,i)=>[r.id,i]));candidates=[...candidates].sort((a,b)=>(ranks.get(a.id)??9999)-(ranks.get(b.id)??9999));}
 const seen=new Map<string,number>();let bytesRead=0;
 for(const raw of candidates){
  const a=raw as Artifact, entry={id:a.id,title:a.title||a.file_name,state:'unread',reason:'',readChars:0,totalChars:0};pack.files.push(entry);
  if(get('SELECT id FROM business_ai_run WHERE artifact_id=?',[a.id])||(a.kind==='generated'&&!a.is_final)){entry.state='excluded';entry.reason='AI助手成果或未审核生成草稿，不作为独立事实证据';continue;}
  const sf=source('artifact',raw,a.workbench_id!,raw.work_period_id??undefined);sf.title=entry.title;sf.fileRel=a.file_rel;sf.version=a.revision??a.version;sf.href=`/api/artifacts/${a.id}/file`;
  if(a.version_group && candidates.some(b=>b.id!==a.id&&b.version_group===a.version_group&&((b.is_final&&!a.is_final)||(!!b.is_final===!!a.is_final&&Number(b.revision)>Number(a.revision))))){entry.state='excluded';entry.reason='同版本链已有更适用版本';continue;}
  if(pack.coverage.readFiles>=30||pack.coverage.chars>=budget||bytesRead>=32*1024*1024){entry.state='omitted';entry.reason='超过本次文件或上下文预算，未读取';continue;}
  try{
   const path=artifactAbsPath(a),size=statSync(path).size;if(size>8*1024*1024){entry.state='omitted';entry.reason='文件超过8MB读取上限';continue;}
   const hash=sha256(readFileSync(path));sf.fileDigest=hash;bytesRead+=size;
   if(seen.has(hash)){entry.state='duplicate';entry.reason=`与文件 #${seen.get(hash)} 内容相同，不增加独立证据`;continue;}seen.set(hash,a.id);
   const current=await readArtifactEvidence(a),extracted={text:current.text,ok:!!current.text.trim(),message:current.warning};if(current.digest!==hash){entry.reason='读取期间文件发生变化，请重试';continue;}
   if(!extracted.ok||!extracted.text.trim()){entry.reason=extracted.message||'无法提取正文／待OCR';continue;}
   if(/忽略.{0,15}(指令|规则)|ignore.{0,30}(instructions|rules)|<\|(?:system|im_start)\|>/i.test(extracted.text)){entry.state='quarantined';entry.reason='发现疑似指令注入文本；不进入模型或草稿正文，请人工阅读原件';pack.gaps.push(`文件 #${a.id} 存在疑似指令内容，已隔离。`);continue;}
   const changed=!!a.sha256&&a.sha256!==hash;
   const verified=!changed&&(!!a.is_final||!!get('SELECT id FROM period_material WHERE artifact_id=? AND status=\'verified\'',[a.id]));
   sf.status=changed?'原文件更新，旧核对失效':verified?'已核对资料':'待核实资料';
   const isLedger=!!scope.start&&selected.works.some(w=>w.id===a.workbench_id&&w.type_code==='integrity-talk');
   const scopedText=isLedger?datedBusinessText(extracted.text,scope):extracted.text;
   if(isLedger&&!scopedText.trim()){entry.state='excluded';entry.reason='已读取累计台账，未找到本次日期范围内可明确归属的条目；不推断当季谈话已发生';pack.gaps.push(`文件 #${a.id}：${entry.reason}`);continue;}
   const allowedLines=new Set(scopedText.split(/\n/));
   const lines=extracted.text.split(/\n/).map((text,index)=>({text,index})).filter(x=>x.text.trim()&&(!isLedger||allowedLines.has(x.text)));
   const keys=scope.keyword?.split(/\s+/)??(scope.category==='清廉工程'?['监督','检查','学习','谈话','廉政','廉洁','研判','会议','整改']:[]);
   if(keys.length)lines.sort((a,b)=>Number(keys.some(k=>b.text.includes(k)))-Number(keys.some(k=>a.text.includes(k))));
   const limit=Math.min(2400,Math.max(0,budget-pack.coverage.chars-200));let used=0;
   const excerpts:string[]=[];
   for(const l of lines){if(used>=limit)break;const text=l.text.slice(0,limit-used);excerpts.push(`提取文本第${l.index+1}行：${text}`);used+=text.length;}
   entry.totalChars=extracted.text.length;entry.readChars=used;entry.state=used<extracted.text.length?'excerpt':'read';entry.reason=changed?'磁盘内容已更新，索引和旧确认不可沿用':extracted.message??'';
   if(a.kind==='generated')entry.reason+='；定稿生成件仅作佐证，不能作为独立统计记录';
   pack.coverage.readFiles++;sf.locator=`${a.file_name} v${sf.version}，${excerpts.map(x=>x.split('：')[0]).join('、')}`;
   fact(`文件 #${a.id}《${entry.title}》（${sf.status}；以下是原文摘录，非系统确认结论）：\n${excerpts.join('\n')}`,'unverified',[sf],'document',excerpts.map(t=>t.replace(/^提取文本第\d+行：/,'')).join('\n'));
   if(changed)pack.gaps.push(`文件 #${a.id} 已更新；旧定稿或核对状态不能证明新版内容。`);
  }catch{entry.reason='文件缺失、路径失效或解析失败，未读取正文';}
 }
 for(const file of pack.files.filter(f=>['unread','omitted'].includes(f.state)))pack.gaps.push(`文件 #${file.id} ${file.title}：${file.reason}`);
 const references=referenceInventory(selected.works,scope);pack.gaps.push(...references.warnings);pack.coverage.candidateFiles+=references.files.length;
 for(const ref of references.files){
  const href=`/api/workbenches/${ref.workbenchId}/reference-file?path=${encodeURIComponent(ref.path)}`;
  const entry={id:ref.id,title:ref.path,state:'unread',reason:ref.reason,readChars:0,totalChars:0,href};pack.files.push(entry);
  if(!ref.scoped){entry.state='excluded';continue;}
  if(pack.coverage.readFiles>=30||pack.coverage.chars>=budget||bytesRead>=32*1024*1024){entry.state='omitted';entry.reason='本次文件或文本预算不足，未读取参考文件';continue;}
  try{
   const abs=referencePath(ref.workbenchId,ref.path),size=statSync(abs).size;
   if(size>8*1024*1024){entry.state='omitted';entry.reason='参考文件超过8MB';continue;}
   const hash=sha256(readFileSync(abs));bytesRead+=size;
   const sf:EvidenceSource={id:ref.id,table:'reference_file',recordId:ref.workbenchId,workbenchId:ref.workbenchId,title:ref.path,status:'只读参考原文，日期及版本待核实',locator:ref.path,href,digest:hash,fileDigest:hash,fileRel:ref.path,acquiredAt};pack.sources.push(sf);
   if(get("SELECT id FROM artifact WHERE sha256=? AND kind='generated' AND is_final=0",[hash])||get('SELECT a.id FROM artifact a JOIN business_ai_run r ON r.artifact_id=a.id WHERE a.sha256=?',[hash])){entry.state='excluded';entry.reason='与已知AI草稿或助手成果相同，不能作为独立证据';continue;}
   if(seen.has(hash)){entry.state='duplicate';entry.reason='与已读取文件内容相同，不增加独立证据';continue;}seen.set(hash,-ref.workbenchId);
   const extracted=await extractAny(abs);if(sha256(readFileSync(abs))!==hash)throw new Error('文件读取期间变化');
   if(!extracted.ok||!extracted.text.trim()){entry.reason=extracted.message||'无法提取正文／待OCR';continue;}
   if(/忽略.{0,15}(指令|规则)|ignore.{0,30}(instructions|rules)|<\|(?:system|im_start)\|>/i.test(extracted.text)){entry.state='quarantined';entry.reason='疑似指令文本已隔离，不进入模型或草稿';continue;}
   const limit=Math.min(2400,Math.max(0,budget-pack.coverage.chars-200));
   const keys=scope.keyword?.split(/\s+/)??(scope.category==='清廉工程'?['监督','检查','学习','谈话','廉政','廉洁','研判','会议','整改']:[]);
   const lines=extracted.text.split('\n').map((text,index)=>({text,index})).filter(x=>x.text.trim());
   if(keys.length)lines.sort((a,b)=>Number(keys.some(k=>b.text.includes(k)))-Number(keys.some(k=>a.text.includes(k))));
   let remaining=limit;const parts:string[]=[];
   for(const line of lines){if(remaining<=0)break;const text=line.text.slice(0,remaining);parts.push(`提取文本第${line.index+1}行：${text}`);remaining-=text.length;}
   const excerpt=parts.join('\n');
   entry.readChars=excerpt.length;entry.totalChars=extracted.text.length;entry.state=excerpt.length<extracted.text.length?'excerpt':'read';entry.reason=extracted.message??'日期范围仅按路径标注筛选，正文真实性和适用版本待核实';pack.coverage.readFiles++;
   sf.locator=`${ref.path}，${parts.map(x=>x.split('：')[0]).join('、')}`;
   fact(`只读参考文件《${ref.path}》（日期及版本未人工确认，以下仅为原文）：\n${excerpt}`,'unverified',[sf],'document',parts.map(t=>t.replace(/^提取文本第\d+行：/,'')).join('\n'));
  }catch{entry.reason='参考文件失效、不可读取或读取期间变化';}
 }
 if(references.files.length)pack.gaps.push('只读参考目录中的文件未登记确认状态；期间仅按路径标注保守筛选，不据此确认活动发生。排除、读取失败和遗漏明细见文件面板。');
 if(pack.files.some(f=>f.state==='excerpt'))pack.gaps.push('文件正文仅提供可定位节选，未宣称阅读全文；请核对未覆盖段落。');
 if(pack.coverage.omittedFacts)pack.gaps.push(`结构化事实有 ${pack.coverage.omittedFacts} 条超过上下文预算；统计仍基于所选完整记录，正文未覆盖全部细节。`);
 // Explicit comparable metric statements only; arbitrary prose conflicts remain a human review task.
 const claims:{value:string;source:string}[]=[...pack.facts.filter(f=>f.kind==='document').flatMap(f=>[...f.text.matchAll(/(?:检查次数\s*[:：]\s*(\d+)|检查(?:了|共计|合计|共)?\s*(\d+)\s*次)/g)].map(m=>({value:(m[1]??m[2])!,source:f.sources[0]!})))];
 if(inspectionRows.length&&claims.some(c=>Number(c.value)!==pack.metrics.inspections))pack.conflicts.push({field:'资料中检查次数与所选记录统计口径可能冲突',candidates:[{value:String(pack.metrics.inspections),source:'按独立记录ID统计'},...claims]});
 if(pack.conflicts.length)pack.gaps.push('存在来源冲突，未自动采信任一叙述；正式文书需先核清口径。');
 return pack;
}

export function evidenceChanges(pack: EvidencePack): string[] {
 const changes:string[]=[];
 try{if(selectionHash(pack.scope)!==pack.selectionDigest)changes.push('适用工作、期次或文件集合发生变化');}catch{changes.push('原资料范围已失效');}
 for(const s of pack.sources){
  if(s.table==='reference_file'){
   try{const path=referencePath(s.workbenchId,s.fileRel!);if(statSync(path).size>8*1024*1024||sha256(readFileSync(path))!==s.fileDigest)changes.push(`${s.title} 参考文件内容已变化`);}catch{changes.push(`${s.title} 参考文件不可读取`);}continue;
  }
  if(!TABLES.has(s.table)){changes.push(`${s.id} 来源类型无效`);continue;}
  const r=get<Row>(`SELECT * FROM ${s.table} WHERE id=?`,[s.recordId]);
  if(!r||sourceDigest(s.table,r)!==s.digest)changes.push(`${s.title}（${s.id}）记录或版本状态已变化`);
  if(s.fileDigest&&r)try{const path=s.table==='annual_ledger'?r.path:artifactAbsPath(r as Artifact);if(statSync(path).size>20*1024*1024||sha256(readFileSync(path))!==s.fileDigest)changes.push(`${s.title} 文件内容已变化`);}catch{changes.push(`${s.title} 文件已不可读取`);}
 }
 return changes;
}

export function refreshAfterDraft(pack:EvidencePack,workbenchId:number,periodId:number):void {
 for(const s of pack.sources.filter(s=>s.table==='period_material'&&s.workbenchId===workbenchId&&s.periodId===periodId)){
  const row=get<Row>('SELECT * FROM period_material WHERE id=?',[s.recordId]);if(row?.requirement_kind==='generated')s.digest=sourceDigest(s.table,row);
 }
}

/** Called by every existing finalization route, including version-page confirmation. */
export function assertBusinessEvidenceFinal(artifactId:number):void {
 const r=get<{snapshot:string;review_note:string|null;reviewed_digest:string|null}>('SELECT * FROM business_ai_run WHERE artifact_id=? ORDER BY id DESC LIMIT 1',[artifactId]);
 if(!r)return;
 const changes=evidenceChanges(JSON.parse(r.snapshot));
 if(changes.length)throw new ApiError('EVIDENCE_STALE','业务证据已变化，须重新收集资料并起草。',409,changes);
 const a=get<Artifact>('SELECT * FROM artifact WHERE id=?',[artifactId]);
 if(!r.review_note?.trim()||!a||sha256(readFileSync(artifactAbsPath(a)))!==r.reviewed_digest)throw new ApiError('EVIDENCE_REVIEW_REQUIRED','请先在AI助手证据面板填写核对依据并确认当前草稿；该确认不会自动定稿。',409);
}

/** Preserve provenance through the existing generic editor and version rollback. Never inherit review. */
export function inheritBusinessEvidence(fromId:number,toId:number,values:unknown):void {
 const previous=get<{id:number;snapshot:string;draft:string|null}>('SELECT id,snapshot,draft FROM business_ai_run WHERE artifact_id=? ORDER BY id DESC LIMIT 1',[fromId]);
 if(!previous||get('SELECT id FROM business_ai_run WHERE artifact_id=?',[toId]))return;
 const pack=JSON.parse(previous.snapshot) as EvidencePack,draft=previous.draft?JSON.parse(previous.draft):null;
 if(draft){draft.values=Object.fromEntries(Object.entries(values&&typeof values==='object'&&!Array.isArray(values)?values:{}).map(([k,v])=>[k,String(v??'')]));draft.fieldFacts={};refreshAfterDraft(pack,draft.workbenchId,draft.periodId);}
 run(`INSERT INTO business_ai_run(parent_id,question,snapshot,answer,model,validation,draft,artifact_id)
 SELECT id,question,?,?,model,?,?,? FROM business_ai_run WHERE id=?`,[JSON.stringify(pack),draft?Object.values(draft.values).join('\n\n'):'恢复后的内容需重新核对',JSON.stringify(['经通用文书编辑或历史版本恢复生成；保留原证据快照，当前内容必须重新人工核对，旧核对记录不继承。']),draft?JSON.stringify(draft):null,toId,previous.id]);
}
