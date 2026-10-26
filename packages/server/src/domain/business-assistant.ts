import {writeEvidence,materialize,type WritingAudit} from './evidence-writing.ts';
import {documentSourceSignature} from './document-source.ts';
import {refreshAfterDraft} from './business-evidence.ts';
import { all, get, run } from '../db/index.ts';
import { chat, parseJsonLoose, resolveTarget } from '../ai/gateway.ts';
import { getSetting } from '../core/config.ts';
import { scanTemplateStructure } from '../core/template.ts';
import { getTemplate, templateAbsPath, getWorkbench, workbenchOutputDirAbs } from './service.ts';
import { DATA_ROOT } from '../core/config.ts';
import { isInsideRoot } from '../core/paths.ts';
import { saveGeneratedDocument } from './generate.ts';
import { collectBusinessEvidence, evidenceChanges, type BusinessScope, type EvidencePack } from './business-evidence.ts';
import { ApiError } from '../api/reply.ts';
import { findChainHead } from './versions.ts';
import { documentPeriodKey } from './inspections.ts';
import { requirePeriod } from './periods.ts';
import {prepareEvidenceTask,writingFacts,businessDraftNotices} from './evidence-task.ts';

export interface BusinessDraft { templateId:number; workbenchId:number; periodId:number; values:Record<string,string>; fieldFacts:Record<string,string[]> }
export interface BusinessResult { id:number; evidence:EvidencePack; answer:string; model:string; validation:string[]; draft:BusinessDraft|null; artifactId:number|null; changes:string[]; writing:WritingAudit|null }
const RECOMMENDATIONS = {
 verify:'建议逐项核对待核实记录与原始凭证，补全未能读取的资料。',
 delivery:'建议与责任方核对待交付事项、约定日期和验收依据，记录实际交付后再更新状态。',
 coordination:'建议明确协调事项的责任人、处理时限及下一次跟进安排。',
 conflict:'建议先核清冲突资料的适用期间、版本和统计口径，再形成正式结论。',
 archive:'建议对照项目归档要求核对合同、会议、交付及验收资料；项目结束不能代替档案核对。',
} as const;
type Plan={factIds:string[];recommendations:(keyof typeof RECOMMENDATIONS)[]};
/** Model prose is never promoted to fact. Only IDs and a closed set of follow-up actions can pass. */
export function validateBusinessPlan(value:unknown,pack:EvidencePack):Plan {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('模型未返回可检查的证据引用');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['factIds','recommendations'].includes(k)))throw new Error('模型输出了未授权的事实文本或字段');
 if(!Array.isArray(v.factIds)||v.factIds.length>200||!v.factIds.every(id=>typeof id==='string'&&pack.facts.some(f=>f.id===id)))throw new Error('模型引用了不存在的事实，已拒绝使用');
 if(!Array.isArray(v.recommendations)||v.recommendations.length>5||!v.recommendations.every(k=>typeof k==='string'&&Object.hasOwn(RECOMMENDATIONS,k)))throw new Error('模型建议不符合受控输出要求');
 const applicable=new Set<string>(['verify']);
 if(pack.facts.some(f=>f.kind==='followup'&&f.text.includes('供应商交付')))applicable.add('delivery');
 if(pack.facts.some(f=>f.kind==='followup'&&f.text.includes('协调事项')))applicable.add('coordination');
 if(pack.facts.some(f=>f.kind==='project'))applicable.add('archive');
 if(pack.conflicts.length)applicable.add('conflict');
 return {factIds:[...new Set(v.factIds)] as string[],recommendations:[...new Set(v.recommendations)].filter(k=>applicable.has(String(k))) as Plan['recommendations']};
}
export function defaultPlan(pack:EvidencePack):Plan {
 return {factIds:writingFacts(pack).slice(0,200).map(f=>f.id),recommendations:[...pack.facts.some(f=>f.kind==='followup')?['delivery','coordination'] as const:[],...pack.conflicts.length?['conflict'] as const:[], 'verify']};
}
export function renderAnswer(pack:EvidencePack,plan:Plan):string {
 if(pack.task){
  const facts=writingFacts(pack).filter(f=>plan.factIds.includes(f.id));
  return [facts.length?'以下为相关来源摘录，尚未形成通过核验的自然语言回答：':'目前没有足够的相关资料回答该问题，不表示事情没有发生。',...facts.map(f=>`${f.bodyText??f.text}〔${f.id}〕`),...businessDraftNotices(pack)].join('\n\n');
 }
 const ordered=[...plan.factIds,...pack.facts.map(f=>f.id).filter(id=>!plan.factIds.includes(id))].map(id=>pack.facts.find(f=>f.id===id)!);
 const cite=(f:typeof ordered[number])=>`${f.text}〔${f.id}〕`;
 const confirmed=ordered.filter(f=>f.certainty==='confirmed'&&f.kind!=='inspection'&&(f.kind!=='work'||!pack.coverage.periods)).slice(0,24),pending=ordered.filter(f=>f.certainty==='unverified'&&f.kind!=='document').slice(0,4);
 return [pack.scope.start?`资料范围：${pack.scope.start} 至 ${pack.scope.end}（结束日不含）。`:'资料范围：所选工作当前登记记录。',
  '已确认的登记事实',confirmed.map(cite).join('\n\n')||'没有可核查的结构化事实；不能据此编写工作已完成的结论。',
  pending.length?'有来源但待核实':'',pending.map(cite).join('\n\n'),
  '分析判断',pack.facts.some(f=>f.kind==='followup')?'当前登记存在待办理事项，应跟进责任方与期限；这不代表已证实违约或延期。':'目前资料不能支持额外的成效、验收或风险等级判断。',
  '建议内容（尚未执行）',plan.recommendations.map(k=>RECOMMENDATIONS[k]).join('\n'),
  '信息缺口与待核实',pack.gaps.slice(0,8).join('\n')||'自由文本中的真实性、签章及报送效力仍需人工核对。',
  ...pack.conflicts.map(c=>`冲突：${c.field}。${c.candidates.map(x=>`${x.value}〔${x.source}〕`).join('；')}`),
  `本次覆盖 ${pack.coverage.workbenches} 份工作、${pack.coverage.periods} 个期次；${pack.coverage.candidateFiles} 份候选文件中读取 ${pack.coverage.readFiles} 份。逐次检查、文件节选及全部事实请展开证据面板。未查询到记录不表示事情没有发生。`,
 ].filter(Boolean).join('\n\n');
}

