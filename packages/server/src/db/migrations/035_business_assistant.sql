-- Evidence snapshots are local audit records, never independent business facts.
CREATE TABLE business_ai_run (
 id INTEGER PRIMARY KEY,
 message_id INTEGER REFERENCES agent_message(id),
 parent_id INTEGER REFERENCES business_ai_run(id),
 question TEXT NOT NULL,
 snapshot TEXT NOT NULL,
 answer TEXT NOT NULL,
 model TEXT NOT NULL,
 validation TEXT NOT NULL,
 draft TEXT,
 artifact_id INTEGER REFERENCES artifact(id),
 review_note TEXT,
 reviewed_digest TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_business_ai_message ON business_ai_run(message_id);
CREATE INDEX idx_business_ai_artifact ON business_ai_run(artifact_id);
