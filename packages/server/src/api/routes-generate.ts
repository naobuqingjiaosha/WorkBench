import {inspectionFields,requireInspection,documentPeriodKey,assertInspectionScope} from '../domain/inspections.ts';
import type { FactChoice } from '../domain/memory-facts.ts';
import {documentSourceSignature} from '../domain/document-source.ts';
/**
 * 生成接口：AI 填变量 → 预览 → 保存成文件
 *
 * 预览（B4-12）：`POST /api/generate/preview` 回**结构化预览计划**（不再回文件流），
 * 页面内渲染成文本/表格/缩略图 + 产物合法性横幅；下载退到 `/preview/file`（兜底），
 * 「用系统打开」走 `/preview/open`（写运行目录的临时文件，不落用户目录、不进 artifact）。
 */
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import { assertGenerationScope,assertPeriodContext,requirePeriod,assertPeriodTemplate,periodNativeFields,periodResultTargets,resolvePeriodResultTarget,periodResultHead } from '../domain/periods.ts';
import {
  analyzeGaps,
  generateVariables,
  openPreviewInSystem,
  previewDocument,
  renderPreviewPlan,
  saveGeneratedDocument,
} from '../domain/generate.ts';
import { getTemplate, readTemplateVars,templateAbsPath } from '../domain/service.ts';
import {scanTemplateStructure} from '../core/template.ts';
import { getPolicyRequirement, setPolicyRequirement, policyDocuments } from '../domain/policy-requirements.ts';
import { resolveTemplateVars } from '../domain/archive.ts';
import { chainSummary, VersionRuleError } from '../domain/versions.ts';
import { ApiError, body, fail, intParam, ok, optBool, optNum, optStr, strArray } from './reply.ts';

