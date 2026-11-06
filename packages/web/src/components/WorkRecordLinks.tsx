import {useApi} from '../api';
import {Button,Card,Loading} from '../ui';

/** Only explicit foreign-key associations; never infer links from project names. */
export function WorkRecordLinks({workbenchId}:{workbenchId:number}) {
 const records=useApi<{items:{id:number;text:string;occurred_from:string|null}[];total:number}>(`/api/work-records?workbenchId=${workbenchId}&pageSize=5`);
 const href=`#/records?workbenchId=${workbenchId}`;
 return <Card title="关联工作记录" extra={<a href={href}>查看全部关联记录 →</a>}>
  <p className="small muted">仅显示明确关联到这份工作的有效记录，按发生时间排列。记录不改变阶段、期次或完成状态。</p>
  {records.loading?<Loading/>:records.error?<p role="alert">读取关联记录失败：{records.error.message} <Button onClick={records.reload}>重试</Button></p>:<>
   <p>有效记录 {records.data?.total??0} 条</p>
   {records.data?.items.length?<ul>{records.data.items.map(r=><li key={r.id}><a href={`${href}&id=${r.id}`}>记录 #{r.id} · {r.occurred_from||'发生日期未说明'} · {r.text.slice(0,100)}{r.text.length>100?'…':''}</a></li>)}</ul>:<p className="muted">尚无明确关联的工作记录。未关联记录仍保留在全部记录中。</p>}
  </>}
 </Card>;
}
