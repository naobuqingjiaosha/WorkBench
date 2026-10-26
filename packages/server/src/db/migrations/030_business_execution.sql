-- Lightweight per-period execution; no shared work-level stage state.
ALTER TABLE work_period_rule ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE work_period ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE work_period ADD COLUMN scheduled_date TEXT;
ALTER TABLE work_period ADD COLUMN source_period_ids TEXT NOT NULL DEFAULT '[]';
