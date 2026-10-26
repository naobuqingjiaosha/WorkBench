-- 006 AI 助手：对话、待确认动作、记忆
--
-- 设计要点：
--   1. 所有写入都先落成 agent_action（status=pending），用户确认后才真正执行 ——
--      「AI 只提议、人来拍板」这条底线在对话式交互里同样成立。
--   2. 记忆（agent_memory）不是摆设：对话和出文书时都会把相关的几条注入提示词，
--      这样「临时补充的信息」才会在以后真正被用上。
--   3. 每次动作都留痕（工具、参数、结果、谁确认的），出问题能倒查。

CREATE TABLE agent_session (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '新对话',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE agent_message (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER NOT NULL REFERENCES agent_session(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                     -- user | assistant | tool
  content     TEXT NOT NULL DEFAULT '',
  -- 这一轮模型请求调用的工具（JSON 数组），用于界面回放
  tool_calls  TEXT,
  model       TEXT,
  tokens      INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_agent_message_session ON agent_message(session_id, id);

CREATE TABLE agent_action (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  INTEGER REFERENCES agent_session(id) ON DELETE CASCADE,
  message_id  INTEGER REFERENCES agent_message(id) ON DELETE SET NULL,
  tool        TEXT NOT NULL,                     -- 工具名
  payload     TEXT NOT NULL,                     -- 参数（JSON）
  summary     TEXT NOT NULL DEFAULT '',          -- 给人看的一句话
  risk        TEXT NOT NULL DEFAULT 'normal',    -- normal | destructive
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | applied | discarded | failed
  result      TEXT,                              -- 执行结果（JSON）
  error       TEXT,
  applied_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_agent_action_session ON agent_action(session_id, id);
CREATE INDEX idx_agent_action_status ON agent_action(status);

CREATE TABLE agent_memory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  text          TEXT NOT NULL,                   -- 记住了什么（人话）
  tags          TEXT,                            -- JSON 数组，便于匹配
  workbench_id  INTEGER REFERENCES workbench(id) ON DELETE CASCADE,
  due_date      TEXT,                            -- 有期限的事
  source        TEXT,                            -- 从哪来的：对话/用户手填
  status        TEXT NOT NULL DEFAULT 'active',  -- active | archived
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_agent_memory_wb ON agent_memory(workbench_id, status);
