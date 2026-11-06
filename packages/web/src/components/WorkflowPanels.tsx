import {useEditorGuard} from './NavigationGuard';
import {useWorkbenchCollection} from './useWorkbenchCollection';
import {WorkbenchSelect} from './WorkbenchSelect';
import { ImportResult } from './ImportResult';
import { useEffect, useState, useRef } from 'react';
import { api, useApi } from '../api';
import { Button, Card, Field, Input, Select, Textarea, useAction } from '../ui';
export interface Inbox {
    other:{kind:string;title:string;reason:string;href:string;workbenchId:number;workbenchName:string}[];
    otherTruncated:boolean;
    periods: {
        id: number;
        workbench_id: number;
        name: string;
        report_period: string;
        due_date: string;
        overdue: boolean;
        missing: string[];
        nextAction:string;
        canComplete:boolean;
    }[];
    todos: {
        id: number;
        title: string;
        due_date: string | null;
        note: string;
    }[];
    timesheets: {
        id: number;
        month: string;
        exceptions: number;
        workbench_id:number|null;
        period_id:number|null;
    }[];
}
export function useWorkflowInbox() {
    const list = useApi<Inbox>('/api/workflow/inbox');
    const [syncError, setSyncError] = useState('');
    const refresh = async () => {
        setSyncError('');
        try { await api.post('/api/periods/sync'); }
        catch (e) { setSyncError((e as Error).message); }
        finally { list.reload(); }
    };
    useEffect(() => { void refresh(); }, []);
    return {...list, syncError, refresh};
}
interface CheckItem {
    id: number;
    title: string;
    kind:string;
    position_name: string;
    required: number;
    review_status: string;
    review_note: string;
    files: {
        id: number;
        file_name: string;
        exists: boolean;
    }[];
}
export function ProjectReadiness({ workbenchId, onChanged }: {
    onChanged?:()=>void;
    workbenchId: number;
}) {
    const data = useApi<{
        items: CheckItem[];
        documents: {positionId:number;positionCode:string;shortfall:number;items:{templateId:number;name:string;required:number;finalized:boolean}[]}[];
        missing: number;
    }>(`/api/workbenches/${workbenchId}/readiness`);
    if (!data.data || (!data.data.items.length && !data.data.documents.length))
        return null;
    return <Card title={`工作材料核对 · ${data.data.missing} 项必备材料未确认`} collapsible><p>上传文件只代表已提供。确认符合要求后才能完成阶段；不适用须记录原因。</p>{data.data.items.map(i => <CheckRow key={`${i.id}-${i.review_status}-${i.files.length}`} workbenchId={workbenchId} item={i} reload={()=>{data.reload();onChanged?.();}}/>)}{data.data.documents.map(d => <StageDocumentRequirements workbenchId={workbenchId} key={d.positionId} stage={d} reload={data.reload}/>)}</Card>;
}
function StageDocumentRequirements({stage, reload,workbenchId}: {workbenchId:number;stage:{positionId:number;positionCode:string;shortfall:number;items:{templateId:number;name:string;required:number;finalized:boolean}[]};reload:()=>void}) {
    const {busy,run}=useAction(),lock=useRef(false);
    const act=async(fn:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;try{await run(fn);}finally{lock.current=false;}};
    const [difference,setDifference]=useState<{allowed:boolean;reason:string;before:{name:string;required:number}[];after:{name:string;required:number}[]}|null>(null);
    useEditorGuard({dirty:!!difference,busy,discard:()=>setDifference(null)});
    return <div className="col" style={{borderTop:'1px solid var(--border)',padding:10}}>
        <strong>{stage.positionCode} · 必备文书尚缺 {stage.shortfall} 份定稿</strong>
        {stage.items.map((d,i)=><div key={i}><p>{d.name} · {d.required?'必备':'可选'} · {d.finalized?'已定稿':'尚未定稿'}</p><ImportResult name={d.name} workbenchId={workbenchId} templateId={d.templateId} positionCode={stage.positionCode} onSaved={reload}/></div>)}
        <Button disabled={busy} onClick={()=>void act(async()=>setDifference(await api.post(`/api/positions/${stage.positionId}/doc-requirements`,{})))}>预览阶段模板要求变更</Button>
        {difference && <div><p>当前快照：{difference.before.map(x=>`${x.name}${x.required?'（必备）':''}`).join('、')||'无绑定'}</p><p>最新配置：{difference.after.map(x=>`${x.name}${x.required?'（必备）':''}`).join('、')||'无绑定'}</p><p>确认后只改变此阶段的文书要求，已有文件保留。</p>{!difference.allowed&&<p role="status">不可应用：{difference.reason}</p>}<Button disabled={busy||!difference.allowed} onClick={()=>void act(async()=>{await api.post(`/api/positions/${stage.positionId}/doc-requirements`,{apply:true,expected:difference});setDifference(null);reload();})}>确认应用到此阶段</Button><Button disabled={busy} onClick={()=>setDifference(null)}>取消</Button></div>}
    </div>;
}
function CheckRow({ item: i, reload,workbenchId }: {
    workbenchId:number;
    item: CheckItem;
    reload: () => void;
}) {
    const [status, setStatus] = useState(i.review_status), [note, setNote] = useState(i.review_note), { busy, run } = useAction();
    return <div className="col" style={{ padding: 8, borderBottom: '1px solid var(--border)' }}><strong>{i.position_name} · {i.title} {i.required ? '（必备）' : '（可选）'}</strong><div>{i.files.map(f => <a style={{ marginRight: 12 }} href={`/api/artifacts/${f.id}/file`} key={f.id}>{f.file_name}{f.exists ? '' : '（文件丢失）'}</a>)}</div><div className="row"><Select value={status} onChange={setStatus} options={[{ value: 'pending', label: '未核对' }, { value: 'verified', label: '确认符合本项要求' }, { value: 'na', label: '不适用' }]}/><Input value={note} onChange={setNote} placeholder="核对说明 / 不适用原因"/><label>上传本项资料<input type="file" aria-label={`上传 ${i.title}`} disabled={busy} onChange={e=>{const file=e.target.files?.[0];if(!file)return;void run(async()=>{const form=new FormData();form.append('workbenchId',String(workbenchId));form.append('checklistItemId',String(i.id));form.append('file',file);await api.upload(i.kind==='evidence'?'/api/artifacts/evidence':'/api/artifacts/upload',form);reload();});}}/></label><Button disabled={busy} onClick={() => void run(async () => { await api.put(`/api/checklist/${i.id}/review`, { status, note }); reload(); })}>保存核对</Button><Button disabled={busy||!note.trim()} onClick={()=>void run(async()=>{await api.put(`/api/checklist/${i.id}/requirement`,{required:!i.required,reason:note});reload();})}>{i.required?'调整为选备':'调整为必备'}（需依据）</Button></div></div>;
}
interface Memory {
    id: number;
    text: string;
    source: string | null;
    fact_key: string | null;
    fact_value: string | null;
    workbench_id: number | null;
    period_id: number | null;
    valid_from: string | null;
    valid_until: string | null;
    status: string;
}
export function MemoryLifecycle() {
    const [status, setStatus] = useState('active'), list = useApi<{
        items: Memory[];
    }>(`/api/agent/memories?status=${status}`), [selected, setSelected] = useState('');
    const m = list.data?.items.find(x => String(x.id) === selected);
    return <Card title="记忆适用范围与有效期"><p>仅已确认、未过期且属于当前工作的记忆参与生成。本期事实优先，冲突需人工核对。</p><Select value={status} onChange={v => { setStatus(v); setSelected(''); }} options={[{ value: 'active', label: '启用记忆' }, { value: 'archived', label: '停用记忆' }]}/><Select value={selected} onChange={setSelected} options={[{ value: '', label: '选择要更正的记忆' }, ...(list.data?.items ?? []).map(x => ({ value: String(x.id), label: x.text.slice(0, 90) }))]}/>{m && <MemoryEditor key={m.id} memory={m} reload={list.reload}/>}</Card>;
}
function MemoryEditor({ memory: m, reload }: {
    memory: Memory;
    reload: () => void;
}) {
    const [text, setText] = useState(m.text), [source, setSource] = useState(m.source ?? ''), [wb, setWb] = useState(String(m.workbench_id ?? '')), [period, setPeriod] = useState(String(m.period_id ?? '')), [from, setFrom] = useState(m.valid_from ?? ''), [until, setUntil] = useState(m.valid_until ?? ''), { busy, run } = useAction();
    const [factKey,setFactKey]=useState(m.fact_key ?? ''), [factValue,setFactValue]=useState(m.fact_value ?? '');
    const work = useWorkbenchCollection(), periods = useApi<{
        items: {
            id: number;
            report_period: string;
        }[];
    }>(wb ? `/api/workbenches/${wb}/periods` : null);
    const history = useApi<{items: Memory[]}>(`/api/agent/memories/${m.id}/history`);
    const save = (status: string) => run(async () => { await api.put(`/api/agent/memories/${m.id}`, { text, source: source || '用户更正', workbench_id: wb ? Number(wb) : null, period_id: period ? Number(period) : null, valid_from: from || null, valid_until: until || null, fact_key:factKey.trim() || null,fact_value:factValue.trim() || null, status }); reload(); history.reload(); });
    return <div className="col"><Field label="记忆内容"><Textarea value={text} onChange={setText}/></Field><Field label="来源"><Input value={source} onChange={setSource}/></Field><div className="grid grid-2"><Field label="事实字段（可选，与模板变量同名）"><Input value={factKey} onChange={setFactKey}/></Field><Field label="事实值（与字段同时填写）"><Input value={factValue} onChange={setFactValue}/></Field></div><p>标注事实字段后，与本次值不同的记忆会要求逐项选择并记录依据；自由文本仍需人工核对。</p><div className="row"><WorkbenchSelect collection={work} value={wb} onChange={v => { setWb(v); setPeriod(''); }} placeholder="全局"/><Select value={period} onChange={setPeriod} options={[{ value: '', label: '不限期次' }, ...(periods.data?.items ?? []).map(p => ({ value: String(p.id), label: p.report_period }))]}/></div><div className="grid grid-2"><Field label="生效日期"><Input type="date" value={from} onChange={setFrom}/></Field><Field label="失效日期"><Input type="date" value={until} onChange={setUntil}/></Field></div><div className="row"><Button disabled={busy} onClick={() => void save('active')}>确认并启用</Button><Button disabled={busy} onClick={() => void save('archived')}>停用</Button></div><details><summary>更正历史与来源</summary>{history.data?.items.map(x => <p key={x.id}>#{x.id} · {x.text} · 来源：{x.source || '未说明'} · {x.status === 'active' ? '当前启用' : '已停用或替代'}</p>)}</details></div>;
}
