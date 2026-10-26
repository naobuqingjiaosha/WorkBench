import {useEffect,useRef,useState} from 'react';
import {api,useApi,type Workbench} from '../api';
import {useEditorGuard} from '../components/NavigationGuard';
import {Button,Card,Empty,Field,Input,Loading,Modal,Select,Textarea,fmtTime,useAction,useToast} from '../ui';

type Nature='done'|'progress'|'plan'|'unknown';
interface RecordItem {id:number;text:string;occurred_from:string|null;occurred_to:string|null;nature:Nature;revision:number;status:'active'|'withdrawn';workbench_id:number|null;source:string;created_at:string;updated_at:string;}
interface Result {items:RecordItem[];total:number;page:number;pageSize:number;unknownDateCount:number;unknownItems:RecordItem[];}
const labels:Record<Nature,string>={done:'已做 · 用户陈述',progress:'进展',plan:'计划',unknown:'性质待明确'};
const options=Object.entries(labels).map(([value,label])=>({value,label}));
const dateText=(r:RecordItem)=>r.occurred_from?`${r.occurred_from}${r.occurred_to!==r.occurred_from?' 至 '+r.occurred_to:''}`:'发生日期未说明';
function submissionKey(ref:{current:{body:string;key:string}|null},body:unknown){const value=JSON.stringify(body);if(ref.current?.body!==value)ref.current={body:value,key:crypto.randomUUID()};return ref.current!.key;}

