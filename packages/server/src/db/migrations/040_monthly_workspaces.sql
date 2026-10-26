-- User-maintained scope and rules are separate from monthly source snapshots.
CREATE TABLE timesheet_preferences (
 workbench_id INTEGER PRIMARY KEY REFERENCES workbench(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1,
 value TEXT NOT NULL
);
CREATE TABLE annual_ledger (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 workbench_id INTEGER NOT NULL REFERENCES workbench(id) ON DELETE CASCADE,
 year TEXT NOT NULL,
 path TEXT NOT NULL,
 digest TEXT NOT NULL,
 metadata TEXT NOT NULL,
 UNIQUE(workbench_id,year)
);
CREATE TABLE ledger_entry (
 id TEXT PRIMARY KEY,
 ledger_id INTEGER NOT NULL REFERENCES annual_ledger(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1,
 fields TEXT NOT NULL,
 month TEXT NOT NULL DEFAULT '',
 baseline TEXT NOT NULL,
 inspection_id INTEGER REFERENCES inspection_record(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'draft'
);
CREATE TABLE ledger_entry_version (
 entry_id TEXT NOT NULL REFERENCES ledger_entry(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 snapshot TEXT NOT NULL,
 PRIMARY KEY(entry_id,revision)
);
CREATE TABLE ledger_document (
 id TEXT PRIMARY KEY,
 ledger_id INTEGER NOT NULL REFERENCES annual_ledger(id) ON DELETE CASCADE,
 entry_id TEXT NOT NULL REFERENCES ledger_entry(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 path TEXT NOT NULL UNIQUE,
 digest TEXT NOT NULL,
 baseline TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'editable',
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
