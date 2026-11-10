import {useState} from 'react';
import {api, useApi, type PositionInstance} from '../api';
import {Button, Card, Field, Input, Select, useAction} from '../ui';
import {useEditorGuard} from './NavigationGuard';

interface Dossier {businessStatus:string;dossierStatus:string;historical:boolean;missing:string[];canArchive:boolean;}
interface Task {id:number;title:string;note:string;kind:string;due_date:string|null;owner:string;status:string;position_id:number|null;}
const kinds=[{value:'task',label:'办理事项'},{value:'delivery',label:'供应商交付'},{value:'coordination',label:'待协调事项'}];

export function DossierStatus({id,revision}:{id:number;revision?:unknown}) {
  const dossier=useApi<Dossier>(`/api/workbenches/${id}/dossier`,[revision]);
  return <Card title="业务与档案状态">
    {dossier.error ? <p role="alert">档案状态读取失败：{dossier.error.message} <Button onClick={dossier.reload}>重试</Button></p> :
      !dossier.data ? <p role="status">正在核对材料与阶段…</p> : <>
        <p>业务：{dossier.data.businessStatus==='completed'?'已结束':'办理中'}{dossier.data.historical?'（历史补录）':''}　·　档案：{dossier.data.dossierStatus==='ready'?'已备齐':'整理中'}</p>
        {dossier.data.missing.length ? <details><summary>查看 {dossier.data.missing.length} 项待处理要求</summary><ul>{dossier.data.missing.map((m,i)=><li key={i}>{m}</li>)}</ul></details> : <p>当前已配置的要求均已满足。未配置的业务要求仍需人工确认。</p>}
      </>}
    <Button size="sm" disabled={dossier.loading} onClick={dossier.reload}>刷新核对状态</Button>
  </Card>;
}

const emptyTask={title:'',note:'',owner:'',due:'',kind:'task',stage:''};
export function WorkExecution({id,positions,onChanged,project=false}:{id:number;positions:PositionInstance[];onChanged:()=>void;project?:boolean}) {
  const tasks=useApi<{items:Task[]}>(`/api/quick-todos?workbenchId=${id}`);
  const [form,setForm]=useState(emptyTask);
  const {busy,run}=useAction();
  const set=(key:keyof typeof form)=>(value:string)=>setForm(prev=>({...prev,[key]:value}));
  const refresh=()=>{tasks.reload();onChanged();};
  async function save() {
    if (!form.title.trim()) throw new Error('请填写事项名称');
    await api.post('/api/quick-todos',{title:form.title,note:form.note,owner:form.owner,kind:form.kind,workbench_id:id,position_id:form.stage?Number(form.stage):null,due_date:form.due||null});
    setForm(emptyTask);refresh();
  }
  const dirty=Object.entries(form).some(([k,v])=>v!==emptyTask[k as keyof typeof form]);
  useEditorGuard({dirty,busy,save,discard:()=>setForm(emptyTask)});
  return <>
    {!project && <DossierStatus id={id} revision={tasks.data}/>}
    <details className="work-support card"><summary>{project?'办理、供应商交付与协调事项':'办理事项'}</summary><div className="card-body">
      {tasks.error && <p role="alert">{tasks.error.message} <Button onClick={tasks.reload}>重试</Button></p>}
      <fieldset disabled={busy} className="grid grid-2">
        <Field label="事项"><Input value={form.title} onChange={set('title')}/></Field>
        {project&&<Field label="类型"><Select value={form.kind} onChange={set('kind')} options={kinds}/></Field>}
        <Field label="所属阶段"><Select value={form.stage} onChange={set('stage')} options={[{value:'',label:'工作整体'},...positions.map(p=>({value:String(p.id),label:p.name}))]}/></Field>
        <Field label={project?'负责人 / 供应商':'负责人'}><Input value={form.owner} onChange={set('owner')}/></Field>
        <Field label="截止日期"><Input type="date" value={form.due} onChange={set('due')}/></Field>
        <Field label="办理说明"><Input value={form.note} onChange={set('note')}/></Field>
      </fieldset>
      <Button disabled={busy||!form.title.trim()} onClick={()=>void run(save)}>添加事项</Button>
      {!tasks.loading&&!tasks.error&&!tasks.data?.items.length&&<p>暂无办理事项。</p>}
      {tasks.data?.items.map(t=><TaskRow key={t.id} task={t} project={project} onChanged={refresh}/>)}
    </div></details>
  </>;
}

function TaskRow({task:t,onChanged,project}:{task:Task;onChanged:()=>void;project:boolean}){
  const [draft,setDraft]=useState<{note:string;owner:string;due:string}|null>(null);
  const {busy,run}=useAction();
  const saved={note:t.note,owner:t.owner,due:t.due_date??''};
  const dirty=draft!==null&&(draft.note!==saved.note||draft.owner!==saved.owner||draft.due!==saved.due);
  async function save(){
    if(!draft)return;
    await api.put(`/api/quick-todos/${t.id}`,{note:draft.note,owner:draft.owner,due_date:draft.due||null});
    setDraft(null);onChanged();
  }
  const navigate=useEditorGuard({dirty,busy,save,discard:()=>setDraft(null)});
  return <div className="col">
    <div className="row"><strong>{t.title}</strong><span>{t.status==='done'?'已完成':'待办理'} · {kinds.find(k=>k.value===t.kind)?.label} · {t.owner||'未指定负责人'} · {t.due_date??'未设截止日期'} · {t.note}</span>
      {!draft && <Button size="sm" disabled={busy} onClick={()=>setDraft(saved)}>更新进度与节点</Button>}
      <Button size="sm" disabled={busy||!!draft} onClick={()=>void run(async()=>{await api.put(`/api/quick-todos/${t.id}`,{status:t.status==='open'?'done':'open'});onChanged();})}>{t.status==='open'?'确认完成':'重新打开'}</Button>
    </div>
    {draft && <fieldset disabled={busy}>
      <Field label="实际进度 / 最新协调记录"><Input value={draft.note} onChange={note=>setDraft({...draft,note})}/></Field>
      <Field label={project?'负责人 / 供应商':'负责人'}><Input value={draft.owner} onChange={owner=>setDraft({...draft,owner})}/></Field>
      <Field label="经确认的截止日期"><Input type="date" value={draft.due} onChange={due=>setDraft({...draft,due})}/></Field>
      <Button disabled={busy||!dirty} onClick={()=>void run(save)}>保存进度与节点</Button>
      <Button disabled={busy} onClick={()=>navigate(()=>setDraft(null))}>取消修改</Button>
    </fieldset>}
  </div>;
}
