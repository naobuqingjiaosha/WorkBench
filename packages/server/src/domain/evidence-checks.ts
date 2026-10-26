import type {EvidencePack,BusinessFact} from './business-evidence.ts';
import type {Passage} from './evidence-writing.ts';
import {writingConflicts} from './evidence-task.ts';
import {locateCitation} from './evidence-citations.ts';
export type IssueCode='citation_id_missing'|'citation_out_of_scope'|'source_integrity'|'source_stale'|'source_permission'|'citation_quote_missing'|'citation_quote_not_found'|'citation_ambiguous'|'citation_quality'|'citation_incomplete'|'unsupported_claim'|'semantic_pending'|'task_incomplete'|'technical_failure'|'conflict_context'|'query_coverage'|'irrelevant_content'|'writing_quality'|'invalid_structure';
export type IssueCategory='source'|'citation'|'fact'|'semantic'|'task'|'quality'|'technical';
export interface WritingIssue {code:IssueCode;message:string;paragraphId?:string;candidateFactIds?:string[];factId?:string;citationIndex?:number;category?:IssueCategory;related?:WritingIssue[]}
export const isWritingWarning=(issue:WritingIssue)=>['writing_quality','citation_quality'].includes(issue.code);
export function issueCategory(code:IssueCode):IssueCategory {
 if(['source_integrity','source_stale','source_permission','citation_id_missing','citation_out_of_scope'].includes(code))return 'source';
 if(code==='citation_quality'||code.startsWith('citation_')||code==='invalid_structure')return 'citation';
 if(code==='semantic_pending')return 'semantic';
 if(code==='task_incomplete')return 'task';
 if(code==='writing_quality'||code==='irrelevant_content')return 'quality';
 if(code==='technical_failure')return 'technical';
 return 'fact';
}
/** Only a failed binding's dependent support checks are folded into that root. */
export function organizeIssues(issues:WritingIssue[]):WritingIssue[]{
 const categorized=issues.map(i=>({...i,category:issueCategory(i.code),related:i.related?.map(r=>({...r,category:issueCategory(r.code)}))}));
 const absorbed=new Set<WritingIssue>();
 for(const issue of categorized){
  const root=issue.code==='citation_incomplete'&&issue.candidateFactIds?.length===1?categorized.find(i=>i.paragraphId===issue.paragraphId&&i.factId===issue.candidateFactIds![0]&&['citation_quote_missing','citation_quote_not_found','citation_ambiguous'].includes(i.code)):undefined;
  if(root){(root.related??=[]).push(issue);absorbed.add(issue);}
 }
 return categorized.filter(i=>!absorbed.has(i));
}
export class WritingValidationError extends Error {
 issues:WritingIssue[];
 constructor(issues:WritingIssue[]){super([...new Set(issues.filter(i=>!isWritingWarning(i)).map(i=>`[${i.code}] ${i.message}`))].join('\n'));this.issues=issues;this.name='WritingValidationError';}
}
const norm=(s:string)=>s.normalize('NFKC').replace(/\s+/g,'');
export function numericClaims(text:string):Set<string>{
 const result=new Set<string>();let year='';
 let rest=text.replace(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|\b)/g,(_,y,m,d)=>{result.add(`日期 ${y}-${+m}-${+d}`);result.add(`月日 ${+m}-${+d}`);result.add(`月份 ${y}-${+m}`);result.add(`年份 ${y}`);return ' ';});
 rest=rest.replace(/(\d{1,2})月(\d{1,2})日/g,(_,m,d)=>{result.add(`月日 ${+m}-${+d}`);return ' ';});
 rest=rest.replace(/(20\d{2})年\s*(\d{1,2})月|\b(20\d{2})-(\d{2})(?![-\d])|(\d{1,2})月/g,(all,y,m,y2,m2,month)=>{
  if(y||y2)year=y||y2;
  result.add(`月份 ${year?year+'-':''}${+(m||m2||month)}`);if(year)result.add(`年份 ${year}`);return ' ';
 });
 rest=rest.replace(/(20\d{2})年/g,(_,y)=>{result.add(`年份 ${y}`);return ' ';});
 for(const m of rest.matchAll(/\d+(?:\.\d+)?/g))result.add(`数字 ${+m[0]}`);
 return result;
}
export function supportsNumber(claim:string,text:string):boolean {
 const claims=numericClaims(text);
 if(claim.startsWith('年份 '))return text.includes(claim.slice(3));
 if(/^月份 \d{1,2}$/.test(claim))return [...claims].some(c=>c.startsWith('月份 ')&&c.split('-').at(-1)===claim.slice(3));
 return claims.has(claim);
}
export function citationIssue(id:string,message:string,pack:EvidencePack,refs:BusinessFact[],supports:(f:BusinessFact)=>boolean):WritingIssue {
 const candidates=pack.facts.filter(f=>(!pack.task||pack.task.factIds.includes(f.id))&&!refs.includes(f)&&supports(f));
 return {code:candidates.length?'citation_incomplete':'unsupported_claim',paragraphId:id,message,candidateFactIds:candidates.map(f=>f.id)};
}

