-- ============================================================
-- 021 文书↔制度双链（B3-10）
--
-- 【编号说明】docs/11 §10.1 把 B3-10 排在 **021**（原计划占用 019，但 019 已给 B3-8 的抽取链、
-- 020 给 B4-11、020b 给 B3-9），本条按该承诺落地为 021。文件名字典序在 020b 之后，
-- 迁移执行器（db/migrate.ts）按文件名排序，顺序一致。
--
-- 本迁移只**新建两张表**，不动任何既有表：
--   · doc_kb_link       文书 ↔ 制度条款的链接（正查/反查/影响面的唯一数据源）
--   · kb_change_impact  变更影响的历史留痕（谁在什么时候算出"哪些文书受影响"）
--
-- 【与 docs/11 草稿 DDL 的三处有意偏离（实现为准）】
--   1. **两个 id 列都不建外键**（草稿写 `REFERENCES … ON DELETE CASCADE`）。
--      实测：`core/kb.ts:deleteKbDocument()` 是**物理删**（kb_document + kb_chunk + FTS 一起删），
--      回收站对 artifact 的"彻底删除"也是物理删。若按草稿写 CASCADE，制度一移除，
--      "哪些文书引用过它"这条历史就被数据库静默抹掉 —— 恰恰是 B3-10 要回答的问题。
--      所以：链接行**一律保留**，读路径自己 JOIN 判对象在不在（`resolveLinkTarget`）。
--   2. 增 `kb_rel_path`：制度重入库后 kb_document.id 会变（稳定键是 `(source_id, rel_path)`，
--      但换了来源目录就是新 id），留着相对路径才能**自动认回**老链接，不必让人重连一遍。
--   3. 增 `clause_sha256` / `raw_cite` / `created_by`：
--      · `clause_sha256` = 建链时该条**归一化正文**的哈希，用来回答"这条**改了没有**"
--        （与当前片段正文同法归一化后比哈希；不是逐字 diff，见 domain/kb-links.ts 的头注）；
--      · `raw_cite` = 正文里的原文写法（`《XX办法》第五条`），界面直接显示，不用反推；
--      · `created_by` = 人加链接时留痕（谁加的）。
--
-- 【link_kind】explicit（正文里写了条号，保存时自动扫）| manual（人加的）| suggested（预留）
--   本轮只写 explicit 与 manual。suggested（出文书时检索命中的"待确认"建议）**本轮不做**：
--   检索发生在生成弹窗里的独立请求中，没有随保存请求落库的通道，硬凑会造出"假建议"。
--   列与接口留着，将来接上检索日志即可，不需要再改表。
--
-- 【幂等】部分唯一索引保证「同一文书 + 同一制度 + 同一条款 + 同一来源」只有一条活链接；
--   注意 SQLite 里 NULL 彼此不相等，制度被删后 kb_document_id 为 NULL 时唯一性靠代码兜底
--   （domain/kb-links.ts 先按 rel_path 查再写）。
-- ============================================================

CREATE TABLE IF NOT EXISTS doc_kb_link (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id    INTEGER NOT NULL,                 -- 文书（artifact.id）；不建外键，理由见上
  kb_document_id INTEGER,                          -- 制度（kb_document.id）；制度被移除后按 kb_rel_path 认回
  kb_rel_path    TEXT,                             -- 制度在来源目录里的相对路径（稳定定位，用于认回）
  kb_chunk_id    INTEGER,                          -- 命中的片段（一条可能切成多块，这里记第一块）
  clause_path    TEXT,                             -- 条款路径，如 '第二章 到货验收要求 > 第五条 检查频次'
  link_kind      TEXT NOT NULL,                    -- explicit | manual | suggested（预留）
  confidence     REAL,                             -- 0..1；explicit/manual 记 1，suggested 才用得上
  quote          TEXT,                             -- 建链时该条原文片段（制度改了以后能对着看）
  clause_sha256  TEXT,                             -- 建链时该条归一化正文的 sha256（判"这条变了没有"）
  doc_sha256     TEXT,                             -- 建链时那份制度文件的 sha256（变了说明制度动过）
  raw_cite       TEXT,                             -- 正文里的原文写法（《XX办法》第五条）
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_by     TEXT,                             -- 人工链接：谁加的
  deleted_at     TEXT,                             -- 软删（人工取消 / 自动同步时正文已不再引用）
  deleted_by     TEXT,
  delete_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_dkl_artifact ON doc_kb_link(artifact_id);
CREATE INDEX IF NOT EXISTS idx_dkl_kbdoc    ON doc_kb_link(kb_document_id);
CREATE INDEX IF NOT EXISTS idx_dkl_relpath  ON doc_kb_link(kb_rel_path);
CREATE INDEX IF NOT EXISTS idx_dkl_clause   ON doc_kb_link(kb_document_id, clause_path);
-- 活链接的唯一性（软删的行不参与，所以取消过还能再加回来）
CREATE UNIQUE INDEX IF NOT EXISTS idx_dkl_uniq_live
  ON doc_kb_link(artifact_id, kb_document_id, clause_path, link_kind)
  WHERE deleted_at IS NULL;

-- 影响面历史：只在"制度内容确实变了且算出了受影响文书"时写一行（读点仍是现算，见 domain/kb-links.ts）
CREATE TABLE IF NOT EXISTS kb_change_impact (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kb_document_id     INTEGER NOT NULL,
  old_sha256         TEXT NOT NULL,
  new_sha256         TEXT NOT NULL,
  changed_clauses    TEXT,                          -- JSON：[{clausePath, status, clauseLabel}]
  affected_artifacts TEXT,                          -- JSON：[{artifactId, title, workbenchCode, clausePath, status}]
  computed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_kci_doc ON kb_change_impact(kb_document_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_kci_time ON kb_change_impact(computed_at DESC);
