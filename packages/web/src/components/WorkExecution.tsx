import {useState} from 'react';
import {api,useApi,type PositionInstance} from '../api';
import {Button,Card,Field,Input,Select,useAction} from '../ui';

interface Dossier {businessStatus:string;dossierStatus:string;historical:boolean;missing:string[];canArchive:boolean;}
interface Task {id:number;title:string;note:string;kind:string;due_date:string|null;owner:string;status:string;position_id:number|null;}
const kinds=[{value:'task',label:'办理事项'},{value:'delivery',label:'供应商交付'},{value:'coordination',label:'待协调事项'}];
export function WorkExecution({id,positions,onChanged,project=false}:{id:number;positions:PositionInstance[];onChanged:()=>void;project?:boolean}){
 const dossier=useApi<Dossier>(`/api/workbenches/${id}/dossier`),tasks=useApi<{items:Task[]}>(`/api/quick-todos?workbenchId=${id}`),{busy,run}=useAction();
 const [title,setTitle]=useState(''),[note,setNote]=useState(''),[owner,setOwner]=useState(''),[due,setDue]=useState(''),[kind,setKind]=useState('task'),[stage,setStage]=useState('');
 const refresh=()=>{tasks.reload();dossier.reload();onChanged();};
 return <><Card title="业务与档案状态">
 {dossier.error&&<p role="alert">{dossier.error.message}</p>}
 {dossier.data&&<><p>业务：{dossier.data.businessStatus==='completed'?'已结束':'办理中'}{dossier.data.historical?'（历史补录）':''}　·　档案：{dossier.data.dossierStatus==='ready'?'已备齐':'整理中'}</p><p>{project?'业务已结束的项目仍可补录资料、核对材料及整理阶段，资料备齐后再归档。':'核对本工作材料及成果后，按实际办理情况完成或归档。'}</p>{dossier.data.missing.length?<details><summary>查看 {dossier.data.missing.length} 项待处理要求</summary>{dossier.data.missing.map((m,i)=><p key={i}>{m}</p>)}</details>:<p>当前已配置的要求均已满足。未配置的业务要求仍需人工确认。</p>}</>}
 {dossier.data?.historical&&<p>历史补录直接按阶段收集、上传和核对档案；无需重走阶段或补造历史办理时间。</p>}
 <Button size="sm" onClick={()=>{dossier.reload();onChanged();}}>刷新核对状态</Button>
 </Card><Card title={project?'办理、供应商交付与协调事项':'办理事项'} collapsible defaultOpen={false}>
 {tasks.error&&<p role="alert">{tasks.error.message}</p>}
 <div className="grid grid-2"><Field label="事项"><Input value={title} onChange={setTitle}/></Field>{project&&<Field label="类型"><Select value={kind} onChange={setKind} options={kinds}/></Field>}<Field label="所属阶段"><Select value={stage} onChange={setStage} options={[{value:'',label:'工作整体'},...positions.map(p=>({value:String(p.id),label:p.name}))]}/></Field><Field label={project?'负责人 / 供应商':'负责人'}><Input value={owner} onChange={setOwner}/></Field><Field label="截止日期"><Input type="date" value={due} onChange={setDue}/></Field><Field label="办理说明"><Input value={note} onChange={setNote}/></Field></div>
 <Button disabled={busy||!title.trim()} onClick={()=>void run(async()=>{await api.post('/api/quick-todos',{title,note,owner,kind,workbench_id:id,position_id:stage?Number(stage):null,due_date:due||null});setTitle('');setNote('');refresh();})}>添加事项</Button>
 {!tasks.data?.items.length&&<p>{project?'暂无事项，可按实际需要添加交付或协调任务。':'暂无办理事项。'}</p>}
 {tasks.data?.items.map(t=><TaskRow key={`${t.id}-${t.note}-${t.due_date}-${t.status}`} task={t} project={project} onChanged={refresh}/>)}
 </Card></>;
}
function TaskRow({task:t,onChanged,project}:{task:Task;onChanged:()=>void;project:boolean}){
 const [edit,setEdit]=useState(false),[note,setNote]=useState(t.note),[owner,setOwner]=useState(t.owner),[due,setDue]=useState(t.due_date??''),{busy,run}=useAction();
 return <div className="col"><div className="row"><strong>{t.title}</strong><span>{kinds.find(k=>k.value===t.kind)?.label} · {t.owner||'未指定负责人'} · {t.due_date??'未设截止日期'} · {t.note}</span><Button size="sm" disabled={busy} onClick={()=>setEdit(!edit)}>更新进度与节点</Button><Button size="sm" disabled={busy} onClick={()=>void run(async()=>{await api.put(`/api/quick-todos/${t.id}`,{status:t.status==='open'?'done':'open'});onChanged();})}>{t.status==='open'?'确认完成':'重新打开'}</Button></div>
 {edit&&<><Field label="实际进度 / 最新协调记录"><Input value={note} onChange={setNote}/></Field><Field label={project?'负责人 / 供应商':'负责人'}><Input value={owner} onChange={setOwner}/></Field><Field label="经确认的截止日期"><Input type="date" value={due} onChange={setDue}/></Field><Button disabled={busy} onClick={()=>void run(async()=>{await api.put(`/api/quick-todos/${t.id}`,{note,owner,due_date:due||null});setEdit(false);onChanged();})}>保存进度与节点</Button></>}
 </div>;
}
