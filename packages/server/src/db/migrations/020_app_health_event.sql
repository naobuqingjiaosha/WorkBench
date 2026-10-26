-- 020 健康事件表 app_health_event（B4-11 崩溃自愈 / 看门狗）
--
-- 背景：`core/health.ts` 已经实现"异常事件"的内存环形缓冲 + 可选持久化，
-- 但它**刻意不建表**（表不存在时静默降级为仅内存，重启即清零，只在启动日志里说一行原因）。
-- 这份迁移就是它等的那个"表一落地、代码零改动自动启用"的物化步骤：
-- **不需要改 health.ts 一个字**，它启动时用 `PRAGMA table_info(app_health_event)` 探到这张表就自动开始落库，
-- `/api/health` 的 `events` / `uncaughtCount24h` 从此跨重启可见。
--
-- 【为什么只有这几列 —— 与 docs/11 草拟写法的差异（这里是有意的）】
-- `docs/11` §7 B4-11 当初草拟的是
--     app_health_event(id, kind, message, stack, count, created_at, seen_at)
-- 其中 `count`（同 kind+message 合并计数）在草稿里是 **NOT NULL 且无默认值** 的形态。
-- 而 health.ts 的 `persistEvent()` 实际只插三到四列，且列名按探测结果现拼：
--     INSERT INTO app_health_event (<at|created_at>, kind, message[, <stack_head|stack>])
--   · `at`        = `at`（探测到 `at` 就用 `at`，否则退回 `created_at`）
--   · `stack_head`= `stack_head`（探测到 `stack_head` 就用它，否则退回 `stack`，都没有就不插这一列）
-- 所以本表**绝不能有"NOT NULL 且无默认值"的、health.ts 不插的列**：
-- 那样每条 INSERT 都会因 NOT NULL 约束失败，health.ts 连续失败 5 次
-- （`MAX_PERSIST_FAILURES`）后就把 `persistState` 永久降级为 `memoryOnly`，
-- 于是"事件跨重启保留"这个功能的一半价值直接消失，而表面上**没有任何报错**（只多一行启动警告）。
-- ⇒ 本迁移的列**严格按实际 INSERT 语句来定**，一个多余的列都不加：
--   · 不需要 `count`/`seen_at`：合并计数与"已读"尚未实现，先建成 NOT NULL 只会变成坑；
--     真要做时用 `ALTER TABLE ... ADD COLUMN count INTEGER NOT NULL DEFAULT 0` 另开一份迁移（有默认值才安全）。
--   · 不需要 `created_at`/`stack`：探测是二选一的兼容写法，全建出来只会让人分不清哪列才是权威。
--   · `stack_head` 可空，且 health.ts 只在 `event.stackHead` 非空时才写它 —— 可空是硬要求。
--
-- 【幂等】迁移执行器（db/migrate.ts）按 `schema_migration.version` 记已执行版本，正常只会跑一次；
-- 这里仍用 `IF NOT EXISTS`，是为了"手工对着既有库补跑一遍"也不会炸。
-- **不改动任何既有表**：本文件只创建这一张新表与它的索引。
--
-- 与 health.ts 头部注释里那份期望 DDL 逐列一致（id/at/kind/message/stack_head）。

CREATE TABLE IF NOT EXISTS app_health_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,   -- ISO 时间戳（与项目其它表同一口径，用 ISO 字符串比较即得时间序）
  kind       TEXT NOT NULL,   -- uncaughtException | unhandledRejection | ocrFailure | selfCheckFailed
  message    TEXT NOT NULL,   -- 一行摘要（health.ts 已截断到 300 字）
  stack_head TEXT             -- 堆栈开头（可空；仅 uncaughtException/unhandledRejection 会带）
);

-- 按时间倒序取最近事件（recentHealthEvents 的 `ORDER BY <at> DESC LIMIT ?`）走这条索引。
CREATE INDEX IF NOT EXISTS idx_app_health_event_at ON app_health_event(at DESC);

-- 24 小时未捕获异常计数（`WHERE kind = 'uncaughtException' AND <at> > ?`）走这条复合索引。
CREATE INDEX IF NOT EXISTS idx_app_health_event_kind_at ON app_health_event(kind, at);
