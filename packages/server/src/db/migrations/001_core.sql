-- ============================================================
-- 001 核心表结构
-- 说明见 docs/01-系统设计.md 第 4 节
-- ============================================================

-- ---------- 配置类 ----------

CREATE TABLE app_setting (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  value_type  TEXT NOT NULL DEFAULT 'string',   -- string | number | boolean | json
  scope       TEXT NOT NULL DEFAULT 'app',      -- app | secret
  label       TEXT,
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE work_type (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'admin',    -- admin 行政管理 | project 项目实施
  description TEXT,
  icon        TEXT,
  color       TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ai_provider (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url      TEXT NOT NULL,
  api_key       TEXT,
  api_key_env   TEXT,                            -- 用环境变量提供 key 时填变量名
  extra_headers TEXT,                            -- JSON 对象
  enabled       INTEGER NOT NULL DEFAULT 1,
  is_builtin    INTEGER NOT NULL DEFAULT 0,      -- 预置模板，可改不可删
  remark        TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ai_profile (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose       TEXT NOT NULL UNIQUE,            -- writing | extract | reasoning | vision | embedding
  name          TEXT NOT NULL,
  provider_id   INTEGER REFERENCES ai_provider(id) ON DELETE SET NULL,
  model         TEXT,
  temperature   REAL NOT NULL DEFAULT 0.2,
  max_tokens    INTEGER NOT NULL DEFAULT 4096,
  timeout_ms    INTEGER NOT NULL DEFAULT 120000,
  embedding_dim INTEGER,
  extra_body    TEXT,                            -- JSON，透传给接口
  note          TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE prompt_template (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  purpose     TEXT NOT NULL DEFAULT 'writing',
  system_text TEXT,
  user_text   TEXT NOT NULL,
  description TEXT,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- 流程规范类 ----------

CREATE TABLE position_template (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  work_type_id  INTEGER NOT NULL REFERENCES work_type(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 1,
  folder_name   TEXT,                            -- 该阶段在项目文件夹里的子目录名
  description   TEXT,
  duration_hint TEXT,                            -- 建议工期，如 "3-5 个工作日"
  sort_order    INTEGER NOT NULL DEFAULT 100,
  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (work_type_id, code)
);

-- 模板表放在材料清单之前，便于 material_check 引用
CREATE TABLE template (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',         -- general | admin | project
  work_type_id  INTEGER REFERENCES work_type(id) ON DELETE SET NULL,
  position_code TEXT,                                    -- 可选：绑定到某个阶段编码
  file_rel      TEXT NOT NULL,                           -- 相对数据目录的模板文件
  file_format   TEXT NOT NULL,                           -- docx | xlsx | doc | xls | pdf | other
  vars_rel      TEXT,                                    -- 同名 .vars.json
  variable_count INTEGER NOT NULL DEFAULT 0,
  doc_no        TEXT,                                    -- 文号规则
  description   TEXT,
  usage_note    TEXT,
  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_template_cat ON template(category, work_type_id);

CREATE TABLE material_check (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  position_template_id INTEGER NOT NULL REFERENCES position_template(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL DEFAULT 'material', -- doc 文档 | material 材料 | form 表单 | record 记录
  template_id          INTEGER REFERENCES template(id) ON DELETE SET NULL,
  required             INTEGER NOT NULL DEFAULT 1,
  retention            TEXT,                             -- 留存说明
  hint                 TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 100,
  archived_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE evidence_rule (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  position_template_id INTEGER NOT NULL REFERENCES position_template(id) ON DELETE CASCADE,
  title                TEXT NOT NULL,
  min_count            INTEGER NOT NULL DEFAULT 1,
  max_count            INTEGER,
  shooting_points      TEXT,                             -- 拍摄要点
  angles               TEXT,                             -- 建议角度
  required             INTEGER NOT NULL DEFAULT 1,
  sample_artifact_id   INTEGER,
  hint                 TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 100,
  archived_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------- 工作台实例类 ----------

CREATE TABLE workbench (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,                  -- 如 2026-001
  name            TEXT NOT NULL,
  work_type_id    INTEGER NOT NULL REFERENCES work_type(id) ON DELETE RESTRICT,
  status          TEXT NOT NULL DEFAULT 'active',        -- active | paused | done | archived
  priority        TEXT NOT NULL DEFAULT 'normal',        -- low | normal | high | urgent
  owner           TEXT,
  counterpart     TEXT,                                  -- 甲方/对接单位
  contract_no     TEXT,
  contract_amount REAL,
  start_date      TEXT,
  plan_end_date   TEXT,
  actual_end_date TEXT,
  folder_path     TEXT NOT NULL,                         -- 相对数据目录
  summary         TEXT,
  tags            TEXT,                                  -- JSON 数组
  profile         TEXT,                                  -- JSON 对象：项目档案字段（甲方、地点、设备…）
  progress        INTEGER NOT NULL DEFAULT 0,            -- 0-100
  archived_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_workbench_type   ON workbench(work_type_id, status);
CREATE INDEX idx_workbench_status ON workbench(status, updated_at DESC);

CREATE TABLE position_instance (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  workbench_id         INTEGER NOT NULL REFERENCES workbench(id) ON DELETE CASCADE,
  position_template_id INTEGER REFERENCES position_template(id) ON DELETE SET NULL,
  code                 TEXT NOT NULL,
  name                 TEXT NOT NULL,
  seq                  INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'pending',  -- pending | doing | blocked | done | skipped
  started_at           TEXT,
  finished_at          TEXT,
  owner                TEXT,
  note                 TEXT,
  folder_rel           TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 100,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (workbench_id, code)
);
CREATE INDEX idx_position_instance_wb ON position_instance(workbench_id, seq);

CREATE TABLE checklist_item (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  position_instance_id INTEGER NOT NULL REFERENCES position_instance(id) ON DELETE CASCADE,
  kind                 TEXT NOT NULL,                    -- material | evidence
  source_id            INTEGER,                          -- 来自哪条规则
  title                TEXT NOT NULL,
  detail               TEXT,
  required             INTEGER NOT NULL DEFAULT 1,
  min_count            INTEGER NOT NULL DEFAULT 1,       -- 影像类：最少张数
  status               TEXT NOT NULL DEFAULT 'todo',     -- todo | doing | done | na
  done_count           INTEGER NOT NULL DEFAULT 0,
  done_at              TEXT,
  done_by              TEXT,
  note                 TEXT,
  sort_order           INTEGER NOT NULL DEFAULT 100,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_checklist_pos ON checklist_item(position_instance_id, kind, sort_order);

-- ---------- 模板与产出 ----------

CREATE TABLE artifact (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workbench_id    INTEGER REFERENCES workbench(id) ON DELETE CASCADE,
  position_code   TEXT,
  kind            TEXT NOT NULL DEFAULT 'generated',     -- generated 生成 | evidence 证据影像 | source 原始资料 | scan 扫描件 | template 模板 | other
  title           TEXT NOT NULL,
  file_rel        TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  file_ext        TEXT,
  mime            TEXT,
  size_bytes      INTEGER,
  sha256          TEXT,
  template_id     INTEGER REFERENCES template(id) ON DELETE SET NULL,
  checklist_item_id INTEGER REFERENCES checklist_item(id) ON DELETE SET NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  doc_date        TEXT,
  captured_at     TEXT,                                  -- 影像拍摄时间（EXIF）
  exif            TEXT,                                  -- JSON：设备、GPS、尺寸
  extracted_text  TEXT,                                  -- 抽出的纯文本（供检索）
  ocr_text        TEXT,
  ocr_status      TEXT,                                  -- none | pending | done | failed | skipped
  summary         TEXT,
  tags            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_artifact_wb   ON artifact(workbench_id, kind, created_at DESC);
CREATE INDEX idx_artifact_item ON artifact(checklist_item_id);

CREATE TABLE generation_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  workbench_id   INTEGER REFERENCES workbench(id) ON DELETE SET NULL,
  template_id    INTEGER REFERENCES template(id) ON DELETE SET NULL,
  artifact_id    INTEGER REFERENCES artifact(id) ON DELETE SET NULL,
  profile_purpose TEXT,
  variables      TEXT,                                   -- JSON：本次填的变量
  mode           TEXT NOT NULL DEFAULT 'ai',             -- ai | manual | hybrid
  status         TEXT NOT NULL DEFAULT 'ok',             -- ok | failed
  message        TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ai_call_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose       TEXT,
  provider_code TEXT,
  model         TEXT,
  mode          TEXT,                                    -- chat | json | vision | embedding
  ok            INTEGER NOT NULL DEFAULT 1,
  latency_ms    INTEGER,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens  INTEGER,
  error_code    TEXT,
  error_message TEXT,
  ref_type      TEXT,
  ref_id        INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_ai_call_log_time ON ai_call_log(created_at DESC);

-- ---------- 知识库（最后阶段启用，先把结构留好） ----------

CREATE TABLE kb_document (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id   INTEGER REFERENCES artifact(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  doc_type      TEXT,                                    -- 制度 | 规范 | 合同 | 纪要 | 图纸 | 其他
  work_type_id  INTEGER REFERENCES work_type(id) ON DELETE SET NULL,
  source        TEXT,                                    -- _规范库 / 手工上传 …
  chunk_count   INTEGER NOT NULL DEFAULT 0,
  embedded_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE kb_chunk (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES kb_document(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 1,
  heading      TEXT,
  content      TEXT NOT NULL,
  tokens       INTEGER,
  embedding    BLOB,
  embedding_model TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_kb_chunk_doc ON kb_chunk(document_id, seq);
