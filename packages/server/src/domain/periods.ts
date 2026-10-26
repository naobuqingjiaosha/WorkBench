import {isMonthlyInspection,inspectionDocuments,listInspections,inspectionText,inspectionCollectionFields} from './inspections.ts';
import {invalidateLegacyDocumentSources,materialArtifactCurrent} from './document-source.ts';
import { assertPeriodTimesheet } from './timesheets.ts';
import { recalcProgress } from './service.ts';
import { assertFinalArtifact } from './finalization.ts';
import { all, get, run, tx } from '../db/index.ts';
import { getWorkbench, listTemplatesForWorkbench, templateAbsPath, varsAbsPath, templateGenerationScope,templateSupportsWorkType,type Template } from './service.ts';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { artifactAbsPath, type Artifact } from '../core/store.ts';
import { ApiError } from '../api/reply.ts';
export interface PeriodRule {
    workbench_id: number;
    frequency: 'monthly' | 'quarterly' | 'yearly';
    first_period: string;
    due_month_offset: number;
    due_day: number;
    remind_days: number;
    requirements: string;
    version: number;
    steps: string;
}
export interface WorkPeriod {
    completed_at:string|null;
    id: number;
    workbench_id: number;
    report_period: string;
    report_date: string;
    due_date: string;
    status: string;
    snapshot: string;
    content: string;
    steps: string;
    reported_on:string|null;
    report_snapshot:string|null;
    scheduled_date: string | null;
    source_period_ids: string;
}
export interface PeriodStep { title:string; status:'open'|'done'|'na'; note:string }
export function parsePeriodSteps(value:unknown):PeriodStep[] {
 if(!Array.isArray(value)||value.length>50)throw new ApiError('BAD_STEPS','办理步骤须为最多50项的数组');
 return value.map(s=>{const v=typeof s==='string'?{title:s,status:'open',note:''}:s;
 if(!v||typeof v.title!=='string'||!v.title.trim()||v.title.length>300||!['open','done','na'].includes(v.status)||typeof v.note!=='string'||v.note.length>3000)throw new ApiError('BAD_STEPS','步骤标题、状态或说明无效');
 if(v.status==='na'&&!v.note.trim())throw new ApiError('REASON_REQUIRED','不适用步骤须填写依据');
 return {title:v.title.trim(),status:v.status,note:v.note};});
}
export function relatedPeriods(id:number) {
 const p=requirePeriod(id),w=requireWorkbench(p.workbench_id);
 if(!/^\d{4}-Q[1-4]$/.test(p.report_period))return [];
 const end=new Date(p.report_date+'T00:00:00Z');end.setUTCMonth(end.getUTCMonth()+3);
 return all<WorkPeriod & {work_name:string}>(`SELECT p.*,w.name AS work_name FROM work_period p JOIN workbench w ON w.id=p.workbench_id JOIN work_type t ON t.id=w.work_type_id JOIN work_type target ON target.id=? WHERE w.deleted_at IS NULL AND t.domain=target.domain AND t.category=target.category AND p.id<>? AND p.report_date>=? AND p.report_date<? ORDER BY w.name,p.report_date`,[w.work_type_id,id,p.report_date,end.toISOString().slice(0,10)])
 .filter(s=>{const f=JSON.parse(s.snapshot).frequency;return f==='monthly'||f==='quarterly';});
}
export function validateSourcePeriods(id:number,value:unknown):number[] {
 if(!Array.isArray(value)||value.length>100||value.some(n=>!Number.isSafeInteger(n)))throw new ApiError('BAD_SOURCES','请选择有效的来源期次，最多100项');
 const allowed=new Set(relatedPeriods(id).map(p=>p.id));
 if(value.some(n=>!allowed.has(n)))throw new ApiError('BAD_SOURCES','只能选择本季度同业务分类的其他工作期次');
 return [...new Set(value)];
}
export function periodNativeFields(p: WorkPeriod): Record<string, string> {
    const year = p.report_date.slice(0, 4), month = p.report_date.slice(5, 7);
    const quarter=String(Math.ceil(Number(month)/3));
    const content=[p.content,...listInspections(p.id).map(inspectionText)].filter(Boolean).join('\n\n');
    return { ...inspectionCollectionFields(p),'内容':content,'业务内容':content,'本期内容':content, '报告期': p.report_period, '报告月份': `${year}-${month}`, '年份':year,'本季度':quarter,'下季度':String(Number(quarter)%4+1),'下季度年份':String(Number(year)+(quarter==='4'?1:0)), '_年份': year, '_月份': month, '_本月': `${year}年${Number(month)}月` };
}
export function templateFingerprint(t: Template): string {
    const path = templateAbsPath(t), vars = varsAbsPath(t);
    return createHash('sha256').update(existsSync(path) ? readFileSync(path) : 'missing-template').update(vars && existsSync(vars) ? readFileSync(vars) : '').digest('hex');
}
export function periodTemplates(id: number) { return listTemplatesForWorkbench(id).map(t => ({ id: t.id, name: t.name, required: t.required, file_rel: t.file_rel, digest: templateFingerprint(t),generation_scope:templateGenerationScope(t) })); }
export function assertPeriodTemplate(period: WorkPeriod, t: Template) { const entry = (JSON.parse(period.snapshot).templates ?? []).find((x: {
    id: number;
}) => x.id === t.id); if (!entry) throw new ApiError('WRONG_TEMPLATE','请先为本期选择此模板',409); if (entry?.digest && entry.digest !== templateFingerprint(t))
    throw new ApiError('TEMPLATE_CHANGED', '模板或填写规则已变更。请先查看本期模板差异并确认更新，历史定稿不会改变。', 409); }
