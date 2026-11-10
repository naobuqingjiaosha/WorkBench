import {useEditorGuard,useNavigationGuard} from '../components/NavigationGuard';
import {InspectionRecords} from '../components/InspectionRecords';
import {AnnualLedger} from '../components/AnnualLedger';
import {PeriodAttachments,type ExternalMaterial} from '../components/PeriodAttachments';
import {WorkDocuments} from '../components/WorkDocuments';
import MonthlyTimesheet from './MonthlyTimesheet';
import { ImportResult } from '../components/ImportResult';
import {PeriodExecution} from '../components/PeriodExecution';
import {PeriodRuleEditor,type PeriodRule} from '../components/PeriodRuleEditor';
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
        rule: PeriodRule | null;
    }>(`/api/workbenches/${workbenchId}/periods`), { busy, run } = useAction();
    const navigation=useNavigationGuard();
    const [selected, setSelected] = useState(initialPeriodId??''), [configure, setConfigure] = useState(false);
    useEffect(() => { void run(async () => { await api.post(`/api/workbenches/${workbenchId}/periods/sync`); list.reload(); }); }, [workbenchId]);
    useEffect(() => { if (initialPeriodId)
        setSelected(initialPeriodId); }, [initialPeriodId]);
    useEffect(() => { if (!selected && list.data?.items.length){const id=String(list.data.items.find(p => p.status === 'open')?.id ?? list.data.items[0]!.id);setSelected(id);onPeriodSelected?.(id);} }, [list.data, selected]);
    const sync = () => run(async () => { await api.post(`/api/workbenches/${workbenchId}/periods/sync`); list.reload(); });
    return <Card className="period-panel" title="办理期次" extra={<Button disabled={!list.data} onClick={()=>configure?navigation.request(()=>setConfigure(false)):setConfigure(true)}>高级排期设置</Button>}>
 {list.error && <p role="alert">{list.error.message} <Button onClick={list.reload}>重试</Button></p>}
 {configure&&list.data&&<PeriodRuleEditor key={'rule-'+workbenchId} workbenchId={workbenchId} rule={list.data.rule} onClose={()=>setConfigure(false)} onSaved={()=>{list.reload();onRuleChanged?.();}}/>}
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
    const navigation=useNavigationGuard();
    const monthly=workTypeCode==='integrity-monthly-inspection';
    const toast=useToast();
    const contentDirty=useRef(false),savingContent=useRef(false);
    const [contentBusy,setContentBusy]=useState(false),[savedContent,setSavedContent]=useState(''),[conflict,setConflict]=useState<string|null>(null);
    const [content,setContent]=useState(''),[due,setDue]=useState('');
    useEffect(() => { if (detail.data) {
        if(!contentDirty.current&&!savingContent.current){setContent(detail.data.content);setSavedContent(detail.data.content);}
        setDue(detail.data.due_date);
    } }, [detail.data]);
    const changeContent=(value:string)=>{contentDirty.current=value!==savedContent;setContent(value);};
    const saveContent=async()=>{
        if(!contentDirty.current)return;
        if(savingContent.current)throw Error('补充说明正在保存，请等待完成后再操作');
        savingContent.current=true;setContentBusy(true);
        const snapshot=content;
        try {
            await api.put(`/api/periods/${id}`,{content:snapshot,expected:{content:savedContent}});
            setSavedContent(snapshot);setConflict(null);contentDirty.current=false;
            // Refresh readiness/file validity after changing the source content.
            detail.reload();onChange();
        } catch(e) {
            const error=e as {code?:string;detail?:{field:string;current:string}};
            if(error.code==='PERIOD_CHANGED'&&error.detail?.field==='content')setConflict(error.detail.current);
            throw e;
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
 {conflict!==null&&<div className="notice notice-warn" role="alert"><strong>其他入口已保存了新的本期内容</strong><p style={{whiteSpace:'pre-wrap'}}>{conflict||'（空）'}</p>
 <Button onClick={()=>{setSavedContent(conflict);setContent(conflict);contentDirty.current=false;setConflict(null);detail.reload();}}>采用已保存内容</Button>
 <Button onClick={()=>{setSavedContent(conflict);contentDirty.current=content!==conflict;setConflict(null);}}>保留我的输入，继续核对</Button></div>}
 {detail.error&&<p role="alert">状态刷新失败：{detail.error.message} <Button onClick={detail.reload}>重试</Button></p>}
 <p className={`period-summary${monthly?' monthly-summary':''}`}><strong>{p.report_period}</strong> · {monthly?`${readiness.recordCount} 次已确认检查 · ${readiness.recordsReady?'文件已生成':'待起草／编辑中'}`:timesheet?'本期部门工时：上传资料，核对人员与项目后计算':'准备内容，生成文件后可下载或继续修改'}</p>

 {workTypeCode==='integrity-quarter-summary'&&<PeriodExecution period={p} purpose="summary" onSaved={refresh}/>}
 {monthly&&<div id={`period-${id}-checks`}><AnnualLedger key={id} periodId={id} month={p.report_period} onChanged={refresh}/><details><summary>检查草稿、已确认记录与单次表册</summary><InspectionRecords periodId={id} workbenchId={workbenchId} month={p.report_period} templates={templates.filter(t=>t.generation_scope!=='period')} disabled={false} onChanged={refresh}/></details></div>}
 {timesheet&&<MonthlyTimesheet embedded workbenchId={workbenchId} periodId={id} initialMonth={p.report_period} boundTemplates={templates}/>}
 <div id={`period-${id}-documents`}>
 {timesheet?<details><summary>其他模板与通用文书</summary>{documentPanel}</details>:documentPanel}
 </div>

 {p.reported_on&&<details><summary>历史报送记录（只读）</summary><p>{p.reported_on}；历史记录保留，不影响当前材料制作。</p></details>}
 <details id={`period-${id}-attachments`} className="secondary-panel"><summary>参考资料与附件{readiness.external.some(m=>m.required&&!m.ready)?' · 有必要附件待确认':''}</summary>
 {monthly&&<Field label="本月补充说明（可选）"><Textarea value={content} onChange={changeContent} disabled={contentBusy}/><Button disabled={contentBusy||content===savedContent} onClick={()=>void saveContent().then(()=>toast('补充说明已保存','ok')).catch(e=>toast((e as Error).message,'err'))}>保存补充说明</Button></Field>}
 <PeriodAttachments periodId={id} workbenchId={workbenchId} materials={readiness.external} files={p.files} disabled={false} onChanged={refresh}/>
 {!monthly&&workTypeCode!=='integrity-quarter-summary'&&<PeriodExecution period={p} purpose="general" onSaved={refresh}/>}
 {!monthly&&templates.map(t=><ImportResult key={t.id} name={t.name} workbenchId={workbenchId} periodId={id} templateId={t.id} disabled={false} onSaved={refresh}/>)}
 <details><summary>本期办理状态与截止日期</summary>
 <p>{p.status==='done'?'本期已确认完成。':readiness.missing.length?`待补：${readiness.missing.join('；')}`:'已满足本期材料要求，可按实际办理情况确认完成。'}</p>
 <Button disabled={busy||p.status!=='done'&&!readiness.canComplete} onClick={()=>navigation.request(()=>void update({status:p.status==='done'?'open':'done'}))}>{p.status==='done'?'重新打开本期':'确认本期办理完成'}</Button><Field label="本期截止日期"><Input type="date" value={due} onChange={setDue} disabled={false}/></Field><Button disabled={busy} onClick={()=>void update({due_date:due})}>保存截止日期</Button></details>
 </details>
 </div>;
}
