# 项目变更记录

文档ID：PM-CHANGELOG。版本：1.0。更新：2026-10-26。性质：实际任务变更与交付记录；任务队列仍为[PROJECT_PLAN](PROJECT_PLAN.md)。

本文件保留既有历史条目，其中Git、运行与交付状态只代表记录当时。新的逐次工作统一记录在[工作日志](WORK_LOG.md)，不再向本文件追加新任务。当前项目状态见[开发进度](../../DEVELOPMENT_PROGRESS.md)，执行队列见[项目计划](PROJECT_PLAN.md)；历史证据不代替当前核查。

## 2026-10-26｜GOV-11｜明确五份根文档职责，README仅保留项目介绍

**目标与依据：** 用户要求修改CONTEXT、DEVELOPMENT_PROGRESS、GPT_CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE，并明确以后README只写项目介绍。本次只整理文档及索引分类，不修改应用功能或运行环境。

**开始状态与核实：** main/2c26fbcc7f667e6d7519bc181309c22d8c353396，工作区干净；本地origin/main及只读git ls-remote均指向该提交，架构隔离改造已由用户提交推送。2026-10-26 17:24北京时间核对发布指针、RELEASE、8787健康接口及进程命令行，本机仍运行ui-design-20261024-r1。未查业务数据库行数/实际迁移集合，未重算全部发布摘要；不把旧设备reliability记录当本机状态。

**文件与前后变化：**
- README.md：由介绍、安装、开发、测试和交接混合入口改为项目介绍、能力范围、设计原则、技术概览及文档链接。新增docs/guides/INSTALLATION.md承接原安装、配置、构建和启动内容，避免操作说明丢失。
- CONTEXT.md：保留全部业务术语，将检查草稿、整体采用、文件已生成归入对应类别，去除工程与交付状态。业务含义无变化。
- PRODUCT_REQUIREMENTS.md：保留BR/PR/SC编号、规则和验收要求，移出具体设备发布与本轮交付表述；名单中的个人实例改为遵循本机确认名单，不在共享需求写具体人员信息；归并运行隔离和文档职责约束。
- SYSTEM_ARCHITECTURE.md：重写为整体结构、模块职责、业务对象、存储、一致性、AI、环境、启动发布及恢复设计，清除过时pack遗漏与设备运行流水。原技术要点按职责保留，应用架构未新增变更。
- DEVELOPMENT_PROGRESS.md：以本机当前源码/运行核实为主，纠正未提交和旧设备发布状态；区分历史验证、本次文档检查、未发布与未验收事项。
- GPT_CONTEXT.md：缩短为AI阅读路线、最新接续要点和不可丢失约束，状态主记录链接DEVELOPMENT_PROGRESS，不再复制完整历史发布表。
- AGENTS.md、docs/management/DOCUMENT_CONTROL.md：固化六份根文档职责，区分根README项目介绍与docs/README导航索引，修正过时Git暂存状态和测试移交口径。
- docs/management/PROJECT_PLAN.md：仅更新GOV-11相关摘要，架构提交已推送，本次文档整理尚未提交；清除旧pack遗漏待办。docs/guides/DEVELOPMENT.md补安装指南入口。
- scripts/docs-maintenance.mjs：更新README用途说明并登记INSTALLATION指南；生成docs/README.md、docs/knowledge-index.json和docs/reference/source-inventory.json。

**原文保留：** 整理前九份文档及SHA256清单保存在本机[整理前快照](../archive/2026-10-26-172619-before-document-roles/manifest.json)，目录被排除上传，原历史报告不改写。Git基点2c26fbc也保留已提交原文。

**五份文档复核：** CONTEXT归整术语且含义不变；PRODUCT_REQUIREMENTS保留需求并明确文档约束；SYSTEM_ARCHITECTURE整理当前实现，不新增技术能力；DEVELOPMENT_PROGRESS纠正实际Git及本机运行状态；GPT_CONTEXT更新接续与阅读路线。

**验证：** 文档generate/check通过：23份文档、202个本地引用、215份源码、0错误；共享内容检查248文件通过，git diff --check通过。静态对照确认原28个术语与36个BR/PR/SC编号全部保留、9份原文快照摘要一致，README无安装命令和实时提交状态，应用源码无变更、索引无暂存操作。仅文档和静态索引分类变化，不运行应用业务测试，不把前轮测试记成本轮重验。

**交付与未完成：** 本次修改保存本地，未git add/commit/push、未发布、未迁移真实资料、未新增业务验收。旧敏感历史清理及日常新版本发布仍按原GOV任务另行处理。建议提交说明：docs: 明确项目介绍与五份核心文档职责。

## 2026-10-26｜GOV-11｜运行架构分离源码、配置、数据与测试

**原因与范围：** 用户明确不能仅做本地/Git隔离，需要代码设计本身体现边界。本轮基于前轮未提交修改继续开发；原154项取消跟踪删除保持在索引中，不重新暂存其他文件，不改远端历史。

**实际变更：**
- 新增core/runtime-layout.ts：统一daily/development/test、环境配置与路径；新安装默认把配置/files/runtime/backups放在源码之外。只解析不初始化数据库；错误配置、非绝对环境路径、链接越界及资源目录重叠拒绝启动。旧安装仅通过daily兼容识别保留原布局。
- core/config、backup、ocr、domain/service及升级CLI使用统一布局；备份执行与文件删除保护共用backupDirectoryConfig。start按当前环境定位发布指针，打开已有服务前核对DB；pack默认不读取本机配置，显式私有备份才解析实际环境。
- 新增dev-server及调整根/服务包命令：开发、初始化、预置、重置使用独立开发环境；月度预览也放在源码外。开发与测试入口去除继承的日常路径和常见凭证。测试不再读取根配置或复制日常OCR/前端，OCR测试夹具只读本机测试目录。
- Vite默认18889并核对health的development与预期DB，错误环境的API及文件请求返回503；health/system提供当前环境/配置位置，设置页显示本机配置位置。应用tsconfig只包含源码，本机tsconfig.test.json及新增runtime-layout测试均不上传。
- 修正应用运行依赖：旧版Excel导入的通用PowerShell转换工具由scripts移入core源码并改为模块相对定位，源码包明确包含；原本机脚本仍保留，避免源码交付漏掉运行工具。转换脚本内容摘要与原件一致，PowerShell语法解析通过；最终247文件源码包已核对包含此运行资产。未执行真实Office转换验收。
- 更新共享脚本范围与通用配置样例（files/backups），保留原仓库防护与所有本机原件。README、DATA_BOUNDARIES、开发/运维/换机说明及AGENTS同步当前行为。

