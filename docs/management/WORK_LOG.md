# 项目工作日志

文档ID：PM-WORK-LOG。版本：1.37。更新：2026-11-10。性质：逐次实际工作的过程与交付记录。

每项任务一条记录，最新在前；同一任务的补充合入原条目，不为每次操作新建日志文件。记录当时的目标、依据、修改、验证、五份文档复核、未完成项与交付状态。当前有效说明维护在对应主文档，执行队列只维护[PROJECT_PLAN](PROJECT_PLAN.md)。格式见[文档治理第5节](DOCUMENT_CONTROL.md#5-任务收尾与变更记录规范)。

[CHANGELOG](CHANGELOG.md)保留启用本日志前的已有历史，不迁移或重复抄写。历史记录中的“本机”“已发布”“未提交”仅代表当时；当前状态见[开发进度](../../DEVELOPMENT_PROGRESS.md)。日志不包含业务正文、凭证或私人配置值。

## 2026-11-10｜GOV-02 / GOV-05 / GOV-06 / GOV-10 / GOV-11 / GOV-12 / GOV-13｜个人工作台整体验收与候选交付

从 `main/913b002` 和已有未提交工作开始，保留原修改，使用 `codex/workbench-delivery`。以需求、基点源码与实际运行交叉核对，修复落在现有 React、Fastify、SQLite、工作类型及实例快照上。业务进度见[开发进度](../../DEVELOPMENT_PROGRESS.md)。本条记录区分源码、候选和运行验证。本机已知日常指针为 `d2b1d8ffa9f8`，本轮未切换。以下三个案例的旧用户操作和 Windows 已加载版本均未知。

| 交付案例 | 需求、旧理解与实现 | 旧验证与交付断点 | 本轮从界面到成果的复核 |
|---|---|---|---|
| 工时整数与月度归属 | 已要求今后分配整小时、保持个人总量；旧需求保留了这一条，旧迭代将它单列待办。基点 `timesheets.ts` 仍按 0.01 小时均分。 | 早先批次验证人员或文件识别，未核对整数输出；旧构建成功不能证明新口径进入成果。历史九月原件保留。 | `33fb212` 实施工时链路，`37a9631` 修复独立反例。浏览器实算与导出；按模板、研发、考勤单元格独立逐项对账，别名人员的驻场项目、扣薪和人工调整保留，冲突时阻止定稿。 |
| 重复提醒被建成单次 | 简单事项只需提醒，创建页有频率与提醒日；基点 `Workbench.tsx` 提交固定 `once`，通用行政新建还会被服务端引向工作记录。 | 选项和文案已在源码中，旧页面/构建检查未贯穿创建、重开和下一次到期。当时日常包中的实际点击没有证据。 | 合成工作从新建到首页查看、提前提醒、办完本期和重开均走真实页面；下次日期推进，工作仍在办，没有多建材料期次。 |
| 历史项目日期与材料就绪 | 历史结束可确认，未知日期应留空。旧表单预置当天并发送；项目页面就绪清单与完成、归档服务分别计算，含阶段的工作可能漏核工作级必备文书。 | 基点后端本可接受空日期，绕开表单的检查会漏过误填。局部流程能生成文件，也无法证明已有真实证明或具备归档条件。 | 统一页面与提交门槛。真实页面核对未填历史日期、附件下载与缺件拒绝、人工注明不适用、重开项目；隔离服务另验工作级文书、停用模板及旧快照。 |

**验证条件与修复。** 原源码交付规则排除全部用例，干净检出按旧 `npm test` 寻找私有测试失败。现将生成合成夹具的用例及隔离运行器随源码交付，真实附件、配置与旧机专属证据仍只留本机。浏览器复测了切至 B 遇 503 后只显示失败、重试读取 B。旧库升级和数据库加文件快照在新目录恢复，核对内部绝对路径重定位、外部引用标识及文件内容，拒绝损坏快照与覆盖已有目录。例会、清廉月季、年度台账、真实文件渲染与限制详见[本轮核验矩阵](QUALITY_AND_ACCEPTANCE.md#41-本轮隔离验证)。项目未增加迁移，未修改日常库、原件或历史成果。

**文档与接续。** GPT_CONTEXT 衔接候选入口，CONTEXT 区分完成、收起和归档，PRODUCT_REQUIREMENTS 与 SYSTEM_ARCHITECTURE 对齐工时、期次与材料规则，DEVELOPMENT_PROGRESS 区分源码、候选和日常。GOV 队列继续承接 Windows 启动与 Office、真实授权样例及模型验收。工程批次依次为 `d83cb5a`（隔离与恢复）、`33fb212`、`37a9631`（工时）、`66fefe1`（提醒、跨期材料、项目）、`ffa0d03`（台账）、`5b9070f`（可复现测试与候选启动）。

**首包复验。** 从 `5b9070f` 压缩包实际启动，匹配其源码、前端、锁文件及健康身份。生产界面复现月检草稿已写入但保存回执丢失时重开遇到 409。实际导出再重算、打印，发现短月表尾在空日期下仍有两个零，部门合计标签与人员总计混淆。该包留作修前对照。首页/工作列表、配置版本、关联记录和附件变更的本机专项另行运行；旧记录、设置用例只修正创建夹具所需的已发布版本，既有断言保留。

**最终候选。** 修复后的软件提交 `92f60991669b35f2c6508a80291432ee12a37b7b` 已推送并与远端工作分支逐字核对。`WorkBench-92f6099.zip` 的 SHA-256 为 `cca9c65a4d13f4fa8367401347da46a998d2dd1b396c3e34cc14f90051761233`。ZIP 内容逐文件匹配源码交付策略，未附业务库、真实模板、配置、凭据或依赖缓存。完整软件文件清单可由 `git diff --name-status 913b002..92f6099` 重现。源码提交、实际启动和 Windows 业务验收分别记录。

从该 ZIP 解压到新目录，以 Node 24.22.2 / npm 11.19.1 按锁离线全新安装；同包使用普通源码启动器和独立预览根，核对指针、实际响应、源码和依赖摘要。候选前端摘要为 `d394108790b45368c40771d8189c478654bb263bf44dce1214c984e069ca4f2c`。类型检查、`npm test` 和 `npm run test:browser` 均由解压副本实际运行。已复现并验证草稿保存回执丢失、同文不同来源冲突后的明确选择，重开能继续登记。四份 XLSX 和两份 DOCX 经 LibreOffice 检查九页；对最终工时原件删除 39 个公式缓存后重算，研发/部门/个人为 1/13/14，短月余列空白。试用材料包的 SHA-256 为 `7a1300c5eb0a6377c0758e9c994c032f88425c83e2537fdb11d180e7e785d1b1`。外部模型仅做回环模拟，未产生付费请求。

本机交付物保存在 `outputs/workbench-delivery-20261110/`。程序 ZIP、合成试用材料 ZIP、交付核验和改动清单分别提供。Mac 日常进程启动时间与指针保持原值，Windows 尚未发布；正式资料、旧 XLS 转换、目标 Office、真实模型验收由原 GOV 队列接续。软件批次已保存、提交、推送，交付记录另作仅文档提交。

## 2026-11-10｜GOV-12 / GOV-13｜人员范围仅依据本月明确名单

**依据与边界：** 用户明确当前未纳入人员继续不纳入，但不能把姓名写死成规则或永久黑名单；其他来源人员也不自动加入确认范围。本项在Darwin、Mac原仓库main/913b002a613d4b06b0a67172b009885af6fb30d1串行实施，保留起点22项未提交修改，空索引。不读取或改写正式人员名单、偏好或历史，不迁移、不更新日常实例，不新建代理/会话或转云端，不add/commit/push。

**五个应用文件：** packages/server/src/domain/timesheet-workspace.ts移除模板人员特定姓名过滤与默认excluded名单，返回完整来源候选，旧偏好原样读取；MonthlyTimesheet.tsx去掉姓名专属示例，把历史偏好仅显示为参考，模板候选与本月明确名单分开。沿用原名单文本框作为用户确认入口，空名单提示并禁算；独立切月旧名单只作候选，不自动确认新月。packages/web/src/components/project-report-input.ts的模板安装函数不再填入requiredPeople或assignments，只更新来源候选并保护已有清单/参与关系。packages/server/src/api/routes-timesheets.ts及domain/timesheets.ts在新建计算前要求非空明确名单，取消回退模板人员；仅重建已有的通用“名单外”派生排除标记，之后用户明确纳入不会被旧自动标记阻挡，其他人工依据保留。现有显式加人入口保留，不因去掉过滤就自动加任何人，不设置替代姓名特例，不改变整数分配。

**验证：** 新增仅本机packages/server/test/monthly-roster-scope.ts，经根隔离入口完成9组：默认无排除、旧偏好只读、完整模板候选但不预填、已确认子集保护、无/空/重复名单无写入、模板/研发/考勤额外人员不参与实际计算、以后明确扩员及原加人入口、旧历史不变、月报/考勤采用不改名单、真实React SSR候选/名单/异期草稿。测试姓名全部为合成内容。运行源码与scripts扫描确认原三处特定姓名引用均已移除；另核对运行代码没有模板/偏好自动赋值为requiredPeople的残留路径，不把静态扫描当作真实名单验收。npm run typecheck通过；原月报15组和工时输入12组分别回归通过，月报模板初始预填断言按新授权改为名单/参与保持空，原清单和来源保护断言保留。82模块隔离构建通过，主包约1.51MB体积提示仍在，未扩展拆包。测试正常退出并清理专属根，证据仅本机outputs/monthly-roster-scope-20261110；新增与调整的测试及所有夹具/报告继续被既有规则忽略。

**文档复核：** GPT_CONTEXT整合当前人员范围及未应用状态；CONTEXT区分本月明确名单与来源候选；PRODUCT_REQUIREMENTS明确名单外默认不纳入、无姓名规则、以后显式变更及不自动扩员；SYSTEM_ARCHITECTURE说明候选展示、无名单API保护与通用派生排除重建；DEVELOPMENT_PROGRESS按当前实现及各组验证范围整合。五根按全文口径和本会话既有上下文复核，未覆盖其他任务有效结论。USER_GUIDE补名单操作，MONTHLY_DEVELOPMENT替换个人默认排除文案并区分旧环境发布事实与当前源码候选；PROJECT_PLAN沿用GOV-12/13，QUALITY_AND_ACCEPTANCE区分SSR/接口与实际交互。索引generate/check、repo:check及git diff --check按本机报告核实。

**保存与未验收：** 五个应用文件及必要文档已保存，原月报解析/预览、考勤辅助函数、首页/列表应用文件与任务起点字节一致，其他无关改动保留。HEAD与空索引不变，日常指针仍d2b1d8ffa9f8，未运行或更新日常版本、未操作正式数据。本月范围通过“保留既有明确名单、来源仅候选、空名单不计算”保护；不能声称已经查验或修改真实人员名单。锁屏下未执行浏览器：偏好慢响应、实际填写/清空、模板切换、切月/返回、草稿保存重开、响应式仍待解锁；无Office、真实业务/模型、完整旧套件、独立审查或跨进程验收。建议提交说明：fix(timesheets): use explicit monthly roster without name-specific defaults。工作区混有前序修改，不可全量视为本项。

## 2026-11-10｜GOV-12 / GOV-13｜独立本月项目月报导入与确认

**目标与依据：** 用户明确部门项目资料是当月开展项目的独立XLSX，按WorkBuddy交接区分研发人日约束、上期部门模板、考勤、月报项目参考与经营项目正式名称/合同。本项只在Darwin及原Mac仓库实施，main/913b002a613d4b06b0a67172b009885af6fb30d1、上游tracking同SHA、空索引；起点17项修改和此前两项输入修复保留。用户已给出实际附件的核验结构，本项无需打开原件，未复制真实附件至仓库、测试或日志；合成用例不含真实项目明细。不创建代理/会话，不转云端，不提交推送或更新日常实例。

**源码增量：** 新增packages/server/src/domain/project-report.ts，按唯一表头发现项目名、建设单位、本月完成及比例，跳空页、容许移位和空格换行；歧义/重复表头、公式字段、缺失名称及异月拒绝。同名项目逐源行保留，100%和进度截至某日不排除项目；仅从月报标题读明确年月，未知年份留给用户确认。明确模板项目名称与客户/合同表头可提取参考，歧义警告，不从建设单位推合同。修改timesheet-workspace.ts和api/routes-timesheets.ts，在既有inspect增加project-report种类及模板catalog；原考勤人工映射保留。修改domain/timesheets.ts，复用原run输入JSON保存月报选择、最多10份替换来源及实际来源字段快照，计算重验digest/月/源行/确认，定稿前核对副本；不改分配算法、人员排除或迁移。

新增packages/web/src/components/project-report-input.ts和ProjectReportReview.tsx，集中候选、逐项名称/月份确认、明确合并与可选简称、原参与关系保护。修改MonthlyTimesheet.tsx增加独立入口、失败重读、取消、替换及“重新核对此月报”入口；后上传模板时可直接重新读取已有月报及当前模板名称，不需重新上传文件。采用仅补入清单，既有项目和未涉及简称保留，人员参与不自动扩展；模板先后顺序不覆盖已选项目/参与关系。相同文件重复上传会保留副本但不重复添加清单项；替换保留此前来源。候选纳入原草稿与离开保护，恢复须重读/重新确认，跨期不串用，待采用禁算。来源采用快照只供追溯，之后手工清单以当前输入为准，不反推人员工时。原timesheet-input.ts未改。

**验证与证据：** npm run typecheck通过。新增本机packages/server/test/monthly-project-report.ts，只从node scripts/test-isolated.mjs --unit monthly-project-report运行：15组通过，覆盖14项同结构合成XLSX、空页/移位/换行表头、错误/空/公式/歧义、年月与下月计划边界、同名与模糊建议、100%保留、明确名称/合并/简称冲突、真正同字节重复上传、取消/替换及来源历史、模板顺序和不扩展人员参与、后端拒绝/真实期次计算/历史溯源。inspect与无效请求全表不变；计算后仅按明确参与项目得到工时。实际React SSR检查独立预览、已采用重新核对入口、草稿重新验证与异期拒载，不是浏览器操作。原monthly-input-repair的12组回归通过；次数不累计为全套或独立验收。monthly-input-build经原隔离入口完成82模块构建；主JS约1.51MB，存在1500kB阈值提示，未扩大到拆包优化。所有测试正常结束、专属根清理；本机证据outputs/monthly-project-report-20261110，测试源码、HTML、夹具与日志被既有规则忽略。

**文档复核：** GPT_CONTEXT整合当前月报范围及运行限制；CONTEXT定义月报与工时/模板/合同的区别；PRODUCT_REQUIREMENTS在PR-15整合输入用途与明确采用条件；SYSTEM_ARCHITECTURE替换“不支持独立项目导入”旧口径，说明解析器、前端确认与run快照；DEVELOPMENT_PROGRESS区分15组月报、12组回归、静态渲染与未验浏览器。五根按全文口径及原上下文核对，未改无关业务结论。USER_GUIDE补操作步骤，PROJECT_PLAN沿用GOV-12/13，QUALITY_AND_ACCEPTANCE更新覆盖边界；docs/knowledge-index.json及docs/reference/source-inventory.json由生成器更新。generate/check、repo:check及git diff --check实际结果见本机报告，非功能验收替代品。

**交付与限制：** 七个应用源码文件及必要文档实际保存；原Dashboard.tsx、Workbench.tsx、desktop.css和timesheet-input.ts字节与任务起点一致，其他无关文件保留。HEAD及空索引不变，不add/commit/push，不运行日常应用或访问正式数据库，日常指针仍为d2b1d8ffa9f8。Mac锁屏，未绕过：原生文件重选、真实点击/取消/返回/切期、草稿重开及响应式待解锁；实际附件适配、Office打印重算、真实整月对账、全套、跨进程压力和独立审查未验。无新模型/Office调用，不改历史3:2:3、整数规则及特定人员排除。上传未收到编号仍无新增幂等保证，取消副本保留不自动删除。建议提交说明：feat(timesheets): review monthly project reports before adoption。当前工作区仍混有前序修改，不可整包视为此项。

## 2026-11-10｜GOV-12 / GOV-13｜工时期次锁月与考勤识别失败恢复

**目标与依据：** 用户授权继续理顺两项明确缺陷，不再以工作列表待确认阻断本项。Darwin、Mac原仓库与main/913b002a613d4b06b0a67172b009885af6fb30d1核实，空索引；起点13项既有首页/列表及文档修改保留，不创建代理或其他会话。不开日常业务页、不更新日常实例，不add/commit/push。

**应用文件：** 修改packages/web/src/pages/MonthlyTimesheet.tsx：从所属期次核对并锁定月份，独立工时仍可选月；草稿/历史检查工作、期次、月份，异范围草稿不载入且不覆盖原存储；偏好异步返回不覆盖已有名单分配，URL版本不自动盖掉恢复的待核对考勤。新增未跟踪源码packages/web/src/components/timesheet-input.ts集中范围匹配、验证键与显式采用检查。上传先保留pendingAttendance，识别失败保留副本供手动映射和重试；验证后由用户采用为主/补充来源或显式替换主考勤，旧来源此前保持，替换保留补充输入，取消不删文件；文件控件值重置以支持同文件重选。待采用禁算，映射编辑和草稿恢复清除验证，操作中锁定输入并沿用离开保护。修改packages/server/src/api/routes-timesheets.ts和domain/timesheet-workspace.ts：原inspect仅为考勤接收可选mapping，经原schema/readMapped验证；自动识别、源月份与日期拒绝、计算算法保持。不新增迁移、端点或业务规则，不处理项目清单导入/整数分配。

**复现与验证：** 隔离合成考勤确认上传成功但自动/人工映射均报MAPPING_REQUIRED；旧React SSR绑定月控件仍可编辑，后端异月请求拒绝。最终npm run typecheck通过；node scripts/test-isolated.mjs --unit monthly-input-repair通过12组，包括上传、横表/逐行映射、错误/异月拒绝、自动识别兼容、采用/补充/替换/取消纯状态、范围匹配、绑定期次异月无写入和真实计算保存；inspect及拒绝请求前后全表一致。实际React SSR比较修前/后绑定月份禁用、独立月份可选和恢复草稿，明确不是浏览器操作。node scripts/test-isolated.mjs --unit monthly-input-build完成80模块隔离构建。最终回归首次因沙箱随机回环端口listen EPERM未进入用例，获正常隔离执行权限后通过；仅该失败入口留下的空标记根按时间及内容确认并清理，其他未知根未动。成功入口正常退出并清理数据/构建根。证据outputs/monthly-input-repair-20261110；两个新增本机test脚本、夹具及报告均被现有规则忽略，不上传。

**文档复核：** 五根全文按本会话上下文复核：GPT_CONTEXT整合最新有限授权及锁屏边界；CONTEXT术语不变、正文不改；PRODUCT_REQUIREMENTS整合期次归属及候选验证/采用验收；SYSTEM_ARCHITECTURE记录前端待核对状态与原inspect扩展；DEVELOPMENT_PROGRESS区分候选、各批验证与日常版本。USER_GUIDE新增尚未应用日常的操作说明，PROJECT_PLAN沿用GOV-12/13，QUALITY_AND_ACCEPTANCE区分SSR/接口/纯状态与真实交互；WORK_LOG记录实际增量。docs/knowledge-index.json和docs/reference/source-inventory.json由生成器更新；generate/check、repo:check及git diff --check结果见本机报告。两次长Unicode文档脚本因解码失败未执行，改用显式Unicode字面量/补丁后保存，未造成部分文档覆盖。

**交付及未完成：** 四个应用源码文件和必要文档实际保存；原Dashboard.tsx、Workbench.tsx、desktop.css及其他无关跟踪文件与任务基线核对不变。HEAD、空索引不变，不提交推送、不迁移或更新日常实例；source-current仍d2b1d8ffa9f8。Mac锁屏及内置浏览器不可用为已知现状，本项未尝试解锁或浏览器操作；真实文件选择器重选、切期/返回/取消、慢请求互斥、保存重开草稿及响应式仍待解锁后验收，不把SSR冒充操作。非独立审查，未跑旧全套、Office/真实模型/真实业务及跨进程压力。建议提交说明：fix(timesheets): preserve period scope and validate attendance before adoption。当前工作区混有前序改动，不可整包视为本次变更。

## 2026-11-10｜GOV-13｜工作列表底部分页与空态居中

**依据与范围：** 实际读取用户截图5116.jpg（Mac Downloads/workbench-layout-reference），确认对象为“我的工作台”工作列表而非Dashboard。用户明确指定分页在卡片底部、空态在剩余区域水平垂直居中，仅修此页。Darwin/原项目核对；main HEAD913b002a613d4b06b0a67172b009885af6fb30d1，原12项首页差异全部保留，索引为空；.agents/skills不存在。无add/commit/push，不启动代理或其他聊天。

**文件与原因：** packages/web/src/pages/Workbench.tsx仅给列表根/卡片/分页增加专属类，并将原列表状态/表格包入独立内容容器；分页事件、筛选逻辑和详情保持。packages/web/src/desktop.css追加限定样式：内容分配剩余高度，空态auto边距居中，分页从旧sticky跟流改为独立底部区域；表格顶部排列、桌面内部滚动，窄屏横向滚动和短窗主页面滚动保留。Dashboard.tsx与此前首页CSS字节未改，不改公共Card/Empty、接口、依赖或数据库。仅本机新增packages/server/test/work-list-layout.ts及outputs/work-list-layout-20261110证据，复用隔离入口构建、HTTP及合成数据库，测试/截图不共享。

**验证：** npm run typecheck通过，node scripts/test-isolated.mjs --unit work-list-layout内79模块构建通过。41项合成工作来自真实测试HTTP；专属代理只读返回0项/3项。Mac内置浏览器实测空态新建/取消、3行顶部对齐、41项三页20/20/1行及末页禁用、上一页/下一页、搜索空态与清除后返回第一页；桌面内容scrollTop达到1132而底部分页位置不变。1366×850、1280×600、1366×650、640×360、390×844截图及DOM几何检查通过，空态中心误差小于2px，分页贴卡片底部内边距；短窗口点击下一页自动滚动至可见位置，无覆盖。无浏览器error日志。76张合成表前后相同；测试服务exit0，代理/页面/视口覆盖及临时数据根均清理。首次reload快照仍在加载，等待实际3项标题后再检查，不把初始空数据当通过；短窗首张截图有尺寸切换瞬态，最终短窗分页截图另行实测。

**日常应用：** 用户已授权测试通过后按原安全启动器更新。本机Safari唯一窗口含起始页及空工作列表标签，无编辑表单；无其他工作台测试页。原health/source-current/SOURCE_BUILD一致为909fd081130c、PID4327，迁移42份完整且无pending，知识批处理空闲。候选与旧运行副本仅Workbench.tsx/desktop.css两文件差异，prepareBuild复用本机依赖并构建通过。先校验SQLite/配置/内部文件/旧指针备份，再经正常node scripts/start.mjs --background --start-only及原确认提示安全停止/接续，未强杀或迁移；启动器另存停机备份。新sourceBuildId=d2b1d8ffa9f82762ce3104cd1a654cabeef786c7c46db8bc7ffe6bf05e588878，PID4974；两份备份quick_check及77表内容匹配，原DB/schema/配置/内部文件不变。health及HTML/JS/CSS与候选相符，source-current由启动器更新，原副本/历史备份保留，无current-release指针。没有刷新真实页或触发首页期次同步，用户刷新列表即可查看。备份路径与完整身份见本机report.txt及daily-*.json；未执行恢复演练。

**文档与交付：** 五根全文按现有上下文复核：GPT_CONTEXT改当前指定页及运行身份，CONTEXT术语不变不改，PRODUCT_REQUIREMENTS补列表验收及当前范围，SYSTEM_ARCHITECTURE说明专属布局，DEVELOPMENT_PROGRESS更新验证/运行边界。USER_GUIDE补列表滚动与筛选，现有GOV-13及质量矩阵同步，索引generate/check、repo:check和diff检查按收尾实际结果记录。本地保存并应用此Mac，不暂存/提交/推送，其他设备未发布，等待用户确认此页。未跑旧完整套件、其他页完整流程、Windows/Office、真实业务/模型、全量无障碍或恢复压力；作者验证非独立审查。建议提交说明：fix(workbench): anchor list pagination and center empty state。

## 2026-11-10｜GOV-13｜Mac首页办理优先与通知入口

**依据与范围：** 用户确认待我处理/最近工作优先，保留搜索、新建及通知，日历改近期截止、统计缩一行，成果/随手记后置；强调入口真正能用、逐页确认。本轮仅Mac原项目，Darwin及仓库根实时确认；开工main、实时GitHub main均为913b002a613d4b06b0a67172b009885af6fb30d1，工作区干净。未复制项目、转云端或启动其他代理。当前明确不add/commit/push，不推进其他页面。首页实现与隔离验收完成后，用户追加授权将其安全应用到同一Mac日常实例，要求先核对候选、输入安全、迁移及备份，保留真实数据。

**文件与变化：** packages/web/src/pages/Dashboard.tsx将原概览卡改为单行统计，将继续办理改为按更新时间展示最近五项工作并标明状态；保留搜索、新建及待办操作。铃铛改为可关闭的通知摘要，复用待处理/截止信息，提供正确工作/期次跳转或待办分页定位与焦点恢复。截止按在办工作既有期次/计划日期排序，同日合并说明，超五项可展开；完整月历、成果预览及随手记保留于次级区。复验发现无模板期次的后端通用提示误称文件已生成，首页限定改为中性“查看本期材料与成果”；未改后端或其他页面。packages/web/src/desktop.css新增首页限定主次网格、自然高度、通知及窄屏样式，不改其他页面业务。没有新增接口、数据表、订阅或推送权限。

**验证与本机证据：** npm run typecheck通过；node scripts/test-isolated.mjs --unit home-focus从根隔离入口创建随机端口test后端、匿名SQLite与合成文本，核对health身份和数据库路径；隔离79模块构建通过。Mac内置浏览器实际覆盖搜索命中/取消，新建取消及真实创建后返回，最近/全部工作、通知与截止的正确工作/期次落点，待办排序/分页/明确完成，通知定位及Escape焦点恢复，月历翻月/今天/选日，成果展开预览关闭，随手记进入与返回。代理注入空/加载/503及同步失败，提示、重试与恢复通过。截图检查1280×720、1280×600、1366×650、1024×768、640×360和390×844；窄屏无横向溢出，小高度可滚动到操作。只读阶段76表一致；创建只新增工作/规则/期次/事件，完成只改目标待办并增事件，既有工作/阶段/清单/成果行不变。补充视口阶段76表一致。两次专属服务正常退出，页面/视口覆盖及合成数据根已清理，日常服务未关闭。证据仅本机outputs/home-focus-20261110，含report.txt、截图、请求记录及前后表快照；新增本机packages/server/test/home-focus.ts被既有规则忽略，不共享。

**验证过程限制：** 首次沙箱回环监听EPERM，获正常执行权限后使用同一隔离入口成功；不是应用失败。一次根npm build传参被嵌套npm吞掉，将旧隔离产物重新打包到该临时根的web/dist，未覆盖项目dist或日常资源；改用workspace明确的build -- --outDir后重新构建并刷新，最终再从根隔离入口构建补验。少数定位器因原生summary角色、标签空格或旧构建未命中，读取当前DOM后改用真实目标复验；不将尝试视为通过。作者限定检查，非独立审查；未运行旧全套、其他页面完整流程、Windows、Office、真实业务/模型、原生系统缩放、全量无障碍/性能及跨进程压力。后端通用nextAction口径保留为边界，未扩大到其他页面整改。

**文档复核与交付：** 全文复核五份根文档：GPT_CONTEXT更新Mac接续及首页验收门槛；CONTEXT业务术语无变化，正文不改；PRODUCT_REQUIREMENTS整合已确认首页需求及本轮授权；SYSTEM_ARCHITECTURE更新首页复用和布局方式；DEVELOPMENT_PROGRESS更新实际基点、限定验证及Mac日常应用状态。同步USER_GUIDE、PROJECT_PLAN与QUALITY_AND_ACCEPTANCE；历史结果保留其适用范围。生成docs/README.md、docs/knowledge-index.json及docs/reference/source-inventory.json，仅实际变化纳入清单；维护/边界检查与git diff --check结果见本机报告。文件已保存，未暂存/提交/推送；首页已按后续授权应用到Mac日常实例，其他设备未发布，等待用户验收首页后再处理下一页。建议提交说明：feat(home): prioritize pending work and keep actionable notifications。

**同任务日常应用：** Darwin/原仓库、HEAD及12项首页差异重新核对；Safari唯一窗口/标签为起始页，内置浏览器无标签，无工作台未保存编辑页。原daily PID3008、source-current及SOURCE_BUILD/health均为cee397ca73dc；旧发布指针不存在。只读迁移全集42项，无pending或未知项；原工作/期次/成果/OCR及内部文件为空，知识批处理未运行。新旧可共享源码只有Dashboard.tsx和desktop.css不同；prepareBuild核对复制本机依赖，79模块构建成功，新候选909fd081130c。仅本机outputs/home-focus-20261110/daily-snapshot.mjs保存SQLite一致副本、配置、内部空目录与旧源码指针，quick_check及逐表/文件/配置摘要与原位置匹配；初次因backups父目录不存在失败，修正本机备份工具recursive创建后成功，未触及原数据库。正常node scripts/start.mjs --background --start-only，经原确认提示后安全shutdown，不强杀、不另开端口、不打开业务页；启动器另存数据库备份，成功后自行更新source-current，previousId保留原版，新PID4327。77表（包含内部表）内容及schema、配置和内部文件前后不变；health/data身份、HTML及JS/CSS字节与候选一致，无待迁移、更新锁释放。无新增迁移、应用源码修改、模型/Office调用、真实业务写操作或其他设备部署；没有直接启动探测真实库，也未为截图触发期次同步。用户打开http://127.0.0.1:8787后验收实际首页。备份、身份、校验与限制详见仅本机daily-apply-report.txt、daily-before/after/runtime.json；外部原件不在备份范围，未执行恢复演练。五根再次按全文复核：GPT_CONTEXT/DEVELOPMENT_PROGRESS更新运行事实，PRODUCT_REQUIREMENTS整合追加安全应用授权，CONTEXT术语与SYSTEM_ARCHITECTURE结构无新增变化；USER_GUIDE、原GOV-11/13及质量矩阵相应同步，重新生成/检查索引。

## 2026-11-10｜GOV-11 / GOV-13｜拉取后双击运行当前源码

**依据与范围：** 用户澄清要求同一仓库pull后双击使用最新代码，避免逐台盘点多个版本，并针对本轮启动更新与必要文档授权审查后提交推送naobuqingjiaosha/WorkBench。基点bd958f518b47ffbd50759ce7a3f67beef041f7ed已在远端核对。使用独立云端副本；原云端5个未提交应用文件与另一核查副本9份文档保留，不reset、不混入。本轮不改页面、工时算法、模板绑定或业务迁移SQL，不部署真实Windows，不读真实业务资料。

**代码清单与变化：** scripts/start.mjs改为默认源码入口与显式历史恢复分发；新增start-source、source-build、source-upgrade，原启动器迁为start-release并加恢复迁移兼容拒绝；启动工作台.cmd说明同步，命令路径保留。按共享源码和Node ABI/平台/架构标识固定副本，自动安装/复制相同锁依赖、构建web，修正Windows绝对workspace链接，校验源码与界面后使用；构建失败不停止原服务。source-update锁串行化准备，相同实例复用，不自动换端口；会话令牌/startedAt核对及明确确认后停止，后台忙拒绝、在途请求排空并关闭完成响应的长连接后关库，原锁释放才启动。config/test-isolation保留原检出根解析，paths同时保护原源码根和副本；build-identity记录sourceBuildId。server-lock提供主动释放用于升级预检；migrate将全部待执行SQL合成事务。backup/ocr各增加只读忙碌状态供退出检查。升级前确认、保留数据库备份、副本演练；未知迁移拒绝，失败不自动倒库。仅新服务身份核对通过才更新source-current；历史指针/数据/备份/缓存不自动删。.gitignore和repository-policy只允许四个新增通用脚本，不放宽私有资源边界。

**验证与证据：** node scripts/test-isolated.mjs --unit source-launch最终17组通过，匿名证据/workspace/workbench-cloud/launch-evidence-kvdOc9；前15组是准确应用候选，最后两组只在合成源码副本注入后台忙、慢请求及启动异常，生产无测试开关。覆盖真实npm ci/79模块构建、中文和空格目录、复用、更新确认、并发双击、依赖/构建/启动失败、显式恢复、旧布局与指针、迁移确认/回滚、会话和实例拒绝、慢请求落库后退出；DB行、文件字节、备份及成功记录分别比较。真实Chromium首页及截图已亲自复核，无页面脚本错误。source-contract最终6组通过，证据/workspace/workbench-cloud/launch-contract-rMHqvS：实际040结构升级041/042保留旧行、延迟FK提交失败回滚、备份路径失败不改原库、非空无记录拒绝、两类源码根保护及缺历史指针拒绝。server/web类型、脚本语法、仓库边界、文档generate/check与diff检查通过；未运行缺资源的完整npm test/typecheck:tests，不以23组替代旧完整套件。

**发现与复核：** 首次7组启动测试在第5组暴露关闭HTTP后DB尚未释放的时序，改为等待原server.lock释放；修后7组通过（QAwT7f）。扩展15组与修正运行环境/链接后的15组分别通过（Gqt9HW、hOllyn），不重复累计。补充慢请求复现长连接等待（bkbZho、带服务日志cM1j9z），通过停止期间响应Connection: close修复，最终17组通过；在途写入保留。迁移工具测试初次未创建临时runtime、再次把合成代码根放进隔离资源根而触发正确拒绝，均仅修测试设置，失败证据4YrhNm/1asgw9保留，最终6组通过。作者审查与复跑，不称新独立审查；未操作真实Windows、真实旧库/旧包、Office或模型，未验证原生窗口/文件锁、所有后台任务实际负载、跨盘或崩溃恢复。

**文档与五根复核：** GPT_CONTEXT更新基点、授权和接续；CONTEXT全文复核，无术语变化不改；PRODUCT_REQUIREMENTS写明pull后双击与保留数据验收；SYSTEM_ARCHITECTURE整合副本/升级/退出边界；DEVELOPMENT_PROGRESS整合当前云端状态与验证限制。安装/运维改为单一日常入口，开发、资料边界、换机和界面指引修正相关旧指针说法；既有GOV-11/13、质量矩阵与本条日志更新，机器索引重新生成，不建立新队列。

**离线接续独立审查反馈与修复：** b0c4a192a2c7a81c45607447bc883d32169d1851推送后，父任务审查指出首次源码副本忽略现有checkout依赖及原.npmrc/cache。以完整已安装node_modules、空缓存、离线环境实际复现启动失败，证据/workspace/workbench-cloud/offline-evidence-YBzE9S；OFFLINE_REPRO断言的是缺陷存在，不是产品通过。应用仅修改source-build.mjs：候选依赖先比较当前manifest/lock和npm隐藏安装记录，复制后核对实际版本、npm ls依赖图、服务端外部模块加载及esbuild本机探针；原checkout和相同锁/ABI/平台副本可复用，不修改原安装。无可用树时，在原仓库解析缓存绝对路径，临时沿用项目npm配置，先离线npm ci，再获取缺项，完整副本不保留.npmrc；失败明确提示且不停止旧实例、不静默运行旧代码。补充拒绝链接依赖根及workspace父目录，防重建链接时改到原安装；Windows最终junction目标修复保留。安装记录检查并非全部包文件的密码学证明。

离线专项先7组通过（O3simY），链接边界补强后最终8组通过（/workspace/workbench-cloud/offline-evidence-jJ0SLO）：已安装离线、注册表503且零安装请求、缺模块拒绝、链接目标不变、锁变化拒绝旧依赖、实际首次在线安装、原项目相对缓存离线重装、网络失败保留活动PID及成功记录。配置与缓存均为匿名临时资源，未读取真实凭证或业务。依赖修复后原source-launch 17组回归通过（/workspace/workbench-cloud/launch-evidence-23ke4T），包含真实Chromium首页、失败与迁移/退出边界；之后仅增加链接拒绝两处检查，由最终8组复验，不累计为新全系统测试。server/web类型、脚本语法、文档与仓库检查通过，Windows原生/旧完整套件/真实资料仍未验。五根再次复核：CONTEXT术语不变，其余四份及安装、运维、资料边界、现有GOV/质量矩阵整合离线语义，索引重生成。本机用例、报告和缓存不提交；原5文件及9文档现场不变。按用户当前授权精确提交推送本修复，不部署设备。

**配置残留与缓存预检修复（4830353基点）：** 父任务独立审查提出npmrc复制中断残留、相对cafile及已建缓存只查fastify的问题。匿名复现证据npm-baseline-evidence-NgkB9o：强制终止实际prepareBuild后复制令牌仍在stage；缓存缺pizzip入口仍被prepareBuild接受、实际模块导入失败。只确认合成场景，不宣称真实用户凭据泄露。source-build改用新增source-npm子进程在原cwd通过npm 11加载全部配置层，再将操作根指向副本；不落地/传参配置值，沿用npm认证过滤，原相对cache/cafile及用户认证有效。verifyReadyBuild在缓存复用和start-source显式恢复前核对安装记录、依赖图、服务端导入与esbuild，失败不先停旧服务、不自动改动缓存。共享脚本白名单及.gitignore仅增加该通用适配器。使用安装的npm 11内部接口，版本主号检查并失败关闭；当前仅实测11.9.0，不承诺其他主版本兼容。没有更改业务、依赖锁、迁移或真实数据。

配置专项最终4组通过（npm-config-evidence-SGogzY）：真实回环HTTPS/合成CA与令牌、项目相对cafile/cache、用户认证与项目registry优先级、环境证书覆盖、缓存离线、网络请求中SIGKILL后stage/cache无凭据副本及参数无令牌。首轮负向使用不存在CA，npm自身flatten沿用较低层CA使断言不成立；改用有效但不受信任的CA验证覆盖，4tAhnh失败证据保留，不修改npm规则。实际prepareBuild复制中SIGKILL追加1组通过（npm-interrupt-evidence-zAbRKt）；首轮扫描遇本次被中断复制文件的临时无读权限，仅给测试自建副本恢复读权限后复验，B6p9RS记录保留。缓存7组通过，最终候选再次7组通过（cache-guard-evidence-FHkeBj，首轮IHQJIu保留）：非fastify入口丢失、版本不符、传递依赖图缺项、esbuild执行文件缺失、last-good拒绝及正常更新；失败核对PID、DB/业务文件字节及成功记录。原离线8组通过（offline-evidence-B5d1xm），原启动17组通过（launch-evidence-Iu5F53），包括真实npm安装/构建、浏览器首页及更新/迁移/退出边界，不累加为全系统覆盖。证据均在/workspace/workbench-cloud，仅留本地。类型、脚本、文档generate/check、仓库worktree及差异检查通过，提交前另核对暂存范围；五根全文按影响复核，CONTEXT无术语变化不改，其余四份及安装/运维/资料边界、现有GOV/质量矩阵整合当前语义。Windows、真实旧机/CA/数据、旧完整测试、其他npm主版本及跨进程恢复未验。新独立代理未启动，父任务审查线索与作者复验分别记录。

**交付与清理：** 本批测试/合成源码/数据库/依赖缓存/服务和浏览器按专属范围清理，匿名证据和本地测试源码保留且不上传；原5文件差异摘要仍为27df8bc0527ffce7120cc0fcf625886d15988627675d92bb71f1a52631bbd553，9文档现场保留。交付只包含上述代码与正式文档；按当前授权运行原钩子、精确提交并普通推送main，完整SHA/远端及CI结果以Git记录和任务交付为准。没有部署日常设备、删除历史或宣称完整业务验收。source-inventory committedBase为生成时基点，不追逐自身提交哈希追加提交。

## 2026-11-10｜GOV-13｜办理优先入口与空态、整页滚动

**依据与范围：** 用户要求最近成果空时无多余滚动、文件溢出再滚动，工作详情展开后整页滚动；进一步要求流程预先配置，创建即办理，月度工时先显示研发、部门项目与考勤资料入口。父线程已查看两张用户截图并提供准确描述；当前执行器未看到原图像素。开工main / 1ab1fc515e43eca943c1e2357755ffc9086ca03e，应用源码干净；同任务前段文档差异合并到本条。查阅AGENTS、五份根文档、开发/文档治理/界面指南及既有GOV队列；仓库无.agents/skills或.codex/skills。仅本机修改和测试，不提交、推送、发布或操作真实资料。

**修改清单与原因：** 六个前端文件：Dashboard.tsx给已加载无错误的空成果添加专用标记；compact.css、desktop.css取消空态正文、详情期次/阶段和辅助折叠区不必要的压缩/内滚动，让内容自然撑开主页面，有成果时保留溢出滚动。Workbench.tsx行政创建把编号、额外模板和说明收进可选区，保留发布版本核对及创建后详情跳转；材料核对、关联记录和流程配置后置，周期失败明确报错。Periods.tsx将已有MonthlyTimesheet内嵌到工时期次主要位置，通用文书收起；无周期工时工作也显示办理入口。MonthlyTimesheet.tsx增加嵌入模式、基于实际输入的下一步提示、默认展开的研发/部门表/考勤入口及快照绑定模板显式选择。嵌入时输入、结果、历史版本区自然增高，保留表格横向滚动和独立工时页原布局。现有解析器从部门表提取项目，明确提示独立项目清单不支持自动导入；保留手填项目。未改后端、模型、迁移、算法、历史模板绑定或业务状态。

**验证与限制：** npm run typecheck:web和Vite构建79模块通过，最终产物在本机outputs/scroll-fix-20261110/web-build-final。node scripts/test-isolated.mjs --unit task-first-entry通过4组：实际隔离SQLite创建沿用发布版本并产生期次；真实React组件使用API响应替身渲染，三类上传在通用文书前且月份正确；空月份禁用、绑定模板显式操作及已提供资料的下一步提示；首页空/非空/长文件名/加载/失败分支。首次测试因测试代码调用不存在的getPeriodRule失败，改用隔离库查询后全部通过；不是产品缺陷。用例和合成数据只留本机，测试临时根由隔离运行器清理。静态审查details保留内容、样式层叠及正常文档流。这不是浏览器点击或布局验收：Windows浏览器工具此前无法可靠判定当前URL而安全停止，未再次操控或换驱动绕过；空/非空、展开/折叠、溢出、不同高度和缩放的真实页面测试仍待验。官方Library落地因Windows缺少os.setxattr失败，未绕过；父线程描述解决定位，但不解除浏览器限制。未运行完整套件、上传/计算端到端、真实模型或Office。

**文档与五根复核：** GPT_CONTEXT整合当前办理候选、滚动及验证限制；CONTEXT无术语变化保持；PRODUCT_REQUIREMENTS整合预先配置、创建办理和滚动验收；SYSTEM_ARCHITECTURE说明现有组件复用与真实能力边界；DEVELOPMENT_PROGRESS记录本机基点、验证和未闭环。原GOV-13、界面指南、本条日志同步；索引由docs-maintenance generate/check更新和检查，git diff --check与仓库边界检查通过。索引含当前HEAD与Windows检出字节摘要，不代表发布或功能验收。

**交付与未完成：** 文件实际保存本机，未暂存、提交、推送、发布；业务验收未完成。发布指针SHA-256与开工一致。前序独立预览曾返回PID36056，但收尾未见该PID或18889监听、日志为空，未重新启动，不宣称存在已验证可访问地址。outputs内助手/构建及packages/server/test/task-first-entry.ts均被Git忽略，不上传。仍须沿GOV-13补安全浏览器检查；独立项目清单解析、通用自动步骤执行不属于已实现能力，不能宣称每种工作已配置完成。建议提交说明：fix(ui): prioritize task inputs and page scrolling。

## 2026-11-09｜GOV-13｜液态玻璃视觉增强与主要页面统一

**依据与范围：** 用户在Windows查看后反馈不够通透，进一步要求首页完成后把其余页面统一并测试，明早在公司预览。开工main、远端均为f44ef18e732c1f02d95794db28423a1d2b8c3150，工作区干净，origin为naobuqingjiaosha/WorkBench。遵守本地规则与云运行技能，复核五根文档和现有GOV-13；.agents/skills不存在。不下载原图或改网络，未看到原设计图；不访问真实资料、Windows日常运行环境或付费模型，不作原生Apple或逐图还原声明。

**修改清单：** 应用代码只修改packages/web/src/desktop.css：原贴边低透明侧栏改为浮起的半透明面板，静态蓝紫色场、白色边缘高光、内外阴影增强通透感；首页搜索/提醒/新建操作条、主要页面标题栏、二级导航、操作区及弹窗头尾统一。正文、表格、编辑区及内容卡片保留白色实底；弹窗根与遮罩不做全屏模糊，二级导航不叠加过滤。仅首页工具增加140ms/1px悬停及按压反馈，无持续动画、指针追踪、模糊动画或永久will-change。无模糊支持保留预设实底，减少透明/动画、增强对比或慢刷新媒体偏好去模糊与阴影，forced-colors保持系统色及明确焦点。首页双栏、八导航及所有业务组件/确认不改；无JS、后端、依赖、迁移或数据规则变化。INSTALLATION补已有Windows预览更新及独立旧版本工作树对比步骤，不改发布指针。

**实际验证：** 所有业务测试由scripts/test-isolated.mjs --unit进入，匿名SQLite/合成文件，health校验test身份与专属DB。liquid-ui-pages 11组（pages-Dyeg2N）：八主页面及阶段/期次/工时/记录、模板上传预览下载/归档取消、文件预览下载/上传取消、流程未保存退出、辅助区键盘展开、期次保存重载、模板前台和设置制度维护边界；跨页面五档视口含1280×600、1366×650、1920×900及125%/150%等效CSS空间。liquid-ui-home最终13组（home-ChBJ8A）：首页全部导航与业务入口、排序分页刷新/提交失败后明确重试、日历/成果、全局搜索及制度维护去向、范围/空/加载/失败、七档视口含390px和200%等效空间、键盘焦点、玻璃/实底/媒体偏好、交互微动及90帧滚动冒烟。liquid-ui-citation 4组（citation-dTz0VH）：原文/反向引用、维护深链接/刷新/折叠、普通知识库和默认设置、未保存导航及短视口；KB/引用行及文件字节不变。liquid-ui-trash 11组（trash-QutKGs）：真实回收站API与浏览器，慢请求双击/关闭/返回/筛选保护、全失败/混合/保留期/父子范围、响应丢失核对与明确重试、跳过/警告、2000快照及501明细持续展示、失败目标DB/文件保护。四组共39个检查组，重复运行不累计覆盖；服务调用使用真实本地应用或原回收站路由，错误/慢响应/断连明确注入，无真实模型请求。295处实色可见文字对比度≥4.5；透明混合、禁用和未显示内容不属该扫描。首页主按钮渐变最亮端另算得4.47，调深至#326dce，两端≥4.5并加入实际计算样式断言，13组首页重新通过；四组主题令牌在预设浅色范围另作有限检查，不宣称全状态无障碍认证。亲自看过首页、知识、阶段、周期、流程编辑、文件、助手、设置、回收站、弹窗、高对比及缩小视口实际截图。

**图像复核补查：** 首张AI助手截图标题有短暂上移，直接进入和原导航顺序补查均测得main.scrollTop=0、标题top=12，未能复现稳定裁切；两次要求出现负坐标的诊断断言失败，原日志agent.log/agent-sequence.log保留，不把它们改写为产品修复通过。随后稳定页面、三档视口、标签切换和输入焦点1组定向复核通过（agent-gGI9rF）；不因一张中间态截图盲改全局滚动规则。详见同目录agent-final.log及实际结果。

**工程、文档与交付：** npm run typecheck通过；实际隔离浏览器用最终源码构建通过，另Vite隔离构建79模块通过。docs-maintenance generate/check、仓库worktree及差异检查通过；暂存检查在提交前执行。五根全文复核：GPT_CONTEXT更新接续和边界；CONTEXT无业务术语变化保持；PRODUCT_REQUIREMENTS把用户增强/全页一致/微动与降级要求整合进PR-18；SYSTEM_ARCHITECTURE更新局部过滤层与微动；DEVELOPMENT_PROGRESS更新本批基点、39组限定验证与未验。PROJECT_PLAN沿现有GOV-13，QUALITY_AND_ACCEPTANCE/UI指南/INSTALLATION和本条日志同步，源码/知识索引由工具生成。RK-01删除与RK-11/12保存机制无实现变化，不扩写为新的验收。当前证据根为/workspace/workbench-cloud/liquid-ui，测试源码、截图、日志仅本地不上传Git。此前Library批量传递失败仍是历史事实；本次新增单张最终首页截图通过当前Library技能官方单文件路径成功保存，文件名WorkBench-liquid-glass-home.png，为实际运行的匿名合成页面，不是设计图。

**交付后静态审查补查与修复：** 增强界面e909727已正常推送、远端核验且Git干净，父线程独立静态审查指出普通页头的:not组合优先级压过偏好规则，并提出极矮弹窗裁切线索。当前修复开工HEAD/远端均为e909727dde9115d87a9d4cec6100fb40e209a189。glass-cascade隔离实际浏览器在知识库/设置/文件三页复现减少透明/动画仍有阴影、增强对比仍为rgba(255,255,255,0.85)边框；forced-colors正常Chromium自动调色掩盖作者规则错误，临时forced-color-adjust:none诊断探针仍显示原阴影和边框，不能把探针状态说成用户默认行为。修复仅把两处普通页头排除条件置于:where，保留匹配范围、默认外观及首页/详情排除，降低至单类选择器优先级。glass-modal原样实测320×180新建弹窗clientHeight=146、scrollHeight=197，取消/创建按钮中心被裁切；增加≤480px整张弹窗滚动、正文不独立裁切，常规高度维持原布局，未改组件或业务。

**补查验证与边界：** 原始证据/workspace/workbench-cloud/glass-cascade：页头before.log/run-26LcIM为故障确证，after.log/run-iD2ABQ五模式组通过，逐页检查background/border/box-shadow/backdrop及键盘切换；普通、减少透明、减少动画、增强对比、forced-colors分别验证，作者声明与浏览器自动调色分开。弹窗modal-before.log/modal-VMfjjr记录裁切；最终modal-final.log/modal-ciA9Y3五视口组通过（1366×900、683×450、683×300、390×240、320×180），新建首步/项目表单与未保存确认的每个可见按钮滚动后中心elementFromPoint命中，可用按钮聚焦和trial点击，实际选择项目/取消、继续编辑保留输入及不保存离开成功；截图已看。前两次工具失败分别因可访问名称含空格、继续编辑后误再展开已打开的移动导航，修正本地用例并保留modal-after.log/modal-after-2.log，不改业务规避。最终主要页面11组（pages-kagQVk）、首页13组（home-n0zbGT）、回收站11组（trash-X0jE6J）重跑通过；原文/制度专用4组没有重跑，不冒充新结果。npm run typecheck及隔离构建通过；正式文档与仓库检查按收尾执行。全部测试仍经test-isolated，匿名DB/文件、失败保护核对不变；专属根、服务及活动浏览器清理，原证据保留。五根再次复核：CONTEXT/PRODUCT_REQUIREMENTS无术语/需求增量保持，GPT_CONTEXT/架构/进度整合当前修复范围及基点；原GOV-13、质量矩阵、UI说明与本条日志更新，索引重生成，不建新队列。该补查是作者实际复验，父线程静态审查不等同全套独立运行验收。Windows实际字体/缩放/系统主题、旧浏览器、慢刷新硬件、完整旧套件、Office/真实模型等边界不变；不部署。依用户授权只提交本批CSS及正式文档，执行原钩子并恢复权限、核对并发与最终远端，最终SHA/CI见交付；无记录不算通过。

**清理、限制与Git边界：** runner清理各自数据库/文件/构建；本批测试服务与活动浏览器关闭，保留匿名证据和失败诊断，不清原有资料；额外独立构建目录已删除；cleanup.json确认8个运行根均已删除，无残留隔离根、活动Node服务或Chromium。旧完整npm test/typecheck:tests缺原套件/test-isolation-contract/tsconfig.test.json，未运行；未验Windows原生字体/真实缩放/高对比主题、旧浏览器、目标GPU/低性能设备、全部执行器/模板/年度台账生成、Office/真实模型、原图对照及完整业务。无模糊为删除增强规则模拟，媒体偏好用Chromium模拟；慢刷新降级只有样式审查，未作设备实测。作者复核不等同新独立审查。用户已明确授权每轮验收后提交推送；仅暂存本批样式与正式文档/索引，正常钩子，提交前后核对origin/main并发，恢复钩子原权限，不强推、不部署。该条在提交前定稿，最终完整SHA/远端/CI以交付核验为准，无记录不算CI通过。建议提交标题：feat(ui): strengthen glass navigation and dialog surfaces。

## 2026-11-09｜GOV-13｜轻度玻璃导航与可读降级

**依据与边界：** 用户认可液态玻璃方向并授权修改、每轮验收后提交推送。开工main、远端均为2f26d9b48c480623cf9f7b27db31c1479ea3ab11，工作区干净，origin为naobuqingjiaosha/WorkBench。遵守AGENTS、五根文档和隔离指南；.agents/skills不存在。未取得或查看原图，按文字规范实施，不下载图片、不改网络、不声称原生Apple材质；不访问真实数据、Windows/Mac日常实例或付费模型。

**实际修改：** 应用只改packages/web/src/desktop.css：背景浅灰蓝，次要文字略加深；侧栏轻磨砂、高光细边界，顶部导航/首页搜索操作条局部模糊，白色卡片实底。基础规则先给不支持模糊的实底；@supports增强，减少透明/增强对比关闭模糊，forced-colors使用系统实底、选中描边与焦点。没有模糊动画、永久will-change、嵌套滤镜、新依赖或JS。首页双栏、原导航与按钮、模板及制度后台/引用、删除确认和数据语义保留。

**作者验证：** 全部应用测试经test-isolated入口，匿名SQLite、合成DOCX/文本、独立WEB_DIST构建和实际Chromium，无外网/真实模型调用。glass-ui主专项16组通过（/workspace/workbench-cloud/glass-ui/main-G0Y0C7）：八主页面及阶段/期次/工时/记录，创建取消、未保存退出、上传预览下载与归档取消、辅助区键盘、期次保存重载；1366×900、1280×600、1366×650、1920×900及1093×720/911×600等效可用空间。322处可见实色文字对比度≥4.5，玻璃四组令牌在#dce6f1至白色边界保守比值4.76～11.70；禁用、透明图像和全部动态状态未全面扫描。首页实际两处非嵌套模糊；搜索键盘、提醒定位、短窗口滚动后记录/设置操作正常。

原引用维护链glass-ui-citation 4组通过（citation-MPpbcG）：原文/被引、设置直达/刷新/折叠、模板前台、未保存保护、小高度可达，KB/引用行及文件字节未变。原清空回收站glass-ui-trash 11组通过（trash-iUz9Dr），包括慢请求双击/关闭/返回/刷新保护、失败与响应丢失核对、明确重试、保留结果及警告。测试副本只换证据根，未改变原业务断言；没有重跑纯后端全删除矩阵或知识可见性套件，不借历史数量扩大覆盖。

**视觉发现与复验：** 自动化初过后亲自看图发现强制颜色的Highlight填充与文字背板组合遮住选中导航/主按钮标签。改为Canvas/ButtonText及Highlight描边，增强子元素颜色断言；5组材质专项通过（最终material-1PyDoy）。媒体偏好使用Chromium模拟；无背景模糊支持通过删除增强@supports规则模拟。中间material-tZgVPb的普通降级图受前一强制颜色模拟残余影响，最终将强制颜色独立置末并重载核实普通主按钮色，未为测试残余修改应用。最初本地新增测试缺闭合语法，修正测试后运行；不作业务缺陷。保留各轮截图/结果；最终普通、强制颜色、增强对比、降级、模板和阶段图已查看。90帧滚动与操作冒烟通过，只表明云端响应，不宣称目标硬件性能或Windows原生效果。本轮由作者测试与差异复核，没有新独立代理验收。

**文档及收尾：** 五根文档全文复核，CONTEXT无术语增量保持；GPT_CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS整合当前文字方向、样式结构、基点及验证边界。原GOV-13、质量矩阵和UI实施指南同步，文档/源码索引按既有工具生成与检查；未新建任务队列，RK-11/RK-12与GOV-01无新业务变化。类型检查、独立构建、仓库边界、差异与暂存检查用于本次交付。5个有结果的临时数据/构建根已不存在，实际全应用端口无监听，测试服务与活动浏览器已关闭（glass-ui/cleanup.json）；测试源码、匿名证据及截图仅留云端本地，不暂存。

**首页交付复查：** 用户要求“先把首页改好同步GitHub，我拉下来看看”。开工main/远端同为ddb8f042c7e56112bc0cf0524d59b8f0c719790c且干净。新匿名完整应用浏览器实际复现首页全局搜索制度结果落在仅模板的知识库（home-review/run-BaKiKL、repro.log），而非已有后台维护区。最小修正search-all.ts的KB命中route及过时注释为/settings?section=references；不改检索内容、默认范围、排序、隐藏/恢复规则或资料。12组home-review最终通过（run-s1k3bY、after-6.log）：八导航、模型配置、新建取消、记录；待办排序/分页/刷新、503保留及明确完成；继续办理/全部工作、日历翻月/今天/事件；实际成果预览下载字节；工作/制度搜索、范围切换/空/失败后重试；首页空/加载/失败及重试；1920×900、1366×900、1280×600、1093×720、911×600、683×450、390×844及小高度滚动、玻璃层次与媒体偏好。125%/150%/200%仅等效CSS可用空间，未冒充Windows原生缩放。截图已亲自查看，无需新增布局修改。原知识可见性home-review-kb 20组通过（kb-rENGDG），使用本地AI替身；类型及独立构建通过。

测试工具首轮直接插入待办遗漏公开创建API的owner空串、误期望轻量联想包括制度域、取消挂起拦截顺序及hash导航未等页面切换造成重复执行；均按现有契约修正本地用例，未据此改业务。原失败日志保留，after-3/4非正常退出的两个自建后端已单独终止；只读/proc环境权限不足未重试，按既有隔离启动命令与进程归属完成清理。最终cleanup.json核实无剩余隔离根、无活动测试服务/浏览器，记录端口均关闭；不碰历史证据或真实资料。

已核对start.mjs、runtime-layout及dev-monthly：日常指针存在时拉取源码不切换发布包；新增INSTALLATION的Windows独立clone、npm ci、dev:monthly -- --build及18889/health身份核对说明，预览不带日常数据、不加seed-handoff。没有启动或读取Windows日常实例、修改发布指针、部署；Windows命令链为源码核查，待目标设备执行。五根文档再次全文复核：CONTEXT/PRODUCT_REQUIREMENTS无新术语或需求保持；GPT_CONTEXT/架构/进度整合当前基点及搜索去向，原GOV-13、质量矩阵/UI指南/索引同步。测试、夹具、截图与报告仅云端本地，精确暂存源码及正式文档，正常钩子提交推送并核实远端；最终SHA/CI见交付结果，无记录不算通过。

**未验及提交边界：** 未看到原图；旧完整npm test/typecheck:tests缺少原套件/test-isolation-contract/tsconfig.test.json。Windows字体、系统/浏览器缩放、原生高对比主题、旧浏览器、GPU性能、Office/真实模型、全部类型模板、完整视觉与业务验收未完成。此前官方Library helper通道tools/list报network，未获得可下载文件ID；本轮不重试受阻传输、不绕限制，仅交付本地真实截图。按当前明确授权精确提交推送main，执行原钩子并恢复权限，提交前后核对远端；本条提交前定稿，最终SHA与CI以交付核验为准，无记录不算CI通过。不强推、不部署。建议提交标题：feat(ui): add restrained frosted navigation surfaces。

## 2026-11-09｜GOV-13 / GOV-11｜文字规范下的浅色桌面界面

**依据与范围：** 从main/b8a5a0097d44e3df8a676cca7a27639bd59f1710开始，实时远端一致、工作区干净，origin为naobuqingjiaosha/WorkBench。用户授权按浅色macOS文字规范与现有代码实施，保留个人工作流程、资料、模板和自动生成定位，保留全部业务入口与确认。此前图像材料传递失败；本次未下载图像、未改网络、未看到原图，不能声明逐图还原。读取仓库规则、五根文档及相关正式指南；.agents/skills不存在，沿用已读取云运行技能。不操作Mac、Windows日常服务、真实资料或付费模型。

**7个源码文件：** 新增desktop.css并在main.tsx最后加载，浅冷灰侧栏/暖白背景/白面板/克制蓝色，200px侧栏、14px正文、36px常规控件、Windows优先字体及键盘焦点；首页仍7:5双栏，小高度允许滚动，窄屏保持单列和可展开导航。App更新个人工作空间文案，将配置模型入口改为可键盘操作的按钮。Knowledge默认模板库/字段映射，原制度四个维护面板复用至Settings→模型与资料→后台参考资料维护；首次展开后保持挂载，折叠不丢维护状态，后台行、索引、显式制度启用与引用逻辑不改。Template完整变量/循环/图片说明折叠收纳，上传/预览/配置/扫描/下载/归档等原实现保留。Workbench核对、关联记录、流程配置更新改为原生details，子组件不卸载；实际初版截图发现这些辅助区挤占阶段办理区，调整后主操作可达。文件格式图标防换行，模板操作按钮分行以保留名称和类别的阅读宽度。无后端、依赖、迁移、算法或风险确认机制改动。

**作者验证与本地证据：** `node scripts/test-isolated.mjs --unit desktop-ui`最终11组通过，证据`/workspace/workbench-cloud/desktop-ui/validation/run-GQ2nIk`及run-6.log。测试以专属临时根构建前端、启动完整实际应用，核对health=test与精确DB；匿名SQLite/合成DOCX和文本用于主页面、阶段/期次/工时/记录、创建取消和键盘、流程未保存退出、模板实际上传/预览/下载/删除取消及设置弹窗、文件预览/下载/上传取消、工作辅助区展开、期次保存重载。知识库含旧module=policy链接不展示制度哨兵；设置主动展开可见、折叠重开保留标签；原KB行与文件字节未变，显式引用判定未变。1366×900及1280×600、1366×650、1920×900，另1093×720与911×600只代表125%/150%等效CSS空间，非原生缩放验证；无页面JS错误和外网请求。511处实际可见文字实色对比度≥4.5，主题令牌四对4.96～13.56；禁用、透明混合、未显区域与所有动态状态未全面扫描。小高度补查`desktop-ui-small`2组通过（run-T96bA7）：1280×600侧栏系统配置键盘进入、首页底部记录跳转、阶段无模板提示、期次选择面板以及911×600窄屏导航。最终模板表格专项`desktop-ui-template`2组通过（run-i3nRA0）：真实上传预览下载/取消再验及1280/911视口设置弹窗、截图；这是对模板局部样式变化的复验，不与主套件次数累计业务覆盖。原`gov01-empty-ui`11组真实浏览器回归通过，含慢请求双击、关闭/后退/刷新保护、失败及响应丢失核对与明确重试、分项结果保留；证据`/workspace/workbench-cloud/gov01-empty/ui-Ac58PB`。原`gov01-kb-visibility`20组回归通过，证据`/workspace/workbench-cloud/gov01-kb-visibility/run-Q6VvK7`，仅本地AI替身。类型检查、隔离构建通过；工程/文档/暂存检查按本条交付步骤执行。以上为作者验证和差异复核，没有新独立审查，不借前批独立结论覆盖本次UI。

**失败记录：** 初始专项fixture误用indexDocumentText签名，修正测试后继续；第二轮把文件按钮“下载副本”误写为“下载”，未处理等待Promise导致退出清理不完整，已终止该轮自己创建的服务/浏览器并保留原日志。后两次模板补测分别将折叠说明的隐藏表格也计入行数、混用模板“下载”与文件“下载副本”标签，均为测试定位错误，未据此改业务；保留run-4/run-5失败证据，最终限定可见行、匹配实际按钮并补请求超时后通过。小高度补测首版误把无模板提示及内联选择器期望成弹窗（run-KJStcr），按原源码契约修正断言后2组通过，未改业务行为。全部测试误定位与失败日志保留，不累加重复运行次数扩大覆盖。

**引用导航交付复查与有限修复：** 浅色界面提交e0ce13df3b2ab0412c35709aec6bc1d6e0d8deb3已正常推送且远端核实，Git干净、CI无记录。审阅者指出引用弹窗仍跳模板前台；本环境gov01隔离规则下desktop-ui-citation-repro实际复现（run-L9MnBL/citation-before.log），原文及被引接口正常，但点知识库落模板页找不到制度维护，确为本次入口迁移断链。最小5文件调整：Workbench按钮改“后台参考资料”并导航#/settings?section=references；App传参数，Settings在模型与资料顶部默认折叠、仅该链接主动展开，组件继续保留挂载与原导航守卫；同步Settings、GenerateModal的制度路径提示及ProjectInfo字段映射提示，不改后台/引用数据或具体条款定位能力。最终desktop-ui-citation 4组真实全应用浏览器通过（run-OV3vMc/citation-after.log）：原文与被引1份、跳转目的区、刷新/折叠保留标签、返回原引用、普通模板前台/默认设置、未保存继续及放弃导航、小高度可达；KB行、引用行和文件字节前后相同，页面无异常、无真实模型/外网调用。类型和隔离构建通过；截图已亲自查看。两次隔离根/服务/浏览器已清理。测试与证据只留本环境；修复由作者验证，外部静态发现不等同本轮新独立全套验收。最终按已有授权精确提交推送并另核对SHA/CI，不部署。

**五份根文档与治理：** 全文复核GPT_CONTEXT、CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS。CONTEXT术语不变保持正文；其余整合当前基点、PR-18文字规范、样式层/后台维护结构、验证边界。引用导航补充复核CONTEXT与PRODUCT_REQUIREMENTS无新增语义，保持正文，其余受影响架构/接续/进度及指南、GOV-13/质量矩阵在原章节整合。现有GOV-13/质量矩阵、UI实施说明、使用说明和本条日志同步；旧13px/184px尺寸明确移为2026-10-24历史，刷新知识/源码索引，不新增任务队列。RK-11/RK-12保存保护、GOV-01/RK-01删除边界无实现变化，保留原记录及范围。

**清理、未验与交付：** 截图/测试源码/夹具/报告仅云端本地，不暂存。各隔离临时根与构建目录已由runner清理；11个有证据的根均不存在，所记录的10个本轮端口无监听，服务与活动浏览器已关闭（cleanup.json）。保留匿名截图和失败证据，不清原有资料。旧完整npm test/typecheck:tests资源缺失，Windows原生字体/系统与浏览器缩放、Office分页打印重算、真实模型、全部类型/模板、年度台账生成、完整逐图视觉与用户业务验收未完成，不关闭整个GOV-13。用户已有每轮提交推送授权：精确检查本批源码与正式文档、敏感/临时文件，执行原钩子普通提交推送main，前后核对远端并发和完整SHA；本条在提交前定稿，实际提交和CI情况以交付核验为准，无CI记录不代表通过。不强推、不部署。建议提交标题：feat(ui): apply light desktop theme and template-first knowledge view。

## 2026-11-06｜GOV-01 / GOV-11｜整工作软删知识可见性与恢复一致性

**范围与依据：** Linux Codex Cloud接续main/5fd56249be81639e1b280d88b9af1d3d3c3c8e2f，HEAD与实时远端一致、工作区干净，仓库naobuqingjiaosha/WorkBench；重读AGENTS、根接续/术语/需求/架构/进度、docs入口、GOV/RK及隔离说明，.agents/skills不存在，沿用已读取云环境运行技能。PR-08要求软删/恢复关联保护；trash读契约及softDeleteWorkbench明确“进回收站=从检索消失”，无依据支持其派生知识继续活动引用。仅整工作软删后的活动读取和本轮在途引用，不重做删除架构、不物理删KB、不改UI，不读真实库/模板/配置/凭证，不调用真实模型。

**修前确证：** gov01-kb-visibility-repro经原隔离入口、实际SQLite/原KB与助手路由注入及回环AI替身完成4组：软删后列表、直接正文/条款、全文/语义/全局与实际search_knowledge助手仍返回合成标识；等待embedding响应期间删除仍返回旧片段；等待KB问答或助手最终chat响应期间删除仍返回旧正文/引用。KB原行与磁盘字节未变、恢复后可读。证据`/workspace/workbench-cloud/gov01-kb-visibility/before.json`及before.log；复现退出0不是修复通过，无真实用户资料泄漏证据。

**8个源码文件与最小变化：** trash.ts增加复用既有visibleArtifactFilter的知识可见性SQL片段，无附件知识不受父工作过滤。kb.ts在列表/正文/片段/统计和缓存返回处过滤，缓存保留原片段向量以便恢复，不污染事务回滚；semantic/hybrid在await后复核。knowledge.ts为统一制度检索、显式ID及语料统计过滤并在返回前重核。kb-extract.ts片段FTS、search-all.ts全局KB、kb-cite.ts条款/文档匹配共用谓词。routes-kb.ts对齐统计、条款选择器和问答，模型前后来源不可见则409，避免回传旧答案。agent.ts仅记录本轮制度检索文档ID，在后续模型调用前/后及保存前复核；变化时撤回本轮答案和检索trace并提示重新查询。未改变整工作删除/恢复写入、文件补偿、stale/版本业务规则，未新增依赖/迁移/持久引擎。已返回历史会话不改写，已发送本地模型的上下文不能撤回。

**自检与本地证据：** 新专项20组通过（run-4Liogm/results.json、test-first.log）：列表/正文/条款/FTS/语义/全局/实际助手、删除/恢复的KB行向量和文件字节保留、独立知识/正常工作/无父附件、先删子项、单独父标记、stale、暖/冷缓存、删除触发器与恢复sync故障全表回滚、外层删除/恢复回滚、embedding/hybrid/统一检索await复核、KB回答409与助手本轮持久trace撤回、topK/显式ID/统计、单附件仍需重导入。回归副本仅改输出目录：软删21（run-N3yIai）+P2组合3（fix-FTrfSQ）、单附件17（single-run-EojUvd）、整工作22（run-PRBtRU）、清空12（api-y3y7oH）均通过。类型及78模块隔离构建通过（typecheck-candidate.log/build-candidate.log），仅输出/tmp/workbench-gov01-kb-build/dist。原测试与前批证据不改，不累计运行次数扩大覆盖。

**独立验收：** 首轮265项及补丁dacf6af2b65ee21f75bf58fc24194bc1ce7351366ae43fa0162d5731ba0c0938由全新审查者只读核对，原20+75组亲自复跑通过。独立反向6组5过1失败，确证P2/F1：多轮助手把命中原文作为后续search_knowledge.query，来源在第三轮响应时删除，最终答案虽撤回，trace.args仍随HTTP响应返回并保存在新agent_message.tool_calls；直接隔离DB证据见independent/extra-r0TXTg，首轮报告independent/REPORT.md保留。原20组第17组通过消息API验证正文，接口未返回tool_calls，不能证明落库trace无残留；已增强为直接SELECT content,tool_calls。限定修复仅在撤回本轮知识trace时同时清空args，保留工具名和固定状态；既有历史消息不改写。作者原20组增强重跑（run-fpbCHT）及原独立失败单项的只改输出路径副本（fix-mKnBbA）通过，typecheck-r2通过。新冻结266项及补丁9e383ae874865f4a38bdbd232b8f55479e4b450d8c7aacdebfeb312835475c38经独立复验通过（independent/RECHECK.md）：增强20组及独立6组全过，第6组并入原v3直接DB失败断言，未降低要求；撤回时响应和DB均args={}且无来源标记，正常trace原样、历史消息完整行不变，F1/P2解除。前后266项无变化；旧75组本轮未重复，保留首轮本人通过的原范围。独立初版曾误期望已删父的子附件恢复抛错，实际契约是恢复成功带警告、父过滤仍隐藏；修正测试预期后的v2通过对应场景，旧失败保留，不列为应用缺陷或累加覆盖。

**五份根文档与治理：** 全文复核GPT_CONTEXT、CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS；术语无变保持CONTEXT，其余整合接续基点、PR-08活动可见性、共享过滤/缓存/异步边界与当前验证。现有GOV-01/11、RK-01、质量矩阵、开发指南3.13及本条日志同步，修正指南旧“软删带文件未验”链接到3.12；生成知识/源码索引，不新建任务队列，不追逐committedBase自指。

**边界、清理与交付：** 全部AI调用仅匿名本地替身，纯后端API不代表UI/真实模型或全应用鉴权；历史会话/维护报告全链未验，Windows锁、跨盘/跨进程/崩溃、真实业务/Office及完整旧npm test/typecheck:tests资源未具备。GOV-01未整体关闭。隔离DB/合成文件与服务运行后关闭并由runner清根，作者构建目录已清理，首轮独立9次运行的根与6端口已清理；新冻结复验两隔离根及两AI端口亦已清理；原始证据仅云端本地。源码/正式文档已保存并限定独立验收通过，文档/仓库边界/差异检查通过；本条在提交前定稿，按用户授权审查精确暂存并执行原钩子普通提交推送main，前后核对并发及CI，最终SHA及远端状态以交付核验为准；不强推、不部署。建议提交标题：fix(kb): hide trashed workbench knowledge from active retrieval。

## 2026-11-06｜GOV-01 / GOV-11｜附件带文件软删除失败一致性

**范围与依据：** Linux Codex Cloud接续main/9fdd0f208f1ec2fdaa313637c9b6ede20bb58433，初始HEAD/远端一致、工作区干净，仓库naobuqingjiaosha/WorkBench；重读AGENTS、根文档、正式GOV/RK及隔离规则，.agents/skills不存在，云环境运行技能已读取。仅deleteArtifact及原DELETE附件路由，不重做前批、不操作Mac/真实库/资料/模板/凭证，无模型调用或部署。

**修前确证：** gov01-soft-repro经test-isolated及实际SQLite/原路由注入：记录UPDATE触发器拒绝后HTTP500但文件已丢；syncEvidence拒绝时已软删、索引/OCR已变而清单与KB未处理；第二篇KB删除拒绝时首篇已删、另一篇留下。正常删除KB文档为0但全文索引仍2行、即时空语义查询仍命中缓存2片。before.json/before.log保留于`/workspace/workbench-cloud/gov01-soft/`，退出0仅代表确证。注释曾称软删不动KB，实际代码已删除关联KB；本批按父任务明确要求保留恢复后重导入语义，并把结果写入响应，纠正矛盾注释。

**文件与变化：** store.ts复用trash.ts既有文件补偿，把附件标记/索引、OCR、初检、syncEvidence、KB文档/片段/全文索引合入同一事务；拒绝带文件外层事务、比较附件快照，已软删重复调用不碰新文件。安全拒绝仍软删并明示；真正故障回滚并补偿，补偿冲突保留副本。trash.ts导出既有助手及可关闭其目录收尾参数，软删继续按原附件根清空目录；独立修复增加安全拒绝子类保留清理警告，详见下段。kb.ts同步缓存失效，事务内读取不复用/填充可回滚的全局矩阵；routes-files.ts依据实际结果回传文件删除、跳过、KB移除/重导入及清理警告，提交后清理问题不误报主操作失败。无UI、依赖、迁移或配置修改。

**自检：** gov01-soft最终21组通过（run-r0RpeP/results.json、test-second.log），涵盖正常/恢复/重复、普通软删、记录/同步/KB/延迟FK故障、EBUSY/ENOSPC、补偿EPERM/目标冲突、副本/目录清理警告、前后指纹变化/只读/共享引用/登记漂移、缺文件/解绑、外层事务和回滚缓存。逐表与二进制字节比较，FK及事务退出检查。首轮test-first.log因测试把阶段已完成工作进度错误期望为0而失败；按既有两门槛口径修正为50，不改应用算法，保留失败证据。旧单附件17组（single-run-OtNUJ0）、整工作22组（run-VTS3JY）、清空12组（api-4h4KJT）断言以新输出路径回归通过，不累计为新增覆盖。npm run typecheck及78模块隔离前端构建通过（typecheck-final.log/build.log），产物仅专属/tmp/workbench-gov01-soft-build/dist。文档、边界、差异检查按冻结前执行。

**独立验收：** 首轮冻结263项及补丁4a2863f78dbd6514c6253863b7ddae44fe712caf3b8394bd23bbc71df3ed7096经全新审查者只读核对，原21/17/22/12组亲自复跑通过，新增7组中6过1失败，报告`/workspace/workbench-cloud/gov01-soft/independent/REPORT.md`。阻断P2为晚期安全拒绝叠加副本清理EPERM被转换为普通Error，返回500、全表未软删；原文件与备份均完整，非数据丢失或提交后误报。限定修复以PurgeSafetyRefusal保留安全类别与清理warnings，软删继续事务；如该事务也失败仍报失败并保留副本位置。真实数据库/复制/删除/补偿故障不降级。新增本地3组组合回归（fix-oYL1im）及原21组复跑（run-AYgAeK）通过，类型/构建复跑通过（typecheck-r2.log/build-candidate.log），新冻结264项及补丁76e12089d3e1fa97b2a86f200f9c56654b82a79dc8d130ddb1a905c219d1555f独立复验通过（independent/RECHECK.md）：亲自重跑原21/17/22/12、原独立7、作者新3、独立反向3组共85组全过；核对硬删除400/清空protected、真正DB错误failed与cleanup位置。前后264项无变化，原断言未降低，首轮P2已解除；原失败证据保持，不累计运行次数作更广覆盖。修复首试用了Node strip-only不支持的参数属性，两个专项均在加载前失败（fix.log/soft-final.log）；改为显式类属性后通过，未改业务规则或测试断言。

**五份根文档及治理：** 全文复核GPT_CONTEXT、CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS；CONTEXT术语无变化保持正文，其余分别整合当前接续、PR-08既有语义/故障要求、补偿/事务/缓存结构、实际验证与剩余范围。PROJECT_PLAN仍唯一队列，RK-01/07、质量矩阵和开发指南3.12同步；本条日志合并收尾，刷新两份机器索引，不追逐source-inventory提交自指哈希。

**未测、清理与交付：** 未新增页面入口、未做本批浏览器/实际断网/全应用鉴权；Linux注入不等于Windows锁。完整npm test/typecheck:tests旧资源缺失，跨盘/跨进程/崩溃/断电恢复未验，GOV-01未整体关闭。隔离运行根由runner清除，补偿故障残留仅验证后清理自建副本，未启动浏览器或持久测试服务；作者构建目录已清理；首轮独立五个临时根与两个回环端口均已清理，新冻结复验的七个临时根及两个回环端口亦已清理。文档/仓库边界/差异检查通过；源码/文档已保存并完成限定独立验收。本条在提交前定稿，按用户明确授权审查暂存并普通提交推送main，执行原钩子并恢复本地权限；最终SHA、远端与CI实况以交付时核验为准，不强推、不部署；测试/夹具/报告仅本环境保留。建议提交标题：fix(trash): preserve consistency during artifact soft deletion。

## 2026-11-06｜GOV-01 / GOV-11 / GOV-13｜清空回收站逐目标结果与重复提交保护

**目标、基点与范围：** 接续main/31c93bfd6f99d5fcacc4b77ed64ac181ff38384f，HEAD及实时origin/main相同，工作区干净；仓库naobuqingjiaosha/WorkBench、Linux Codex Cloud可执行，未操作Mac。读取AGENTS、根接续/术语/需求/架构/进度、docs入口、GOV/RK/质量与隔离规范；云环境运行技能核对当前环境ready、网络策略enforced，无读取凭证。仅清空回收站反馈与页面互斥，不扩展文件补偿架构；测试仅原test-isolated入口及专属匿名临时根，不读真实库/资料/模板/配置/成品，不部署。

**修前证据：** 本地gov01-empty-repro在实际SQLite/原路由上让系统必备字段拒绝删除，DELETE仍200、purged=0且没有失败明细。实际Chromium加载App/Trash，绿色“已彻底删除0项”提示并关闭对话框；同一轮双击实际发出2次DELETE，请求期间保留期仍可选。字段记录仍在。before.json、before.log、before-pending.png及before-false-success.png保存在`/workspace/workbench-cloud/gov01-empty/`，退出0表示缺陷确证，不代表修复通过。

**修改文件与行为：**

- `packages/server/src/core/trash.ts`：清空以既有倒序列表最多2000条为快照，严格早于保留期界线的目标才进入处理。选中工作/字段先处理，快照内附件/阶段/别名随父成功标covered，父失败标notExecuted，不拆删或重复计数。items含种类/ID/标题、原因与父目标，计数区分purged/covered/retained/protected/failed/notExecuted；skipped是已提交目标中被安全规则保留的文件，warnings是清理问题；scope标快照/原总数/上限/快照外/结束剩余及界线。真正故障不再仅console.warn。补偿成功后的SafetyRefusal保留原类别用于安全拒绝分类，未改副本/数据库/删除/恢复顺序。
- `packages/server/src/api/routes-files.ts`：沿用200响应中的分项目结果，摘要明确失败与未执行数量、范围外及剩余；保留旧warnings具体原因供原消息消费者读取。保留期无效值拒绝，不静默变全清。不把HTTP200当全部目标成功。
- `packages/web/src/pages/Trash.tsx`：同步ref锁挡重绘前双击，锁定保留期、筛选、关闭，接入既有NavigationGuard在途离开保护。结果留在对话框，关闭后仍在页面卡片，列表刷新不清结果；失败/安全保留/警告采用非全成功提示。未收到完整响应保留选择与未知提示，不自动重试；须主动核对全部类型列表（最多2000项），实际响应持留为可读核对快照，再明确确认。单项删除warnings/skipped改为非绿色提示并持留消息；原只删记录/带文件选项保留。没有服务端幂等键或持久任务引擎。
- `PRODUCT_REQUIREMENTS.md`将当前明确要求整合到PR-08；`SYSTEM_ARCHITECTURE.md`写计数/父子/范围与互斥边界；`GPT_CONTEXT.md`、`DEVELOPMENT_PROGRESS.md`整合当前基点/验证状态。现有`PROJECT_PLAN`、`RISKS_AND_DECISIONS`、`QUALITY_AND_ACCEPTANCE`及开发指南3.11更新；本条WORK_LOG记录过程，生成知识/源码索引，不新增任务队列或修改CHANGELOG。CONTEXT术语无变动。

**采用研究：** 沿用前批已静态读取的Paperless-ngx固定a4543c03dceedafd3e588c9832306893993bffc4[成组删除契约](https://github.com/paperless-ngx/paperless-ngx/blob/a4543c03dceedafd3e588c9832306893993bffc4/src/documents/models.py#L550-L568)及[整组结果测试](https://github.com/paperless-ngx/paperless-ngx/blob/a4543c03dceedafd3e588c9832306893993bffc4/src/documents/tests/test_api_trash.py#L242-L282)，只借鉴明确父子范围与逐项验证的思路，自行实现；未复制GPL代码、未增加依赖。本项目deleted_at同批恢复保留，参考不是原子性证明，持久恢复协议未实现。

**验证与证据：**

- gov01-empty最终12组API通过（api-Q6r7S4/results.json、api-candidate.log）：全成功/重复、立即/提交FK全失败、混合第2文件EBUSY后父补偿且独立目标提交、单附件真实business_ai_run外键、7天精确边界/较早1ms、父级带走较新子项、文件安全跳过/清理警告、安全拒绝分类、2000快照保留最新而旧合格项留在范围外、范围外子项随父消失、无效天数及单项记录-only/缺文件兼容。逐表行和全部文件字节核对，foreign_key_check及事务退出检查；不以状态码代替一致性。
- gov01-empty-ui最终10组实际Chromium通过（ui-vZSGaL/results.json、ui-candidate.log及截图）：同步双击仅1请求，关闭/遮罩/Escape/保留期/筛选/后退/原生刷新均保护，部分失败明细可读且刷新/筛选后保留；全部文件目标失败时库/字节不变，解除约束后仅明确重试；服务器已提交后丢响应不自动重试，关闭重开仍要求核对；核对GET失败不解锁、选择30天保留，核对成功后明确再次提交；全成功、仅保留期、安全拒绝、文件安全跳过、清理警告和2000限制非全成功呈现；单项warning一致提示。1366×900实际截图检查，未冒充完整设计视口矩阵。Vite实际App/Trash及原路由，session/AI状态为本地替身，不代表全应用鉴权。
- 单附件原17组和整工作原22组以仅输出路径不同的本地副本回归通过（single-run-U3MNRG、run-tW0n3V）；前批证据未改。曾发现旧17组最后一项要求清空message包含具体清理警告，首轮失败保留于single-regression.log；恢复该兼容消息后原断言17组通过，不以改断言掩盖回归。API工具首轮因新建第二合成DB却复用模块schema缓存失败，调用现有resetArtifactIdentitySchema修复测试工具后通过；未改业务缓存。所有失败日志保留，不累加运行次数作覆盖。
- npm run typecheck server/web通过；Vite78模块构建仅`/tmp/workbench-gov01-empty-build/dist`，候选日志typecheck-candidate.log/build-candidate.log。仓库/文档/差异检查按收尾执行。测试脚本、匿名夹具、截图和报告均在本地忽略路径，不上传；未修改依赖、锁文件、配置或迁移。

**边界与关键口径：** 保持7天默认；清空处理全部类型，与页面筛选无关。2000条按现有最新优先快照取数后再过滤，不无限批处理；snapshot外数量不保证未被父级联带走。选中父的全部子项仍按父级删除，不按子项日期另保留；父失败不拆组。单目标可回滚/补偿，已经成功的其他目标保留，非整批原子。结果仅页面挂载期保存，强制刷新后不持久；非服务器多窗口/跨进程幂等。Windows锁/权限、跨盘/跨进程并发、崩溃/断电重启、软删withFile=true、真实资料/Office/模型未验；旧完整npm test及typecheck:tests因资源缺失未跑。GOV-01未整体关闭。

**独立验收与有限修复：** 全新未参与实施审查者第一轮冻结263项/patch SHA256 b06b79d676d5208ec18ca6f7ef395bd6d89a5353870763586de9366d69bd9d7d前后一致，独立原API12/浏览器10及新API2组通过；另2组真实浏览器补证发现P2：核对GET limit=2000响应被丢弃，默认500列表可能漏第501条，或列表刷新失败仍显示核对完成并解锁。证据independent/ui-extra-fXcbzD/results.json、REPORT.md保留，其通过只表示缺陷已复现。独立先冻结末核对并完成5次临时根/服务清理，再交实施者有限修复，未边审边改。

修复只改Trash页面：保存并直接展示核对GET的实际条目快照（kind/id/title/deletedAt、已读/总数/2000边界），不依赖后台列表刷新或类型筛选；再次核对先清旧快照和许可，失败不能沿用。新增作者501条、筛选、刷新失败与重新核对失败场景；完整UI11组通过（ui-T9LJKm/results.json、ui-p2-final.log），类型与78模块隔离构建重新通过（typecheck-p2-final.log、build-p2-final.log），同一独立审查者复验通过。两个服务端源码及旧17/22组回归测试未变，不因文案修复无限重跑全部矩阵。

第二轮独立结论PASS、P2关闭、无本批剩余阻断，最终REPORT.md与原REPORT-first-review.md分别保留。263项前后冻结一致，第二轮patch SHA256 0d01384feeed5112a956ad9c848e0a7fec7a7a3414d46f380309399ed160fd9a；Trash.tsx SHA256 3e81426aa9790f7435489bf4e58cff0b7e2036143d59bc174273cf038ab9c6b4。独立新版原UI11组（p2-ui-ZohjqQ）及反向2组（p2-extra-p0O6PJ）通过：真实核对快照在辅助刷新失败时可读，重核对开始/失败撤销旧许可；501条跨类型快照保留最旧字段与附件，关闭/筛选/列表刷新不丢，全表与字节不变。独立仅修自身标题定位器的过严断言，失败日志保留，未修改实现。第一轮API12/独立API2仍绑定未变服务端哈希；作者17/22及类型/构建未冒充独立结果。审查者docs/check-repository/diff检查通过。独立两轮cleanup与p2-cleanup确认5+3次自建根均删、HTTP/Vite端口关闭、浏览器与数据库已关闭。最终收尾只改文档状态/索引，三份业务源码和作者专项保持冻结哈希。

**五份根文档复核：** GPT_CONTEXT与DEVELOPMENT_PROGRESS更新清空范围、基点与当前证据；CONTEXT完整复核无术语变化不改正文；PRODUCT_REQUIREMENTS将本次明确验收条件整合PR-08；SYSTEM_ARCHITECTURE明确快照/父子计数/结果/互斥，未扩展为持久任务架构。

**清理与交付：** 每轮finally关闭自建浏览器/Vite/HTTP/DB，原隔离入口删除专属临时根；cleanup-author.json另核对修前根、10份作者自检/回归证据对应根及P2复测根均不存在，HTTP端口已关，两份专属构建目录已删除。匿名证据与脚本保留本环境，原有资料/证据不动。当前源码文档已保存并通过限定独立验收；本条写于提交前，不预记Git结果。按用户授权精确暂存本批14份共享文件、普通提交推送main，前后核对远端并发。原钩子0600仅执行期间临时启用并恢复原权限，不强推、不跳过保护、不部署。最终SHA/Git/CI按实际执行回报，无CI记录不算通过。

## 2026-11-06｜GOV-01 / GOV-11｜整工作多文件彻底删除与逐份失败补偿

**目标与基点：** 接续晚间GOV-01，仅处理整工作从回收站彻底删除、涉及多个受管文件的进程内一致性；不重做上批单附件、不扩展通用任务引擎。Linux Codex Cloud `/workspace/WorkBench`，main与实时远端main均为fcb8de36dd7d0990f375d2d9b68018afe5c945ac，origin为https://github.com/naobuqingjiaosha/WorkBench.git，开工工作区干净。环境恢复后可执行，无持续环境阻塞；只使用本云环境，不操作Mac。读取AGENTS、GPT_CONTEXT、docs入口、GOV-01/RK-01、质量与隔离说明并复核五份根文档。不读取真实库、资料、配置、模板、成品或凭证，不调用模型，不部署。

**修前证据与有限设计：** `gov01-workbench-repro.ts`通过原隔离入口创建3份匿名文件、工作及真实SQLite约束。立即外键失败后父/子记录回滚保留，但3份文件全消失；第2份unlink模拟EBUSY被原循环捕获后仍返回purged=true/filesRemoved=2，父/子记录清除而磁盘剩1份。`/workspace/workbench-cloud/gov01-workbench/before.json`、before.log与复现脚本保留，退出0只表示两缺陷被确证，不是修复通过。没有真实资料损失证据。

父任务研究线索与本机复现相符。仅借鉴明确成组范围和验证整组结果的设计经验，独立实现于现有React/Fastify/SQLite体系；已静态读取Paperless-ngx固定a4543c03dceedafd3e588c9832306893993bffc4的[根文档/版本删除分组](https://github.com/paperless-ngx/paperless-ngx/blob/a4543c03dceedafd3e588c9832306893993bffc4/src/documents/models.py#L550-L568)及[根与版本恢复测试](https://github.com/paperless-ngx/paperless-ngx/blob/a4543c03dceedafd3e588c9832306893993bffc4/src/documents/tests/test_api_trash.py#L242-L282)。它使用同一transaction_id维护根/版本组，本项目仍保留原deleted_at同批恢复，不复制GPL代码或增加外部依赖；参考测试不证明跨数据库/文件原子性。持久operation_id、重启扫描与崩溃恢复只是后续设计可能性，本批未实现，也未为此新建任务队列。

**实际修改清单：**

- `packages/server/src/core/trash.ts`：小范围抽取上批补偿为purgeFilesWithCompensation；单附件继续复用，整工作按实际路径分组去重、备齐所有可删文件副本后才进入删除事务。用副本内容哈希检查当前文件（包括旧无登记哈希文件），副本后重查引用/指纹，事务内核对父工作/附件登记快照。先删数据库行，逐份unlink，再提交；即时外键、文件操作或提交失败时回滚并逐份COPYFILE_EXCL恢复，一份补偿失败继续其余项，保留全部副本并报位置，不覆盖新文件。保留原数据库关系清理顺序，不新增迁移或解除业务外键。
- 同文件多个登记任一安全阀不满足则整份磁盘文件保留；外部活引用按各自实际绝对路径核对，避免不同root/file_rel指向同一路径被漏掉。预检只读/指纹不符/外部活引用通过skipped明确返回，符合既有安全保留语义；无法确认位置则整次拒绝。复制/unlink/提交等真正失败不得转为跳过并清库。错误响应沿原路由返回400，说明失败阶段/文件编号、已补偿和未执行/未成功数量；已提交但副本清理失败沿上批warnings返回。无API路由或UI源码变更。
- 绑定工作目录清理改到数据库成功提交之后，提前保存必要目录清单；仅处理允许删除、非链接、平台命名且空的目录，保留根、只读目录和未登记文件。withFile=false保持仅数据库操作及嵌套事务回滚；带文件操作拒绝外层事务。未修改softDelete withFile=true或清空回收站逐项循环的整批语义。
- `GPT_CONTEXT.md`、`DEVELOPMENT_PROGRESS.md`：整合main/fcb8de3基点、当前整工作范围与单附件历史交付，补本机22组及17/12组新候选回归边界。`SYSTEM_ARCHITECTURE.md`整合成组补偿、保护、失败结果与无持久恢复协议的边界。
- `docs/management/PROJECT_PLAN.md`、`RISKS_AND_DECISIONS.md`、`QUALITY_AND_ACCEPTANCE.md`：沿GOV-01/GOV-11与RK-01/07更新确证问题、限定进度和未测，不整体关闭GOV-01。`docs/guides/DEVELOPMENT.md`新增3.10限定验证及人工补偿目录处理说明、整合3.9副本字段；本条WORK_LOG记录实际工作，不追加CHANGELOG。
- 自动生成`docs/knowledge-index.json`与`docs/reference/source-inventory.json`，docs/README由生成器复核。没有依赖、锁文件、配置、数据库迁移或前端改动。
- 本机新增忽略测试：`gov01-workbench-repro.ts`、`gov01-workbench.ts`、`gov01-single-regression.ts`、`gov01-single-independent-regression.ts`。后两份仅改上批脚本的输出目录，原脚本/证据保留；所有用例、合成夹具、证据均不进入Git。

**验证结果：**

- 最终`node scripts/test-isolated.mjs --unit gov01-workbench`退出0、22组通过，原始结果`/workspace/workbench-cloud/gov01-workbench/run-eDxcCf/results.json`，日志test-candidate.log。包含正常3文件HTTP删除/重复、普通父恢复/重复/重删、父立即和延迟外键、现有business_ai_run外键、第2份EBUSY/第3份EPERM、第二份副本复制失败、补偿失败仍恢复其他项、恢复目标冲突、同路径去重及冲突指纹、不同根的外部活引用、只读文件/目录、旧无指纹变化、登记快照变化、定位失败、嵌套事务、withFile=false、缺失/零字节、旧external_root绑定及提交后清理警告。每轮核对全表行/字节和foreign_key_check，失败不凭HTTP码推断回滚；第N份unlink时直接断言3份副本都已存在。
- 首轮20组run-QPMxgC通过，补绑定目录2组后run-0yOYUL的22组通过；随后仅补失败阶段/数量提示及其断言，最终22组通过。分别保留日志，不累计数量扩大业务覆盖。
- 在最终共享源码上运行`gov01-single-regression`17组通过（single-run-cOwxfg，single-17-candidate.log）；`gov01-single-independent-regression`12组通过（single-independent-rerun/supplement-results.json，single-12-candidate.log）。这是作者重跑上批原套件及上批独立补测，用例来源不使本次作者运行自动变成独立验收；旧证据未覆盖。这两份副本只更换输出路径，未删断言。
- `npm run typecheck`server/web通过；`npm --workspace @workbench/web run build -- --outDir /tmp/workbench-gov01-multi-build-7l4gra/dist`78模块构建通过，仅专属临时目录。`npm run repo:check`258项通过，`git diff --check`通过；docs-maintenance generate/check按治理运行。不新增依赖，不覆盖日常dist。
- `npm test`、`typecheck:tests`未运行：旧完整用例、test-isolation-contract及tsconfig.test.json缺失。文件占用、权限、容量、补偿故障仅通过测试进程内fs替身模拟，不是Windows真实锁。没有完整应用鉴权/UI、Windows/Office、真实业务/模型、跨盘/跨进程压力、崩溃/断电自动恢复、软删带文件或清空回收站全矩阵验收；不把本批升级为完整系统通过。

**独立验收：** 全新未参与本批实施的审查者仅只读核查/复跑，`/workspace/workbench-cloud/gov01-workbench/independent/REPORT.md`结论PASS，无阻断。262项冻结前后相同，patch SHA256 d7c2471135993f79002b2f5a9e42f6e63fa862da446dab3e2798f034da97953f，trash.ts SHA256 1c55dd369eefa0ac97dae43daf40ec7e5c741337ec4a7b0a41dcd80ae8bee8ba。独立原22组通过（author-rerun-oB1BCB），单附件12组原断言重跑通过（single/supplement-results.json），新增16组通过（supplement-WqB82l）。新补证使用5份二进制文件、77表及故障约束时78表，含非空检查/草稿/工作历史关系，验证第1/3/5份unlink、末份备份失败、两份补偿失败仍继续、EXCL冲突、同批deleted_at与FTS恢复、迟到外部引用、父快照漂移、lstat EACCES/ENOTDIR、缺失计数、绑定目录链接/只读哨兵保护。所有表行/字节比较、foreign_key_check及事务退出均核对。独立未重跑作者17组或类型/构建，未把作者结果当独立结果；未将修前作者复现称为独立重现。3个新本地忽略审查脚本只保存本环境。独立cleanup.json/process-cleanup.json确认3根已删、37053无监听且无残留Node服务。独立通过后仅收尾文档状态及索引，生产源码/原测试保持冻结哈希。

**五份根文档复核：** GPT_CONTEXT更新本批开工基点/限定状态；CONTEXT完整复核，业务术语不变、正文不改；PRODUCT_REQUIREMENTS完整复核，PR-08及完整性要求不变、正文不改；SYSTEM_ARCHITECTURE整合成组补偿的实际流程及无崩溃保证边界；DEVELOPMENT_PROGRESS更新本批范围、验证、缺资源与历史证据归属。只在实际改变正文的文档递增版本。

**清理与交付：** 原隔离入口在每轮finally关闭并删除专属运行根；作者cleanup-author.json另核对7份可定位证据的临时根全部不存在、对应HTTP端口无监听，专属构建目录已删除。模拟补偿失败留存副本在断言后仅清理本轮自建数据；未启动浏览器，未触碰既有证据/源码/资料。候选已通过限定独立验收，源码与文档已保存；本条写于提交前，不预记提交/推送结果。用户已授权精确暂存本批11份共享文件并普通提交推送main；提交前后核对远端并发，原钩子0600仅执行期间临时启用并恢复原权限，不强推、不跳过保护。测试/夹具/报告不上传，未部署。完整SHA、最终Git状态与CI由实际执行回报核对，无CI记录不算通过。

## 2026-11-06｜GOV-01 / GOV-11｜单附件彻底删除的数据库失败与文件补偿

**目标与基点：** 按原GOV-01队列选择单附件回收站彻底删除`purgeFromTrash('artifact')`，覆盖与它直接相关的普通软删/恢复，不重做Periods、不重写删除系统。本次Linux Codex Cloud环境/workspace/WorkBench，origin为https://github.com/naobuqingjiaosha/WorkBench.git。初始work/4869a7e干净；实时远端main为f609016234c3b4cf056742ee35fe2c29fb96f975，确认祖先关系后fetch并切main，无覆盖既有修改。环境status可见source_config_id/version，但不显示github-1434044454别名；指定绑定来自委派，不能声称后台别名已独立核验。读AGENTS、GPT_CONTEXT、docs/README、五份根文档、正式GOV/RK/质量与隔离治理；无本仓库.agents/skills。协作01原报告未随Git存在，未以旧报告冒充当前证据。不读真实资料、正式库、配置、模板、成品，不操作Mac或调用模型。

**确证与修改：**

- 修前本地`gov01-repro.ts`经原隔离入口建立完整迁移匿名库、单个合成文本附件和额外RESTRICT引用。实际SQLite拒绝DELETE，artifact记录仍在，但文件已unlink。`/workspace/workbench-cloud/gov01/before.json`及本地复现脚本保留；复现命令退出0只证明缺陷存在，不是修复通过。未发现或宣称真实资料丢失。
- `packages/server/src/core/trash.ts`：仅单附件withFile路径增加私有临时补偿副本和原路径说明，数据库清理与unlink纳入同一事务；即时外键失败不删原文件，延迟提交失败用COPYFILE_EXCL补回字节。补偿失败/新文件冲突明确报错、保留副本，不覆盖新文件；临时复制失败不改记录。外层事务拒绝带文件删除，避免调用者后续回滚破坏一致性。正常完成清理副本并回收空业务目录；删除已提交但副本清理失败返回warnings。withFile=false、缺文件、原有只读/指纹/在用引用拒绝保留。清空入口只转发单附件返回的清理警告；不修整工作或软删withFile=true逻辑，不新增迁移/依赖/UI/配置。
- `packages/server/src/api/routes-files.ts`：单项及清空回复message附加清理警告，保留实际purged/filesRemoved字段，不把清理失败写成普通删除失败。
- `GPT_CONTEXT.md`、`DEVELOPMENT_PROGRESS.md`整合当前main/f609016基点、单附件候选和验证边界；前批Periods与旧Mac结论保留原范围。`SYSTEM_ARCHITECTURE.md`说明私有补偿流程及无崩溃自动恢复边界。
- `docs/management/PROJECT_PLAN.md`沿GOV-01/GOV-11整合状态，RK-01记录确证缺陷、RK-07区分补偿与备份、RK-08补本批隔离边界；`QUALITY_AND_ACCEPTANCE.md`分列单附件覆盖与未测，GOV-01不整体关闭。`docs/guides/DEVELOPMENT.md`补本地专项重建条件、模拟与实测区别及残留副本处理原则。本条WORK_LOG记录过程，不新建队列或追加CHANGELOG。
- 运行docs-maintenance刷新`docs/knowledge-index.json`与`docs/reference/source-inventory.json`；生成器复核docs/README，无需手改。
- 新增本机忽略测试`packages/server/test/gov01-repro.ts`、`gov01-artifact.ts`与源码外`/workspace/workbench-cloud/gov01`证据；全部不进入Git。没有新增可上传测试或虚构夹具。

**自检证据：**

- 最终`node scripts/test-isolated.mjs --unit gov01-artifact`退出0，17组通过；结果在`/workspace/workbench-cloud/gov01/run-D7iZgf/results.json`，日志test-final.log。包括普通软删/重复/恢复/重复恢复/HTTP彻底删除重试、即时RESTRICT、延迟外键提交失败补偿、模拟unlink EBUSY与EPERM、复制ENOSPC、补偿失败保留副本、补偿冲突保护新文件、已提交清理警告、withFile=false、缺文件恢复警告、指纹/在用引用/只读拒绝、外层事务拒绝、关联工作恢复同步失败回滚重试、清空入口警告转发。失败分支逐表比较全部SQLite表行，并直接读取实际文件字节；最终foreign_key_check为空。HTTP只注册本批现有回收站路由，不冒充完整应用或页面验收。
- 第一次测试13组通过后在“只读根”测试失败：夹具错误地把平台DATA_ROOT声明为只读，生产规则明确忽略这种声明。修正本地夹具为隔离根内独立外部目录后15组通过（run-bdhBWU）；再补关联恢复/警告转发两组，最终17组通过。原失败run-vwJIH6及test-first.log保留，不改业务安全规则以适配测试；次数不累计扩大覆盖。
- `npm run typecheck`server/web通过；`npm --workspace @workbench/web run build -- --outDir /tmp/workbench-gov01-build-y8zqlf/dist`成功（78模块）；无前端源码变更。`npm run repo:check`258项通过；差异检查通过。没有安装依赖或改锁文件。
- `npm test`及`npm run typecheck:tests`未执行：旧packages/server/test套件、scripts/test-isolation-contract.mjs和tsconfig.test.json缺失；本地最小专项不能替代完整套件。Windows文件锁/权限、Office、真实工时/模型、完整UI、跨进程压力、断电/进程崩溃自动恢复、整工作/阶段/批量矩阵、软删withFile=true未验，不列为本批完成。

**独立验收：** 一名全新、未参与实施的审查者在冻结后只读审查共享源码/文档与测试，未修改候选。`/workspace/workbench-cloud/gov01/independent/REPORT.md`结论PASS，无阻断；冻结258共享文件及2作者本地测试共260项前后哈希匹配，补丁SHA256为e7f6e56d413f5370ac707b5b564ccfacc4b0adc7aaea6d0b8958d2d8ca41aea7。原17组独立复跑通过（run-tWZj3N），新增本地忽略`gov01-independent.ts`的12组补测通过；包括真实business_ai_run外键、非空依赖图/FTS即时与延迟回滚、65,537字节二进制恢复、manifest/目录清理失败、复制期间指纹/引用重查、withFile=false外层回滚、恢复父目录链接拒绝、零字节/重试。常规77表，带测试约束78表，逐表完整行摘要及文件字节对照保存在supplement-results.json；次数分开记录，不累计成全系统覆盖。独立server/web类型、diff及docs检查通过，两临时根已删、36143端口已关闭，cleanup.json确认。未把作者修前复现称为独立重现。独立通过后只更新文档验收状态、DEVELOPMENT修订号与前批GOV-13已推送事实，刷新索引，不改应用或测试。

**五份根文档复核：** GPT_CONTEXT替换已过时的前批开工状态，指向当前单附件限定任务；CONTEXT全文核对，术语不变，正文不改；PRODUCT_REQUIREMENTS全文核对，既有PR-08/完整性验收条件足够、业务要求不变，正文不改；SYSTEM_ARCHITECTURE整合实际补偿结构和非整体事务边界；DEVELOPMENT_PROGRESS更新基点/能力/验证/未完成项，历史证据不冒充本机复跑。

**清理与交付：** 每轮专项在finally关闭HTTP与SQLite，外层test-isolated删除其专属临时根；模拟补偿失败保留检查后由用例明确清理自有副本。没有浏览器或长期测试服务。作者cleanup-author.json确认4个自建根已删、3端口关闭、构建目录已删；独立cleanup.json另确认2个自建根及端口释放。必要匿名证据与源码保留。限定独立验收已通过、源码/文档已保存；本条正文写于提交前，不预记提交/推送结果。用户已授权每轮验收后普通提交推送对应GitHub main，仅精确暂存本批12份共享文件，测试/夹具/证据不上传；提交前后核对远端main，遇并发停止。云克隆原pre-commit/pre-push为0600，将仅在执行期间临时启用原钩子并恢复权限，不跳过保护、不改安全设置。实际SHA、推送/CI和最终Git状态以Git及执行回报核对；正式发布与真实业务验收未执行。

## 2026-11-06｜GOV-13 / GOV-11｜云端Periods冗余查询清理与限定回归

**目标与基点：** 按用户“两个项目继续，按照原先计划”及本线程仅WorkBench的限定授权，执行PROJECT_PLAN第2节第3项，不重复实现已完成的流程配置两阶段及修复。当前Linux云环境/workspace/WorkBench，分支work，初始工作区干净；HEAD与实时`git ls-remote origin refs/heads/main`均为4869a7ec69b95f3d8441393b8cbc744880b69b28，origin为https://github.com/naobuqingjiaosha/WorkBench.git。环境配置绑定github-1434044454来自委派说明，当前工具未提供配置元数据查询，不把仓库远端核对写成绑定后台已独立核验。读AGENTS、GPT_CONTEXT、docs/README、五份根文档、正式计划与运行/测试/文档治理说明；checkout无.agents/skills。不操作Mac，不读取正式库/模板/成品/模型凭证，不调用模型，不迁移或发布。

**修改与理由：**

- `packages/web/src/pages/Periods.tsx`：删除PeriodDetail未消费的`files = useApi(...)`、saveContent/refresh中的两次`files.reload()`以及Artifact、GenerateModal无用导入。原hook的data/loading/error均无消费者，useApi状态独立无共享缓存，GET artifacts/listArtifacts只读列表且无业务刷新副作用；故不是回退入口。保留saveContent成功后的detail.reload()/onChange()、refresh中有效刷新、p.files附件与refreshKey、WorkDocuments自有查询/重试/操作回调、离开保护和共享组件。应用源码仅此一文件，4行新增/7行删除；无后端、迁移或依赖变更。
- `GPT_CONTEXT.md`、`DEVELOPMENT_PROGRESS.md`：替换旧Mac“当前检出/远端未核实”口径，记录本次实际云端基点、已存在流程配置历史验收和当前限定自测、独立验收及P3收尾复验；清理候选改为限定验收通过、未提交保存，不把远端已有源码或历史通过写成云端全系统通过。
- `PRODUCT_REQUIREMENTS.md`：只更新多设备开发约束以对应用户最新云端要求；既有业务和验收要求不变。`SYSTEM_ARCHITECTURE.md`说明Periods详情/父级与WorkDocuments自身查询的实际刷新职责，不改变业务模型。
- `docs/management/PROJECT_PLAN.md`：在原GOV-13/GOV-11及原第3项整合本批结果；相关053964e已进入当前远端的事实同步，不新建任务队列。`QUALITY_AND_ACCEPTANCE.md`增加绑定4869a7e差异的云端自测/独立验收/工具收尾覆盖行，与历史Mac证据分开，不累计检查数量。
- `docs/guides/DEVELOPMENT.md`：增加3.8本地云回归的前提、原隔离入口、测试代理边界、清理与未覆盖范围；复核并沿用已有直接web workspace构建示例，避免根脚本参数转发问题，未改该示例。本文记录本任务，不追加CHANGELOG。
- 自动生成`docs/knowledge-index.json`和`docs/reference/source-inventory.json`；source-inventory的committedBase刷新为实际HEAD，Periods源码摘要同步。生成器也复核docs/README，内容无差异。
- 本机新增忽略文件`packages/server/test/cloud-periods.ts`及源码外`/workspace/workbench-cloud/periods-review-*`证据，不进入Git。用例使用合成工作、两期与两个文本附件，不接续旧Mac测试或真实夹具。

**验证与失败边界：**

- `npm run typecheck`通过server/web；`npm run repo:check`通过（258项，无违规）；`git diff --check`通过。源码审查核对Periods引用、api.useApi、routes-files/listArtifacts、期次详情、WorkDocuments、PeriodAttachments及NavigationGuard，确认有效请求、回退、保护与兼容入口保留。
- `node scripts/test-isolated.mjs --unit cloud-periods`最终退出0；内层执行`npm --workspace @workbench/web run build -- --outDir <本次临时根>/web`，78模块构建通过。真实HTTP健康确认profile=test与专属dbFile，自动备份未启动。
- 作者自测`/workspace/workbench-cloud/periods-review-aRasQk/results.json`记录16项通过：独立构建、隔离身份、13项实际Chromium页面链路及最终数据边界核对。页面操作含月度初载；A/B切期继续/放弃/保存并离开；503后输入和数据库保留、重试只存A；慢普通保存锁定输入和离开按钮；附件已上传但关联503时保留文件/恢复UI及离开保护，重试成功且POST上传仍只有一次；附件确认及参考资料刷新；详情刷新失败保留组件/输入后重试、详情初载失败重试、WorkDocuments自身成果查询503重试。最终两期快照/status、B内容/文件不变，A新增两份匿名附件，下载字节与合成原文一致。
- 初始`periods-review-29ooCC`和`periods-review-kiygtN`均在首屏等待超时退出1；本地代理只改Host、未改Origin，浏览器模块请求被应用来源保护拒绝，白屏不算通过。修正本地代理转发Origin后完整重跑通过，未改应用来源守卫；失败日志保留。截图/页面文本、请求路径、服务/浏览器日志与脚本副本分别存各运行目录；该轮是作者自测，不是随后发生的独立验收。浏览器图片人工查看限故障页，不宣称完整视觉验收。
- `node scripts/docs-maintenance.mjs generate`、`node scripts/docs-maintenance.mjs check`通过；24份共享文档、224源码、284路由声明、42迁移的静态索引核对，不等于运行API或业务验收。
- `npm test`、`npm run typecheck:tests`未执行：原测试用例、隔离契约脚本与tsconfig.test.json未随云克隆交付。未运行旧Mac15份专项、WorkDocuments逐项成果关联/生成/定稿链、原生刷新/关页保护、完整视觉与全部类型模板、Windows/Office、真实业务/数据迁移/模型或跨进程压力；不得以当前页面链路替代这些缺项。

**独立验收与两项P3有限收尾：**

- 在同一checkout按明确授权启动一名未参与实施的审查者，原11份候选冻结后不改。独立报告`/workspace/workbench-cloud/periods-independent-20261106/report.md`结论PASS，无P0～P2应用回归；原套件在`periods-review-4oCORc`重跑16项/13条页面链路通过，独立副本在`periods-review-9KmS85`通过19项（原16项加3项请求计数）。普通保存artifacts读取0次，上传后1次，成果重试1次且详情/父级均0次；这些是同范围补证，不累计为更多业务覆盖。
- P3测试等待：独立补测`periods-review-3T8rBj`出现selector absent，期次详情先于父级选项返回。仅在本地忽略的cloud-periods.ts加入独立副本已验证的“期次选项就绪”条件，其余断言不变；原失败记录及原脚本副本保留。修改前后摘要与唯一新增行见`periods-closeout-20261106/test-change.json`。
- P3清单路径：旧清单有257个哈希，实际258个跟踪文件，非NUL路径处理漏记未修改的`启动工作台.cmd`。新本地`periods-closeout-20261106/freeze-manifest.py`使用git -z路径协议，完整清单覆盖258项；中文文件SHA256为100e552deb91a1e30f86c62de022d1f5e8621171d0eed07d52e60a3c286934d3，与旧补验及HEAD/index/工作区相同。`pre-closeout/manifest.json`确认原257项均匹配；`final/manifest.json`记录收尾文档差异，旧manifest不改写。启动脚本与应用源码均未改。
- 同一原命令`node scripts/test-isolated.mjs --unit cloud-periods`在等待修正后顺序执行两次，均退出0、各16项通过；证据分别为`periods-review-wZoS6J`、`periods-review-RPkwJQ`，命令日志在`periods-closeout-20261106/run-1.log`与`run-2.log`。每次完成并确认清理后才启动下一次；只验证原范围及重复运行，不新增请求计数或其他业务测试。
- Periods.tsx SHA256在独立验收、P3修正及收尾后始终为2cd196bbc0c72ea6c8cc41fbb22a59e1c8a135da0b65ef6a5111b94de583fd85；本批应用独立验收结论保持。当前文档分别记录作者自测、独立16/19项及收尾两次16项；原审查者的工具/文档短复核PASS记录于同一本地收尾目录closeout-review.md，不扩展为第三轮完整审计。应用未变，未重跑无关类型/全系统测试；重新generate/check、diff检查和repo:check作为收尾核对。

**五份根文档复核：** GPT_CONTEXT更新云接续摘要；CONTEXT全文复核，业务术语无变化，正文不改；PRODUCT_REQUIREMENTS仅同步最新云端开发约束，业务需求不改；SYSTEM_ARCHITECTURE整合实际查询刷新关系；DEVELOPMENT_PROGRESS替换当前环境基线、冗余候选状态及限定验证边界。旧Mac独立验收只保留原适用范围，不重写其历史结果。

**清理与交付：** 作者初验三轮、独立审查三轮及P3收尾两轮的专属后端、代理和Chromium主进程均退出；清理证据分别保存。收尾两处临时根已删除，6个专属端口均关闭且无活动进程引用对应根；前两阶段各三根/9端口也已核对清理。Chromium部分退出子进程为容器PID1所属Z僵尸，无监听和运行任务，需由宿主回收，未尝试操作PID1。没有启动18889日常/开发自启服务，原有云环境development目录及历史构建/证据保留。用例与脱敏证据仅保留当前云环境，不上传。验收及P3收尾结束时全部源码/文档已保存，未暂存/提交/推送/部署；随后用户明确要求每轮验收后提交并推送GitHub，并确认本批执行。提交前已核对远端main仍为4869a7e、原最终补丁和258项哈希完全匹配，应用哈希不变；仅在本批原11个文件内最小同步授权/提交前状态并刷新索引。云克隆现有pre-commit/pre-push缺执行权限，执行时临时赋予执行权限以运行原钩子，完成后恢复原权限，不提交钩子模式、不改Git安全配置。只精确暂存本批源码/文档，原测试及证据仍忽略；正常提交一次并推送main，完整SHA、远端核对和CI结果由实际执行回报记录，本文写于提交前，不预记成功；日常运行和真实业务验收未执行。本批应用限定独立验收通过、P3工具修正及两次收尾复验完成，其他缺口仍沿原PROJECT_PLAN；建议提交标题`refactor(periods): 删除未消费文件查询并同步云端验证状态`。

## 2026-11-05～06｜GOV-02 / GOV-13｜流程配置版本治理、新建与在办安全应用

**目标、依据与范围：** 用户要求在已有个人工作台上优化可配置流程；接续只读方案及outputs/workflow-config-independent-prep-20261105/report.md，第一段包括草稿/发布治理、新建复制、版本化创建、停用恢复。第一段经outputs/workflow-link-ui-independent-20261106/report.txt限定独立通过后，继续第二段在办范围预览与显式应用。开工时main/db6984f保留既有未提交关联/P2修复；250项开工源文件及哈希保存在本机baseline，不暂存、提交、推送、发布或操作真实业务。读AGENTS、五份根文档、指南与正式队列；checkout无可用.agents/skills及已定位的本机记忆摘要，以源码和正式证据为准，不新建代理。

**代码文件与前后变化：**

- 新增未跟踪packages/server/src/db/migrations/041_workflow_config.sql、domain/workflow-config.ts、workflow-config-types.ts、api/routes-workflow-config.ts。由直接修改规范表改为整套草稿revision/base校验、不可变版本、显式发布指针、原子兼容投影和operation_id重试。新增/复制只取配置引用，稳定阶段/材料/影像保留旧ID；旧值异常不猜修。材料用途明确为external/reference/generated，legacy仅旧类型兼容。停用只限制新建。
- core/bootstrap.ts、cli/upgrade-business.ts：完整seed之后一次性建旧配置兼容基线；index.ts注册路由。api/routes-core.ts、routes-work.ts封闭旧规范写入口及新建隐藏覆盖，旧SQL/种子写投影也受保护；routes-template.ts在任何文件删除前拒绝被版本引用的模板永久删除。
- domain/service.ts：创建事务核对明确发布版本与可用性，保存实际阶段/规则/模板选择和来源；失败仅回收该请求新建空目录。新实例明确空模板不走实时类型回退，旧来源未知保持兼容；版本化实例旧instantiate拒绝追加最新阶段。domain/periods.ts：结构化材料key/用途与模板映射，周期实例快照及模板指纹，显式改已有规则清除其精确配置来源。domain/generate.ts、api/routes-generate.ts在生成和字段读取中校验实际工作/阶段/期次绑定及模板指纹，不依赖最新类型模板池覆盖旧实例。
- packages/web/src/api.ts、components/WorkTypeEditor.tsx、pages/Process.tsx：新增复制草稿、完整编辑、保存/差异发布、版本记录、停用恢复、修订冲突比较与明确采用，复用NavigationGuard和同步锁；保存/发布期间禁止重复操作及离开。pages/Workbench.tsx从发布版创建，不再隐式覆盖默认周期，显式刷新可用配置保留输入；停用类型仍参与旧工作分类但不参与新建。1280×720检查后让类型长名称换行。
- 正式文档：五份根文档分别整合接续、术语、PR-12、041结构/兼容边界及验证状态；USER_GUIDE提供候选操作，DEVELOPMENT 3.5提供本机专项和准确人工页面复现/清理步骤；PROJECT_PLAN继续GOV-02/13两段安排，QUALITY区分第一段自测与待独立验收。本日志原关联任务合入已收到的最终独立结论。knowledge-index.json、source-inventory.json由生成器刷新。README及无新风险事实的风险表不改。
- 本机测试/证据：新增workflow-config-phase1.ts和workflow-config-fresh.ts及本轮outputs目录，不共享上传；通用运行器沿原根入口。DTO最终放server/src纯类型文件，避免新增不在共享策略内的目录或依赖。

**实际验证与中断恢复：**

1. `npm run typecheck`最终server/web通过（typecheck-final.log）；`npm --workspace @workbench/web run build -- --outDir <本轮隔离根>/web`最终77模块通过（build-final.log），不覆盖日常dist。
2. `WORKFLOW_CONFIG_HOLD=1 node scripts/test-isolated.mjs --unit workflow-config-phase1`最终run-krOjrT：15组API通过。覆盖040升级旧来源NULL/原快照、草稿隔离、旧API与SQL守卫、明确空模板及版本绑定、只读GET、7个发布触发器故障点逐表回滚/重试幂等、版本不可变/并发409、新建失败DB与空目录回滚、复制/停用、结构化材料、模板文件与变量配置指纹变化/缺失/归档/删除保护、重启不误发布。错误注入是真实SQLite触发器及HTTP，不调用模型。
3. `node scripts/test-isolated.mjs --unit workflow-config-fresh`最终fresh-Pbadd9：全新库18个种子类型、软件4阶段完整基线、未发布复制草稿重启后仍未发布，passed=true。旧fresh-NN8kmR和run-BT99Ie已有通过，连接中断不补造未知退出；11月6日重新核对其cleanup确认退出0及根不存在，未落地的最后批补丁按实际差异补回。
4. 实际GPT内置浏览器与本轮代理：11项UI检查通过，ui-checks.json、ui-state-assertions.json及截图保存。覆盖继续/保存并离开、双窗口409输入保留/差异/保留本页、503重试、慢保存/发布双击各仅一请求、忙碌离开/关闭互斥、新增发布前隔离、创建期间新版本冲突后刷新重试、停用/恢复不隐藏旧工作分类及详情、复制后阶段新增/排序/发布。SQLite确认新工作绑定v2/明确空模板，复制阶段顺序正确；既有工作/阶段/期次/材料/成果等行前后逐行相同（ui-business-integrity.json）。这是工具实测，不是自动UI回放脚本；未声称全流程全套测试通过。
5. 初次沙箱监听EPERM，经正式升级审批执行隔离测试；早期用例先发现instantiate覆盖未转交、期望错误码与实际500不符等问题，修正并复验，失败日志保留。页面一次宽泛工作名称定位器匹配两项，未填入/提交；改为实际唯一标签后完成。没有绕过审批、锁屏或生产请求保护。
6. cleanup-final.json核对8个有清理记录的运行均backendExit=0、临时根不存在；本轮49872/49913/50005及旧记录端口均ECONNREFUSED，18889关闭，无本轮测试/代理进程。两个自建页面已关闭，未停止其他服务；初次EPERM日志未记录根路径，按日志时间定向核对未发现匹配临时根，不扫删其他目录。证据保留。文档generate/check、repo:check及git diff --check按最终文件执行，结果保存本轮日志。

**独立验收与共享模板定向修复：** outputs/workflow-config-independent-20261106/report.txt发现两项成果共用模板时后项覆盖前项materialId/required，选备B生成即可错误完成；先以`MAPPING_EXPECT_BUG=1 node scripts/test-isolated.mjs --unit workflow-material-mapping`复现，run-0i5ula退出0只证明缺陷存在。定向修改domain/periods.ts、generate.ts、versions.ts、api/routes-generate.ts与前端Periods.tsx、GenerateModal.tsx、WorkDocuments.tsx：保留全部稳定key映射，明确本次生成目标，按材料关联分开版本链与完成检查；增加逐项成果显示及明确绑定，复用原expected并发保护。不禁止共用模板、不按名称自动满足、不改旧快照/定稿，无新增迁移。

`WORKFLOW_CONFIG_HOLD=1 node scripts/test-isolated.mjs --unit workflow-material-mapping`在run-vLKFFf通过16组（原15组及7个映射场景）；mapping-results.json保存必备/选备、顺序交换、两个必备、不同模板、旧有损快照只读、旧无结构兼容及无模板必备断言。最终类型检查和77模块隔离构建通过。GPT内置浏览器实测未选目标禁存、生成B后A缺失且API不可完成、生成A后分别绑定并可完成但状态仍open、已有成果明确绑定只更新所选行及最终构建刷新。ui-B-only-api.json、ui-final-api.json、ui-state-assertions.json及截图保留；这是页面自测，不是独立复验或自动UI套件。新增本机workflow-material-mapping.ts不上传。

定向补丁相对上一冻结257项候选生成，全部原改动保留；本机outputs/workflow-material-fix-20261106保留修前/修后证据、仅此修复incremental.patch、changed-files.json、新frozen-manifest.json和清理记录。本轮两个隔离运行退出0、临时根删除，专属50381及18889未监听，自建页面关闭，未停其他服务。初次文档批量编辑脚本编码解析失败、未执行任何替换，改用明确Unicode转义后完成；早期前端类型缺字段已补齐，最终server/web检查通过，不将中间失败记为通过。

**新增关联UI保护定向收尾：** outputs/workflow-material-independent-20261106/report.txt已独立关闭共享模板身份/必备/历史保护阻断（含原15+7及同名、跨期补测），另复现新增关联请求busy未注册导航保护、503后选择回退。仅改WorkDocuments.tsx：关联选择、原expected快照和错误保存在本页缓冲；独立ref锁和busy防重复提交，接入现有NavigationGuard。慢请求不能离开/放弃；失败保留选择并明确重试/放弃，保存并离开必须成功；成功清缓冲并刷新。没有改后端身份/完成/历史规则，不新增清空关联能力，空选项仍无写入。

`node scripts/test-isolated.mjs --unit workflow-link-ui`构建77模块并通过3组关键API（必备独立、期次不自动完成、旧expected冲突全表不变），新本机用例与专属proxy仅留本地。run-atbEHW在50734/50746用GPT内置浏览器验证11项：新关联/更改503保留、双击重试仅1条hold、首页/切期/浏览器返回等待保护、禁用放弃、关闭离开提示仍保留在途、成功解锁、保存并离开失败留页/恢复成功、明确放弃/不保存离开不写入、空选项不清空。ui-checks.json、DOM/截图、proxy-events.log及状态快照可复核，不是自动UI脚本。75张表前后仅2条材料行与新增3条workflow_event变化；artifact、全部期次及阶段行不变。最终typecheck通过；原15+7已有独立通过且后端未变，不无谓重跑全套。

本轮证据与仅此次补丁位于outputs/workflow-link-ui-fix-20261106；258项开工哈希全部一致，原修改保留。自建页4、代理38293及runner48310受控关闭并退出0；临时根删除，50734/50746/18889未监听，未停其他进程。正式文档更新关联状态、使用和复现说明；PRODUCT_REQUIREMENTS既有失败保留/互斥要求及CONTEXT术语未变，全文复核后不改正文。当时候选重新冻结待关联UI独立复验；随后该项独立通过，再进入下述第二段。

**第二段安全应用：** 259项已验收文件保存为outputs/workflow-config-stage2-20261106/baseline-manifest.json及baseline副本。新增042_workflow_application.sql、domain/workflow-application.ts、components/WorkflowApplication.tsx；修改routes-workflow-config.ts、service.ts、periods.ts、core/checklist.ts、web/api.ts、WorkflowPanels.tsx及Workbench.tsx。只读比较当前发布版本与实际实例，所选范围事务内重新校验摘要/版本/状态，operation_id重试不重复；顺序组合冲突拒绝。新增阶段pending并保存独立规则快照；既有显示信息固定目录，文书要求保留原确认并加强安全守卫。未来规则独立生效，不即时补期；syncPeriods按日期选规则，旧期次不改，相同规则不重复安排。进度沿原门槛，不重写既有影像计数和完成时间。原未提交内容保留，无真实库/文件操作。

本机新增workflow-config-application.ts；phase1合成040过滤改为编号小于041，避免042提前执行。WORKFLOW_CONFIG_HOLD=1 node scripts/test-isolated.mjs --unit workflow-config-application最终run-SrpPTO通过15组，构建78模块：全表只读、安全/拒绝、过期/幂等、阶段/清单/进度/事件及原文书确认故障回滚、旧定稿字节/快照、未来边界/共用模板、重启和同规则拒绝重复。node scripts/test-isolated.mjs --unit workflow-config-phase1在run-Urxklz通过15组；workflow-material-mapping在run-Q8N6V8通过原15组加7个映射场景。最终npm run typecheck通过，不代替缺失的全套测试。

实际内置浏览器run-uWJCrh覆盖慢预览锁、503保留、真实409重新预览并确认、慢应用双击单请求、在途取消/离开锁、pending/部分来源/成功解锁、脏选择返回及明确放弃。首次返回遇同地址历史未切换，未算通过；重新建立列表→工作历史后返回保护通过。run-SrpPTO补验未来期必填、明确2029-01应用不补期、原阶段文书慢确认/双击/导航锁及成功解锁。首轮全表仅新增阶段/两清单/一次事件及测试注入摘要；最终全表仅增未来规则一行和事件两行，已有工作/阶段/期次/材料/成果/版本不变。截图、代理日志和ui-final.json保留，不是无人值守UI套件。

用户要求停止本机操作时立即暂停；随后明确Mac原任务继续才恢复。70858核实退出0，旧29784/54714受控退出，不盲目重发补丁。ps总览被沙箱拒绝未重试，使用专属会话及端口核对；未停止他人服务。文档临时脚本编码/包装解析失败均未执行，明确UTF-8读取编译后完成维护。最终清理、仅第二段补丁、变更清单及冻结哈希在同目录。当时用户新增本地提交授权，待第二段独立通过并明确范围后执行；当时未暂存/提交/推送/发布，测试或证据不入库。最终提交见本任务收尾。

**旧文书指纹P2定向收尾：** 第二段独立报告outputs/workflow-stage2-independent-20261106/report.txt确认原15组、前段15+7、11项UI及清理，但旧确认入口接受发布后漂移模板，第二段因此未通过。用户明确“行，你先修改”。以263项冻结清单保存本机outputs/workflow-legacy-fingerprint-fix-20261106/baseline副本；run-WQki7l在原代码复现新入口拒绝而旧入口200写入漂移指纹/选备，先复现后修复。仅改domain/workflow-application.ts、service.ts：抽取同类型当前发布配置解析；已知来源旧入口读取发布文书快照、保留发布指纹与targetVersionId，事务内检查allowed/expected，提交前再次校验版本与模板；新入口在提交前同样复核实际所选引用，故障要求/进度/事件一起回滚。未知来源仍保留旧分支与原安全范围，不赋予虚假发布来源；无依据时拒绝。未改迁移、前端、历史定稿及原快照。

本机新用例workflow-legacy-fingerprint.ts最终12组通过；`FINGERPRINT_UI=1 node scripts/test-isolated.mjs --unit workflow-legacy-fingerprint`在run-xWljaR完成10组及隔离78模块构建后保留页面，补齐两项来源边界后`node scripts/test-isolated.mjs --unit workflow-legacy-fingerprint`最终12组通过。覆盖文件/字段映射/归档/缺失、新旧拒绝一致和逐表只读、预览后发布变化、事务中模板失效触发器完整回滚、进度故障、正常应用/重复旧预览拒绝、未知及阶段单独来源兼容。`npm run typecheck`通过；`node scripts/test-isolated.mjs --unit workflow-config-application`受影响15组及独立构建通过（run-gG98Hh），未无谓重跑未改的第一段。真实内置浏览器页8验证漂移禁用、健康预览后漂移确认拒绝且错误/预览保留、恢复并重预览后成功；失败前后76表不变，成功只更新目标文书要求和新增1条事件，原来源、快照、阶段状态及模板字节不变。ui-integrity首次比较遇到SQLite空原型对象与JSON普通对象的测试断言差异，没有写入或停止服务；统一JSON对象后断言通过，不是业务数据差异。页面已关闭，runner退出0，独立根/随机端口已清理，未恢复18889；精确命令、补丁、哈希和清理在本轮本机report.txt。

指纹P2修复随后获outputs/workflow-fingerprint-independent-20261106/report.txt独立通过，两阶段限定验收完成。拆分候选的三类实际UI链路已独立通过：Periods成果关联503保留、慢请求互斥和逐表/文件保护；Workbench配置预览与安全应用、详情只读及显式核对；发布配置到新建工作采用同一发布版本。删除记录链接引用后的页面加载与导航正常。拆分精确候选另通过类型、隔离构建、映射16组、第二段15组、指纹12组及关联3组；内容一致性支持复用原限定证据，没有重跑未受影响的完整UI或同步故障矩阵。

**文档状态收尾与交付：** 流程配置第一、第二阶段及共享模板、关联保护、旧文书指纹P2修复已通过既定范围独立验收；精确40文件已本地提交为053964ec3b87c9f0c2b4df493348a5da7edd0612，未推送、未发布。父提交为db6984ffb4e44c3fb3beb8b441165292adb1eafb；提交全部257份文件的内容/模式与受测精确候选一致，40文件改动排除设置并发、月度笔记保护和记录筛选/链接。代码提交时原264项冻结文件保持，索引为空，另有22项工作区改动保留。独立报告及提交证明只留本机，不纳入Git。文档收尾以该代码提交为基点，逐块更新GPT_CONTEXT、DEVELOPMENT_PROGRESS、DEVELOPMENT指南、PROJECT_PLAN、QUALITY_AND_ACCEPTANCE及本任务日志，将待验/待提交改为限定通过/代码已提交；knowledge-index与source-inventory由生成器分别按提交候选和混合工作区刷新。CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE全文复核，术语、需求和结构没有新增变化，不改正文。文档增量与代码分开，实际提交结果以Git记录为准。文档generate/check、共享边界与差异检查通过；不重跑工程验收，不启动服务/浏览器/测试数据；产品代码及其他任务改动保留。

未执行完整npm test/typecheck:tests：缺scripts/test-isolation-contract.mjs、旧unit/workflow等用例/夹具及tsconfig.test.json。未执行Windows、真实库迁移、全部模板/执行器、Office版式、真实模型、完整响应式/压力/硬断电。模板以引用及指纹拒绝已观察到的变化，不是冻结历史二进制渲染；旧来源NULL保留旧动态兼容，不能宣称全部历史语义已冻结。两阶段、旧文书指纹P2及拆分三类UI已限定独立通过，代码已本地提交，未推送、未发布；跨进程文件压力仍未覆盖。未知来源或无法证明安全时拒绝应用；既有材料/影像清单不覆盖，未来安排不原位撤销/编辑，可安排更晚的不同规则。实际代码提交说明：`feat(workflow): 支持版本化流程配置与安全在办更新`。

## 2026-11-05｜GOV-13 / GOV-08｜工作关联记录视图与范围筛选

**目标、范围与基点：** 用户要求保留现有工作台，参考成熟工具的关系组织方式作最小增量。main/db6984f接续17份既有未提交文件；保留先前RK修复和本机测试，不提交、推送或发布。已读AGENTS、五份根文档、相关正式指南与队列；checkout无.agents/skills，未找到本机memory_summary.md，因此以当前源码/正式记录核实，不写全局记忆、不创建代理。不引入Grist依赖、合同模块、迁移或按工时/检查文本猜测项目关联。测试只用匿名隔离库和随机端口，不恢复用户预览。

**实体与最小验收：** 复用work_record.workbench_id和既有workbenchId API筛选；项目/行政工作详情提供有效记录入口，范围留在URL，默认全部兼容未关联记录；无效/删除范围明确提示，归档深链接可读，分页切换不串范围。查看、筛选、返回不推进业务状态，记录不等于完成事实。

**实际文件增量：**

- 新增未跟踪源码packages/web/src/components/WorkRecordLinks.tsx：最多5条有效记录摘要、总数及全部/单条可点击链接，空/加载/错误重试反馈。
- packages/web/src/pages/Workbench.tsx：详情头部后接入关联卡片，原阶段/期次入口保留。
- packages/web/src/pages/WorkRecords.tsx：URL workbenchId、工作选择、范围标题/返回链接、空/错误/删除/归档处理，切换工作重置其他筛选/页码；默认包括未关联记录，跨范围详情明确提示。新记录仍显式选关联，不隐式继承筛选。
- packages/server/src/domain/service.ts、api/routes-work.ts：独立检查指出getWorkbenchDetail隐含recalcProgress写入。新增默认兼容的refreshProgress参数，仅HTTP GET传false，展示存储业务状态；写入命令、生成/助手既有调用及POST recalc仍保持原行为。筛选名称/有效性改用现有只读分页工作列表，不依赖详情。单纯打开详情不再持久化修正因外部文件变化产生的进度偏差，边界写入架构和使用说明。
- GPT_CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS整合候选/只读边界/验收条件；USER_GUIDE新增候选操作说明；DEVELOPMENT新增本机重放、人工替代及清理方法；PROJECT_PLAN和QUALITY_AND_ACCEPTANCE整合现有GOV及新覆盖。DEVICE_HANDOFF、RISKS_AND_DECISIONS同步已有P3独立结果，本文补录原启动条目的停止结果。自动生成knowledge-index.json、source-inventory.json，docs/README生成后无增量。
- 新增本机忽略用例packages/server/test/record-links.ts、record-links-ui.mjs；outputs/record-links-20261105保存隔离配置、前态副本、增量diff、哈希、截图/DOM及结果，不共享、不上传。正式说明可随Git获取，测试资源须单独授权接续。

**验证与可复核证据：**

1. `npm run typecheck`最终源码通过；`node node_modules/typescript/bin/tsc -p outputs/record-links-20261105/tsconfig.json --noEmit`专项类型通过；`node --check packages/server/test/record-links-ui.mjs`通过。
2. `RECORD_LINKS_HOLD=1 node scripts/test-isolated.mjs --unit record-links`最终应用运行run-yBKYnI（54700）：独立Vite构建78模块、隔离身份、默认/未关联、范围、日期/未知、撤回、空/无效/删除关联API通过。cua_repl导入本次目录内与源模块逐字相同的replay.mjs副本执行7组真实页面回放，ui-results.json为passed=true；截图1280×720可见卡片与原阶段内容。此前两轮页面结果保留，不代替最终版。
3. 人为在匿名库设置progress=37、影像清单done_count=99及完成日期哨兵，GET工作列表/详情/记录，以及上述7组浏览、筛选、重载、返回前后，全部业务表逐行一致（readonly-api.json和readonly-after-ui.json）。补充显式写入验证后，`node scripts/test-isolated.mjs --unit record-links`运行run-DqPuS2（54775），构建/API/只读断言及POST recalc确实重算写回通过（explicit-recalc.json）；此API-only轮没有执行页面，不能据退出0声称重跑UI。
4. 初次普通沙箱绑定端口EPERM，经正式require_escalated路径获准后执行；一次新增测试夹具列名误写name导致失败，改为实际title后通过，失败证据保留。浏览器模块带查询串导入不受支持、未执行；随后导入逐字副本成功。无未决审批或结果不明操作。
5. 两次最终运行器均退出0，后端exitCode=0；所有本轮已创建服务均停止，自有浏览器页关闭。cleanup-check.json核对四个有UI元数据的运行端口均ECONNREFUSED、临时根均不存在；进程定向查询无本轮服务，18889仍关闭，未停他人服务。证据目录保留。
6. 文档generate/check、repo:check和git diff --check通过；静态索引217个源码、282个路由声明、40个迁移，251个共享文件检查无问题。默认npm test、npm run typecheck:tests未执行：缺scripts/test-isolation-contract.mjs、旧全套用例/夹具及tsconfig.test.json。专项不是全套通过。

**五份根文档复核：** GPT_CONTEXT更新候选及P3接续；CONTEXT全文复核，无新术语不改；PRODUCT_REQUIREMENTS更新PR-13/SC-02范围验收；SYSTEM_ARCHITECTURE更新显式关联投影与详情GET只读；DEVELOPMENT_PROGRESS更新能力、限定证据、P3已复核和预览已停止。原17份差异保留，原5份应用/隔离工具修复文件哈希与P3独立基线相同。

**独立未通过后的P2同任务修复：** 已读取outputs/record-links-independent-20261105/report.txt及真实图片复现。独立结果为不通过：移除详情GET隐含重算后恢复影像仍为0，且外部文件变化没有可发现的核对入口；原七组回放跨范围链接两次不稳定，一轮未定位表差异不能事后改写为通过。用户要求继续修复而非发布。

- core/trash.ts在成功恢复工作/阶段/文件后同步关联工作；domain/versions.ts在markFinal成功后同步，包括取消定稿；既有上传、软删和附件关联修改已在store同步，未改计算口径。routes-work.ts的显式recalc拒绝不存在/已删除工作。Workbench.tsx新增可发现的核对按钮和更新范围说明，引用锁拒绝重复请求，busy接入NavigationGuard，失败留输入并可重试。GET继续只读，不推进阶段/期次或重写历史定稿。
- 本机record-links-p2.ts复用独立复现的真实multipart合成PNG，将恢复断言改为1；验证外部移动/恢复需显式重算、定稿/取消定稿，保存保护状态。record-links-ui.mjs在跨范围提示之后等待范围列表加载完成并读取当前DOM，再点击旧记录入口；这是对异步列表展开与目标布局变化的等待修复，不据此断言已定位独立首轮未知表差异。record-links.ts新增table-differences.json，失败时保存逐表前后内容，页面失败保存DOM/截图。
- 应用最终`npm run typecheck`通过；`node node_modules/typescript/bin/tsc -p outputs/record-links-p2-20261105/tsconfig.json --noEmit`及页面脚本node --check通过。首次P2运行run-xrANNw的构建/API通过后Mac环境断开，浏览器打开结果当时不确定，未作页面通过。恢复连接后确认56768/56795进程及监听均无，写其专属停止标记并按原隔离根标记/路径守卫清理遗留根，关闭此前实际创建的测试页；interruption-cleanup.json保留中断事实。
- `RECORD_LINKS_HOLD=1 node scripts/test-isolated.mjs --unit record-links-p2`重建run-hcxKug：78模块构建及API通过；真实页面完成外部图片移走后刷新仍保留旧值、显式核对变0、恢复图片后503失败提示、重试慢请求按钮禁用、离开弹窗放弃/保存禁用、释放后变1。proxy-events.log有一次fail和一次hold，ui-p2.json、missing/failed/busy-page.txt、rechecked.jpg保留结果。初次页面立即读DOM遇加载态、把无href标题误当link的定位错误已按当前DOM改为等待和侧栏按钮，未归为应用缺陷。运行器退出0，阶段/期次/定稿字段及哈希前后一致。
- `node scripts/test-isolated.mjs --unit record-links-p2`补强run-v4x7mP：定稿→取消→重新定稿后再显式核对，已有定稿标记/时间/哈希不变，未完成阶段工作progress仍0，API及构建通过；此轮没有重跑页面。
- 完全相同命令`RECORD_LINKS_HOLD=1 node scripts/test-isolated.mjs --unit record-links`连续run-Qh2wRS与run-ibjiws，均独立构建/API、同一个脚本7组真实页面回放通过，逐表差异均[]，外层退出0。没有用人工替代动作将脚本失败涂改成通过。
- 五份根文档再次全文复核：GPT_CONTEXT/DEVELOPMENT_PROGRESS改为独立曾不通过、修复待复验；PRODUCT_REQUIREMENTS补恢复计数和显式核对验收；SYSTEM_ARCHITECTURE补写入同步与按钮保护；CONTEXT无新术语不改。USER_GUIDE提供可执行的核对操作及与刷新区别，DEVELOPMENT记录P2本机用例/人工步骤及脚本等待/诊断，现有GOV-13与质量矩阵同步，未增加平行队列。文档/索引、共享边界和diff检查再次执行。
- cleanup-final.json核对四轮正常后端退出0、临时根不存在，57475/58023/57898/57958及代理57710、旧56768/56795、预览18889均ECONNREFUSED。没有匹配测试/代理进程，自有测试页关闭；旧用户预览页未操作，服务未恢复。中断轮没有补造正常退出码。证据保留，未动他人服务。

**同步失败原子性收尾：** 读取outputs/record-links-p2-independent-20261105/report.txt及independent-extra.json。独立确认正常计数/绑定目录恢复/定稿门槛通过，但新增同步失败时主动作已提交，接口整体失败；UI因锁屏未完成。本轮只修该边界，不实施后续流程配置。

- 先以本机record-sync-atomic.ts运行根隔离入口，run-HNOfKg复现artifact恢复接口400但全表变化，外层断言失败退出1；证据restore-artifact-progress.json记录unchanged=false。该轮后端正常退出、隔离根清理，不改写成通过。
- core/trash.ts将restoreFromTrashInner和syncEvidence共同包入现有tx保存点，包含恢复索引和嵌套写入；提交后才刷新允许根。domain/versions.ts将markFinalInner、版本/定稿/来源审查与syncEvidence共同事务；原schema初始化留在事务外防缓存与回滚不一致。核查两条主动作不修改磁盘文件，仅读取/检查，无不可回滚文件写入需补偿。没有吞同步异常或返回假成功。
- 最终`npm run typecheck`通过；`node scripts/test-isolated.mjs --unit record-sync-atomic`运行run-eK8eiz，78模块构建、继承正常API及10组故障通过：恢复3类×清单/进度两点、定稿/取消×两点。每次失败400、全部业务表及原文件字节不变；去故障重试200。成功后重复恢复400且状态不变、同值定稿200 changed=false且状态不变。正常阶段/工作/绑定目录恢复、非空期次/历史定稿保护、80→100→80门槛通过。用例类型检查和文档/仓库/diff检查通过。cleanup.json确认60812/60832均ECONNREFUSED、两轮临时根已删除、后端exitCode=0，无匹配测试进程，18889仍关闭；复现轮外层失败仍单独保留。
- 五份根文档全文复核：GPT_CONTEXT/DEVELOPMENT_PROGRESS区分正常路径独立通过、事务修复自测与UI未验；PRODUCT_REQUIREMENTS补共同成功/回滚；SYSTEM_ARCHITECTURE补事务/文件只读和schema边界；CONTEXT无变化。USER_GUIDE说明明确失败后重试及网络未知需先核对；DEVELOPMENT 3.4给出故障验证；现有队列/质量矩阵更新，索引生成，不开新任务队列。
- 本轮只调用一次cua.getState，仍明确报告Mac锁屏、自动解锁不可用；未开测试页面或继续点击，最新UI保持待验，最小所需用户操作为手动解锁Mac。此前实施UI通过与最新独立锁屏失败分别保留，不用旧结果替代此次验证。无权限绕过或未决审批。

**限制与交付：** 本地文件已保存；未暂存、提交、推送、发布；P2正常路径独立通过后的同步失败原子性已完成限定修复自测，冻结候选待独立复验；UI待解锁，未完成真实业务验收。工作/阶段整体恢复与绑定外部根、完整模板定稿链仅静态检查，未声称这些路径均实跑；P2页面为真实手动工具操作及断言，不是新增无人值守UI套件。未验证完整响应式矩阵、所有表单更正/新建路径、跨窗口工作删改后的实时刷新、真实模型/数据及Office；归档深链接可读但筛选选项仍以在用工作为主。新筛选不提供“仅未关联”专用选项，默认全部可见未关联。后续已读取outputs/record-sync-atomic-independent-20261105/report.txt及outputs/record-links-ui-final-20261105/report.txt：10组后端故障、最终核对按钮/503/双击/离开互斥、两轮7组关联回放独立通过，逐表差异为空、254项冻结哈希/Git/HEAD不变，服务及页面清理完成。该任务限定独立验收已通过，保留早前失败和锁屏未执行历史；当前接续流程配置按GOV-02/13管理。建议提交说明：`feat(records): 增加工作关联入口和范围筛选并保持浏览只读`。

## 2026-11-05｜GOV-11｜Mac独立空白工作台启动

**目标与依据：** 用户要求在已连接Mac运行工作台。读取AGENTS、安装和开发指南及启动脚本；checkout无.agents/skills。核对默认服务端口、项目旧布局和默认日常根，未发现可复用服务或正式数据库、模板及发布指针。保护此前未提交改动，不处理另一项目。

**实施与文件：** 使用WORKBENCH_DEV_HOME指向本次新建的源码外临时根，执行`npm run dev:monthly -- --build`，端口18889；没有seed-handoff，不导入样例或真实资料。独立构建77个模块成功，新空库正常初始化为development。仅DEVELOPMENT_PROGRESS更新环境状态；本文记录启动过程，docs/knowledge-index.json随文档生成刷新，业务源码与凭据不变。启动元数据、日志、HTTP核对和首页截图仅保留本机临时根，不进入共享仓库。

**验证与边界：** HTTP首页和/api/health均200，status=ok、runtimeProfile=development、webBuilt=true；只读SQL核对template/workbench/artifact数量均0。实际可见浏览器首页为0项在办、0项待处理、暂无成果，启动时页面作为用户交付保留；后端与启动器当时按用户请求继续运行。用户随后撤回启动需求，核对归属后经正常升级审批发送SIGTERM停止本次6457/6468/6471，确认18889无监听，数据与日志保留。11月5日关联视图收尾再次只读核对18889为ECONNREFUSED，未恢复预览。未操作业务按钮、模型、付费调用或真实数据；空白预览不具备原77份模板和历史业务，不是Windows日常版，临时根不可当作正式资料存储。没有执行被拒绝、待批准或结果不明的启动动作。

**五份文档复核与交付：** 沿用已通读的当前五份根文档，当前任务只改变运行环境状态，已整合到DEVELOPMENT_PROGRESS；GPT_CONTEXT入口、CONTEXT术语、PRODUCT_REQUIREMENTS需求及SYSTEM_ARCHITECTURE结构无变化。仅本地保存，未暂存、提交、推送或发布；启动不等于完整功能或业务验收。建议提交说明：`docs(runtime): 记录Mac空白预览启动与数据边界`。日常资料迁移和模板接续仍须单独处理。

## 2026-11-05｜GOV-13 / GOV-11｜月度说明切期保护与设置跨窗口冲突修复

**授权与基点：** 用户解除暂停，授权接续未完成事项；父任务限定本线程写WorkBench，先复现RK-11/RK-12再最小修复，不处理其他项目。main/db6984ffb4e44c3fb3beb8b441165292adb1eafb开工工作区干净，本地origin/main差异0/0；实时git ls-remote因github.com域名解析失败，未确认远端最新值。旧线程已只读收敛，本轮未启动其他代理。只使用匿名临时数据库和随机本机端口，未读写真实业务、日常配置/发布指针、调用模型或修改权限。

**实际增量：**

- packages/server/src/api/routes-core.ts：原逐项覆盖改为对app.org/app.operator/ai.writing_style的完整_expected原值快照进行事务内比较；缺快照428、格式错误400、冲突409附最新三字段值，整请求不写；其他设置保留原扁平调用，不新增表或迁移。
- packages/web/src/pages/Settings.tsx：保存发送成功基线；冲突保留输入并展示当前值/本页值，用户明确保留自己的改动后更新未改字段，或放弃本页改动采用最新值。普通保存与离开保存继续共用互斥；人工核对后再保存仍重新校验。
- packages/web/src/pages/Periods.tsx：月度说明注册NavigationGuard，共用内容、成功基线及保存函数，保存期间锁定输入并阻止离开，失败不清基线；成功刷新期次和成果状态。WorkDocuments调用同一保存路径，不改变期次/检查事实或报送边界。
- scripts/test-isolated.mjs、packages/server/src/core/test-isolation.ts：仅把操作系统临时父目录规范为真实路径，解决Mac /var别名阻断；仍保留专属根标记、目录内链接拒绝、越界及重叠保护。
- GPT_CONTEXT.md、DEVELOPMENT_PROGRESS.md：替换暂停/两项未修结论，区分当前Mac未提交候选、旧机发布历史、旧全套测试缺失及限定通过。
- PRODUCT_REQUIREMENTS.md：将当前任务要求明确为月度切期输入保护与三个设置字段的跨窗口冲突验收；CONTEXT.md全文复核，业务术语未变，正文不改。
- SYSTEM_ARCHITECTURE.md：整合_expected事务协议、前端冲突处理、月度统一保存及Mac临时路径规则。
- docs/management/PROJECT_PLAN.md、RISKS_AND_DECISIONS.md、QUALITY_AND_ACCEPTANCE.md：同步GOV-13、两项缺陷和覆盖矩阵为限定回归通过、待独立复核，保留历史失败与其他未验收项，不新建队列。
- docs/guides/DEVICE_HANDOFF.md、DEVELOPMENT.md：同步实际Mac源码/测试接续边界和测试临时目录规则。
- 新增仅本机packages/server/test/rk-repair.ts、rk-isolation.ts及outputs/rk-repair-20261105内类型配置、复现/回归日志、截图和DOM证据；由.gitignore排除，不共享、不上传。已有mac-compatibility.ts未修改。
- 自动生成docs/knowledge-index.json、docs/reference/source-inventory.json；docs/README.md生成后无差异。

**复现与验证：**

1. 首次隔离入口被沙箱拒绝监听本机端口；授权执行后复现/var符号链接保护错误。规范系统临时父目录后可正常运行，未关闭任何路径守卫。无自动审批拒绝遗留。
2. `RK_MODE=before RK_HOLD=1 node scripts/test-isolated.mjs --unit rk-repair`：真实HTTP复现B旧快照覆盖A设置；实际浏览器复现A未保存说明切B无提示、切回丢失。只改验证基础设施后取修复前证据，不以源码推测替代复现。
3. `RK_MODE=after RK_HOLD=1 node scripts/test-isolated.mjs --unit rk-repair`：构建、隔离身份及7组API通过；涵盖同/不同字段旧值、重试、同时请求一成一冲突、缺失/错误快照、其他设置兼容、混合请求原子拒绝。
4. 实际浏览器对月度继续/放弃/保存并离开、A/B归属、反复切换、慢保存锁定、普通及离开保存失败重试通过；设置两个独立页面同/不同字段冲突、人工核对/明确放弃、普通及离开保存、同页互斥和503失败重试通过。匿名故障由测试代理产生；具体步骤见本机ui-report.md，未运行真实模型。
5. `node scripts/test-isolated.mjs --unit rk-isolation`：系统临时根、根内链接拒绝、越界拒绝、重叠拒绝4项通过。`node scripts/test-isolated.mjs --unit mac-compatibility`：已有Mac启动/静态资源/项目/记录冲突/文件下载/其他设置/目录响应/软删恢复/重启持久化9组通过。
6. 最终补回月度成功后的状态刷新后，`npm run typecheck`通过；`RK_MODE=final RK_HOLD=1 node scripts/test-isolated.mjs --unit rk-repair`内独立Vite构建、隔离身份及7组API重跑通过。最终浏览器重验月度保存刷新、A/B反复切换、失败保留/重试和设置跨页面冲突/核对保存通过。`node outputs/rk-repair-20261105/verify-final.mjs`确认最终HTTP持久化值与B期不串写。Mac9组的运行在最后月度刷新修正前，不作为该修正的验证替代。
7. `node node_modules/typescript/bin/tsc -p outputs/rk-repair-20261105/tsconfig.json --noEmit`：新增两份测试类型检查通过；首次测试HTTP解析值unknown报错仅补类型注解后复验。默认npm test与typecheck:tests未执行，缺旧隔离契约脚本、旧全套用例/夹具及原tsconfig.test.json，不能记成通过。
8. `node scripts/docs-maintenance.mjs generate`、`node scripts/docs-maintenance.mjs check`及`git diff --check`通过；索引为24份文档、216个源码文件、282个静态路由声明、40个迁移，不是运行/API完整验收。`npm run repo:check`通过，检查250个共享文件，problems为空。

**独立验收与同任务收尾：** 父任务的本机`outputs/rk-independent-20261105/report.txt`确认最终应用功能、类型/构建、7组API、4项路径、9组Mac冒烟和限定实际页面验收通过，无阻断应用源码缺陷；报告发现P3：固定目录旧after-done/final-done令同名页面验收立即退出，并指出页面交互尚无可重放脚本。依父任务明确指令，仅修测试和文档；原17份跟踪差异全部保留，5个应用/通用工具文件哈希与收尾前一致，没有扩大业务改动。

- 仅本机`packages/server/test/rk-repair.ts`改为每次mkdtemp独立runs目录，mode仅作安全标签；各自持有control/held/ui/done、日志和cleanup.json。旧固定目录及标记不删除、不改写；输出RK_RUN_DIR供当前操作者取址，不设会被并发覆盖的latest指针。HOLD超时非零失败，不把等待结束当页面通过。
- 新增仅本机`packages/server/test/rk-ui-replay.mjs`：复用现有cua_repl工具，无新增依赖；三组持久化动作及断言覆盖月度切期取消/503保留/重试与归属、双页面设置冲突及核对保存、慢保存互斥。ui-results.json记录执行结果，关键DOM和截图归属本次目录。普通API入口仍不自动执行页面检查，也不是裸Node或CI浏览器测试。
- 完全相同命令`RK_MODE=final RK_HOLD=1 node scripts/test-isolated.mjs --unit rk-repair`连续运行两次，目录分别为runs/final-oDfzia与runs/final-78ObpQ。每次独立Vite构建和7组API通过，再经浏览器工具调用同一模块的openReplay、monthly、conflict、busy、finish；两次均3组通过并自动关闭各自两页，写自己的done。两个运行器退出0、后端exitCode=0、代理关闭、临时根不存在，四个端口实际ECONNREFUSED。第二次运行时第一轮done及旧final-done均保留，仍能完成全部页面检查；原控制/停止/元数据5份文件哈希不变。详见outputs/rk-followup-20261105/repeat-results.json、closed-ports.json及两运行目录的结果/清理记录。
- 新增脚本`node --check packages/server/test/rk-ui-replay.mjs`通过；原本机专项类型配置检查通过。此次未修改应用源码，不重复原整套应用验收；相同启动命令自带构建和API重复是验证重跑要求的一部分。局部精确diff、文件哈希和证据保存在outputs/rk-followup-20261105，测试与证据仍由Git忽略。
- 正式开发指南3.1记录获取前提、独立run元数据、停止/故障控制、浏览器模块调用、人工验收条件和缺工具时的未执行边界；Git可获取正式说明，三份本机用例须按授权私下接续或重建，不把测试混入共享源码。GPT_CONTEXT、DEVELOPMENT_PROGRESS、GOV-13、风险表、质量矩阵和换机指南同步应用独立验收已通过、测试收尾待复核；需求与应用架构无本次增量，CONTEXT仍不改。文档生成/检查、共享边界和差异检查作为收尾验证。

**五份根文档复核：** GPT_CONTEXT更新接续与授权状态；CONTEXT无术语增量不改；PRODUCT_REQUIREMENTS补两项当前验收条件；SYSTEM_ARCHITECTURE更新实际协议与路径处理；DEVELOPMENT_PROGRESS重整当前机器、能力、验证及未完事项。均逐一全文核对，不保留旧暂停说明覆盖当前修复；测试收尾再次复核五份全文，需求/术语/应用架构无增量，正文保持，入口与进度按独立证据更新。

**交付及未完成：** 本地已保存；未暂存、提交、推送、发布或业务验收。测试后端和代理已由finally关闭，三个before/after/final运行器退出0并核对临时根不存在，浏览器测试页已关闭；未停止其他服务。应用限定独立验收已通过；后续独立报告outputs/rk-p3-independent-20261105/report.txt记录final-QJIbSC和final-AL4ZYy两次同名运行、各三组页面回放、隔离清理及原文件完整性通过，P3限定关闭。该报告在关联视图任务收尾时读取并同步到正式状态；旧全套测试资源仍缺，未测原生beforeunload、其他设置完整表单、全部月度模板生成、Windows/Office、真实模型与正式业务。设置采用值快照比较，不提供历史修订或ABA检测；旧页面写三个受保护字段须重新打开。按现有GOV队列接续。建议提交说明：`fix(workbench): 保护月度说明切期并拒绝设置跨窗口覆盖`。

## 2026-11-04｜GOV-11｜正式文档与跨电脑接续闭环

**授权与边界：** 用户确认尚未提交推送，明确要求补齐正式交接文件，供不同电脑上的Codex理解项目并接续。本次仅工作台项目文档；应用代码、业务规则、数据库、配置、发布指针均不修改，不调用模型，不启动应用或独立Codex修改任务。代码实施仍暂停。开工HEAD为main/086d2993980dffec4db62a3a1b14bf0e3e29c7ac，暂存区为空，原21份跟踪差异和WorkbenchSelect新文件保留；开始前另存文档副本与已跟踪文件/新组件哈希用于复核。

**盘点结论与修改：** 现有README、CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE已说明定位、术语、约束和架构，无需新建重复总览。此前覆盖矩阵与缺陷细节只在被忽略的本机报告；现将可共享事实整合到已有主记录，不复制原始测试、私人配置、截图或业务正文。

- GPT_CONTEXT.md：明确不依赖聊天的阅读路线、正式证据主记录、用户未提交推送及文档授权/代码暂停状态。
- DEVELOPMENT_PROGRESS.md：区分包版本0.1.0、Git候选与所选运行包；补daily/development/test运行定位，链接覆盖及问题主记录，保留已完成与未验收边界。
- docs/management/RISKS_AND_DECISIONS.md：RK-11设置双窗口覆盖、RK-12月度说明切期保护缺失的匿名复现、影响、代码入口、最小修复方向和关闭条件；两项均明确未修。
- docs/management/QUALITY_AND_ACCEPTANCE.md：正式四层覆盖矩阵，含回收站、月度说明、文件/附件和跨模块保存；区分历史证据、三批通过和收尾5通过/4失败，说明原生选文件、Office、真实模型、整数工时及真实业务验收未覆盖。
- docs/management/PROJECT_PLAN.md：在原GOV-11/GOV-13与后续顺序中整合两项缺陷、有限冗余清理建议及依赖，不建立新队列，不自动授权恢复实施。
- docs/guides/DEVICE_HANDOFF.md：补正式阅读闭环、新机Git/源码完整性检查、本机测试和证据缺失处理；明确WorkbenchSelect新文件需随引用方审查同步，不能只推送已跟踪文件。
- docs/guides/DEVELOPMENT.md：将共享边界整合进正文，说明测试目录、夹具及tsconfig.test.json不随Git；命令存在不等于资源齐备，纯文档任务不重跑应用测试。
- 本日志：单独记录正式文档交接任务；自动生成docs/README.md、docs/knowledge-index.json、docs/reference/source-inventory.json，仅实际有差异的文件列入交付。

**五份根文档复核：** GPT_CONTEXT和DEVELOPMENT_PROGRESS按上述事实更新；CONTEXT的对象术语、PRODUCT_REQUIREMENTS的已确认需求、SYSTEM_ARCHITECTURE的实际结构和运行语义无新增变化，保持全文。README及章程定位保持，不编造新目标、业务规则、预算或完成比例。

**验证：** 文档generate/check通过：24份文档、232处本地引用、216份源码、282处路由、40份迁移，0错误；仓库共享边界检查250文件通过，git diff --check通过。相对开工快照仅9份已跟踪文档/索引改变，应用源码哈希无变化，无新增重复二级标题；HEAD未变、暂存区为空。验证限定文档、仓库共享边界、Git跟踪与文件哈希，不运行应用测试。原始覆盖结论来自已有证据；本次文档自检不是独立功能复测。新增内容不包含个人数据或凭据，原证据仍按既定忽略规则留在本机。

**交付与接续：** 仅本地保存，由用户审查提交和推送；未暂存、提交、推送、发布或迁移数据。正式文档均在现有Git跟踪范围，不新增忽略目录中的必读文件，不放宽共享策略。用户同步后，新机重新核对自身分支、HEAD、文件和运行身份；不能把旧机测试/运行结论视为新机已验证。两项代码缺陷及Office、整数工时、真实模型和业务验收保持未解决；本次完成后停止写入，继续等待用户。建议提交说明：docs(handoff): 补齐验证边界与跨电脑接续依据。

## 2026-11-04｜GOV-13 / GOV-08 / GOV-11｜个人使用审查及三批保存恢复修复

**目标与边界：** 用户要求继续全面检查个人使用问题，经监督限定为设置并发保存、局部输入保护、附件关联恢复三批；随后限定核对月度说明、同文件重选、附件刷新与未知POST、设置双窗口及静态重复入口。用户最终要求本轮结束暂停、自行同步GitHub并换机；限定追加只做证据与文档，不启动第四批应用修复。仅本机源码、匿名隔离测试及文档。开始时main/086d2993980dffec4db62a3a1b14bf0e3e29c7ac已有17份跟踪修改及WorkbenchSelect新文件，全部保留。日常指针未改；11月4日监督健康探测连接被拒绝，执行者未启动日常服务、未读真实正文或数据库、未调用模型。

**修改清单与原因：** packages/web/src/pages/Settings.tsx将普通保存和保存并离开共用同步互斥及busy，成功后更新快照基线，失败继续抛给guard；Agent.tsx内部标签经过导航保护；WorkRecords.tsx更正弹窗建立进入时基线并保护关闭、取消、保存与修订冲突；Files.tsx上传选择/busy接入保护，明确放弃清理File及错误。packages/web/src/components/PeriodAttachments.tsx保留已知上传ID、先核对再仅重试关联，失败展示已保存文件，避免断服刷新父级卸载恢复信息。packages/server/src/api/routes-workflow.ts对携带expected的关联在事务内比较原关联、状态与要求，409保护并发变化，同文件已成功返回updated=false且不新增事件或降级verified；旧调用仍按原契约，不增加表/迁移。

**本机测试与证据：** outputs/full-review-20261104-XFyINJ保存初始源码/文档基线、各批独立基线、唯一审查报告和证据。新增仅本机settings-save-regression.ts、input-guards-regression.ts、attachment-recovery-regression.ts、project-create-regression.ts；审查观察器full-review-phase-one.ts及明确月份的full-review-seed.ts亦仅本机。修改本机type-navigation.ts，拒绝普通once创建时检查USE_WORK_RECORD和零新增，另验证合法周期行政与旧单次工作只读保留。未为旧用例放宽生产规则。

**验证：** 所有运行经scripts/test-isolated.mjs。第一批修复前1失败/4通过且非零退出，修复后5通过（settings-after-J100CH），监督独立5通过（settings-after-fvGR54）。第二批最终14通过（input-guards-LLQPOP），监督独立14通过（input-guards-sUenT8）；包括失败后同页取消、明确放弃、重开无隐形旧文件。第三批执行者附件6通过（attachments-uu2CsT）、项目创建/阶段/重启2通过（project-create-1TiGfC）、分类15项通过；监督独立附件6通过（attachments-g9jM6t）、项目2通过（project-create-e1AB7e）、分类15项、workflow40项及monthly-workspaces14项通过，均退出0。真实后端、SQLite、磁盘文件与headless Edge；无mock成功响应，部分故障以目标请求abort或响应丢弃明确传输状态。首次附件停服后仍continue的请求存在晚到可能，修正为停服后明确abort目标PUT后再测；另保留真实PUT成功丢响应场景。测试还发现失败刷新父级会卸载恢复UI，已调整并重新通过。早期定位器、DOM回调类型、脚本拼接及旧seed月份问题均为测试辅助代码问题，报告不把观察器退出0或test-incomplete列为通过。

应用及本机测试类型检查通过；候选Vite构建位于candidate-web-3QbQWR，不覆盖日常dist；仓库共享检查250文件通过，git diff --check通过。文档generate/check通过：24份文档、217个本地引用、216份源码、282处路由、40份迁移，0错误。没有重新把此前19项mock浏览器或48项HTTP检查算作新修改通过；监督已按后端路由范围独立复跑workflow/月度相关检查，通过范围如上。

**限定收尾核查（同一任务）：** 独立快照bounded-followup-N6CkR0含baseline/、manifest.json、baseline.patch；新增仅本机packages/server/test/bounded-followup-regression.ts。最终before-MtWrDl为9组5通过/4失败，Node及隔离入口非零退出，4个失败是月度未保存切期、慢保存仍可编辑并切期、保存失败后切期，以及设置两个独立上下文的旧快照覆盖。应用源码保持三批成果，未修复这些新证实问题。月度请求仍写原期次、目标月未串写；普通保存重开、文件输入DOM状态、实际beforeunload取消后pending仍在，以及两种未知POST提示/风险记录通过。Playwright setInputFiles不能代替原生Windows选文件验证；未知POST已有先核对提示，无视提示重传仍重复属于已明确限制，不新增无ID幂等承诺。首次共用label定位器错误及早期错误的未知POST断言已纠正，旧失败证据保留，不归因应用；最终测试类型检查通过。未重复运行全套或重建应用。监督独立只读确认结果、无残留测试/无头进程及源码哈希未变。最终cleanup.json记录browserConnected=false、测试服务SIGTERM且退出事件已确认；隔离运行器清理临时根。

唯一审查报告重整为首屏/API/完整操作链/未测四层矩阵，补回收站首屏但删除恢复未重验；区分同页设置互斥与新双窗口冲突。静态盘点保留Template、WorkRecords双入口、WorkDocuments、useUnsavedClose、WorkbenchSelect与不同上传用途；仅Periods未消费的文件查询及GenerateModal导入列为可清理建议，未删除或改代码。当前追加实际修改GPT_CONTEXT.md、DEVELOPMENT_PROGRESS.md、docs/management/PROJECT_PLAN.md、本日志及唯一报告，生成docs/knowledge-index.json；本机测试与bounded-followup-N6CkR0证据不随Git同步。

**五份根文档与计划：** GPT_CONTEXT更新简短候选及日常健康边界；CONTEXT全文复核，术语无变化不改正文；PRODUCT_REQUIREMENTS整合保存/离开与已知文件ID恢复的验收条件；SYSTEM_ARCHITECTURE整合两步关联恢复、事务核对和页面暂存限制；DEVELOPMENT_PROGRESS区分既有证据与新专项、三批独立复测及未完成的完整验收边界。PROJECT_PLAN整合GOV-13现状及GOV-11健康信息，不创建新队列；docs/README、knowledge-index及source-inventory由既有生成器刷新。限定收尾再次通读五份根文档：GPT_CONTEXT增加暂停接续边界，DEVELOPMENT_PROGRESS明确5通过/4失败与未修状态；CONTEXT术语、PRODUCT_REQUIREMENTS验收条件（已含无ID不承诺幂等）、SYSTEM_ARCHITECTURE实际结构均无新增变化，正文保持三批结束版本。PROJECT_PLAN整合GOV-13未修事项及用户暂停要求，不另造队列。

**未完成与回退：** 审查矩阵覆盖入口并列出未测链，不等于全部功能、真实模型、Office或业务验收。附件恢复信息只在当前页面；刷新/明确放弃后文件保留但需重新核对；POST未返回ID时不保证无重复。回退按报告列出的每批基线逐文件比较恢复，保留原有工作区修改，禁止git reset或整包覆盖。

**交付状态：** 本地保存；未暂存、提交、推送、正式发布或完成业务验收；旧ui-design日常指针保持。三批独立复核及限定收尾完成后暂停；月度说明与双窗口设置缺陷未修，等待用户继续指令。测试子进程与浏览器已回收，无本任务后台写入。用户自行Git同步；新增本机测试/快照/证据不会随源码推送。建议提交说明：fix(workbench): 保护编辑保存并支持附件关联安全恢复。目录盘点误入过程已停止，既有目录清单及日志保留，不混算修复功能。

## 2026-11-04｜GOV-11｜整理本机项目文件结构

**目标与范围：** 按用户要求枚举当前项目的全部目录和文件，交付完整文件树、折叠依赖及本机产物的源码结构精简版、目录统计；仅读取名称及目录类型，不读取业务文件或私人配置正文，不跟随目录链接。

**修改清单：** 新增本机输出目录outputs/project-structure-20261104-WcVc34，包含完整文件树.txt、项目结构精简版.txt、目录统计.json；WORK_LOG登记本任务。保留任务开始时的17份已修改文件及未跟踪WorkbenchSelect.tsx，不覆盖既有产物；本次不修改应用源码。文档索引按既有生成器刷新。

**五份文档复核：** GPT_CONTEXT、CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS已逐一通读；本次只整理文件结构，接续、术语、需求、架构及实现/发布状态均无新增变化，正文不修改。

**验证与边界：** 文件清单由实际目录遍历生成，隐藏目录纳入完整树，符号链接只列入口，不扩展到项目外；统计和树节点数量交叉核对通过：20191个文件、2583个目录、11个链接，0处读取错误。文档generate/check通过（24份文档、217个本地引用、216份源码、282处路由、40份迁移），git diff --check通过。未运行应用测试、未检查当前服务或发布可用性；文件存在不等于功能可用。

**交付状态：** 清单与日志保存本地；未暂存、提交、推送、发布或改动业务数据。本机清单含私有路径名称，不纳入共享源码。无待实施功能；建议提交说明：docs(structure): 记录项目目录盘点。

## 2026-11-04｜GOV-13 / GOV-08 / GOV-11｜离开保护、关联分页与本机回归修复

**目标、边界与基点：** 按用户授权的监督接续指令，以小批修复现有交互Bug和明确重复代码；第一批完成后经独立审查继续第二批。开始时main/086d2993980dffec4db62a3a1b14bf0e3e29c7ac、工作区和暂存区干净，本地origin/main差异0/0；远端实时查询因现有代理连接失败，未改网络设置。已读仓库约定、五份根文档、README、文档总览、开发指南及计划；本仓库没有.agents/skills目录。未启动其他代理。本任务不修改后端业务规则、正式数据库、资料、配置、发布包或日常前端，不进行真实模型调用。

**第一批：** NavigationGuard把Editor快照存入离开弹窗，导致忙碌结束后按钮仍禁用、重试保存和放弃调用旧闭包、卸载后仍调用旧保存。改为只保存离开目的地，每次显示/操作读取当前注册编辑器；状态变化通知弹窗，顺序保存时重新读取并跳过已卸载/已干净编辑器。useUnsavedClose移除重复beforeunload监听；已核对其全部现有调用都位于App的NavigationGuard下，刷新保护仍由统一入口提供。修改仅涉及components/NavigationGuard.tsx、components/useUnsavedClose.ts。

**第二批：** 后端列表默认200、单页上限500，多处选择器只取首200；Process寻找绑定工作也只取首100。复用components/useWorkbenchCollection.ts，增加可选workTypeId过滤及过滤切换的旧结果隔离；新增components/WorkbenchSelect.tsx统一完整加载后显示选项、失败重试、原选择保留。更新pages/WorkRecords.tsx、Files.tsx、Knowledge.tsx、Agent.tsx、Process.tsx及components/TemplatePreview.tsx、WorkflowPanels.tsx。保留默认未归档过滤语义；不修改后端模型。Agent原useWorkbenches仅有三个本文件调用，均已替换后移除；未删除业务、历史或缓存目录。新增WorkbenchSelect尚未跟踪，须与引用它的文件一起审查/提交。

**本机测试修复：** packages/server/test/evidence-writing-boundaries.ts的竞争子进程改了runtime却继承旧OCR目录，六个进程均以“OCR资源必须位于当前运行目录”退出；已捕获stderr与退出码复现。子进程DB/TEST_DB/OCR统一到本测试race目录，加入超时诊断及finally回收本次创建的子进程，不放宽生产路径校验。packages/server/test/e2e.ts旧断言把明确required=false的结论当作必填，和generate.ts的optionalRenderValues、placeholders.ts的OPTIONAL_EMPTY及已有template-collections契约矛盾；改为核对可选结论留空且不造事实，并另请求缺少必填检查情况的DOCX，检查实际XML占位和X-Missing-Vars缺项。没有为了通过测试修改渲染行为。

**复现与验证：**

- 新增本机测试navigation-guard.ts、navigation-guard-page.ts、workbench-collection.ts，均通过node scripts/test-isolated.mjs --unit运行。before模式从上述Git基点读取原源码进行对照，不回退工作区。离开组件原版6失败/2通过、修复后8通过；完整App的工作记录保存中导航与失败保留/重试两场景原版均失败、修复后均通过；501项工作记录和文件上传关联原版均无法选中末项，修复后分页专项9项通过。
- 浏览器专项覆盖501项跨500边界、第二页失败不提供部分列表、重试保留选择、类型/归档切换、卸载后旧请求、工作记录/文件上传/模板自动带入/记忆更正的关联提交；Field标签可被真实getByLabel定位。使用本机Edge、真实React页面/组件及匿名受控API响应，无真实模型或日常后端。未逐个业务页面完成全面视觉验收。
- 执行者运行npm run typecheck、npm run typecheck:tests通过；独立候选Vite构建通过，最终产物在outputs/navigation-guard-20261104/web-final。11项隔离契约、8组可靠性通过。
- 监督端首次npm test在锁竞争测试处失败；其前面的isolation/unit/regression/workflow/policy/local-model/business/business-ai/stability通过。修正后执行者重跑evidence-writing-boundaries、evidence-directed、evidence-semantic-entry、evidence-citation-contract、work-records（16项）、inspection-drafts（20项）全部通过；监督端另重跑整个test:evidence-writing及后续两组通过。此为首次全链失败后分段覆盖通过，不称首次全链成功。
- HTTP端到端首次由监督端报告46通过/1失败；区分可选与必填契约后，执行者及监督端重跑npm run test:e2e均48通过/0失败，使用隔离后端与匿名生成文件，不包含Office分页打印验收。
- 监督端独立复核离开组件8项、真实页面2项、分页9项、应用及测试类型检查均通过；独立Vite构建通过，产物在监督任务本机目录workbench-review-build-20261104。同日只读核对current-release.json与ui-design-20261024-r1/RELEASE.json，仍选该包；未检查健康或完整包哈希。未把监督反馈写成执行者直接运行的首次全链结果。

**证据与文件：** outputs/navigation-guard-20261104内before.json、after.json、before-page.json、after-page.json、before-collection.json、after-collection.json分别保存浏览器对照结果；PNG保留失败/重试界面；boundaries-before.log包含子进程诊断，六份后续套件日志及e2e-after.log保留验证输出。测试三份新增、两份修改和产物均被Git忽略，仅留本机。源码共10份既有修改加1份新增；文档修改GPT_CONTEXT、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS、PROJECT_PLAN、WORK_LOG；docs/README.md、knowledge-index.json及reference/source-inventory.json由生成器刷新，以最终Git差异为准。

**五份根文档复核：** GPT_CONTEXT更新源码候选与日常证据日期边界；SYSTEM_ARCHITECTURE更新共享编辑/分页组件职责；DEVELOPMENT_PROGRESS整合当前源码基点、验证结果及未发布状态；CONTEXT业务术语无变化、PRODUCT_REQUIREMENTS需求与验收条件无变化，两份正文不修改。GOV-13与GOV-11在唯一队列原行更新状态，不新建并行任务。

**收尾检查、风险与回退：** 文档generate/check通过：24份文档、217处本地引用、216份源码、282处路由声明、40份迁移，0错误；共享内容检查250文件通过，git diff --check通过。完整分页仍为多请求读取，数据在翻页期间变化时不保证数据库快照一致性；大规模数据的加载耗时未做容量验收。新增选择组件应与调用方成组回退；当前无迁移/依赖更新，可按本任务diff逐文件恢复至086d299，先保护之后的新改动，禁止整仓reset。仅本机测试改动应按本条明确的目录修正/断言差异恢复，不删除测试或产物目录。其他GOV未完成项维持原状态。

**交付状态：** 修改实际保存本地；未暂存、未提交、未推送、未发布，日常发布指针未改，未完成真实业务验收。建议提交说明：fix(ui): 修复编辑离开状态与工作关联分页。当前批次完成后停下，等待独立复核，不继续扩大范围。

## 2026-11-03｜GOV-11｜梳理项目完整文件结构

**目标与依据：** 按用户要求扫描当前项目完整文件结构，区分源码、文档、依赖、本机数据和历史产物。开始时main/8b1e927，本地上游差异0/0；已有8份文档及索引修改，全部保留。本任务不涉及近期提交核查，未查询远端。

**修改清单：** 新增本机outputs/project-structure-20261103/完整文件树.txt、项目结构精简版.txt和目录统计.json：分别提供全量名称树、折叠依赖/缓存/数据等目录的阅读版、顶层统计；文件被Git忽略，不上传。WORK_LOG新增本条，文档索引由生成器刷新。只扫描名称，不读取业务文件、数据库或私人配置正文。

**验证：** 扫描包含隐藏和Git忽略项，共19,859个文件、2,500个目录、8个链接，0个读取错误；链接列出但不递归，项目外路径不扫描，本次3份输出文件生成于扫描后、不计入统计。核对输出文件及树条目统计，执行文档generate/check和git diff --check；不运行应用测试、服务、模型或Office。

**五份文档复核：** GPT_CONTEXT接续入口、CONTEXT术语、PRODUCT_REQUIREMENTS需求、SYSTEM_ARCHITECTURE结构、DEVELOPMENT_PROGRESS状态全文复核；本次仅提供目录快照，无新增需求、架构或运行验证结论，五份正文均无需本次修改。

**未完成与交付状态：** 目录快照不证明发布或功能可用，既有未完成项仍见PROJECT_PLAN。清单和日志保存本地，未暂存、提交、推送、发布、修改正式数据或执行业务验收。建议提交说明：docs(inventory): 记录项目文件结构梳理；清单仅留本机，既有文档修改不作为本任务整包提交。

## 2026-11-02｜GOV-11｜项目成果、进度、缺口与后续计划核查整理

**目标与依据：** 根据用户要求总结项目现状；通读五份根文档、项目计划、风险及治理约定，核查当前源码、Git和本机发布条件。开始时main/8b1e927工作区干净，本地上游差异0/0，远端main实时查询与HEAD一致。

**核查结果：** Node v24.21.0，五项主要依赖可解析，前端产物、本机测试及测试配置存在；daily解析为legacy，本机配置、数据库和发布指针存在。指针与RELEASE均选择ui-design-20261024-r1，包内后端/前端入口存在，038迁移不在该包；健康接口连接被拒绝。源码timesheets.ts多项目分配仍使用0.01小时，整数要求未满足。此为只读核查，未启动服务、打开数据库或核验完整包哈希。

**修改清单：** DEVELOPMENT_PROGRESS替换旧设备的缺依赖/数据/发布指针结论，记录本机证据与验证边界；GPT_CONTEXT修正环境摘要；PROJECT_PLAN修正设备与环境说明，不新增任务或承诺排期；RISKS_AND_DECISIONS清除大量未提交修改和038发布状态的泛化表述；WORK_LOG记录本任务。docs/README.md、docs/knowledge-index.json、docs/reference/source-inventory.json按生成器刷新，以最终Git差异为准。

**五份文档复核：** GPT_CONTEXT与DEVELOPMENT_PROGRESS更新当前状态；CONTEXT术语无变化；PRODUCT_REQUIREMENTS需求及验收条件无变化；SYSTEM_ARCHITECTURE结构无变化。三份未变化文档不修改正文。

**验证：** Git、远端、依赖解析、路径存在性、发布清单、健康请求及工时源码检查已执行。文档generate/check通过：24份文档、217个本地引用、215份源码、282处路由声明、40份迁移，0错误；git diff --check通过。自动源码索引刷新提交基点及本机文件摘要，Git未显示应用源码修改。未运行应用测试、构建、真实模型、浏览器或Office验收；健康连接被拒绝不能直接解释为源码启动缺陷。

**未完成与接续：** 沿用PROJECT_PLAN中的GOV-01/05/08/10/11/12/13；重点为运行确认、可靠性异常、整数工时、真实整月对账、模型/Office和完整视觉验收。本次只提供整理与建议，不实施修复、资料迁移或发布。

**交付状态：** 文档保存本地；未暂存、提交、推送、正式发布或完成业务验收，未改动正式数据。建议提交说明：docs(status): 核实本机发布基线并整理项目进度缺口。

## 2026-10-26｜GOV-11｜核查当前工作台是否可运行

**目标与范围：** 用户询问当前工作台能否正常运行；只读检查安装条件、运行路径和健康接口，不启动应用或初始化数据库。

**实际核查：** Node v24.18.0满足项目最低版本；fastify、react、vite和concurrently无法解析，仅有文档工具所需的typescript。前端index.html不存在；daily环境解析为非legacy，未发现配置、数据库或发布指针。8787健康接口返回连接被拒绝。结论为当前目录尚不具备直接正常使用条件，不能据此判断源码本身存在启动缺陷。

**文件与五份文档复核：** GPT_CONTEXT、CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS的当前口径仍适用，正文无变化；只在WORK_LOG记录本次核查，并由生成器刷新索引。不把缺少配置或数据库单独视为新安装故障，它们可在首次启动时创建；旧业务资料是否迁移需另行明确。

**验证与未完成：** 路径解析、依赖解析、文件存在性及健康请求已执行；文档generate/check及共享内容检查通过。未安装完整依赖，未构建或启动应用，未运行应用测试。正常使用还需安装依赖、构建前端、明确新建环境或接续旧数据，再启动并验证实际页面与业务。

**交付状态：** 核查记录保存本地，保留已有文档修改；未暂存、提交、推送、发布或改动业务数据。

## 2026-10-26｜GOV-11｜当前文档完整更新，逐次工作独立记入日志

**目标与依据：** 用户要求删除记忆文档的过时表述，今后完整更新文档，不再逐次追加任务段落，并新建日志文件记录每次工作。范围为仓库文档与索引，不涉及用户全局记忆或应用功能。

**开始状态：** main/adc1f401bdb79df143bf866adf463188cc740e84，工作区干净；远端main经git ls-remote核对一致。整理前原文可由该Git基点完整追溯。运行与环境依据承接同日下方只读核查，不将其扩大为业务验收。

**修改清单与前后变化：**

- GPT_CONTEXT.md、DEVELOPMENT_PROGRESS.md：删除“文档整理未提交”和“本机正在运行旧发布包”等过时表述；将接续入口与进度整合为当前源码、环境、能力及未验收边界，移除“最新任务交付”流水栏目。
- CONTEXT.md、SYSTEM_ARCHITECTURE.md：删除文档整理和复核过程叙述，保留术语及应用结构；架构文档的历史阅读入口接入工作日志。
- PRODUCT_REQUIREMENTS.md：删除整理过程叙述，将PR-18首页与紧凑布局要求、PR-15整数工时要求合入完整条款；明确完整更新正文、清理冲突和重复、无变化只记日志的验收条件。业务BR/PR/SC编号和要求含义保留。
- AGENTS.md、docs/management/DOCUMENT_CONTROL.md：将维护规则从逐次补充及正文复核段落改为全文核对、整合受影响章节；任务经过只写WORK_LOG，CHANGELOG保留已有历史。
- docs/guides/DEVICE_HANDOFF.md：重写为源码接续、完整迁移、恢复验收和多设备边界的完整指南，移除旧Git未合并/大量未提交、过时pack遗漏及旧设备运行状态；保留测试不上传、成对备份、发布身份和隔离验证要求。
- docs/guides/DEVELOPMENT.md：清除安装过程叙述，更新文档维护和日志入口。
- docs/management/PROJECT_PLAN.md：统一设备历史适用范围，更新GOV-11现状，清除过时提交/运行结论和追加式事件段落；保留GOV编号、优先级及未完成事项。
- docs/management/WORK_LOG.md：新增唯一的逐次工作日志，记录当前整理任务并据会话实证补录此前只读核查。
- docs/management/CHANGELOG.md：仅调整文件使用说明，原历史条目保持不变，不再追加新任务。
- scripts/docs-maintenance.mjs：登记工作日志用途，更新CHANGELOG用途；docs/README.md、docs/knowledge-index.json、docs/reference/source-inventory.json由脚本重新生成。

**五份文档复核：** GPT_CONTEXT改为当前接续说明；DEVELOPMENT_PROGRESS重建当前基线及验证边界；CONTEXT术语未变，仅移除过程段落；PRODUCT_REQUIREMENTS更新文档维护要求，业务要求与编号保留；SYSTEM_ARCHITECTURE应用结构未变，删除过程叙述并调整证据入口。

**验证：** 文档generate/check通过：24份文档、217个本地引用、215份源码、282处路由声明、40份迁移，0错误；共享内容检查249文件通过；git diff --check通过。静态对比确认28个术语、36个BR/PR/SC编号保留，CHANGELOG原历史条目不变，五份根文档中的任务流水已清理。应用源码与依赖清单无修改。TypeScript 5.9.3按现有锁文件版本下载到本机临时目录，并解包到忽略的node_modules/typescript供索引工具使用；未修改package.json或锁文件，未安装完整应用依赖，未执行安装生命周期脚本。下载只获取公开工具包，未发送项目资料。索引重算同时刷新了检出换行差异和过期摘要；逐文件对比HEAD确认，除文档生成器用途登记外，索引涉及的源码内容均未变化。

**未完成与边界：** 未运行应用测试、构建、真实模型或Office验收；当前缺少完整应用依赖和本机测试资源。GOV-01/05/08/10/11/12/13既有未闭环项保持，不以文档整理宣布业务完成。

**交付状态：** 文件保存本地；未暂存、未提交、未推送、未发布，未迁移或修改业务数据。建议提交说明：docs(handoff): 完整维护当前文档并分离工作日志。

## 2026-10-26｜GOV-11｜读取项目并核对变化（据同日会话补录）

**目标与范围：** 用户要求读取项目、了解变化；只读核查源码、文档、Git与运行状态，没有修改文件或启动应用。

**核查结果：** main/adc1f40与本地origin/main及远端实时查询一致，工作区干净。2c26fbc引入运行环境与交付边界隔离；adc1f40整理文档职责。发现接续文档仍称整理未提交，与Git事实不符。

**环境与验证：** 当前目录无node_modules、packages/web/dist、packages/server/test、tsconfig.test.json、workbench.config.json、data或outputs。使用只解析路径的runtime-layout模块确认daily、非legacy、8787；解析位置的配置、数据库及发布指针不存在。本机健康接口沙箱访问失败后，获准重试返回连接被拒绝，未确认运行服务。共享内容检查248文件通过，git diff --check通过；文档check因缺少typescript失败，未执行业务测试。

**五份文档复核：** 阅读GPT_CONTEXT、CONTEXT、PRODUCT_REQUIREMENTS、SYSTEM_ARCHITECTURE、DEVELOPMENT_PROGRESS；识别当前状态与历史设备信息混用，业务术语和需求未改。发现的问题由上方文档整理任务处理。

**交付状态：** 仅在会话汇报核查结果，未更改、暂存、提交、推送或发布。此条为据实际工具结果补录，不补造当时未执行的检查；未排查其他路径或设备上的业务数据。
