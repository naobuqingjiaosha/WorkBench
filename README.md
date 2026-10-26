# 工作台（WorkBench）

面向本机单用户的行政管理与项目实施工具。将工作事项、办理期次、项目阶段、模板、业务资料和成果文件集中管理，并提供 AI 辅助起草与资料检索能力。

项目目前处于开发阶段。本文说明开发工作区的安装和使用方式；功能进度见[开发进度](DEVELOPMENT_PROGRESS.md)，版本变更见[变更记录](docs/management/CHANGELOG.md)。

## 主要功能

- **工作管理**：按工作类型组织事项，管理周期期次、项目阶段和关联资料。
- **材料准备**：参考历史材料、编辑检查草稿，使用模板生成和下载 Word、Excel 文件。
- **工时与台账**：管理月度工时材料、年度台账及相关成果。
- **文件与模板**：维护模板库、文件版本、资料目录和检索索引。
- **AI 辅助**：根据所选资料辅助起草、问答与整理，支持配置本地或外部模型服务。
- **工作记录**：保存日常工作情况，为后续查询和回顾提供依据。

生成文件不自动表示检查已开展、材料已定稿或业务已完成。AI 建议需要用户核对；当前材料流程以生成和下载为终点。

## 技术栈

| 层次 | 技术 |
|---|---|
| 前端 | React 19、TypeScript、Vite 7 |
| 后端 | Fastify 5、TypeScript、Node.js 24+ |
| 数据存储 | SQLite（`node:sqlite`）及本地文件系统 |
| 文档处理 | ExcelJS、PizZip、PDF.js |
| OCR | Tesseract.js |
| 工程管理 | npm workspaces |

前端构建后由后端服务提供静态资源，默认通过本机浏览器访问。具体依赖版本以各包的 `package.json` 和根目录的 `package-lock.json` 为准。

## 环境要求

- Windows：当前主要开发与使用环境，部分 Office 验证脚本依赖 Windows 桌面应用。
- Node.js **24 或更高版本**，以及 npm。
- 可用的本地磁盘目录，用于数据库、业务文件和备份。
- AI 功能按需配置模型服务；OCR、Office 验证按所用功能准备对应资源。

## 快速开始

以下步骤适用于首次安装到独立目录。已有运行环境请直接阅读“日常启动”，不要在服务运行期间重装依赖或覆盖前端构建。

### 1. 安装依赖

获取完整源码，在项目根目录执行：

```powershell
node --version
npm --version
npm ci
```

`npm ci` 按锁文件安装整个 workspace 的依赖，无需分别进入前后端目录安装。

### 2. 检查本机配置

编辑根目录的 `workbench.config.json`，确认监听地址、端口和资料目录适用于当前电脑。以下是关键字段示例，已有其他配置项按需保留：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "dataRoot": "data/files"
}
```

相对资料路径以项目根目录为基准。换机后应重新检查原配置中的绝对路径；已有数据时，修改 `dataRoot` 不会自动搬迁原资料。

### 3. 构建并启动

```powershell
npm run build
npm start
```

默认访问 [http://127.0.0.1:8787](http://127.0.0.1:8787)。首次启动会初始化数据库、执行缺失的迁移并创建基础目录与预置配置，无需先运行数据库初始化命令。

如需 AI 功能，在界面的设置中配置模型服务商及用途。凭证保存在本机配置的数据中，不应提交到源码仓库。

## 日常启动

在已配置的环境中双击 `启动工作台.cmd`，或执行：

```powershell
npm start
```

`npm start` 会读取 `data/runtime/current-release.json`：存在有效指针时启动所选发布包；没有指针时启动开发工作区源码。发布包与当前源码可能不同，拉取代码或构建前端不等于完成发布。已有发布指针但包不完整时，启动器会报错，不会自动回退到源码。

备份、恢复和发布步骤见[运维手册](docs/guides/OPERATIONS.md)。

## 本地开发

### 前后端热更新

在使用独立数据目录的开发环境中执行：

```powershell
npm run dev
```

Vite 使用 `http://127.0.0.1:5273`，并将 `/api`、`/files` 代理到 `http://127.0.0.1:8787`。此命令直接运行工作区源码；默认配置不会自动隔离日常数据，不能将日常实例作为测试后端。仅修改后端端口也不会同步修改 Vite 代理。

