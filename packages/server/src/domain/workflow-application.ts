import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { all, get, run, tx } from '../db/index.ts';
import { ApiError } from '../api/reply.ts';
import { assertNoPathLinks, workbenchRootAbs, toPosix } from '../core/paths.ts';
import { updateStoredProgress } from '../core/checklist.ts';
import { getWorkbench, getTemplate, positionDirAbs } from './service.ts';
import { periodStart, todayShanghai, templateFingerprint, type PeriodRule } from './periods.ts';
import type { WorkflowConfig, ConfigStage } from './workflow-config-types.ts';
const json = (v: unknown) => JSON.stringify(v);
const hash = (v: unknown) => createHash('sha256').update(json(v)).digest('hex');
const parse = (s: string | null | undefined, fallback: any = null) => s ? JSON.parse(s) : fallback;
type Stage = Record<string, any> & {
    id: number;
    seq: number;
    name: string;
    folder_name: string | null;
};
type Item = {
    key: string;
    label: string;
    allowed: boolean;
    reason: string;
    before: unknown;
    after: unknown;
};
function work(id: number) { const w = getWorkbench(id); if (!w)
    throw new ApiError('NOT_FOUND', '工作不存在', 404); return w; }
function workReason(w: ReturnType<typeof work>) { return w.deleted_at || w.archived_at || w.status === 'done' || w.status === 'archived' || w.historical ? '已删除、归档、完成或历史工作不接受配置应用' : ''; }
function folderState(w: ReturnType<typeof work>, p: any, newStage = false) { try {
    const path = positionDirAbs(w, p);
    assertNoPathLinks(path);
    if (existsSync(path) && (newStage || readdirSync(path).length))
        return '阶段目录已存在材料或无法证明为空，不能应用';
    return '';
}
catch {
    return '阶段目录不可安全核验，不能应用';
} }
/** Conservative scope guard shared with the existing document-requirement confirmation. */
export function stageApplicationReason(positionId: number): string {
    const p = get<Stage>('SELECT * FROM position_instance WHERE id=?', [positionId]);
    if (!p)
        return '阶段不存在';
    const w = work(p.workbench_id);
    const blocked = workReason(w);
    if (blocked)
        return blocked;
    if (p.deleted_at || p.status !== 'pending' || p.started_at || p.finished_at || p.owner || p.note || p.updated_at !== p.created_at)
        return '阶段已开始、删除或有业务操作，只能保留现有快照';
    const checks = all<Stage>('SELECT * FROM checklist_item WHERE position_instance_id=?', [positionId]);
    const base = stageBase(w, p);
    if (!base)
        return '旧阶段的原始清单规则未知，无法证明尚未操作';
    const expected = [...base.materials.map(m => ({ kind: 'material', title: m.name, detail: m.retention ?? m.hint ?? null, required: m.required, min_count: 1 })), ...base.evidences.map(e => ({ kind: 'evidence', title: e.title, detail: [e.shooting_points ? `要点：${e.shooting_points}` : '', e.angles ? `角度：${e.angles}` : '', e.hint ?? ''].filter(Boolean).join('；') || null, required: e.required, min_count: e.min_count }))];
    const shape = (c: any) => ({ kind: c.kind, title: c.title, detail: c.detail, required: c.required, min_count: c.min_count });
    if (json(checks.map(shape).map(json).sort()) !== json(expected.map(json).sort()))
        return '清单规则已在工作中调整，不能覆盖该阶段范围';
    if (checks.some(c => c.status !== 'todo' || c.done_count || c.done_at || c.done_by || c.note || c.review_status !== 'pending' || c.review_note || c.created_at !== c.updated_at))
        return '清单已有核对、调整或操作记录';
    if (get('SELECT id FROM artifact WHERE workbench_id=? AND (position_code=? OR position_code IS NULL OR checklist_item_id IN (SELECT id FROM checklist_item WHERE position_instance_id=?))', [w.id, p.code, positionId]))
        return '已有材料或成果引用（含回收站）';
    if (get('SELECT id FROM quick_todo WHERE workbench_id=? AND (position_id=? OR position_id IS NULL)', [w.id, positionId]))
        return '已有阶段待办或未明确阶段的工作待办';
    if (get('SELECT id FROM work_record WHERE workbench_id=?', [w.id]) || get('SELECT id FROM agent_memory WHERE workbench_id=?', [w.id]))
        return '工作已有记录或记忆，无法证明该阶段未被引用';
    if (get('SELECT id FROM generation_log WHERE workbench_id=?', [w.id]))
        return '工作已有生成记录，无法证明该阶段未被引用';
    return folderState(w, p);
}
function templateReason(s: ConfigStage) { for (const ref of [...s.documents.map(d => ({ id: d.templateId, digest: d.digest })), ...s.materials.filter(m => m.template_id).map(m => ({ id: m.template_id!, digest: m.templateDigest }))]) {
    const t = getTemplate(ref.id);
    if (!t || t.archived_at || !ref.digest || templateFingerprint(t) !== ref.digest)
        return '引用模板失效或内容已变化，请先重新发布配置';
} return ''; }
function stageBase(w: any, p: Stage): ConfigStage | undefined { return parse(p.config_snapshot) ?? parse(w.rules_snapshot)?.configuration?.stages?.find((s: ConfigStage) => s.code === p.code); }
function documentSnapshot(s: ConfigStage) { return s.documents.map(d => ({ ...d, name: getTemplate(d.templateId)?.name ?? String(d.templateId) })); }
function workState(id: number) { return { work: work(id), stages: all('SELECT * FROM position_instance WHERE workbench_id=? ORDER BY id', [id]), checks: all('SELECT c.* FROM checklist_item c JOIN position_instance p ON p.id=c.position_instance_id WHERE p.workbench_id=? ORDER BY c.id', [id]), artifacts: all('SELECT * FROM artifact WHERE workbench_id=? ORDER BY id', [id]), todos: all('SELECT * FROM quick_todo WHERE workbench_id=? ORDER BY id', [id]), records: all('SELECT * FROM work_record WHERE workbench_id=? ORDER BY id', [id]), memory: all('SELECT * FROM agent_memory WHERE workbench_id=? ORDER BY id', [id]), generation: all('SELECT * FROM generation_log WHERE workbench_id=? ORDER BY id', [id]), rule: get('SELECT * FROM work_period_rule WHERE workbench_id=?', [id]) ?? null, periods: all('SELECT * FROM work_period WHERE workbench_id=? ORDER BY id', [id]), materials: all('SELECT m.* FROM period_material m JOIN work_period p ON p.id=m.period_id WHERE p.workbench_id=? ORDER BY m.id',[id]), future: all('SELECT * FROM work_period_future_rule WHERE workbench_id=? ORDER BY effective_from', [id]) }; }
function publishedApplicationConfig(id: number, targetVersionId?: unknown) {
    const w = work(id), t = get<any>('SELECT * FROM work_type WHERE id=?', [w.work_type_id])!;
    const target = targetVersionId ?? t.published_config_id;
    const v = get<{
        id: number;
        work_type_id: number;
        version_no: number;
        payload: string;
        digest: string;
    }>('SELECT * FROM workflow_config_version WHERE id=?', [Number(target) || -1]);
    if (!v || v.work_type_id !== w.work_type_id || v.id !== t.published_config_id)
        throw new ApiError('STALE_CONFIG', '请选择当前已发布的同类型版本并重新预览', 409);
    const config: WorkflowConfig = parse(v.payload), snapshot = parse((w as any).rules_snapshot), baseType = snapshot?.configuration?.type ?? snapshot?.type;
    let common = workReason(w);
    if (!baseType)
        common ||= '旧工作的类型来源未知，无法证明执行语义兼容';
    else if ((['code', 'mode', 'executor', 'domain', 'category'] as const).some(k => baseType[k] !== config.type[k]))
        common ||= '类型执行语义发生变化，不能迁移在办工作';
    return { w, t, v, config, common };
}
/** Known-source legacy confirmation must use the same immutable target as configuration application. */
export function publishedPositionDocumentTarget(positionId: number) {
    const p = get<Stage>('SELECT * FROM position_instance WHERE id=?', [positionId]);
    if (!p) throw new ApiError('NOT_FOUND', '阶段不存在', 404);
    const w = work(p.workbench_id);
    // Do not assign a later publication as the provenance of genuine legacy instances.
    if (!w.source_config_version_id && !p.source_config_version_id) return null;
    const { v, config, common } = publishedApplicationConfig(w.id);
    const s = config.stages.find(s => s.code === p.code);
    return { targetVersionId: v.id, after: s ? documentSnapshot(s) : [],
        reason: common || (!s ? '目标发布版本不包含此阶段，不能删除既有要求' : templateReason(s)) };
}