function buildDraft(pack:EvidencePack,targetWorkbenchId?:number):BusinessDraft {
 const scopes=pack.sources.filter(s=>s.table==='work_period');
 const targets=all<{id:number;workbench_id:number;snapshot:string}>(`SELECT p.id,p.workbench_id,p.snapshot FROM work_period p JOIN workbench w ON w.id=p.workbench_id JOIN work_type t ON t.id=w.work_type_id WHERE t.code='integrity-quarter-summary' AND w.deleted_at IS NULL AND p.status='open' AND p.report_date=?`,[pack.scope.start!]).filter(p=>scopes.some(s=>s.recordId===p.id)&&(!targetWorkbenchId||p.workbench_id===targetWorkbenchId));
 if(targets.length!==1)throw new ApiError('DRAFT_TARGET_REQUIRED',targets.length?'有多个季度汇报工作，请选择所属工作后重新起草。':'未找到本季度可写的汇报期次，请先在既有工作中建立或打开对应季度并选择Word模板。');
 const target=targets[0]!,ids=(JSON.parse(target.snapshot).templates??[]).map((t:{id:number})=>t.id);
 const templates=ids.map((id:number)=>getTemplate(id)).filter((t:ReturnType<typeof getTemplate>)=>t&&t.file_format==='docx'&&!t.archived_at);
 if(templates.length!==1)throw new ApiError('DRAFT_TEMPLATE_REQUIRED','请为汇报期次选择一份适用Word模板（当前为零份或多份），随后重新起草。');
 const template=templates[0]!,fields=scanTemplateStructure(templateAbsPath(template)).fields,values:Record<string,string>={},fieldFacts:Record<string,string[]>={};
 const profile=JSON.parse(getWorkbench(target.workbench_id)?.profile||'{}') as Record<string,unknown>;
 const year=Number(pack.scope.start!.slice(0,4)),quarter=Math.ceil(Number(pack.scope.start!.slice(5,7))/3);
 for(const field of fields){
  const native:Record<string,string>={'年份':String(year),'本季度':String(quarter),'下季度':String(quarter%4+1),'下季度年份':String(year+(quarter===4?1:0)),'报告期':`${year}-Q${quarter}`};
  if(native[field]){values[field]=native[field]!;fieldFacts[field]=[];continue;}
  if(['单位名称','部门名称'].includes(field)){values[field]=typeof profile[field]==='string'?profile[field] as string:`【待补：${field}】`;fieldFacts[field]=[];continue;}
  if(/计划|建议|后续安排/.test(field)){values[field]=`【待补：${field}的针对性建议尚未形成，须结合本期问题整理】`;fieldFacts[field]=[];continue;}
  if(/导语/.test(field)){
   const facts=writingFacts(pack).filter(f=>!['work','period','metric','query'].includes(f.kind)&&!['安全','合同','采购'].some(t=> (f.bodyText??f.text).includes(t)));
   values[field]=facts.map(f=>`资料记载：${f.bodyText??f.text}〔${f.id}〕`).join('\n\n')||`【待补：${year}年第${quarter}季度工作概述，按本期业务资料起草】`;fieldFacts[field]=facts.map(f=>f.id);continue;
  }
  const topic=/安全/.test(field)?'安全':/合同/.test(field)?'合同':/采购/.test(field)?'采购':null;
  const issues=/问题|整改/.test(field);
  const facts=writingFacts(pack).filter(f=>!['work','period','metric'].includes(f.kind)&&(!topic||f.text.includes(topic))&&(!issues||['inspection','followup','record'].includes(f.kind)));
  if(/情况|内容|正文|工作|问题|整改/.test(field)){
   fieldFacts[field]=facts.map(f=>f.id);values[field]=facts.map(f=>`资料记载：${f.bodyText??f.text}〔${f.id}〕`).join('\n\n')||'【待补：现有资料无法支持本项内容，须人工核对】';
   if(/问题|整改/.test(field)&&businessDraftNotices(pack).length)values[field]+='\n\n待核实事项：\n'+businessDraftNotices(pack).join('\n');
  }else {values[field]=`【待补：${field}】`;fieldFacts[field]=[];}
 }
 const unmapped=writingFacts(pack).filter(f=>pack.task?.requiredFactIds.includes(f.id)&&!Object.values(fieldFacts).some(ids=>ids.includes(f.id)));
 if(unmapped.length){const field=fields.find(f=>/导语|概述/.test(f));if(field){values[field]+='\n\n'+unmapped.map(f=>`资料记载：${f.bodyText??f.text}〔${f.id}〕`).join('\n\n');fieldFacts[field]!.push(...unmapped.map(f=>f.id));}else throw new ApiError('DRAFT_COVERAGE','模板无法容纳必要事实：'+unmapped.map(f=>f.id).join('、'));}
 return {templateId:template.id,workbenchId:target.workbench_id,periodId:target.id,values,fieldFacts};
}