export function registerGenerateRoutes(app: FastifyInstance): void {
  app.get('/api/generate/policy/:templateId', async (req, reply) => {
    try {
      const id = intParam(req, 'templateId');
      if (!getTemplate(id)) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      return ok(reply, { requirement: getPolicyRequirement(id), documents: policyDocuments() });
    } catch (e) { return fail(reply, e); }
  });
  app.put('/api/generate/policy/:templateId', async (req, reply) => {
    try { return ok(reply, { requirement: setPolicyRequirement(intParam(req, 'templateId'), body(req)) }); }
    catch (e) { return fail(reply, e); }
  });
  /**
   * 取某个模板的变量清单 + 每个变量的自动带入情况。
   *
   * 每个变量都带 `preset`（自动带出的值）和 `source`（值从哪来），
   * 界面据此把「不用填的」和「要手填的」分开显示。
   */
  app.get('/api/generate/fields/:templateId', async (req, reply) => {
    try {
      const templateId = intParam(req, 'templateId');
      const t = getTemplate(templateId);
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const vars = readTemplateVars(t);
      const workbenchId = Number((req.query as Record<string, string>).workbenchId ?? '') || null;
      const positionCode = (req.query as Record<string, string>).positionCode || null;
      const periodId=Number((req.query as Record<string,string>).periodId)||null;
      const inspectionId=Number((req.query as Record<string,string>).inspectionId)||null;
      if(inspectionId)requireInspection(inspectionId,periodId);
      assertPeriodContext(workbenchId,periodId);
      assertGenerationScope(t,workbenchId,positionCode,periodId);
      if(periodId&&!workbenchId)throw new ApiError('WORK_REQUIRED','期次生成必须指定工作');
      const period=periodId?requirePeriod(periodId,workbenchId):null;
      assertInspectionScope(t,period,inspectionId);
      if(period)assertPeriodTemplate(period,t);

      const { resolved, autoCount, todoCount } = resolveTemplateVars(
        vars.variables.map((v) => v.name),
        workbenchId,
        t.work_type_id ?? null,
        positionCode,
        {...(period?periodNativeFields(period):{}),...inspectionFields(inspectionId,periodId)},
      );
      const byName = new Map(resolved.map((r) => [r.name, r]));
      const collections=scanTemplateStructure(templateAbsPath(t)).collections;

      return ok(reply, {
        materialTargets:period?periodResultTargets(period,templateId).map(m=>({id:m.id,title:m.title,required:!!m.required})):[],
        sourceSignature:documentSourceSignature(workbenchId,periodId,templateId,[],inspectionId),
        inspectionRevision:inspectionId?requireInspection(inspectionId,periodId).revision:null,
        template: { id: t.id, name: t.name, category: t.category, file_format: t.file_format, description: t.description },
        variables: vars.variables.map((v) => {
          const r = byName.get(v.name);
          return {
            ...v,
            collectionFields:collections.find(c=>c.name===v.name)?.fields,
            /** 自动带出的值（系统变量 / 档案字段 / 工作台字段），空串表示要手工填 */
            preset: r && r.value !== '' ? r.value : undefined,
            /** 值从哪来：system | archive | native | unmapped */
            source: r?.from ?? 'unmapped',
            /** 命中路径说明，直接显示给用户 */
            via: r?.via ?? '',
            /** 命中的档案字段（source=archive 时），界面可提供「去补档案」入口 */
            fieldKey: r?.fieldKey,
          };
        }),
        /** 汇总：多少个能自动带出、多少个要填 */
        summary: { total: vars.variables.length, auto: autoCount, todo: todoCount },
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 调模型生成变量值（不落盘，只返回结果给界面确认） */
  app.post('/api/generate/draft', async (req, reply) => {
    try {
      const b = body(req);
      const templateId = optNum(b, 'templateId');
      if (!templateId) throw new ApiError('MISSING_FIELD', '需要 templateId');
      if (!getTemplate(templateId)) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const known = b.known && typeof b.known === 'object' ? (b.known as Record<string, string>) : {};
      const result = await generateVariables({
        templateId,
        workbenchId: optNum(b, 'workbenchId') ?? null,
        periodId: optNum(b, 'periodId') ?? null,
        inspectionId: optNum(b,'inspectionId')??null,
        inspectionRevision:optNum(b,'inspectionRevision')??null,
        positionCode: optStr(b, 'positionCode') ?? null,
        known,
        instruction: optStr(b, 'instruction'),
        referenceArtifactIds: (strArray(b, 'referenceArtifactIds') ?? []).map(Number).filter(Number.isFinite),
        skipAi: optBool(b, 'skipAi') === 1,
        model: optStr(b, 'model'),
      });
      return ok(reply, result);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 预览（B4-12 真·预览）：回**结构化预览计划**（`plan.segments`）与**产物合法性校验**，
   * 由界面渲染成页面内的文本/表格/缩略图 + 红/绿横幅 —— 点「预览」不再等于下载文件。
   *
   * 兼容一个口子（有意为之，不是过渡期临时写法）：**不传 `want:'plan'` 时仍回文件流**，
   * 与改造前逐字一致。原因：`packages/server/test/e2e.ts` 有两条断言依赖「这个路径回 docx 流」
   * （`预览返回文件流`、`渲染后变量已被替换`），而测试文件不在本次改动范围内 ——
   * 把老调用方悄悄从"拿到文件"改成"拿到 JSON"，等于用一次接口改造打掉别人的回归门。
   * 后果：**界面永远显式传 `want:'plan'`**（见 `pages/GenerateModal.tsx` 的 doPreview），
   * 所以"点预览不再下载"这件事是真的；老调用方拿到的东西一个字节都没变。
   */
  app.post('/api/generate/preview', async (req, reply) => {
    try {
      const b = body(req);
      const templateId = optNum(b, 'templateId');
      if (!templateId) throw new ApiError('MISSING_FIELD', '需要 templateId');
      const values = b.values && typeof b.values === 'object' ? (b.values as Record<string, unknown>) : {};

      if (optStr(b, 'want') !== 'plan') {
        /**
         * 老契约（= /preview/file，同一个实现，不复制粘贴两套）。
         * 老调用方不带 `workbenchId` 时行为逐字不变；带了就按工作台取影像 —— 纯增量，
         * 不再让"带了工作台"的调用方掉进全库按名字找照片的兜底。
         */
        const legacy = await previewDocument(templateId, values, {
          workbenchId: optNum(b, 'workbenchId') ?? null,
        periodId: optNum(b, 'periodId') ?? null,
        inspectionId: optNum(b,'inspectionId')??null,
        inspectionRevision:optNum(b,'inspectionRevision')??null,
          positionCode: optStr(b, 'positionCode') ?? null,
        });
        if (!legacy.ok || !legacy.bytes) throw new ApiError('RENDER_FAILED', legacy.message ?? '渲染失败');
        reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(legacy.fileName)}`);
        reply.type('application/octet-stream');
        reply.header('X-Missing-Vars', encodeURIComponent(JSON.stringify(legacy.missing)));
        return reply.send(legacy.bytes);
      }

      const r = await renderPreviewPlan(templateId, values, {
        workbenchId: optNum(b, 'workbenchId') ?? null,
        periodId: optNum(b, 'periodId') ?? null,
        inspectionId: optNum(b,'inspectionId')??null,
        inspectionRevision:optNum(b,'inspectionRevision')??null,
        positionCode: optStr(b, 'positionCode') ?? null,
        rowLimit: optNum(b, 'rowLimit'),
      });
      /**
       * **产物非法时也回 200 + `ok:false`**（有意为之）：
       * B4-12 验收②③要的是"预览看到红色横幅 + 具体原因"，而不是一个笼统的错误 toast。
       * 所以这里不把 `check.ok=false` 转成 4xx/5xx —— 校验结论、逐条错误与 plan 一起回给界面，
       * 由界面把红色横幅写清楚。真正"没法渲染"的情形（模板不存在/格式不支持）仍然是 4xx。
       */
      if (!r.plan && !r.check.ok) throw new ApiError('RENDER_FAILED', r.check.reason, 400);
      return ok(reply, {
        check: r.check,
        plan: r.plan,
        warnings: r.warnings,
        missing: r.missing,
        missingImages: r.missingImages ?? [],
        /** 兜底下载用的文件名与提醒（界面保留「下载」入口，但默认动作不再是下载） */
        fileName: r.fileName,
        notes: r.notes ?? [],
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 预览的**兜底下载**：与改造前的 `/api/generate/preview` 逐字一致
   * （文件流 + Content-Disposition + `X-Missing-Vars`），供预览窗口里那个「下载」按钮使用。
   *
   * **但 `workbenchId` 现在是必填**（有意为之，见 docs/16 的缺陷 2）。原因：
   * 影像素材由 `buildRenderAssets()` 决定，有 `workbenchId` 时按"本工作台 / 本阶段优先"取，
   * 没有就退回**全库影像按名字子串匹配** —— 于是同一个模板下载出来的 docx 里，可能是
   * 别的工作台（或任意同名文件）的照片，与「预览」「用系统打开」「正式生成」三条路不同源。
   * 缺参数时**明确报错**而不是悄悄出一份别的照片的、或者一份没照片的文件：
   * 后者用户会以为"预览就是正式产物"，而这条路的全部意义就是"下载一份和正式生成同源的东西来核对"。
   */
  app.post('/api/generate/preview/file', async (req, reply) => {
    try {
      const b = body(req);
      const templateId = optNum(b, 'templateId');
      if (!templateId) throw new ApiError('MISSING_FIELD', '需要 templateId');
      const workbenchId = optNum(b, 'workbenchId');
      if (!workbenchId) {
        throw new ApiError(
          'MISSING_FIELD',
          '下载预览需要 workbenchId：缺了它就无法确定这次渲染该用哪个工作台（哪个阶段）的影像，' +
            '以前会退回"全库影像按名字找同名的"，可能插进别的工作台的照片。请从工作台的「出文书」弹窗里下载。',
        );
      }
      const values = b.values && typeof b.values === 'object' ? (b.values as Record<string, unknown>) : {};
      const r = await previewDocument(templateId, values, {
        workbenchId,
        periodId: optNum(b, 'periodId') ?? null,
        inspectionId: optNum(b,'inspectionId')??null,
        inspectionRevision:optNum(b,'inspectionRevision')??null,
        positionCode: optStr(b, 'positionCode') ?? null,
      });
      if (!r.ok || !r.bytes) throw new ApiError('RENDER_FAILED', r.message ?? '渲染失败');
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(r.fileName)}`);
      reply.type('application/octet-stream');
      reply.header('X-Missing-Vars', encodeURIComponent(JSON.stringify(r.missing)));
      return reply.send(r.bytes);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 「用系统打开」（B4-12 兼容路径）：写 `RUNTIME_ROOT/preview/<uuid>.<ext>` 再交给系统默认程序，
   * 不阻塞、不解析返回值；本机没有关联 Word 时只是打不开，**接口照样成功**（不报 500），
   * 界面据此显示「本机未关联 Word，请下载后查看」。
   */
  app.post('/api/generate/preview/open', async (req, reply) => {
    try {
      const b = body(req);
      const templateId = optNum(b, 'templateId');
      if (!templateId) throw new ApiError('MISSING_FIELD', '需要 templateId');
      const values = b.values && typeof b.values === 'object' ? (b.values as Record<string, unknown>) : {};
      const r = await openPreviewInSystem(templateId, values, {
        workbenchId: optNum(b, 'workbenchId') ?? null,
        periodId: optNum(b, 'periodId') ?? null,
        inspectionId: optNum(b,'inspectionId')??null,
        inspectionRevision:optNum(b,'inspectionRevision')??null,
        positionCode: optStr(b, 'positionCode') ?? null,
      });
      return ok(reply, {
        opened: r.opened,
        fileName: r.fileName,
        check: r.render.check,
        /**
         * 绝对路径只给实测/日志核对用；界面不显示它 —— 运行目录不该成为用户要去记的东西。
         * 字段名用 tempFile 而不是 path，避免误当成"文件在哪"的正式答案。
         */
        tempFile: r.path,
        expiresInHours: 24,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 保存成文件：落到工作台 _生成文书 目录，登记 artifact。
   *
   * `saveMode`（B1-4）三选项，**缺省 `'new'`**（不传时行为与改造前逐字一致，见
   * `domain/generate.ts` 的 `SaveGeneratedInput.saveMode`）：
   *   · `new`    新建（另一份不同用途）
   *   · `update` 更新这一版 —— 旧版文件移到 `.versions/<group>/v<N>.<ext>`，新版占正式文件名
   *   · `final`  另存为定稿 —— 同 update，且这一版直接置 `is_final=1`
   * 链上有定稿时 update/final 会被拦下（400 + 明确的人话），**不静默覆盖**。
   * 链身份含**期次**（迁移 022）：9 月定稿不会挡住 10 月，跨期各自一条链。
   *
   * 【提交顺序】渲染与校验在**任何**磁盘/库的版本变更之前完成；新版本登记失败时
   * 会把上一版搬回原位（库从未改过），不会留下"记录指向不存在的文件"。
   * 响应里的 `missingImages` 是"本工作台的影像里没找到这些图片"（**不会**拿别的工作台的照片顶替）。
   */
  app.post('/api/generate/save', async (req, reply) => {
    try {
      const b = body(req);
      const templateId = optNum(b, 'templateId');
      if (!templateId) throw new ApiError('MISSING_FIELD', '需要 templateId');
      const values = b.values && typeof b.values === 'object' ? (b.values as Record<string, unknown>) : {};
      const rawMode = optStr(b, 'saveMode');
      if (rawMode !== undefined && !['new', 'update', 'final'].includes(rawMode)) {
        throw new ApiError('BAD_PARAM', `saveMode 只能是 new / update / final：${rawMode}`);
      }
      if (rawMode !== 'new' && rawMode !== undefined && (b.expectedHeadId === undefined || !optStr(b,'expectedContextSignature'))) {
        throw new ApiError('EDIT_TOKEN_REQUIRED','更新或定稿需要当前窗口的版本及来源令牌。请重新打开生成窗口；旧客户端只能显式新建独立草稿。',409);
      }
      const r = await saveGeneratedDocument({
        templateId,
        materialId:optNum(b,'materialId')??null,
        workbenchId: optNum(b, 'workbenchId') ?? null,
        periodId: optNum(b, 'periodId') ?? null,
        inspectionId: optNum(b,'inspectionId')??null,
        inspectionRevision:optNum(b,'inspectionRevision')??null,
        positionCode: optStr(b, 'positionCode') ?? null,
        values,
        fileName: optStr(b, 'fileName'),
        mode: (optStr(b, 'mode') as 'ai' | 'manual' | 'hybrid') ?? 'ai',
        checklistItemId: optNum(b, 'checklistItemId') ?? null,
        factChoices: b.factChoices && typeof b.factChoices==='object' && !Array.isArray(b.factChoices) ? b.factChoices as Record<string,FactChoice> : undefined,
        saveMode: (rawMode as 'new' | 'update' | 'final' | undefined) ?? 'new',
        expectedHeadId: b.expectedHeadId===null?null:optNum(b,'expectedHeadId'),
        expectedSourceSignature:optStr(b,'expectedSourceSignature'),
        expectedContextSignature:optStr(b,'expectedContextSignature'),
        sourceArtifactIds:(strArray(b,'sourceArtifactIds')??[]).map(Number).filter(Number.isSafeInteger),
      });
      return ok(reply, { artifact: r.artifact, missing: r.missing, missingImages: r.missingImages, version: r.version, warnings: r.warnings }, 201);
    } catch (e) {
      /**
       * 版本链的规则拒绝（"已经是最终版不能再覆盖"…）是**用户操作不合法**，
       * 必须是 400 + 后端原文（界面 toast 直接显示那句话），不能变成 500「服务出错了」。
       * 其余异常（模板坏了、渲染失败）照旧按内部错误走。
       */
      if (e instanceof VersionRuleError) return fail(reply, new ApiError('VERSION_RULE', e.message, 400));
      return fail(reply, e);
    }
  });

  /** 验收前缺口分析 */
  app.post('/api/workbenches/:id/gap-analysis', async (req, reply) => {
    try {
      const r = await analyzeGaps(intParam(req, 'id'));
      if (!r.ok) throw new ApiError('AI_FAILED', r.error ?? '分析失败');
      return ok(reply, { text: r.text, model: r.model });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 「这份文书现在有几版、能不能覆盖」—— 生成对话框在**点保存之前**要用它，
   * 才能把「更新这一版 → v3」「已有定稿，不能再覆盖」这类后果先摆在用户眼前（B1-4）。
   *
   * 【期次（迁移 022）】链身份 = `工作台 + 模板 + 清单项 + 阶段 + 期次`，
   * 期次由 `resolvePeriodKey()` 按该阶段的 `period_dir` × 工作台**当前**期次现算。
   * 所以月报这类文书：9 月那一期定稿之后，10 月再打开这个接口拿到的是一条**新的**链
   * （`exists:false`、`blocked:false`）—— 不会再被上一期的定稿挡住。
   * 想看**某一期**的状态时用 `?periodKey=2026\09月` 显式指定（界面回看历史期次时用得上）。
   */
  app.get('/api/generate/chain', async (req, reply) => {
    try {
      const templateId = Number((req.query as Record<string, string>).templateId ?? '');
      if (!Number.isSafeInteger(templateId) || templateId <= 0) throw new ApiError('MISSING_FIELD', '需要 templateId');
      const workbenchId = Number((req.query as Record<string, string>).workbenchId ?? '') || null;
      const checklistItemId = Number((req.query as Record<string, string>).checklistItemId ?? '') || null;
      const positionCode = (req.query as Record<string, string>).positionCode || null;
      const rawPeriod = (req.query as Record<string, string>).periodKey;
      const businessPeriod = Number((req.query as Record<string,string>).periodId) || null;
      assertPeriodContext(workbenchId,businessPeriod);
      if(businessPeriod&&!workbenchId)throw new ApiError('WORK_REQUIRED','期次生成必须指定工作');
      const inspectionId=Number((req.query as Record<string,string>).inspectionId)||null;
      const p=businessPeriod?requirePeriod(businessPeriod,workbenchId):null;
      const target=p?resolvePeriodResultTarget(p,templateId,Number((req.query as Record<string,string>).materialId)||null):undefined;
      const explicitPeriod=documentPeriodKey(businessPeriod?requirePeriod(businessPeriod,workbenchId):null,inspectionId)??rawPeriod;
      return ok(
        reply,
        chainSummary({
          workbenchId,
          templateId,
          checklistItemId,
          positionCode,
          periodKey: explicitPeriod,
        },target&&p?periodResultHead(p,templateId,target):undefined),
      );
    } catch (e) {
      return fail(reply, e);
    }
  });
}
