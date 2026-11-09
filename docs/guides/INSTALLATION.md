# 安装与启动指南

文档ID：GUIDE-INSTALLATION。版本：1.2。更新：2026-11-09。性质：新安装与已有环境启动说明。

本文面向本地最新源码；既有运行实例的版本与路径先按[开发进度](../../DEVELOPMENT_PROGRESS.md)和[运维手册](OPERATIONS.md)核对。开发、测试命令见[开发指南](DEVELOPMENT.md)，源码和私有资料边界见[资料边界](DATA_BOUNDARIES.md)。

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

已有安装仍兼容项目根配置及 `data/runtime`，启动时会提示沿用旧布局，不自动迁移资料。修改数据根不会搬迁数据。详见[运行边界](DATA_BOUNDARIES.md)。

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

备份、恢复和发布步骤见[运维手册](OPERATIONS.md)。

## 在 Windows 查看 GitHub 最新界面（隔离预览）

只看最新界面时，建议在另一个源码目录预览，保留日常实例、数据库和发布指针。Node.js须为24或更高版本。在 PowerShell 中首次获取：

```powershell
git clone https://github.com/naobuqingjiaosha/WorkBench.git WorkBench-preview
cd WorkBench-preview
git rev-parse HEAD
npm ci
npm run dev:monthly -- --build
```

打开终端显示的地址，默认是 [http://127.0.0.1:18889](http://127.0.0.1:18889)。虽然命令沿用monthly名称，它构建并启动的是当前源码的完整工作台：首页、文件、模板和其他导航均可查看。不要加`--seed-handoff`；该选项会建立额外验收样本。首次预览没有日常工作或模板是正常现象，不表示原资料丢失。

此入口使用development身份，数据与构建位于`%LOCALAPPDATA%\WorkBench\development\<源码路径哈希>\monthly`（未另设开发根时），不读取日常发布指针，不把预览数据写进日常库。可在`http://127.0.0.1:18889/api/health`核对`runtimeProfile`为`development`及独立`dbFile`；`loadedBuild`是启动时文件摘要，不是Git SHA。源码版本用上述`git rev-parse HEAD`与本次交付提交核对。

再次更新同一预览目录时，先用Ctrl+C停止自己的预览服务；确认分支为main、`git status --short`无修改，再运行：

```powershell
git pull --ff-only origin main
git rev-parse HEAD
npm run dev:monthly -- --build
```

本次玻璃样式更新未改依赖；已有依赖可直接使用。首次安装或拉取后锁文件变化时先运行`npm ci`。有本地修改或分支分歧时保留现场，不重置。端口被占用时核实已有进程；可在当前PowerShell先设置`$env:MONTHLY_DEV_PORT='18890'`后启动，并使用终端实际地址。需要时用Ctrl+F5刷新页面。

需要对比增强玻璃之前的版本，可停止预览后另建只用于预览的工作树，不回退main、不覆盖已有预览数据：

```powershell
git worktree add --detach ..\WorkBench-before-liquid f44ef18e732c1f02d95794db28423a1d2b8c3150
cd ..\WorkBench-before-liquid
npm ci
npm run dev:monthly -- --build
```

新路径默认对应另一个独立开发数据根，因此不带原预览样本；勿设置成日常或原预览数据根来对比。结束后Ctrl+C停止，回到原预览目录即可继续新版本。减少动画/透明或增强对比的浏览器媒体偏好会关闭玻璃增强；不同Windows/浏览器版本是否传递该偏好须以实际效果为准。

`npm start`或双击日常启动脚本可能仍加载旧发布包；单纯拉取Git或运行预览不会更新日常版。配套发布是另一项操作，不删除或改写`current-release.json`来强行看到新界面。本步骤由启动源码与隔离规则核对；Windows本机字体、缩放、浏览器主题及完整启动链仍需在目标设备确认。

## 后续操作

- 日常操作见[使用说明](USER_GUIDE.md)。
- 前后端开发、暂存构建与隔离验证见[开发指南](DEVELOPMENT.md)。
- 换电脑接续见[换机清单](DEVICE_HANDOFF.md)，测试用例、业务数据和本机配置不会随Git自动传递。

首次启动会写入当前环境数据库、执行迁移并创建目录。需要只读了解配置时，使用`node scripts/dev-server.mjs --show-paths`查看开发路径，不以启动应用代替只读检查。
