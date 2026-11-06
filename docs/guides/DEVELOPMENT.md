# 开发与验证指南

文档ID：GUIDE-DEVELOPMENT。版本：1.11。更新：2026-11-06。适用：本仓库开发工作区；不会自动授权日常发布。

共享范围为源码、依赖/构建规则、通用工具、开发文档和配置样例；真实资料、本机配置、测试用例、夹具、tsconfig.test.json及历史验证产物均保留本机、不上传。具体见[源码与资料边界](DATA_BOUNDARIES.md)，跨机阅读与资源缺项处理见[换机清单](DEVICE_HANDOFF.md)。

首次获取源码后的配置、安装和日常启动见[安装指南](INSTALLATION.md)；根README仅维护项目介绍。

## 1. 开工检查

读AGENTS、GPT_CONTEXT、当前需求及对应GOV任务；检查Git状态和已有变更。若存在其他任务修改，禁止重置或把全部差异当作自己的成果。

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

macOS测试入口先解析系统临时目录的真实路径，以兼容/var系统别名；专属隔离子目录中的链接、越界和重叠仍会拒绝。不要关闭路径守卫或将任意业务路径realpath化来规避检查。

测试使用匿名样例；真实资料只在授权范围复制，不能把日常模型密钥带入测试。模型mock和真实调用分开记录。

### 3.1 RK-11/RK-12限定回归的重复执行

以下运行方法适用于本机存在`packages/server/test/rk-repair.ts`、`rk-isolation.ts`、`rk-ui-replay.mjs`的开发环境。用例和证据按用户约定不随Git分发；新克隆只会取得本指南、正式风险表和通用隔离入口。接续者应先核对文件，缺失时经当前授权私下接续这三份本机用例，或按下列验收条件重建匿名验证；不能把缺文件或仅API退出0当作页面已通过。已有本机测试类型配置可单独接续，应用构建不依赖它。不得把测试复制进共享源码目录绕过交付边界。

仅自动API验证可运行`node scripts/test-isolated.mjs --unit rk-repair`。需要页面回放时，在macOS/POSIX终端运行：

```sh
RK_MODE=final RK_HOLD=1 node scripts/test-isolated.mjs --unit rk-repair
```

每次从控制台读取新的`RK_RUN_DIR`，再等`UI_READY`；即使mode相同，也会在`outputs/rk-repair-20261105/runs/`内生成独立目录。目录中的`ui.json`包含本次`ui`、`base`、`runDir`、`controlFile`和`doneFile`。不要使用旧根目录的ui/control/final-done，也不要删除其他运行的标记。运行日志不跨目录混合；停止只读取本次`doneFile`。一小时无人结束会报超时并清理，不算页面通过。

`rk-ui-replay.mjs`复用现有`cua_repl`浏览器工具，不新增Playwright依赖，不是裸Node或CI浏览器驱动。已初始化浏览器工具并阅读其当前文档后，使用实际检出绝对路径、本次`RK_RUN_DIR`和浏览器ID加载：

```js
let rkReplayModule = await import('/<checkout>/packages/server/test/rk-ui-replay.mjs');
let rkReplay = await rkReplayModule.openReplay(cua, '<本次RK_RUN_DIR>', '<浏览器ID>');
```

分别在浏览器工具中执行以下调用，每步失败就停止后续测试，运行`await rkReplay.abort()`回收该脚本创建的页面并请求停止服务，保留失败记录：

```js
await rkReplay.monthly();
await rkReplay.conflict();
await rkReplay.busy();
await rkReplay.finish();
```

这是三组可重放页面断言：月度切期取消/503失败保留/重试与A/B归属；两个独立设置页面的旧快照冲突、输入保留和明确核对保存；普通保存慢请求与离开保存的互斥。动作通过真实页面执行，故障只由本次匿名代理提供。脚本保存`ui-results.json`、关键DOM和冲突截图；只有三组都通过才标记complete=true。普通API运行器的`uiAutomation=not-run-by-api-runner`不是页面检查结果。

没有浏览器工具时，保持API与页面结果分开，可按以下人工步骤核验，并保存实际期次/设置值、错误状态和结果：

