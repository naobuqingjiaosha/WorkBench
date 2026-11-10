import { createHash } from 'node:crypto';
import { all, get, run, tx, type SqlValue } from '../db/index.ts';
import { ApiError } from '../api/reply.ts';

export type RecordNature = 'done' | 'progress' | 'plan' | 'unknown';
export interface WorkRecord {
 id:number; text:string; occurred_from:string|null; occurred_to:string|null; date_precision:string;
 nature:RecordNature; workbench_id:number|null; source:string; source_message_id:number|null;
 revision:number; status:'active'|'withdrawn'; created_at:string; updated_at:string;
}
export const natureLabels:Record<RecordNature,string>={done:'已做（用户陈述）',progress:'进展',plan:'计划',unknown:'性质待明确'};
export const recordHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const recordToday=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const shift=(day:string,days:number)=>new Date(Date.parse(day+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
function date(value:unknown):string|null {
 if(value===null||value===undefined||value==='')return null;
 const s=String(value);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)throw new ApiError('BAD_DATE','请输入有效日期');return s;
}
function monthRange(year:number,month:number){const from=`${year}-${String(month).padStart(2,'0')}-01`;date(from);return {from,to:new Date(Date.UTC(year,month,0)).toISOString().slice(0,10)};}
/** 保守本地解析；多种时间／混合计划保留未知，原话始终是依据。 */
export function interpretRecord(text:string,today=recordToday()) {
 let from:string|null=null,to:string|null=null,precision='unknown';
 const explicit=[...text.matchAll(/(\d{4})[-年/](\d{1,2})[-月/](\d{1,2})日?/g)];
 const relative=[...text.matchAll(/今天|今日|昨天|昨日|前天|明天|后天|本周|这周|上周|本月|这个月|上个月|上月/g)];
 if(explicit.length===1&&!relative.length){const m=explicit[0]!;try{from=date(`${m[1]}-${m[2]!.padStart(2,'0')}-${m[3]!.padStart(2,'0')}`);to=from;precision='day';}catch{/* Invalid text dates remain unknown. */}}
 else if(!explicit.length&&relative.length===1){const word=relative[0]![0];
  const days:Record<string,number>={今天:0,今日:0,昨天:-1,昨日:-1,前天:-2,明天:1,后天:2};
  if(word in days){from=shift(today,days[word]!);to=from;precision='day';}
  else if(/周/.test(word)){const weekday=new Date(today+'T00:00:00Z').getUTCDay()||7;from=shift(today,1-weekday-(word==='上周'?7:0));to=shift(from,6);precision='range';}
  else {let y=Number(today.slice(0,4)),m=Number(today.slice(5,7));if(/上/.test(word)&&--m===0){y--;m=12}({from,to}=monthRange(y,m));precision='month';}
 }else if(!explicit.length&&!relative.length){const m=text.match(/(?<!\d)(\d{1,2})月(\d{1,2})日/);if(m&&/今年|去年|上年/.test(text)&&!/前年|明年/.test(text)){try{from=date(`${Number(today.slice(0,4))-(/去年|上年/.test(text)?1:0)}-${m[1]!.padStart(2,'0')}-${m[2]!.padStart(2,'0')}`);to=from;precision='day';}catch{/* retain raw text */}}}
 const plan=/计划|准备|打算|拟于|明天|后天|下周|下月|将要/.test(text),done=/已经|已(?!经?计划|经?准备)|完成了|发给.*了|发送.*了|提交.*了|整理.*了|参加.*了|开.*会了|办好了/.test(text);
 const negative=/未|没有|没能|尚未|假设|如果|比如|例如|他说|她说|转述|是否|[?？]/.test(text);
 let nature:RecordNature='unknown';
 if(!negative && !(plan && done)) {
  if(plan) nature='plan';
  else if(done) nature='done';
  else if(/正在|进行中|处理中|推进中/.test(text)) nature='progress';
 }
 if(nature==='done'&&from&&from>today)nature='unknown';
 return {occurred_from:from,occurred_to:to,date_precision:precision,nature};
}
function fields(input:Record<string,unknown>,today=recordToday()) {
 const text=typeof input.text==='string'?input.text.trim():'';if(!text||text.length>10000)throw new ApiError('BAD_TEXT','工作记录需为1至10000字');
 const inferred=interpretRecord(text,today);let from=inferred.occurred_from,to=inferred.occurred_to,precision=inferred.date_precision;
 if(input.occurred_from!==undefined||input.occurred_to!==undefined){from=date(input.occurred_from);to=date(input.occurred_to??input.occurred_from);if(Boolean(from)!==Boolean(to)||from&&to&&from>to)throw new ApiError('BAD_DATE','发生时间范围无效');precision=!from?'unknown':from===to?'day':'range';}
 const nature=(input.nature??inferred.nature) as RecordNature;if(!Object.hasOwn(natureLabels,nature))throw new ApiError('BAD_NATURE','工作记录性质无效');
 if(nature==='done'&&from&&from>today)throw new ApiError('FUTURE_DONE','未来的安排不能登记为已经做过');
 const wid=input.workbench_id==null||input.workbench_id===''?null:Number(input.workbench_id);
 if(wid!==null&&(!Number.isSafeInteger(wid)||!get('SELECT id FROM workbench WHERE id=? AND deleted_at IS NULL',[wid])))throw new ApiError('BAD_WORK','关联工作不存在或已移入回收站');
 return {text,occurred_from:from,occurred_to:to,date_precision:precision,nature,workbench_id:wid};
}
export function requireRecord(id:number):WorkRecord {const row=get<WorkRecord>('SELECT * FROM work_record WHERE id=?',[id]);if(!row)throw new ApiError('NOT_FOUND','工作记录不存在',404);return row;}
export function createWorkRecord(input:Record<string,unknown>,source='用户录入',messageId:number|null=null):WorkRecord {
 const key=String(input.request_key??'');if(!/^[\w:-]{8,160}$/.test(key))throw new ApiError('REQUEST_KEY','缺少有效提交标识，请刷新后重试');
 const hash=recordHash({text:input.text,occurred_from:input.occurred_from,occurred_to:input.occurred_to,nature:input.nature,workbench_id:input.workbench_id??null});
 return tx(()=>{const prior=get<WorkRecord&{request_hash:string}>('SELECT * FROM work_record WHERE request_key=?',[key]);if(prior){if(prior.request_hash!==hash)throw new ApiError('REQUEST_CONFLICT','提交标识已被另一条内容使用',409);return prior;}
  const f=fields(input);const id=run('INSERT INTO work_record(text,occurred_from,occurred_to,date_precision,nature,workbench_id,source,source_message_id,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',[f.text,f.occurred_from,f.occurred_to,f.date_precision,f.nature,f.workbench_id,source,messageId,key,hash]).lastInsertRowid;return requireRecord(id);
 });
}
export function changeWorkRecord(id:number,input:Record<string,unknown>):WorkRecord {
 return tx(()=>{const old=requireRecord(id);if(input.revision!==old.revision)throw new ApiError('RECORD_CONFLICT','记录已被更正，请刷新核对后再保存',409);
  const status=input.status??old.status;if(status!=='active'&&status!=='withdrawn')throw new ApiError('BAD_STATUS','记录状态无效');
  const edited=['text','occurred_from','occurred_to','nature','workbench_id'].some(k=>Object.hasOwn(input,k));
  if(old.status==='withdrawn'&&edited)throw new ApiError('WITHDRAWN','请先恢复这条记录再更正',409);
  // State-only restoration must also work when the formerly linked work was removed.
  const f=edited?fields({...old,...input}):old;
  run('INSERT INTO work_record_history(record_id,revision,snapshot) VALUES(?,?,?)',[id,old.revision,JSON.stringify(old)]);
  run("UPDATE work_record SET text=?,occurred_from=?,occurred_to=?,date_precision=?,nature=?,workbench_id=?,status=?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",[f.text,f.occurred_from,f.occurred_to,f.date_precision,f.nature,f.workbench_id,String(status),id]);return requireRecord(id);
 });
}
export interface RecordQuery {q?:string;from?:string;to?:string;nature?:string;status?:string;workbenchId?:number;page?:number;pageSize?:number;}
export function searchWorkRecords(input:RecordQuery={}) {
 const clauses=['status=?'],params:SqlValue[]=[input.status==='withdrawn'?'withdrawn':'active'];
 const q=String(input.q??'').trim();if(q.length>200)throw new ApiError('BAD_QUERY','关键词过长');if(q){clauses.push('instr(lower(text),lower(?))>0');params.push(q)}
 if(input.workbenchId!==undefined){if(!Number.isSafeInteger(input.workbenchId)||input.workbenchId<=0)throw new ApiError('BAD_WORK','关联工作无效');clauses.push('workbench_id=?');params.push(input.workbenchId)}
 if(input.nature){if(!Object.hasOwn(natureLabels,input.nature))throw new ApiError('BAD_NATURE','性质筛选无效');clauses.push('nature=?');params.push(input.nature)}
 const from=date(input.from),to=date(input.to);if(from&&to&&from>to)throw new ApiError('BAD_DATE','查询起止日期顺序错误');
 const base=clauses.join(' AND '),baseParams=[...params];
 const unknown=get<{n:number}>(`SELECT count(*) n FROM work_record WHERE ${base} AND occurred_from IS NULL`,params)!.n;
 if(from){clauses.push('occurred_to>=?');params.push(from)}if(to){clauses.push('occurred_from<=?');params.push(to)}
 const where=clauses.join(' AND ');const total=get<{n:number}>(`SELECT count(*) n FROM work_record WHERE ${where}`,params)!.n;
 const counts=all<{nature:RecordNature;n:number}>(`SELECT nature,count(*) n FROM work_record WHERE ${where} GROUP BY nature`,params);
 const page=input.page??1,pageSize=input.pageSize??30;if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new ApiError('BAD_PAGE','分页参数无效');
 const items=all<WorkRecord>(`SELECT * FROM work_record WHERE ${where} ORDER BY occurred_from DESC,id DESC LIMIT ? OFFSET ?`,[...params,pageSize,(page-1)*pageSize]);
 return {items,total,page,pageSize,counts,unknownDateCount:unknown,unknownItems:from||to?all<WorkRecord>(`SELECT * FROM work_record WHERE ${base} AND occurred_from IS NULL ORDER BY id DESC LIMIT ? OFFSET ?`,[...baseParams,pageSize,(page-1)*pageSize]):[]};
}
export const recordHistory=(id:number)=>{requireRecord(id);return all<{snapshot:string}>('SELECT snapshot FROM work_record_history WHERE record_id=? ORDER BY revision DESC',[id]).map(h=>JSON.parse(h.snapshot) as WorkRecord);};
export interface RecordRef {id:number;revision:number;}
export function changedRecordRefs(refs:RecordRef[]){return refs.filter(ref=>{const r=get<WorkRecord>('SELECT * FROM work_record WHERE id=?',[ref.id]);return !r||r.status!=='active'||r.revision!==ref.revision;});}
export function recordReplyChanges(messageId:number){const row=get<{record_refs:string}>('SELECT record_refs FROM work_record_answer WHERE message_id=?',[messageId]);return row?changedRecordRefs(JSON.parse(row.record_refs) as RecordRef[]):[];}

export function recordIntent(message:string):'capture'|'query'|null {
 const text=message.trim();if(/^(?:记一下|记一条|记住|记录一下|帮我记下|帮我记录|记下来)(?:[：:\s]|(?=我|今天|昨天|前天|明天|已|刚|准备))/.test(text))return 'capture';
 if(/(?:工作记录|工作记忆|我.*(?:做了什么|做过什么|干了什么|做了哪些)|(?:这个月|本月|上月|上个月|这周|本周|今年|本季度).*做了什么|上次.*(?:什么|哪些)|(?:帮我|给我).*(?:月度总结|工作总结)|(?:本月|本季度|今年).*工作总结)/.test(text))return 'query';
 if(/(?:[?？]|是否|怎么|如何|如果|假设|比如|例如|他说|她说|转述)/.test(text))return null;
 if(/^(?:我(?:今天|昨天|前天)?|今天(?:我)?|昨天(?:我)?|前天(?:我)?)/.test(text)&&/(?:完成了|已(?:经)?|发给.*了|发送.*了|提交.*了|整理.*了|参加.*了|开.*会了|办好了|准备|计划|正在)/.test(text))return 'capture';
 return null;
}
export function queryFromRecordMessage(message:string,today=recordToday()):RecordQuery {
 const result:RecordQuery={pageSize:50};const month=message.match(/(\d{4})年(\d{1,2})月/);let y=Number(today.slice(0,4)),m=Number(today.slice(5,7));
 if(month){Object.assign(result,monthRange(Number(month[1]),Number(month[2])))}
 else if(/上个月|上月/.test(message)){if(--m===0){m=12;y--}Object.assign(result,monthRange(y,m))}
 else if(/今天|今日|昨天|昨日|前天/.test(message)){const range=interpretRecord(message.match(/今天|今日|昨天|昨日|前天/)![0],today);result.from=range.occurred_from!;result.to=range.occurred_to!;}
 else if(/本月|这个月|月度/.test(message))Object.assign(result,monthRange(y,m));
 else if(/本季度|这个季度/.test(message)){const first=Math.floor((m-1)/3)*3+1;result.from=monthRange(y,first).from;result.to=monthRange(y,first+2).to;}
 else if(/今年|年度/.test(message)){result.from=`${y}-01-01`;result.to=`${y}-12-31`;}
 else if(/上周|本周|这周/.test(message)){const range=interpretRecord(message.match(/上周|本周|这周/)![0],today);result.from=range.occurred_from!;result.to=range.occurred_to!;}
 const keyword=message.match(/(?:关键词|查找|搜索)[：:\s]+([^\n]+)/)?.[1]??message.match(/[“「"]([^”」"]+)[”」"]/)?.[1];
 if(keyword)result.q=keyword.trim();else {const last=message.match(/上次给(.+?)(?:发|送|交)/);if(last)result.q=last[1];}
 const page=message.match(/第\s*(\d+)\s*页/);if(page)result.page=Number(page[1]);return result;
}
export function answerFromRecords(message:string,workbenchId?:number|null) {
 const query=queryFromRecordMessage(message);if(workbenchId)query.workbenchId=workbenchId;const result=searchWorkRecords(query);
 const refs:RecordRef[]=[...result.items,...result.unknownItems].map(r=>({id:r.id,revision:r.revision}));
 const rows=(items:WorkRecord[])=>items.map(r=>`- ${natureLabels[r.nature]} · ${r.occurred_from??'发生日期未说明'}${r.occurred_to&&r.occurred_to!==r.occurred_from?'至'+r.occurred_to:''}：[工作记录 #${r.id} v${r.revision}](#/records?id=${r.id})\n  原话：${r.text}`).join('\n');
 const counts=result.counts.map(c=>`${natureLabels[c.nature]}${c.n}条`).join('、');
 const summary=/总结|汇报/.test(message);
 let text=`${summary?'工作记录回顾（按原话整理，可作为总结素材）':'工作记录查询'}\n\n范围：${query.from??'不限起始'}至${query.to??'不限结束'}${query.q?'；关键词：'+query.q:''}。找到${result.total}条记录${counts?'（'+counts+'）':''}，记录条数不等于已完成事项数。\n\n`;
 text+=result.items.length?rows(result.items):'没有找到符合条件的记录；不能据此认定没有开展工作。';
 if(query.from||query.to)text+=`\n\n另有${result.unknownDateCount}条发生日期未说明的记录，未计入期间结果。`+(result.unknownItems.length?'\n'+rows(result.unknownItems):'');
 const pages=Math.max(1,Math.ceil(Math.max(result.total,(query.from||query.to)?result.unknownDateCount:0)/result.pageSize));
 text+=`\n\n第${result.page}/${pages}页，每组最多${result.pageSize}条。${pages>result.page?'可带相同时间和关键词询问“第'+(result.page+1)+'页”，或在工作记录页查看。':''}\n来源为你的告知，计划与进展不代表已完成；本查询只覆盖工作记录，不代替正式项目／月检数据。`;
 return {text,refs,result};
}
