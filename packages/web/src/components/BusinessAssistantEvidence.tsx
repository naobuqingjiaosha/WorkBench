import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Card, Textarea, useAction, useToast } from '../ui';
import { FilePreview } from './FilePreview';

interface Finding {code:string;message:string;category?:string;related?:Finding[]}
interface Result {
 id:number;answer:string;model:string;artifactId:number|null;changes:string[];validation:string[];
 writing?:{mode:string;status:string;issues:string[];checks:string[];candidate?:{paragraphs:{id:string;field:string;text:string;kind?:string}[]};findings?:Finding[];citationLocations?:{paragraphId:string;citationIndex:number;factId:string;originalQuote:string;status:string;reason:string;start?:number;end?:number;context?:string;sources:{id:string;version?:number;digest:string;locator:string}[]}[];output:{paragraphs:{id:string;field:string;text:string;kind:string;citations:{factId:string;quote:string}[]}[]}|null;calls:{purpose:string;provider:string;model:string;ok:boolean;latencyMs:number;usage:{total:number};rawText?:string}[]}|null;
 draft:{workbenchId:number;periodId:number;values:Record<string,string>;fieldFacts:Record<string,string[]>}|null;
 evidence:{metrics:Record<string,number>;task?:{mode:string;factIds:string[];metrics:string[];businessGaps:string[];sourceNotes:string[]};scope:{start?:string;end?:string};acquiredAt:string;coverage:{candidateFiles:number;readFiles:number;omittedFacts:number};
 sources:{id:string;title:string;status:string;locator:string;href:string;table:string;recordId:number;periodId?:number}[];
 facts:{id:string;text:string;certainty:string;sources:string[]}[];gaps:string[];
 conflicts:{field:string;candidates:{value:string;source:string}[]}[];
 files:{id:number|string;title:string;state:string;reason:string;readChars:number;totalChars:number;href?:string}[];};
}
export default function BusinessAssistantEvidence({runId}:{runId:number}) {
 const [result,setResult]=useState<Result|null>(null),[activeId,setActiveId]=useState(runId),[values,setValues]=useState<Record<string,string>>({}),[periods,setPeriods]=useState<number[]>([]),[note,setNote]=useState(''),[preview,setPreview]=useState<number|null>(null);
 const {busy,run}=useAction(),toast=useToast();
 const accept=(r:Result)=>{setResult(r);setActiveId(r.id);setValues(r.draft?.values??{});setNote('');setPeriods(r.evidence.sources.filter(s=>s.table==='work_period').map(s=>s.recordId));};
 useEffect(()=>{api.get<Result>(`/api/agent/business/${runId}`).then(accept).catch(e=>toast(e.message,'err'));},[runId]);
 if(!result)return null;
 const displayText=(text:string)=>text.replace(/\{\{(inspections|projects|duplicateRecords|periods|completedPeriods)\}\}/g,(_,key:string)=>String(result.evidence.metrics[key]??'待核对'));
 const periodSources=result.evidence.sources.filter(s=>s.table==='work_period');
 const categoryNames:Record<string,string>={source:'来源完整性／权限',citation:'引用定位／格式',fact:'事实支持',semantic:'语义待核对',task:'任务未完成',quality:'表达质量',technical:'技术故障'};
 return <div style={{marginTop:12}}><Card title="业务证据与文书草稿">
  <p className="small">检索时间：{new Date(result.evidence.acquiredAt).toLocaleString()} · 文件读取 {result.evidence.coverage.readFiles}/{result.evidence.coverage.candidateFiles} · 模型：{result.model}</p>
  <div className={`notice ${result.writing?.mode==='model'?'':'notice-warn'}`}><strong>{result.writing?.status??'历史证据整理，未标记为模型自然写作'}</strong>{result.writing?.issues.map((v,i)=><p key={i}>{v}</p>)}</div>
  {!!result.writing?.calls.length&&<p className="small">{result.writing.calls.map((c,i)=><span key={i}>{c.purpose}：{c.provider}/{c.model} · {c.ok?'请求成功':'请求失败'} · {(c.latencyMs/1000).toFixed(1)} 秒 · {c.usage.total?`${c.usage.total} tokens`:'服务商未报告用量'}；</span>)}</p>}
  {result.writing?.calls.filter(c=>c.purpose==='writing'&&c.rawText).map((c,i)=><details key={i}><summary>未经修改的模型原稿（保留原始版本，不代表核验通过）</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{c.rawText}</pre></details>)}
  {!result.writing?.output&&result.writing?.candidate&&<section aria-label="未核验模型正文"><h4>未核验模型正文（原稿保留，不代表整份通过）</h4>{result.writing.candidate.paragraphs.filter(p=>p&&typeof p.text==='string').map((p,i)=><div key={i}><strong>{p.kind==='analysis'?'分析':p.kind==='recommendation'?'建议':'资料陈述'} · {p.field}</strong><p style={{whiteSpace:'pre-wrap'}}>{p.text}</p></div>)}</section>}
  {!!result.writing?.findings?.length&&<details open><summary>分项诊断（关联影响不另算独立事实错误）</summary>{result.writing.findings.map((f,i)=><div key={i}><p><strong>{categoryNames[f.category??'']??f.code}</strong> · {f.message}</p>{f.related?.map((r,j)=><p key={j} className="small">关联影响：{r.message}（引用关联尚未完成，不据此认定事实编造）</p>)}</div>)}</details>}
  {!!result.writing?.citationLocations?.length&&<details><summary>程序引用定位与同源上下文（对应模型候选版本）</summary>{result.writing.citationLocations.map((c,i)=><div key={i} style={{margin:'12px 0'}}><strong>{c.paragraphId} · {c.factId} · {c.status==='located'?'已定位，支持关系另核':'未定位'}</strong><p>模型原引文：{c.originalQuote||'（空）'}</p><p className="small">{c.reason}{c.start!==undefined?`；快照位置 [${c.start}, ${c.end})，UTF-16` : ''}</p>{c.context&&<p style={{whiteSpace:'pre-wrap'}}>程序截取的同源上下文：{c.context}</p>}{c.sources.map(s=><p key={s.id} className="small">{s.locator} · {s.version===undefined?'记录快照':`v${s.version}`} · 摘要 {s.digest.slice(0,12)}</p>)}</div>)}</details>}
  {result.changes.length>0&&<div className="notice notice-warn">来源已变化，原草稿保留，请重新收集：{result.changes.join('；')}</div>}
  <div className="row" style={{gap:8,flexWrap:'wrap'}}>
   <Button size="sm" disabled={busy} onClick={()=>run(async()=>accept(await api.get<Result>(`/api/agent/business/${activeId}`)))}>检查来源变化</Button>
   <Button size="sm" disabled={busy} onClick={()=>run(async()=>accept(await api.post<Result>(`/api/agent/business/${activeId}/recollect`,{periodIds:periodSources.length?periods:undefined})))}>按所选范围重新收集并生成</Button>
   {result.artifactId&&<><Button size="sm" onClick={()=>setPreview(result.artifactId)}>预览Word草稿</Button><a className="btn btn-sm" href={`/api/artifacts/${result.artifactId}/file`}>下载草稿</a></>}
   {result.draft&&<a className="btn btn-sm" href={`#/workbench?id=${result.draft.workbenchId}&periodId=${result.draft.periodId}`}>所属期次／文书版本与定稿</a>}
  </div>
  {!result.draft&&(!result.writing?.candidate||result.writing.output)&&<div style={{whiteSpace:'pre-wrap',margin:'12px 0'}}>{result.answer}</div>}
  <details><summary>自动选择的期次（可调整）</summary>{periodSources.map(s=><label key={s.id} style={{display:'block'}}><input type="checkbox" checked={periods.includes(s.recordId)} onChange={e=>setPeriods(p=>e.target.checked?[...p,s.recordId]:p.filter(id=>id!==s.recordId))}/>{s.title} · <a href={s.href}>查看工作／期次 #{s.recordId}</a></label>)}</details>
  {result.evidence.task&&<details><summary>本次写作取材与统计适用性</summary><p>正文选用 {result.evidence.task.factIds.length} 项相关资料，完整来源仍保留在下方。</p>{Object.entries({inspections:'检查记录数',projects:'检查涉及项目数',duplicateRecords:'疑似重复记录数',periods:'期次数',completedPeriods:'登记完成期次数'}).map(([key,label])=><p key={key}>{label}：{result.evidence.task!.metrics.includes(key)?result.evidence.metrics[key]:'本次正文不适用或未请求，不按零值解释'}</p>)}{result.evidence.task.sourceNotes.map((n,i)=><p key={i} className="small">{n}</p>)}</details>}
  <details><summary>关键事实及对应来源（{result.evidence.facts.length}）</summary>{result.evidence.facts.map(f=><div key={f.id} style={{margin:'10px 0',whiteSpace:'pre-wrap'}}><strong>{f.id} · {f.certainty==='confirmed'?'已确认登记事实':'有来源待核实'}</strong><div>{f.text}</div>{f.sources.map(id=>{const s=result.evidence.sources.find(s=>s.id===id);return s?<a key={id} href={s.href} style={{marginRight:12}}>{s.locator}</a>:null;})}</div>)}</details>
  {result.writing?.output&&<details><summary>正文与来源支持关系（逐段核对）</summary>{result.writing.output.paragraphs.map(p=><div key={p.id} style={{margin:'12px 0'}}><strong>{p.field} · {p.kind==='fact'?'资料事实':p.kind==='analysis'?'分析推断':'建议'}</strong><p>{displayText(p.text)}</p>{p.citations.map((c,i)=><p key={i} className="small">{c.factId} 原文：{c.quote}</p>)}</div>)}</details>}
  <details><summary>文件读取情况与版本</summary>{result.evidence.files.map(f=><p key={f.id}><a href={f.href??`/api/artifacts/${f.id}/file`}>{f.title}</a> · {({read:'已读',excerpt:'节选',unread:'无法读取',omitted:'未覆盖',excluded:'不作为事实来源',duplicate:'重复',quarantined:'疑似指令已隔离'} as Record<string,string>)[f.state]??f.state} · {f.readChars}/{f.totalChars} 字 {f.reason}</p>)}</details>
  <details open={result.evidence.conflicts.length>0}><summary>信息缺口与冲突（需人工核对）</summary>{result.evidence.gaps.map((g,i)=><p key={i}>{g}</p>)}{result.evidence.conflicts.map((c,i)=><p key={i}><strong>{c.field}</strong>：{c.candidates.map(x=>`${x.value}〔${x.source}〕`).join('；')}</p>)}</details>
  {result.draft&&<details><summary>修改草稿正文并保存新版本</summary><p className="small muted">手工修改不会自动获得事实依据，引用编号须逐项核对。历史定稿保持不变。</p>{result.writing?.candidate&&<Button size="sm" onClick={()=>setValues(current=>{const next={...current};for(const field of Object.keys(next)){const ps=result.writing!.candidate!.paragraphs.filter(p=>p&&p.field===field&&typeof p.text==='string');if(ps.length)next[field]=ps.map(p=>displayText(p.text)).join('\n\n');}return next;})}>载入未核验模型正文进行修改</Button>}{Object.entries(values).map(([key,value])=><label key={key} style={{display:'block',marginTop:10}}>{key} · 依据 {(result.draft!.fieldFacts[key]??[]).join('、')||'期间信息／建议／待补字段'}<Textarea value={value} onChange={v=>setValues(x=>({...x,[key]:v}))} rows={value.length>100?6:2}/></label>)}<Button disabled={busy||!!result.changes.length} onClick={()=>run(async()=>{accept(await api.post<Result>(`/api/agent/business/${activeId}/draft`,{values}));toast('已保存新草稿版本','ok');})}>保存新草稿版本</Button></details>}
  {result.artifactId&&<details><summary>人工证据核对</summary><p>请核对重要数字、日期、完成情况、引用及冲突；填写核对依据。此操作只保存核对记录，定稿仍在所属工作的版本入口明确确认。</p><Textarea value={note} onChange={setNote} rows={3} placeholder="填写核对依据，说明缺失信息或冲突如何处理"/><Button disabled={busy||!note.trim()||!!result.changes.length} onClick={()=>run(async()=>{await api.post(`/api/agent/business/${activeId}/review`,{note,confirmed:true});toast('已记录核对，尚未定稿','ok');})}>确认已人工核对当前草稿</Button></details>}
  <details><summary>生成检查说明</summary>{(result.writing?.mode==='human-edited'?['人工修改内容须重新核对；原模型核验结论仅属于历史版本，不能用于当前草稿定稿。']:result.validation).map((v,i)=><p key={i}>{v}</p>)}</details>
 </Card>{preview!==null&&<FilePreview id={preview} onClose={()=>setPreview(null)}/>}</div>;
}
