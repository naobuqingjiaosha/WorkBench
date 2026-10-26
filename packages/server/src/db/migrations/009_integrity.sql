ALTER TABLE workbench ADD COLUMN schedule_due_date TEXT;
ALTER TABLE workbench ADD COLUMN last_done_period TEXT;
ALTER TABLE workbench ADD COLUMN archive_status TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workbench_folder_unique ON workbench(folder_path);
ALTER TABLE ai_call_log ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
UPDATE ai_call_log SET is_test=1 WHERE provider_code LIKE 'fake-%';
ALTER TABLE workbench ADD COLUMN template_ids TEXT;
