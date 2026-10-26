CREATE TABLE template_policy_requirement (
  template_id INTEGER PRIMARY KEY REFERENCES template(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('off','reference','required')),
  document_ids TEXT NOT NULL DEFAULT '[]'
);
-- 保留生成时的要求；修改模板设置不会降低已保存文书的定稿要求。
CREATE TABLE artifact_policy_requirement (
  artifact_id INTEGER PRIMARY KEY REFERENCES artifact(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL
);