**五份文档逐一复核：** GPT_CONTEXT更新本轮接续与兼容边界；CONTEXT核对无业务术语变化；PRODUCT_REQUIREMENTS补充用户确认的运行分离约束；SYSTEM_ARCHITECTURE记录纯路径解析层与调用关系；DEVELOPMENT_PROGRESS记录已实现、验证及未发布状态。队列仍为GOV-11。

**验证：** 14组新增运行环境测试通过，包含在两个临时独立环境中实际启动后端、校验配置/DB路径，以及启动真实Vite验证错误后端请求被阻止、正确后端允许转发；11组原有隔离契约、13组仓库边界、67项单元和8组可靠性回归通过。应用及本机测试类型检查通过。前端构建与源码包检查通过；导出包不含本机配置、测试及夹具，解包后借用已安装依赖完成前后端类型检查和前端构建（未执行全新联网npm ci）。22份文档/203个引用/215份源码的索引检查及差异格式检查通过；154项前轮保留原件SHA256仍一致。未执行完整业务/Office/真实模型验收；未触碰日常数据进行测试。

**交付与未完成：** 本地保存；本轮未新增暂存、commit、push或发布，原154项索引删除继续保留。现有安装解析仍为legacy，运行数据/配置未搬迁，旧发布包未替换。实际迁移、日常发布、远端敏感历史清理及另一台电脑验证尚未执行。建议提交说明：refactor(runtime): 分离源码与日常开发测试环境。

## 2026-10-26｜GOV-11｜源码与本机测试、资料及配置隔离

**目标及用户决定：** 用户要求以后只上传代码，真实数据和配置隔离；经询问明确测试用例及完全虚构夹具也只保留本机、不上传。通用运行器与构建规则属于开发工具，保留共享；本轮不改写远端历史、不发布。

**实施与文件清单：**

- .gitignore改为根目录默认拒绝加明确允许范围，补本机配置、测试、历史证据及私有文件类型；新增scripts/repository-policy.mjs共享策略、check-repository.mjs实际blob检查、install-git-hooks.mjs安装器，以及.githooks/pre-commit、pre-push和.gitattributes。package.json增加repo检查/钩子、prepare和本机test:repository命令，未新增依赖，锁文件不变。
- 钩子已通过本地core.hooksPath启用。pre-commit核对实际暂存blob，pre-push检查全部待发送提交；强行暂存私有路径、源码凭证、链接与历史中间泄露会失败。只报告路径和类型，不回显敏感值。规则检查不等于完整语义定密，安装于客户端，不是GitHub端强制规则。
- 新增workbench.config.example.json，仅含通用相对路径与默认值；原workbench.config.json仅取消跟踪，字节未变。packages/server/src/domain/archive.ts及core/kb-extract.ts的真实单位示例/注释替换为虚构名称，无业务逻辑更改。
- scripts/pack.mjs默认程序包复用路径/内容检查，不再展开真实cfg，排除测试、历史资料和运行配置，只带通用样例；显式with-runtime-state仍为含资料的私有备份。scripts/docs-maintenance.mjs只索引共享文档及源码，本机证据链接标local-evidence且不查询存在性；不再收集测试、历史报告或运行快照的内容和摘要。
- 新增docs/guides/DATA_BOUNDARIES.md；README、AGENTS、DEVELOPMENT/DEVICE_HANDOFF指南与DOCUMENT_CONTROL说明边界及新克隆无用例。五份根文档逐一复核：GPT_CONTEXT/DEVELOPMENT_PROGRESS更新交付；CONTEXT术语不变；PRODUCT_REQUIREMENTS新增用户工程交付约束；SYSTEM_ARCHITECTURE记录策略/钩子/打包/索引结构。PROJECT_PLAN仅接续GOV-11，本记录与自动索引同步。

**取消跟踪及本机保留：** 对154项明确私有/本机文件执行git rm --cached，未删除本地文件。包括packages/server/test下35文件、scripts下33个历史或场景验证脚本、docs下73个历史报告/证据/样例、work下10文件、2个样例生成CLI和根运行配置1文件。操作前后154项SHA-256全部一致；逐文件清单与摘要保存在忽略目录work/repository-isolation-20261026/untracked-local-files.json。新本机测试repository-boundary.mjs也不上传。原有审计任务的9份未提交文档保留，未重置工作区。

**验证：** npm run test:repository的13组本机边界测试通过：正常源码、误暂存、实际索引值、个人路径脱敏日志、未知文件类型、新增提交、泄露中间提交、已存在远端历史后的删除提交、新空远端旧历史、删除引用、Git忽略一致性及凭证规则。npm run typecheck通过；源码程序包244文件均为允许路径，未含测试用例/运行配置，解包后前后端类型检查和Vite构建通过。源码包不携带node_modules，解包验证借用本机已安装依赖，未执行全新联网npm ci。未运行完整业务回归、真实模型或Office验证，未接触正式数据库。文档generate/check通过：22份共享文档、198个本地引用、212份共享源码，0错误；私有引用存在性不再检查。工作区/暂存边界检查和差异格式检查通过；最终154项本机原件摘要仍一致，索引无私有路径，154项均命中忽略规则。

**交付与后续：** 文件本地保存；154项取消跟踪的删除已在索引暂存，这是实现既有文件不再上传所需的限定操作，未暂存其他修改，未commit/push/历史改写。提交时需要将策略、样例和文档一并审查；当前远端3603923及旧提交中的资料仍存在，后续单独授权历史清理。建议提交说明：chore(repo): 隔离源码与本机测试数据配置。默认程序包验证产物位于.tmp，不上传。

## 2026-10-26｜GOV-11｜已推送版本敏感资料核查

**目标与范围：** 用户要求检查这版代码是否把保密文件传上GitHub。本次先fetch，确认本地main与origin/main均为360392383e69351709b8dd206713c4508026502e，开始工作区干净。检查当前390个文件、4个可达提交及404个唯一文件版本（包含14个历史额外版本）。GitHub连接器核实当前仓库private；不据此推断从未公开、无人下载或没有其他协作者。

**已上传且应单独处理的内容（仅记录路径和类别，不复制原文）：**

