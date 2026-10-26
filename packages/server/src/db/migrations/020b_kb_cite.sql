-- ============================================================
-- 020b 条款级引用 + 出文书前口径校验（B3-9）
--
-- 【编号说明】docs/11 §10.1 把 B3-9 的迁移写成「020 或文档指派号」，但 020 已被
-- B4-11 的 app_health_event 占用，021 又被本文指派给 B3-10（doc_kb_link /
-- kb_change_impact）。所以本条取 **020b**：
--   · 文件名字典序在 `020_app_health_event.sql` 之后、`021_*` 之前（'_' 0x5F < 'b' 0x62），
--     迁移执行器（db/migrate.ts）按文件名排序，索引一致；
--   · 不占用任何整数号，B3-10 落地时仍用 021（与 docs/11 §10.1 的承诺一致）。
-- 差异已写回 docs/11 §10.1（本文的「对账约定」：以实际落地物为准并写回）。
--
-- 本迁移只**新建两张表**，不动任何既有表：
--   · compliance_rule       口径校验规则（数据化：severity/enabled 改了立刻生效，不改代码）
--   · compliance_exception  例外放行留痕（谁、何时、以什么理由放行了哪条规则 —— B1-3 审计页要看）
--
-- 【列按实际读写来定】教训见 docs/15 §二.3：草稿 DDL 里"NOT NULL 且无默认值"的列会变成运行时的坑。
-- 这里除了 code/name/severity/kind/message 这几列（种子数据每条都有值、业务上也不允许为空）之外，
-- 一律允许为空并给默认值。
--
-- 【种子规则分两类】
--   · implemented=1（checker 已实现，本迁移落地 5 条）：条款级引用的口径校验，随文书生成前运行；
--   · implemented=0（docs/11 B3-9 表里的 12 条公文惯例规则，**先做草案给人改**）：
--     这些规则的检查逻辑尚未实现，`enabled` 一律 0。规则接口（PUT /api/kb/compliance/rules/:code）
--     会**明确拒绝启用未实现的规则**，而不是让它"启用了却永远不响"——
--     docs/11 风险③"求值器写错导致规则静默失效"就是这么防的。
--     `implemented` 是**元数据列**：它记的是"检查逻辑有没有实现"，不是"用户开没开"。
--     真实的草案确认动作是：实现了对应 checker 之后把 implemented 置 1，再由用户启用。
-- ============================================================

