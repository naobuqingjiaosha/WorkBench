CREATE TABLE inspection_record (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 period_id INTEGER NOT NULL REFERENCES work_period(id),
 project TEXT NOT NULL, inspection_date TEXT NOT NULL,
 subject TEXT NOT NULL, content TEXT NOT NULL, result TEXT NOT NULL,
 rectification TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_inspection_period ON inspection_record(period_id,id);
ALTER TABLE artifact ADD COLUMN inspection_id INTEGER REFERENCES inspection_record(id);
ALTER TABLE artifact ADD COLUMN inspection_revision INTEGER;
ALTER TABLE work_period ADD COLUMN reported_on TEXT;
ALTER TABLE work_period ADD COLUMN report_snapshot TEXT;
ALTER TABLE period_material ADD COLUMN requirement_kind TEXT NOT NULL DEFAULT 'external'
 CHECK(requirement_kind IN ('external','generated','reference','submission'));
-- Classify only the known built-in defaults; preserve user-defined proof rules.
UPDATE period_material SET requirement_kind=CASE
 WHEN title='实际报送与归档材料' THEN 'submission'
 WHEN title IN ('监督检查记录','监督情况报送表册','八大体系自查表','风险研判会议纪要','廉洁学习记录','项目研判考评会议纪要','人工核对与定稿材料') THEN 'generated'
 ELSE 'reference' END
WHERE period_id IN (SELECT p.id FROM work_period p JOIN workbench w ON w.id=p.workbench_id JOIN work_type t ON t.id=w.work_type_id WHERE t.code IN ('integrity-monthly-inspection','integrity-system-check','integrity-risk','integrity-study','integrity-project-review','integrity-quarter-summary'))
AND title IN ('实际报送与归档材料','监督检查记录','监督情况报送表册','八大体系自查表','风险研判会议纪要','廉洁学习记录','项目研判考评会议纪要','人工核对与定稿材料','核对与归档材料','风险研判材料','廉洁学习材料','项目研判考评材料');
