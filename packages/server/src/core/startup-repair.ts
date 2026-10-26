import {all,get,run,tx} from '../db/index.ts';
import {computeSchedule,type ScheduleSpec} from '../domain/schedule.ts';
import {syncEvidence} from './checklist.ts';
import {liveFilter,markDeleted,tableHasDeletedAt} from './trash.ts';
export function repairStoredState():void {
 tx(()=>{
  /**
   * 启动自检只修**在用**的工作台（`liveFilter('workbench')` → deleted_at IS NULL；老库还没跑 015、
   * 没有这一列时自动降级成 1=1，不会报 no such column）。
   *
   * 为什么这处必须过滤：下面每轮都对 w.id 调 `syncEvidence()` 重算进度，而它只统计"在用"的行
   * （checklist.ts 里的 `p.deleted_at IS NULL`）—— 回收站里的工作台，它的阶段在软删除时全被打了标记，
   * 于是重算得到 total=0、progress=0，**每次启动都把回收站里那份工作台的进度刷成 0**，
   * 而恢复路径不重算进度（只有 `POST /api/workbenches/:id/recalc` 会），用户恢复回来看到的是进度归零的工作台。
   * 回收站里的行不参与业务，等恢复之后的下一轮启动再照常自检。
   */
  const rows=all<{id:number;profile:string|null;recurrence:string;recur_day:number|null;recur_month:number|null;last_done_at:string|null;schedule_due_date:string|null}>(`SELECT * FROM workbench WHERE ${liveFilter('workbench')}`);
  for(const w of rows){
   if(w.recurrence!=='once' && !w.schedule_due_date){const due=computeSchedule({...w,recurrence:w.recurrence as ScheduleSpec['recurrence']}).nextDue;run('UPDATE workbench SET schedule_due_date=? WHERE id=?',[due,w.id]);}
   if(w.profile){try{const profile=JSON.parse(w.profile) as Record<string,unknown>;let raw=profile.templateIds;
    if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch{raw=String(raw).split(/[,，]/).map(Number);}}
    const ids=(Array.isArray(raw)?raw:typeof raw==='number'?[raw]:[]).map(Number);
    if(ids.length && ids.every(id=>Number.isSafeInteger(id)&&id>0&&Boolean(get('SELECT id FROM template WHERE id=?',[id])))) {
      /**
       * 把 profile.templateIds 迁进 template_ids 列。
       *
       * COALESCE 只保证"不覆盖已有值"，但后面那句 `delete profile.templateIds` 是**无条件**的：
       * 一旦这一列早已有值（例如用户在新版里点过一次保存、被写成 '[]'），旧绑定就被永久丢弃，
       * 而且一行日志都没有。所以改成条件式 —— 只有确实把值写进空列（影响行数 = 1）时才删旧键，
       * 否则保留 profile 里的原值并告警。
       */
      const r=run('UPDATE workbench SET template_ids=? WHERE id=? AND template_ids IS NULL',[JSON.stringify([...new Set(ids)]),w.id]);
      if(Number(r.changes)===1){delete profile.templateIds;run('UPDATE workbench SET profile=? WHERE id=?',[JSON.stringify(profile),w.id]);}
      else if(raw!=null)console.warn(`工作台 #${w.id} 的 profile.templateIds 未迁移（template_ids 已有值），已保留原值`);
    }
   }catch{console.warn('工作台 #'+w.id+' 档案格式无效，请人工核对');}}
   syncEvidence(w.id);
  }
  run("UPDATE workbench SET archive_status=CASE WHEN actual_end_date IS NOT NULL THEN 'done' ELSE 'active' END WHERE archived_at IS NOT NULL AND archive_status IS NULL");
  /**
   * 修归档脏行：`archived_at` 为空、但 status 还停在 'archived'。
   *
   * 这种行是旧版本写下的（归档时把 status 当成了归档前状态），后果很黏：
   * 列表按 archived_at 会返回它，前端又按 status 把它从"进行中"过滤掉 ——
   * 用户看到"取消了归档，但工作台不见了"，而且再点取消也出不来（死循环）。
   * 现在取消归档本身会自愈，这里再在启动时统一清一遍存量。
   */
  run(
    `UPDATE workbench SET
       status = CASE
         WHEN archive_status IN ('active','paused','done') THEN archive_status
         WHEN actual_end_date IS NOT NULL THEN 'done'
         ELSE 'active'
       END,
       archive_status = NULL
     WHERE archived_at IS NULL AND status = 'archived'`,
  );
  run("UPDATE ocr_item SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,ocr_error='上次任务中断，请重试' WHERE status='running' AND (started_at IS NULL OR started_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-10 minutes'))");
  run("UPDATE artifact SET ocr_status=(SELECT status FROM ocr_item WHERE artifact_id=artifact.id) WHERE id IN(SELECT artifact_id FROM ocr_item)");
  /**
   * 【一次性回填】把"旧代码删过、但只写了 `archived_at`"的档案字段补进回收站。
   *
   * 判据（两列一起看，缺一不可）：`archived_at IS NOT NULL AND deleted_at IS NULL`
   *   · `archived_at` 是 `archive_field` 从迁移 004 起就有的**删除**标记：全项目的写点只有
   *     `domain/archive.ts` 的 `archiveField()` 与 `domain/agent.ts` 的 `softDeleteById()`，
   *     读点一律是 `archived_at IS NULL`（`listArchiveFields` / `getArchiveField` /
   *     `core/coverage.ts` / `domain/agent.ts`）—— 没有任何"归档但仍可用"的读法；
   *   · `deleted_at` 是迁移 015 才补的回收站标记；缺陷修好**之前**的 `archiveField()` 只写
   *     `archived_at`、不写它，于是这批行：回收站列表（只列 `deleted_at IS NOT NULL`）里看不到，
   *     `restoreFromTrash('field',…)` / `purgeFromTrash('field',…)` 又被 `!f.deleted_at` 挡回去
   *     —— 字段从界面上消失，却**既不在回收站、也永远恢复不了**。补这一列，就是让用户能自己选。
   *
   * 只补标记，**不恢复**：补过之后这些行在常规读路径上仍然被排除（两个过滤条件都还在），
   * 唯一的差别是它们出现在「回收站」页里，由用户决定恢复还是彻底删除。
   *
   * **绝不碰 `workbench` / `template`**：只有这两张表的 `archived_at` 才是"归档 = 收起来、
   * 仍可查"的另一种语义（`service.ts` 的列表按它筛"已归档"）。所以本段的表名是字面量
   * `archive_field`，没有任何变量能把它换成别的表 —— 不写循环、不写表名参数。
   *
   * 幂等：`markDeleted()` 自带 `... AND deleted_at IS NULL` 守卫，只对"还没有回收站标记"的行生效，
   * 因此补过的行永远不会再进候选（重复启动的 `changes` 恒为 0），也保留了最早的删除时间。
   * 可审计：每次启动把实际补写行数打进启动日志（为 0 时不打印，避免老机器每次刷屏）。
   * 老库降级：缺迁移 015（没有 `deleted_at` 列）时**跳过** —— 而不是让 `markDeleted()` 抛错打断启动。
   * 不自己拼 SQL：出口沿用 `core/trash.ts` 的 `markDeleted()`，与全项目其它"移入回收站"同一时间戳格式与语义。
   */
  if(tableHasDeletedAt('archive_field')){
   const backfilled=markDeleted('archive_field','archived_at IS NOT NULL',[]);
   if(backfilled>0)console.log(`[启动修复] 回填了 ${backfilled} 个历史删除的档案字段（原只有 archived_at）`);
  }
 });
}
