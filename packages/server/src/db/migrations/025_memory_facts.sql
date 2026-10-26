ALTER TABLE agent_memory ADD COLUMN fact_key TEXT;
ALTER TABLE agent_memory ADD COLUMN fact_value TEXT;
CREATE TABLE artifact_fact_review (
 artifact_id INTEGER PRIMARY KEY REFERENCES artifact(id),
 snapshot TEXT NOT NULL
);