### 隔离页面预览

仓库提供独立数据和端口的页面开发入口：

```powershell
npm run dev:monthly -- --build
```

该入口默认使用 `http://127.0.0.1:18889`，数据位于 `.tmp/monthly-development`，前端暂存构建位于 `outputs/monthly-development-web`；不修改日常发布指针。重复运行会复用这个隔离目录，构建不带热更新，也不会自动导入真实资料。

如只需验证前端构建，可在 PowerShell 中指定新的输出目录：

```powershell
$stageOut = Join-Path (Get-Location).Path ('outputs/web-stage-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
npm --workspace @workbench/web run build -- --outDir $stageOut
```

更多隔离开发、迁移和调试说明见[开发指南](docs/guides/DEVELOPMENT.md)。

## 检查与测试

在项目根目录执行，按改动范围选择：

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | 前后端 TypeScript 类型检查 |
| `npm run test:isolation` | 测试环境隔离约束检查 |
| `npm run test:unit` | 基础单元测试 |
| `npm run test:regression` | 回归测试，包含可靠性修复场景 |
| `npm run test:monthly` | 月度工时与年度台账专项测试 |
| `npm test` | 默认测试集合 |
| `npm run test:all` | 默认集合及端到端、检索、助手、视觉、OCR 扩展测试 |

单独运行某个测试套件时使用隔离入口，例如：

```powershell
node scripts/test-isolated.mjs --unit inspection-drafts
```

扩展测试可能需要额外模型或 OCR 资源，执行前查看对应测试要求。自动化测试通过不替代真实模型、Office 排版打印和业务验收。

## 项目结构

```text
packages/
  server/
    src/
      api/          HTTP 接口
      ai/           模型服务与调用
      core/         配置、文件、检索等基础能力
      db/           数据库与迁移
      domain/       业务逻辑
    test/           后端与业务测试
  web/
    src/            页面、组件和样式
    dist/           前端构建产物
scripts/            启动、隔离测试、构建辅助和维护脚本
docs/               开发指南、需求、架构及历史记录
data/               本机数据库、业务文件、备份和发布包
outputs/            本机构建与验证产物
workbench.config.json  本机启动和目录配置
```

`data/`、`outputs/`、`.tmp/`、`node_modules/` 和构建产物由 `.gitignore` 排除。克隆仓库不会复制业务资料、运行包或本机依赖；完整恢复需要同时保留数据库及配套业务文件。

## 开发文档

| 文档 | 内容 |
|---|---|
| [使用说明](docs/guides/USER_GUIDE.md) | 日常操作 |
| [开发指南](docs/guides/DEVELOPMENT.md) | 环境、隔离验证和开发流程 |
| [系统架构](SYSTEM_ARCHITECTURE.md) | 模块职责与关键链路 |
| [产品需求](PRODUCT_REQUIREMENTS.md)、[业务术语](CONTEXT.md) | 功能范围及业务对象定义 |
| [数据与接口](docs/reference/DATA_AND_API.md) | 数据结构与接口定位 |
| [开发进度](DEVELOPMENT_PROGRESS.md)、[项目计划](docs/management/PROJECT_PLAN.md) | 当前进度和后续任务 |
| [运维手册](docs/guides/OPERATIONS.md) | 备份、恢复与发布 |
| [变更记录](docs/management/CHANGELOG.md) | 已完成修改与验证范围 |
| [文档总览](docs/README.md) | 完整文档索引 |

修改前阅读 [AGENTS.md](AGENTS.md)；AI 协作接续见 [GPT_CONTEXT.md](GPT_CONTEXT.md)。修改功能后运行相关检查并同步对应文档；文档索引通过以下命令维护：

```powershell
node scripts/docs-maintenance.mjs generate
node scripts/docs-maintenance.mjs check
```