1. 匿名A期输入说明后切B：选择继续应留在A并保留输入；模拟原期PUT返回503后选择保存并离开，应仍在A且显示错误；恢复后重试应到B，B原值不变，返回A读到已保存值。
2. 两页面读同一设置基线：A改单位保存，B只改经办人保存或保存并离开应冲突并保留输入；明确保留自己的修改后，未改单位采用A最新值，再保存成功。
3. 将本次代理的`controlFile`设为`{"mode":"hold","path":"/api/settings"}`，普通保存期间输入、离开弹窗的放弃/保存按钮均应禁用；改回`{}`释放后才可离开，成功基线不再提示脏输入。月度故障同理使用`/api/periods/<本次A编号>`和`mode=fail`，结束时恢复`{}`。

手工验收完成或中止时，先关闭本次页面、释放本次hold，再在本次`doneFile`写入任意文本；等待隔离命令退出，检查`cleanup.json`中的后端退出和代理关闭，再核对`ui.json`记录的临时数据根已被外层隔离入口删除。证据目录保留供复核，不作运行数据。重复完全相同的启动命令，应得到另一个独立目录；上次done文件不得影响新服务。

三组脚本不覆盖原生beforeunload、真实断网、所有模板和设置子表单，也不等同旧全套测试。缺浏览器工具时记页面回放未执行，不安装额外工具来掩盖缺项；后续扩展仍沿GOV-13处理。正式覆盖说明可随源码获取，脚本和合成用例需按上述本机资源流程接续，不能声称新克隆具备自动UI测试。

### 3.2 工作关联视图与记录筛选限定回归

本机用例为`packages/server/test/record-links.ts`和`record-links-ui.mjs`；按共享边界只留本机。新克隆须先核对资源，按授权私下接续或依本节重建匿名测试。没有脚本或浏览器工具时标记未执行，不创建空用例或连接真实数据替代。

API专项通过`node scripts/test-isolated.mjs --unit record-links`执行。需要实际页面回放时运行：

```sh
RECORD_LINKS_HOLD=1 node scripts/test-isolated.mjs --unit record-links
```

入口每次创建独立临时数据根和随机端口，构建前端到临时根。读取本次`UI_READY`目录（outputs/record-links-20261105/run-*），在已初始化并阅读说明的cua_repl中执行：

```js
let recordReplay = await import('/<checkout>/packages/server/test/record-links-ui.mjs');
await recordReplay.replay(cua, '<本次UI_READY绝对目录>', '<浏览器ID>');
```

复用现有浏览器工具，无新增依赖；模块有变更时使用新工具会话，或把最终模块逐字复制至本次证据目录后导入该副本，避免旧模块缓存。跨范围详情先等待当前范围列表结果完成并读取DOM，再点击“单独查看记录”，避免异步列表展开导致目标位置变化；失败保存DOM/截图，API保存table-differences.json逐表差异。七组结果分别覆盖：工作卡片/记录深链接/重载；返回工作和全部关联记录；分页后切换范围重置页码；空列表与默认未关联兼容；非法/不存在/删除工作不回退全部；跨工作详情提示和旧记录链接；归档工作深链接。结束关闭自身页面并写本次done，即使失败也会请求清理，因此只有ui-results.json明确passed=true才代表页面通过。30分钟无人结束会报错，不算页面通过。

API还检查日期筛选与未知日期单列、撤回记录、关联隔离及已删除关联不被改写。匿名库故意设置非当前文件推导的进度和影像清单值，逐表比较GET与实际浏览前后的行内容，防止“只是看一下”自动写回进度/清单/完成时间。该哨兵是虚构测试，不能放进真实库。显式recalc命令保留原写入行为，与浏览检查分开。

没有浏览器工具时可人工复现：建立A/B及空项目，A放33条有效记录、另有撤回和未知日期，B放1条，另放1条未关联；再设归档和删除工作。由工作卡片进入记录并刷新，核对归属；返回后去第二页切B，应回第1页且无A记录；切空项目应空，回全部应包含未关联；分别打开错误、缺失、删除工作范围应明确报错；跨范围记录深链接应提示不属于当前工作，旧单记录链接仍可用；归档深链接可查。记录截图/DOM及实际HTTP、匿名数据库前后比较结果，不能据API成功代替页面通过。

人工结束时仅在本次UI_READY目录写done，等待隔离运行器退出；检查cleanup.json的exitCode、ui.json记录的临时根已删除且本次端口无监听，保留证据目录。不操作其他运行标记。验证范围不含完整npm test、真实模型/数据、Office、所有响应式尺寸、跨窗口关联变化或所有新建/更正表单；应用与测试的类型检查分别报告。

