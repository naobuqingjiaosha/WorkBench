-- ============================================================
-- 002 全文检索（FTS5）
--
-- 中文处理策略：FTS5 的 unicode61 分词器不切分 CJK，整串会成为一个 token。
-- 因此入库时把 CJK 字符逐字用空格隔开后再索引（"验收清单" → "验 收 清 单"），
-- 查询时同样处理并作为短语匹配（"验收" → "验 收"）。
-- 原始文本仍完整保存在 artifact 表里；这里只存切分后的副本用于打分。
--
-- 注意：本表名不能叫 artifact_fts_data，那是 FTS5 内部 shadow 表的保留名。
-- ============================================================

CREATE TABLE artifact_search (
  id       INTEGER PRIMARY KEY,                 -- 与 artifact.id 相同
  wb_id    INTEGER,
  kind     TEXT,
  seg_text TEXT NOT NULL,
  seg_name TEXT NOT NULL
);

CREATE VIRTUAL TABLE artifact_fts USING fts5(
  seg_text,
  seg_name,
  content='artifact_search',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER artifact_search_ai AFTER INSERT ON artifact_search BEGIN
  INSERT INTO artifact_fts(rowid, seg_text, seg_name) VALUES (new.id, new.seg_text, new.seg_name);
END;
CREATE TRIGGER artifact_search_ad AFTER DELETE ON artifact_search BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, seg_text, seg_name) VALUES ('delete', old.id, old.seg_text, old.seg_name);
END;
CREATE TRIGGER artifact_search_au AFTER UPDATE ON artifact_search BEGIN
  INSERT INTO artifact_fts(artifact_fts, rowid, seg_text, seg_name) VALUES ('delete', old.id, old.seg_text, old.seg_name);
  INSERT INTO artifact_fts(rowid, seg_text, seg_name) VALUES (new.id, new.seg_text, new.seg_name);
END;

CREATE INDEX idx_artifact_search_wb ON artifact_search(wb_id, kind);
