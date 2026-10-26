# 开发与验证指南

文档ID：GUIDE-DEVELOPMENT。版本：1.1。更新：2026-10-24。适用：本仓库开发工作区；不会自动授权日常发布。

2026-10-26边界更新：仅共享源码、依赖/构建规则、通用工具、开发文档和配置样例；真实资料、本机配置、测试用例及历史验证产物均保留本机、不上传。旧文中要求随Git携带测试或运行快照的表述由本条替代，具体见[源码与资料边界](DATA_BOUNDARIES.md)。

## 1. 开工检查

读AGENTS、GPT_CONTEXT、当前需求及对应GOV任务；检查Git状态和已有变更。当前大量文件有其他任务修改，禁止重置或把全部差异当作自己的成果。

Node.js要求≥24，根package.json使用npm workspaces。检查本机版本和依赖状态后，在新环境按锁文件安装：

```powershell
node --version
npm --version
npm ci
```

npm ci会重建node_modules；已有环境不是每次任务都要运行，更不能在日常服务运行时随意替换其共享依赖。本文的命令是操作说明，本次文档整理未安装依赖。

## 2. 代码定位

先查[架构](../../SYSTEM_ARCHITECTURE.md)和[源码索引](../reference/source-inventory.json)。典型调用是页面/组件 → api.ts → routes-* → domain → core/db。参数及HTTP错误留在API，业务状态集中在领域服务，避免在多个页面复制就绪判断。

工作区与日常包分别核查；新增接口若只在工作区注册，不可当线上接口调用。需求和测试映射在[PR追溯表](../../PRODUCT_REQUIREMENTS.md)。

## 3. 安全的测试入口

```powershell
npm run typecheck
node scripts/test-isolated.mjs --unit inspection-drafts
npm test
```

按实际变更选择需要的命令，不要求文档维护运行以上应用测试。完整扩展回归为 `npm run test:all`。

隔离启动器在子进程执行前设置数据库、文件、运行、备份、OCR、前端等绝对路径，并预加载test-preflight。不要直接运行业务测试文件，也不要先静态import应用再设置隔离变量。

测试使用匿名样例；真实资料只在授权范围复制，不能把日常模型密钥带入测试。模型mock和真实调用分开记录。

## 4. 暂存前端构建

在仓库根PowerShell中，为每次候选使用独立绝对输出目录：

```powershell
$stageOut = Join-Path (Get-Location).Path ('outputs\web-stage-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
npm --workspace @workbench/web run build -- --outDir $stageOut
```

Vite会清理指定输出目录，因此必须选择本次专属目录。不要覆盖运行中 `packages/web/dist`。根package.json没有build:staged脚本，即使旧错误提示提到它，也不要照抄不存在的命令。

## 5. 隔离页面开发

`npm run dev` 与 `npm run server` 自动使用独立开发根，后端端口默认18889；Vite的5273代理使用同一个WORKBENCH_DEV_PORT，并核对后端development身份及数据库路径。开发根在源码之外，使用WORKBENCH_DEV_HOME可调整；不会读取项目旧配置或日常数据库。运行`node scripts/dev-server.mjs --show-paths`可只读确认位置。

需要构建后预览时使用`npm run dev:monthly -- --build`，复用独立开发根下monthly环境。一次性测试仍使用test-isolated的临时根，不能把持久开发环境当作可自动删除的测试目录。测试用例及夹具只留本机；应用类型检查与本机typecheck:tests分开。详见[运行与资料边界](DATA_BOUNDARIES.md)。

## 6. 数据和迁移

- 新迁移采用未占用文件名，保留已存在迁移；本仓库有020b且缺016，不能假设数字连续。
- 038在开发目录中存在，2026-10-24日常快照未应用；039和040已应用。后续发布需对比当时实际完整集合。
- schema_migration记录完整文件基名，启动执行缺失迁移。连接/初始化可能写数据，探测时使用直接只读SQLite连接，不import应用db入口。
- 迁移在独立副本上核对原表内容、行数、外键、实际文件与新字段影响。不能用“能启动”代替数据一致性。
- DB、成果文件与版本关系需一致；失败补偿、旧请求、重复提交均要考虑。

## 7. 变更和审查流程

确认PR/BR/SC和GOV → 阅读当前代码 → 实现最小完整行为 → 验证正常及关键失败 → 检查实际页面/文件 → 整理范围、证据和未验收项 → 同步文档。

禁止把界面隐藏视为后端规则已取消；例如取消报送需同时核对待办、readiness、接口、历史展示和下载。反之保留历史字段不等于仍需引导用户办理。

每次任务保存实际文件、记录本轮增量并交付文件清单。用户手动推送Git；默认不执行git add、git commit或git push，不自动发布。用户另行授权本地提交时仅处理指定范围。发布准备见[运维手册](OPERATIONS.md)，其他未提交工作继续保留。

## 8. 文档与技术债

每次逐一复核五份根文档，按[文档治理](../management/DOCUMENT_CONTROL.md)填写[变更记录](../management/CHANGELOG.md)。变更记录包括文件及前后差异、理由、验证、未完成项和保存/暂存/提交/推送/发布/验收状态；建议提交标题采用 `类型(范围): 具体变化`。修改结构/API/迁移后刷新source-inventory，状态更新到对应GOV。运行：

```powershell
node scripts/docs-maintenance.mjs generate
node scripts/docs-maintenance.mjs check
git diff --check
```

文档检查仅静态读文件。新增脚本先明确读写范围，不能以“检查”名称掩盖初始化、删除或模型调用。未完成需求、证据不足和待偿还技术问题分别记录到项目计划/风险表，不只散落在会话里。
