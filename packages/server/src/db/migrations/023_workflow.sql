-- Additive only. Existing files and legacy period_key values remain untouched.
CREATE TABLE work_period_rule (
 workbench_id INTEGER PRIMARY KEY REFERENCES workbench(id),
 frequency TEXT NOT NULL CHECK(frequency IN ('monthly','quarterly','yearly')),
 first_period TEXT NOT NULL,
 due_month_offset INTEGER NOT NULL DEFAULT 0,
 due_day INTEGER NOT NULL DEFAULT 31,
 remind_days INTEGER NOT NULL DEFAULT 3,
 requirements TEXT NOT NULL DEFAULT '[]',
 version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE work_period (
 id INTEGER PRIMARY KEY,
 workbench_id INTEGER NOT NULL REFERENCES workbench(id),
 report_period TEXT NOT NULL,
 report_date TEXT NOT NULL,
 due_date TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
 snapshot TEXT NOT NULL,
 content TEXT NOT NULL DEFAULT '',
 completed_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(workbench_id,report_period)
);
CREATE TABLE period_material (
 id INTEGER PRIMARY KEY,
 period_id INTEGER NOT NULL REFERENCES work_period(id),
 title TEXT NOT NULL,
 required INTEGER NOT NULL DEFAULT 1,
 artifact_id INTEGER REFERENCES artifact(id),
 status TEXT NOT NULL DEFAULT 'missing' CHECK(status IN ('missing','provided','verified','na')),
 note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE workflow_event (
 id INTEGER PRIMARY KEY,
 period_id INTEGER REFERENCES work_period(id),
 action TEXT NOT NULL,
 detail TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE artifact ADD COLUMN work_period_id INTEGER REFERENCES work_period(id);
ALTER TABLE agent_memory ADD COLUMN valid_from TEXT;
ALTER TABLE agent_memory ADD COLUMN valid_until TEXT;
ALTER TABLE agent_memory ADD COLUMN period_id INTEGER REFERENCES work_period(id);
ALTER TABLE agent_memory ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN supersedes_id INTEGER REFERENCES agent_memory(id);
UPDATE agent_memory SET confirmed=1 WHERE source IN ('用户手填','手工','对话');
CREATE TABLE ai_request (
 id TEXT PRIMARY KEY,
 owner TEXT NOT NULL,
 target TEXT NOT NULL,
 purpose TEXT NOT NULL,
 model TEXT NOT NULL,
 payload TEXT NOT NULL,
 digest TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 created_at TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 decided_at TEXT
);
CREATE TABLE quick_todo (
 id INTEGER PRIMARY KEY,
 title TEXT NOT NULL,
 due_date TEXT,
 note TEXT NOT NULL DEFAULT '',
 workbench_id INTEGER REFERENCES workbench(id),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE timesheet_run (
 id INTEGER PRIMARY KEY,
 month TEXT NOT NULL,
 input TEXT NOT NULL,
 result TEXT NOT NULL,
 rule_version TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE timesheet_source (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 digest TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE checklist_item ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE checklist_item ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
