-- 015 回收站与撤销：软删除列 + 助手动作的前置快照
--
-- 设计要点：
--   1. **软删除**：workbench / artifact / position_instance / archive_field / archive_alias
--      各加一列 `deleted_at`（NULL = 正常）。删掉的东西进回收站，能恢复、也能彻底删。
--      与 `archived_at` 是两回事：归档 = 还在（只是收起来、可查询），软删除 = 进回收站（默认查询全排除）。
--   2. **每个读路径都要认这一列**。加了列却漏掉某条 SELECT，就会出现
--      "列表里没有了，但搜索/统计/检查清单还查得到" 这种半截状态。
--      core/trash.ts 里导出了 `NOT_DELETED` 片段与 `notDeleted()` 小工具，读点统一用它。
--   3. `archive_field` / `archive_alias` 建表（004）时还没有这一列，这里补上；
--      `archive_field` 原本已有等价的 `archived_at` 软删语义，删除时会**两列一起写**，
--      于是旧代码按 `archived_at` 过滤照样看得懂，回收站也能列出/恢复它。
--   4. `agent_action.before_json`：写入待确认动作时记下被改对象的**改动前关键字段快照**，
--      动作执行后可以据此撤销（POST /api/agent/actions/:id/undo）。
--      没有快照的动作类型明确不允许撤销，不假装成功。
--
-- 索引：`idx_<表>_deleted_at`，让"排除已删除"的过滤能走上索引。

-- ---------- 软删除列 ----------

ALTER TABLE workbench ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_workbench_deleted_at ON workbench(deleted_at);

ALTER TABLE artifact ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_artifact_deleted_at ON artifact(deleted_at);

ALTER TABLE position_instance ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_position_instance_deleted_at ON position_instance(deleted_at);

ALTER TABLE archive_field ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_archive_field_deleted_at ON archive_field(deleted_at);

ALTER TABLE archive_alias ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_archive_alias_deleted_at ON archive_alias(deleted_at);

-- ---------- 助手动作的前置快照 ----------

ALTER TABLE agent_action ADD COLUMN before_json TEXT;