| 文件/目录 | 核实内容 | 建议 |
|---|---|---|
| work/cleanup-20261021/db-audit.json（1055行起） | 2条workbench业务记录，包括名称、状态、日期、目录及规则快照；不是仅表结构 | 从源码交付范围排除，保留本机原件并检查历史 |
| work/cleanup-20261021/files-before.json | 155项含中文名称的业务文件相对路径、大小和SHA-256；没有文件正文 | 排除本机文件清单及清理证据 |
| docs/制度识别预览.md（92行起有公司名称条目） | 制度/会议等扫描目录与文件名，407行含公司全称；不等于上传完整制度正文 | 移出源码或脱敏成匿名示例，保留本机原件 |
| docs/命名整理报告-工作test.md | 本机资料目录、文件名称及命名整理清单 | 与开发说明分离或脱敏 |
| workbench.config.json、scripts/archive/_zhidu-config.json | 本机资料/备份/扫描路径；未发现密钥字段 | 保留通用配置样例，具体本机配置另管 |
| docs/collab/_acl-reports/ | 路径、ACL/账户SID等机器权限元数据及辅助脚本 | 本机审计产物不随源码交付 |

上述重点文件均可追溯到fd0190e初始提交，之后的3603923合并与推送包含了该历史。历史文档及部分辅助脚本还出现其他本机路径和业务上下文，需要按用途审查；不把所有路径命中都等同凭证泄露。本次没有判断资料的法定密级。

**未发现与误报核验：** 当前树未跟踪data/、outputs/、.tmp/、node_modules/，也未发现原始.db/.sqlite、Word/Excel/PDF、私钥文件。对文本与历史版本扫描常见提供商token、私钥头、凭证赋值、带凭证URL、手机号/身份证和本机路径；未发现可确认的明文API密钥或私钥。2处凭证候选位于local-model测试中，为假token及user:secret拒绝测试；3处手机号形状均为SHA-256片段；3处邮箱位于第三方glob弃用提示。3张原型PNG人工查看为示例界面；含NUL的git-before.txt另按UTF-8检查为Git状态清单，未发现密钥模式。db-before.json只有表计数及摘要，不误报为完整数据库行导出。

**方法与限制：** 以实际远端提交对象为依据，不仅检查.gitignore。检测使用本地规则及人工复核，不请求验证任何候选凭证，不向外发送源文件；外部调用仅为原Git远端fetch、GitHub仓库元数据及GitHub官方历史清理文档。规则扫描并非穷尽所有任意密码/业务敏感信息；未检查其他设备未上传文件、服务器日志、协作者访问或分叉缓存。未运行应用、模型或Office测试。

**本次文件和五份文档复核：** GPT_CONTEXT、DEVELOPMENT_PROGRESS记录范围、风险与后续；CONTEXT术语无变化，PRODUCT_REQUIREMENTS需求无新增，SYSTEM_ARCHITECTURE架构无变化，分别更新复核信息；PROJECT_PLAN仅更新原GOV-11；本CHANGELOG保存脱敏发现。docs/README.md及两份索引按生成器刷新；临时扫描元数据保存在被忽略的.tmp/privacy-audit，不含命中原文。

**文档验证：** generate/check及git diff --check通过：83份文档、510个本地链接、0项错误；16项既有历史证据缺失保留。应用源码、原审计资料、依赖、配置及.gitignore无本轮差异。

**后续与交付：** 目前是核查完成、清理未实施。未改.gitignore、原资料、Git历史、仓库可见性或访问权限；未暂存/提交/推送/发布，业务数据未变。已跟踪文件仅加入.gitignore不会移出版本；只删除最新文件也不能清除旧提交，应先保留本机原件、确定脱敏及历史清理清单，再按用户授权实施。参考GitHub官方removing-sensitive-data-from-a-repository流程。建议本次记录提交说明：docs(audit): 记录已上传资料范围与清理事项。

## 2026-10-26｜GOV-11｜README改为标准软件开发说明

**目标与依据：** 用户要求本地README按正常软件开发文档编写。原README以AI接续导航、目录清理及旧设备发布快照为主，首次安装与开发命令不完整；本轮改为面向使用者和开发者的项目首页。

**文件与变化：** README.md重写项目介绍、功能、技术栈、环境、快速开始、日常启动、本地开发、检查测试、目录结构及文档导航。配置示例使用通用相对路径；分别说明有/无发布指针的启动行为、Vite固定代理、隔离预览及独立构建，未添加不存在的npm脚本。GPT_CONTEXT.md、DEVELOPMENT_PROGRESS.md更新本次交付；CONTEXT.md复核术语无变化；PRODUCT_REQUIREMENTS.md复核需求无新增；SYSTEM_ARCHITECTURE.md复核架构无变化。AGENTS.md、docs/guides/DEVICE_HANDOFF.md和PROJECT_PLAN.md纠正过期的无Git说明，只沿用GOV-11；本CHANGELOG新增记录。docs/README.md、docs/knowledge-index.json、docs/reference/source-inventory.json按生成器刷新，实际差异以本轮清单为准。

**仓库状态澄清：** 本轮开始main为fd0190e且工作区干净；已存在的新Git仓库及origin/main不是本轮创建/拉取。本地缓存的fe328c8已核实只有一行README，是新仓库初始化，不代表遗漏周末业务更新；本地与远端各有一个独立初始提交。旧备份路径当前不存在，不再把清理当时备份成功记录当成当前可用性保证。本轮未合并、重置或推送。

**验证范围：** 静态读取根及子包package.json、start.mjs、dev-monthly.mjs、Vite配置、bootstrap及隔离测试入口，核对README命令与路径；检查文档索引、本地链接和差异格式。仅文档改动，不运行npm ci、构建、启动器或业务测试，不改正式数据；首次安装、真实模型、Office和完整业务验收未在本轮执行。收尾检查通过：83份文档、510个本地链接、278份源码索引，0项错误；16项既有历史证据缺失继续单列。git diff --check通过；本轮13份变动均为文档或索引，应用源码、脚本、依赖声明和运行配置无差异。

**交付：** 文件已本地保存；未暂存、提交、推送或发布。当前运行环境沿用原配置，本轮未做运行验收。后续继续原GOV队列，新仓库合并与推送仍待用户处理。建议提交说明：docs(readme): 重写项目安装开发与测试说明。

## 2026-10-26｜GOV-11｜恢复已下载云端基线并清理目录

**目标与依据：** 用户确认以云端已下载的版本为准，替换原未提交内容，并完成清理及移除.git。选定77887a678bb20f54192f2bee93bf7220d33a5eb6；此前联网见到fe328c8但本机无该对象，用户在明确此差异后仍确认使用已下载版本。用户已告知远端仓库删除，本次不再连接远端。

**原状态与备份：** 开始HEAD为7902f92，本地有17份文档/索引修改，无未跟踪文件。覆盖前将17份文件逐字节核验备份，另存binary patch、状态和保留资产摘要。备份目录：D:/project/工作台清理备份/2026-10-26-cloud-77887a6。local-files与local-changes.patch可查原改动，git-metadata保留完整本地Git元数据（含提交历史与配置），removed保存移出的缓存及构建。

