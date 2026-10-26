# 工作台

> 2026-10-26目录清理：源码采用已下载云端提交77887a6；.git及原本地差异已在项目外备份，当前目录无Git仓库。当前设备仍为ui-design-20261024-r1，本文其他设备的发布描述保留原范围。后续Git同步需另行恢复或建立仓库；本次记录见[CHANGELOG](docs/management/CHANGELOG.md)。

本地运行的行政管理与项目实施工具，用于工作与期次管理、模板文书生成、资料检索、部门工时和 AI 辅助材料准备。

文档更新：2026-10-24。当前文档按项目范围、需求、设计、实施、验收、发布和维护分层整理；原始报告保留，可追溯到代码和历史证据。

## 从哪里开始

| 你要做什么 | 阅读入口 |
|---|---|
| 让其他 AI 接手 | [AI 接续入口](GPT_CONTEXT.md) → [仓库约定](AGENTS.md) |
| 浏览所有项目资料 | [文档总览与完整目录](docs/README.md) |
| 了解用途、范围和责任 | [项目章程](docs/management/PROJECT_CHARTER.md) |
| 了解业务与功能要求 | [业务术语](CONTEXT.md)、[产品需求与追溯矩阵](PRODUCT_REQUIREMENTS.md) |
| 查看当前版本、进度和下一步 | [开发进度](DEVELOPMENT_PROGRESS.md)、[项目计划](docs/management/PROJECT_PLAN.md) |
| 查看每次修改和手动Git同步范围 | [变更记录](docs/management/CHANGELOG.md)、[任务收尾规范](docs/management/DOCUMENT_CONTROL.md)、[换机清单](docs/guides/DEVICE_HANDOFF.md) |
| 日常使用 | [使用说明](docs/guides/USER_GUIDE.md) |
| 开发、测试与接口定位 | [系统架构](SYSTEM_ARCHITECTURE.md)、[开发指南](docs/guides/DEVELOPMENT.md)、[数据与接口](docs/reference/DATA_AND_API.md) |
| 启动、备份、恢复或发布 | [运维与发布手册](docs/guides/OPERATIONS.md) |
| 自动检索知识 | [机器可读文档索引](docs/knowledge-index.json)、[源码结构索引](docs/reference/source-inventory.json) |

## 当前状态

2026-10-24的发布记录为 `ui-design-20261024-r1`，基础包为 `monthly-workspaces-20261021-r1`。运行快照记录8787健康200、加载摘要匹配；迁移包含039、040，不含038。之后仅清理两项业务，未重置模板和配置。详见[当前进度](DEVELOPMENT_PROGRESS.md)、[运行快照](docs/reference/current-baseline.json)和[发布报告45](docs/45-前台设计限定发布-2026-10-24.md)。本轮文档整改没有重新执行运行验收。

- 已发布：导航、模板、共享草稿、月度工时及年度台账/两表联动，另含GOV-13前台设计和紧凑布局。操作见[月度工作指南](docs/guides/MONTHLY_DEVELOPMENT.md)，发布边界见报告45。
- 未发布：工作记录038及其他工作区候选改动。
- 待验收：真实模型、完整Office/业务流程、全部月份核对和其他页面完整逐图还原。报告44的原生Excel检查及报告45的22组界面检查只覆盖各自范围。整数小时算法仍待落实，保留原9月文件。
- 当前产品帮助准备和生成材料，不管理是否报送；旧报送数据保留。

以上是注明日期的快照，不能代替下一次任务的运行核对。

## 启动与运行

环境要求以 [package.json](package.json) 为准：Node.js ≥24，npm workspaces。首次安装与开发配置见[开发指南](docs/guides/DEVELOPMENT.md)。

现有日常环境通过 `启动工作台.cmd` 或下列命令启动，通常访问 [本机工作台](http://127.0.0.1:8787)：

```powershell
npm start
```

启动器选择已审核的独立发布包，并使用原数据目录；启动可能执行该包迁移。已有实例运行时不要为读取文档重复启动。直接运行源码会绕过发布选择，未发布功能须在隔离环境验证。

业务文件与 SQLite 关系数据共同构成完整资料。自动数据库备份不包含全部业务文件，完整恢复见运维手册。

## 文档维护

每次任务结束保存本地文件、同步五份根文档并填写变更记录。用户手动推送Git；默认不自动暂存、提交或推送。规范及状态定义见[文档治理](docs/management/DOCUMENT_CONTROL.md)。

```powershell
node scripts/docs-maintenance.mjs generate
node scripts/docs-maintenance.mjs check
```

生成命令只刷新文档目录、文档索引和静态代码索引；检查命令验证索引时效、本地文档链接和必要元数据，不运行应用或修改业务数据。旧版本根文档保存在[历史快照](docs/archive/2026-10-21-before-knowledge/README.md)。
