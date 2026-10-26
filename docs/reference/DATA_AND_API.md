# 数据字典、接口约定与定位

文档ID：REF-DATA-API。版本：1.0。更新：2026-10-21。范围：工作区静态说明；日常版本另核对。完整字段定义以迁移SQL和领域校验为准，不声称已有完整OpenAPI。

## 1. 数据模型与关系

| 对象/主要表 | 关键字段或关系 | 约束/意义 | 定义入口 |
|---|---|---|---|
| 类型work_type | code、domain、navigation_group | 导航目录不改变具体流程 | 001、027、037 |
| 阶段模板position_template | work_type关联 | 定义可执行阶段；不是期次 | 001及后续迁移 |
| 工作workbench | 类型、领域、业务/归档状态等 | 持续业务归属；不是单份文件 | 001、027及domain/service |
| 阶段实例position_instance | workbench关联、doc_requirements | 保留实例要求快照 | 001、024 |
| 期次work_period | workbench_id、report_period、snapshot | 月/季/年范围独立；旧报送字段保留 | 023、030、033 |
| 材料period_material、checklist_item | 期次/阶段关联与核对 | 外部证明与生成成果不能混同 | 001、023及后续 |
| 实际检查inspection_record | period_id、revision、业务字段 | 真正登记的检查，草稿不进入事实统计 | 033、034 |
| 检查草稿inspection_draft | period_id、request_key、revision、fields、provenance、source | UNIQUE(period_id,request_key)，JSON内容由领域校验 | 039 |
| 草稿历史inspection_draft_history | draft_id、revision、snapshot | 复合主键；随草稿级联清理 | 039 |
| 成果artifact | file_rel、root_kind及工作/期次/检查/草稿关联 | 元数据指向实际文件；软删控制访问 | 001及039等 |
| 文书版本doc_version | 成果关联与版本/核对 | 保存旧稿，当前来源变化不能继承核对 | 017、022 |
| 模板template | file_rel、vars_rel、category等 | 文件与字段映射配套；目录不是适用范围 | 001、014、029 |
| 模板适用position_template_doc | 阶段模板与文书模板关联 | 同模板可复用，不复制事实 | 018 |
| 助手证据business_ai_run | 事实快照、来源及writing等 | 保留生成上下文、引用和核对 | 035、036 |
| 旧记忆agent_memory | 来源、作用范围与更正 | 不等于新工作记录 | 006、025 |
| 工作记录候选work_record/history/answer | 原话、时间、nature、revision、status、引用快照 | 038候选，日常未应用，不与旧记忆混写 | 038 |
| 设置、模型、日志、知识库、OCR、工时 | 各自元数据与状态 | 可能含敏感资料；知识文档不导出行内容 | 静态迁移索引及对应domain/core |

039中草稿引用实际检查为ON DELETE SET NULL；期次删除级联草稿及历史；artifact的草稿关联置空。软件删除流程还涉及文件和其他表，仅有SQL约束不能证明全过程可靠。

## 2. 如何查完整字段与迁移

[source-inventory.json](source-inventory.json)列出每个SQL文件的摘要、声明的表和ALTER片段，并列出源码、路由与测试文件。SQL定义可能被后续迁移改变；查某表时应顺序查看所有相关ALTER，不能只看001初始定义。

运行库另以schema_migration实际集合为准。本次[只读运行基线](current-baseline.json)记录039存在、038不存在。该快照不含业务行或凭证；复制到另一机器后不是那台机器的当前结构。

日期、修订和来源的语义由[CONTEXT](../../CONTEXT.md)及领域校验决定。未知发生时间不能用created_at代替。

## 3. API公共约定

源码：packages/server/src/api/reply.ts、core/request-guard.ts及web/src/api.ts。

- 常规成功：`{ "ok": true, "data": ... }`。
- 常规错误：`{ "ok": false, "error": { "code": "...", "message": "...", "detail": ... } }`。
- 下载/静态文件、流式响应等以各路由为准，不强套JSON信封。
- 本机Host/Origin校验；写API需要x-workbench-token，会话由/api/session提供。该令牌不应存入文档，也不是多用户账号凭证。
- 路径ID须满足正整数校验；查询/请求体以实际路由与领域校验为准。
- 常见400为业务输入，403为来源/会话，404为未找到，409为来源/修订冲突，410为文件缺失，422为部分模型格式/字段错误，503为部分模型失败。具体code和状态以实现为准。
- 幂等、revision和来源令牌是不同机制，不可省略其中一个来“解决冲突”。

## 4. 检查草稿接口摘要

注册关系：index → registerWorkflowRoutes → registerInspectionDraftRoutes。接口在当前日常包包含；接续时仍需核对发布状态。下面描述校验过的主要字段，不替代完整实现。

| 方法/路径 | 用途与主要输入 | 结果/边界 |
|---|---|---|
| GET /api/periods/:id/drafts | 获取当前期次草稿上下文与候选历史 | 校验月检范围 |
| POST /api/periods/:id/drafts | requestKey：8～100位字母数字下划线/连字符；可选project、sourceId | 同期同key返回已有草稿；sourceId=null表示不引用，省略时可自动选历史 |
| GET /api/periods/:id/drafts/:draftId | 查看草稿与关联文件 | 返回来源变化和文件有效性 |
| PUT /api/periods/:id/drafts/:draftId | revision及fields；或sourceId；或restoreRevision | 互斥分支按实现处理；保存修订历史并递增revision |
| POST /api/periods/:id/drafts/:draftId/suggest | revision、可选fields与instruction | 返回建议补丁，不自动保存；拒绝越界字段、陈旧修订和变化来源 |
| POST /api/periods/:id/drafts/:draftId/generate | revision、templateIds（1～20个整数）、可选adopt=true | 单次模板；逐份处理；事实不齐全为待确认文件，不能以调用成功认定实际检查 |

suggest默认字段为subject/content/method；允许集合还含result/findings/rectification/remarks，事实边界仍需人工核对。patch的origin=ai用于来源标记，不可当真实性证明。requestKey重用不等于新建另一项检查。

## 5. 其他接口定位

| 领域 | 路由文件 | 领域入口 |
|---|---|---|
| 工作与类型 | routes-work.ts、routes-core.ts | service、work-type-navigation |
| 期次、检查与就绪 | routes-workflow.ts | periods、workflow、inspections |
| 生成、模板、预览、版本 | routes-generate.ts、routes-template.ts、routes-preview.ts | generate、document-source、versions、template |
| 文件、回收站、归档 | routes-files.ts、routes-archive.ts | store、trash、archive |
| 工时 | routes-timesheets.ts | timesheets |
| 检索、知识与识别 | routes-search.ts、routes-kb.ts、routes-vision.ts | search-all、kb、vision、ocr |
| 助手与外发确认 | routes-agent.ts、routes-ai.ts、routes-consent.ts | agent、business-evidence、ai/consent |
| 工作记录候选 | routes-records.ts，经routes-agent注册 | work-records、work-record-chat；当前日常排除 |

静态索引从TypeScript AST提取字面量路径及注册调用，包含可能不在日常包内的代码。接口参数不应凭路径名推断；修改前读领域函数和测试。当前没有宣称自动生成了完整请求/响应Schema或所有动态注册。