**实际清理：** 先将全部受控文件恢复到77887a6，git diff --exit-code确认无差异。随后将.npm-cache、node_modules/.vite-temp、.tmp下frontend-design-20261023/web、monthly-development/web、ui-design-20261024/web、ui-design-20261024-b/web、ui-design-preview/web共7目录移出项目（33文件、6,178,940字节）；.git亦移出（78文件、75,279,792字节）。合计81,458,732字节约77.69 MiB从项目目录移出，但仍在同盘备份，未释放对应磁盘空间。永久删除命令被自动审批策略拦截且未执行，因此采用可恢复移动，不声称永久删除；验证工具可能重新生成少量缓存。清单见备份cleanup.json。

**保留范围：** data的正式库、文件、备份、发布包和指针，packages/web/dist，node_modules依赖本体，outputs/work及其他.tmp原资料、数据库副本、验收证据均保留；两个等大设计稿目录内容并不完全相同，未按重复文件删除。未执行git clean，未修改业务数据或发布，未升级依赖。运行库由现有进程管理，不读取业务行作比较。

**五份文档与文件清单：** GPT_CONTEXT、DEVELOPMENT_PROGRESS替换最新接续摘要；CONTEXT仅复核术语无变化；PRODUCT_REQUIREMENTS复核业务需求无新增并标明设备范围；SYSTEM_ARCHITECTURE记录源码与运行分离、应用架构无新增。AGENTS、README、DEVICE_HANDOFF说明无Git状态；PROJECT_PLAN只接续GOV-11，本CHANGELOG记录增量；docs/README.md、knowledge-index.json、source-inventory.json由生成器刷新。云端原有历史报告、运行快照保留原设备范围，不把源码恢复解释成当前机器reliability发布。

**验证：** 恢复后受控文件与77887a6无差异；npm run typecheck通过前后端检查；node scripts/test-isolated.mjs --unit reliability-repairs通过8组隔离回归，未使用正式数据库。最终保留资产摘要、健康与文档检查结果见本条收尾验证。

**收尾验证：** 10组保留资产（5,761项文件/链接）的前后SHA-256集合摘要一致；应用源码、脚本及依赖/配置与77887a6再次比对无差异，使用项目外git-metadata只读检查文档差异格式通过。项目.git不存在；8787健康ok、webBuilt=true，发布指针未变。docs-maintenance generate/check通过：83份文档、520个本地链接、278份源码、0项错误；16项既有历史证据缺失保留。无Git时生成器提示not a git repository但已按其无Git兼容路径完成，退出码0。准确文件清单与核验摘要保存于项目外备份verification.json。

**交付与接续：** 本地保存完成，未add/commit/push，.git移出后Git状态/差异命令不适用；未发布、未新增业务验收。源码和测试采用云端基线，本次仅新增清理接续记录。完整业务、真实模型、Office和fe328c8均未验收/恢复，原GOV队列继续。若未来恢复Git，建议将本次文档单独审查，提交说明可用chore(workspace): 恢复云端基线并记录可恢复清理；当前不执行提交。

## 2026-10-24｜GOV-13/11｜首页铺满可用高度

用户指出首页底部留白并要求依照原设计填满。原因是compact.css将桌面首页网格限制为最高650px。本轮仅移除此上限，继续由既有flex/grid分配窗口剩余高度，保留7:5双栏、模块顺序、10px间距、16px底边距及窄屏单列滚动；无业务逻辑、接口、依赖、迁移或数据变化。

- 实际代码文件：`packages/web/src/compact.css`一处修改。其余既有源码/测试差异保留，未作为本轮修改。
- 五份文档复核：GPT_CONTEXT、DEVELOPMENT_PROGRESS更新最新范围、四档验证及未发布状态；CONTEXT术语无变化，PRODUCT_REQUIREMENTS业务需求无新增（落实PR-18），SYSTEM_ARCHITECTURE框架与数据结构无变化，分别更新复核说明。PROJECT_PLAN接续原GOV-13，UI_DESIGN_IMPLEMENTATION补布局证据并明确笔记本历史与台式机当前范围；本记录及自动索引同步。
- 验证：`npm run typecheck:web`、独立前端build通过。内置浏览器在18886全新隔离空库检查1920×932、1366×650、1280×600、768×800；前三档无页面纵横溢出且主要模块可见，大屏网格底部距视口16px，窄屏保持单列滚动。1920档双栏宽比约1.4。原设计PNG本机缺失，依据既有设计文字与本次截图，未宣称逐像素复原。
- 本机证据：`D:/project/工作台审计/HOME_FILL_20261024/viewport-results.json`与`首页填满-1920.png`；独立构建在`.tmp/home-fill-20261024/web`。只验证本次空态布局，未重跑业务完整回归或重新验收其他页面。
- 未完成与交付：源码已本地保存，未暂存/提交/推送/发布，日常仍为reliability-20261024-r1；18886隔离服务已关闭，临时文件保留，视口覆盖已重置。文档generate/check及git diff --check结果在本机收尾日志；其他GOV事项保留。建议提交说明：`fix(ui): 让首页双栏填满可用视口高度`。

## 2026-10-24｜GOV-01/06/08/10/11/12｜台式机首批可靠性修复发布

用户在独立复测后授权“发布吧”。日常入口已切换至`reliability-20261024-r1`；首批9项修复发布完成，完整业务验收和其余审计项不据此关闭。完整范围、核验摘要、回退说明与日志见本机[发布报告](../../../工作台审计/PUBLISH_20261024_R1/发布报告.txt)。外部证据、发布包及备份不随Git迁移。

### 本轮增量与发布依据

- 应用源码、测试、依赖声明没有本轮新增修改。开始时22项修改及1份未跟踪测试继续保留；以前轮次的11份运行源码修复、package.json测试入口及8组可靠性测试构造候选，不把整个脏工作区直接发布。
- 从`7902f92af2e46383ba3cfb8a8188d53e48ac8e10`和原审计文件hash重建基础，先核实后端/依赖/旧前端与发布前运行摘要一致，再叠加本批。新增本地发布包`data/releases/reliability-20261024-r1`（249项运行文件清单）及兼容回退包`data/releases/pre-reliability-20261024-base`。
- 原本机发布指针不存在；新增`data/runtime/current-release.json`并替换配套根前端，旧前端保存到`data/backups/before-reliability-20261024-r1/frontend`。同目录snapshot、配置和旧运行依据保留，restore-check为新目录恢复演练。通过原日常入口启动，当前服务继续运行。
- GPT_CONTEXT与DEVELOPMENT_PROGRESS由“已修复、未发布”更新为本台式机已发布、实际验证及剩余边界；CONTEXT术语无变化，更新复核信息；PRODUCT_REQUIREMENTS需求无新增，更新本机PR-13启用状态及复核；SYSTEM_ARCHITECTURE更新实际发布链和指针事实，业务模型无新增。
- PROJECT_PLAN只更新原GOV状态；OPERATIONS补本机兼容回退和新增数据保护。`docs/reference/current-baseline.json`替换为本机实际发布快照，旧笔记本快照原样保存至`docs/archive/2026-10-24-before-reliability/current-baseline.json`；报告45顶部标注历史设备范围。README、knowledge-index和source-inventory按工具生成。

