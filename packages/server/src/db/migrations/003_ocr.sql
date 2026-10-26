-- ============================================================
-- 003 OCR 任务队列
--
-- OCR 耗时且吃 CPU，不能在上传请求里同步做。
-- 上传时登记任务，后台串行处理，界面轮询进度。
-- ============================================================

CREATE TABLE ocr_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL UNIQUE REFERENCES artifact(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed | skipped
  attempts    INTEGER NOT NULL DEFAULT 0,
  confidence  INTEGER,
  chars       INTEGER,
  ocr_error   TEXT,
  started_at  TEXT,
  finished_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_ocr_item_status ON ocr_item(status, id);
CREATE INDEX idx_ocr_item_artifact ON ocr_item(artifact_id);
