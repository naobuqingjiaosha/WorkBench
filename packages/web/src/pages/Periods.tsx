import {useEditorGuard,useNavigationGuard} from '../components/NavigationGuard';
import {InspectionRecords} from '../components/InspectionRecords';
import {AnnualLedger} from '../components/AnnualLedger';
import {PeriodAttachments,type ExternalMaterial} from '../components/PeriodAttachments';
import {WorkDocuments} from '../components/WorkDocuments';
import MonthlyTimesheet from './MonthlyTimesheet';
import { ImportResult } from '../components/ImportResult';
import {PeriodExecution} from '../components/PeriodExecution';
import { useEffect, useRef, useState } from 'react';
import { api, useApi } from '../api';
import { Button, Card, Field, Input, Select, Textarea, useAction, useToast } from '../ui';
interface Period {
    id: number;
    report_period: string;
    due_date: string;
    status: string;
    content: string;
    snapshot: string;
    steps: string;
    scheduled_date: string|null;
    source_period_ids:string;
}
interface Material {
    id: number;
    title: string;
    status: string;
    note: string;
    artifact_id: number | null;
    required:number;
    requirement_kind:string;
    config_key:string|null;
}
interface Detail extends Period {
    materials: Material[];
    files: {
        id: number;
        file_name: string;
        is_final: number;kind:string;file_role:string;
    }[];
    readiness:{validFinalIds:number[];recordDocumentsReady:boolean;inspectionRevisions:{id:number;revision:number;project:string;date:string}[];monthly:boolean;missing:string[];canComplete:boolean;external:ExternalMaterial[];finalCount:number;recordCount:number;recordsReady:boolean;reported:boolean};
    reported_on:string|null;
}
interface Rule {
    frequency: string;
    first_period: string;
    due_month_offset: number;
    due_day: number;
    remind_days: number;
    requirements: string;
    steps:string;
}
export function PeriodPanel({ workbenchId, workTypeId, workTypeCode, initialPeriodId, onRuleChanged, timesheet = false,onPeriodSelected }: {
    workbenchId: number;
    workTypeId: number;
    workTypeCode?:string;
    timesheet?:boolean;
    initialPeriodId?: string;
    onPeriodSelected?:(id:string)=>void;
    onRuleChanged?: () => void;
}) {
    const list = useApi<{
        items: Period[];
        rule: Rule | null;
    }>(`/api/workbenches/${workbenchId}/periods`), { busy, run } = useAction();
    const navigation=useNavigationGuard();
    const [selected, setSelected] = useState(initialPeriodId??''), [configure, setConfigure] = useState(false), [frequency, setFrequency] = useState('monthly'), [first, setFirst] = useState(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date())), [offset, setOffset] = useState('1'), [day, setDay] = useState('5'), [remind, setRemind] = useState('3'), [requirements, setRequirements] = useState('');
    const [defaultSteps,setDefaultSteps]=useState('');
    useEffect(() => { const r = list.data?.rule; if (r) {
        setFrequency(r.frequency);
        setFirst(r.first_period);
        setOffset(String(r.due_month_offset));
        setDay(String(r.due_day));
        setRemind(String(r.remind_days));
        setRequirements(JSON.parse(r.requirements).join('\n'));
        setDefaultSteps(JSON.parse(r.steps).join('\n'));
    } }, [list.data?.rule]);
    useEffect(() => { void run(async () => { await api.post(`/api/workbenches/${workbenchId}/periods/sync`); list.reload(); }); }, [workbenchId]);
    useEffect(() => { if (initialPeriodId)
        setSelected(initialPeriodId); }, [initialPeriodId]);
    useEffect(() => { if (!selected && list.data?.items.length){const id=String(list.data.items.find(p => p.status === 'open')?.id ?? list.data.items[0]!.id);setSelected(id);onPeriodSelected?.(id);} }, [list.data, selected]);
    const sync = () => run(async () => { await api.post(`/api/workbenches/${workbenchId}/periods/sync`); list.reload(); });
    return <Card className="period-panel" title="办理期次" extra={<Button onClick={() => setConfigure(!configure)}>高级排期设置</Button>}>
 {list.error && <p role="alert">{list.error.message}</p>}
 {configure && <div className="col">
 <p>配置只影响新期次；已有期次保留配置快照。日号 31 表示短月份取月末。</p>
 <div className="grid grid-3"><Field label="频率"><Select value={frequency} onChange={setFrequency} options={[{ value: 'monthly', label: '月报' }, { value: 'quarterly', label: '季报' }, { value: 'yearly', label: '年报' }]}/></Field>
 <Field label="首个报告期（2026-09 / 2026-Q3 / 2026）"><Input value={first} onChange={setFirst}/></Field>
 <Field label="截止月份：从报告期首月偏移几个月"><Input type="number" value={offset} onChange={setOffset}/></Field>
 <Field label="截止日号"><Input type="number" value={day} onChange={setDay}/></Field><Field label="提前提醒天数"><Input type="number" value={remind} onChange={setRemind}/></Field></div>
 <Field label="必备材料（一行一项）"><Textarea value={requirements} onChange={setRequirements}/></Field>

 <Button disabled={busy} onClick={() => void run(async () => { await api.put(`/api/workbenches/${workbenchId}/periods/rule`, { frequency, first_period: first, due_month_offset: Number(offset), due_day: Number(day), remind_days: Number(remind), requirements: requirements.split('\n').filter(Boolean), steps: defaultSteps.split('\n').filter(Boolean) }); await api.post(`/api/workbenches/${workbenchId}/periods/sync`); setConfigure(false); list.reload(); onRuleChanged?.(); })}>保存规则</Button>
 </div>}
 <div className="row"><Select value={selected} onChange={v=>navigation.request(()=>{setSelected(v);onPeriodSelected?.(v);})} options={[{ value: '', label: '选择报告期' }, ...(list.data?.items ?? []).map(p => ({ value: String(p.id), label: `${p.report_period} · 截止 ${p.due_date} · ${p.status === 'done' ? '已完成' : '待办理'}` }))]}/><Button disabled={busy} onClick={() => void sync()}>补齐期次</Button></div>
 {!list.loading&&!list.data?.rule && <p>尚未启用独立期次。可按实际业务在高级设置启用排期。</p>}
 {selected && <PeriodDetail timesheet={timesheet} key={selected} id={Number(selected)} workbenchId={workbenchId} workTypeId={workTypeId} workTypeCode={workTypeCode} onChange={()=>{list.reload();onRuleChanged?.();}}/>}
 </Card>;
}
function PeriodDetail({ id, workbenchId, workTypeId, workTypeCode, onChange,timesheet }: {
    id: number;
    workbenchId: number;
    workTypeId: number;
    workTypeCode?:string;
    onChange: () => void;
    timesheet:boolean;
}) {
    const detail = useApi<Detail>(`/api/periods/${id}`), { busy, run } = useAction();
    const monthly=workTypeCode==='integrity-monthly-inspection';
    const toast=useToast();
    const contentDirty=useRef(false),savingContent=useRef(false);
    const [contentBusy,setContentBusy]=useState(false),[savedContent,setSavedContent]=useState('');
    const [content,setContent]=useState(''),[due,setDue]=useState('');
    useEffect(() => { if (detail.data) {
        if(!contentDirty.current&&!savingContent.current){setContent(detail.data.content);setSavedContent(detail.data.content);}
        setDue(detail.data.due_date);
    } }, [detail.data]);
    const changeContent=(value:string)=>{contentDirty.current=value!==savedContent;setContent(value);};
    const saveContent=async()=>{
        if(savingContent.current)throw Error('补充说明正在保存，请等待完成后再操作');
        savingContent.current=true;setContentBusy(true);
        const snapshot=content;
        try {
            await api.put(`/api/periods/${id}`,{content:snapshot});
            setSavedContent(snapshot);contentDirty.current=false;
            // Refresh readiness/file validity after changing the source content.
            detail.reload();onChange();
        } finally {savingContent.current=false;setContentBusy(false);}
    };
    useEditorGuard({dirty:monthly&&content!==savedContent,busy:monthly&&contentBusy,save:saveContent,discard:()=>{setContent(savedContent);contentDirty.current=false;}});
    const p = detail.data;
    if (!p)
        return <p role={detail.error?'alert':undefined}>{detail.error?.message ?? '加载期次…'}{detail.error&&<Button onClick={detail.reload}>重试</Button>}</p>;
    const refresh = () => { detail.reload(); onChange(); };
    const update = (b: unknown) => run(async () => { await api.put(`/api/periods/${id}`, b); refresh(); });
    const templates = (JSON.parse(p.snapshot).templates ?? []) as {
        id: number;
        name: string;
        generation_scope?:'period'|'record';
    }[];
    const rawRules=JSON.parse(p.snapshot).material_rules;
    const resultRules=(typeof rawRules==='string'?JSON.parse(rawRules):rawRules??[]) as {key:string;kind:string;templateId:number|null}[];
    const resultRequirements=p.materials.flatMap(m=>{const rule=resultRules.find(r=>r.kind==='generated'&&r.key===m.config_key);return rule?[{...m,templateId:rule.templateId}]:[];});
    const readiness=p.readiness;
    const nextSection=!readiness.recordDocumentsReady?'checks':!readiness.recordsReady?'documents':'attachments';
    const goToSection=()=>{const section=document.getElementById(`period-${id}-${nextSection}`);if(section instanceof HTMLDetailsElement)section.open=true;section?.scrollIntoView({behavior:'smooth',block:'start'});section?.querySelector<HTMLElement>('button:not(:disabled),input:not(:disabled)')?.focus({preventScroll:true});};
    const documentPanel = <WorkDocuments resultRequirements={resultRequirements} validFinalIds={readiness.validFinalIds} refreshKey={p.files.map(f=>`${f.id}-${f.is_final}`).join()} inspectionMode={monthly} workbenchId={workbenchId} workTypeId={workTypeId} periodId={id} content={content} contentLabel={monthly?'本月补充说明（可选）':'本次业务内容'} onContentChange={changeContent} onSaveContent={saveContent} templates={templates} inspectionRevisions={readiness.inspectionRevisions} disabled={contentBusy} onChanged={refresh}/>;
    return <div className="col period-workspace">
 {detail.error&&<p role="alert">状态刷新失败：{detail.error.message} <Button onClick={detail.reload}>重试</Button></p>}
 <p className={`period-summary${monthly?' monthly-summary':''}`}><strong>{p.report_period}</strong> · {monthly?`${readiness.recordCount} 次已确认检查 · ${readiness.recordsReady?'文件已生成':'待起草／编辑中'}`:timesheet?'本期部门工时：上传资料，核对人员与项目后计算':'准备内容，生成文件后可下载或继续修改'}</p>

 {monthly&&<div id={`period-${id}-checks`}><AnnualLedger key={id} periodId={id} month={p.report_period} onChanged={refresh}/><details><summary>已有检查记录与其他模板</summary><InspectionRecords periodId={id} workbenchId={workbenchId} month={p.report_period} templates={templates.filter(t=>t.generation_scope!=='period')} disabled={false} onChanged={refresh}/></details></div>}
 {timesheet&&<MonthlyTimesheet embedded workbenchId={workbenchId} periodId={id} initialMonth={p.report_period} boundTemplates={templates}/>}
 <div id={`period-${id}-documents`}>
 {timesheet?<details><summary>其他模板与通用文书</summary>{documentPanel}</details>:documentPanel}
 </div>

 {p.reported_on&&<details><summary>历史报送记录（只读）</summary><p>{p.reported_on}；历史记录保留，不影响当前材料制作。</p></details>}
 <details id={`period-${id}-attachments`} className="secondary-panel"><summary>参考资料与附件{readiness.external.some(m=>m.required&&!m.ready)?' · 有必要附件待确认':''}</summary>
 {monthly&&<Field label="本月补充说明（可选）"><Textarea value={content} onChange={changeContent} disabled={contentBusy}/><Button disabled={contentBusy||content===savedContent} onClick={()=>void saveContent().then(()=>toast('补充说明已保存','ok')).catch(e=>toast((e as Error).message,'err'))}>保存补充说明</Button></Field>}
 <PeriodAttachments periodId={id} workbenchId={workbenchId} materials={readiness.external} files={p.files} disabled={false} onChanged={refresh}/>
 <PeriodExecution period={p} purpose={monthly?'inspection':workTypeCode==='integrity-quarter-summary'?'summary':'general'} onSaved={refresh}/>
 {!monthly&&templates.map(t=><ImportResult key={t.id} name={t.name} workbenchId={workbenchId} periodId={id} templateId={t.id} disabled={false} onSaved={refresh}/>)}
 <details><summary>调整本期截止日期</summary><Field label="本期截止日期"><Input type="date" value={due} onChange={setDue} disabled={false}/></Field><Button disabled={busy} onClick={()=>void update({due_date:due})}>保存截止日期</Button></details>
 </details>
 </div>;
}