### 实际验证

1. 准确候选包目录运行`npm test`、`npm run typecheck`、`npm run build`、`npm run test:monthly`全部通过，含可靠性8组及月度14项。
2. 日常库副本在18885隔离演练；结构、40项迁移不变，完整性ok、外键异常0。仅app.data_root按隔离配置改变为临时根，已逐字段核对为预期；其余表内容一致。内置浏览器验证候选记录未保存保护，明确放弃不写库；服务已停止。
3. 停止已核实的旧日常进程后创建最终一致快照，verify通过，实际restore到新目录检查通过；没有覆盖在线库。保存原前端和兼容回退组合，没有执行正式回退。
4. 新日常进程三项加载摘要与候选相同，249项清单文件核验通过；首页及五项业务GET返回200，内置浏览器首页/记录页正常。发布前后72张非sqlite_内部表内容hash、结构、40项迁移、内部文件清单一致（文件0份），完整性ok、外键异常0；正式数据未写入匿名样例。
5. 文档`generate`、`check`及`git diff --check`通过：83份文档、278份源码、282条静态路由、40项迁移索引，检查错误0；44项历史本机证据缺失继续单列。文档检查不是业务验收证明。

### 未完成与交付状态

未做真实模型、全套OCR等test:all扩展、原生Office分页/打印或完整业务验收；整数算法、历史数据边界、单进程并发限制、旧partial及原GOV未完成项保留。历史笔记本ui-design包和69表/155文件结论不覆盖本机；本机原40项迁移（含038/039/040）保留，本轮无新增迁移。

本地文件已保存；本台式机发布完成，未暂存、提交或推送Git，其他设备未发布，完整业务验收未完成。建议本轮提交说明：`docs(release): 记录台式机可靠性修复发布及恢复依据`；既有源码与测试应按此前批次另行审查提交。本轮准确文件清单见外部发布报告与交付清单。

## 2026-10-24｜GOV-01/06/08/10/11/12｜首批修复独立复测与覆盖补强

用户要求根据修改再测试一遍。本轮基点仍为main / `7902f92af2e46383ba3cfb8a8188d53e48ac8e10`，开始已有22项修改及1份未跟踪测试，全部保留；应用源码与package.json的差异经前后比对未改变。实际补测和原始日志见本机[修复后复测报告](../../../工作台审计/RETEST_20261024_R2/修复后复测报告.txt)，证据不随Git迁移。

### 本轮增量

- 修改已有未跟踪的`packages/server/test/reliability-repairs.ts`：由7组扩展至8组，新增档案字段/清单状态/文件摘要/设置/模型用途五类动作的人工冲突、force拒绝及正常撤销；与原负责人测试合计覆盖六类覆盖写。工时测试补缺失输入导致失败、恢复后8路并发、完成后复用；照片测试增加不同图片字节的精确比对。
- GPT_CONTEXT、DEVELOPMENT_PROGRESS更新独立复测、未发布及样例保留状态；CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE逐一复核，术语/需求/架构无新增变化，只更新复核说明。PROJECT_PLAN在原GOV队列补记验证，CHANGELOG记录本轮增量。
- 自动生成的docs/knowledge-index.json、docs/reference/source-inventory.json更新hash与源码导航。没有新增应用代码、依赖、迁移、配置或发布包变更；上轮11份源码修复不算本轮新增完成。

### 实际验证

1. 本轮重新运行`npm test`通过（当时可靠性7组）；`npm run test:monthly`14项、`npm run typecheck`及隔离前端构建通过。
2. 补强后`node scripts/test-isolated.mjs --unit reliability-repairs`8组通过，随后`npm run test:regression`及`npm run typecheck`再次通过。最终测试日志分别为reliability-expanded.log、regression-final.log、typecheck-final.log。
3. 内置浏览器在全新18884隔离组合实测正文离开保护、继续编辑、正常保存、保存后正常离开、空正文仅性质变化保护、明确放弃、服务重启及冷刷新后持久性。只有1条已保存匿名记录，放弃内容未入库；截图与AX文本保存在外部报告同目录。服务已正常关闭。
4. 日常库只读核对原有业务行hash和数量、结构及迁移均无变化，完整性ok、无外键异常；8787健康正常，current-release.json仍不存在。未将其旧运行组合计作修复版验收。
5. `node scripts/docs-maintenance.mjs generate`、`check`及`git diff --check`通过：83份文档、278份源码，无检查错误；44项历史本机证据缺失仍单列。文档检查不是业务验收。

### 交付和边界

九项修复的上述验证均通过，本轮未发现回归故障。未进行真实模型、全套OCR等test:all扩展、原生Office分页/打印或完整业务验收；原GOV未完成项及旧数据兼容限制保持有效。

本地已保存；未暂存、提交、推送或发布，业务验收未完成。本轮`.tmp/reliability-preview-r2`保留匿名样例及构建供复查，服务已关闭；上轮被自动审批拦截清理的目录未触碰。建议提交说明：`test(reliability): 扩展撤销冲突和定稿失败重试复测`。准确本轮增量清单见外部报告，不将当前整个工作区差异统一算成本轮修改。

## 2026-10-24｜GOV-01/06/08/10/11/12｜首批审计问题修复与隔离验证

### 目标与依据

用户在完整审计及首批修复建议后授权“可以，你进行修复”。本轮处理原审计F02/F03/F08/F09/F12/F22/F23/F24/F31，不把31项全部标记关闭。基点main / `7902f92af2e46383ba3cfb8a8188d53e48ac8e10`；开始已有五份根文档未提交修改，保留并接续更新，旧版本与差异在本机外部修复证据目录。原审计报告保留，修复结果另见[修复与验证报告](../../../工作台审计/FIX_20261024_R1/修复与验证报告.txt)，该证据不随Git迁移。

### 本轮文件增量

