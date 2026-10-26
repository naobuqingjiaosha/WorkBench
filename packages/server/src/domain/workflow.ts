import { evidenceCount, checklistSatisfied } from '../core/checklist.ts';
import { recalcProgress, listWorkbenchPositionDocs, listTodayTodos } from './service.ts';
import { existsSync } from 'node:fs';
import { all, get, run } from '../db/index.ts';
import { ApiError } from '../api/reply.ts';
import { artifactAbsPath, type Artifact } from '../core/store.ts';
import { requireWorkbench, todayShanghai,periodReadiness } from './periods.ts';
export function listWorkflowInbox() {
    const today = todayShanghai();
    const periods = all<{
        id: number;
        workbench_id: number;
        report_period: string;
        due_date: string;
        snapshot: string;
        name: string;
    }>("SELECT p.*,w.name FROM work_period p JOIN workbench w ON w.id=p.workbench_id WHERE p.status='open' AND w.deleted_at IS NULL AND w.archived_at IS NULL AND w.status<>'done' ORDER BY p.due_date,p.id").map(p => {
        const readiness=periodReadiness(p.id);
        return {...p,overdue:p.due_date<today,missing:readiness.missing,canComplete:readiness.canComplete,
            nextAction:readiness.canComplete?'文件已生成，可下载或继续编辑':readiness.monthly?
                !readiness.recordCount&&!readiness.draftCount?'新增检查记录':!readiness.recordsReady?'编辑草稿／生成检查文件':'核对必要附件':readiness.missing[0]};
    });
    // 独立期次只使用 periodReadiness；旧排期投影不能再次计算同一工作的待办。
    const periodic=new Set(all<{workbench_id:number}>('SELECT DISTINCT workbench_id FROM work_period').map(p=>p.workbench_id));
    const other=listTodayTodos({limit:1000});
    return { today, other:other.items.filter(item=>!periodic.has(item.workbenchId)), otherTruncated:other.truncated,
        periods, todos: all("SELECT q.* FROM quick_todo q LEFT JOIN workbench w ON w.id=q.workbench_id WHERE q.status='open' AND (q.workbench_id IS NULL OR (w.id IS NOT NULL AND w.deleted_at IS NULL AND w.archived_at IS NULL)) ORDER BY q.due_date IS NULL,q.due_date,q.id"), timesheets: all("SELECT t.id,t.month,t.status,t.workbench_id,t.period_id,json_array_length(json_extract(t.result,'$.issues')) AS exceptions FROM timesheet_run t LEFT JOIN workbench w ON w.id=t.workbench_id WHERE t.status='draft' AND (t.workbench_id IS NULL OR (w.deleted_at IS NULL AND w.archived_at IS NULL AND w.status<>'done')) AND t.period_id IS NULL AND t.id IN (SELECT MAX(id) FROM timesheet_run GROUP BY workbench_id,period_id,month) ORDER BY t.id DESC") };
}
export function projectReadiness(id: number) {
    requireWorkbench(id);
    const items = all<{
        id: number;
        title: string;
        required: number;
        review_status: string;
        review_note: string;
        status: string;
        min_count: number;
        kind: string;
        position_name: string;
        position_id: number;
        stage_status:string;
        stage_note:string|null;
    }>(`SELECT c.*,p.name AS position_name,p.id AS position_id,p.status AS stage_status,p.note AS stage_note FROM checklist_item c JOIN position_instance p ON p.id=c.position_instance_id WHERE p.workbench_id=? AND p.deleted_at IS NULL ORDER BY p.seq,c.sort_order,c.id`, [id]);
    const files = all<Artifact>('SELECT * FROM artifact WHERE workbench_id=? AND deleted_at IS NULL', [id]);
    const reviewed = items.map(i => ({ ...i, files: files.filter(f => f.checklist_item_id === i.id).map(f => ({ id: f.id, file_name: f.file_name, exists: (() => { try { return existsSync(artifactAbsPath(f)); } catch { return false; } })() })) }));
    const documents = listWorkbenchPositionDocs(id).items;
    return {items:reviewed, documents, missing:reviewed.filter(i=>i.required && !(i.stage_status==='skipped'&&i.stage_note?.trim()) && !checklistSatisfied(i,id)).length};
}
export function reviewProjectMaterial(id: number, b: Record<string, unknown>) {
    const item = get<{
        id: number;
        position_instance_id: number;
        kind: string;
        min_count: number;
    }>('SELECT * FROM checklist_item WHERE id=?', [id]);
    if (!item)
        throw new ApiError('NOT_FOUND', '清单项不存在', 404);
    const pos = get<{
        workbench_id: number;
        deleted_at: string | null;
    }>('SELECT workbench_id,deleted_at FROM position_instance WHERE id=?', [item.position_instance_id]);
    if (!pos || pos.deleted_at)
        throw new ApiError('NOT_FOUND', '阶段已删除', 404);
    requireWorkbench(pos.workbench_id);
    const status = String(b.status), note = String(b.note ?? '');
    if (!['pending', 'verified', 'na'].includes(status))
        throw new ApiError('BAD_STATUS', '请选择核对状态');
    if (status === 'na' && !note.trim())
        throw new ApiError('REASON_REQUIRED', '不适用必须记录原因');
    if (status === 'verified') {
        const files = all<Artifact>('SELECT * FROM artifact WHERE checklist_item_id=? AND workbench_id=? AND deleted_at IS NULL', [id, pos.workbench_id]);
        const count = item.kind==='evidence'?evidenceCount(id):files.filter(a => { try {
            return existsSync(artifactAbsPath(a));
        }
        catch {
            return false;
        } }).length;
        if (count < Math.max(1, item.min_count))
            throw new ApiError('MISSING_FILES', '材料数量不足或关联文件已丢失，不能确认符合要求');
    }
    run('UPDATE checklist_item SET review_status=?,review_note=?,status=? WHERE id=?', [status, note, status === 'verified' ? 'done' : status === 'na' ? 'na' : 'doing', id]);
    recalcProgress(pos.workbench_id);
}
