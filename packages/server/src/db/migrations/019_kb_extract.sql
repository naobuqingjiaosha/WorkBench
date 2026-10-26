-- ============================================================
-- 019 知识库内容抽取与向量化（B3-8）
--
-- 背景：012 只搭了「来源目录登记 + 只统计元数据」的框架，一个字节内容都没读。
-- 本迁移把「真抽内容」所需的落点补齐，**不改任何既有列的类型或语义**：
--   · kb_source      追加「抽取状态」四列（登记/统计这条路完全不受影响）
--   · kb_document    追加「来源 + 去重 + 分区 + 版本」列，并加**稳定键唯一约束**
--   · kb_chunk       追加「章节/条款路径」列（B3-9 条款级引用直接用它）
--   · kb_chunk_search / kb_chunk_fts  FTS5 全文索引（中文逐字切分，口径同 002）
--   · kb_extract_job / kb_extract_item  抽取批次与逐文件结果（进度、失败原因、可续跑）
--
-- 三条口径（去重 / 范围 / 版本）不是表结构，而是 app_setting 的
-- `kb.dedup` / `kb.scope` / `kb.version` 三个键 —— 换口径重跑只改设置，
-- 靠下面的 `stable_key` 唯一约束保证「不产生重复行」。
--
-- 【编号说明】docs/11 §10.1 把 019 记在「B3-8/B3-10」名下，并写明
-- 「kb_chunk.clause_path 放 019 或 B3-9 的迁移，落地时二选一并写回本文」。
-- 本次实测选：019 = B3-8（clause_path + 抽取链），B3-10 的
-- doc_kb_link / kb_change_impact 顺延为 **021**（020 已被 B4-11 占用）。
--
-- 另：本迁移**不建** kb_document 上任何 NOT NULL 无默认值的列
-- （教训见 docs/15 §二.3：草稿 DDL 会变成运行时的坑）。
-- ============================================================

-- ---------- 1. 来源目录：抽取状态 ----------

ALTER TABLE kb_source ADD COLUMN last_extract_at TEXT;
ALTER TABLE kb_source ADD COLUMN extracted_docs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_source ADD COLUMN extracted_chunks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kb_source ADD COLUMN extract_note TEXT;

-- ---------- 2. 知识库文档：来源、去重、分区、版本 ----------

ALTER TABLE kb_document ADD COLUMN source_id INTEGER REFERENCES kb_source(id) ON DELETE SET NULL;
-- 相对来源根的路径（正斜杠）；绝对路径不落库，由 kb_source.path + rel_path 现算
ALTER TABLE kb_document ADD COLUMN rel_path TEXT;
-- 文件内容哈希（sha256）：去重与「内容变没变」的唯一判据
ALTER TABLE kb_document ADD COLUMN doc_sha256 TEXT;
-- 归一化文本哈希：去重口径 by_hash 用它（容忍页眉页脚/空白差异）
ALTER TABLE kb_document ADD COLUMN norm_sha256 TEXT;
-- 文号（从文件名/正文抬头抽；抽不到就是 NULL）
ALTER TABLE kb_document ADD COLUMN doc_no TEXT;
-- 来源分区：unit 本单位制度 | regulation 外部法规标准 | reference 参考制度（非本单位发文）
ALTER TABLE kb_document ADD COLUMN scope_layer TEXT;
-- 版本状态：final 定稿（0. 起头 / 已印发）| current 现行 | superseded 上会稿/制作中/历史/旧稿
ALTER TABLE kb_document ADD COLUMN version_status TEXT;
-- 抽取结论：active 已入库可用 | skipped_dup 判为重复 | skipped_scope 按范围口径排除
--           | skipped_version 按版本口径排除 | skipped_kind 判定为非制度 | failed 抽取失败
ALTER TABLE kb_document ADD COLUMN decision TEXT;
-- 结论理由（人话）："与 #12 重复（同文号…）" / "只抽 0. 定稿件，本文件是历史稿" …
ALTER TABLE kb_document ADD COLUMN decision_reason TEXT;
-- 顶掉它的那一份（重复关系可查：从被跳过的那条能追到留下的那条）
-- 刻意**不加 REFERENCES**：SQLite 的 ALTER TABLE ADD COLUMN 不接受外键约束（会直接报错），
-- 而且它指向同表另一行、删除时不该级联。
ALTER TABLE kb_document ADD COLUMN dup_of_id INTEGER;
-- 切块口径签名：切块算法或参数变了 → 同一份文件要重新切
ALTER TABLE kb_document ADD COLUMN chunk_config TEXT;
-- 最近一次抽取动作的时间（与 embedded_at 区分：后者只说向量）
ALTER TABLE kb_document ADD COLUMN extracted_at TEXT;
-- 文件类型 / 大小 / 修改时间（毫秒）：重跑时的「没变就跳过」快通道靠这三个
ALTER TABLE kb_document ADD COLUMN file_ext TEXT;
ALTER TABLE kb_document ADD COLUMN size_bytes INTEGER;
ALTER TABLE kb_document ADD COLUMN mtime_ms INTEGER;
-- 抽文本用的手段：docx | pdf-text | ocr | xlsx | plain | none（排错用）
ALTER TABLE kb_document ADD COLUMN extract_method TEXT;
-- 抽到的正文字数（界面「抽取结果」一栏显示，也是"这份文件到底抽到东西没有"的证据）
ALTER TABLE kb_document ADD COLUMN chars INTEGER;

