-- 工作类型驱动方式 + 周期性工作
--
-- 系统里有两类截然不同的工作，之前被套进了同一个模子：
--   项目工作     流程驱动 —— 按阶段推进（工程类 19 阶段 / 信息化类 12 / 服务类 4）
--   行政管理工作  时间驱动 —— 按月/按季度的周期到了就填一份
--
-- 「清廉工程按月填」「工时表按月报」属于后者：它没有阶段序列，
-- 需要的是「到时间提醒我」，而不是「走到第几步了」。

-- ---------- 工作类型的驱动方式 ----------
-- process  流程驱动：有阶段序列，逐阶段推进（项目三类）
-- document 文书驱动：没有阶段，按模板直接出文书（行政管理）
ALTER TABLE work_type ADD COLUMN mode TEXT NOT NULL DEFAULT 'process';

-- ---------- 周期性工作 ----------
-- 只有行政管理工作用得上；项目工作这几列留空。
ALTER TABLE workbench ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'once';
  -- once 单次 | monthly 每月 | quarterly 每季度 | yearly 每年
ALTER TABLE workbench ADD COLUMN recur_day INTEGER;
  -- 每月/每季度做事的日号（1-28，避开月末不存在的日期）
ALTER TABLE workbench ADD COLUMN recur_month INTEGER;
  -- yearly 时的月份（1-12）
ALTER TABLE workbench ADD COLUMN last_done_at TEXT;
  -- 上次完成时间，用于算下一期
ALTER TABLE workbench ADD COLUMN remind_days INTEGER NOT NULL DEFAULT 3;
  -- 提前几天开始提醒

CREATE INDEX idx_workbench_recur ON workbench(recurrence, status);

-- 把已有的行政管理工作标成文书驱动
UPDATE work_type SET mode = 'document' WHERE code = 'admin';
