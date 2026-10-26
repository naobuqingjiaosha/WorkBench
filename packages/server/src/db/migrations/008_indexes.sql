-- 008 审计后补的索引与清理
--
-- 来源：一次逐条用 EXPLAIN QUERY PLAN 实测的只读审计（见 docs/06-系统审计与优化清单.md）。
-- 补的都是代码里高频走的 WHERE / ORDER BY，之前全是全表扫描 + 临时 B 树。
-- 现在数据量小，感觉不出来；等文件上千、片段上万时，这些就是"点一下卡三秒"的来源。

-- 文件按内容去重（store.ts 的 sha256 查询原来全表扫描）
CREATE INDEX IF NOT EXISTS idx_artifact_sha256 ON artifact(sha256);

-- 工作列表：WHERE archived_at IS NULL ORDER BY updated_at DESC
CREATE INDEX IF NOT EXISTS idx_workbench_live ON workbench(archived_at, updated_at DESC);

-- 生成记录按工作台查（工作台详情页）
CREATE INDEX IF NOT EXISTS idx_generation_log_wb ON generation_log(workbench_id, id DESC);

-- 活着的模板按工作类型列（知识库检索、模板列表）
CREATE INDEX IF NOT EXISTS idx_template_live ON template(archived_at, work_type_id, id);

-- 阶段模板的材料清单 / 影像规则（工作台详情、影像初检都要读）
CREATE INDEX IF NOT EXISTS idx_material_check_pos ON material_check(position_template_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_evidence_rule_pos ON evidence_rule(position_template_id, sort_order);

-- 影像初检结论按工作台回看
CREATE INDEX IF NOT EXISTS idx_evidence_review_wb ON evidence_review(workbench_id, id DESC);

-- AI 助手的记忆与会话
CREATE INDEX IF NOT EXISTS idx_agent_memory_status ON agent_memory(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_session_updated ON agent_session(updated_at DESC);

-- 删工作台时要按 workbench_id 清理提议
CREATE INDEX IF NOT EXISTS idx_archive_proposal_wb ON archive_proposal(workbench_id);

-- 冗余索引：ocr_item.artifact_id 本身已是 UNIQUE（自带 autoindex），再建一个是白占写入成本
DROP INDEX IF EXISTS idx_ocr_item_artifact;
