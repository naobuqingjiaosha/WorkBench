import {useApi} from '../api';
import {Button,Card,Loading} from '../ui';

/** Only explicit foreign-key associations; never infer links from project names. */
export function WorkRecordLinks({workbenchId}:{workbenchId:number}) {
 const records=useApi<{items:{id:number;text:string;occurred_from:string|null}[];total:number}>(`/api/work-records?workbenchId=${workbenchId}&pageSize=5`);
 const href=`#/records?workbenchId=${workbenchId}`;
 return <Card title="关联工作记录" extra={<a href={href}>查看全部关联记录 →</a>}>
  {records.loading?<Loading/>:records.error?<p role="alert">读取关联记录失败：{records.error.message} <Button onClick={records.reload}>重试</Button></p>:<>
   {records.data?.items.length?<><p className="small muted">本工作共 {records.data.total} 条有效记录，按发生时间排列。</p>
   <ul className="linked-work-records">{records.data.items.map(r=><li key={r.id}><a href={`${href}&id=${r.id}`} title={r.text}>{r.text.slice(0,100)}{r.text.length>100?'…':''}</a><small>#{r.id} · {r.occurred_from||'发生日期未说明'}</small></li>)}</ul></>:<p className="muted">尚无明确关联到这份工作的记录。</p>}
  </>}
 </Card>;
}