### 3.3 材料重新核对与恢复同步回归

本机`record-links-p2.ts`从隔离入口运行：`RECORD_LINKS_HOLD=1 node scripts/test-isolated.mjs --unit record-links-p2`。用例真实multipart上传合成PNG，依次软删、回收站恢复，断言计数1→0→1；移动本次临时图片后GET保持原存储状态，显式recalc才更新。定稿/取消定稿及已有定稿快照保护另行断言。没有HOLD时仅API，不算页面通过。文件与脚本均为本机资源，不随Git提供。

真实页面操作在本次UI_READY的工作rw上执行：从工作详情可见“重新核对材料与进度”；仅移动该临时文件，刷新后计数不自动写回，点击核对应变0；恢复文件，点击核对应变1。使用仅连接本次后端的故障代理令POST /recalc返回503，确认错误和重试；挂起请求时核对按钮及离开弹窗放弃/保存均禁用，继续编辑后释放请求恢复成功。比较阶段/期次及artifact定稿标记、时间、哈希前后不变；影像计数改变不代表人工核对状态verified或业务办结。截图与数据库断言分别保留。

本机代理例程保存在outputs/record-links-p2-20261105/proxy.mjs，以当前run目录为参数，随机端口和专属proxy-control.json（method=POST、path=/recalc、mode=fail/hold，释放为{}）、proxy-stop；不要复用旧目录或面向日常端口。结束关闭自有页，释放hold，写本次done和proxy-stop，检查服务退出、端口关闭和临时根删除。环境中断时先核对归属，不能以连接恢复推定旧进程仍在或已退出。此说明可共享，脚本缺失时按上述条件重建授权隔离验证，不能伪造通过。

### 3.4 恢复与定稿同步失败回归

本机`record-sync-atomic.ts`通过`node scripts/test-isolated.mjs --unit record-sync-atomic`执行。只在隔离合成SQLite创建触发器，在目标工作progress更新或影像清单done_count更新时RAISE(ABORT)，覆盖文件/阶段/工作恢复及定稿/取消定稿共10组。收到400时逐表比较全部业务行和原文件字节不变，移除触发器后原请求200；成功后重复恢复保持原有“不在回收站”400且不改状态，同值定稿200 changed=false且无额外写入。另覆盖正常上传/删除/恢复、绑定目录恢复、非空期次/定稿保护及80→100→80门槛，不将故障复现退出0当修复通过。

用例/夹具仅本机，获取方式沿3.2；输出atomic-results.json和每组恢复失败响应，构建及隔离清理由原根入口执行。数据库触发器故障不代表真实磁盘故障或所有I/O故障，未模拟硬断电、网络结果未知。页面需独立验证，Mac锁屏且工具不能交互时停下，待手动解锁或工具可靠确认可交互后再继续，不以DOM可读取代替点击成功。

### 3.5 流程配置第一段限定回归

本机资源为packages/server/test/workflow-config-phase1.ts、workflow-config-fresh.ts、workflow-material-mapping.ts。按3.1/3.2规则私下接续或在明确授权下重建；源码不附测试/夹具/原始截图，新克隆不能自动重放。入口：

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

本机用例workflow-config-application.ts仍只经根隔离入口运行，不随源码上传。缺失时按3.1私下接续或经授权重建，不能用真实库补齐。运行：

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

实际页面检查由工具交互完成，不是npm test附带的无人值守脚本。比较所有表，只允许本次明确选择的阶段/清单/规则/进度及事件变化；真实文件不动。关闭自建页，写本轮proxy-stop，再写doneFile，等待runner退出0和临时根删除；不结束其他服务。流程配置两阶段、旧文书指纹P2及拆分后三类UI已通过既定范围独立验收，代码提交053964ec3b87c9f0c2b4df493348a5da7edd0612，未推送、未发布。三类链路和证据适用范围见开发进度与质量矩阵；未覆盖Windows、真实业务/迁移、全模板/执行器、Office、真实模型、完整系统测试、完整响应式或跨进程文件压力。

### 3.7 旧文书入口发布指纹保护定向回归

本机workflow-legacy-fingerprint.ts与夹具不随源码交付。缺少该文件不能宣称已经通过；按3.1在获准范围接续。正常运行及保留隔离页面：

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
