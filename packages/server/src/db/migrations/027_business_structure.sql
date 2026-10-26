-- Domain is independent of execution mode. Existing instance files are never moved.
ALTER TABLE work_type ADD COLUMN domain TEXT NOT NULL DEFAULT 'admin' CHECK(domain IN ('admin','project'));
UPDATE work_type SET domain=CASE WHEN category IN ('project','项目','项目实施','工程类','信息化类','服务类') THEN 'project' ELSE 'admin' END;
ALTER TABLE work_type ADD COLUMN period_defaults TEXT;
ALTER TABLE work_type ADD COLUMN executor TEXT NOT NULL DEFAULT 'general' CHECK(executor IN ('general','timesheet'));
ALTER TABLE work_type ADD COLUMN rule_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workbench ADD COLUMN rules_snapshot TEXT;
ALTER TABLE workbench ADD COLUMN historical INTEGER NOT NULL DEFAULT 0;
ALTER TABLE position_instance ADD COLUMN folder_name TEXT;
ALTER TABLE position_instance ADD COLUMN period_dir TEXT;
UPDATE position_instance SET folder_name=(SELECT folder_name FROM position_template WHERE id=position_template_id),
 period_dir=(SELECT period_dir FROM position_template WHERE id=position_template_id);
ALTER TABLE timesheet_run ADD COLUMN workbench_id INTEGER REFERENCES workbench(id);
ALTER TABLE timesheet_run ADD COLUMN period_id INTEGER REFERENCES work_period(id);
ALTER TABLE timesheet_run ADD COLUMN artifact_id INTEGER REFERENCES artifact(id);
CREATE INDEX idx_timesheet_scope ON timesheet_run(workbench_id,period_id,id);
ALTER TABLE quick_todo ADD COLUMN kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','delivery','coordination'));
ALTER TABLE quick_todo ADD COLUMN position_id INTEGER REFERENCES position_instance(id);
ALTER TABLE quick_todo ADD COLUMN owner TEXT;