| 文件（均相对仓库根） | 操作与前后变化 |
|---|---|
| packages/server/src/domain/agent.ts | 修改：覆盖写动作执行后保存目标值；撤销先比较，拒绝覆盖后续人工新值和无快照的历史动作，force不绕过 |
| packages/server/src/core/backup.ts | 修改：停止按文件名/年龄删除旧partial；唯一临时路径仅清理本次创建文件 |
| packages/server/src/core/template.ts | 修改：保护token恢复也进行Word XML转义及换行/tab编码 |
| packages/server/src/domain/timesheets.ts | 修改：同run并发定稿共享Promise，避免重复成果，结束后释放 |
| packages/server/src/core/trash.ts | 修改：重复删除父对象不再级联；独立操作的删除时间不碰撞；父恢复只恢复同批子项；提供父状态文件过滤 |
| packages/server/src/core/store.ts、search.ts、search-all.ts | 修改：普通列表/读取/索引及两类搜索统一排除已删除父工作下的文件，旧索引也不泄出 |
| packages/server/src/domain/workflow.ts | 修改：首页关联待办检查父工作删除/归档状态 |
| packages/server/src/domain/generate.ts | 修改：预览/保存传递inspectionId，取图同时约束期次和具体检查 |
| packages/web/src/pages/WorkRecords.tsx | 修改：记录输入复用NavigationGuard；原表单保存，离开前可继续编辑或明确放弃 |
| packages/server/test/reliability-repairs.ts | 新增且未跟踪：7组隔离回归，覆盖上述边界、实际DOCX/Excel生成及外键检查 |
| package.json | 修改：可靠性回归加入test:regression/default npm test；无依赖声明变更 |
| 五份根文档、docs/management/PROJECT_PLAN.md、本文件 | 修改：接续状态、实现约束、原GOV状态、实际交付与限制；不新增并行队列 |
| docs/README.md、docs/knowledge-index.json、docs/reference/source-inventory.json | 自动生成：文档目录、hash、源码hash/符号/路径及新增测试导航；不是发布证明 |

未修改迁移、锁文件、运行配置、真实资料、根dist及发布指针。本轮前既有依赖准备、审计服务和原审计报告不算本轮应用修改。

### 验证与证据

- `npm test`：最终完整运行通过，包含新增7组回归；`npm run test:monthly`：14项通过；`npm run typecheck`：server/web通过。日志在上述报告同目录。新增夹具路径、搜索返回字段、Excel总计公式和Buffer类型断言曾修正，最终均复验通过。
- 隔离构建：`npm --workspace @workbench/web run build -- --outDir D:\project\工作台\.tmp\reliability-preview-r1\web` 通过；通过isolationEnv与test-preflight启动18883，内置浏览器验证未保存拦截、继续编辑保留、原表单保存后刷新、明确放弃不入库。截图保存在报告目录；临时服务正常关闭。
- 真实生成验证：特殊字符DOCX文字/换行/tab及结构检查；同月两次检查和未归属照片的预览/保存媒体隔离；双并发工时定稿只一份成果；父子恢复、陈旧索引、待办及备份无关文件保留。未进行本轮Word/Excel原生视觉和打印验收。
- 日常库仅只读：与原审计hash及清理后数量对比，原有行/业务数量、结构、迁移集合不变，完整性ok、无外键异常，data/files无测试残留。8787健康正常，发布指针不存在；未重启或替换其加载组合。
- `node scripts/docs-maintenance.mjs generate`、`check` 及 `git diff --check` 通过：83份文档、278份源码、282条静态路由声明、40项迁移索引；无检查错误。缺失的历史本机证据仍如实列出，不是仓库链接错误，也不据此补造历史验收。

### 五份根文档逐一复核

GPT_CONTEXT更新首批范围、当前本机运行边界与接续事项；DEVELOPMENT_PROGRESS更新源码修复、隔离测试、未发布/未验收状态；SYSTEM_ARCHITECTURE补充快照比较、进程内并发、同批恢复、照片过滤和临时路径所有权约束。CONTEXT业务术语无变化，更新复核说明；PRODUCT_REQUIREMENTS业务需求基线无变化，记录既有保护要求的落实。版本仅在状态/结构正文变化的文档递增。

### 未完成与交付状态

其他审计项及完整功能矩阵仍未完成；GOV-01文件占用/失败补偿、GOV-10真实模型/Office、GOV-08候选发布、GOV-12整数算法/真实业务核对、GOV-11跨机与pack缺项保留。旧删除时间碰撞不能反推历史归属；无执行后快照的旧助手动作拒绝自动撤销；备份旧残片保留；工时保护不宣称支持多进程并发崩溃恢复。

本地已保存；未暂存、未提交、未推送、未发布，业务验收未完成。隔离服务已关闭，但递归清理`.tmp/reliability-preview-r1`的命令被自动审批审核拦截（blocked by policy，未提供更具体原因），隔离样例与构建保留，未绕过删除。建议提交说明：`fix(reliability): 防止撤销覆盖、检查串图和重复定稿并收紧恢复边界`。需一起审查新增测试，五份文档含此前未提交内容；不要把整个工作区旧改动统称本轮完成。

## 2026-10-24｜GOV-11｜Git设置与待提交遗漏核查

### 目标与依据

用户要求查看Git设置并检查有无遗漏待提交内容。核查仅使用Git只读命令、GitHub仓库元数据、文件列表及引用关系；未暂存、提交、推送、拉取合并、修改配置或放开忽略规则。本轮开始HEAD为 `fee4915b4186d529682f7bce2b8f6a3715105f4d`，分支main。

### Git设置与忽略规则结论

| 检查项 | 结果 |
|---|---|
| 远端 | origin指向naobuqingjiaosha/Workbench，GitHub元数据确认private，默认分支main |
| 分支与远端提交 | main跟踪origin/main；实时 `git ls-remote origin HEAD refs/heads/main` 与本地HEAD相同；本地跟踪比较ahead/behind为0/0 |
| 待保存到Git的改动 | 41项已跟踪修改、18项未跟踪新文件、暂存区0；这些内容均未因当前HEAD与远端一致而自动同步 |
| 身份与隐藏文件设置 | user.name/email均已配置；未发现assume-unchanged/skip-worktree标记；无有效本地hook、附加全局excludesfile或attributesfile配置 |
| 换行和平台设置 | core.autocrlf=true、core.ignorecase=true、core.filemode=false、core.symlinks=false；仓库无.gitattributes。当前未发现由这些设置导致的漏交，不为规范行尾批量重写文件 |
| 源码和文档误忽略 | 对docs、scripts、server/src、server/test、web/src的忽略文件核查为空；根现有文件均已跟踪 |
| 有意忽略 | data、outputs、dist、依赖和临时目录，以及私有环境文件；正式运行快照/包不应直接放开data规则提交 |
| 已跟踪本机配置 | workbench.config.json已跟踪，dataRoot含本机绝对路径；配置字段检查未见非空密钥字段，.npmrc未见绝对路径设置。本轮不是全仓或历史密钥审计 |

