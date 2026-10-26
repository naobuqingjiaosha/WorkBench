-- 独立保留用户陈述，不迁移或删除旧工作、备忘与成果。
CREATE TABLE work_record (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 text TEXT NOT NULL,
 occurred_from TEXT,
 occurred_to TEXT,
 date_precision TEXT NOT NULL DEFAULT 'unknown',
 nature TEXT NOT NULL DEFAULT 'unknown' CHECK(nature IN ('done','progress','plan','unknown')),
 workbench_id INTEGER REFERENCES workbench(id) ON DELETE SET NULL,
 source TEXT NOT NULL,
 source_message_id INTEGER,
 request_key TEXT NOT NULL UNIQUE,
 request_hash TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','withdrawn')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK((occurred_from IS NULL AND occurred_to IS NULL) OR (occurred_from IS NOT NULL AND occurred_to IS NOT NULL AND occurred_from<=occurred_to))
);
CREATE INDEX idx_work_record_period ON work_record(status,occurred_from,occurred_to);
CREATE INDEX idx_work_record_work ON work_record(workbench_id,status);
CREATE TABLE work_record_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 record_id INTEGER NOT NULL REFERENCES work_record(id),
 revision INTEGER NOT NULL,
 snapshot TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(record_id,revision)
);
CREATE TABLE work_record_answer (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 message_id INTEGER UNIQUE REFERENCES agent_message(id) ON DELETE SET NULL,
 request_key TEXT UNIQUE,
 request_hash TEXT,
 session_id INTEGER,
 text TEXT NOT NULL,
 record_refs TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