export const todayShanghai = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function validDate(s: unknown): string {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s + 'T00:00:00Z')) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s)
        throw new ApiError('BAD_DATE', '日期必须为有效的 YYYY-MM-DD');
    return s;
}
export function periodStart(key: string, frequency: PeriodRule['frequency']): string {
    const pattern = frequency === 'monthly' ? /^\d{4}-(0[1-9]|1[0-2])$/ : frequency === 'quarterly' ? /^\d{4}-Q[1-4]$/ : /^\d{4}$/;
    if (!pattern.test(key) || Number(key.slice(0, 4)) < 2000 || Number(key.slice(0, 4)) > 2200)
        throw new ApiError('BAD_PERIOD', '报告期格式：2026-09 / 2026-Q3 / 2026');
    return frequency === 'monthly' ? key + '-01' : frequency === 'quarterly' ? `${key.slice(0, 4)}-${String((Number(key.slice(-1)) - 1) * 3 + 1).padStart(2, '0')}-01` : key + '-01-01';
}
function reportKey(d: Date, f: PeriodRule['frequency']): string { return f === 'monthly' ? d.toISOString().slice(0, 7) : f === 'quarterly' ? `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}` : String(d.getUTCFullYear()); }
export function periodDue(start: string, offset: number, day: number): string {
    const d = new Date(start + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + offset);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, end));
    return d.toISOString().slice(0, 10);
}
export function requireWorkbench(id: number) { const w = getWorkbench(id); if (!w || w.deleted_at)
    throw new ApiError('NOT_FOUND', '工作不存在', 404); return w; }
