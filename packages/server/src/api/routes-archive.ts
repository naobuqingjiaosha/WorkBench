/**
 * 档案接口
 *
 * 分三组：
 *   1. 字段与别名   —— 档案的定义，谁能在模板里被自动带出
 *   2. 档案值       —— 某个工作台的项目信息
 *   3. AI 提议      —— 运行中的模型读模板/读资料后的建议，必须用户确认才落盘
 *
 * 铁律：AI 只能通过 /api/archive/analyze 提建议，通过 /api/archive/proposals/:id/accept 落盘，
 *      且只允许「新增字段 / 新增别名 / 写值」，不能改名、删除、改变已有 field_key 的含义。
 */
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { aiReadiness, chat, parseJsonLoose } from '../ai/gateway.ts';
import type { AiPurpose } from '../ai/providers.ts';
import { all, get } from '../db/index.ts';
import { DATA_ROOT } from '../core/config.ts';
import { liveFilter } from '../core/trash.ts';
import {
  computeCoverage,
  listUnmapped,
  loadSuggestCandidates,
  ruleSuggestAlias,
  type AliasSuggestion,
} from '../core/coverage.ts';
import { scanTemplate } from '../core/template.ts';
import { cleanupTemp, readParts, type SavedUpload } from './upload.ts';
import { confirmExtraction, extractProjectInfo } from '../domain/extract-info.ts';
import {
  acceptBatch,
  acceptProposal,
  archiveCompleteness,
  archiveField,
  createProposals,
  deleteArchiveAlias,
  listArchiveAliases,
  listArchiveFields,
  listProposals,
  readArchiveValues,
  rejectProposal,
  resolveTemplateVars,
  upsertArchiveAlias,
  upsertArchiveField,
  writeArchiveValues,
  type FieldType,
} from '../domain/archive.ts';
import { getTemplate, getWorkbench, templateAbsPath } from '../domain/service.ts';
import { ApiError, body, fail, intParam, ok, optBool, optNum, optStr, q, qBool, qInt, requireStr, strArray } from './reply.ts';

/** 取模板的全部变量名（用于档案解析与 AI 梳理） */
async function templateVarNames(templateId: number): Promise<string[]> {
  const t = getTemplate(templateId);
  if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
  const scan = await scanTemplate(templateAbsPath(t));
  return [...new Set(scan.variables.filter((v) => !v.prefix).map((v) => v.name))];
}

/**
 * 修补被截断的 JSON。
 *
 * 模型输出撞到 max_tokens 时，JSON 会停在半路（如 `{"fields":[{...},{"k":"a"` ）。
 * 直接 JSON.parse 必然失败，但把未闭合的括号补齐后，前面已经写好的提议大多能救回来 ——
 * 这比整批丢弃重跑划算得多。
 */
function repairTruncatedJson(text: string): unknown | undefined {
  let s = text.trim();
  // 去掉可能的代码围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!s) return undefined;
  // 截断常停在不完整的字符串或键上，砍到最后一次「完整」的分隔符
  const lastGood = Math.max(s.lastIndexOf('},'), s.lastIndexOf('}]'), s.lastIndexOf('"],'));
  if (lastGood > 0) s = s.slice(0, lastGood + 1);

  // 统计未闭合的括号并补齐（忽略字符串内的括号）
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) s += '"';
  while (stack.length) {
    const open = stack.pop();
    s += open === '{' ? '}' : ']';
  }
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

interface AnalysisProposal {
  kind: 'field' | 'alias';
  payload: Record<string, unknown>;
  reason?: string;
}

