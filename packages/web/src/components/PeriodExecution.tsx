import {useEffect,useState} from 'react';
import {api,useApi} from '../api';
import {Button,Field,Input,useAction} from '../ui';
/** Optional schedule and explicitly chosen sources; no manually maintained steps. */
export function PeriodExecution({period,onSaved,purpose}:{period:{id:number;status:string;scheduled_date:string|null;source_period_ids:string;report_period:string};onSaved:()=>void;purpose?:string}){
 const {busy,run}=useAction(),[date,setDate]=useState(''),[ids,setIds]=useState<number[]>([]);
 const related=useApi<{items:{id:number;work_name:string;report_period:string}[]}>(purpose==='summary'?`/api/periods/${period.id}/related`:null);
 useEffect(()=>{setDate(period.scheduled_date??'');setIds(JSON.parse(period.source_period_ids));},[period.id]);
 const disabled=busy||period.status==='done';
 return <div className="col">
 {purpose!=='inspection'&&<><Field label="安排日期（可选）"><Input type="date" value={date} onChange={setDate} disabled={disabled}/></Field><Button disabled={disabled} onClick={()=>void run(async()=>{await api.put(`/api/periods/${period.id}`,{scheduled_date:date||null});onSaved();})}>保存安排日期</Button></>}
 {purpose==='summary'&&<><h4>季度汇报参考范围</h4><p className="small muted">按需选择同季度的相关工作；不会自动读取整个业务目录。</p>{related.data?.items.map(p=><label key={p.id}><input type="checkbox" disabled={disabled} checked={ids.includes(p.id)} onChange={e=>setIds(a=>e.target.checked?[...a,p.id]:a.filter(id=>id!==p.id))}/>{p.work_name} · {p.report_period}</label>)}<Button disabled={disabled} onClick={()=>void run(async()=>{await api.put(`/api/periods/${period.id}`,{source_period_ids:ids});onSaved();})}>保存参考范围</Button></>}
 </div>;
}
