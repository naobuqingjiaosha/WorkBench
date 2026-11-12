import {useEffect,useRef,useState} from 'react';
import {api,useApi} from '../api';
import {Button,Card,Field,Input,Textarea,Select,Modal} from '../ui';
import {FilePreview} from './FilePreview';
import {useEditorGuard} from './NavigationGuard';
const labels:Record<string,string>={project:'检查项目',inspection_date:'实际检查日期（未知可留空）',subject:'检查重点',content:'检查内容／清单',method:'检查方法',supervisor:'检查人（历史候选待确认）',supervised_unit:'被检查单位',result:'实际结果／待确认写法',findings:'发现问题',rectification:'整改情况',remarks:'备注'};
interface Draft {id:number;period_id:number;revision:number;fields:Record<string,string>;provenance:Record<string,string>;source:{id:number;periodId:number;month:string;revision:number}|null;sourceChanged:boolean;inspection_id:number|null;accepted_revision:number|null;files:{id:number;name:string;current:boolean;accessible:boolean}[]}
interface Context {candidates:{id:number;project:string;month:string;subject:string}[];drafts:Draft[]}
interface Suggestion {periodId:number;draftId:number;revision:number;fields:Record<string,string>;reason:string;baseline:Record<string,string>}
interface PendingDraft {base:Draft;fields:Record<string,string>;aiFields?:string[]}