export async function runBusinessAssistant(input:{question:string;scope:BusinessScope;draft?:boolean;targetWorkbenchId?:number;messageId?:number;useModel?:boolean}):Promise<BusinessResult & {usage:{prompt:number;output:number;total:number}}> {
 if(!input.question.trim()||input.question.length>4000)throw new ApiError('BAD_QUESTION','问题不能为空且不能超过4000字');
 const configured=Number(getSetting('ai.business_context_chars','24000')),budget=Number.isFinite(configured)?configured:24000;
 const evidence=prepareEvidenceTask(await collectBusinessEvidence(input.scope,budget),input.question,input.draft?'report':'answer'),validation:string[]=[];
 let draft:BusinessDraft|null=null;
 if(input.draft)try{draft=buildDraft(evidence,input.targetWorkbenchId);}catch(e){validation.push((e as Error).message);}
 const native=new Set(['年份','本季度','下季度','下季度年份','报告期','单位名称','部门名称']);
 const fields=draft?Object.keys(draft.values).filter(f=>!native.has(f)):['正文'];
 let writing:WritingAudit={mode:'local-rules',status:'本地规则证据整理，未完成模型写作',output:null,calls:[],checks:[],issues:[]};
 if(input.useModel!==false&&evidence.facts.length){
  let limit=8192;try{limit=Math.min(12000,resolveTarget('writing').profile.max_tokens||8192);}catch{}
  writing=await writeEvidence(input.question,evidence,fields,limit,budget,()=>{
   const changes=evidenceChanges(evidence);
   if(changes.length)throw new ApiError('EVIDENCE_STALE','来源已变化，停止后续模型调用',409,changes);
  });
 }
 validation.push(writing.status,...writing.checks,...writing.issues);
 const model=writing.calls.filter(c=>c.purpose==='writing').map(c=>c.provider+'/'+c.model).join('；')||'未调用模型（确定性证据整理）';
 const usage=writing.calls.reduce((a,c)=>({prompt:a.prompt+c.usage.prompt,output:a.output+c.usage.output,total:a.total+c.usage.total}),{prompt:0,output:0,total:0});
 let answer=renderAnswer(evidence,validateBusinessPlan(defaultPlan(evidence),evidence));
 if(writing.output){
  answer=writing.output.paragraphs.map(p=>materialize(p.text,evidence)).join('\n\n');
  if(draft)for(const field of fields){const paragraphs=writing.output.paragraphs.filter(p=>p.field===field);draft.values[field]=paragraphs.map(p=>materialize(p.text,evidence)).join('\n\n');draft.fieldFacts[field]=[...new Set(paragraphs.flatMap(p=>p.citations.map(c=>c.factId)))];}
 }
 // Business gaps stay visible; technical coverage and validation details stay in the source panel.
 if(draft){const warnings=businessDraftNotices(evidence);
  const field=fields.find(f=>/问题|整改/.test(f))||fields.at(-1);
  if(field){const missing=warnings.filter(w=>!Object.values(draft.values).some(v=>v.includes(w)));if(missing.length)draft.values[field]+='\n\n'+missing.join('\n');}
 }
 const changes=evidenceChanges(evidence);if(changes.length)throw new ApiError('EVIDENCE_STALE','资料在处理期间发生变化，请重新收集',409,changes);
 const id=run('INSERT INTO business_ai_run(message_id,question,snapshot,answer,model,validation,draft,writing) VALUES(?,?,?,?,?,?,?,?)',[input.messageId??null,input.question,JSON.stringify(evidence),answer,model,JSON.stringify(validation),draft?JSON.stringify(draft):null,JSON.stringify(writing)]).lastInsertRowid;
 if(draft)try{await saveBusinessDraft(id);}catch(e){validation.push('Word草稿尚未保存：'+(e as Error).message);run('UPDATE business_ai_run SET validation=? WHERE id=?',[JSON.stringify(validation),id]);}
 return {...getBusinessRun(id),usage};
}

