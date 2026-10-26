-- 知识库来源目录（契约 §2 数据模型 / §1 决定 3、7）
--
-- 本阶段**只搭框架**：登记「制度汇总文件夹」这一个只读来源，显示文件数与总大小。
-- 明确不做的事（决定 7）：
--   * 不抽取内容：不产生 kb_document / kb_chunk，不抽文字、不算 sha256、不触发 iCloud 下载；
--   * 不写入来源目录：只 readdir + stat 读元数据，不建目录、不写文件、不改文件名。
-- 内容抽取要等工作台侧确认无误后再启用（doc 10 的第 4 步实施项）。
--
-- 路径入库前用 realpathSync 规范化（解析 `..`、短名、符号链接），所以同一目录
-- 不会因为写法不同而登记成两条；绑定时另行拒绝「不存在 / 非目录 / 在 DATA_ROOT 内部」。
--
-- 表名与字段沿用契约 §2 的原样定义（010 迁移的注释里已说明 kb_source 由 S4 的迁移负责）。

CREATE TABLE IF NOT EXISTS kb_source (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT NOT NULL UNIQUE,   -- 绝对路径（realpath 规范化后）
  label        TEXT,                   -- 显示名，缺省取末段目录名
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  last_scan_at TEXT,                   -- 上次统计时间（只记元数据）
  file_count   INTEGER NOT NULL DEFAULT 0,
  total_bytes  INTEGER NOT NULL DEFAULT 0
);
