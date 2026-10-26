-- 模板健康状态
--
-- 背景：模板库里有源文件损坏（word/document.xml 被截断、标签丢失）的 docx。
-- 这种文件 PizZip 照样能读、渲染照样"成功"，用户拿到一个打不开的文书。
-- 所以在 template 上记住"这个文件到底能不能打开"，出文书前据此拦下来。
--
--   health_ok = NULL → 还没校验过（历史数据），不拦截，照常生成
--   health_ok = 1    → 校验通过
--   health_ok = 0    → 坏模板，生成前报 400 并提示重新上传
--
-- health_note 存人话原因（哪个部件、第几行、什么毛病），直接显示给用户。
ALTER TABLE template ADD COLUMN health_ok INTEGER;
ALTER TABLE template ADD COLUMN health_note TEXT;
ALTER TABLE template ADD COLUMN health_checked_at TEXT;
