-- 档案带入体系（D 地基）
--
-- 目标：让「同一个项目的信息，填一次，后面所有模板自动带出」。
--
-- 设计原则（重要）：
--   1. 字段集不预设。只种少量「系统必备字段」（跨所有工作类型都成立的），
--      其余字段由运行中的 AI 读模板后提议、用户确认，逐步长出来。
--   2. field_key 是契约。模板变量一旦映射到某个 key，这个 key 的含义就固定了。
--      AI 可以新增字段、可以提别名，但不得改名/删除/改变已有 key 的含义。
--   3. 档案值不新增存储，存进 workbench.profile（JSON 桶，已有列）。
--      字段由用户自定义，加字段不必改表结构。

-- 档案字段定义：一个字段 = 一组同义变量名的统一归口
CREATE TABLE archive_field (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_type_id  INTEGER REFERENCES work_type(id) ON DELETE CASCADE,
                -- NULL = 跨类型通用字段；非 NULL = 该类型专有
  field_key     TEXT NOT NULL,                      -- 程序用，如 party_a_name，稳定不改
  label         TEXT NOT NULL,                      -- 界面显示，如「建设单位 / 发包人」
  type          TEXT NOT NULL DEFAULT 'text',       -- text|longtext|date|money|number|percent|enum
  required      INTEGER NOT NULL DEFAULT 0,
  example       TEXT,
  hint          TEXT,
  seed          INTEGER NOT NULL DEFAULT 0,         -- 1 = 系统必备字段（不是 AI 提议的）
  origin        TEXT NOT NULL DEFAULT 'seed',       -- seed | ai | user
  -- 该字段在不同工作类型下的称谓，JSON 数组，如 ["发包人","建设单位","采购单位"]
  -- 仅用于界面提示「填这一个，这些称谓都通」，不参与取值
  aliases_label TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_archive_field_key ON archive_field(COALESCE(work_type_id, 0), field_key);
CREATE INDEX idx_archive_field_wt ON archive_field(work_type_id, sort_order);

-- 变量别名映射：模板里的 {变量名} → 取哪个档案字段的值
CREATE TABLE archive_alias (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_type_id  INTEGER REFERENCES work_type(id) ON DELETE CASCADE,
                -- NULL = 全局通用；非 NULL = 该类型专有（优先匹配）
  var_name      TEXT NOT NULL,                      -- 模板里的变量名，不含花括号
  field_key     TEXT NOT NULL,                      -- → archive_field.field_key
  confidence    TEXT NOT NULL DEFAULT 'manual',     -- manual | ai | seed
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_archive_alias_uniq ON archive_alias(COALESCE(work_type_id, 0), var_name);
CREATE INDEX idx_archive_alias_var ON archive_alias(var_name);

-- AI 提议的待确认项（字段新增 / 别名映射 / 档案取值）
-- 铁律：AI 只提案，用户确认后才落盘
CREATE TABLE archive_proposal (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workbench_id  INTEGER REFERENCES workbench(id) ON DELETE CASCADE,   -- 取值类提议才有
  work_type_id  INTEGER REFERENCES work_type(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                      -- field | alias | value
  payload       TEXT NOT NULL,                      -- JSON：提议内容
  source        TEXT,                               -- 出处：文件名 + 位置 / 模板名
  reason        TEXT,                               -- AI 为什么这么提
  status        TEXT NOT NULL DEFAULT 'pending',    -- pending | accepted | rejected
  batch_id      TEXT,                               -- 同一轮梳理的提议归一批，便于批量确认
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_archive_proposal_status ON archive_proposal(work_type_id, status);
CREATE INDEX idx_archive_proposal_batch ON archive_proposal(batch_id);
