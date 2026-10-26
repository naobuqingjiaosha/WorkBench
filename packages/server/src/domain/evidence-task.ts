import type {BusinessFact, EvidencePack} from './business-evidence.ts';

/** A writing view, not a replacement for the original source/freshness snapshot. */
export interface EvidenceTask {
 mode:'answer'|'report'; question:string; factIds:string[]; requiredFactIds:string[];
 conflictIndexes:number[];
 metrics:(keyof EvidencePack['metrics'])[]; businessGaps:string[]; sourceNotes:string[];
}
const businessKinds=new Set(['inspection','record','document','followup','todo','project','stage']);
const topicGroups=[['培训','学习','授课','课程','参训'],['谈话','岗位交流'],['会议'],['采购'],['合同'],['安全'],['检查','核查','复查'],['交付'],['验收'],['付款'],['工期'],['预算'],['协调']];
// Negative relevance clauses are metadata about another topic, not evidence
// about that topic (e.g. an unrelated appointment mentioning a course).
const subjectText=(text:string)=>text.replace(/(?:与|和|同)[^。；\n]{0,60}(?:无关|没有关系)[^。；\n]*/g,'');
export function prepareEvidenceTask(pack:EvidencePack,question:string,mode:EvidenceTask['mode']):EvidencePack {
 const result=structuredClone(pack);
 const groups=topicGroups.filter(g=>g.some(t=>question.includes(t)));
 const requested=groups.map(g=>g[0]!);
 const comparison=/两份|两方|分别|一致|判断|结论/.test(question);
 const matches=(text:string)=>groups.some(g=>g.some(t=>subjectText(text).includes(t)));
 const statistical=/多少|几条|几次|数量|统计|总数|项目数|记录数/.test(question);
 const status=/待办|办理|报送|登记状态|进度|进展/.test(question);
 let chosen=pack.facts.filter(f=>{
  if(f.kind==='metric')return false;
  if(mode==='report')return businessKinds.has(f.kind);
  if(f.kind==='work')return status;
  if(!requested.length)return comparison?f.kind==='inspection':businessKinds.has(f.kind);
  return matches(f.text);
 });
 // A relevant business record brings its period context, not every period in the workspace.
 if(mode==='answer'){
  const sources=new Set(chosen.flatMap(f=>f.sources));
  chosen=pack.facts.filter(f=>chosen.includes(f)||(f.kind==='period'&&f.sources.some(s=>sources.has(s))));
 }
 // Never select only one side of an identified dispute.
 for(const c of pack.conflicts)if(c.candidates.some(x=>chosen.some(f=>f.sources.includes(x.source)))){
  for(const f of pack.facts)if(f.kind!=='metric'&&c.candidates.some(x=>f.sources.includes(x.source))&&!chosen.includes(f))chosen.push(f);
 }
 const metrics:EvidenceTask['metrics']=[];
 if(statistical){
  const inspections=pack.facts.filter(f=>f.kind==='inspection'),periods=pack.facts.filter(f=>f.kind==='period');
  if(inspections.length&&inspections.every(f=>chosen.includes(f))){metrics.push('inspections','projects','duplicateRecords');chosen.push(...pack.facts.filter(f=>f.kind==='metric'));}
  if(periods.length&&periods.every(f=>chosen.includes(f)))metrics.push('periods','completedPeriods');
 }
 const businessGaps=pack.gaps.filter(g=>!isSourceNote(g)&&(mode==='report'||(!/报送|归档|安排日期/.test(g)||/报送|归档|安排日期/.test(question))&&(!requested.length||matches(g))));
 result.task={mode,question,factIds:chosen.map(f=>f.id),requiredFactIds:chosen.filter(f=>businessKinds.has(f.kind)).map(f=>f.id),conflictIndexes:pack.conflicts.map((_,i)=>i).filter(i=>pack.conflicts[i]!.candidates.some(c=>chosen.some(f=>f.sources.includes(c.source)))),metrics,businessGaps,sourceNotes:pack.gaps.filter(g=>!businessGaps.includes(g))};
 if(mode==='answer'&&/检索|查找|查询.*(?:资料|记录)/.test(question))for(const topic of requested)addScopedQuery(result,topic);
 return result;
}
export function isSourceNote(text:string):boolean {
 return /节选|上下文|预算|索引|扫描上限|文件.*(?:读取|解析|路径|更新|隔离)|参考目录|统计口径|独立记录ID|疑似重复|未自动采信|仅反映登记/.test(text);
}
export function writingFacts(pack:EvidencePack):BusinessFact[]{return pack.task?pack.facts.filter(f=>pack.task!.factIds.includes(f.id)):pack.facts;}
export function writingConflicts(pack:EvidencePack){return pack.task?pack.conflicts.filter((_,i)=>pack.task!.conflictIndexes.includes(i)):pack.conflicts;}
export function businessDraftNotices(pack:EvidencePack):string[]{
 const gaps=pack.task?.businessGaps??pack.gaps.filter(g=>!isSourceNote(g));
 return [...gaps,...pack.files.some(f=>['unread','omitted','quarantined'].includes(f.state))?['【待核实：部分相关资料尚不能核实，本稿不作为完整工作结论。】']:[],...writingConflicts(pack).map(c=>'来源冲突待核实：'+c.field+'；'+c.candidates.map(x=>x.value).join('／'))];
}

/** Literal search of the actual retained text; never an assertion about unobserved activity. */
export function addScopedQuery(pack:EvidencePack,topic:string):BusinessFact {
 if(!topic.trim()||topic.length>80)throw Error('检索主题无效');
 const candidates=pack.facts.filter(f=>businessKinds.has(f.kind));
 const hits=candidates.filter(f=>f.text.includes(topic));
 const query={topic,scope:{...pack.scope},candidateFactIds:candidates.map(f=>f.id),hitFactIds:hits.map(f=>f.id),
  readFileIds:pack.files.filter(f=>['read','excerpt'].includes(f.state)).map(f=>f.id),
  omittedFileIds:pack.files.filter(f=>!['read','duplicate'].includes(f.state)).map(f=>f.id),omittedFacts:pack.coverage.omittedFacts,method:'literal-retained-text' as const};
 const id=`query-${pack.facts.filter(f=>f.kind==='query').length+1}`;
 const fact:BusinessFact={id,kind:'query',certainty:'confirmed',sources:[...new Set(candidates.flatMap(f=>f.sources))],query,
  text:`在本次纳入并成功读取的资料文本中${hits.length?'检索到':'未检索到'}“${topic}”字面词项；仅限本次读取范围，不排除同义表述或未读取资料，不证明实际是否开展。`};
 pack.facts.push(fact);pack.task?.factIds.push(id);return fact;
}
