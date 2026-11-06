-- Additive governance. Existing instances and business snapshots are not backfilled.
CREATE TABLE workflow_config_version (
 id INTEGER PRIMARY KEY, work_type_id INTEGER NOT NULL REFERENCES work_type(id),
 version_no INTEGER NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
 payload TEXT NOT NULL, digest TEXT NOT NULL, change_note TEXT NOT NULL,
 origin TEXT NOT NULL DEFAULT 'published', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(work_type_id,version_no)
);
CREATE TABLE workflow_config_draft (
 work_type_id INTEGER PRIMARY KEY REFERENCES work_type(id),
 base_version_id INTEGER REFERENCES workflow_config_version(id), revision INTEGER NOT NULL DEFAULT 1,
 schema_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE work_type ADD COLUMN published_config_id INTEGER REFERENCES workflow_config_version(id);
ALTER TABLE work_type ADD COLUMN config_baseline_pending INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workbench ADD COLUMN template_snapshot TEXT;
ALTER TABLE workbench ADD COLUMN source_config_version_id INTEGER REFERENCES workflow_config_version(id);
ALTER TABLE position_instance ADD COLUMN source_config_version_id INTEGER REFERENCES workflow_config_version(id);
ALTER TABLE work_period_rule ADD COLUMN source_config_version_id INTEGER REFERENCES workflow_config_version(id);
ALTER TABLE work_period_rule ADD COLUMN material_rules TEXT;
ALTER TABLE period_material ADD COLUMN config_key TEXT;
ALTER TABLE material_check ADD COLUMN config_key TEXT;
ALTER TABLE material_check ADD COLUMN requirement_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE evidence_rule ADD COLUMN config_key TEXT;
ALTER TABLE workflow_event ADD COLUMN operation_id TEXT;
CREATE UNIQUE INDEX idx_workflow_operation ON workflow_event(operation_id) WHERE operation_id IS NOT NULL;
-- Publication is the sole writer of managed projections, including internal callers.
CREATE TABLE workflow_config_write (id INTEGER PRIMARY KEY CHECK(id=1), allowed INTEGER NOT NULL DEFAULT 0 CHECK(allowed IN (0,1)));
INSERT INTO workflow_config_write(id) VALUES(1);
CREATE TRIGGER immutable_workflow_version_update BEFORE UPDATE ON workflow_config_version BEGIN SELECT RAISE(ABORT,'已发布流程版本不可修改'); END;
CREATE TRIGGER immutable_workflow_version_delete BEFORE DELETE ON workflow_config_version BEGIN SELECT RAISE(ABORT,'已发布流程版本不可删除'); END;
CREATE TRIGGER guard_work_type_update BEFORE UPDATE OF code,name,domain,category,navigation_group,mode,executor,period_defaults,description,icon,color,sort_order,published_config_id,rule_version ON work_type WHEN ((OLD.published_config_id IS NOT NULL OR OLD.config_baseline_pending=0)) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_work_type_delete BEFORE DELETE ON work_type WHEN ((OLD.published_config_id IS NOT NULL OR OLD.config_baseline_pending=0)) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_position_template_insert BEFORE INSERT ON position_template WHEN (EXISTS(SELECT 1 FROM work_type WHERE id=NEW.work_type_id AND (published_config_id IS NOT NULL OR config_baseline_pending=0))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_position_template_update BEFORE UPDATE ON position_template WHEN ((EXISTS(SELECT 1 FROM work_type WHERE id=OLD.work_type_id AND (published_config_id IS NOT NULL OR config_baseline_pending=0))) OR (EXISTS(SELECT 1 FROM work_type WHERE id=NEW.work_type_id AND (published_config_id IS NOT NULL OR config_baseline_pending=0)))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_position_template_delete BEFORE DELETE ON position_template WHEN (EXISTS(SELECT 1 FROM work_type WHERE id=OLD.work_type_id AND (published_config_id IS NOT NULL OR config_baseline_pending=0))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_material_check_insert BEFORE INSERT ON material_check WHEN (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=NEW.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_material_check_update BEFORE UPDATE ON material_check WHEN ((EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=OLD.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) OR (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=NEW.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0)))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_material_check_delete BEFORE DELETE ON material_check WHEN (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=OLD.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_evidence_rule_insert BEFORE INSERT ON evidence_rule WHEN (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=NEW.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_evidence_rule_update BEFORE UPDATE ON evidence_rule WHEN ((EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=OLD.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) OR (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=NEW.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0)))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_evidence_rule_delete BEFORE DELETE ON evidence_rule WHEN (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=OLD.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_position_template_doc_insert BEFORE INSERT ON position_template_doc WHEN (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=NEW.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_position_template_doc_update BEFORE UPDATE ON position_template_doc WHEN ((EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=OLD.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) OR (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=NEW.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0)))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
CREATE TRIGGER guard_position_template_doc_delete BEFORE DELETE ON position_template_doc WHEN (EXISTS(SELECT 1 FROM position_template p JOIN work_type t ON t.id=p.work_type_id WHERE p.id=OLD.position_template_id AND (t.published_config_id IS NOT NULL OR t.config_baseline_pending=0))) AND (SELECT allowed FROM workflow_config_write WHERE id=1)=0 BEGIN SELECT RAISE(ABORT,'请通过流程草稿发布配置'); END;
