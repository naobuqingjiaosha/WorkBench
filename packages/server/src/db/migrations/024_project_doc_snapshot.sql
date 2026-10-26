-- 存量实例只能冻结升级时仍可见的配置，不推断已被删除的历史要求。
ALTER TABLE position_instance ADD COLUMN doc_requirements TEXT;
UPDATE position_instance SET doc_requirements = COALESCE((
 SELECT json_group_array(json_object('templateId',d.template_id,'name',COALESCE(t.name,'模板 #' || d.template_id),'required',d.required,'seq',d.seq))
 FROM position_template_doc d LEFT JOIN template t ON t.id=d.template_id
 WHERE d.position_template_id=position_instance.position_template_id AND d.deleted_at IS NULL
), '[]');