export function savePeriodRule(id: number, b: Record<string, unknown>): PeriodRule {
    const wb=requireWorkbench(id);
    if(get<{mode:string}>('SELECT mode FROM work_type WHERE id=?',[wb.work_type_id])?.mode==='process' || get('SELECT id FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL',[id]))throw new ApiError('STAGE_PERIOD_CONFLICT','阶段式工作暂不支持每期独立阶段，请另建周期报送工作');
    if(get<{executor:string}>('SELECT executor FROM work_type WHERE id=?',[wb.work_type_id])?.executor==='timesheet' && b.frequency!=='monthly')throw new ApiError('BAD_RULE','部门工时只支持月度期次');
    const frequency = String(b.frequency) as PeriodRule['frequency'];
    if (!['monthly', 'quarterly', 'yearly'].includes(frequency))
        throw new ApiError('BAD_RULE', '请选择月度、季度或年度');
    const first = String(b.first_period ?? '');
    periodStart(first, frequency);
    const offset = Number(b.due_month_offset ?? 0), day = Number(b.due_day ?? 31), remind = Number(b.remind_days ?? 3);
    const max = frequency === 'monthly' ? 1 : frequency === 'quarterly' ? 3 : 12;
    if (!Number.isInteger(offset) || offset < 0 || offset > max || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(remind) || remind < 0 || remind > 365)
        throw new ApiError('BAD_RULE', '截止月份、日号或提醒天数超出范围');
    const old = get<PeriodRule>('SELECT * FROM work_period_rule WHERE workbench_id=?', [id]);
    if (old && old.frequency !== frequency && get('SELECT id FROM work_period WHERE workbench_id=?', [id]))
        throw new ApiError('HAS_PERIODS', '已有期次的工作不能改变频率，请新建另一项工作');
    const requirements = Array.isArray(b.requirements) ? b.requirements.map(String).map(x => x.trim()).filter(Boolean) : [];
    const steps=parsePeriodSteps(b.steps??[]).map(s=>s.title);
    if (requirements.length > 100 || requirements.some(x => x.length > 300))
        throw new ApiError('BAD_RULE', '材料要求过长');
    run(`INSERT INTO work_period_rule(workbench_id,frequency,first_period,due_month_offset,due_day,remind_days,requirements) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(workbench_id) DO UPDATE SET frequency=excluded.frequency,first_period=excluded.first_period,due_month_offset=excluded.due_month_offset,due_day=excluded.due_day,remind_days=excluded.remind_days,requirements=excluded.requirements,version=work_period_rule.version+1`, [id, frequency, first, offset, day, remind, JSON.stringify(requirements)]);
    run("UPDATE workbench SET recurrence='once',schedule_due_date=NULL WHERE id=?",[id]);
    run('UPDATE work_period_rule SET steps=? WHERE workbench_id=?',[JSON.stringify(steps),id]);
    return get<PeriodRule>('SELECT * FROM work_period_rule WHERE workbench_id=?', [id])!;
}
export function syncPeriods(id: number, through = todayShanghai()): WorkPeriod[] {
    const wb=requireWorkbench(id);
    if(wb.status==='done'||wb.archived_at)return listPeriods(id);
    validDate(through);
    const rule = get<PeriodRule>('SELECT * FROM work_period_rule WHERE workbench_id=?', [id]);
    if (!rule)
        return [];
    const start = new Date(periodStart(rule.first_period, rule.frequency) + 'T00:00:00Z'), end = new Date(through + 'T00:00:00Z'), step = rule.frequency === 'monthly' ? 1 : rule.frequency === 'quarterly' ? 3 : 12;
    const templates = periodTemplates(id);
    return tx(() => {
        for (let n = 0; start <= end; n++, start.setUTCMonth(start.getUTCMonth() + step)) {
            if (n > 2400)
                throw new ApiError('TOO_MANY_PERIODS', '起始期次过早');
            const key = reportKey(start, rule.frequency), date = start.toISOString().slice(0, 10);
            const r = run('INSERT OR IGNORE INTO work_period(workbench_id,report_period,report_date,due_date,snapshot) VALUES(?,?,?,?,?)', [id, key, date, periodDue(date, rule.due_month_offset, rule.due_day), JSON.stringify({ ...rule, templates })]);
            if (r.changes) {
                run('UPDATE work_period SET steps=? WHERE id=?',[JSON.stringify(parsePeriodSteps(JSON.parse(rule.steps))),r.lastInsertRowid]);
                for (const title of JSON.parse(rule.requirements) as string[])
                    run('INSERT INTO period_material(period_id,title,requirement_kind) VALUES(?,?,?)', [r.lastInsertRowid, title,defaultMaterialKind(wb.work_type_id,title)]);
                event(r.lastInsertRowid, 'created', `规则版本 ${rule.version}`);
            }
        }
        recalcProgress(id);
        return listPeriods(id);
    });
}
export function listPeriods(id: number): WorkPeriod[] { return all<WorkPeriod>('SELECT * FROM work_period WHERE workbench_id=? ORDER BY report_date DESC', [id]); }
export function requirePeriod(id: number, workbenchId?: number | null): WorkPeriod {
    const p = get<WorkPeriod>('SELECT * FROM work_period WHERE id=?', [id]);
    if (!p || (workbenchId != null && p.workbench_id !== workbenchId))
        throw new ApiError('BAD_PERIOD', '期次不存在或不属于本工作', 404);
    requireWorkbench(p.workbench_id);
    return p;
}
export function event(id: number, action: string, detail: string) { run('INSERT INTO workflow_event(period_id,action,detail) VALUES(?,?,?)', [id, action, detail]); }
const builtinMaterialKinds:Record<string,Record<string,string>>={
 'integrity-monthly-inspection':{'监督检查记录':'generated','监督情况报送表册':'generated','实际报送与归档材料':'submission'},
 'integrity-system-check':{'八大体系自查表':'generated','核对与归档材料':'reference'},
 'integrity-risk':{'风险研判会议纪要':'generated','风险研判材料':'reference'},
 'integrity-study':{'廉洁学习记录':'generated','廉洁学习材料':'reference'},
 'integrity-project-review':{'项目研判考评会议纪要':'generated','项目研判考评材料':'reference'},
 'integrity-quarter-summary':{'人工核对与定稿材料':'generated'}
};
export function isSubmissionOnly(title:string){return /^(实际报送与归档材料|报送回执|报送凭证|报送证明|报送确认|报送记录)$/.test(title.trim());}
export function defaultMaterialKind(workTypeId:number,title:string){const code=get<{code:string}>('SELECT code FROM work_type WHERE id=?',[workTypeId])?.code??'';return builtinMaterialKinds[code]?.[title]??'external';}
export function periodReadiness(id:number){
 const p=requirePeriod(id),monthly=isMonthlyInspection(p),missing:string[]=[];
 try{assertPeriodTimesheet(id);}catch(e){missing.push((e as Error).message);}
 // Business records and valid outputs replace manually maintained step states.
 const materials=all<{id:number;title:string;required:number;status:string;artifact_id:number|null;requirement_kind:string}>('SELECT * FROM period_material WHERE period_id=?',[id]);
 const files=all<Artifact>('SELECT * FROM artifact WHERE work_period_id=? AND workbench_id=? AND deleted_at IS NULL',[id,p.workbench_id]);
 const validFinals=files.filter(a=>a.kind==='generated'||a.is_final).filter(materialArtifactCurrent);
 const templates=(JSON.parse(p.snapshot).templates??[]) as {id:number;name:string;required?:boolean;materialId?:number}[];
 const external=materials.filter(m=>m.requirement_kind==='external'&&!isSubmissionOnly(m.title)).map(m=>{
  const file=files.find(a=>a.id===m.artifact_id&&a.kind!=='generated');
  let exists=false;try{exists=!!file&&existsSync(artifactAbsPath(file));}catch{}
  const ready=m.status==='na'&&!!get<{note:string}>('SELECT note FROM period_material WHERE id=?',[m.id])?.note.trim()||m.status==='verified'&&exists;
  if(m.required&&!ready)missing.push(`${m.status==='verified'&&!exists?(m.artifact_id?'外部材料文件丢失':'外部材料缺少关联文件'):'外部材料待提供或确认'}：${m.title}`);
  return {...m,exists,ready,fileName:file?.file_name??null};
 });
 let inspections:ReturnType<typeof inspectionDocuments>|null=null;
 if(monthly){
  inspections=inspectionDocuments(p);
  if(!inspections.records.length&&!inspections.drafts.length)missing.push('请新建本月检查草稿');
  for(const d of inspections.drafts)if(!d.ready)missing.push(`草稿${d.id} ${d.project||'项目待定'}：待生成 ${d.missing.join('、')}`);
  for(const r of inspections.records)if(!r.ready)missing.push(`${r.project}（${r.inspection_date}）待生成：${r.missing.join('、')}`);
  missing.push(...inspections.aggregateMissing);
 }else{
  for(const t of templates.filter(t=>t.required!==false))if(!validFinals.some(a=>a.template_id===t.id))missing.push(`文书待生成：${t.name}`);
  if(materials.some(m=>m.required&&m.requirement_kind==='generated')&&!validFinals.some(a=>templates.some(t=>t.id===a.template_id)))missing.push('请使用适用模板生成文件（也可导入已有成果）');
 }
 return {monthly,missing,canComplete:!missing.length,external,finalCount:validFinals.length,recordCount:inspections?.records.length??0,draftCount:inspections?.drafts.length??0,recordDocumentsReady:!!inspections&&(inspections.records.length+inspections.drafts.length)>0&&inspections.records.every(r=>r.ready)&&inspections.drafts.every(d=>d.ready),validFinalIds:validFinals.map(a=>a.id),inspectionRevisions:inspections?.records.map(r=>({id:r.id,revision:r.revision,project:r.project,date:r.inspection_date}))??[],recordsReady:inspections?.ready??false,reported:inspections?.reported??false};
}
export function assertPeriodReady(id:number):void {const r=periodReadiness(id);if(r.missing.length)throw new ApiError('BUSINESS_INCOMPLETE',r.missing.join('；'),409,r.missing);}
export function updatePeriod(id: number, b: Record<string, unknown>) {
    const p = requirePeriod(id);
    if(requireWorkbench(p.workbench_id).archived_at)throw new ApiError('ARCHIVED','请先恢复归档工作',409);
    return tx(() => {
        if (p.status === 'done' && b.status === 'done' && Object.keys(b).length === 1){assertPeriodReady(id);return p;}
        if(['content','scheduled_date','source_period_ids'].some(k=>b[k]!==undefined&&b[k]!==p[k as keyof WorkPeriod]))invalidateLegacyDocumentSources(p.workbench_id,id);
        if (b.due_date !== undefined) {
            run('UPDATE work_period SET due_date=? WHERE id=?', [validDate(b.due_date), id]);
            event(id, 'deadline', String(b.due_date));
        }
        if (b.content !== undefined) {
            if (typeof b.content !== 'string' || b.content.length > 100000)
                throw new ApiError('BAD_CONTENT', '内容过长');
            run('UPDATE work_period SET content=? WHERE id=?', [b.content, id]);
            event(id, 'content', '更新本期事实');
        }
        if(b.reported_on!==undefined)throw new ApiError('REPORT_RETIRED','报送管理已取消，历史记录只读保留',409);
        if(b.steps!==undefined){const steps=parsePeriodSteps(b.steps);run('UPDATE work_period SET steps=? WHERE id=?',[JSON.stringify(steps),id]);event(id,'steps',JSON.stringify(steps));}
        if(b.scheduled_date!==undefined){const date=b.scheduled_date===null||b.scheduled_date===''?null:validDate(b.scheduled_date);run('UPDATE work_period SET scheduled_date=? WHERE id=?',[date,id]);event(id,'scheduled',date??'取消安排');}
        if(b.source_period_ids!==undefined){const ids=validateSourcePeriods(id,b.source_period_ids);run('UPDATE work_period SET source_period_ids=? WHERE id=?',[JSON.stringify(ids),id]);event(id,'sources',JSON.stringify(ids));}
        if (b.status !== undefined) {
            if (!['open', 'done'].includes(String(b.status)))
                throw new ApiError('BAD_STATUS', '状态无效');
            if (b.status === 'done') {
                assertPeriodReady(id);
            }
            run('UPDATE work_period SET status=?,completed_at=? WHERE id=?', [String(b.status), p.completed_at ?? (b.status === 'done' ? new Date().toISOString() : null), id]);
            if(b.status==='open')run("UPDATE workbench SET status='active' WHERE id=? AND status='done'",[p.workbench_id]);
            event(id, String(b.status), '用户确认办理状态');
        }
        recalcProgress(p.workbench_id);
        return requirePeriod(id);
    });
}

