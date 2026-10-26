import {api,useApi} from '../api';
import {Button,Card} from '../ui';

export interface Evidence {records:string[];warnings?:string[];sources:{id:number;fileName:string;text:string;final:boolean;workbenchId?:number|null;periodId?:number|null}[]}
export function BusinessEvidence({workbenchId,periodId,snapshot}:{workbenchId:number;periodId?:number|null;snapshot?:Evidence}){
 const data=useApi<Evidence>(`/api/workbenches/${workbenchId}/context${periodId?`?periodId=${periodId}`:''}`),e=snapshot??data.data;
 return <details><summary>{snapshot?'本次生成实际使用的事实来源':'生成前工作记录与资料预览'}</summary>{data.error&&<p role="alert">{data.error.message}</p>}<p>使用当前期次及用户明确选择的本季度相关期次；生成后展示本次请求的资料节选。请按文件来源逐项核实初稿。</p>{e?.warnings?.map(w=><p role="alert" key={w}>{w}</p>)}{e?.records.map((r,i)=><p key={i} style={{whiteSpace:'pre-wrap'}}>{r}</p>)}{e?.sources.map(s=><details key={s.id}><summary>#{s.id} {s.fileName} · 工作 #{s.workbenchId} / 期次 #{s.periodId} · {s.final?'定稿':'待核实资料'}</summary><a href={`/api/artifacts/${s.id}/file`} target="_blank" rel="noreferrer">打开来源文件</a><p style={{whiteSpace:'pre-wrap'}}>{s.text}</p></details>)}{!e?.sources.length&&<p>没有可读取的关联文件正文；请先导入资料。</p>}</details>;
}
export function TemplateHistory({id}:{id:number}){
 const history=useApi<{items:{id:number;digest:string;created_at:string;vars_rel:string|null}[]}>(`/api/templates/${id}/history`);
 return <Card title="模板与字段规则历史" collapsible><p>修改字段规则或修订模板前自动保留副本。数据库备份仍需与文件备份配套。</p>{history.error&&<p role="alert">{history.error.message}</p>}{!history.data?.items.length&&<p>暂无历史修订。</p>}{history.data?.items.map(r=><div className="row" key={r.id}><span>{r.created_at} · {r.digest.slice(0,12)}</span><Button size="sm" onClick={()=>api.download(`/api/templates/${id}/history/${r.id}/file`)}>下载旧模板</Button>{r.vars_rel&&<Button size="sm" onClick={()=>api.download(`/api/templates/${id}/history/${r.id}/file?part=vars`)}>下载旧字段规则</Button>}</div>)}<Button size="sm" onClick={history.reload}>刷新历史</Button></Card>;
}
