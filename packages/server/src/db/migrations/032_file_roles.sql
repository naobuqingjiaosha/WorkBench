-- Upload purpose is distinct from file format and the generated-result kind.
ALTER TABLE artifact ADD COLUMN file_role TEXT NOT NULL DEFAULT 'source' CHECK(file_role IN ('source','external'));
UPDATE work_type SET category='清廉工程补充事项' WHERE code='integrity-commitment';
