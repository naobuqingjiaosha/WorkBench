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

`npm ci` 按锁文件安装整个 workspace 的依赖，并通过 prepare 安装本地提交/推送检查；无需分别进入前后端目录安装。

### 2. 检查本机配置

新安装默认把本机配置和数据放在源码之外：Windows 为 `%LOCALAPPDATA%/WorkBench/daily`，首次启动自动创建。可以用 `WORKBENCH_HOME` 指定另一个独立的绝对目录；不需要把真实配置复制到项目根目录。

`workbench.config.example.json` 仅提供配置格式。需要预先配置时，将它复制到独立数据根的 `workbench.config.json`，且不要覆盖已有文件。相对路径以该环境的数据根为基准，例如 `dataRoot: "files"` 和 `backup.dir: "backups"`。`WORKBENCH_CONFIG_FILE` 可显式指定已有配置文件，仍以环境数据根解析其中相对路径；格式错误会停止启动。

已有安装仍兼容项目根配置及 `data/runtime`，启动时会提示沿用旧布局，不自动迁移资料。修改数据根不会搬迁数据。详见[运行边界](docs/guides/DATA_BOUNDARIES.md)。

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

`npm start` 会读取当前环境的 `runtime/current-release.json`（旧布局为 `data/runtime/current-release.json`）：存在有效指针时启动所选发布包；没有指针时启动开发工作区源码。发布包与当前源码可能不同，拉取代码或构建前端不等于完成发布。已有发布指针但包不完整时，启动器会报错，不会自动回退到源码。

备份、恢复和发布步骤见[运维手册](docs/guides/OPERATIONS.md)。

## 本地开发

### 前后端热更新

在使用独立数据目录的开发环境中执行：

```powershell
npm run dev
```

Vite 使用 `http://127.0.0.1:5273`，开发后端使用 `18889`。`npm run dev`、`npm run server` 自动选择源码之外的独立开发根，并清除继承的日常路径及常见模型凭证变量；不读取日常配置。代理每次转发前核对后端环境及数据库身份，不匹配时返回503。

开发根默认是 `%LOCALAPPDATA%/WorkBench/development/<源码目录摘要>`。使用 `WORKBENCH_DEV_HOME` 或 `WORKBENCH_DEV_PORT` 自定义，前后端从同一命令环境读取。`node scripts/dev-server.mjs --show-paths` 只显示解析结果，不创建数据库。数据库初始化、预置及重置等开发命令也使用此环境。

### 隔离页面预览

仓库提供独立数据和端口的页面开发入口：

```powershell
npm run dev:monthly -- --build
```

该入口默认使用 `http://127.0.0.1:18889`，数据位于独立开发根的 `monthly` 子目录，前端暂存构建位于该目录的 `web-build`；不修改日常发布指针。重复运行会复用这个隔离目录，构建不带热更新，也不会自动导入真实资料。

如只需验证前端构建，可在 PowerShell 中指定新的输出目录：

```powershell
$stageOut = Join-Path (Get-Location).Path ('outputs/web-stage-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
npm --workspace @workbench/web run build -- --outDir $stageOut
```

更多隔离开发、迁移和调试说明见[开发指南](docs/guides/DEVELOPMENT.md)。

## 检查与测试

按本项目约定，测试用例和夹具仅保留本机，不随Git上传；应用类型检查只检查生产源码，测试有独立编译入口。下表业务测试命令需要本机已具备用例；新克隆可先运行类型检查和源码边界检查。

在项目根目录执行，按改动范围选择：

| 命令 | 用途 |
|---|---|
| `npm run repo:check` | 检查待共享文件范围与常见凭证模式 |
| `npm run repo:check:staged` | 检查实际Git暂存内容 |
| `npm run test:runtime-layout` | 本机运行环境、启动及开发代理边界测试 |
| `npm run typecheck:tests` | 本机测试类型检查，依赖不上传的tsconfig.test.json |
| `npm run test:repository` | 本机提交/推送边界测试（用例不上传） |
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
    test/           本机测试用例与夹具（不上传）
  web/
    src/            页面、组件和样式
    dist/           前端构建产物
scripts/            启动、隔离测试、构建辅助和维护脚本
docs/               开发指南、需求、架构及历史记录
data/               旧布局兼容目录（不上传）；新布局在源码外
outputs/            本机构建与验证产物
workbench.config.example.json  可共享的通用配置样例
workbench.config.json          旧布局本机配置；新布局在环境根（均不上传）
```

`data/`、`outputs/`、`.tmp/`、`work/`、测试用例、本机配置、历史扫描报告、依赖目录和构建产物均不上传。提交与推送钩子按允许范围检查实际文件及新增历史；详见[源码与资料边界](docs/guides/DATA_BOUNDARIES.md)。克隆仓库不会复制业务资料、运行包或本机依赖；完整恢复需要同时保留数据库及配套业务文件。

## 开发文档

| 文档 | 内容 |
|---|---|
| [使用说明](docs/guides/USER_GUIDE.md) | 日常操作 |
| [源码与资料边界](docs/guides/DATA_BOUNDARIES.md) | 上传范围、本机测试和配置隔离 |
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