// A save may commit even if the browser closes before the HTTP response arrives.
function matchesSavedDraft(pending:PendingDraft,latest:Draft) {
 const {base,fields,aiFields=[]}=pending;
 if(base.id!==latest.id || base.period_id!==latest.period_id || latest.revision!==base.revision+1 ||
    latest.sourceChanged || JSON.stringify(base.source)!==JSON.stringify(latest.source) ||
    base.inspection_id!==latest.inspection_id || base.accepted_revision!==latest.accepted_revision) return false;
 return Object.keys(latest.fields).every(key=>{
  if(!Object.hasOwn(fields,key)) return latest.fields[key]===base.fields[key] && latest.provenance[key]===base.provenance[key];
  const origin=aiFields.includes(key)?'AI建议':'用户输入';
  return latest.fields[key]===fields[key]?.trim() && latest.provenance[key]===origin;
 });
}
export function InspectionDrafts({periodId,workbenchId,templates,refreshKey,suggestOnOpen,onSuggestionStarted,showWorkLink=true,onChanged=()=>{}}:{periodId:number;workbenchId:number;templates:{id:number;name:string}[];onChanged?:()=>void;refreshKey?:number;showWorkLink?:boolean;suggestOnOpen?:number;onSuggestionStarted?:()=>void}){
 const context=useApi<Context>(`/api/periods/${periodId}/drafts`);
 const [draft,setDraft]=useState<Draft|null>(null),[form,setForm]=useState<Record<string,string>>({}),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[aiBusy,setAiBusy]=useState(false),[suggestion,setSuggestion]=useState<Suggestion|null>(null),[instruction,setInstruction]=useState('推荐本月检查重点、方法和可执行清单'),[target,setTarget]=useState('subject,content,method'),[selected,setSelected]=useState<number[]>(templates.map(t=>t.id)),[preview,setPreview]=useState<number|null>(null),[results,setResults]=useState<{templateId:number;ok:boolean;artifactId?:number;name?:string;error?:string;pending?:string[]}[]>([]);
 const [conflict,setConflict]=useState<Draft|null>(null);
 const [chosen,setChosen]=useState<string[]>([]),[includeHistory,setIncludeHistory]=useState(false),[confirm,setConfirm]=useState(false);
 const epoch=useRef(0),dirty=useRef(new Set<string>()),aiFields=useRef(new Set<string>()),creating=useRef<string|null>(null),current=useRef<Draft|null>(null);
 useEffect(()=>{if(refreshKey!==undefined)context.reload();},[refreshKey]);
 const path=(d:Draft)=>`/api/periods/${periodId}/drafts/${d.id}`;

 useEffect(()=>{
  if(!context.data)return;
  const requested=Number(new URLSearchParams(location.hash.split('?')[1]).get('draftId'));
  const d=context.data.drafts.find(x=>x.id===(current.current?.id||requested))??context.data.drafts[0];
  if(!d)return;
  if(current.current){
   if(d.id===current.current.id && d.revision>current.current.revision){
    if(dirty.current.size)setConflict(d);else load(d);
   }
   return;
  }
  load(d);
  const key=`inspection-draft-${periodId}-${d.id}`;
  try{
   const pending:PendingDraft|null=JSON.parse(sessionStorage.getItem(key)||'null');
   if(!pending)return;
   if(matchesSavedDraft(pending,d)){
    sessionStorage.removeItem(key);
    setMessage('已核对上次修改已保存，已载入最新草稿。');
    return;
   }
   current.current=pending.base;setDraft(pending.base);
   setForm({...pending.base.fields,...pending.fields});
   dirty.current=new Set(Object.keys(pending.fields));aiFields.current=new Set(pending.aiFields??[]);
   if(pending.base.revision!==d.revision)setConflict(d);
   setMessage(pending.base.revision===d.revision?'已恢复上次未保存输入，请保存草稿':'其他入口已修改草稿，已保留本页输入。');
  }catch{}
 },[context.data]);
 useEffect(()=>{if(!draft||!dirty.current.size)return;try{sessionStorage.setItem(`inspection-draft-${periodId}-${draft.id}`,JSON.stringify({base:draft,aiFields:[...aiFields.current],fields:Object.fromEntries([...dirty.current].map(k=>[k,form[k]??'']))}));}catch{}},[form,draft,periodId]);
 useEffect(()=>()=>{epoch.current++;},[periodId]);
 useEffect(()=>{const open=()=>{const id=Number(new URLSearchParams(location.hash.split('?')[1]).get('draftId'));if(!id||id===current.current?.id)return;if(dirty.current.size){setMessage('请先保存当前输入，再在草稿列表切换目标');return;}const token=++epoch.current;void api.get<Draft>(`/api/periods/${periodId}/drafts/${id}`).then(d=>{if(token===epoch.current)load(d);}).catch(e=>{if(token===epoch.current)setMessage(e.message);});};window.addEventListener('hashchange',open);return()=>window.removeEventListener('hashchange',open);},[periodId]);

 const load=(d:Draft)=>{epoch.current++;current.current=d;setDraft(d);setForm(d.fields);setConflict(null);dirty.current.clear();aiFields.current.clear();setSuggestion(null);setResults([]);};
 const refresh=()=>{context.reload();onChanged();};
 const showFailure=async(error:unknown)=>{
  const e=error as {code?:string;message?:string},active=current.current;
  if(e.code==='STALE_DRAFT' && active){
   try{
    const latest=await api.get<Draft>(path(active));
    if(current.current?.id===latest.id){setConflict(latest);setConfirm(false);}
   }catch{setMessage('草稿有更新，暂时无法读取最新版本。本页输入已保留，可重试。');return;}
  }
  setMessage(e.message||'操作失败，请重试');
 };
 const act=async(fn:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await fn();}catch(e){await showFailure(e);}finally{setBusy(false);}};
 const save=async()=>{
  if(!draft)throw Error('请先新建或打开草稿');
  if(conflict)throw Error('请先核对两版草稿，再保存修改。');
  const fields=Object.fromEntries([...dirty.current].map(k=>[k,form[k]??'']));
  if(!Object.keys(fields).length)return draft;
  const d=await api.put<Draft>(path(draft),{revision:draft.revision,fields,aiFields:[...aiFields.current]});
  sessionStorage.removeItem(`inspection-draft-${periodId}-${draft.id}`);load(d);refresh();return d;
 };
 const request=useEditorGuard({dirty:dirty.current.size>0,busy,save:async()=>{
  try{await save();}catch(e){await showFailure(e);throw e;}
 },discard:()=>{if(draft){sessionStorage.removeItem(`inspection-draft-${periodId}-${draft.id}`);load(conflict??draft);}}});
 const conflictKeys=draft&&conflict?Object.keys(labels).filter(k=>dirty.current.has(k)||draft.fields[k]!==conflict.fields[k]||draft.provenance[k]!==conflict.provenance[k]):[];
 const changedSource=!!conflict && (conflict.sourceChanged || JSON.stringify(draft?.source)!==JSON.stringify(conflict.source));
 const sourceNeedsReview=changedSource && [...aiFields.current].some(k=>dirty.current.has(k));
 const sourceLabel=(source:Draft['source'])=>source?`${source.month} · 记录 ${source.id} · 版本 ${source.revision}`:'无历史来源';
 const localOrigin=(key:string)=>dirty.current.has(key)?(aiFields.current.has(key)?'AI建议':'用户输入'):(draft?.provenance[key]||'未填写');
 const keepLocal=()=>{
  if(!conflict||sourceNeedsReview)return;
  const local=Object.fromEntries([...dirty.current].map(k=>[k,form[k]??'']));
  const origins=new Set(aiFields.current);
  load(conflict);
  dirty.current=new Set(Object.keys(local));aiFields.current=origins;
  setForm({...conflict.fields,...local});
  setMessage('已按最新版本保留本页修改，请核对后保存。');
 };
 const suggest=async(d:Draft)=>{
  const token=epoch.current,snapshot={...form};setAiBusy(true);setMessage('');setSuggestion(null);
  try{const r=await api.post<Suggestion>(path(d)+'/suggest',{revision:d.revision,instruction,fields:target.split(','),snapshot,includeHistory});
   if(token!==epoch.current||current.current?.id!==r.draftId)return;
   setSuggestion({...r,baseline:snapshot});setChosen(Object.keys(r.fields));
  }catch(e){if(token===epoch.current)setMessage(`AI建议尚未生成：${(e as Error).message}。可以继续编辑、保存和下载。`);}finally{if(token===epoch.current||current.current?.id===d.id)setAiBusy(false);}
 };
 useEffect(()=>{if(draft&&draft.id===suggestOnOpen&&!aiBusy){onSuggestionStarted?.();void suggest(draft);}},[draft?.id,suggestOnOpen]);
 const create=()=>act(async()=>{if(dirty.current.size)await save();creating.current??=crypto.randomUUID();const d=await api.post<Draft>(`/api/periods/${periodId}/drafts`,{requestKey:creating.current,sourceId:null});creating.current=null;load(d);refresh();setMessage('空白草稿已创建，按需选择资料和 AI 修改范围。');});
 const generate=(adopt:boolean)=>act(async()=>{const d=await save();if(adopt&&!selected.length){load(await api.post<Draft>(path(d)+'/adopt',{revision:d.revision}));refresh();setMessage('已登记实际检查');return;}const r=await api.post<{draft:Draft;results:typeof results}>(path(d)+'/generate',{revision:d.revision,templateIds:selected,adopt});load(r.draft);setResults(r.results);refresh();});
 return <Card title="检查材料草稿 · 助手与页面共同编辑" extra={<Button kind="primary" disabled={busy} onClick={()=>void create()}>新建检查记录</Button>}>
  <p className="small muted">历史仅作参考，实际日期与结果可留空。AI 建议先进入编辑区，保存与确认实际检查分别操作。</p>
  {context.error&&<p role="alert">草稿加载失败：{context.error.message} <Button onClick={context.reload}>重试</Button></p>}
  <div className="row">{context.data?.drafts.map(d=><Button key={d.id} disabled={busy} onClick={()=>request(()=>load(d))}>草稿 {d.id} · {d.fields.project||'项目待定'} · {d.files.some(f=>f.current)?'文件已生成':d.files.length?'内容变化待更新':'编辑中'}</Button>)}</div>
  {message&&<p role="status" className="notice">{message}</p>}
  {draft&&<div className="col">
   <div className="row"><strong>草稿 {draft.id}</strong><span>{draft.source?`参考 ${draft.source.month} · 记录 ${draft.source.id}`:'无历史来源，可填写项目背景后起草'}</span><Button disabled={busy||!!conflict||!dirty.current.size} onClick={()=>void act(async()=>{await save();})}>保存草稿</Button><Button disabled={busy||aiBusy||draft.revision<2||dirty.current.size>0} onClick={()=>void act(async()=>{load(await api.put<Draft>(path(draft),{revision:draft.revision,restoreRevision:draft.revision-1}));refresh();})}>恢复上一版</Button></div>
   {conflict&&<section className="notice" aria-label="核对草稿修改"><strong>核对草稿修改</strong>
    <p>比较本页与已保存版本 {conflict.revision}，选择后可继续编辑。</p>
    {conflictKeys.map(k=><div key={k}><strong>{labels[k]}</strong>
     <p>已保存（{conflict.provenance[k]||'未填写'}）：{conflict.fields[k]||'空'}</p>
     <p>本页（{localOrigin(k)}）：{form[k]||'空'}</p></div>)}
    {changedSource&&<p>已保存来源：{sourceLabel(conflict.source)}；本页来源：{sourceLabel(draft.source)}。{conflict.sourceChanged&&'历史记录已变化，登记前须重新选择来源。'}{sourceNeedsReview&&'保留修改前，请人工复核并编辑本页的 AI 建议字段。'}</p>}
    <Button disabled={busy} onClick={()=>{sessionStorage.removeItem(`inspection-draft-${periodId}-${draft.id}`);load(conflict);setMessage('已载入已保存的草稿。');}}>载入已保存版本</Button>
    <Button disabled={busy||sourceNeedsReview} onClick={keepLocal}>保留本页修改并继续核对</Button>
   </section>}
   {!conflict&&dirty.current.size>0&&<Button disabled={busy} onClick={()=>void act(async()=>{const latest=await api.get<Draft>(path(draft));sessionStorage.removeItem(`inspection-draft-${periodId}-${draft.id}`);load(latest);setMessage('已放弃未保存输入并加载最新草稿');})}>放弃未保存输入，加载最新草稿</Button>}
   {draft.sourceChanged&&<p role="alert">历史来源已变化，采用前请重新选择来源或解除引用。当前草稿内容保留。</p>}
   <Field label="参考来源（切换保留人工编辑，可恢复上一版）"><Select value={String(draft.source?.id??'')} onChange={v=>void act(async()=>{const d=await save();load(await api.put<Draft>(path(d),{revision:d.revision,sourceId:v?Number(v):null}));refresh();})} options={[{value:'',label:'不引用历史'},...(context.data?.candidates??[]).map(r=>({value:String(r.id),label:`${r.month} · ${r.project} · ${r.subject} #${r.id}`}))]}/></Field>
   {Object.entries(labels).map(([k,label])=><Field key={k} label={`${label}${draft.provenance[k]?' · '+draft.provenance[k]:''}`}>{['content','result','findings','rectification','remarks'].includes(k)?<Textarea disabled={busy} rows={3} value={form[k]??''} onChange={v=>{dirty.current.add(k);aiFields.current.delete(k);setForm(f=>({...f,[k]:v}));}}/>:<Input disabled={busy} type={k==='inspection_date'?'date':'text'} value={form[k]??''} onChange={v=>{dirty.current.add(k);aiFields.current.delete(k);setForm(f=>({...f,[k]:v}));}}/>}</Field>)}
   <Card title="让助手修改当前草稿">
    <p><label><input type="checkbox" checked={includeHistory} onChange={e=>setIncludeHistory(e.target.checked)}/> 本次引用已选历史记录（仅作参考）</label></p><Field label="修改范围"><Select value={target} onChange={setTarget} options={[{value:'subject,content,method',label:'检查重点、内容和方法'},{value:'content',label:'只改检查内容'},{value:'result',label:'只改结果写法'},{value:'subject',label:'只换检查重点'}]}/></Field>
    <Input value={instruction} onChange={setInstruction} placeholder="例如：保留项目，换成设备调试方面；简短一些"/>
    <div className="row"><Button disabled={busy||aiBusy||!!conflict} onClick={()=>void suggest(draft)}>{aiBusy?'助手正在起草…':'请助手起草／修改'}</Button>{aiBusy&&<Button onClick={()=>{epoch.current++;setAiBusy(false);setMessage('已取消应用，后续响应不会覆盖草稿');}}>取消应用</Button>}</div>
    {suggestion&&<div><p>{suggestion.reason}</p><p className="small muted">采用只改变编辑区，未选字段保持原值。保存后仍需单独确认实际检查。</p>{Object.entries(suggestion.fields).map(([k,v])=><section key={k}><label><input type="checkbox" checked={chosen.includes(k)} onChange={e=>setChosen(e.target.checked?[...chosen,k]:chosen.filter(x=>x!==k))}/><strong>{labels[k]}</strong></label><div className="compare-grid"><div>原稿<p>{suggestion.baseline[k]||'空'}</p></div><div className="suggested"><Field label="建议（可编辑）"><Textarea value={v} onChange={value=>setSuggestion({...suggestion,fields:{...suggestion.fields,[k]:value}})}/></Field></div></div></section>)}<Button disabled={busy||!chosen.length} onClick={()=>void act(async()=>{const latest=await api.get<Draft>(path(draft));if(latest.revision!==suggestion.revision||latest.sourceChanged||JSON.stringify(form)!==JSON.stringify(suggestion.baseline))throw Error('草稿或来源已变化，请重新请求建议；当前输入保留');const patch=Object.fromEntries(chosen.map(k=>[k,suggestion.fields[k]??'']));chosen.forEach(k=>{dirty.current.add(k);aiFields.current.add(k);});setForm({...form,...patch});setSuggestion(null);setMessage('已采用到编辑区，尚未保存。');})}>采用 {chosen.length} 项到编辑区</Button><Button onClick={()=>setSuggestion(null)}>忽略建议</Button></div>}
   </Card>
   <Field label="生成单次表册（汇总与年度台账使用下方本期汇总入口）"><div>{templates.map(t=><label key={t.id} style={{display:'block'}}><input type="checkbox" checked={selected.includes(t.id)} onChange={e=>setSelected(a=>e.target.checked?[...a,t.id]:a.filter(x=>x!==t.id))}/>{t.name}</label>)}</div></Field>
   <p className="small">待补：{['project','inspection_date','subject','content','result'].filter(k=>!form[k]?.trim()).map(k=>labels[k]).join('、')||'必要字段已填写，请集中核对预览内容'}</p>
   <div className="row"><Button disabled={busy||!selected.length} onClick={()=>void generate(false)}>下载待确认草稿</Button><Button kind="primary" disabled={busy||!!conflict||draft.sourceChanged||['project','inspection_date','subject','content','result'].some(k=>!form[k]?.trim())} onClick={()=>setConfirm(true)}>{selected.length?'确认实际检查并生成文件':'确认实际检查'}</Button>{showWorkLink&&<a href={`#/workbench?id=${workbenchId}&periodId=${periodId}`}>在工作页面继续编辑</a>}</div>
   {results.map(r=><p key={r.templateId}>{templates.find(t=>t.id===r.templateId)?.name}：{r.ok?<><a href={`/api/artifacts/${r.artifactId}/file`}>下载 {r.name}</a>{!!r.pending?.length&&<span>（文件待确认：{r.pending.join("、")}）</span>} <Button onClick={()=>setPreview(r.artifactId!)}>预览</Button></>:<span role="alert">失败：{r.error}（可保留成功文件并重试）</span>}</p>)}
   <details><summary>已生成文件与历史版本</summary>{draft.files.map(f=><p key={f.id}>{f.current?'文件已生成':'内容变化待更新／旧版'} · {f.accessible?<><a href={`/api/artifacts/${f.id}/file`}>{f.name}</a> <Button onClick={()=>setPreview(f.id)}>预览</Button></>:`文件不可访问：${f.name}`}</p>)}</details>
  </div>}
  <Modal open={confirm} title="确认实际检查" onClose={()=>{if(!busy)setConfirm(false);}} footer={<><Button disabled={busy} onClick={()=>setConfirm(false)}>返回核对</Button><Button kind="primary" disabled={busy} onClick={()=>{setConfirm(false);void generate(true);}}>{selected.length?'确认上述事实并生成':'确认并登记'}</Button></>}><p>只有人工确认实际已开展的检查才登记为真实记录。请核对日期、项目、内容和结果。</p>{['project','inspection_date','subject','content','result'].map(k=><p key={k}><strong>{labels[k]}：</strong>{form[k]||'未确认'}</p>)}</Modal>
  {preview&&<FilePreview id={preview} onClose={()=>setPreview(null)}/>}
 </Card>;
}
