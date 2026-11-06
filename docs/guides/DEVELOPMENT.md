# 开发与验证指南

文档ID：GUIDE-DEVELOPMENT。版本：1.3。更新：2026-11-06。适用：本仓库开发工作区；不会自动授权日常发布。

共享范围为源码、依赖/构建规则、通用工具、开发文档和配置样例；真实资料、本机配置、测试用例、夹具、tsconfig.test.json及历史验证产物均保留本机、不上传。具体见[源码与资料边界](DATA_BOUNDARIES.md)，跨机阅读与资源缺项处理见[换机清单](DEVICE_HANDOFF.md)。

首次获取源码后的配置、安装和日常启动见[安装指南](INSTALLATION.md)；根README仅维护项目介绍。

## 1. 开工检查

读AGENTS、GPT_CONTEXT、当前需求及对应GOV任务；检查Git状态和已有变更。当前大量文件有其他任务修改，禁止重置或把全部差异当作自己的成果。

Node.js要求≥24，根package.json使用npm workspaces。检查本机版本和依赖状态后，在新环境按锁文件安装：

```powershell
node --version
npm --version
npm ci
```

npm ci会重建node_modules；已有环境不是每次任务都要运行，更不能在日常服务运行时随意替换其共享依赖。安装命令不表示当前环境已经完成安装。

## 2. 代码定位

先查[架构](../../SYSTEM_ARCHITECTURE.md)和[源码索引](../reference/source-inventory.json)。典型调用是页面/组件 → api.ts → routes-* → domain → core/db。参数及HTTP错误留在API，业务状态集中在领域服务，避免在多个页面复制就绪判断。

工作区与日常包分别核查；新增接口若只在工作区注册，不可当线上接口调用。需求和测试映射在[PR追溯表](../../PRODUCT_REQUIREMENTS.md)。

## 3. 安全的测试入口

应用依赖齐备后可运行npm run typecheck核对源码类型。纯文档任务只执行文档及共享边界检查，不重跑应用测试。

用例齐备时才通过隔离入口运行相关专项，例如：

```powershell
node scripts/test-isolated.mjs --unit inspection-drafts
```

先确认packages/server/test中存在所需用例及其依赖夹具；npm run typecheck:tests还需要本机tsconfig.test.json。npm test和npm run test:all引用的部分隔离契约脚本与用例同样仅在旧机，不能因根package.json有命令就认为新克隆可运行。缺失时记录未执行及所缺资源；依据当前授权另行接续或在隔离环境重建匿名验证，不创建空测试绕过失败，不连接日常库补样本。按改动范围选检查，不反复运行无关全套。

隔离启动器在子进程执行前设置数据库、文件、运行、备份、OCR、前端等绝对路径，并预加载test-preflight。不要直接运行业务测试文件，也不要先静态import应用再设置隔离变量。

测试使用匿名样例；真实资料只在授权范围复制，不能把日常模型密钥带入测试。模型mock和真实调用分开记录。

本次精确提交候选未纳入旧Mac临时目录别名兼容补丁。Mac验证在已解析的真实系统临时父目录运行：`TMPDIR=/private/tmp node scripts/test-isolated.mjs --unit <用例名>`；仍检查专属根、标记、链接与数据隔离，不关闭保护。测试用例须单独获准接续，缺失不等于通过。以下原混合候选的UI证据只作步骤依据，拆分候选需另行复验。

### 3.5 流程配置第一段限定回归

本机资源为packages/server/test/workflow-config-phase1.ts、workflow-config-fresh.ts、workflow-material-mapping.ts。按本节资源边界在明确授权下接续或重建；源码不附测试/夹具/原始截图，新克隆不能自动重放。入口：

```sh
node scripts/test-isolated.mjs --unit workflow-config-phase1
node scripts/test-isolated.mjs --unit workflow-config-fresh
WORKFLOW_CONFIG_HOLD=1 node scripts/test-isolated.mjs --unit workflow-config-phase1
WORKFLOW_CONFIG_HOLD=1 node scripts/test-isolated.mjs --unit workflow-material-mapping
```

phase1在全新临时根构建前端，合成040旧库经正式启动升级；15组断言覆盖草稿隔离、旧API/种子/SQL守卫、发布7个故障点回滚及同操作重试、版本/修订409、新建目录回滚、复制与停用、材料稳定身份、缺失/改变/归档模板和重启。fresh从无库启动，检查完整seed再建兼容基线、复制未发布草稿重启不误发布。不得导入真实库/模板替代夹具。