/** 把模型返回的原始对象转成规范化的提议列表（过滤掉不合法的） */
function normalizeProposals(
  value: { fields?: unknown[]; aliases?: unknown[] },
  ctx: { knownVars: Set<string>; mapped: Set<string>; existingKeys: Set<string>; systemVars: Set<string> },
): AnalysisProposal[] {
  const out: AnalysisProposal[] = [];
  // 被 AI 提议为档案字段、但其实该由系统自动填的变量（如 {年份} → _年份）。
  // 这些不能建成档案字段，否则用户要为一个本该自动的值去手工填档案。
  const bogusKeys = new Set<string>();
  for (const raw of value.fields ?? []) {
    const f = raw as Record<string, unknown>;
    const key = String(f.k ?? f.field_key ?? '').trim();
    if (!key || !/^[a-z][a-z0-9_]*$/.test(key)) continue; // 只接受规范 key
    if (ctx.existingKeys.has(key)) continue;
    // 该字段对应的变量若全是系统变量，说明它本该自动填，不是档案字段
    const bound = (value.aliases ?? [])
      .map((a) => String((a as Record<string, unknown>).k ?? (a as Record<string, unknown>).field_key ?? ''))
      .filter((k) => k === key).length;
    const systemBound = (value.aliases ?? [])
      .filter((a) => String((a as Record<string, unknown>).k ?? '') === key)
      .filter((a) => ctx.systemVars.has(String((a as Record<string, unknown>).v ?? ''))).length;
    if (bound > 0 && bound === systemBound) { bogusKeys.add(key); continue; }
    out.push({
      kind: 'field',
      payload: {
        field_key: key,
        label: f.l ?? f.label ?? key,
        type: f.t ?? f.type ?? 'text',
        example: f.e ?? f.example,
        hint: f.r ?? f.reason,
      },
      reason: (f.r ?? f.reason) ? String(f.r ?? f.reason) : undefined,
    });
    ctx.existingKeys.add(key); // 同批内不重复建
  }
  for (const raw of value.aliases ?? []) {
    const a = raw as Record<string, unknown>;
    const varName = String(a.v ?? a.var_name ?? '').trim();
    const fieldKey = String(a.k ?? a.field_key ?? '').trim();
    if (!varName || !fieldKey) continue;
    if (!ctx.knownVars.has(varName)) continue; // 变量必须真实存在于模板里
    if (ctx.mapped.has(varName)) continue;     // 已有映射的不重复提
    if (ctx.systemVars.has(varName)) continue; // 系统变量不让 AI 改
    if (bogusKeys.has(fieldKey)) continue;     // 指向已被否掉的伪字段
    out.push({ kind: 'alias', payload: { var_name: varName, field_key: fieldKey },
      reason: (a.r ?? a.reason) ? String(a.r ?? a.reason) : undefined });
    ctx.mapped.add(varName);
  }
  return out;
}

/**
 * 跑一批：把一份变量清单交给模型，拿回提议。
 * 分批的关键原因：一次喂 19 份模板（196 个变量）时，deepseek-flash 会生成超长输出撞上
 * max_tokens 上限而被截断，整批作废。拆小后每批输出可控。
 */
async function analyzeBatch(input: {
  rows: { id: number; name: string }[];
  varMap: Map<string, string[]>;
  existingFields: { field_key: string; label: string; type: string }[];
  knownVars: Set<string>;
  mapped: Set<string>;
  existingKeys: Set<string>;
  systemVars: Set<string>;
  model?: string;
  maxTokens: number;
  workTypeId: number | null;
}): Promise<{ proposals: AnalysisProposal[]; truncated: boolean; error?: string; usage?: { prompt: number; output: number } }> {
  const inventory = [...input.varMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, ts]) => `${name}｜${ts.length}`)
    .join('\n');

  const instruction = [
    '为本地文书工作台梳理「档案字段」。',
    '',
    '背景：模板里用 {变量名} 标出待填内容。反复出现的变量（如「项目名称」在 18 份模板里出现）',
    '应在「项目档案」里填一次、所有模板自动带出。你的任务是找出这类变量并归类。',
    '',
    '【现有档案字段】',
    input.existingFields.length ? input.existingFields.map((f) => `${f.field_key}=${f.label}`).join('; ') : '（无）',
    '',
    '【模板变量清单】格式：变量名｜出现份数',
    inventory,
    '',
    '【任务】',
    '1. 找出属于「项目级稳定信息」的变量（项目名、合同、甲乙方、金额、日期、人员、地点、监理等）',
    '2. 给每个新字段一个英文 field_key 和中文 label',
    '3. 把所有同义变量名归到对应字段',
    '排除：编号式明细（设备一名称、交付物2数量这类带序号的）；每份各不相同的正文（检查内容、整改要求）',
    '',
    '【输出】只输出 JSON，不要任何解释文字，不要代码围栏。格式：',
    '{"fields":[{"k":"supervisor_org","l":"监理机构","t":"text"}],',
    ' "aliases":[{"v":"监理单位","k":"supervisor_org"},{"v":"监理机构","k":"supervisor_org"}]}',
    '',
    '字段说明：k=field_key（英文小写下划线），l=label（中文），t=type。',
    'type 取值：text|longtext|date|money|number|percent|enum',
    'aliases 里 v=变量名（必须与上面清单里的名字完全一致），k=归入哪个字段的 field_key。',
    '若某变量该归入现有字段，只输出 alias，不要重复建 field。',
    '直接给结果，不要逐条解释理由。只提议有把握的，宁少勿多。',
  ].join('\n');

  const res = await chat({
    purpose: 'extract',
    json: true,
    model: input.model,
    maxTokens: input.maxTokens,
    messages: [
      { role: 'system', content: '你是严谨的信息架构助手，只输出紧凑 JSON，不编造不存在的变量名。' },
      { role: 'user', content: instruction },
    ],
    ref: { type: 'archive-analyze', id: input.workTypeId ?? 0 },
  });

  // 截断时尽力抢救已产出的部分，拿回多少算多少
  if (!res.ok) {
    const salvaged = repairTruncatedJson(res.text) as { fields?: unknown[]; aliases?: unknown[] } | undefined;
    if (salvaged) {
      return {
        proposals: normalizeProposals(salvaged, input),
        truncated: true,
        usage: res.usage,
      };
    }
    return { proposals: [], truncated: true, error: res.error, usage: res.usage };
  }

  const parsed = parseJsonLoose<{ fields?: unknown[]; aliases?: unknown[] }>(res.text);
  if (!parsed.ok || !parsed.value) {
    const salvaged = repairTruncatedJson(res.text) as { fields?: unknown[]; aliases?: unknown[] } | undefined;
    if (salvaged) return { proposals: normalizeProposals(salvaged, input), truncated: false, usage: res.usage };
    return { proposals: [], truncated: false, error: '模型返回的不是合法 JSON', usage: res.usage };
  }
  return { proposals: normalizeProposals(parsed.value, input), truncated: false, usage: res.usage };
}