/** Limited date-role checks. Presence of a date in a record does not make it
 * an event date. Ambiguous relationships remain for semantic/manual review. */
export function dateRoleIssues(p:Passage,refs:BusinessFact[]):WritingIssue[]{
 const spans=(text:string)=>{
  const dates=[...text.matchAll(/(?:(20\d{2})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?/g)];
  return dates.map((m,i)=>{
   const tail=text.slice(m.index!+m[0].length,dates[i+1]?.index??text.length).split(/[。；\n]/)[0]!;
   const prefix=text.slice(0,m.index).split(/[。；，,\n]/).pop()!;
   const bookPrefix=/(?:核对|登记|签发)(?:日期|时间|日)(?:为|是)?$/.test(prefix);
   const eventPrefix=/(?:完成|授课|开展|举行|召开)(?:日期|时间|日)(?:为|是)?$/.test(prefix)||/(?:培训|授课|会议|活动)(?:于|在)$/.test(prefix);
   const bookkeeping=bookPrefix||(!eventPrefix&&/核对单|核对日期|登记日期|签发日期|逐人核对/.test(tail.split(/[，,]/).slice(0,2).join('，')));
   const occurrence=!bookkeeping&&(eventPrefix||/(?:培训|授课|检查|谈话|会议|课程|活动|签到表).{0,60}(?:完成|开展|举行|召开|检查|记录|签名)|(?:开展|举行|召开).{0,25}(?:培训|谈话|会议|活动)/.test(tail));
   return {date:`${m[1]?m[1]+'-':''}${+m[2]!}-${+m[3]!}`,bookkeeping,occurrence};
  });
 };
 const sourceSpans=refs.flatMap(f=>spans(f.bodyText??f.text)),issues:WritingIssue[]=[];
 for(const claim of spans(p.text).filter(x=>x.occurrence)){
  const support=sourceSpans.filter(s=>s.date===claim.date||(!/^20\d{2}-/.test(claim.date)&&s.date.endsWith('-'+claim.date)));
  if(support.length&&support.every(s=>s.bookkeeping))issues.push({code:'unsupported_claim',paragraphId:p.id,message:`${p.id} 将核对或登记日期 ${claim.date} 用作活动发生日期`});
 }
 return issues;
}

/** Adjacent paragraphs may share a conflict argument, but not lend ordinary factual citations. */
export function conflictIssues(paragraphs:Passage[],pack:EvidencePack):WritingIssue[]{
 const issues:WritingIssue[]=[];
 const validRefs=(p:Passage)=>p.citations.flatMap((c,i)=>{const {fact}=locateCitation(c,pack,p.id,i);return fact&&fact.kind!=='metric'?[fact]:[];});
 for(const conflict of writingConflicts(pack)){
  const values=conflict.candidates.map(c=>norm(c.value));
  const common=new Set<string>();
  const stop=/^(?:记录|资料|目前|提供|检查|结果|尚未|没有|整改|情况|已经|登记|同日|内容|齐全|缺失|完成|未附|凭证|原件|核对|不一致)$/;
  for(const run of values[0]?.match(/[\p{Script=Han}A-Za-z0-9]+/gu)??[])for(let n=2;n<=Math.min(12,run.length);n++)for(let i=0;i+n<=run.length;i++){
   const s=run.slice(i,i+n);if(!stop.test(s)&&values.slice(1).every(v=>v.includes(s)))common.add(s);
  }
  const touches=(p:Passage)=>typeof p?.text==='string'&&([...(common)].some(s=>norm(p.text).includes(s))||values.some(v=>v.length>=4&&norm(p.text).includes(v))||
   (validRefs(p).some(f=>conflict.candidates.some(c=>f.sources.includes(c.source)))&&/冲突|不一致|不同记载|待核|待确认|口径/.test(p.text)));
  const both=(p:Passage)=>conflict.candidates.every(c=>validRefs(p).some(f=>f.sources.includes(c.source)));
  for(let i=0;i<paragraphs.length;i++){
   const p=paragraphs[i]!;if(!touches(p))continue;
   const add=(message:string)=>issues.push({code:'conflict_context',paragraphId:p.id,message:`${p.id} ${message}`});
   if(!both(p)){add('冲突表述未引用全部相互矛盾的来源');continue;}
   let lo=i,hi=i;
   while(lo>0&&paragraphs[lo-1]!.field===p.field&&touches(paragraphs[lo-1]!)&&both(paragraphs[lo-1]!))lo--;
   while(hi+1<paragraphs.length&&paragraphs[hi+1]!.field===p.field&&touches(paragraphs[hi+1]!)&&both(paragraphs[hi+1]!))hi++;
   const unit=paragraphs.slice(lo,hi+1).map(p=>p.text).join('\n');
   const alternatives=conflict.candidates.every(c=>c.value.split(/[；;]/).filter(s=>s.trim()).every(s=>norm(unit).includes(norm(s))))||/不同记载|不一致|一份.{0,100}另一|一条.{0,100}另一/.test(unit);
   const unresolved=/待核|待确认|尚未|不能|未能|需.{0,12}(?:核|确认)|建议.{0,12}(?:核|确认)/.test(unit);
   const topicClauses=p.text.split(/[；。]/).filter(c=>[...common].some(s=>norm(c).includes(s)));
   const conditional=p.kind==='recommendation'&&topicClauses.length>0&&topicClauses.every(c=>/建议|核实|核对/.test(c)&&!/(?:因此|据此|所以|实际|已经|已完成|确认已|认定已)/.test(c.replace(/是否实际/g,'是否')));
   // A nearby disclaimer cannot turn a categorical choice into an attributed report.
   const decisive=topicClauses.some(c=>/(?:因此|据此|所以|可确定|可以确定|确认|认定|实际)/.test(c)&&!/(?:不能|尚未|未能|不宜|待|核实|核对|是否)/.test(c));
   const localAlternatives=values.every(v=>norm(p.text).includes(v.split(/[；;]/)[0]!));
   const chooses=values.some(v=>norm(p.text).includes(v.split(/[；;]/)[0]!))&&!localAlternatives;
   const attribution=/记录(?:结果)?(?:为|载明|记载|显示)|一份|另一份|一条|另一条|称|报告称/.test(p.text);
   const oneSided=chooses&&(!alternatives||!attribution);
   if(decisive||oneSided||(!conditional&&(!alternatives||!unresolved)))add('冲突须在连续论证单元交代双方不同记载及未解决状态，不能作出单边确定结论');
  }
 }
 return issues;
}

export function qualityIssues(paragraphs:Passage[],pack:EvidencePack):WritingIssue[]{
 if(!pack.task)return [];
 const issues:WritingIssue[]=[];const seen=new Set<string>();
 for(const p of paragraphs){
  const add=(code:IssueCode,message:string)=>issues.push({code,paragraphId:p.id,message:`${p.id} ${message}`});
  if(p.citations.some(c=>!pack.task!.factIds.includes(c.factId)))add('irrelevant_content','引用了当前任务未选用的状态、统计或其他主题资料');
  const variables=[...p.text.matchAll(/\{\{(\w+)\}\}/g)].map(m=>m[1]);
  if(variables.some(v=>!pack.task!.metrics.includes(v as keyof EvidencePack['metrics'])))add('irrelevant_content','当前问题不需要此统计指标，不能默认填零或列为缺口');
  const metadataRequested=/统计口径|计数口径|如何统计|去重|读取范围|核验|来源/.test(pack.task.question);
  if(pack.task.mode==='answer'&&!/报送|归档|办理流程/.test(pack.task.question)&&/报送|归档/.test(p.text))add('writing_quality','本题未要求报送或归档分析；该扩展不自动形成补资料任务，原文保留供核对');
  if(!metadataRequested&&/记录\s*ID|自动(?:合并|去重)|(?:全文|正文).{0,12}(?:读取|节选)|(?:系统|程序).{0,8}(?:确认结论|核验)|提取文本第\d+行/.test(p.text))add('writing_quality','技术核验信息应放在来源区域');
  if(pack.scope.end&&/(?:范围|期间).{0,12}为/.test(p.text)&&!/(?:结束日不含|不含结束日|半开)/.test(p.text)){
   const end=pack.scope.end.split('-').map(Number);if(p.text.includes(pack.scope.end)||p.text.includes(`${end[0]}年${end[1]}月${end[2]}日`))add('unsupported_claim','半开区间的结束日不能写成包含该日的业务期间');
  }
  if(pack.task.mode==='report'&&/方面|情况/.test(p.text)){
   const lead=p.text.split(/[。；]/)[0]!.split(/方面|情况/)[0]!;
   const cited=pack.facts.filter(f=>p.citations.some(c=>c.factId===f.id)).map(f=>f.bodyText??f.text).join('\n');
   if(!/未|待|缺|无/.test(lead)&&['会议','学习','培训','谈话'].some(topic=>lead.includes(topic)&&!cited.includes(topic)))add('semantic_pending','栏目需对应实际内容，不能将未提供活动列入标题');
  }
  for(const sentence of p.text.replace(/【待补：[^】]+】/g,'').split(/[。；]/).map(norm).filter(t=>t.length>=24)){
   if(seen.has(sentence))add('writing_quality','重复同一事实或核验说明');seen.add(sentence);
  }
 }
 if(pack.task.mode==='report'&&!/复述|已批准|既定计划/.test(pack.task.question)){
  for(const field of new Set(paragraphs.map(p=>p.field).filter(f=>/计划|建议|后续安排/.test(f)))){
   if(!paragraphs.some(p=>p.field===field&&p.kind==='recommendation'&&/建议/.test(p.text)&&!/^【待补/.test(p.text)&&p.citations.length))issues.push({code:'task_incomplete',message:`${field} 请求的建议内容未完成或缺少事实前提引用`});
  }
 }
 if(pack.task.mode==='answer'&&/是否|能否|完成了吗|完成了没有/.test(pack.task.question)&&!/(?:能|不能|尚|已|未|待|是|否|不足|无法)/.test(paragraphs[0]?.text??''))issues.push({code:'writing_quality',message:'首段应直接回答问题，再给依据及必要建议'});
 return issues;
}
