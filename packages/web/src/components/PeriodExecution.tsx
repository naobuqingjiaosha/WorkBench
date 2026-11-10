import {useEffect,useRef,useState} from 'react';
import {api,useApi} from '../api';
import {Button,Field,Input} from '../ui';
import {useEditorGuard} from './NavigationGuard';

type Period={id:number;status:string;scheduled_date:string|null;source_period_ids:string;report_period:string};

type Arrangement=Pick<Period,'scheduled_date'|'source_period_ids'>;

export function PeriodExecution({period,onSaved,purpose}:{period:Period;onSaved:()=>void;purpose:'summary'|'general'}){
 const summary=purpose==='summary',base=useRef(period),lock=useRef(false);
 const [date,setDate]=useState(period.scheduled_date??'');
 const [ids,setIds]=useState<number[]>(()=>JSON.parse(period.source_period_ids));
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const [conflict,setConflict]=useState<Arrangement|null>(null);
 const related=useApi<{items:{id:number;work_name:string;report_period:string}[]}>(summary?`/api/periods/${period.id}/related`:null);
 const dirtyDate=date!==(base.current.scheduled_date??''),dirtyScope=summary&&JSON.stringify(ids)!==base.current.source_period_ids;
 const disabled=busy||period.status==='done';
 const reset=(current:Arrangement)=>{base.current={...base.current,...current};setConflict(null);setDate(current.scheduled_date??'');setIds(JSON.parse(current.source_period_ids));setError('');};
 useEffect(()=>{if(!dirtyDate&&!dirtyScope&&!lock.current)reset(period);},[period.id,period.scheduled_date,period.source_period_ids]);
 const save=async()=>{
  if(lock.current)throw Error('本期安排正在保存');
  if(conflict)throw Error('请先核对其他入口已保存的安排');
  lock.current=true;setBusy(true);setError('');setMessage('');
  const patch:Record<string,unknown>={},expected:Record<string,unknown>={};
  if(dirtyDate){patch.scheduled_date=date||null;expected.scheduled_date=base.current.scheduled_date;}
  if(dirtyScope){patch.source_period_ids=ids;expected.source_period_ids=base.current.source_period_ids;}
  try{
   const current=await api.put<Period>(`/api/periods/${period.id}`,{...patch,expected});
   reset(current);setMessage(summary?'已保存本期安排与参考范围':'安排日期已保存');onSaved();
  }catch(e){
   setError((e as Error).message);
   const changed=e as {code?:string;detail?:{arrangement:Arrangement}};
   if(changed.code==='PERIOD_CHANGED'&&changed.detail?.arrangement)setConflict(changed.detail.arrangement);
   throw e;
  }finally{lock.current=false;setBusy(false);}
 };
 const keepEdits=()=>{
  if(!conflict)return;
  if(!dirtyDate)setDate(conflict.scheduled_date??'');
  if(!dirtyScope)setIds(JSON.parse(conflict.source_period_ids));
  base.current={...base.current,...conflict};setConflict(null);setError('');setMessage('已保留本页修改，请核对后保存。');
 };
 const describe=(ids:number[])=>ids.map(id=>{const p=related.data?.items.find(p=>p.id===id);return p?`${p.work_name} · ${p.report_period}`:`期次 #${id}`;}).join('、')||'未选择';
 const discard=()=>{reset(conflict??period);setMessage('已恢复已保存的安排');};
 useEditorGuard({dirty:dirtyDate||dirtyScope,busy,save,discard});
 return <section className="col">
 {summary&&<><h4>季度汇报参考范围</h4><p className="small muted">仅选择本季度需要引用的工作期次。已确认检查可带入模板的“范围内已确认检查”和“范围内已确认检查次数”字段。</p>
 {related.loading&&!related.data&&<p>正在读取同季度期次…</p>}
 {related.error&&<p role="alert">{related.error.message} <Button onClick={related.reload}>重试</Button></p>}
 {related.data&&!related.data.items.length&&<p>本季度暂无同业务分类的其他期次，可先保存本期内容。</p>}
 {related.data?.items.map(p=><label key={p.id}><input type="checkbox" disabled={disabled} checked={ids.includes(p.id)} onChange={e=>setIds(a=>e.target.checked?[...a,p.id]:a.filter(id=>id!==p.id))}/>{p.work_name} · {p.report_period}</label>)}</>}
 <Field label="安排日期（可选）"><Input type="date" value={date} onChange={setDate} disabled={disabled}/></Field>
 <div className="row"><Button disabled={disabled||!!conflict||!(dirtyDate||dirtyScope)} onClick={()=>void save().catch(()=>{})}>{summary?'保存安排与参考范围':'保存安排日期'}</Button>
 {(!conflict&&(dirtyDate||dirtyScope))&&<Button disabled={busy} onClick={discard}>放弃未保存修改</Button>}</div>
 {conflict&&<div className="notice notice-warn"><strong>其他入口已保存的安排</strong><p>安排日期：{conflict.scheduled_date??'未安排'}</p>
 {summary&&<><p>已保存范围：{describe(JSON.parse(conflict.source_period_ids))}</p><p>本页选择：{describe(ids)}</p></>}
 <Button disabled={busy} onClick={discard}>采用已保存的安排</Button><Button disabled={busy} onClick={keepEdits}>保留本页修改，继续核对</Button></div>}
 {error?<p role="alert">{error}</p>:message&&<p role="status">{message}</p>}
 </section>;
}
