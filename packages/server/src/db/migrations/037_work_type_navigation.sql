-- 仅保存展示目录选择；既有类型按元数据解析，不改写领域或业务配置。
ALTER TABLE work_type ADD COLUMN navigation_group TEXT CHECK (navigation_group IN ('information','engineering','administration'));
