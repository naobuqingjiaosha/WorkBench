CREATE TABLE template_revision (
 id INTEGER PRIMARY KEY,
 template_id INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
 digest TEXT NOT NULL,
 file_rel TEXT NOT NULL,
 vars_rel TEXT,
 metadata TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(template_id,digest)
);