仓库私有不改变业务资料保护范围。Git推送只传递已提交内容；只提交已跟踪修改（例如commit -a）仍会漏掉下列18项。未重新构建或测试这些既有候选，因此“需保持提交完整”不表示本轮批准其正式发布。

### 容易漏交的18项新文件

以下全部处于未跟踪状态，没有被.gitignore隐藏；应与各自相关改动一起审查纳入提交。

| 分类 | 文件 |
|---|---|
| 发布报告 | docs/45-前台设计限定发布-2026-10-24.md |
| 原文快照 | docs/archive/2026-10-24-before-closeout/DEVELOPMENT_PROGRESS.md |
| 原文快照 | docs/archive/2026-10-24-before-closeout/GPT_CONTEXT.md |
| 换机指南 | docs/guides/DEVICE_HANDOFF.md |
| 界面实施指南 | docs/guides/UI_DESIGN_IMPLEMENTATION.md |
| 正式变更记录 | docs/management/CHANGELOG.md |
| 隔离预览样例脚本 | packages/server/test/ui-design-seed.ts |
| 紧凑布局样式 | packages/web/src/compact.css |
| 年度台账界面 | packages/web/src/components/AnnualLedgerWorkspace.tsx |
| 共用界面组件 | packages/web/src/components/DesignSystem.tsx |
| 离开保护 | packages/web/src/components/NavigationGuard.tsx |
| 工作集合读取 | packages/web/src/components/useWorkbenchCollection.ts |
| 全局设计样式 | packages/web/src/design.css |
| 首页样式 | packages/web/src/home.css |
| 首页检查脚本 | scripts/check-dashboard-layout.mjs |
| 交互检查脚本 | scripts/check-ui-design.mjs |
| 窗口密度检查脚本 | scripts/check-viewport-density.mjs |
| 隔离预览入口 | scripts/preview-ui-design.mjs |

App、AnnualLedger、Dashboard、main.tsx等已跟踪文件直接引用上述新增组件或样式；预览入口引用ui-design-seed。仅提交旧文件的修改会造成新设备缺少被引用文件。应以本次功能为单位审查完整依赖，不把18个新文件与对应41项修改割裂处理。

### 被忽略但需要另行保管的资料

- `outputs/ui-design-reference-20261024-v2`当前有23张PNG及2份Markdown说明（目录总计32个条目）。这些设计依据不会随Git传递；后续逐图验收需要单独移交，或审查后择取到受控文档目录。本轮没有复制资料或放开整个outputs。
- `data/runtime/current-release.json`、所选data/releases包和根packages/web/dist被既有规则忽略；它们是正式运行移交范围，不等于应提交到源码仓库的遗漏。
- `workbench.config.json`不是漏交文件，但新设备须核对dataRoot绝对路径；凭证、数据库和外部原件不随源码自动同步。报告27的13项历史本机证据仍缺失。

### 本轮文件修改与五份文档复核

| 文件 | 本轮变化/复核 |
|---|---|
| GPT_CONTEXT.md | 替换最新交接事项为Git核查，记录41/18/0、操作边界及接续步骤 |
| CONTEXT.md | 更新复核说明；业务术语无变化 |
| PRODUCT_REQUIREMENTS.md | 更新复核说明；业务需求及手动Git责任无变化 |
| SYSTEM_ARCHITECTURE.md | 更新复核说明；架构和依赖无变化，指出新增文件引用的完整性要求 |
| DEVELOPMENT_PROGRESS.md | 更新最新任务范围、核查结果和验证入口 |
| docs/guides/DEVICE_HANDOFF.md | 增补未跟踪文件、设计依据及本机绝对路径的接续检查 |
| docs/management/CHANGELOG.md | 保存本条设置核查、18项清单、验证和交付状态；该文件本轮开始已未跟踪，不算本轮新建 |
| docs/README.md、docs/knowledge-index.json、docs/reference/source-inventory.json | 执行生成器刷新；内容无变化的生成目标保持原样 |

### 验证与交付状态

- 已执行Git分支/状态/配置、忽略与索引标记检查、远端ls-remote及GitHub私有属性读取；完成新增组件和样式引用核对。
- 本轮docs-maintenance generate/check及git diff --check通过：83份文档、516个本地链接、0错误；13项历史本机证据缺失保持原限制。前后摘要对比确认仅8份文档/索引文件变化，HEAD与Git索引摘要不变；未运行应用测试，未改变应用或数据。
- 文件保存到本地；Git暂存、提交、推送均未执行；正式发布和业务验收均未新增。
- 建议本轮文档提交说明：`docs(handoff): 记录Git设置核查与待提交遗漏`。该说明仅描述本轮文档增量，不能用来概括所有既有UI和服务端修改。
- 下一步由用户审查功能范围、同时纳入必需新文件及相关修改后手动提交/推送。检查时的41/18/0是有时点的快照，实际操作前重新查看Git状态。

## 2026-10-24｜GOV-11｜本地保存与变更记录规范化

### 目标与依据

用户要求每次任务完成后保存本地文件，由用户手动推送Git，并正式规范修改内容记录、检查和修正已有不一致。本轮审查范围为五份根文档、AGENTS、README、项目计划、文档治理、开发/换机指南和索引生成规则；不是对全仓业务代码的功能审计。

任务开始时分支为main，已存在Git基点 `fee4915b4186d529682f7bce2b8f6a3715105f4d`，工作区已有大量源码和文档改动。基点只标识已提交历史，不表示所有开发候选或日常发布都对应它。本轮没有把既有业务代码差异计入自身修改。

### 检查发现与处理

| 原问题 | 修正结果 |
|---|---|
| “每次保存”与Git暂存、提交、推送责任不够明确 | 明确执行者本地保存，用户手动推送；默认不自动add/commit/push，授权本地提交与推送分别处理 |
| 缺少逐任务、逐文件说明及统一验证/交付状态 | 新增本变更记录和必填格式，清楚区分保存、暂存、提交、推送、发布、业务验收 |
| GPT_CONTEXT及进度反复追加咨询和阶段文字；发布前候选被标为“当前” | 当前入口压缩为接续表和当前结论；历史阶段移到原文快照和报告链接 |
| README仍将10月21包称为当前；治理文件写死旧快照日期；GOV-08仍引用“当前039版本” | 对齐报告45和10月24快照，改为按实际指针/完整迁移集合判定；未重新运行服务验证 |
| 术语文档混入技术部署建议，五份文档复核格式不一致 | 术语正文只保留业务定义，补齐元数据；其他文件按职责复核并链接本记录 |
| 索引初始基线日期容易被误读为本次生成时间 | 明确baselineDate的既有含义及展示；不以文档生成冒充运行快照刷新 |

