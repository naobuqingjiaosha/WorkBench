-- ============================================================
-- 022 文书版本链：定稿唯一性落成硬约束 + 期次进链身份（B1-4 缺陷修复）
--
-- 017 建好了版本链的五列，但"同一链只有一个定稿"只由 domain/versions.ts 的 markFinal()
-- 「先清后置」在代码里保证 —— **没有数据库约束**。任何绕过 markFinal 的写入路径
-- （并发、脚本、中断后的半截态）都能留下同链两个 is_final=1，界面就会出现两个锁图标。
-- 本迁移补两件事：
--
--   ① `period_key`：期次进链身份。月报这类"同模板按月上交"的文书，9 月定稿之后
--      10 月**更新不了**（017 的链身份 = 工作台+模板+清单项+阶段，没有期次）。
--      列由 domain/versions.ts 的 resolvePeriodKey() 写；**存量行一律留 NULL**，
--      由"缺期次退化匹配 + 惰性回填"收进原链（口径见 versions.ts 的头注），
--      所以这里**不做**任何期次回填 —— 迁移里算不出正确期次，猜一个就会把旧链割裂。
--   ② 部分唯一索引 `idx_artifact_final_unique`：
--        CREATE UNIQUE INDEX ... ON artifact(version_group)
--          WHERE is_final = 1 AND deleted_at IS NULL
--      实测（隔离库 + 真实 HTTP）这条索引：
--        · 拦得住同链第二条定稿（SQLITE_CONSTRAINT_UNIQUE）；
--        · 放过软删行（定稿进回收站后仍能标新的定稿，恢复时它又变回唯一那个）；
--        · 放过 `version_group IS NULL` 的存量老数据（NULL 彼此不相等）；
--        · 不挡 markFinal 的"先清后置"（清空那一步在置位之前，同一事务内）。
--
-- 【存量数据必须能建索引成功】库里可能已经有同链多个 1（017 之后没有任何约束）。
-- 处理方式：**保留"界面本来就会显示为定稿"的那一行，其余清掉**，判据与
-- domain/versions.ts 的 findFinalInChain() 逐字一致 ——「活着的行里 revision 最大、
-- 同 revision 取 id 最大」。理由：定稿标记是可重建的显式状态，而"多选一"必须与
-- 读路径同口径，否则清完之后界面显示的定稿会跟唯一索引里的那一行不是同一条。
-- 软删行（deleted_at IS NOT NULL）不参与索引、也不在这里改动：它保留原标记，
-- 从回收站恢复时它仍是那条链的定稿快照。
--
-- 【幂等】
--   · 迁移执行器（db/migrate.ts）按 schema_migration.version 只跑一次；
--   · 兜底路径：domain/versions.ts 的 ensureDocVersionSchema() 会逐列探测补 period_key、
--     再按同样的顺序（先归并存量、后建索引）补建索引 ——
--     **"手工补过列、但 schema_migration 里没有 022" 的库**走的就是这条路。
--   · 归并语句自身幂等：再跑一次时"不是 keeper 的活定稿"已经是 0 行。
--   · 已知边界（与 017 同一条约定，不额外发明机制）：`ADD COLUMN` 没有 IF NOT EXISTS，
--     所以**不能**在"列已存在、又删掉 schema_migration 记录"的库上重跑本文件
--     （会报 duplicate column name）。真实升级不会出现这种组合；
--     真出现了，`ensureDocVersionSchema()` 会在下一次启动把索引与列补齐。
-- ============================================================

-- ---------- ① 期次进链身份 ----------

ALTER TABLE artifact ADD COLUMN period_key TEXT;

-- 链内按「工作台+模板+清单项+阶段+期次」找链头，给它一条能走上的索引
-- （017 的 idx_artifact_version_group 是 (version_group, revision)，这里补的是身份五元组）
CREATE INDEX IF NOT EXISTS idx_artifact_chain_identity
  ON artifact(workbench_id, template_id, checklist_item_id, position_code, period_key);

-- ---------- ② 存量归并：同链多个定稿只留一个 ----------

UPDATE artifact
   SET is_final = 0,
       final_at = NULL
 WHERE is_final = 1
   AND deleted_at IS NULL
   AND version_group IS NOT NULL
   AND id <> (
     SELECT k.id
       FROM artifact k
      WHERE k.version_group = artifact.version_group
        AND k.is_final = 1
        AND k.deleted_at IS NULL
      ORDER BY k.revision DESC, k.id DESC
      LIMIT 1
   );

-- ---------- ③ 定稿唯一性：硬约束 ----------

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_final_unique
  ON artifact(version_group)
  WHERE is_final = 1 AND deleted_at IS NULL;
