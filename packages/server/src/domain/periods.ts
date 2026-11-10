import type {ConfigPeriodMaterial} from './workflow-config-types.ts';
import {isMonthlyInspection,inspectionDocuments,listInspections,inspectionText,inspectionCollectionFields} from './inspections.ts';
import {invalidateLegacyDocumentSources,materialArtifactCurrent} from './document-source.ts';
import { assertPeriodTimesheet } from './timesheets.ts';
import { recalcProgress } from './service.ts';
import { assertFinalArtifact } from './finalization.ts';
import { all, get, run, tx } from '../db/index.ts';
import { assertInstanceTemplate, getTemplate, getWorkbench, listTemplatesForWorkbench, templateAbsPath, varsAbsPath, templateGenerationScope,templateSupportsWorkType,type Template } from './service.ts';
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
    material_rules: string | null;
    source_config_version_id: number | null;
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
    let quarterFields:Record<string,string>={};
    if(/^\d{4}-Q[1-4]$/.test(p.report_period)){
        const ids=validateSourcePeriods(p.id,JSON.parse(p.source_period_ids));
        const sources=ids.map(id=>requirePeriod(id));
        const records=sources.flatMap(source=>listInspections(source.id).map(row=>
            `${source.report_period} · ${requireWorkbench(source.workbench_id).name} · 检查 #${row.id} 修订 ${row.revision}\n${inspectionText(row)}`));
        quarterFields={
            '季度参考范围':sources.map(source=>`${requireWorkbench(source.workbench_id).name} · ${source.report_period}（期次 #${source.id}）`).join('\n'),
            '范围内已确认检查':records.join('\n\n'),
            '范围内已确认检查次数':ids.length?String(records.length):'',
        };
    }
    return { ...quarterFields,...inspectionCollectionFields(p),'内容':content,'业务内容':content,'本期内容':content, '报告期': p.report_period, '报告月份': `${year}-${month}`, '年份':year,'本季度':quarter,'下季度':String(Number(quarter)%4+1),'下季度年份':String(Number(year)+(quarter==='4'?1:0)), '_年份': year, '_月份': month, '_本月': `${year}年${Number(month)}月` };
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
export type PeriodResultTarget = {id:number;config_key:string;title:string;required:number;artifact_id:number|null;status:string;period_id:number};
/** Resolve only explicit stable keys from the saved rule; never guess by title. */
export function periodResultRules(p:WorkPeriod):ConfigPeriodMaterial[]{
 const raw=JSON.parse(p.snapshot).material_rules;
 return (typeof raw==='string'?JSON.parse(raw):raw??[]) as ConfigPeriodMaterial[];
}
export function periodResultTargets(p:WorkPeriod,templateId:number):PeriodResultTarget[]{
 const rules=periodResultRules(p).filter(m=>m.kind==='generated'&&m.templateId===templateId);
 return rules.map(rule=>{const m=get<PeriodResultTarget>("SELECT * FROM period_material WHERE period_id=? AND config_key=? AND requirement_kind='generated'",[p.id,rule.key]);if(!m)throw new ApiError('MATERIAL_MAPPING','本期材料身份缺失，请核对配置；未自动补写历史快照',409);return m;});
}
export function resolvePeriodResultTarget(p:WorkPeriod,templateId:number,materialId?:number|null){
 const targets=periodResultTargets(p,templateId);
 if(materialId!=null){const target=targets.find(m=>m.id===materialId);if(!target)throw new ApiError('WRONG_MATERIAL','请选择当前期次、当前模板对应的成果要求',409);return target;}
 if(targets.length>1)throw new ApiError('MATERIAL_REQUIRED','此模板对应多项成果要求，请明确选择本次生成对应的材料',409);
 return targets[0];
}
export function periodResultHead(p:WorkPeriod,templateId:number,target:PeriodResultTarget){
 return target.artifact_id?get<import('./versions.ts').VersionedArtifact>("SELECT * FROM artifact WHERE id=? AND workbench_id=? AND work_period_id=? AND template_id=? AND kind='generated' AND deleted_at IS NULL",[target.artifact_id,p.workbench_id,p.id,templateId])??null:null;
}
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
 return tx(()=>{
    const wb=requireWorkbench(id);
    if(get('SELECT id FROM work_period_future_rule WHERE workbench_id=?',[id]))throw new ApiError('FUTURE_RULE_SCHEDULED','已有明确生效的未来规则，请通过配置差异入口安排后续规则，不能覆盖原规则',409);
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
    // A plain legacy rule edit does not silently retain mappings for renamed requirements.
    const materialRules=b.material_rules;
    if(materialRules!==undefined && (!Array.isArray(materialRules)||materialRules.length!==requirements.length||materialRules.some((m:any,i:number)=>!m||typeof m.key!=='string'||m.title!==requirements[i]||!['external','reference','generated','legacy'].includes(m.kind)||typeof m.required!=='boolean'||m.templateId!==null&&!Number.isSafeInteger(m.templateId))))throw new ApiError('BAD_RULE','材料用途配置与材料列表不一致');
    if(materialRules===undefined && old?.material_rules && JSON.stringify(requirements)!==old.requirements)throw new ApiError('CONFIG_MATERIALS','此工作有明确材料用途，请保留材料标题；对在办要求的新版应用将在独立入口办理',409);
    if(old)run('UPDATE work_period_rule SET source_config_version_id=NULL WHERE workbench_id=?',[id]);
    run('UPDATE work_period_rule SET steps=?,material_rules=? WHERE workbench_id=?',[JSON.stringify(steps),materialRules===undefined?old?.material_rules??null:JSON.stringify(materialRules),id]);
    return get<PeriodRule>('SELECT * FROM work_period_rule WHERE workbench_id=?', [id])!;
 });
}
function getTemplateForRule(id:number){const t=getTemplate(id);if(!t||t.archived_at)throw new ApiError('BAD_TEMPLATE','已配置的成果模板失效，请核对配置',409);return t;}
export function syncPeriods(id: number, through = todayShanghai()): WorkPeriod[] {
    const wb=requireWorkbench(id);
    if(wb.status==='done'||wb.archived_at)return listPeriods(id);
    validDate(through);
    const rule = get<PeriodRule>('SELECT * FROM work_period_rule WHERE workbench_id=?', [id]);
    if (!rule)
        return [];
    const start = new Date(periodStart(rule.first_period, rule.frequency) + 'T00:00:00Z'), end = new Date(through + 'T00:00:00Z'), step = rule.frequency === 'monthly' ? 1 : rule.frequency === 'quarterly' ? 3 : 12;
    const baseTemplates = periodTemplates(id);
    const scheduled=all<{effective_from:string;payload:string}>('SELECT effective_from,payload FROM work_period_future_rule WHERE workbench_id=? ORDER BY effective_from',[id]);
    return tx(() => {
        for (let n = 0; start <= end; n++, start.setUTCMonth(start.getUTCMonth() + step)) {
            if (n > 2400)
                throw new ApiError('TOO_MANY_PERIODS', '起始期次过早');
            const key = reportKey(start, rule.frequency), date = start.toISOString().slice(0, 10);
            if(get('SELECT id FROM work_period WHERE workbench_id=? AND report_period=?',[id,key]))continue;
            const future=scheduled.filter(r=>r.effective_from<=date).at(-1);
            const effective:PeriodRule=future?JSON.parse(future.payload):rule;
            if(!future&&wb.source_config_version_id)for(const t of listTemplatesForWorkbench(id))assertInstanceTemplate(id,null,t);
            const materialRules:ConfigPeriodMaterial[]|null=effective.material_rules?JSON.parse(effective.material_rules):null;
            const templates: (ReturnType<typeof periodTemplates>[number]&{materialId?:number;materialBindings?:{materialId:number;key:string;title:string;required:boolean}[]})[] = future?[]:[...baseTemplates];
            const r = run('INSERT OR IGNORE INTO work_period(workbench_id,report_period,report_date,due_date,snapshot) VALUES(?,?,?,?,?)', [id, key, date, periodDue(date, effective.due_month_offset, effective.due_day), JSON.stringify({ ...effective, templates })]);
            if (r.changes) {
                run('UPDATE work_period SET steps=? WHERE id=?',[JSON.stringify(parsePeriodSteps(JSON.parse(effective.steps))),r.lastInsertRowid]);
                for (const [i,title] of (JSON.parse(effective.requirements) as string[]).entries()) {
                    const m=materialRules?.[i];
                    const mid=run('INSERT INTO period_material(period_id,title,requirement_kind,required,config_key) VALUES(?,?,?,?,?)', [r.lastInsertRowid,title,m&&m.kind!=='legacy'?m.kind:defaultMaterialKind(wb.work_type_id,title),m?.required===false?0:1,m?.key??null]).lastInsertRowid;
                    if(m?.kind==='generated'&&m.templateId){
                      const t=getTemplateForRule(m.templateId);if(m.templateDigest&&m.templateDigest!==templateFingerprint(t))throw new ApiError('TEMPLATE_CHANGED','未来期次引用的模板已变化，请先核对本工作的模板规则',409);const mapped={id:t.id,name:t.name,required:m.required,file_rel:t.file_rel,digest:templateFingerprint(t),generation_scope:templateGenerationScope(t),materialId:mid};
                      const index=templates.findIndex(t=>t.id===mapped.id), prior=index<0?undefined:templates[index];
                      const materialBindings=[...(prior?.materialBindings??[]),{materialId:mid,key:m.key,title,required:m.required}];
                      const combined={...mapped,required:materialBindings.some(x=>x.required),materialBindings,materialId:materialBindings.length===1?mid:undefined};
                      if(index<0)templates.push(combined);else templates[index]=combined;
                    }
                }
                run('UPDATE work_period SET snapshot=? WHERE id=?',[JSON.stringify({...effective,templates}),r.lastInsertRowid]);
                event(r.lastInsertRowid, 'created', `规则版本 ${effective.version}`);
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
  const rules=periodResultRules(p).filter(m=>m.kind==='generated'), explicitKeys=new Set(rules.map(m=>m.key)), explicitTemplateIds=new Set(rules.map(m=>m.templateId));
  for(const rule of rules.filter(m=>m.required)){const material=get<{artifact_id:number|null;status:string}>("SELECT artifact_id,status FROM period_material WHERE period_id=? AND config_key=? AND requirement_kind='generated'",[p.id,rule.key]);if(!material||!['provided','verified'].includes(material.status)||!validFinals.some(a=>a.id===material.artifact_id&&(rule.templateId===null||a.template_id===rule.templateId)))missing.push(`成果要求待提供有效文件：${rule.title}`);}
  for(const t of templates.filter(t=>t.required!==false&&!explicitTemplateIds.has(t.id)))if(!validFinals.some(a=>a.template_id===t.id))missing.push(`文书待生成：${t.name}`);
  if(materials.some(m=>m.required&&m.requirement_kind==='generated'&&!explicitKeys.has(get<{config_key:string|null}>('SELECT config_key FROM period_material WHERE id=?',[m.id])?.config_key??''))&&!validFinals.some(a=>templates.some(t=>t.id===a.template_id)))missing.push('请使用适用模板生成文件（也可导入已有成果）');
 }
 return {monthly,missing,canComplete:!missing.length,external,finalCount:validFinals.length,recordCount:inspections?.records.length??0,draftCount:inspections?.drafts.length??0,recordDocumentsReady:!!inspections&&(inspections.records.length+inspections.drafts.length)>0&&inspections.records.every(r=>r.ready)&&inspections.drafts.every(d=>d.ready),validFinalIds:validFinals.map(a=>a.id),inspectionRevisions:inspections?.records.map(r=>({id:r.id,revision:r.revision,project:r.project,date:r.inspection_date}))??[],recordsReady:inspections?.ready??false,reported:inspections?.reported??false};
}
export function assertPeriodReady(id:number):void {const r=periodReadiness(id);if(r.missing.length)throw new ApiError('BUSINESS_INCOMPLETE',r.missing.join('；'),409,r.missing);}
export function updatePeriod(id: number, b: Record<string, unknown>) {
    const p = requirePeriod(id);
    if(requireWorkbench(p.workbench_id).archived_at)throw new ApiError('ARCHIVED','请先恢复归档工作',409);
    return tx(() => {
        if (p.status === 'done' && b.status === 'done' && Object.keys(b).length === 1){assertPeriodReady(id);return p;}
        const sourceIds=b.source_period_ids===undefined?undefined:validateSourcePeriods(id,b.source_period_ids);
        if(b.expected!==undefined){
            if(!b.expected||typeof b.expected!=='object'||Array.isArray(b.expected))throw new ApiError('BAD_EXPECTED','原期次字段格式无效');
            for(const [field,value] of Object.entries(b.expected)){
                if(!['content','scheduled_date','source_period_ids'].includes(field))throw new ApiError('BAD_EXPECTED','未知期次字段');
                const requested=field==='source_period_ids'&&sourceIds?JSON.stringify(sourceIds):b[field];
                if(p[field as keyof WorkPeriod]!==value&&p[field as keyof WorkPeriod]!==requested)throw new ApiError('PERIOD_CHANGED','其他入口已修改本期内容或安排。当前输入保留，请核对最新记录后再保存',409,{field,current:p[field as keyof WorkPeriod],arrangement:{scheduled_date:p.scheduled_date,source_period_ids:p.source_period_ids}});
            }
        }
        if(b.content!==undefined&&b.content!==p.content||b.scheduled_date!==undefined&&(b.scheduled_date||null)!==p.scheduled_date||sourceIds&&JSON.stringify(sourceIds)!==p.source_period_ids)invalidateLegacyDocumentSources(p.workbench_id,id);
        if (b.due_date !== undefined) {
            run('UPDATE work_period SET due_date=? WHERE id=?', [validDate(b.due_date), id]);
            event(id, 'deadline', String(b.due_date));
        }
        if (b.content !== undefined && b.content!==p.content) {
            if (typeof b.content !== 'string' || b.content.length > 100000)
                throw new ApiError('BAD_CONTENT', '内容过长');
            run('UPDATE work_period SET content=? WHERE id=?', [b.content, id]);
            event(id, 'content', '更新本期事实');
        }
        if(b.reported_on!==undefined)throw new ApiError('REPORT_RETIRED','报送管理已取消，历史记录只读保留',409);
        if(b.steps!==undefined){const steps=parsePeriodSteps(b.steps);run('UPDATE work_period SET steps=? WHERE id=?',[JSON.stringify(steps),id]);event(id,'steps',JSON.stringify(steps));}
        if(b.scheduled_date!==undefined){const date=b.scheduled_date===null||b.scheduled_date===''?null:validDate(b.scheduled_date);run('UPDATE work_period SET scheduled_date=? WHERE id=?',[date,id]);event(id,'scheduled',date??'取消安排');}
        if(sourceIds && JSON.stringify(sourceIds)!==p.source_period_ids){run('UPDATE work_period SET source_period_ids=? WHERE id=?',[JSON.stringify(sourceIds),id]);event(id,'sources',JSON.stringify(sourceIds));}
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
export function assertGenerationScope(template:Template,workbenchId?:number|null,positionCode?:string|null,periodId?:number|null) {
 if(!workbenchId)return;
 const w=requireWorkbench(workbenchId);
 if(w.source_config_version_id){if(template.archived_at)throw new ApiError('TEMPLATE_ARCHIVED','模板已归档，请核对当前范围选择',409);if(periodId)assertPeriodTemplate(requirePeriod(periodId,w.id),template);else assertInstanceTemplate(w.id,positionCode,template);}
 if(!w.source_config_version_id && (template.archived_at || !templateSupportsWorkType(template,w.work_type_id)))throw new ApiError('WRONG_TEMPLATE','模板不适用于当前工作类型，请先配置适用类型',409);
 if(positionCode && !get('SELECT id FROM position_instance WHERE workbench_id=? AND code=? AND deleted_at IS NULL',[w.id,positionCode]))throw new ApiError('BAD_STAGE','阶段不属于当前工作',409);
}