material-mapping包含原15组及新增一组7场景：同模板必备/选备、顺序交换、两个必备、不同模板、旧有损快照、旧无结构规则及无模板必备。断言只满足一项不可完成、齐备后才可完成、实际artifact_id与版本链独立、更新B不改A定稿字节/行、快照不变。MAPPING_EXPECT_BUG仅用于修前复现，退出0代表断言缺陷存在，不是修复通过。

关联保护专项另用本机workflow-link-ui.ts：`node scripts/test-isolated.mjs --unit workflow-link-ui`，独立构建并创建三项合成果及两期，不重跑未改的完整配置测试。3组API核对必备判断、期次不自动完成和陈旧expected不写入。UI_READY后以仅连接该后端的503/hold代理分别覆盖未关联C、新选择A：失败值/错误保留，双击重试只有一条hold；首页、切期、浏览器返回均提示等待，放弃/保存并离开禁用；解除hold后成功解锁；再次503时保存并离开失败仍留页，恢复后才离开；明确放弃只丢弃选择，空选项不清除已保存关联。比较前后表，除明确材料更新与事件外无差异。代理复用本机前轮proxy.mjs，停止顺序为自有页、专属proxy-stop、done；不操作其他运行。

定向页面步骤：HOLD后按mapping-ui.json的工作/期次打开；生成窗口不选要求时保存禁用；选B手填合成内容保存，A仍待提供且readiness.canComplete=false；另选A保存后两项各有独立成果，canComplete=true但期次仍open。用逐项下拉明确关联已有成果，再恢复原关联，核对只更新指定行。保存截图/DOM及API关联、快照比较；不调用模型。

HOLD输出本轮UI_READY目录，ui.json包含随机base、专属临时根和doneFile（令牌不复制到文档）。用已初始化的cua_repl打开base或本轮受控503/hold代理，仅操作合成页面。人工可重复步骤：编辑说明后切类型验证继续/保存并离开；两页面打开同一修订，A保存后B保存409，核对最新状态并明确选择；代理让draft失败503后重试，hold时双击保存和离开，确认仅一个请求及忙碌互斥；发布预览/说明/hold双击验证仅一个版本；新建类型在发布前不能被新工作选中；发布后填新工作，在另页发新版本，旧创建409，刷新配置保留输入后成功；停用类型只从新建移除、旧工作分类与详情可用；复制后新增/调序阶段并发布。用只读SQLite核对新建来源和实际快照，比较预存旧业务行及定稿不变。

当前11项UI结果为真实工具交互与证据记录，不是npm test自动执行的页面脚本。控制失败只在本轮代理，不能改生产保护或真实服务。结束关闭自有页，先写本轮proxy-stop（如使用代理），再写ui.json指定doneFile；等待外层退出0、检查cleanup.json、临时根及端口均已释放。不得复用其他运行的停止标记。全套旧用例、Windows/Office、真实模型/业务及完整响应式未被这些专项覆盖；第二段另见3.6。

### 3.6 在办配置差异与显式应用限定回归

本机用例workflow-config-application.ts仍只经根隔离入口运行，不随源码上传。缺失时按本节资源边界接续或经授权重建，不能用真实库补齐。运行：

```sh
node scripts/test-isolated.mjs --unit workflow-config-application
WORKFLOW_CONFIG_HOLD=1 node scripts/test-isolated.mjs --unit workflow-config-application
```

15组真实SQLite/HTTP检查覆盖逐表只读预览、安全/拒绝范围、状态及发布过期、同操作幂等/异请求冲突、阶段/清单/进度/事件故障完整回滚、旧定稿字节和快照、明确未来边界/同频率、旧期次不改、未来共用模板各自绑定、重启及相同规则不重复应用。未来时点通过同一隔离环境内调用syncPeriods验证，不向日常API新增测试时钟或生产故障开关。受影响的040升级15组与7场景映射仍用3.5入口。

HOLD生成专属UI_READY、ui.json和doneFile。用GPT内置浏览器打开本轮base的`/#/workbench?id=<workId>`（或专属503/hold代理），不得复用别的运行目录。可重现的页面步骤：