export function getBusinessRun(id:number):BusinessResult {
 const r=get<{id:number;snapshot:string;answer:string;model:string;validation:string;draft:string|null;artifact_id:number|null;writing:string|null}>('SELECT * FROM business_ai_run WHERE id=?',[id]);
 if(!r)throw new ApiError('NOT_FOUND','证据快照不存在',404);
 const evidence=JSON.parse(r.snapshot) as EvidencePack;
 return {id:r.id,evidence,answer:r.answer,model:r.model,validation:JSON.parse(r.validation),draft:r.draft?JSON.parse(r.draft):null,artifactId:r.artifact_id,changes:evidenceChanges(evidence),writing:r.writing?JSON.parse(r.writing):null};
}

/** Only produces a new draft version; there is deliberately no final/status/delete operation here. */
const savingRuns=new Set<number>();
export async function saveBusinessDraft(id:number,edited?:Record<string,string>):Promise<BusinessResult> {
 if(savingRuns.has(id))throw new ApiError('DOCUMENT_BUSY','此草稿正在保存，请稍后打开最新版本。',409);
 savingRuns.add(id);try{return await saveBusinessDraftLocked(id,edited);}finally{savingRuns.delete(id);}
}
async function saveBusinessDraftLocked(id:number,edited?:Record<string,string>):Promise<BusinessResult> {
 if(get('SELECT id FROM business_ai_run WHERE parent_id=? AND artifact_id IS NOT NULL',[id]))throw new ApiError('DRAFT_CHANGED','已有较新的草稿，请打开最新版本。',409);
 const current=getBusinessRun(id);if(current.changes.length)throw new ApiError('EVIDENCE_STALE','来源已变化，请重新收集资料并起草，原草稿保留。',409,current.changes);
 if(!current.draft)throw new ApiError('NO_DRAFT','本次没有适用的季度汇报模板');
 const draft={...current.draft,values:{...current.draft.values}};
 if(edited){if(Object.keys(edited).some(k=>!Object.hasOwn(draft.values,k)||typeof edited[k]!=='string'||edited[k]!.length>50000))throw new ApiError('BAD_DRAFT','修改字段无效或内容过长');for(const k of Object.keys(edited))if(edited[k]!==draft.values[k])draft.fieldFacts={...draft.fieldFacts,[k]:[]};Object.assign(draft.values,edited);}
 // Editing prose does not silently remove unresolved source warnings from the exported Word.
 if(edited){const notices=[...businessDraftNotices(current.evidence),...writingFacts(current.evidence).filter(f=>current.evidence.task?.requiredFactIds.includes(f.id)&&/待复查|待补|尚未补齐|待核实|未确认.*适用|尚未确认.*适用/.test(f.bodyText??f.text)).map(f=>f.bodyText??f.text)];
  const field=Object.keys(draft.values).find(f=>/问题|整改/.test(f));
  if(field){const missing=notices.filter(n=>!Object.values(draft.values).some(v=>v.includes(n)));if(missing.length){draft.values[field]+='\n\n待核实事项：\n'+missing.join('\n');draft.fieldFacts={...draft.fieldFacts,[field]:[]};}}
 }
 // Never move files in a bound external source folder, even when the work uses inline outputs.
 const w=getWorkbench(draft.workbenchId);
 if(w?.external_root&&!isInsideRoot(DATA_ROOT,workbenchOutputDirAbs(w,'generated')))throw new ApiError('READ_ONLY_SOURCE','此工作输出位置仍在外部资料目录；请在工作设置中指定平台数据根内的可写输出目录。本次草稿及证据已保存在助手中。');
 const previous=current.artifactId?get<{is_final:number}>('SELECT is_final FROM artifact WHERE id=?',[current.artifactId]):undefined;
 if(current.artifactId&&!previous?.is_final){const head=findChainHead({workbenchId:draft.workbenchId,templateId:draft.templateId,periodKey:documentPeriodKey(requirePeriod(draft.periodId)),checklistItemId:null,positionCode:null});if(head&&head.id!==current.artifactId)throw new ApiError('DRAFT_CHANGED','已有较新的草稿，请打开最新版本或重新起草。',409);}
 const head=findChainHead({workbenchId:draft.workbenchId,templateId:draft.templateId,periodKey:documentPeriodKey(requirePeriod(draft.periodId)),checklistItemId:null,positionCode:null});
 const writing=current.writing?structuredClone(current.writing):null;
 const changedFields=Object.keys(draft.values).filter(k=>draft.values[k]!==current.draft!.values[k]);
 if(writing&&changedFields.length){writing.mode='human-edited';writing.status='人工修改版本，修改段落原引用及自动核验已失效';writing.checks=[];writing.output=null;}
 const validation=changedFields.length?['人工修改版本：修改文字未自动验证真实性，修改字段旧引用及全部旧核验结论已失效，需逐项核对后人工定稿。原模型核验记录仅保留在历史版本。']:[...current.validation];
 let runId=id;
 await saveGeneratedDocument({businessEvidenceManaged:true,fileName:`${getTemplate(draft.templateId)?.name??'季度汇报'}_${writing?.mode==='local-rules'?'待整理_未核验':writing?.mode==='human-edited'?'人工修改_待核对':'模型草稿_待人工核对'}.docx`,templateId:draft.templateId,workbenchId:draft.workbenchId,periodId:draft.periodId,values:draft.values,mode:edited?'manual':'hybrid',saveMode:current.artifactId&&!previous?.is_final?'update':'new',expectedHeadId:head?.id??null,expectedContextSignature:documentSourceSignature(draft.workbenchId,draft.periodId,draft.templateId,[]),
  onBusinessCommit:(artifact)=>{
   refreshAfterDraft(current.evidence,draft.workbenchId,draft.periodId);
   const changes=evidenceChanges(current.evidence);if(changes.length)throw new ApiError('EVIDENCE_STALE','保存期间来源发生变化，未保存本次草稿',409,changes);
   const answer=changedFields.length?Object.values(draft.values).join('\n\n'):current.answer;
   if(current.artifactId)runId=run('INSERT INTO business_ai_run(parent_id,question,snapshot,answer,model,validation,draft,artifact_id,writing) SELECT ?,question,?,?,?,?,?,?,? FROM business_ai_run WHERE id=?',[id,JSON.stringify(current.evidence),answer,current.model,JSON.stringify(validation),JSON.stringify(draft),artifact.id,writing?JSON.stringify(writing):null,id]).lastInsertRowid;
   else run('UPDATE business_ai_run SET artifact_id=?,draft=?,validation=?,snapshot=?,writing=? WHERE id=?',[artifact.id,JSON.stringify(draft),JSON.stringify(validation),JSON.stringify(current.evidence),writing?JSON.stringify(writing):null,id]);
  }
 });
 return getBusinessRun(runId);
}
