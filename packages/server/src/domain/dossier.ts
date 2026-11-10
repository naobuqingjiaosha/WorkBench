import { all } from '../db/index.ts';
import { assertPeriodReady } from './periods.ts';
import { assertFinalArtifact } from './finalization.ts';
import { getWorkbenchLive, getWorkType, getTemplate, requiredWorkbenchTemplates, listWorkbenchPositionDocs, type WorkbenchPositionDoc } from './service.ts';
import { checklistSatisfied } from '../core/checklist.ts';
import { ApiError } from '../api/reply.ts';
import type { Artifact } from '../core/store.ts';

type Gap = { code: string; message: string };
type Stage = { id: number; name: string; status: string; note: string | null };
type RequiredItem = { id: number; kind: string; min_count: number; title: string; review_status: string; review_note: string };

export function stageMaterialGaps(workId: number, stage: Stage, docs: WorkbenchPositionDoc | undefined): Gap[] {
  const gaps: Gap[] = [];
  for (const doc of docs?.items ?? []) {
    if (doc.required && !doc.finalized) gaps.push({code: 'FINAL_MISSING', message: stage.name + ' · 必备文书未有效定稿：' + doc.name});
  }
  const items = all<RequiredItem>('SELECT * FROM checklist_item WHERE position_instance_id=? AND required=1 ORDER BY sort_order,id', [stage.id]);
  for (const item of items) {
    if (!checklistSatisfied(item, workId)) gaps.push({code: 'MATERIAL_MISSING', message: stage.name + ' · ' + item.title + '：待提供或核对'});
  }
  return gaps;
}

/** Use the same evidence for the user's gap list and the completion/archive gate. */
export function inspectDossier(id: number) {
  const work = getWorkbenchLive(id);
  if (!work) throw new ApiError('NOT_FOUND', '工作不存在', 404);
  const gaps: Gap[] = [];
  const stages = all<Stage>('SELECT * FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL ORDER BY seq,sort_order,id', [id]);
  const documents = new Map(listWorkbenchPositionDocs(id).items.map(d => [d.positionId, d]));
  for (const stage of stages) {
    if (stage.status === 'skipped' && stage.note?.trim()) continue;
    if (stage.status !== 'done' && !work.historical) gaps.push({code: 'STAGES_OPEN', message: '阶段未结束：' + stage.name});
    gaps.push(...stageMaterialGaps(id, stage, documents.get(stage.id)));
  }

  const periodic = all('SELECT workbench_id FROM work_period_rule WHERE workbench_id=?', [id]).length > 0;
  if (!periodic) {
    for (const templateId of requiredWorkbenchTemplates(work)) {
      const name = getTemplate(templateId)?.name ?? `模板 #${templateId}（找不到原模板）`;
      const files = all<Artifact>('SELECT * FROM artifact WHERE workbench_id=? AND template_id=? AND position_code IS NULL AND is_final=1 AND deleted_at IS NULL', [id, templateId]);
      if (!files.some(a => { try { assertFinalArtifact(a); return true; } catch { return false; } })) {
        gaps.push({code: 'FINAL_MISSING', message: '工作级必备文书未有效定稿：' + name});
      }
    }
  }
  for (const t of all<{title:string}>("SELECT title FROM quick_todo WHERE workbench_id=? AND status='open' ORDER BY id", [id])) {
    gaps.push({code: 'TASKS_OPEN', message: '待办未结束：' + t.title});
  }
  for (const p of all<{id:number;status:string;report_period:string}>('SELECT id,status,report_period FROM work_period WHERE workbench_id=? ORDER BY report_period', [id])) {
    if (p.status !== 'done') gaps.push({code: 'PERIODS_OPEN', message: '期次未完成：' + p.report_period});
    else try { assertPeriodReady(p.id); } catch (e) { gaps.push({code: 'PERIOD_NOT_READY', message: p.report_period + '：' + (e as Error).message}); }
  }
  return {work, periodic, gaps};
}

export function dossierReadiness(id: number) {
  const {work, gaps} = inspectDossier(id);
  const businessDone = work.status === 'done' || (work.status === 'archived' && work.archive_status === 'done');
  return {businessStatus: businessDone ? 'completed' : 'active', dossierStatus: gaps.length ? 'collecting' : 'ready',
    historical: Boolean(work.historical), missing: gaps.map(g => g.message), canArchive: businessDone && !gaps.length, domain: getWorkType(work.work_type_id)?.domain};
}
