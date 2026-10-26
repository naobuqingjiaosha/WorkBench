-- Drafts never participate in inspection_record facts or aggregate counts.
CREATE TABLE inspection_draft (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 period_id INTEGER NOT NULL REFERENCES work_period(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 fields TEXT NOT NULL,
 provenance TEXT NOT NULL DEFAULT '{}',
 source TEXT,
 inspection_id INTEGER REFERENCES inspection_record(id) ON DELETE SET NULL,
 inspection_revision INTEGER,
 accepted_revision INTEGER,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(period_id,request_key)
);
CREATE TABLE inspection_draft_history (
 draft_id INTEGER NOT NULL REFERENCES inspection_draft(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 snapshot TEXT NOT NULL,
 PRIMARY KEY(draft_id,revision)
);
ALTER TABLE artifact ADD COLUMN inspection_draft_id INTEGER REFERENCES inspection_draft(id) ON DELETE SET NULL;
ALTER TABLE artifact ADD COLUMN inspection_draft_revision INTEGER;
CREATE INDEX idx_inspection_draft_period ON inspection_draft(period_id);
