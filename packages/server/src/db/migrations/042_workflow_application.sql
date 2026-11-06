-- Explicit partial application only. No historical source/snapshot backfill.
ALTER TABLE position_instance ADD COLUMN config_snapshot TEXT;
ALTER TABLE position_instance ADD COLUMN description TEXT;
ALTER TABLE checklist_item ADD COLUMN config_key TEXT;
ALTER TABLE checklist_item ADD COLUMN rule_snapshot TEXT;
CREATE TABLE work_period_future_rule (
 id INTEGER PRIMARY KEY,
 workbench_id INTEGER NOT NULL REFERENCES workbench(id),
 effective_from TEXT NOT NULL,
 source_config_version_id INTEGER NOT NULL REFERENCES workflow_config_version(id),
 payload TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 UNIQUE(workbench_id,effective_from)
);
CREATE TRIGGER immutable_future_rule_update BEFORE UPDATE ON work_period_future_rule BEGIN SELECT RAISE(ABORT,'已确认的未来规则不可原位修改'); END;
CREATE TRIGGER immutable_future_rule_delete BEFORE DELETE ON work_period_future_rule BEGIN SELECT RAISE(ABORT,'已确认的未来规则不可删除'); END;
