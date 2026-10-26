-- 018 阶段↔文书模板绑定（B2-7）
--
-- 背景：流程规范里已经能写「这个阶段要交什么材料」（material_check）、
-- 「要拍几张照片」（evidence_rule），但**不能写「这个阶段该用哪几个模板出文书」**。
-- 于是用户每次出文书都要在几十份模板里自己找，找错出的就是别阶段的文书。
--
-- 现有的两层绑定都不是这一层：
--   · 工作台↔模板 → `workbench.template_ids`（JSON）
--   · 工作类型↔模板 → `template.work_type_id`
--   · 材料级「顺手带的模板」→ `material_check.template_id`（一条材料只能挂 1 个）
-- 这一张表补的正是**阶段这一层**，且是**多对多**。
--
-- 【优先级定死】阶段绑定 > 工作台绑定 > 工作类型全部（与 docs/11 B2-7 一致）。
-- 三层都空的回退行为与改造前完全一致 —— 存量数据零影响，这条有回归断言守着。
--
-- 【软删除】本表的 `deleted_at` 只用于「绑定记录本身被删除」的留痕，**常规读路径一律带
-- `deleted_at IS NULL`**（用 core/trash.ts 的 liveFilter('position_template_doc', ...)）。
-- 但**解绑走的是真删**（见 domain/service.ts 的 setPositionDocTemplates 注释）：
-- 绑定是配置不是用户资产，且 `UNIQUE(position_template_id, template_id)` 配上
-- 「软删后重绑」要额外做一次复活，会多出一类"库里躺着已删行但界面看不到"的半截状态。
-- 于是 `deleted_by` / `delete_reason` 与 docs/11 的写法保持一致先建出来（将来要改成
-- 软删留痕不必再来一次迁移），当前只有 `deleted_at` 会被读过滤用到。
--
-- 【外键与级联】模板被删 → 绑定跟着走（ON DELETE CASCADE）；阶段模板归档/删除 → 同理。
-- 但 `template` 与 `position_template` 的「删除」在本项目里大多是 **`archived_at` 归档**
-- （不是 DELETE），归档不会触发级联 —— 那种情况下绑定行仍在，由
-- `listPositionDocTemplates()` 把它标成 `missing: true` 并在界面上说
-- 「引用的模板已删除，请重新选择」，**不静默消失**（docs/11 B2-7 风险②）。

CREATE TABLE position_template_doc (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  position_template_id INTEGER NOT NULL REFERENCES position_template(id) ON DELETE CASCADE,
  template_id          INTEGER NOT NULL REFERENCES template(id) ON DELETE CASCADE,
  required             INTEGER NOT NULL DEFAULT 0,   -- 是否本阶段必须出具
  seq                  INTEGER NOT NULL DEFAULT 100,
  note                 TEXT,
  deleted_at           TEXT,
  deleted_by           TEXT,
  delete_reason        TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (position_template_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_ptdoc_pos ON position_template_doc(position_template_id, seq);