### 本轮修改清单

路径相对仓库根；“修改”表示相对本轮开始时文件的增量。DEVICE_HANDOFF等已有未跟踪文件仍属既有内容，本轮只修改相关部分；本轮新增文件明确标注。

| 文件 | 操作 | 具体变化及原因 |
|---|---|---|
| [AGENTS.md](../../AGENTS.md) | 修改 | 固定本地保存、用户手动推送责任，增加变更记录和本轮增量边界要求 |
| [GPT_CONTEXT.md](../../GPT_CONTEXT.md) | 修改 | 用当前接续表、正式基线、业务约束和收尾入口替代重复阶段叙述 |
| [CONTEXT.md](../../CONTEXT.md) | 修改 | 补文档ID/版本/日期，业务术语不变；移除部署方案过程描述 |
| [PRODUCT_REQUIREMENTS.md](../../PRODUCT_REQUIREMENTS.md) | 修改 | 明确开发接续的保存、记录和Git责任及验收条件；其余业务需求不变 |
| [SYSTEM_ARCHITECTURE.md](../../SYSTEM_ARCHITECTURE.md) | 修改 | 明确架构未变、建议未实施，将Git责任链接治理规范 |
| [DEVELOPMENT_PROGRESS.md](../../DEVELOPMENT_PROGRESS.md) | 修改 | 整理当前交付、已有正式基线、能力状态、未闭环事项和历史入口 |
| [README.md](../../README.md) | 修改 | 修正旧发布版本与验证边界，增加变更记录及手动Git同步入口 |
| [DOCUMENT_CONTROL.md](DOCUMENT_CONTROL.md) | 修改 | 建立五份文档责任矩阵、六项记录字段、保存与Git状态、检查顺序及提交标题格式；修正快照日期解释 |
| [PROJECT_PLAN.md](PROJECT_PLAN.md) | 修改 | 更新GOV-11职责与出口，压缩重复咨询记录，修正GOV-08旧基线表述 |
| [DEVELOPMENT.md](../guides/DEVELOPMENT.md) | 修改 | 补040快照边界、正式收尾步骤和用户手动推送责任 |
| [DEVICE_HANDOFF.md](../guides/DEVICE_HANDOFF.md) | 修改既有未跟踪文件 | 将切换流程明确分为Codex本地保存/记录和用户手动提交/推送，不增加远程依赖 |
| [CHANGELOG.md](CHANGELOG.md) | 本轮新增 | 保存本次审查、逐文件变化、验证、文档复核与交付状态；后续任务沿用 |
| [规范化前GPT_CONTEXT](../archive/2026-10-24-before-closeout/GPT_CONTEXT.md)、[规范化前进度](../archive/2026-10-24-before-closeout/DEVELOPMENT_PROGRESS.md) | 本轮新增 | 保留重大重整前的完整原文；原文作为文本快照，避免其相对链接误解为当前入口 |
| [docs-maintenance.mjs](../../scripts/docs-maintenance.mjs) | 修改 | 注册变更记录为当前管理文件；澄清索引初始基线日期和历史快照栏目 |
| [docs/README.md](../README.md)、[knowledge-index.json](../knowledge-index.json)、[source-inventory.json](../reference/source-inventory.json) | 重新生成 | 同步实际文档分类、链接与源码摘要，不手工伪造运行证据 |

### 五份根文档复核

| 文档 | 复核结论 |
|---|---|
| GPT_CONTEXT | 已更新当前任务、Git基点/职责和接续入口；正式基线按报告及快照标注时效 |
| CONTEXT | 已更新元数据和复核说明；业务术语无变化 |
| PRODUCT_REQUIREMENTS | 已更新开发接续与交付约束；业务功能和业务规则无变化 |
| SYSTEM_ARCHITECTURE | 已更新文档职责和接续边界；应用结构、依赖、接口、数据库无变化 |
| DEVELOPMENT_PROGRESS | 已更新本次交付和当前/历史分层；未把本轮文档检查当作应用或业务验收 |

### 验证记录

| 检查 | 实际结果与边界 |
|---|---|
| `node --check scripts/docs-maintenance.mjs` | 通过；校验修改后的索引脚本语法 |
| `node scripts/docs-maintenance.mjs generate` / `check` | 通过：83份文档、515个本地链接、277个源码文件，0错误；13项历史本机证据缺失仍报告为限制 |
| `git diff --check` | 通过；仅验证差异格式，不代表应用测试通过 |
| 本轮前后文件摘要核对 | 共18个新增或变更文件，均在本条清单；无文件删除、无packages业务源码/测试变化 |
| 原文快照核对 | 两份快照中保存的原文摘要与本轮重整前文件一致 |
| Git状态保护 | 分支、HEAD、Git索引文件摘要均保持本轮开始值；未自动暂存、提交或推送 |
| 当前/历史表述检查 | 当前入口已修正；实施指南中“未切换”仍保留为明确标注的发布前历史，不改写原证据 |
| 应用、模型、Office及新设备验证 | 未执行；本轮未改应用功能，仅为文档和索引维护 |

### 交付状态

| 状态层 | 本轮结果 |
|---|---|
| 本地保存 | 上表文件已写入工作区，最终检查结果见验证记录 |
| Git暂存 | 未执行自动暂存；保留原有暂存状态 |
| Git本地提交 | 未执行；任务基点不等于本轮提交 |
| 远端推送 | 未执行，由用户手动操作；远端状态未核实 |
| 正式发布 | 未执行，正式指针和数据不在本轮修改范围 |
| 业务验收 | 未新增，原未验收事项继续按项目计划处理 |

建议提交标题：`docs(handoff): 规范本地保存与多设备接续记录`。只供用户审查使用；当前工作区另有业务代码差异，不能按本条标题将全部差异一并归为文档整改。

### 未完成项与下一步

- 报告27关联的13项本机历史证据缺失仍须保留说明，不能声明已修复或可随包移交。
- 现有pack遗漏开发接续资料、发布指针和发布包的问题仅完成记录，未修改打包逻辑。
- 本轮没有执行Git提交/推送或第二台电脑接续验收；用户按上述清单审查后自行进行Git操作。
- 真实模型、Office、整数工时、工作记录发布等原任务仍见[项目计划](PROJECT_PLAN.md)。
