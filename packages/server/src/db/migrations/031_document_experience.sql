-- Keep business notes separate from descriptive work metadata.
ALTER TABLE workbench ADD COLUMN business_content TEXT NOT NULL DEFAULT '';
-- Null type used to mean both unclassified and globally applicable. Only an
-- explicit opt-in makes an unclassified template available to every type.
ALTER TABLE template ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workbench ADD COLUMN reference_root TEXT;
UPDATE work_type SET description='补充事项：保留历史合同承诺资料，不属于清廉工程8项固定工作',sort_order=49 WHERE code='integrity-commitment';