export function RecordComposer({onSaved}:{onSaved?:(record:RecordItem)=>void}) {
 const [text,setText]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[nature,setNature]=useState(''),[work,setWork]=useState('');
 const [saved,setSaved]=useState<RecordItem|null>(null);const request=useRef<{body:string;key:string}|null>(null);
 const {busy,run}=useAction();const works=useApi<{items:Workbench[]}>('/api/workbenches');
 useEditorGuard({dirty:Boolean(text||from||to||nature||work),busy});
 const save=()=>void run(async()=>{if(!text.trim())return;const payload={text:text.trim(),...(from?{occurred_from:from,occurred_to:to||from}:{}),...(nature?{nature}:{}),workbench_id:work?Number(work):null};const r=await api.post<RecordItem>('/api/work-records',{...payload,request_key:submissionKey(request,payload)});setSaved(r);setText('');setFrom('');setTo('');setNature('');setWork('');request.current=null;onSaved?.(r);},'已记下，已保存到本机工作记录');
 return <Card title="记一句工作情况" extra={<a href="#/records">查看工作记录 →</a>}>
  <p className="muted small">自己办，告诉工作台一声就好。可以记录已做、进展和计划，不产生待办。</p>
  <Field label="做了什么，直接说"><Textarea value={text} onChange={setText} rows={2} disabled={busy} placeholder="例如：今天把部门会议材料整理好，发给办公室了。"/></Field>
  <details><summary>补充或指定时间、性质、关联（可不填）</summary><div className="grid grid-2">
   <Field label="发生日期／范围开始"><Input type="date" value={from} onChange={setFrom} disabled={busy}/></Field><Field label="范围结束（可空）"><Input type="date" value={to} onChange={setTo} disabled={busy}/></Field>
   <Field label="内容性质"><Select value={nature} onChange={setNature} disabled={busy} options={[{value:'',label:'按原话保守识别'},...options]}/></Field>
   <Field label="关联工作（可空）"><Select value={work} onChange={setWork} disabled={busy} options={[{value:'',label:'不关联'},...(works.data?.items??[]).map(w=>({value:String(w.id),label:w.name}))]}/></Field>
  </div></details>
  <div className="row mt12"><Button kind="primary" disabled={busy||!text.trim()||Boolean(to&&!from)} onClick={save}>{busy?'保存中…':'记下来'}</Button><span className="muted small">原话保留；日期或性质不明确时标为待明确，可更正。</span></div>
  {to&&!from&&<p className="notice notice-warn">填写范围结束前，请先填写开始日期。</p>}
  {saved&&<p role="status" className="notice notice-info">已保存记录 #{saved.id} · {dateText(saved)} · {labels[saved.nature]}　<a href={`#/records?id=${saved.id}`}>查看、更正或撤回</a></p>}
 </Card>;
}

export default function WorkRecordsPage({params={}}:{params?:Record<string,string>}){
 const [q,setQ]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[nature,setNature]=useState(''),[status,setStatus]=useState('active');
 const [query,setQuery]=useState(''),[page,setPage]=useState(1),[selected,setSelected]=useState(params.id||'');const {busy,run}=useAction();const toast=useToast();
 useEffect(()=>setSelected(params.id||''),[params.id]);
 const data=useApi<Result>(`/api/work-records?${query}&page=${page}&pageSize=30`);
 const detail=useApi<{record:RecordItem;history:RecordItem[]}>(selected?`/api/work-records/${selected}`:null,[selected]);
 const [editing,setEditing]=useState<RecordItem|null>(null);
 const search=()=>{setPage(1);setQuery(new URLSearchParams({q,from,to,nature,status}).toString())};
 const refresh=()=>{data.reload();detail.reload()};
 const changeStatus=(r:RecordItem)=>void run(async()=>{await api.put(`/api/work-records/${r.id}`,{revision:r.revision,status:r.status==='active'?'withdrawn':'active'});refresh();},r.status==='active'?'已撤回，后续查询和总结不再使用':'已恢复');
 const draw=(r:RecordItem)=><article key={r.id} className="card" style={{padding:16,marginTop:10}}><div className="row" style={{justifyContent:'space-between',flexWrap:'wrap'}}><strong>记录 #{r.id} · {labels[r.nature]}{r.status==='withdrawn'?' · 已撤回':''}</strong><span className="muted small">{dateText(r)} · v{r.revision}</span></div><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{r.text}</p><p className="muted small">来源：{r.source} · 告知时间：{fmtTime(r.created_at)}{r.workbench_id&&<> · <a href={`#/workbench?id=${r.workbench_id}`}>关联工作 #{r.workbench_id}</a></>}</p><div className="row"><Button size="sm" onClick={()=>setSelected(String(r.id))}>查看来源与历史</Button>{r.status==='active'&&<Button size="sm" disabled={busy} onClick={()=>setEditing({...r})}>更正</Button>}<Button size="sm" disabled={busy} onClick={()=>changeStatus(r)}>{r.status==='active'?'撤回':'恢复'}</Button></div></article>;
 return <div className="col" style={{gap:14}}><RecordComposer onSaved={refresh}/>
  <Card title="工作记录" extra={<a href="#/agent">向助手查询或整理总结 →</a>}>
   <p className="muted small">按事情发生时间查找。没有找到记录不代表没有开展工作；记录条数不代表已完成事项数。</p>
   <div className="grid grid-3"><Field label="关键词"><Input value={q} onChange={setQ} onEnter={search}/></Field><Field label="发生时间从"><Input type="date" value={from} onChange={setFrom}/></Field><Field label="发生时间至"><Input type="date" value={to} onChange={setTo}/></Field><Field label="性质筛选"><Select value={nature} onChange={setNature} options={[{value:'',label:'全部性质'},...options]}/></Field><Field label="记录范围"><Select value={status} onChange={setStatus} options={[{value:'active',label:'有效记录'},{value:'withdrawn',label:'已撤回（可恢复）'}]}/></Field></div>
   <div className="row"><Button kind="primary" onClick={search}>查询记录</Button><Button onClick={data.reload}>刷新</Button></div>
   {data.loading?<Loading/>:data.error?<p role="alert" className="notice notice-warn">查询失败：{data.error.message} <Button onClick={data.reload}>重试</Button></p>:<>
    <p>符合条件 {data.data?.total??0} 条 · 第{page}页</p>
    {data.data?.items.length?data.data.items.map(draw):<Empty text="没有符合条件的记录。可以调整筛选，或在上方记一句。"/>}
    {data.data?.unknownDateCount!==undefined&&query.includes('from=')&&(new URLSearchParams(query).get('from')||new URLSearchParams(query).get('to'))&&<><p className="notice notice-info">另有 {data.data.unknownDateCount} 条发生日期未说明，未计入期间结果；以下单列同页记录。</p>{data.data.unknownItems.map(draw)}</>}
    <div className="row mt12"><Button disabled={page<=1} onClick={()=>setPage(p=>p-1)}>上一页</Button><Button disabled={page*30>=Math.max(data.data?.total??0,(new URLSearchParams(query).get('from')||new URLSearchParams(query).get('to'))?(data.data?.unknownDateCount??0):0)} onClick={()=>setPage(p=>p+1)}>下一页</Button></div>
   </>}
  </Card>
  {selected&&<Card title={`记录 #${selected} · 来源与更正历史`} extra={<Button onClick={()=>setSelected('')}>关闭详情</Button>}>
   {detail.loading?<Loading/>:detail.error?<p role="alert">{detail.error.message} <Button onClick={detail.reload}>重试</Button></p>:detail.data&&<>{draw(detail.data.record)}{detail.data.history.length?<details><summary>查看历史版本（不参与当前查询）</summary>{detail.data.history.map(r=><div key={r.revision}><h4>v{r.revision} · {dateText(r)} · {labels[r.nature]} · {r.status==='withdrawn'?'已撤回':'有效'}</h4><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{r.text}</p></div>)}</details>:<p className="muted small">尚无更正历史。</p>}</>}
  </Card>}
  <Modal open={Boolean(editing)} title="更正工作记录" onClose={()=>setEditing(null)} footer={<><Button onClick={()=>setEditing(null)}>取消</Button><Button kind="primary" disabled={busy||!editing?.text.trim()} onClick={()=>void run(async()=>{if(!editing)return;await api.put(`/api/work-records/${editing.id}`,{text:editing.text,occurred_from:editing.occurred_from,occurred_to:editing.occurred_to,nature:editing.nature,revision:editing.revision});setEditing(null);refresh();toast('已保存更正；历史版本保留，旧答复会提示来源变化','ok');})}>保存更正</Button></>}>
   {editing&&<><Field label="原话／更正内容"><Textarea value={editing.text} onChange={text=>setEditing({...editing,text})} disabled={busy}/></Field><div className="grid grid-2"><Field label="发生日期／范围开始"><Input type="date" value={editing.occurred_from??''} onChange={occurred_from=>setEditing({...editing,occurred_from:occurred_from||null,occurred_to:occurred_from?editing.occurred_to||occurred_from:null})} disabled={busy}/></Field><Field label="范围结束"><Input type="date" value={editing.occurred_to??''} onChange={occurred_to=>setEditing({...editing,occurred_to:occurred_to||editing.occurred_from})} disabled={busy}/></Field></div><Field label="内容性质（请核对）"><Select value={editing.nature} onChange={nature=>setEditing({...editing,nature:nature as Nature})} options={options} disabled={busy}/></Field><p className="muted small">保存前请核对发生时间和性质。修改保留旧版本，不改动关联工作的办理状态。</p></>}
  </Modal>
 </div>;
}

/** 仅将本系统工作记录引用转成链接；用户原话与其他模型文本保持纯文本。 */
export function RecordMessageText({text}:{text:string}) {
 const pattern=/\[([^\]\n]+)\]\(#\/records\?id=(\d+)\)/g;const nodes:(string|React.ReactNode)[]=[];let cursor=0;for(const match of text.matchAll(pattern)){nodes.push(text.slice(cursor,match.index));nodes.push(<a key={match.index} href={`#/records?id=${match[2]}`}>{match[1]}</a>);cursor=match.index!+match[0].length;}nodes.push(text.slice(cursor));return <>{nodes}</>;
}
