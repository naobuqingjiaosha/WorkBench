import type {BusinessFact,EvidencePack,EvidenceSource} from './business-evidence.ts';
import type {WritingIssue} from './evidence-checks.ts';

/** Offsets are UTF-16, half-open, in the bound snapshot's fact.text. Never search other facts. */
export interface CitationLocation {
 paragraphId:string; citationIndex:number; factId:string; originalQuote:string;
 status:'located'|'rejected'; reason:string; start?:number; end?:number;
 context?:string; contextStart?:number; contextEnd?:number;
 sources:Pick<EvidenceSource,'id'|'digest'|'fileDigest'|'version'|'locator'|'acquiredAt'>[];
}
export function locateCitation(c:unknown,pack:EvidencePack,paragraphId:string,citationIndex:number):{location:CitationLocation;fact?:BusinessFact;issue?:WritingIssue} {
 const input=c as {factId?:unknown;quote?:unknown}|null;
 const factId=typeof input?.factId==='string'?input.factId:'',quote=typeof input?.quote==='string'?input.quote:'';
 const location:CitationLocation={paragraphId,citationIndex,factId,originalQuote:quote,status:'rejected',reason:'',sources:[]};
 const reject=(code:WritingIssue['code'],reason:string)=>{location.reason=reason;return {location,issue:{code,paragraphId,factId,citationIndex,message:`${paragraphId} ${factId||'未指定ID'}：${reason}`}};};
 const matches=pack.facts.filter(f=>f.id===factId),fact=matches[0];
 if(!fact)return reject('citation_id_missing','引用ID不存在，未替换来源');
 if(matches.length!==1)return reject('source_integrity','事实ID在快照中不唯一');
 if(pack.task&&!pack.task.factIds.includes(factId))return reject('citation_out_of_scope','引用越出当前任务取材范围');
 if(fact.kind!=='metric'&&fact.kind!=='query'&&!fact.sources.length)return reject('source_integrity','事实缺少绑定来源快照');
 for(const id of fact.sources){
  const sources=pack.sources.filter(s=>s.id===id),s=sources[0];
  if(sources.length!==1||!s?.digest)return reject('source_integrity','绑定来源或版本快照缺失、不唯一');
  if((pack.scope.workbenchId&&s.workbenchId!==pack.scope.workbenchId)||(pack.scope.periodIds&&s.periodId&&!pack.scope.periodIds.includes(s.periodId)))return reject('citation_out_of_scope','绑定来源越出当前工作或期次');
  location.sources.push({id:s.id,digest:s.digest,fileDigest:s.fileDigest,version:s.version,locator:s.locator,acquiredAt:s.acquiredAt});
 }
 if(!quote.trim())return reject('citation_quote_missing','缺少可定位的逐字引文');
 const start=fact.text.indexOf(quote);
 if(start<0)return reject('citation_quote_not_found','引文不在所绑定事实中；未从其他来源补引');
 if(fact.text.indexOf(quote,start+1)>=0)return reject('citation_ambiguous','引文在绑定事实内有多处匹配，须提供可消歧的上下文');
 const end=start+quote.length;
 // Prefer the complete short business excerpt. A bounded window is only needed
 // for long facts; offsets always remain relative to the original fact.text.
 const bodyStart=fact.bodyText?fact.text.indexOf(fact.bodyText):-1;
 const wholeBody=bodyStart>=0&&fact.bodyText!.length<=400&&start>=bodyStart&&end<=bodyStart+fact.bodyText!.length;
 const contextStart=wholeBody?bodyStart:fact.text.length<=400?0:Math.max(0,start-96);
 const contextEnd=wholeBody?bodyStart+fact.bodyText!.length:fact.text.length<=400?fact.text.length:Math.min(fact.text.length,end+160);
 Object.assign(location,{status:'located',reason:'同一绑定事实内逐字唯一定位；展示上下文由程序截取，事实支持另行核验',start,end,contextStart,contextEnd,context:fact.text.slice(contextStart,contextEnd)});
 return {location,fact};
}
