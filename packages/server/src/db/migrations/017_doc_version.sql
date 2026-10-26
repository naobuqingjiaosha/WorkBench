-- 017 生成文书的版本链（B1-4）
--
-- 背景（docs/11 B1-4）：同一份文书改三遍，磁盘上是 `XXX_v1/v2/v3.docx` 三个并列的独立文档，
-- 「这是同一份的三个版本」这个概念在库里根本不存在；`artifact.version` 列从 001 建表起就有，
-- 但**没有任何写入路径**（docs/09 D8 已核实）。于是"哪份是最终版"只能靠文件名猜。
--
-- 这一份迁移补的是**版本链**本身（不做 docx 正文 diff —— 否决理由见 docs/09 §4.8.4）：
--   · `version_group`  同一份文书的版本链 id（uuid；NULL = 迁移前的旧生成件，界面上显示「v1（未分链）」）
--   · `revision`       在这条链里是第几版（旧数据一律 1）
--   · `supersedes_id`  上一版 artifact.id（成链；被软删的上一版仍然记着 id，不再复用版本号）
--   · `is_final`       是否「最终版」。**同一 group 内最多一个 1**，由 domain/versions.ts 的
--                      markFinal() 在同一事务里先清后置来保证（没有唯一索引 —— 部分唯一索引
--                      带 WHERE 的话，软删行也会被算进去，反而让"定稿行被软删后无法再定稿"）
--   · `final_at`       定稿时间（取消定稿时清空）
--
-- `generation_log` 补三列，让"这份文书是怎么一步步变成现在这样的"可查：
--   每次生成的变量取值本来就在 `generation_log.variables` 里，补上链 id 与版本号之后
--   才能把"某两版之间哪个字段改了"直接算出来（`GET /api/artifacts/:id/diff`）。
--
-- 【幂等】SQLite 不支持 `ALTER TABLE ADD COLUMN IF NOT EXISTS`，所以：
--   ① 常规路径：迁移执行器（db/migrate.ts）按 `schema_migration.version` 记已执行版本，只会跑一次；
--   ② 兜底路径：`domain/versions.ts` 的 `ensureDocVersionSchema()` 会**逐列探测**
--      （`pragma_table_info`）再补 ALTER，因此"对着一个已经手工补过列的库再跑一次"也不会炸。
--      探测的列名清单必须与下面这几条 ALTER 逐字一致。
--
-- 【外键】刻意**不给 `supersedes_id` 加 REFERENCES**：上一版被真删（回收站彻底删除）时，
-- `ON DELETE SET NULL` 会把链上的"从哪来"抹掉（追溯信息丢一半），`ON DELETE CASCADE` 更糟 ——
-- 删一个旧版本会把整条链连根拔掉。版本链的追溯信息比外键约束值钱，这里只存 id。

-- ---------- artifact：版本链列 ----------

ALTER TABLE artifact ADD COLUMN version_group TEXT;
ALTER TABLE artifact ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE artifact ADD COLUMN supersedes_id INTEGER;
ALTER TABLE artifact ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifact ADD COLUMN final_at TEXT;

-- 版本列表（`WHERE version_group = ? ORDER BY revision`）走这条索引
CREATE INDEX IF NOT EXISTS idx_artifact_version_group ON artifact(version_group, revision);

-- ---------- generation_log：版本归属 ----------

ALTER TABLE generation_log ADD COLUMN version_group TEXT;
ALTER TABLE generation_log ADD COLUMN revision INTEGER;
ALTER TABLE generation_log ADD COLUMN prev_artifact_id INTEGER;