export function registerArchiveRoutes(app: FastifyInstance): void {
  /* ============================== 字段定义 ============================== */

  app.get('/api/archive/fields', async (req, reply) => {
    try {
      const workTypeId = qInt(req, 'workTypeId') ?? null;
      return ok(reply, { items: listArchiveFields(workTypeId) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/archive/fields', async (req, reply) => {
    try {
      const b = body(req);
      const id = upsertArchiveField({
        workTypeId: optNum(b, 'workTypeId') ?? null,
        fieldKey: requireStr(b, 'fieldKey', '字段标识'),
        label: optStr(b, 'label'),
        type: (optStr(b, 'type') as FieldType) ?? 'text',
        required: optBool(b, 'required') === 1,
        example: optStr(b, 'example'),
        hint: optStr(b, 'hint'),
        aliasesLabel: strArray(b, 'aliasesLabel'),
        origin: 'user',
      });
      return ok(reply, { id }, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/api/archive/fields/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const cur = get<{ field_key: string; work_type_id: number | null }>(
        // 回收站里的字段（软删除）按"不存在"处理：deleted_at IS NULL
        `SELECT field_key, work_type_id FROM archive_field
          WHERE id = ? AND ${liveFilter('archive_field')} /* deleted_at IS NULL */`,
        [id],
      );
      if (!cur) throw new ApiError('NOT_FOUND', '字段不存在', 404);
      const b = body(req);
      return ok(reply, {
        id: upsertArchiveField({
          id,
          fieldKey: cur.field_key, // field_key 不可改：它是模板契约
          workTypeId: cur.work_type_id,
          label: optStr(b, 'label'),
          type: (optStr(b, 'type') as FieldType) ?? undefined,
          required: optBool(b, 'required') === 1 ? true : optBool(b, 'required') === 0 ? false : undefined,
          example: optStr(b, 'example'),
          hint: optStr(b, 'hint'),
          aliasesLabel: strArray(b, 'aliasesLabel'),
          sortOrder: optNum(b, 'sortOrder'),
        }),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/archive/fields/:id', async (req, reply) => {
    try {
      const r = archiveField(intParam(req, 'id'));
      if (!r.archived) throw new ApiError('REFUSED', r.refused ?? '无法删除');
      return ok(reply, { archived: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ============================== 别名映射 ============================== */

  app.get('/api/archive/aliases', async (req, reply) => {
    try {
      return ok(reply, { items: listArchiveAliases(qInt(req, 'workTypeId') ?? null) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/archive/aliases', async (req, reply) => {
    try {
      const b = body(req);
      return ok(
        reply,
        {
          id: upsertArchiveAlias({
            workTypeId: optNum(b, 'workTypeId') ?? null,
            varName: requireStr(b, 'varName', '变量名'),
            fieldKey: requireStr(b, 'fieldKey', '档案字段'),
            confidence: 'manual',
            note: optStr(b, 'note'),
          }),
        },
        201,
      );
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/archive/aliases/:id', async (req, reply) => {
    try {
      deleteArchiveAlias(intParam(req, 'id'));
      return ok(reply, { deleted: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ============================== 档案值 ============================== */

  app.get('/api/archive/values/:workbenchId', async (req, reply) => {
    try {
      const workbenchId = intParam(req, 'workbenchId');
      const wb = getWorkbench(workbenchId);
      if (!wb) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      return ok(reply, {
        values: readArchiveValues(workbenchId),
        fields: listArchiveFields(wb.work_type_id),
        completeness: archiveCompleteness(workbenchId, wb.work_type_id),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/api/archive/values/:workbenchId', async (req, reply) => {
    try {
      const workbenchId = intParam(req, 'workbenchId');
      const wb = getWorkbench(workbenchId);
      if (!wb) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      const b = body(req);
      const patch = (b.values && typeof b.values === 'object' ? b.values : b) as Record<string, unknown>;
      const values = writeArchiveValues(workbenchId, patch);
      return ok(reply, { values, completeness: archiveCompleteness(workbenchId, wb.work_type_id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ============================== 变量解析预览 ============================== */

  /**
   * 看某份模板在这个工作台下，哪些变量能自动带出、哪些要填。
   * body/query 二选一给 templateId，workbenchId 可选（不给就只看系统变量）。
   */
  app.get('/api/archive/resolve', async (req, reply) => {
    try {
      const templateId = qInt(req, 'templateId');
      if (!templateId) throw new ApiError('MISSING_FIELD', '需要 templateId');
      const workbenchId = qInt(req, 'workbenchId') ?? null;
      const positionCode = q(req, 'positionCode') ?? null;
      const t = getTemplate(templateId);
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const names = await templateVarNames(templateId);
      const wb = workbenchId ? getWorkbench(workbenchId) : undefined;
      const r = resolveTemplateVars(names, workbenchId, t.work_type_id ?? wb?.work_type_id ?? null, positionCode);
      return ok(reply, {
        template: { id: t.id, name: t.name },
        ...r,
        /** 已映射到档案字段、但档案里没填的变量 —— 提示用户去补档案 */
        needArchive: r.resolved.filter((x) => x.from === 'mapped-empty').map((x) => ({ name: x.name, fieldKey: x.fieldKey })),
        /** 没有任何映射的变量 —— 只能手工填或让 AI 写 */
        unmapped: r.resolved.filter((x) => x.from === 'unmapped').map((x) => x.name),
        summary: {
          total: r.resolved.length,
          filled: r.autoCount,
          mappedEmpty: r.resolved.filter((x) => x.from === 'mapped-empty').length,
          unmapped: r.resolved.filter((x) => x.from === 'unmapped').length,
        },
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ============================== 从资料抽取项目信息 ============================== */

  /**
   * 从已归档的资料里抽项目信息。
   *
   * 抽取值**不落盘**，只返回给你确认 —— 这是「AI 只提案」原则在抽取上的落点。
   * 确认走 POST /api/archive/extract/confirm。
   */
  app.post('/api/archive/extract/artifact', async (req, reply) => {
    try {
      const b = body(req);
      const workbenchId = optNum(b, 'workbenchId');
      const artifactId = optNum(b, 'artifactId');
      if (!workbenchId) throw new ApiError('MISSING_FIELD', '需要 workbenchId');
      if (!artifactId) throw new ApiError('MISSING_FIELD', '需要 artifactId');
      const art = get<{ id: number; file_rel: string; file_name: string; workbench_id: number | null }>(
        // 回收站里的文件（软删除）不再参与抽取：deleted_at IS NULL
        `SELECT id, file_rel, file_name, workbench_id FROM artifact
          WHERE id = ? AND ${liveFilter('artifact')} /* deleted_at IS NULL */`,
        [artifactId],
      );
      if (!art) throw new ApiError('NOT_FOUND', '文件不存在', 404);
      const abs = join(DATA_ROOT, art.file_rel);
      if (!existsSync(abs)) throw new ApiError('FILE_MISSING', `文件已不在磁盘上：${art.file_rel}`, 404);

      const r = await extractProjectInfo({
        workbenchId,
        absPath: abs,
        fileName: art.file_name,
        fieldKeys: strArray(b, 'fieldKeys'),
        model: optStr(b, 'model'),
        maxTokens: optNum(b, 'maxTokens'),
      });
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 直接上传一份资料并抽取（不归档，用完即弃）。
   * 适合「手上刚拿到合同，先读一遍把项目信息填了」的场景。
   */
  app.post('/api/archive/extract/upload', async (req, reply) => {
    const files: SavedUpload[] = [];
    try {
      const { fields, files: fs } = await readParts(req);
      files.push(...fs);
      if (!files.length) throw new ApiError('NO_FILE', '没有收到文件');
      const workbenchId = Number(fields.workbenchId ?? '');
      if (!Number.isFinite(workbenchId) || !workbenchId) throw new ApiError('MISSING_FIELD', '需要 workbenchId');

      const f = files[0] as SavedUpload;
      const r = await extractProjectInfo({
        workbenchId,
        absPath: f.tempPath,
        fileName: f.fileName,
        fieldKeys: fields.fieldKeys ? fields.fieldKeys.split(/[,，\s]+/).filter(Boolean) : undefined,
        model: fields.model || undefined,
      });
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    } finally {
      for (const f of files) cleanupTemp(f.tempPath);
    }
  });

  /** 把确认过的抽取值写进项目信息 */
  app.post('/api/archive/extract/confirm', async (req, reply) => {
    try {
      const b = body(req);
      const workbenchId = optNum(b, 'workbenchId');
      if (!workbenchId) throw new ApiError('MISSING_FIELD', '需要 workbenchId');
      const wb = getWorkbench(workbenchId);
      if (!wb) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      const accepted = (b.accepted && typeof b.accepted === 'object' ? b.accepted : {}) as Record<string, string>;
      const r = confirmExtraction(workbenchId, accepted);
      return ok(reply, { ...r, completeness: archiveCompleteness(workbenchId, wb.work_type_id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ============================== AI 提议 ============================== */

  app.get('/api/archive/proposals', async (req, reply) => {
    try {
      return ok(reply, {
        items: listProposals({
          workTypeId: qInt(req, 'workTypeId') ?? null,
          status: q(req, 'status') ?? 'pending',
          batchId: q(req, 'batchId'),
        }).map((p) => {
          let payload: unknown = null;
          try {
            payload = JSON.parse(p.payload);
          } catch {
            /* 坏 JSON 原样返回 */
          }
          return { ...p, payload };
        }),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/archive/proposals/:id/accept', async (req, reply) => {
    try {
      const r = acceptProposal(intParam(req, 'id'), { force: optBool(body(req), 'force') === 1 });
      if (!r.ok) throw new ApiError('REFUSED', r.message);
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/archive/proposals/:id/reject', async (req, reply) => {
    try {
      rejectProposal(intParam(req, 'id'));
      return ok(reply, { rejected: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/archive/proposals/batch/:batchId/accept', async (req, reply) => {
    try {
      const batchId = (req.params as { batchId: string }).batchId;
      return ok(reply, acceptBatch(batchId));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 按条件批量采纳（不限于同一批次）—— 界面上「全部采纳」用 */
  app.post('/api/archive/proposals/accept-all', async (req, reply) => {
    try {
      const b = body(req);
      const workTypeId = optNum(b, 'workTypeId') ?? null;
      const kind = optStr(b, 'kind');
      const items = listProposals({ workTypeId, status: 'pending' }).filter((p) => !kind || p.kind === kind);
      let accepted = 0;
      const failed: { id: number; message: string }[] = [];
      for (const it of items) {
        const r = acceptProposal(it.id);
        if (r.ok) accepted += 1;
        else failed.push({ id: it.id, message: r.message });
      }
      return ok(reply, { accepted, failed });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 按条件批量拒绝 —— 界面上「全部忽略」用 */
  app.post('/api/archive/proposals/reject-all', async (req, reply) => {
    try {
      const b = body(req);
      const workTypeId = optNum(b, 'workTypeId') ?? null;
      const kind = optStr(b, 'kind');
      const items = listProposals({ workTypeId, status: 'pending' }).filter((p) => !kind || p.kind === kind);
      for (const it of items) rejectProposal(it.id);
      return ok(reply, { rejected: items.length });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 让运行中的模型梳理档案：读一批模板的变量，提议「该建哪些档案字段」「哪些变量映射到哪个字段」。
   *
   * 产出全部落进 archive_proposal（pending），不直接改档案 —— 用户确认后才生效。
   */
  app.post('/api/archive/analyze', async (req, reply) => {
    try {
      const b = body(req);
      const workTypeId = optNum(b, 'workTypeId') ?? null;
      const templateIds = (Array.isArray(b.templateIds) ? b.templateIds : [])
        .map((x) => Number(x))
        .filter(Number.isFinite);

      // 没指定就取该工作类型（或全部）的模板
      const rows = templateIds.length
        ? all<{ id: number; name: string; variable_count: number }>(
            `SELECT id, name, variable_count FROM template WHERE id IN (${templateIds.map(() => '?').join(',')})`,
            templateIds,
          )
        : all<{ id: number; name: string; variable_count: number }>(
            `SELECT id, name, variable_count FROM template
              WHERE archived_at IS NULL ${workTypeId ? 'AND work_type_id = ?' : ''}
              ORDER BY work_type_id, id`,
            workTypeId ? [workTypeId] : [],
          );
      if (!rows.length) throw new ApiError('NO_TEMPLATE', '没有可分析的模板');

      // 汇总变量 → 出现在哪些模板（复用度高的优先做字段）
      const varMap = new Map<string, string[]>();
      for (const t of rows) {
        let names: string[] = [];
        try {
          names = await templateVarNames(t.id);
        } catch {
          continue;
        }
        for (const n of names) {
          if (!varMap.has(n)) varMap.set(n, []);
          (varMap.get(n) as string[]).push(t.name);
        }
      }

      const existingFields = listArchiveFields(workTypeId);
      const existingAliases = listArchiveAliases(workTypeId);
      const knownVars = new Set(varMap.keys());
      const mapped = new Set(existingAliases.map((a) => a.var_name));
      const existingKeys = new Set(existingFields.map((f) => f.field_key));
      // 已由系统自动填的变量名（映射到 _ 开头的系统键），AI 不得改动
      const systemVars = new Set(
        existingAliases.filter((a) => a.field_key.startsWith('_')).map((a) => a.var_name),
      );

      // 按变量数分批：一批太多时模型输出会撞 max_tokens 被截断
      const batchSize = Math.max(20, Math.min(120, optNum(b, 'batchSize') ?? 60));
      const entries = [...varMap.entries()].sort((a, b2) => b2[1].length - a[1].length);
      const batches: [string, string[]][][] = [];
      for (let i = 0; i < entries.length; i += batchSize) batches.push(entries.slice(i, i + batchSize));

      const batchId = `an-${Date.now().toString(36)}`;
      const items: Parameters<typeof createProposals>[0] = [];
      const perBatch: { vars: number; proposals: number; truncated: boolean; error?: string }[] = [];
      let usageTotal = { prompt: 0, output: 0 };
      let lastModel = '';

      for (const chunk of batches) {
        const subMap = new Map(chunk);
        const r = await analyzeBatch({
          rows, varMap: subMap, existingFields, knownVars, mapped, existingKeys, systemVars,
          model: optStr(b, 'model'),
          maxTokens: optNum(b, 'maxTokens') ?? 16384,
          workTypeId,
        });
        if (r.usage) {
          usageTotal.prompt += r.usage.prompt;
          usageTotal.output += r.usage.output;
        }
        for (const p of r.proposals) {
          items.push({
            workTypeId, kind: p.kind, batchId,
            payload: p.payload,
            source: `AI 梳理（${rows.length} 份模板，${batches.length} 批）`,
            reason: p.reason,
          });
        }
        perBatch.push({ vars: subMap.size, proposals: r.proposals.length, truncated: r.truncated, error: r.error });
      }

      const created = createProposals(items);
      return ok(reply, {
        ok: true,
        batchId,
        created,
        analyzedTemplates: rows.length,
        distinctVars: varMap.size,
        batches: perBatch,
        usage: usageTotal,
        /** 有任一被截断就提示：提议可能不全，可调大 maxTokens 或调小 batchSize 再跑 */
        truncated: perBatch.some((p) => p.truncated),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ============================== 模板变量覆盖率 ============================== */

  /**
   * 覆盖率看板的数据。
   *
   * 口径（与运行时解析链同源，细节见 core/coverage.ts 的模块注释）：
   *   已映射 = 在「档案字段都填了」的探针下，resolveVariable 能取到非空值。
   * 两个数字都给：加权（按出现次数，头号数字）与去重（按变量名）。
   *
   * 查询参数：includeArchived=1 连归档模板一起算；workTypeId=N 只看某类（含通用模板）；
   *          worst=N / top=N 控制「最差模板」「最该补的变量」条数。
   */
  app.get('/api/coverage', async (req, reply) => {
    try {
      const workTypeId = qInt(req, 'workTypeId') ?? null;
      return ok(
        reply,
        computeCoverage({
          includeArchived: qBool(req, 'includeArchived') === true,
          workTypeId: workTypeId && workTypeId > 0 ? workTypeId : null,
          worstLimit: qInt(req, 'worst') ?? 10,
          topN: qInt(req, 'top') ?? 20,
        }),
      );
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 未映射变量清单 —— 给人 / AI 去补别名的行动清单。
   * ?workTypeId=&limit=&sort=count|name&includeArchived=
   */
  app.get('/api/coverage/unmapped', async (req, reply) => {
    try {
      const workTypeId = qInt(req, 'workTypeId') ?? null;
      const r = listUnmapped({
        includeArchived: qBool(req, 'includeArchived') === true,
        workTypeId: workTypeId && workTypeId > 0 ? workTypeId : null,
        sort: q(req, 'sort') === 'name' ? 'name' : 'count',
        limit: Math.max(1, Math.min(500, qInt(req, 'limit') ?? 100)),
      });
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 为若干未映射变量生成「建议别名」。
   *
   * **dryRun：本接口一个字节都不写库。** 建议只是给人看的，
   * 用户确认后由前端调 POST /api/archive/aliases 落盘（那条路已有，且会写入 confidence='manual'）。
   *
   * 先走规则（变量名与档案字段名/称谓高度相似），再（可选）让模型判一遍；
   * 模型没配、超时、返回垃圾、甚至本地测试模式禁网，都只是**降级为规则建议**，绝不 500。
   * 每条建议都带 source（rule / ai）与 confidence（high / medium / low）。
   */
  app.post('/api/coverage/suggest', async (req, reply) => {
    try {
      const b = body(req);
      const workTypeId = optNum(b, 'workTypeId') ?? null;
      const rawList = Array.isArray(b.vars) ? b.vars : Array.isArray(b.names) ? b.names : [];
      const vars = [
        ...new Set(
          rawList
            .map((x) => (typeof x === 'string' ? x : String((x as { name?: unknown })?.name ?? '')))
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ];
      if (!vars.length) throw new ApiError('MISSING_FIELD', '需要 vars：要建议别名的变量名数组');
      const limit = Math.max(1, Math.min(50, optNum(b, 'limit') ?? 20));
      const wanted = vars.slice(0, limit);

      const candidates = loadSuggestCandidates(workTypeId);
      // ① 规则建议（不依赖任何外部服务，永远有）
      const ruleMap = new Map<string, AliasSuggestion>();
      for (const v of wanted) {
        const s = ruleSuggestAlias(v, candidates);
        if (s) ruleMap.set(v, s);
      }

      // ② 可选：让模型判一遍。用途只允许 extract / reasoning（都在 ai_profile 里）
      const wantAi = optBool(b, 'ai') !== 0;
      const reqPurpose = optStr(b, 'purpose');
      const first: AiPurpose = reqPurpose === 'reasoning' ? 'reasoning' : 'extract';
      const second: AiPurpose = first === 'extract' ? 'reasoning' : 'extract';
      const ai: {
        attempted: boolean;
        ok: boolean;
        purpose: string;
        model?: string;
        error?: string;
        returned?: number;
        dropped?: string[];
        usage?: { prompt: number; output: number };
      } = { attempted: false, ok: false, purpose: first };
      const aiMap = new Map<string, AliasSuggestion>();

      if (wantAi && candidates.length) {
        let purpose = first;
        let ready = aiReadiness(first);
        if (!ready.ready) {
          const alt = aiReadiness(second);
          if (alt.ready) {
            purpose = second;
            ready = alt;
          }
        }
        ai.purpose = purpose;
        if (!ready.ready) {
          // 没配模型 = 正常情况（本地工作台允许完全不接模型），不是错误
          ai.error = `未启用 AI 建议（${ready.reason ?? '模型未配置'}），已只给规则建议`;
        } else {
          ai.attempted = true;
          const inventory = wanted.map((v) => `${v}｜${ruleMap.get(v)?.fieldKey ?? '—'}`).join('\n');
          const fieldLines = candidates
            .map((c) => `${c.fieldKey}=${c.label}${c.labelAliases.length > 1 ? `（称谓：${c.labelAliases.join('/')}）` : ''}`)
            .join('; ');
          const instruction = [
            '把模板里还没映射的 {变量} 归到已有的「档案字段」上。',
            '',
            '【现有档案字段】（**只能从这里选**，不许造新字段）',
            fieldLines,
            '',
            '【待归类的变量】格式：变量名｜规则初步猜测（— 表示没猜到）',
            inventory,
            '',
            '【任务】为每个变量挑一个语义相同的档案字段。同义关系如「甲方/发包人/建设单位」「签订日期/签署日期」。',
            '排除：编号式明细（设备1名称、交付物2数量这类带序号的）、每份各不相同的正文。',
            '没有把握就**不要输出这一条**，宁缺勿错。',
            '',
            '【输出】只输出 JSON，不要解释文字，不要代码围栏：',
            '{"aliases":[{"v":"变量名","k":"field_key","c":"high","r":"一句话理由"}]}',
            'c 取值 high|medium|low，表示你有多少把握。',
          ].join('\n');
          const res = await chat({
            purpose,
            json: true,
            maxTokens: optNum(b, 'maxTokens') ?? 4096,
            model: optStr(b, 'model'),
            messages: [
              { role: 'system', content: '你是严谨的信息架构助手，只做同义归类，只输出紧凑 JSON，不编造字段标识。' },
              { role: 'user', content: instruction },
            ],
            ref: { type: 'coverage-suggest', id: workTypeId ?? 0 },
          });
          ai.usage = { prompt: res.usage.prompt, output: res.usage.output };
          if (!res.ok) {
            ai.error = res.error ?? '模型调用失败';
          } else {
            const parsed = parseJsonLoose<{ aliases?: unknown[] }>(res.text);
            if (!parsed.ok || !parsed.value) {
              ai.error = '模型返回的不是合法 JSON';
            } else {
              const knownFields = new Map(candidates.map((c) => [c.fieldKey, c]));
              const allowedVars = new Set(wanted);
              const dropped: string[] = [];
              for (const raw of parsed.value.aliases ?? []) {
                const a = raw as Record<string, unknown>;
                const v = String(a.v ?? a.var_name ?? '').trim();
                const k = String(a.k ?? a.field_key ?? '').trim();
                if (!allowedVars.has(v)) {
                  dropped.push(`${v || '(空)'}：不在待建议清单里`);
                  continue;
                }
                const f = knownFields.get(k);
                if (!f) {
                  dropped.push(`${v}→${k || '(空)'}：字段不存在（只能映射到已有字段）`);
                  continue;
                }
                const c = String(a.c ?? a.confidence ?? '').toLowerCase();
                const confidence: AliasSuggestion['confidence'] = c === 'high' || c === 'low' ? c : 'medium';
                aiMap.set(v, {
                  varName: v,
                  fieldKey: f.fieldKey,
                  label: f.label,
                  source: 'ai',
                  confidence,
                  reason: String(a.r ?? a.reason ?? '模型按语义归类').slice(0, 200),
                  rule: ruleMap.get(v)
                    ? {
                        fieldKey: (ruleMap.get(v) as AliasSuggestion).fieldKey,
                        label: (ruleMap.get(v) as AliasSuggestion).label,
                        confidence: (ruleMap.get(v) as AliasSuggestion).confidence,
                        reason: (ruleMap.get(v) as AliasSuggestion).reason,
                      }
                    : null,
                });
              }
              ai.ok = true;
              ai.returned = aiMap.size;
              ai.model = res.model;
              if (dropped.length) ai.dropped = dropped.slice(0, 10);
            }
          }
        }
      } else if (!candidates.length) {
        ai.error = '该工作类型没有任何档案字段可映射，先去「流程规范 → 项目信息」建字段';
      }

      // ③ 合并：模型优先，没给就用规则；一条都没有的变量列进 notSuggested
      const suggestions: AliasSuggestion[] = [];
      const notSuggested: string[] = [];
      for (const v of wanted) {
        const picked = aiMap.get(v) ?? ruleMap.get(v);
        if (picked) suggestions.push(picked);
        else notSuggested.push(v);
      }

      return ok(reply, {
        dryRun: true,
        workTypeId,
        /** 本接口只返回建议，落库请调 POST /api/archive/aliases */
        suggestions,
        notSuggested,
        candidateFields: candidates.length,
        ai,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
