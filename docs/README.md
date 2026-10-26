# 项目知识与文档总览

文档ID：KB-INDEX。索引体系初始基线：2026-10-21，不表示本轮生成或运行验证日期。由 scripts/docs-maintenance.mjs 自动生成，请修改对应主文档后重新生成。

第一次接手：先读[AI入口](../GPT_CONTEXT.md)、[当前进度](../DEVELOPMENT_PROGRESS.md)和[业务术语](../CONTEXT.md)，再按任务查需求、架构、计划或手册。原始报告中的“当前”仅代表其原日期。

机器入口：[文档索引](knowledge-index.json)、[静态源码/API/迁移索引](reference/source-inventory.json)。索引不是执行授权，源码存在不等于已经发布。

## 当前入口、管理、指南与技术说明

| 文档 | 用途与边界 |
|---|---|
| [工作台：AI 接续工作约定](../AGENTS.md) | 仓库执行约定、数据保护与维护责任 |
| [工作台业务术语](../CONTEXT.md) | 唯一业务术语词典，不承担运行状态 |
| [开发进度与当前基线](../DEVELOPMENT_PROGRESS.md) | 当前发布、能力分层和验收边界 |
| [AI 项目接续入口](../GPT_CONTEXT.md) | AI最小接续上下文及按需阅读路线 |
| [产品需求与追溯矩阵](../PRODUCT_REQUIREMENTS.md) | 当前需求、业务规则、场景及代码验证追溯 |
| [工作台（WorkBench）](../README.md) | 人类阅读入口、当前产品和启动说明 |
| [系统架构](../SYSTEM_ARCHITECTURE.md) | 当前结构、关键链路、运行与候选边界 |
| [项目知识与文档总览](README.md) | 自动生成的完整文档目录与分类 |
| [源码、测试和本机资料的边界](guides/DATA_BOUNDARIES.md) | 源码、测试、本机配置与业务资料的上传边界 |
| [开发与验证指南](guides/DEVELOPMENT.md) | 开发环境、隔离验证、构建和交付 |
| [换机开发与接续清单](guides/DEVICE_HANDOFF.md) | 每次任务收尾、换机移交范围、新机验证与现有打包限制 |
| [月度工时与年度台账操作及开发验收](guides/MONTHLY_DEVELOPMENT.md) | GOV-12月度工时与年度台账日常操作、隔离验收证据和已发布能力边界 |
| [运行、备份、恢复与发布手册](guides/OPERATIONS.md) | 运行、备份、恢复、发布与排障 |
| [前台设计 V2 实施与隔离核验](guides/UI_DESIGN_IMPLEMENTATION.md) | GOV-13前台设计V2限定发布、隔离预览、浏览器验证与验收边界 |
| [使用说明](guides/USER_GUIDE.md) | 当前日常版操作、异常处理及反馈 |
| [项目变更记录](management/CHANGELOG.md) | 逐任务实际修改、验证、五份文档复核及本地保存和Git交付状态 |
| [文档治理与AI读取规范](management/DOCUMENT_CONTROL.md) | 知识权威规则、索引契约和维护方法 |
| [项目章程与范围说明](management/PROJECT_CHARTER.md) | 目标、范围、交付、责任、资源和阶段出口 |
| [项目计划与唯一执行队列](management/PROJECT_PLAN.md) | 唯一GOV执行队列、依赖、状态与下一步 |
| [质量管理与验收计划](management/QUALITY_AND_ACCEPTANCE.md) | 质量方法、验收计划和证据要求 |
| [风险、问题与决策记录](management/RISKS_AND_DECISIONS.md) | 风险、问题、业务未定项与已有决策 |
| [数据字典、接口约定与定位](reference/DATA_AND_API.md) | 关键数据字典、API约定及源码定位 |

## 维护与移交

运行 `node scripts/docs-maintenance.mjs generate` 刷新目录和索引，再运行 `node scripts/docs-maintenance.mjs check`。脚本不启动应用、不读取业务行、不修改日常数据。详细约定见[文档治理](management/DOCUMENT_CONTROL.md)。

data、outputs和旧临时目录通常不随Git分发；本机证据缺失必须如实说明，不能当作代码或验收已通过。测试用例、历史报告与运行快照仅保留本机，不进入共享索引；关联链接在新设备可能不可用。