-- 稳定键：来源 + 相对路径。有这个唯一约束，同一批重跑、换口径重跑都只会 UPDATE，
-- 不会 INSERT 出第二行（这是验收里「不出现重复行」的底座）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_doc_stable ON kb_document(source_id, rel_path);
CREATE INDEX IF NOT EXISTS idx_kb_doc_sha ON kb_document(doc_sha256);
CREATE INDEX IF NOT EXISTS idx_kb_doc_decision ON kb_document(decision);
-- 注意：source_id 为 NULL 的旧行（手工上传那条路）不受唯一约束影响 —— SQLite 里
-- NULL 互不相等，多条 (NULL, '...') 是允许的，老数据零影响。

-- ---------- 3. 片段：章节/条款路径 ----------

-- 形如「S3 第三章 检查考核 > 一 第五条 > （二）」，B3-9 的条款级引用靠它定位
ALTER TABLE kb_chunk ADD COLUMN clause_path TEXT;

-- ---------- 4. 片段全文索引（FTS5） ----------
--
-- 口径与 002_fts.sql 完全一致：CJK 逐字空格化后入库（"验收清单" → "验 收 清 单"），
-- 查询走 core/search.ts 的 buildMatch。表名不能叫 kb_chunk_fts_data（FTS5 内部影子表保留名）。

CREATE TABLE kb_chunk_search (
  id          INTEGER PRIMARY KEY,          -- 与 kb_chunk.id 相同
  document_id INTEGER NOT NULL,
  clause_path TEXT,
  seg_text    TEXT NOT NULL
);

CREATE VIRTUAL TABLE kb_chunk_fts USING fts5(
  seg_text,
  clause_path,
  content='kb_chunk_search',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER kb_chunk_search_ai AFTER INSERT ON kb_chunk_search BEGIN
  INSERT INTO kb_chunk_fts(rowid, seg_text, clause_path) VALUES (new.id, new.seg_text, new.clause_path);
END;
CREATE TRIGGER kb_chunk_search_ad AFTER DELETE ON kb_chunk_search BEGIN
  INSERT INTO kb_chunk_fts(kb_chunk_fts, rowid, seg_text, clause_path) VALUES ('delete', old.id, old.seg_text, old.clause_path);
END;
CREATE TRIGGER kb_chunk_search_au AFTER UPDATE ON kb_chunk_search BEGIN
  INSERT INTO kb_chunk_fts(kb_chunk_fts, rowid, seg_text, clause_path) VALUES ('delete', old.id, old.seg_text, old.clause_path);
  INSERT INTO kb_chunk_fts(rowid, seg_text, clause_path) VALUES (new.id, new.seg_text, new.clause_path);
END;

CREATE INDEX idx_kb_chunk_search_doc ON kb_chunk_search(document_id);

-- ---------- 5. 抽取批次与逐文件结果 ----------

CREATE TABLE kb_extract_job (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES kb_source(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending|running|done|failed|cancelled
  -- 本次口径快照（JSON）：换口径重跑才解释得清"当时用的是什么口径"
  settings_json TEXT,
  total         INTEGER NOT NULL DEFAULT 0,
  done          INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  duplicates    INTEGER NOT NULL DEFAULT 0,
  chunks        INTEGER NOT NULL DEFAULT 0,
  embedded      INTEGER NOT NULL DEFAULT 0,
  current       TEXT,
  message       TEXT,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at   TEXT
);
CREATE INDEX idx_kb_extract_job_source ON kb_extract_job(source_id, id DESC);

CREATE TABLE kb_extract_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES kb_extract_job(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  file_name   TEXT,
  size_bytes  INTEGER,
  doc_no      TEXT,
  scope_layer TEXT,
  version_status TEXT,
  -- ok 入库 | skip 按口径跳过（非失败） | fail 真失败（坏文件/无文字/向量化失败）
  result      TEXT NOT NULL,
  reason      TEXT,
  document_id INTEGER,
  chunks      INTEGER NOT NULL DEFAULT 0,
  embedded    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kb_extract_item_job ON kb_extract_item(job_id, id);
CREATE INDEX idx_kb_extract_item_result ON kb_extract_item(job_id, result);