/** Recheck live template assets immediately before committing database changes. */
function assertApplicationTemplates(id: number, targetVersionId: number, chosen: Item[]) {
    const { config, common } = publishedApplicationConfig(id, targetVersionId);
    if (common) throw new ApiError('UNSAFE_SCOPE', common, 409);
    for (const item of chosen) {
        let reason = '';
        if (item.key.startsWith('add:') || item.key.startsWith('documents:')) {
            const code = item.key.startsWith('add:') ? item.key.slice(4) : get<Stage>('SELECT * FROM position_instance WHERE id=?', [Number(item.key.split(':')[1])])?.code;
            const s = config.stages.find(s => s.code === code);
            reason = s ? templateReason(s) : '目标阶段已变化，请重新预览';
        } else if (item.key === 'future-rule') {
            for (const m of config.period?.materials ?? []) if (m.templateId) {
                const t = getTemplate(m.templateId);
                if (!t || t.archived_at || !m.templateDigest || templateFingerprint(t) !== m.templateDigest)
                    reason = '未来规则引用模板已失效或变化';
            }
        }
        if (reason) throw new ApiError('TEMPLATE_CHANGED', reason, 409);
    }
}
export function previewWorkflowApplication(id: number, b: Record<string, unknown> = {}) {
    const { w, t, v, config, common } = publishedApplicationConfig(id, b.targetVersionId);
    const stages = all<Stage>('SELECT * FROM position_instance WHERE workbench_id=? ORDER BY id', [id]), items: Item[] = [];
    const add = (key: string, label: string, before: unknown, after: unknown, reason = '') => items.push({ key, label, before, after, allowed: !(common || reason), reason: common || reason || '仅应用所选配置，不改变业务完成状态' });
    for (const s of config.stages) {
        const p = stages.find(p => p.code === s.code);
        if (!p) {
            const path = positionDirAbs(w, s);
            const collision = stages.some(p => positionDirAbs(w, p) === path) || config.stages.some(x => x.code !== s.code && positionDirAbs(w, x) === path);
            add('add:' + s.code, '新增待开始阶段：' + s.name, null, s, config.type.mode !== 'process' ? '当前工作不支持阶段' : collision ? '阶段目录与其他阶段冲突' : folderState(w, s, true) || templateReason(s));
            continue;
        }
        const base = stageBase(w, p), reason = stageApplicationReason(p.id);
        if (p.deleted_at) {
            add('trash:' + p.id, '阶段编码已在回收站：' + s.code, p.code, s.code, '不能复用已有或回收站阶段编码');
            continue;
        }
        const oldMeta = { name: p.name, description: p.description ?? base?.description ?? null, seq: p.seq }, newMeta = { name: s.name, description: s.description, seq: s.seq };
        if (json(oldMeta) !== json(newMeta))
            add('metadata:' + p.id, '阶段显示信息：' + p.name, oldMeta, newMeta, reason || (!base ? '旧阶段配置来源未知，无法证明目录规则未变' : base.folder_name !== s.folder_name || base.period_dir !== s.period_dir ? '新版目录规则不同，不能应用' : ''));
        if (base && (base.folder_name !== s.folder_name || base.period_dir !== s.period_dir))
            add('path:' + p.id, '目录规则：' + p.name, { folder: base.folder_name, period: base.period_dir }, { folder: s.folder_name, period: s.period_dir }, '不搬移已有目录或文件');
        const docs = documentSnapshot(s), oldDocs = parse(p.doc_requirements, []);
        const normalized = (a: any[]) => a.map(({ templateId, required, seq, digest }) => ({ templateId, required, seq, digest }));
        if (json(normalized(oldDocs)) !== json(normalized(docs)))
            add('documents:' + p.id, '阶段文书要求：' + p.name, oldDocs, docs, reason || (!base ? '旧阶段来源未知' : templateReason(s)));
        if (!base || json(base.materials) !== json(s.materials) || json(base.evidences) !== json(s.evidences))
            add('requirements:' + p.id, '既有阶段材料与影像要求：' + p.name, base ? { materials: base.materials, evidences: base.evidences } : '未知', { materials: s.materials, evidences: s.evidences }, '既有清单保留原快照，本入口不重写材料与影像要求');
    }
    for (const p of stages)
        if (!p.deleted_at && !config.stages.some(s => s.code === p.code))
            add('remove:' + p.id, '新版未包含阶段：' + p.name, p.code, null, '不能删除、合并或重编码已有阶段');
    const rule = get<PeriodRule>('SELECT * FROM work_period_rule WHERE workbench_id=?', [id]), boundary = typeof b.effectiveFrom === 'string' ? b.effectiveFrom : '';
    if (config.period || rule) {
        let reason = '';
        const period = config.period;
        if (!rule || !period)
            reason = '不能为已有工作新增或移除周期机制';
        else if (rule.frequency !== period.frequency)
            reason = '不能改变已有周期频率';
        else {
            try {
                const date = periodStart(boundary, rule.frequency), now = todayShanghai(), latest = get<{
                    date: string;
                }>('SELECT MAX(report_date) AS date FROM work_period WHERE workbench_id=?', [id])?.date, queued = get<{
                    date: string;
                }>('SELECT MAX(effective_from) AS date FROM work_period_future_rule WHERE workbench_id=?', [id])?.date;
                if (date <= now || latest && date <= latest || queued && date <= queued)
                    reason = '生效期须晚于今天、全部已有期次和已排定规则';
            }
            catch {
                reason = '请明确填写未来生效期（月 YYYY-MM / 季 YYYY-QN / 年 YYYY）';
            }
            for (const m of period.materials)
                if (m.templateId) {
                    const tt = getTemplate(m.templateId);
                    if (!tt || tt.archived_at || !m.templateDigest || templateFingerprint(tt) !== m.templateDigest)
                        reason = '未来规则引用模板已失效或变化';
                }
        }
        const queuedRule=get<{payload:string;effective_from:string}>('SELECT payload,effective_from FROM work_period_future_rule WHERE workbench_id=? ORDER BY effective_from DESC LIMIT 1',[id]);
        const effective:PeriodRule|null=queuedRule?parse(queuedRule.payload):rule??null;
        if(period&&effective){const normalized={frequency:effective.frequency,due_month_offset:effective.due_month_offset,due_day:effective.due_day,remind_days:effective.remind_days,steps:parse(effective.steps,[]),materials:parse(effective.material_rules,[])};if(json(normalized)===json(period))reason='已采用或已安排相同的周期规则，无需重复应用';}
        add('future-rule', '未来期次默认规则（不补期）', {effectiveFrom:queuedRule?.effective_from??null,rule:effective}, { effectiveFrom: boundary, period }, reason);
    }
    const state = workState(id);
    return { workbenchId: id, targetVersionId: v.id, versionNo: v.version_no, originalVersionId: w.source_config_version_id ?? null, effectiveFrom: boundary, items, digest: hash({ state, target: v.id, pointer: t.published_config_id, configDigest: v.digest, boundary, items }), history: applicationHistory(id) };
}
export function applicationHistory(id: number) { return all<{
    detail: string;
    created_at: string;
}>("SELECT detail,created_at FROM workflow_event WHERE action=? AND json_extract(detail,'$.workbenchId')=? ORDER BY id DESC", ['config-applied',id]).map(r => ({ ...parse(r.detail), createdAt: r.created_at })).filter(r => r.workbenchId === id).map(({ request, ...r }) => r); }
export function applyWorkflowApplication(id: number, b: Record<string, unknown>) {
    return tx(() => {
        if (typeof b.operationId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(b.operationId) || !Array.isArray(b.selected) || !b.selected.length || b.selected.some(k => typeof k !== 'string') || new Set(b.selected).size !== b.selected.length)
            throw new ApiError('BAD_APPLICATION', '请选择应用范围并提供有效操作编号');
        const selected = (b.selected as string[]).slice().sort(), request = hash({ id, target: b.targetVersionId, digest: b.previewDigest, effectiveFrom: b.effectiveFrom ?? '', selected });
        const previous = get<{
            action: string;
            detail: string;
        }>('SELECT action,detail FROM workflow_event WHERE operation_id=?', [b.operationId]);
        if (previous) {
            const event = parse(previous.detail);
            if (previous.action !== 'config-applied' || event.request !== request)
                throw new ApiError('OPERATION_CONFLICT', '操作编号已被其他请求使用', 409);
            return { ...event.result, replayed: true };
        }
        const preview = previewWorkflowApplication(id, b);
        if (b.previewDigest !== preview.digest)
            throw new ApiError('STALE_PREVIEW', '工作、配置或材料已变化，请保留选择并重新预览', 409);
        const chosen = selected.map(key => preview.items.find(i => i.key === key));
        if (chosen.some(i => !i || !i.allowed))
            throw new ApiError('UNSAFE_SCOPE', '所选范围不再适用，请重新预览', 409);
        const finalOrder = all<Stage>('SELECT * FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL', [id]).map(p => ({ code: p.code, seq: p.seq }));
        for (const item of chosen as Item[]) {
            if (item.key.startsWith('metadata:')) {
                const pid = Number(item.key.split(':')[1]), p = get<Stage>('SELECT * FROM position_instance WHERE id=?', [pid])!;
                finalOrder.find(x => x.code === p.code)!.seq = (item.after as any).seq;
            }
            else if (item.key.startsWith('add:')) {
                const s = item.after as ConfigStage;
                finalOrder.push({ code: s.code, seq: s.seq });
            }
        }
        if (new Set(finalOrder.map(x => x.seq)).size !== finalOrder.length)
            throw new ApiError('SCOPE_ORDER_CONFLICT', '所选范围会造成阶段顺序重复，请同时选择相关安全阶段或先调整配置后重新预览', 409);
        const w = work(id), version = get<{
            payload: string;
        }>('SELECT payload FROM workflow_config_version WHERE id=?', [preview.targetVersionId])!, config: WorkflowConfig = parse(version.payload);
        for (const item of chosen as Item[]) {
            const split = item.key.indexOf(':'), kind = split < 0 ? item.key : item.key.slice(0, split), key = item.key.slice(split + 1);
            if (kind === 'add') {
                const s = config.stages.find(s => s.code === key)!;
                const projection = get<{
                    id: number;
                }>('SELECT id FROM position_template WHERE work_type_id=? AND code=?', [w.work_type_id, s.code]);
                const pid = run('INSERT INTO position_instance(workbench_id,position_template_id,code,name,seq,status,folder_rel,sort_order,folder_name,period_dir,doc_requirements,source_config_version_id,config_snapshot,description) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, projection?.id ?? null, s.code, s.name, s.seq, 'pending', toPosix(relative(workbenchRootAbs(w), positionDirAbs(w, s))), s.seq * 10, s.folder_name, s.period_dir, json(documentSnapshot(s)), preview.targetVersionId, json(s), s.description]).lastInsertRowid;
                for (const [i, m] of s.materials.entries())
                    run('INSERT INTO checklist_item(position_instance_id,kind,title,detail,required,min_count,sort_order,config_key,rule_snapshot) VALUES(?,?,?,?,?,?,?,?,?)', [pid, 'material', m.name, m.retention ?? m.hint, m.required, 1, (i + 1) * 10, m.key, json(m)]);
                for (const [i, e] of s.evidences.entries())
                    run('INSERT INTO checklist_item(position_instance_id,kind,title,detail,required,min_count,sort_order,config_key,rule_snapshot) VALUES(?,?,?,?,?,?,?,?,?)', [pid, 'evidence', e.title, [e.shooting_points ? `要点：${e.shooting_points}` : '', e.angles ? `角度：${e.angles}` : '', e.hint ?? ''].filter(Boolean).join('；') || null, e.required, e.min_count, (i + 1) * 10, e.key, json(e)]);
            }
            else if (kind === 'metadata') {
                const p = get<Stage>('SELECT * FROM position_instance WHERE id=?', [Number(key)])!, after = item.after as any;
                run('UPDATE position_instance SET name=?,description=?,seq=?,sort_order=?,folder_name=? WHERE id=?', [after.name, after.description, after.seq, after.seq * 10, p.folder_name ?? basename(positionDirAbs(w, p)), p.id]);
            }
            else if (kind === 'documents')
                run('UPDATE position_instance SET doc_requirements=? WHERE id=?', [json(item.after), Number(key)]);
            else if (kind === 'future-rule') {
                const old = get<PeriodRule>('SELECT * FROM work_period_rule WHERE workbench_id=?', [id])!, p = config.period!;
                const payload = { ...old, ...p, requirements: json(p.materials.map(m => m.title)), steps: json(p.steps), material_rules: json(p.materials), source_config_version_id: preview.targetVersionId, version: old.version + all('SELECT id FROM work_period_future_rule WHERE workbench_id=?', [id]).length + 1 };
                run('INSERT INTO work_period_future_rule(workbench_id,effective_from,source_config_version_id,payload,operation_id) VALUES(?,?,?,?,?)', [id, periodStart(preview.effectiveFrom, p.frequency), preview.targetVersionId, json(payload), b.operationId]);
            }
        }
        updateStoredProgress(id);
        const result = { workbenchId: id, targetVersionId: preview.targetVersionId, applied: selected, originalVersionId: w.source_config_version_id ?? null, partial: true };
        run("INSERT INTO workflow_event(action,detail,operation_id) VALUES('config-applied',?,?)", [json({ request, workbenchId: id, sourceVersionId: w.source_config_version_id ?? null, targetVersionId: preview.targetVersionId, scope: chosen, result }), b.operationId]);
        assertApplicationTemplates(id, preview.targetVersionId, chosen as Item[]);
        return result;
    });
}