CREATE TABLE IF NOT EXISTS compliance_rule (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  code                 TEXT NOT NULL UNIQUE,     -- 规则码，如 CITE_CLAUSE_MISSING
  name                 TEXT NOT NULL,            -- 人话名字，界面直接显示
  scope_work_type_ids  TEXT,                     -- JSON 数组；空 = 全部工作类型
  scope_template_ids   TEXT,                     -- JSON 数组；空 = 全部模板
  severity             TEXT NOT NULL,            -- block（拦下，不许保存）| warn（提示）| info
  kind                 TEXT NOT NULL,            -- builtin（引擎内置）| custom（受限表达式，未实现）
  checker              TEXT,                     -- 内置检查函数名；custom 为 'expr'
  expr                 TEXT,                     -- 受限表达式（绝不 eval；本迁移不种任何 expr）
  params               TEXT,                     -- JSON 参数（阈值/正则等）
  message              TEXT NOT NULL,            -- 人话说明
  fix_hint             TEXT,                     -- 怎么改
  enabled              INTEGER NOT NULL DEFAULT 1,
  implemented          INTEGER NOT NULL DEFAULT 0,
  sort_order           INTEGER NOT NULL DEFAULT 100,
  origin               TEXT,                     -- 出处（docs 章节/规则草案来源），便于追溯
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_compliance_rule_enabled ON compliance_rule(enabled, sort_order);

CREATE TABLE IF NOT EXISTS compliance_exception (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_code    TEXT NOT NULL,                    -- 放行的是哪条规则
  artifact_id  INTEGER,                          -- 放行后落盘的文书（保存成功时回填）
  template_id  INTEGER,
  workbench_id INTEGER,
  clause_path  TEXT,                             -- 涉及哪一条（条款类规则才有）
  severity     TEXT,                             -- 放行时的级别快照（当时是 block 还是 warn）
  reason       TEXT NOT NULL,                    -- 人写的例外说明（必填）
  actor        TEXT,                             -- 谁
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_compliance_exception_artifact ON compliance_exception(artifact_id);
CREATE INDEX IF NOT EXISTS idx_compliance_exception_code ON compliance_exception(rule_code, created_at);

-- ---------- 已实现的 5 条：条款级引用与口径 ----------
-- sort_order 10–19：先跑引用解析类（悬空/失效/未入库），再跑跨条款冲突与变量比对。

INSERT OR IGNORE INTO compliance_rule
  (code, name, severity, kind, checker, message, fix_hint, enabled, implemented, sort_order, origin)
VALUES
  ('CITE_CLAUSE_MISSING', '引用的条款在制度库里找不到', 'block', 'builtin', 'cite_clause_missing',
   '文书里引用的条款（如《XX办法》第五条）在这份制度里找不到 —— 引用是悬空的，交出去对方按条号核对会查不到。',
   '核对条号是否写错（第五条/第5条/第5款），或到「知识库」确认这份制度已抽取入库；确实要引用外部文件的，把该文件导入知识库。',
   1, 1, 10, 'docs/11 B3-9 §怎么做（引用悬空）'),

  ('CITE_CLAUSE_SUPERSEDED', '引用的条款来自已被替换/未纳入的版本', 'block', 'builtin', 'cite_clause_superseded',
   '文书引用的条款所在的那一版制度是上会稿/历史稿（或按当前抽取口径未入库）—— 依据可能已经变了。',
   '换成现行版/定稿版的同一条款，或到「知识库」用当前口径重新抽取后再出文书。',
   1, 1, 11, 'docs/15 §三·补二（版本口径：上会稿被当依据是最大的假阳性来源）'),

  ('CITE_CONFLICT', '同一事项引用了两个互相冲突的口径', 'block', 'builtin', 'cite_conflict',
   '同一份文书里对同一事项引用了两个不同的数字口径 —— 这类冲突是公文被退回的典型原因。',
   '确认以哪一份制度为准（通常本单位细则 > 上级办法），删掉另一处引用或改成一致的口径。',
   1, 1, 12, 'docs/09 §4.6.4（口径校验规则引擎）'),

  ('CITE_VALUE_MISMATCH', '变量值与所引条款的关键数字/期限不一致', 'block', 'builtin', 'cite_value_mismatch',
   '文书里填的数字与该文书引用的条款规定的数字/期限不一致 —— 依据说一套、正文写另一套。',
   '按所引条款改正文里的数字，或改引用（引错了条款）。',
   1, 1, 13, 'docs/09 §4.6.4（口径校验规则引擎）'),

  ('CITE_SOURCE_UNINDEXED', '引用的制度未入库，无法核对', 'warn', 'builtin', 'cite_source_unindexed',
   '文书引用的这份制度还没有进知识库 —— 系统核对不了它的条号，只能提示。',
   '到「知识库」把这份制度（来源目录或上传）导入并抽取，之后出文书就能核对到条款出处。',
   1, 1, 14, 'docs/11 B3-9 §怎么做（引用的制度未入库）');

-- ---------- 草案 12 条（docs/11 B3-9 表 + docs/09 §4.6.4 的清单）----------
-- **enabled=0 + implemented=0**：规则先摆出来给人逐条确认/改写（docs/11 原话：
-- "必须由用户逐条确认或改写后才算数"）。检查逻辑未实现，接口会拒绝启用。

INSERT OR IGNORE INTO compliance_rule
  (code, name, severity, kind, checker, message, fix_hint, enabled, implemented, sort_order, origin)
VALUES
  ('AMOUNT_CASE', '合同金额大小写一致', 'block', 'builtin', 'amount_cn_case',
   '合同金额的大写与小写不一致（含换算校验）。', '按合同原件核对金额大小写，改到一致。',
   0, 0, 110, 'docs/11 B3-9 表（草案）'),
  ('DATE_ORDER', '日期序列合法', 'block', 'builtin', 'date_order',
   '日期序列不合法：签订 ≤ 开工 ≤ 竣工 ≤ 今天。', '核对签订日/开工日/竣工日，按实际发生时间改。',
   0, 0, 111, 'docs/11 B3-9 表（草案）'),
  ('DATE_NOT_BEFORE_START', '报审/验收日期不早于开工日', 'block', 'builtin', 'date_not_before_start',
   '报审或验收日期早于开工日。', '核对报审/验收日期与开工日。',
   0, 0, 112, 'docs/11 B3-9 表（草案）'),
  ('ATTACHMENT_MATCH', '报审附件名与清单一致', 'block', 'builtin', 'attachment_match',
   '报审附件名与清单不一致、数量不相符。', '逐个核对附件名与份数。',
   0, 0, 113, 'docs/11 B3-9 表（草案）'),
  ('HEAD_COUNT', '人数/份数合计与明细相符', 'block', 'builtin', 'head_count',
   '人数或份数的合计与明细对不上。', '按明细重算合计。',
   0, 0, 114, 'docs/11 B3-9 表（草案）'),
  ('REQUIRED_FIELD', '必填字段不得为空、不得为待补', 'block', 'builtin', 'required_field',
   '金额/日期/编号这类只读字段为空，或还是【待补】。', '把【待补】换成实际内容。',
   0, 0, 115, 'docs/11 B3-9 表（草案）'),
  ('PAGE_COUNT', '"共 X 页"与已知页数一致', 'warn', 'builtin', 'page_count',
   '"共 X 页"与实际页数不符（需要模板里给了页数变量才算）。', '按实际页数改，或删掉页数表述。',
   0, 0, 116, 'docs/11 B3-9 表（草案；依赖真实分页，暂不做）'),
  ('NUMBER_FORMAT', '编号格式符合单位规则', 'warn', 'builtin', 'number_format',
   '编号格式不符合单位规则（如 HT-YYYY-NNN）。', '按单位编号规则改。',
   0, 0, 117, 'docs/11 B3-9 表（草案）'),
  ('NAME_CONSISTENCY', '同一主体全篇用同一名字', 'warn', 'builtin', 'name_consistency',
   '同一主体在文书里混用了简称与全称。', '统一用一个名字（首次出现写全称）。',
   0, 0, 118, 'docs/11 B3-9 表（草案）'),
  ('UNIT_CONSISTENCY', '单位与数量配套', 'warn', 'builtin', 'unit_consistency',
   '有数量没有单位（或单位与数量不配套）。', '给数量补上单位。',
   0, 0, 119, 'docs/11 B3-9 表（草案）'),
  ('PERIOD_MATCH', '期次与文书日期同属一期', 'warn', 'builtin', 'period_match',
   '期次与文书日期不属于同一期。', '核对期次与日期。',
   0, 0, 120, 'docs/11 B3-9 表（草案）'),
  ('SIGN_DATE_PRESENT', '落款日期已填', 'warn', 'builtin', 'sign_date_present',
   '落款日期没填。', '补上落款日期。',
   0, 0, 121, 'docs/11 B3-9 表（草案）');