1. 点击预览，核对禁用项原因；未选择/未确认不能应用。预览延迟时尝试站内离开，离开及取消受忙碌保护。
2. 选择新阶段并确认，代理503后选择保留；另一次合成并发修改触发409，必须重新预览，保留仍安全的选择并重新确认。
3. hold应用后双击、站内离开、浏览器返回，核对仅一个请求且不能取消/放弃在途操作；成功后新阶段为待开始、原来源保留、历史只记实际部分范围，导航解锁。
4. 未保存选择时返回或取消，应明确继续/放弃，放弃不写数据库。周期工作不填边界不可应用，填晚于全部已有期次/安排的未来期重新预览，再显式应用；旧期次列表、材料、成果与快照保持不变。
5. 工作设置与归档→工作材料核对→预览阶段模板要求，核对不安全阶段禁用，安全确认的慢请求也不能离开；故障后预览保留，事务API核对原要求/进度整体回滚。

实际页面检查由工具交互完成，不是npm test附带的无人值守脚本。比较所有表，只允许本次明确选择的阶段/清单/规则/进度及事件变化；真实文件不动。关闭自建页，写本轮proxy-stop，再写doneFile，等待runner退出0和临时根删除；不结束其他服务。第一段独立通过；第二段原限定范围已独立确认，旧文书指纹P2定向独立复验已通过；该结论不替代拆分提交候选UI复验，尚未覆盖Windows、真实资料迁移、全模板/执行器、Office、真实模型、完整响应式或跨进程压力。

### 3.7 旧文书入口发布指纹保护定向回归

本机workflow-legacy-fingerprint.ts与夹具不随源码交付。缺少该文件不能宣称已经通过；按本节资源边界在获准范围接续。正常运行及保留隔离页面：

```sh
node scripts/test-isolated.mjs --unit workflow-legacy-fingerprint
FINGERPRINT_UI=1 node scripts/test-isolated.mjs --unit workflow-legacy-fingerprint
```

12组检查：健康新旧预览发布指纹相同且只读；文件字节、变量配置、归档、缺失分别让新旧预览/确认拒绝且逐表不变；同内容新版发布使旧预览失效；在文书UPDATE触发器中注入模板失效，两入口的要求/进度/事件共同回滚；进度失败整体回滚；健康旧确认成功与重复旧确认冲突；未知原规则拒绝；仅阶段有明确来源仍保护；真正未知版本但原规则可核对时保留原动态兼容且不补来源。FINGERPRINT_REPRO=1仅用于修前复现，退出0表示断言缺陷存在，不是修复通过；修后该模式应断言失败。

UI_READY后只打开该轮ui.json的base和workId。工作设置与归档→工作材料核对→B阶段“预览阶段模板要求变更”：在专属合成模板末尾加字节，预览应显示指纹变化并禁用确认；取消并恢复原字节。取得健康预览后再次改该合成文件，点击确认应拒绝且保留预览，核对76表无变化；恢复模板、取消后重新预览并明确确认，页面由必备变为可选。成功只允许指定阶段doc_requirements及1条事件变化，原来源、规则快照、状态、其他行和恢复后的模板字节保持一致。保存DOM/截图及逐表比较。此为可复现人工工具步骤，不是自动UI套件；不操作真实模板，不调用模型/Office。关闭自建页，写本轮doneFile，等隔离入口退出0并核对专属临时根/端口已释放。

指纹在事务内重查并于提交前再次核对；外部文件不受SQLite锁保护，这不提供跨进程文件锁或冻结模板二进制。完整测试资源和Windows/Office等未测边界保持不变。

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

每次逐一复核五份根文档，将受影响正文完整整合为当前有效说明，删除失效和重复表述；没有内容变化时不追加复核段落。按[文档治理](../management/DOCUMENT_CONTROL.md)填写[工作日志](../management/WORK_LOG.md)，记录文件及前后差异、理由、验证、五份文档复核、未完成项和保存/暂存/提交/推送/发布/验收状态；建议提交标题采用 `类型(范围): 具体变化`。修改结构/API/迁移后刷新source-inventory，状态更新到对应GOV。运行：

```powershell
node scripts/docs-maintenance.mjs generate
node scripts/docs-maintenance.mjs check
git diff --check
```

文档检查仅静态读文件。新增脚本先明确读写范围，不能以“检查”名称掩盖初始化、删除或模型调用。未完成需求、证据不足和待偿还技术问题分别记录到项目计划/风险表，不只散落在会话里。