export function assertPeriodContext(workbenchId?: number | null, periodId?: number | null): void {
    if (workbenchId && !periodId && get('SELECT workbench_id FROM work_period_rule WHERE workbench_id=?', [workbenchId]))
        throw new ApiError('PERIOD_REQUIRED', '此工作已启用独立期次，请先选择报告期');
    if (periodId && !workbenchId) throw new ApiError('WORK_REQUIRED', '期次生成必须指定工作');
}

/** End the ongoing work explicitly; finishing a single period never ends its parent. */
export function closePeriodSeries(id:number) {
 requireWorkbench(id);
 if(!get('SELECT workbench_id FROM work_period_rule WHERE workbench_id=?',[id]))throw new ApiError('BAD_RULE','此工作没有独立期次');
 return tx(()=>{
  const periods=listPeriods(id);
  if(!periods.length)throw new ApiError('NO_PERIODS','尚无期次，请先配置首个报告期');
  for(const p of periods){if(p.status!=='done')throw new ApiError('PERIODS_OPEN',`尚有未完成期次：${p.report_period}`,409);assertPeriodReady(p.id);}
  if(get("SELECT id FROM quick_todo WHERE workbench_id=? AND status='open'",[id]))throw new ApiError('TASKS_OPEN','仍有未完成的办理事项',409);
  run("UPDATE workbench SET status='done',actual_end_date=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",[todayShanghai(),id]);
  recalcProgress(id);
  return requireWorkbench(id);
 });
}

/** Validate the business relation at every generation entry, independent of UI filters. */
export function assertGenerationScope(template:Template,workbenchId?:number|null,positionCode?:string|null) {
 if(!workbenchId)return;
 const w=requireWorkbench(workbenchId);
 if(template.archived_at || !templateSupportsWorkType(template,w.work_type_id))throw new ApiError('WRONG_TEMPLATE','模板不适用于当前工作类型，请先配置适用类型',409);
 if(positionCode && !get('SELECT id FROM position_instance WHERE workbench_id=? AND code=? AND deleted_at IS NULL',[w.id,positionCode]))throw new ApiError('BAD_STAGE','阶段不属于当前工作',409);
}
