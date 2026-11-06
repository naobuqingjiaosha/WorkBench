import {assertInstanceTemplate} from './service.ts';
import {templateGenerationScope} from './service.ts';
import {requireInspection,inspectionFields,documentPeriodKey,assertInspectionRevision,assertInspectionScope,inspectionSourceSignature} from './inspections.ts';
import { collectWorkContext } from './work-context.ts';
import {withDocumentWrite} from './document-write.ts';
import {documentSourceSignature} from './document-source.ts';
import {readArtifactEvidence} from '../core/evidence-file.ts';
import { inheritBusinessEvidence } from './business-evidence.ts';
import { reviewMemoryFacts, assertFactReview, type FactChoice } from './memory-facts.ts';
import { assertFinalBytes } from './finalization.ts';
import { assertPeriodContext,assertGenerationScope,resolvePeriodResultTarget,periodResultHead } from './periods.ts';
/**
 * 生成服务 —— 把"模板 + 资料 + 大模型"串成一条闭环
 *
 *   AI 生成变量  →  人工确认  →  填充模板  →  落盘存档  →  登记 artifact
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import PizZip from '../core/office-package.ts';
import ExcelJS from 'exceljs';
import {OPTIONAL_EMPTY} from '../core/placeholders.ts';
import { get, run, tx } from '../db/index.ts';
import { chat, parseJsonLoose } from '../ai/gateway.ts';
import { DATA_ROOT, DIRS, RUNTIME_ROOT } from '../core/config.ts';
import { dateOnly, ensureDir, generatedFileName, safeName, stamp, toPosix } from '../core/paths.ts';
import {
  canRender,
  checkTemplateHealth,
  detectFormat,
  renderTemplate,
  ROW_NUMBER_AT,
  ROW_NUMBER_PLAIN,
  scanTemplate,
  scanTemplateStructure,
  type RenderAssets,
  type RenderImageAsset,
  type TemplateFormat,
  type TemplateStructure,
} from '../core/template.ts';
import { artifactAbsPath, artifactReferenceText, getArtifact, listArtifacts, saveArtifact, type Artifact } from '../core/store.ts';import {
  buildNativeContext,
  collectReferenceText,
  getTemplate,
  getWorkbench,
  getWorkbenchDetail,
  recalcProgress,
  readTemplateVars,
  refreshTemplateHealth,
  templateAbsPath,
  workbenchOutputDirAbs,
  type Template,
  type TemplateVarSpec,
} from './service.ts';
import { buildArchiveContext, readArchiveValues, resolveLoopItem } from './archive.ts';
import { relevantMemories } from './agent.ts';
import { requirePeriod, event,assertPeriodTemplate,periodNativeFields } from './periods.ts';
import { ApiError } from '../api/reply.ts';
import { evidenceContextFor, isReviewableImage } from '../core/vision.ts';
import { buildKnowledgeQuery, formatKnowledgeForPrompt, searchKnowledge } from '../core/knowledge.ts';
import { type PolicyRequirement } from './policy-requirements.ts';
import { requestsPolicyReference } from './policy-reference.ts';
import {
  archiveHeadForVersion,
  commitVersionSave,
  ensureDocVersionSchema,
  finalBlockerOf,
  findChainHead,
  planVersionSave,
  resolvePeriodKey,
  rollbackArchive,
  VersionRuleError,
  writeGenerationLog,
  type ArchiveMove,
  type SaveMode,
  type VersionedArtifact,
} from './versions.ts';

/* ------------------------- 循环 / 图片：素材准备 ------------------------- */

/**
 * 「照片集合」的通用叫法。模板里写这些名字时，不需要谁手填数据 ——
 * 直接拿该工作台（或该阶段）的影像证据当集合，一行一张照片。
 */
const PHOTO_COLLECTION_NAMES = ['现场照片', '照片', '影像', '影像证据', '图片', '照片列表'];

/**
 * 「照片 / 图片」这类**通用叫法**：模板里只写一个泛称时，渲染器按序取本工作台的第 1 张
 * （`core/template.ts` 的 `GENERIC_IMAGE_NAMES` 语义）。这类名字不算"缺图"，
 * 因为用户本来就没点名要哪一张；本工作台一张影像都没有时，渲染器照样会回报"未能插入"。
 */
const GENERIC_PHOTO_NAMES = /^(现场照片|照片|影像|影像证据|图片|照片列表|图像|photo|image|picture)$/i;

/** 影像证据 → `{@图片}` 能用的素材（别名给「标题 / 文件名 / 去扩展名的文件名」，三种都能匹配上） */
function imageAssetsFrom(artifacts: Artifact[]): RenderImageAsset[] {
  const out: RenderImageAsset[] = [];
  const seen = new Set<number>();
  for (const a of artifacts) {
    if (!isReviewableImage(a)) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const stem = a.file_name.replace(/\.[a-z0-9]+$/i, '');
    const names = [a.title, a.file_name, stem].filter((x): x is string => Boolean(x && String(x).trim()));
    if (!names.length) continue;
    out.push({ label: (a.title || a.file_name).trim(), names, index: out.length + 1, absPath: artifactAbsPath(a) });
  }
  return out;
}

/**
 * 渲染素材：可插入的图片 + 「照片类集合」的兜底数据。
 *
 * 图片来源按现有影像证据机制取：
 *   · 有工作台 → 该工作台的影像证据，**本阶段的排前面**（`{@图片 1}` 这类按序号取才符合预期）；
 *   · **没有工作台 → 一张图都不给**（缺陷修复：以前会"全库按名字子串找"，
 *     于是 A 的文书里会插进 B 的照片）。找不到就如实回报「未能插入」，绝不跨工作台取图。
 */
function buildRenderAssets(
  opts: {
    absPath: string;
    workbenchId: number | null;
    periodId?: number | null;
  inspectionId?:number|null;
  inspectionRevision?:number|null;
    positionCode: string | null;
    values: Record<string, unknown>;
    structure?: TemplateStructure;
  },
  /**
   * 出参：本工作台里确实找不到的图片名（沿既有 `missingImages` 通道如实报告）。
   * 用出参而不是给 `RenderAssets` 加字段，是因为那个接口在 `core/template.ts`
   * （本次改动范围之外），渲染器也不认识这个信息。
   */
  missingNames?: string[],
): RenderAssets {
  const structure = opts.structure ?? scanTemplateStructure(opts.absPath);
  const picked: Artifact[] = [];
  const pickedIds = new Set<number>();
  const take = (list: Artifact[]): void => {
    for (const a of list) {
      if (pickedIds.has(a.id)) continue;
      pickedIds.add(a.id);
      picked.push(a);
    }
  };

  if (opts.workbenchId) {
    if(opts.periodId)requirePeriod(opts.periodId,opts.workbenchId);
    const wbEvidence = listArtifacts({ workbenchId: opts.workbenchId, kind: 'evidence', limit: 500 }).items.filter(a=>{
      const scoped=a as Artifact & {work_period_id?:number;inspection_id?:number};
      return (!opts.periodId||scoped.work_period_id===opts.periodId) && (!opts.inspectionId||scoped.inspection_id===opts.inspectionId);
    });
    if (opts.positionCode) {
      take(wbEvidence.filter((a) => a.position_code === opts.positionCode));
      take(wbEvidence.filter((a) => a.position_code !== opts.positionCode));
    } else {
      take(wbEvidence);
    }
  }

  /**
   * 【影像素材只允许来自指定工作台（及其阶段）—— 缺陷修复：不再"全库按名字找"】
   *
   * 改造前这里在"本工作台没有该名影像"时会 `listArtifacts({limit:500})` 全库兜底，
   * 而且是**子串**匹配，后果有两个，都实测过：
   *   · A 的文书里插进 B 的照片（跨工作台取图，最严重）；
   *   · 「门厅照片」命中「门厅照片2」这类近似名。
   * 现在：池子里**只有本工作台的影像**（`picked` 已经装好），
   * 没有 workbenchId 时池子是空的 —— 宁可按"图片缺失"如实报告，也不跨库取图。
   *
   * 匹配口径（口径①优先，口径②限定在本工作台内并明确标注）：
   *   ① **精确匹配**（标题 / 文件名 / 去扩展名的文件名，大小写不敏感）；
   *   ② 仍允许"近似名"（子串）兜底，但**只在同一工作台内**选，且标签上如实写
   *      「按近似名匹配」—— 用户看预览图注就知道这不是他点名的那张照片。
   *      保留②的理由：模板里常写「现场照片」而影像标题是「现场照片-东侧」，
   *      一刀切成"缺失"会让本来正确的照片插不进去；而"跨工作台"这条真正的缺陷
   *      由"池子只有本工作台"从结构上堵死。
   */
  const scopeNames = (a: Artifact): string[] => [a.title, a.file_name, a.file_name.replace(/\.[a-z0-9]+$/i, '')].filter(Boolean) as string[];
  const wanted = new Set<string>(structure.images.map((i) => i.name));
  for (const [k, v] of Object.entries(opts.values)) {
    if (!/照片|图片|影像|photo/i.test(k)) continue;
    if (typeof v === 'string' && v.trim() && !v.trim().startsWith('[')) wanted.add(v.trim());
  }
  const exactHit = (a: Artifact, name: string): boolean =>
    scopeNames(a).some((x) => x.toLowerCase() === name.toLowerCase());
  const images0 = imageAssetsFrom(picked);
  const wantsExact = (n: string): boolean => images0.some((a) => a.names.some((x) => x.toLowerCase() === n.toLowerCase()));
  const missingNames0 = [...wanted].filter((n) => !wantsExact(n));
  /** 本次"按近似名匹配"用了哪几张、为的是哪个名字（标签与说明都要如实写出来） */
  const approxOf = new Map<number, string>();
  if (missingNames0.length) {
    const pool = picked.filter((a) => isReviewableImage(a));
    for (const name of missingNames0) {
      // ② 近似名兜底：**只在本工作台的影像里**找，找到了也要在标签上说清是"按近似名匹配"
      const hit = pool.find(
        (a) => !exactHit(a, name) && scopeNames(a).some((x) => x.toLowerCase().includes(name.toLowerCase())),
      );
      if (!hit) continue;
      take([hit]);
      approxOf.set(hit.id, name);
    }
  }
  /**
   * 本工作台里确实找不到的图片名：如实回报（沿既有 `missingImages` 通道），
   * 由界面显示"缺哪张、在哪个工作台没找到" —— 绝不静默换成别的照片。
   */
  {
    const finalImages = imageAssetsFrom(picked);
    const where = opts.workbenchId
      ? `工作台 #${opts.workbenchId}${opts.positionCode ? ` 的阶段 ${opts.positionCode}` : ''}`
      : '本次请求（没有指定工作台）';
    for (const name of wanted) {
      if (finalImages.some((a) => a.names.some((x) => x.toLowerCase() === name.toLowerCase()))) continue;
      if (finalImages.some((a) => a.names.some((x) => x.toLowerCase().includes(name.toLowerCase())))) continue;
      if (GENERIC_PHOTO_NAMES.test(name)) continue; // 「照片」这类通用叫法由渲染器按序取第 1 张
      missingNames?.push(`${name}（${where}的影像里没有找到；没有拿别的工作台或别的照片代替）`);
    }
  }

  const images = imageAssetsFrom(picked);
  /** 按绝对路径回认"这张图是按近似名匹配来的"，在集合项的显示名里如实标注 */
  const labelOf = (a: { absPath: string; label: string }): string => {
    for (const [id, wantedName] of approxOf) {
      const art = picked.find((p) => p.id === id);
      if (!art) continue;
      try {
        if (artifactAbsPath(art) === a.absPath) return `${a.label}（按近似名匹配「${wantedName}」）`;
      } catch {
        /* 定位不到就不标注（这条记录本来就已经打不开） */
      }
    }
    return a.label;
  };
  const collections: Record<string, unknown[]> = {};
  if (images.length) {
    const items = images.map((a) => ({
      序号: a.index,
      名称: labelOf(a),
      文件名: a.names[1] ?? a.label,
      照片: a.names[1] ?? a.label,
      图片: a.names[1] ?? a.label,
    }));
    for (const n of PHOTO_COLLECTION_NAMES) collections[n] = items;
    // 模板里自定义的集合名，只要语义像照片，也给同样的兜底
    for (const c of structure.collections) {
      if (!(c.name in collections) && /照片|图片|影像|photo/i.test(c.name)) collections[c.name] = items;
    }
  }
  return { images, collections };
}

/**
 * 循环集合的每一项：按循环体里用到的字段名，用「当前项 + 档案/工作台字段」补齐。
 *
 * 循环项通常只有「名称/数量」，而「单位」这类字段档案里就有。
 * 解析走 archive.resolveVariable 的**显式 item 参数**（不是全局状态），
 * 项里有值就用项里的，没有才回落，因此绝不会覆盖数据本身。
 */
function enrichCollections(
  values: Record<string, unknown>,
  structure: TemplateStructure,
  ctx: { workTypeId: number | null; archive: Record<string, string>; native: Record<string, unknown> },
): { values: Record<string, unknown>; filled: number } {
  if (!structure.collections.length) return { values, filled: 0 };
  const out: Record<string, unknown> = { ...values };
  let filled = 0;
  for (const c of structure.collections) {
    const cur = out[c.name];
    const asText = typeof cur === 'string';
    let items: unknown[] | null = Array.isArray(cur) ? cur : null;
    if (!items && asText) {
      try {
        const parsed: unknown = JSON.parse(String(cur).trim() || '[]');
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        items = null;
      }
    }
    if (!items) continue;
    const next = items.map((it) => {
      const r = resolveLoopItem(c.fields, it, ctx);
      filled += r.filled.length;
      return r.item;
    });
    out[c.name] = asText ? JSON.stringify(next) : next;
  }
  return { values: out, filled };
}

/** 集合值（可能是数组，也可能是 JSON 文本）转成项数组，别的都算「没给数据」 */
function collectionItemsOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/** 集合值统一按 JSON 文本传给界面/落库（`GenerateResult.variables` 的契约是字符串） */
function toVariableValue(v: unknown): string {
  if (Array.isArray(v) || (v !== null && typeof v === 'object')) return JSON.stringify(v);
  return String(v);
}

/**
 * 坏模板拦截（三条路共用：draft / preview / save）。
 *
 * 背景：48 个在用模板里有 6 个源文件的 word/document.xml 被截断或少了闭合标签。
 * 这种文件 PizZip 照样能读、渲染照样返回字节，于是 draft/preview/save 全都"成功"，
 * 用户拿到一个 Word 打不开的文书，还以为是自己电脑的问题。
 * 现在只要校验标记为坏（health_ok === 0），三条路都在动手之前失败，给出能照着修的提示。
 *
 * 注意：`health_ok === null`（迁移之前的老数据、还没校验过）**不拦** ——
 * 不能因为"没校验"就挡住既有流程；这些模板一旦被校验就会被补上标记。
 *
 * 抛的是普通 Error + statusCode，`api/reply.ts` 的 fail() 认这个字段，
 * 所以接口回的是 400 + 可读中文，而不是 500「服务出错了」。
 */
function assertTemplateRenderable(t: Template): void {
  if (t.health_ok === null || t.health_ok === undefined) return;
  if (Number(t.health_ok) !== 0) return;
  const note = (t.health_note ?? '').trim() || '文件结构已损坏，Word 打不开';
  const err = new Error(
    `这个模板打不开（${note}），出文书前请先修好或重新上传：${t.name}`,
  ) as Error & { statusCode: number; code: string };
  err.statusCode = 400;
  err.code = 'TEMPLATE_BROKEN';
  throw err;
}

/**
 * 三条路统一的"取模板"入口：顺手把还没校验过的模板补一次校验。
 *
 * 按约定，`health_ok === NULL`（历史数据、还没校验过）**不拦** ——
 * 先照常走完这一次，但把校验结果写回 template 表，于是下一次就会被拦下。
 * 正常情况下轮不到这里：`listTemplates()` 首次列出模板时已经整库回填过了
 * （模板库页面、工作台绑定、生成选择器都会触发）。
 */
function templateForRender(templateId: number): Template | undefined {
  const t = getTemplate(templateId);
  if (!t) return undefined;
  if(t.usage_note?.startsWith('timesheet:'))throw new ApiError('TIMESHEET_REQUIRED','此模板须从部门工时入口生成，先核对人员项目、研发工时和考勤');
  if (t.health_ok === null || t.health_ok === undefined) {
    try {
      const h = refreshTemplateHealth(t);
      return { ...t, health_ok: h.ok ? 1 : 0, health_note: h.reason, health_checked_at: h.checkedAt };
    } catch {
      return t; // 校验本身出问题也不该拦住生成
    }
  }
  assertTemplateRenderable(t);
  return t;
}

export interface GenerateInput {
  periodId?: number | null;
  inspectionId?:number|null;
  inspectionRevision?:number|null;
  templateId: number;
  workbenchId?: number | null;
  positionCode?: string | null;
  /** 用户已有的信息，会作为权威值，AI 不得改动 */
  known?: Record<string, string>;
  /** 补充指令，例如"这次检查发现两处隐患：…" */
  instruction?: string;
  /** 要作为参考资料的 artifact id */
  referenceArtifactIds?: number[];
  /** 不走 AI，只用已知信息 + 上下文（用于手工填写） */
  skipAi?: boolean;
  model?: string;
}

export interface GenerateResult {
  sourceSignature?:string;
  contextSignature?:string;
  evidence?: Awaited<ReturnType<typeof collectWorkContext>>;
  ok: boolean;
  variables: Record<string, string>;
  specs: TemplateVarSpec[];
  missing: string[];
  /** 变量名 → 依据说明，帮助用户判断 AI 是否在编 */
  rationale: Record<string, string>;
  /** 变量名 → 值从哪来（系统/档案/工作台字段/待填），让用户知道哪些不用手填 */
  sources: Record<string, { from: string; via: string }>;
  /** 本轮检索到的制度正文及出处；选定模板独立用于填充。 */
  knowledge: { source: string; title: string; heading?: string | null; score: number; optional?: boolean; documentId?: number | null; snippet?: string; docNo?: string | null; retrieval?: string }[];
  /** 没查到依据的原因（语料为空 / 向量化未配置 / 检索报错），界面据此告诉你该去补什么 */
  knowledgeError?: string;
  warnings: string[];
  usage: { prompt: number; output: number; total: number };
  model: string;
  latencyMs: number;
  error?: string;
  rawText?: string;
}

function specLines(specs: TemplateVarSpec[], collectionNames: Set<string> = new Set()): string {
  return specs
    .map((s, i) => {
      const bits = [`${i + 1}. ${s.name}`];
      if (s.label && s.label !== s.name) bits.push(`（${s.label}）`);
      if (s.type && s.type !== 'text') bits.push(`[${s.type}]`);
      if (s.required === false) bits.push('（可留空）');
      /** 表格循环集合：值必须是数组，键名用循环体里的字段名 —— 这条不说明模型一定会给成一行文字 */
      if (collectionNames.has(s.name)) bits.push('【表格循环集合：值为数组，每个元素是一个对象，键名用该循环体里的字段名】');
      if (s.example) bits.push(`示例：${s.example}`);
      if (s.hint) bits.push(`说明：${s.hint}`);
      return bits.join('');
    })
    .join('\n');
}

/**
 * 生成变量取值。核心原则：不编造，缺信息留【待补：…】。
 */
export async function generateVariables(input: GenerateInput): Promise<GenerateResult> {
  const signature=()=>documentSourceSignature(input.workbenchId,input.periodId,input.templateId,input.referenceArtifactIds??[],input.inspectionId);
  const before=signature();
  const result=await generateVariablesCurrent(input);
  if(before!==signature())throw new ApiError('SOURCE_CHANGED','起草期间来源已变化，请重新起草；已填写内容保留',409);
  return {...result,sourceSignature:before,contextSignature:documentSourceSignature(input.workbenchId,input.periodId,input.templateId,[],input.inspectionId)};
}
async function generateVariablesCurrent(input: GenerateInput): Promise<GenerateResult> {
  assertPeriodContext(input.workbenchId, input.periodId);
  assertInspectionRevision(input.inspectionId,input.periodId,input.inspectionRevision);
  // 路径①draft：先拦坏模板，别等渲染完才发现文件打不开（也省掉一次模型调用）
  const t = templateForRender(input.templateId);
  if (!t) throw new Error('模板不存在');
  assertGenerationScope(t,input.workbenchId,input.positionCode,input.periodId);
  const varsFile = readTemplateVars(t);
  const specs = varsFile.variables;
  /**
   * 模板结构：循环集合与图片占位。
   *
   * 这两类写法在变量清单里和普通文字变量长得一样（名字而已），但取值方式完全不同：
   *   集合 → 值必须是数组（一行一项），图片 → 由影像证据自动插入、不该问模型要文字。
   * 结构只认一遍，后面提示词、漏填判定、循环项补字段都用它。
   */
  const structure = scanTemplateStructure(templateAbsPath(t));
  const collectionNames = new Set(structure.collections.map((c) => c.name));
  const imageNames = new Set(structure.images.map((i) => i.name));
  /** 图片不是「要人写的文字变量」，不进提示词、也不算漏填（缺图由渲染阶段如实回报） */
  const textSpecs = specs.filter((s) => !imageNames.has(s.name));
  const native = buildNativeContext(input.workbenchId ?? null, input.positionCode ?? null);
  const period = input.periodId ? requirePeriod(input.periodId,input.workbenchId) : null;
  assertInspectionScope(t,period,input.inspectionId);
  if(period)assertPeriodTemplate(period,t);
  else assertInstanceTemplate(input.workbenchId,input.positionCode,t);
  if(period && !input.workbenchId)throw new ApiError('WORK_REQUIRED','期次生成必须指定工作');
  if(period)Object.assign(native,periodNativeFields(period));
  Object.assign(native,inspectionFields(input.inspectionId,period?.id));
  const refArtifacts = (input.referenceArtifactIds ?? []).map((id) => getArtifact(id)).filter(Boolean) as Artifact[];
  if(refArtifacts.some(a=>(a.workbench_id!==null&&a.workbench_id!==input.workbenchId)|| (period&&(a as Artifact & {work_period_id?:number}).work_period_id!==period.id)))throw new ApiError('WRONG_REFERENCE','参考资料必须属于本工作及所选期次');
  /** 参考资料里的照片数。只用来在 skipAi 时给一句说明，本身不产生任何模型调用 */
  const photoCount = refArtifacts.filter((a) => isReviewableImage(a)).length;
  const refs = (await Promise.all(refArtifacts
    .filter((a) => !isReviewableImage(a))
    .map((a) => collectOneReference(a.id))))
    .filter(Boolean)
    .join('\n\n');
  const evidence = input.workbenchId ? await collectWorkContext(input.workbenchId,period?.id,input.referenceArtifactIds??[]) : undefined;
  const wbRef = input.inspectionId?inspectionFields(input.inspectionId,period?.id)['内容']:evidence?.text ?? '';
  if(input.inspectionId&&refArtifacts.some(a=>(a as Artifact&{inspection_id?:number}).inspection_id&&(a as Artifact&{inspection_id?:number}).inspection_id!==input.inspectionId))throw new ApiError('WRONG_REFERENCE','不能将另一次检查的成果作为本次检查资料');
  if(period&&!input.skipAi)event(period.id,'ai-evidence',JSON.stringify({sourcePeriodIds:evidence?.sourcePeriodIds,files:evidence?.sources.map(s=>({id:s.id,fileName:s.fileName,periodId:s.periodId})),warnings:evidence?.warnings}));

  const known = { ...(input.known ?? {}) };
  // ① 工作台原生字段（日期系统变量、旧表列）
  for (const [k, v] of Object.entries(native)) {
    if (!(k in known) && v !== '' && v !== null && v !== undefined) {
      known[k] = String(v);
    }
  }
  // ② 档案带入：按模板变量名走别名表取档案值，优先级高于原生字段
  const wb = input.workbenchId ? getWorkbench(input.workbenchId) : undefined;
  const { resolved } = buildArchiveContext(
    specs.map((s) => s.name),
    input.workbenchId ?? null,
    t.work_type_id ?? wb?.work_type_id ?? null,
    input.positionCode ?? null,
    {},
    period?periodNativeFields(period):{},
  );
  const sources: Record<string, { from: string; via: string }> = {};
  for (const r of resolved) {
    sources[r.name] = { from: r.from, via: r.via ?? '' };
    if (r.value === '') continue;
    // 用户显式给的值最优先，档案只补空缺
    if (input.known && input.known[r.name] !== undefined && String(input.known[r.name]).trim() !== '') continue;
    // Saved inspection/period records take precedence over general archive aliases.
    if ((input.inspectionId && Object.hasOwn(inspectionFields(input.inspectionId,period?.id),r.name)) || (period && Object.hasOwn(periodNativeFields(period),r.name))) continue;
    known[r.name] = r.value;
  }
  // 用户手填的键也记个来源，界面上能区分
  for (const k of Object.keys(input.known ?? {})) {
    if (!sources[k]) sources[k] = { from: 'input', via: '手工填写' };
  }

  // 模板正文也作为线索（有些模板自带示例文字）
  let preview = '';
  try {
    preview = (await scanTemplate(templateAbsPath(t))).preview.slice(0, 3000);
  } catch {
    /* 扫描失败不影响生成 */
  }

  /** 请求局部状态：生成结束即失效，不读模板的持久制度设置。 */
  let knowledgeBlock = '';
  let knowledgeHits: GenerateResult['knowledge'] = [];
  /** 检索失败的原因 —— 静默吞掉会让人以为「知识库没东西」，得说出来 */
  let knowledgeError: string | undefined;
  const policyRequirement: PolicyRequirement = { mode: requestsPolicyReference(input.instruction) ? 'reference' : 'off', documentIds: [] };
  if (policyRequirement.mode !== 'off' && !input.skipAi) {
    try {
      const q = buildKnowledgeQuery({ instruction: input.instruction, referenceText: refs, templateName: t.name });
      const kr = await searchKnowledge(q, { modules: ['policy'], budget: 5, documentIds: policyRequirement.documentIds,
        authorityOnly: false });
      if (kr.hits.length) {
        knowledgeBlock = formatKnowledgeForPrompt(kr.hits);
        knowledgeHits = kr.hits.map((h) => ({
          source: h.sourceLabel,
          title: h.title,
          heading: h.heading,
          score: h.score,
          optional: h.optional,
          documentId: h.documentId,
          snippet: h.snippet,
          docNo: h.docNo,
          retrieval: h.retrieval,
        }));
      }
      // 两个模块都没东西可依据时，把「为什么」带出去（语料为空 / 向量化未配置）
      knowledgeError = kr.error ?? (kr.hits.length ? undefined : kr.skipped ?? '没有找到与本次内容相关的制度条款，请指定适用制度或调整要求。');
    } catch (e) {
      knowledgeError = e instanceof Error ? e.message : String(e);
    }
  }


  /**
   * 备忘（AI 助手里交代过、但没有对应字段可以填的信息）。
   *
   * 用户的原话是「记下来，以后涉及到就直接给我正确的答案」—— 所以这里必须用上：
   * 出文书时把这份工作相关的备忘喂给模型，且明确"与备忘冲突由用户确认，本次确认事实优先"，
   * 否则记了等于没记。
   */
  const memories = input.workbenchId ? relevantMemories(input.workbenchId, `${input.instruction ?? ''} ${t.name}`, 8, input.periodId ?? null) : [];
  const memoryBlock = memories.map((m) => `- ${m.text}（记忆 #${m.id}；来源：${m.source || '未说明'}）${m.due_date ? `（期限 ${m.due_date}）` : ''}`).join('\n');

  /**
   * 「只按已知信息填入」必须在这里就返回。
   *
   * 以前这个分支排在下面（提示词拼装之后），而 `evidenceContextFor` 是无条件先调用的：
   * 于是用户点"按已知信息填入"，系统仍然逐张照片调**付费的视觉模型**、
   * 还往 `evidence_review` 插记录 —— 语义上完全不该发生。
   * 现在早退在取照片分析之前，skipAi 时只把"有几张照片没识别"写进提示，不调模型、不写库。
   */
  if (input.skipAi) {
    const variables: Record<string, string> = {};
    const missing: string[] = [];
    for (const s of specs) {
      if (imageNames.has(s.name)) continue; // 图片由影像证据自动插入，不算「没填」
      const v = known[s.name];
      if (v !== undefined && String(v).trim() !== '') variables[s.name] = toVariableValue(v);
      else missing.push(s.name);
    }
    // 也带上上下文里的额外键，方便模板里直接引用
    for (const [k, v] of Object.entries(known)) if (!(k in variables)) variables[k] = toVariableValue(v);
    // 循环项缺的字段按档案/工作台字段补齐（显式 item 上下文）
    const enriched = enrichCollections(variables, structure, {
      workTypeId: t.work_type_id ?? wb?.work_type_id ?? null,
      archive: input.workbenchId ? readArchiveValues(input.workbenchId) : {},
      native,
    });
    const skipWarnings: string[] = [];
    if (missing.length) skipWarnings.push(`有 ${missing.length} 项没有值，生成的文件里会原样保留 {变量名}，请手工补。`);
    skipWarnings.push(...collectionWarnings(enriched.values, structure, input.workbenchId !== null && input.workbenchId !== undefined));
    if (enriched.filled) skipWarnings.push(`循环项里有 ${enriched.filled} 个字段按项目信息/工作台字段自动补齐。`);
    if (photoCount) {
      skipWarnings.push(
        `参考资料含 ${photoCount} 张照片，本次「按已知信息填入」未做识别，照片内容不会写进文件；需要照片内容请改用 AI 生成。`,
      );
    }
    return {
      ok: true,
      variables: enriched.values as Record<string, string>,
      specs,
      missing,
      rationale: {},
      sources,
      knowledge: knowledgeHits,
      knowledgeError,
      evidence,
      warnings: [...skipWarnings,...(evidence?.warnings??[])],
      usage: { prompt: 0, output: 0, total: 0 },
      model: '（未调用模型）',
      latencyMs: 0,
    };
  }

  /**
   * 现场照片：写作模型（DeepSeek）看不了图，所以先让**视觉模型**看懂，
   * 再把"照片里拍到了什么"这段文字放进提示词。
   * 这样照片才真正参与写文书，而不是只在旁边躺着。
   * 位置在 skipAi 早退之后 —— 视觉识别是付费调用且会写 `evidence_review`，
   * 只有真的要调写作模型时才做。
   */
  const photoText = await evidenceContextFor(refArtifacts);

  const instruction = [
    `你是一名严谨的行政与项目文档助手，正在为「${t.name}」这份文档准备内容。`,
    '',
    '【必须填写的内容项】',
    specLines(textSpecs, collectionNames) || '（模板里没有扫描到变量，请根据模板正文判断需要哪些信息）',
    collectionNames.size
      ? `\n【表格循环说明】带「表格循环集合」字样的项，值必须是**数组**，每个元素是一个对象，键名用该循环体里的字段名（如 序号/名称/单位/数量）。行数按资料里的实际条目给，不要凑行、不要编条目；资料里没有任何条目时给空数组 []。\n`
      : '',
    imageNames.size
      ? `【图片说明】模板里的 ${[...imageNames].join('、')} 是图片位置，出文书时由系统从现场照片（影像证据）自动插入，你不用写它，也不要编造图片内容。\n`
      : '',
    '',
    '【已确认的事实信息】（这些是权威值，必须原样使用，不得改写）',
    Object.keys(known).length
      ? Object.entries(known)
          .map(([k, v]) => `- ${k}：${v}`)
          .join('\n')
      : '（暂无）',
    '',
    wbRef ? `【本项目已有资料节选】\n${wbRef}\n` : '',
    refs ? `【本次指定参考资料】\n${refs}\n` : '',
    photoText
      ? `【现场照片（由视觉模型识别，供你写内容时参考）】\n${photoText}\n注意：这是模型对照片的描述与判断，可能看错；涉及数字/编号时若照片里没明说，不要写具体值。\n`
      : '',
    memoryBlock ? `【已确认且仍有效的补充记忆】（不得覆盖本次确认事实；冲突时保留字段为空并在待补说明中列出双方来源，等待用户选择）\n${memoryBlock}\n` : '',
    knowledgeBlock
      ? `【检索到的制度规定】（仅说明应遵循的要求，不证明本次已经落实；标为外单位参考的内容不能当作本单位强制要求）\n${knowledgeBlock}\n`
      : '',
    preview ? `【选定模板的结构与格式】（固定示例、历史数字与套话不能作为本期事实或制度规定）\n${preview}\n` : '',
    input.instruction ? `【本次特别要求】\n${input.instruction}\n` : '',
    '【输出要求】',
    '1. 只输出一个 JSON 对象，不要任何解释文字，不要代码围栏。',
    '2. 键名必须与「必须填写的内容项」里的名称完全一致，不要增删。',
    '3. 值为字符串；需要多行时用 \\n 换行。',
    '4. 严禁编造数字、日期、人名、单位名、编号。资料里没有的信息，值写「【待补：说明需要补什么】」。',
    '5. 日期用 2026年3月15日 这样的中文写法；编号保持资料里的原样。',
    '6. 需要成段文字的地方（如"检查情况""结论意见"），写成通顺的公文语句，不要空泛套话。',
    '7. 每条内容都要有依据。',
    memoryBlock ? '8. 记忆只作补充；不得用记忆替换本期确认事实，不得把事实改写成符合制度的情况。' : '',
    knowledgeBlock
      ? `${memoryBlock ? '9' : '8'}. 涉及制度规定时只使用【检索到的制度规定】，准确引用《制度名》（文号）第N条；不得编造条号、不得把规定写成已完成的事实。`
      : '',
    collectionNames.size
      ? `${8 + (memoryBlock ? 1 : 0) + (knowledgeBlock ? 1 : 0)}. 「表格循环集合」项的值为 JSON 数组（不要写成字符串），每个元素对象的键名与循环体里的字段名一致；没有条目就给 []。`
      : '',
    '',
    '【额外输出】在 JSON 里额外加一个 "_依据" 字段，值为对象：键为变量名，值为该值来自哪条信息（如"来自已确认信息：负责人"，或"资料未提及，已留待补"）。',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: { role: 'system' | 'user'; content: string }[] = [
    { role: 'system', content: '你是严谨的公文与项目文档助手，输出严格 JSON，绝不编造事实。' },
    { role: 'user', content: instruction },
  ];
  let res = await chat({
    purpose: 'writing',
    json: true,
    model: input.model,
    messages,
    ref: { type: 'generate', id: input.templateId },
  });

  if (!res.ok) {
    return {
      ok: false,
      variables: known,
      specs,
      missing: specs.map((s) => s.name),
      rationale: {},
      sources,
      knowledge: knowledgeHits,
      knowledgeError,
      evidence,
      warnings: evidence?.warnings??[],
      usage: res.usage,
      model: res.model,
      latencyMs: res.latencyMs,
      error: res.error,
    };
  }

  let parsed = parseJsonLoose<Record<string, unknown>>(res.text);
  const warnings: string[] = [...(knowledgeError ? [knowledgeError] : []),...(evidence?.warnings??[])];
  /**
   * 模型偶尔（实测约十次里有一次）会不按格式来：把 JSON 包在解释文字里，
   * 或者干脆回一段话。这时候自动重问一次比起把原文甩给用户手工整理便宜得多 ——
   * 「稳定不出错」比省这一次调用重要。重试的 token 也计入用量，不藏起来。
   */
  if (!parsed.ok) {
    const retry = await chat({
      purpose: 'writing',
      json: true,
      model: input.model,
      messages: [
        ...messages,
        { role: 'assistant', content: res.text.slice(0, 2000) || '（空）' },
        { role: 'user', content: '上面这次输出不是合法 JSON。请重新输出，只要那个 JSON 对象本身：不要解释文字，不要代码围栏，键名与要求完全一致。' },
      ],
      ref: { type: 'generate-retry', id: input.templateId },
    });
    if (retry.ok) {
      res = {
        ...retry,
        usage: {
          prompt: res.usage.prompt + retry.usage.prompt,
          output: res.usage.output + retry.usage.output,
          total: res.usage.total + retry.usage.total,
        },
        latencyMs: res.latencyMs + retry.latencyMs,
      };
      parsed = parseJsonLoose<Record<string, unknown>>(retry.text);
      if (parsed.ok) warnings.push('模型第一次没按 JSON 格式返回，已自动重试成功（本次用量含两次调用）。');
    }
  }
  let values: Record<string, unknown> = {};
  if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
    values = parsed.value;
  } else {
    warnings.push('模型返回的内容不是合法 JSON（已自动重试一次仍不行），已把原文放在下方供你手工整理。');
  }

  const rationaleRaw = values['_依据'];
  const rationale: Record<string, string> = {};
  if (rationaleRaw && typeof rationaleRaw === 'object') {
    for (const [k, v] of Object.entries(rationaleRaw as Record<string, unknown>)) rationale[k] = String(v);
  }

  const variables: Record<string, string> = {};
  const missing: string[] = [];
  for (const s of specs) {
    if (imageNames.has(s.name)) continue; // 图片由影像证据自动插入，不算「模型没给内容」
    const v = values[s.name];
    if (v === undefined || v === null || (typeof v !== 'object' && String(v).trim() === '')) {
      if (known[s.name] !== undefined) variables[s.name] = toVariableValue(known[s.name]);
      else missing.push(s.name);
    } else {
      variables[s.name] = toVariableValue(v);
    }
  }
  // 保留 AI 额外给出的、模板里也有的键
  for (const [k, v] of Object.entries(values)) {
    if (k.startsWith('_')) continue;
    if (!(k in variables) && v !== null && v !== undefined) variables[k] = toVariableValue(v);
  }
  // 已知事实永远覆盖模型输出
  for (const [k, v] of Object.entries(known)) {
    if (v !== undefined && String(v).trim() !== '') variables[k] = toVariableValue(v);
  }
  /**
   * 循环集合的每一项再补一次字段（档案/工作台字段兜底）。
   * 放在最后：已知事实已经写进 variables，补齐时不会盖掉任何数据。
   */
  const enriched = enrichCollections(variables, structure, {
    workTypeId: t.work_type_id ?? wb?.work_type_id ?? null,
    archive: input.workbenchId ? readArchiveValues(input.workbenchId) : {},
    native,
  });
  const finalVariables = enriched.values as Record<string, string>;

  if (missing.length) warnings.push(`${missing.length} 项模型未能给出内容，渲染时会保留 {变量名} 占位，请手工填充。`);
  warnings.push(...collectionWarnings(finalVariables, structure, input.workbenchId !== null && input.workbenchId !== undefined));
  if (enriched.filled) warnings.push(`循环项里有 ${enriched.filled} 个字段按项目信息/工作台字段自动补齐。`);
  const todos = Object.entries(finalVariables).filter(([, v]) => v.includes('【待补'));
  if (todos.length) warnings.push(`${todos.length} 项标记为待补（【待补：…】），生成后请补齐再定稿。`);

  return {
    ok: true,
    variables: finalVariables,
    evidence,
    specs,
    missing,
    rationale,
    sources,
    knowledge: knowledgeHits,
    knowledgeError,
    warnings,
    usage: res.usage,
    model: res.model,
    latencyMs: res.latencyMs,
    rawText: parsed.ok ? undefined : res.text,
  };
}

/**
 * 循环与图片的可读提醒（生成结果里就要能看见，而不是等用户打开文件才发现缺东西）。
 * 旧模板（没有循环/图片）不会产生任何新提醒 —— 保持原有提示一字不变。
 */
function collectionWarnings(
  values: Record<string, unknown>,
  structure: TemplateStructure,
  hasWorkbench: boolean,
): string[] {
  const out: string[] = [];
  for (const c of structure.collections) {
    const items = collectionItemsOf(values[c.name]);
    if (items === null) {
      const photoish = /照片|图片|影像|photo/i.test(c.name);
      if (!(photoish && hasWorkbench)) {
        out.push(`循环集合「${c.name}」没有数据，生成的文件里这一段/这一行会原样留着标记，请补上条目。`);
      }
    } else if (!items.length) {
      out.push(`循环集合「${c.name}」是空的，生成的文件里这一段/这一行会被整段删掉。`);
    }
  }
  if (structure.images.length) {
    const names = [...new Set(structure.images.map((i) => i.name))];
    out.push(
      `模板里有 ${structure.images.length} 处图片占位（${names.join('、')}），出文书时从${
        hasWorkbench ? '本工作台' : '影像库'
      }按名称/序号自动插入；找不到的图片会保留 {@图片 名字} 字样，并在「没填」提示里列出。`,
    );
  }
  for (const w of structure.warnings) out.push(`模板结构提醒：${w}`);
  return out;
}

async function collectOneReference(id: number): Promise<string> {
  const a=getArtifact(id);if(!a)return '';
  try{const current=await readArtifactEvidence(a);return `【参考资料：${a.title}｜${a.file_name}；原文待核实】\n${current.warning}\n${current.text.slice(0,6000)||'未能读取正文，不得推断内容'}`;}catch(e){return `【参考资料 #${id} 未读取：${(e as Error).message}】`;}
}

/* ------------------------------ 渲染与保存 ------------------------------ */

export interface PreviewResult {
  ok: boolean;
  fileName: string;
  bytes?: Buffer;
  missing: string[];
  /** 未能插入的图片（同时以「图片：名字」并入 missing，预览的 X-Missing-Vars 提示就能看到） */
  missingImages?: string[];
  /** 渲染提醒（循环不配对、集合没数据…） */
  notes?: string[];
  message?: string;
}

/* ==================== B4-12 真·预览：计划（plan）与产物校验 ==================== */

/**
 * 预览计划里的一段。**只做三种**，理由见 docs/11 B4-12 的取舍：
 *   · `text`  模板里的普通段落（变量已替换成实际值，看的就是"生成出来是什么内容"）
 *   · `table` 表格（`{#循环}` 已按集合数据展开成行；行列与真实 docx **由同一份数据驱动**）
 *   · `image` 图片段（缩略图 + 图注）；docx 里的图片是二进制，页面内不重新解析 docx，
 *             只用 `buildRenderAssets()` —— **渲染器自己挑图的那个函数** —— 的同一份结果
 * 不做前端重新解析 docx：那会生成第二真源，两边在合并单元格/编号上一定会不一致。
 */
export interface PreviewSegment {
  kind: 'text' | 'table' | 'image';
  /** kind=text 且模板是 docx 时：这段属于哪个部件（正文 / 页眉 / 页脚） */
  part?: string;
  /** kind=text */
  lines?: string[];
  /** kind=table：表格标题行（有表头时）*/
  headers?: string[] | null;
  /** kind=table：数据行；单元格里的换行已拆成多行 */
  rows?: string[][];
  /** kind=table：表格来自哪个循环集合（没有循环的固定表格为 null） */
  collection?: string | null;
  /** kind=table：被折叠掉的行数（超过展示上限时，如实说，不假装没有） */
  truncatedRows?: number;
  /** kind=image */
  caption?: string;
  /** kind=image：页面内可直接显示的地址（`/api/artifacts/:id/preview/raw`，只服务图片/PDF） */
  url?: string;
  /** kind=image：拍摄/入库时间，图注里那个"（…摄）" */
  takenAt?: string | null;
  /** kind=image：没能插入的图片会给 false + `missingNote` */
  inserted?: boolean;
  missingNote?: string;
}

/** 产物合法性校验的结果（界面上那条红/绿横幅要的全部信息） */
export interface PreviewCheck {
  ok: boolean;
  /** `template-xml` 模板源文件本身坏了 / `output-xml` 渲染出来的成品坏了 / `plain-text` 无需校验 */
  kind: 'template-xml' | 'output-xml' | 'plain-text' | 'skipped';
  /** 一句话结论，直接显示在横幅上 */
  reason: string;
  /** 逐条问题（含行号），没有则为空数组 */
  errors: string[];
}

export interface PreviewPlan {
  template: { id: number; name: string; format: TemplateFormat; fileFormat: string };
  /** 三段预览的结构化内容（变量已替换） */
  segments: PreviewSegment[];
  /** 段数汇总（界面显示"N 段：正文 x / 表 y / 图 z"） */
  counts: { text: number; table: number; image: number };
  /** 表格总行数（验收第 6 条就是拿它与真实 docx 比） */
  tableRows: number;
  /** 结构化预览做不到的那一层，界面必须照原话显示 */
  paginationNote: string;
  /** 字体/分页这类真的没做的东西，一条条说清楚（不假装） */
  limitations: string[];
  renderedBytes: number;
}

export interface PreviewDocResult {
  ok: boolean;
  fileName: string;
  bytes?: Buffer;
  missing: string[];
  missingImages?: string[];
  notes?: string[];
  message?: string;
  /** 渲染提醒、结构警告、模板健康问题 —— 如实列给界面 */
  warnings: string[];
  check: PreviewCheck;
  plan?: PreviewPlan;
}

export interface PreviewPlanOptions {
  periodId?: number | null;
  inspectionId?:number|null;
  inspectionRevision?:number|null;
  /** 有工作台时才能按「本阶段优先」的影像证据取图（B4-12 验收第 4 条的排序） */
  workbenchId?: number | null;
  positionCode?: string | null;
  /** 表格展示上限：超过就折叠（并如实回报折叠了多少行） */
  rowLimit?: number;
}

/** 表格预览的行数上限（docs/11 B4-12 风险 ④：大文书卡顿 → 表格行 > 500 折叠显示） */
const PREVIEW_TABLE_ROW_LIMIT = 500;

const PREVIEW_PAGINATION_NOTE =
  '这是内容预览（变量已替换成实际值），不是排版预览：字体、字号、行距、分页、页码以 Word/Excel 打开为准。';

/** docx 部件名 → 给人看的段落名 */
function partLabel(part: string): string {
  if (part === 'word/document.xml') return '正文';
  if (/^word\/header/.test(part)) return '页眉';
  if (/^word\/footer/.test(part)) return '页脚';
  if (part === 'word/footnotes.xml') return '脚注';
  if (part === 'word/endnotes.xml') return '尾注';
  if (part === 'word/comments.xml') return '批注';
  return part;
}

interface DocxPreviewRow {
  /** 该行是否落在 `{#循环}` 区域内 */
  loop: boolean;
  cells: string[][];
}

interface DocxPreviewBlock {
  kind: 'para' | 'table';
  lines?: string[];
  rows?: DocxPreviewRow[];
}

/** 一段 XML 里的纯文本：`</w:p>` 与 `<w:br/>` 都当换行（与渲染器同一套读法） */
function previewTextOf(fragment: string): string {
  return decodeXmlText(
    fragment.replace(/<w:tab\s*\/>/g, '\t').replace(/<w:br\s*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''),
  );
}

/**
 * 实体还原。**必须与 `core/template.ts` 的 decodeXml 同口径**（顺序：`&amp;` 最后还原，
 * 数字实体要认）—— 否则 WPS/Google Docs 导出的 `&#12290;` 会在预览里显示成字面量，
 * 那就成了"预览与真实文书不一致"，正是本项要避免的第二真源。
 */
function decodeXmlText(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => codePointChar(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => codePointChar(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function codePointChar(cp: number): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** 段落/单元格文本 → 去掉首尾空行、按行整理 */
function tidyLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/).map((s) => s.replace(/[ \t]+$/g, ''));
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.length ? lines : [''];
}

/**
 * 把一段 docx 部件拆成「按文档顺序的段落 / 表格」块。
 *
 * 为什么要自己拆：表格的**行列**是验收第 6 条的断言对象（预览里 5 行 → 真实 docx 也 5 行）。
 * 复用 `core/template.ts` 的 `analyzeDocxText` 只能拿到纯文本，丢掉了行列结构；
 * 而 `core/template.ts` 不归本次改动范围，所以在这里用同一套 `<w:p>` / `<w:t>` 标记口径
 * 做一层只读解析 —— 不写回、不参与渲染，渲染仍然走 `renderTemplate`。
 */
function parseDocxBlocks(xml: string): DocxPreviewBlock[] {
  const blocks: DocxPreviewBlock[] = [];
  const re = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  for (const m of xml.matchAll(re)) {
    const chunk = m[0]!;
    if (chunk.startsWith('<w:tbl')) {
      const rows: DocxPreviewRow[] = [];
      let inLoop = false;
      const cellRe = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
      for (const r of chunk.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)) {
        const rowXml = r[0]!;
        const cells: string[][] = [];
        let rowInLoop = false;
        for (const c of rowXml.matchAll(cellRe)) {
          const t = previewTextOf(c[0]!);
          const open = (c[0]!.match(/\{#\s*循环/g) ?? []).length;
          const close = (c[0]!.match(/\{\/\s*循环/g) ?? []).length;
          if (inLoop || open > 0) rowInLoop = true;
          cells.push(tidyLines(t));
          inLoop = inLoop || open > 0;
          if (close) inLoop = false;
        }
        if (!cells.length) continue;
        rows.push({ loop: rowInLoop, cells });
        inLoop = false;
      }
      if (rows.length) blocks.push({ kind: 'table', rows });
      continue;
    }
    blocks.push({ kind: 'para', lines: tidyLines(previewTextOf(chunk)) });
  }
  return blocks;
}

/**
 * 渲染管道的变量替换 → 预览文本。用 `core/placeholders.ts` 的同一个 `renderText`
 * （用同一个 `PLACEHOLDER_RE` 口径，`keepUnfilled` 语义一致：没填的照原样留着 `{变量}`，
 * 与真实文书一致，一眼能看出漏在哪）。行号与图片占位由调用方按上下文处理。
 */
function renderPreviewValue(raw: string, scope: Record<string, unknown>): string {
  return raw.replace(new RegExp(PLACEHOLDER_RE_SRC, 'g'), (whole, prefixRaw: string, nameRaw: string, fallback?: string) => {
    const prefix = prefixRaw ?? '';
    const name = (nameRaw ?? '').trim();
    const fb = fallback?.trim() ?? '';
    /** 循环标记由调用方按块展开，这里原样留着（去掉标记是 previewLines 的事） */
    if (prefix === '#' || prefix === '/') return whole;
    /** 行号只在循环体内有意义；没有行号上下文就原样留着，与真实文书一致 */
    if (name === ROW_NUMBER_PLAIN) return name in scope ? String(scope[name]) : whole;
    const has = Object.prototype.hasOwnProperty.call(scope, name);
    const v = has ? scope[name] : undefined;
    if(v===OPTIONAL_EMPTY)return fb;
    if (v === undefined || v === null || String(v).trim() === '') {
      if (fb) return fb;
      return whole;
    }
    return String(v);
  });
}

/** 与 core/placeholders.ts 的 PLACEHOLDER_RE 同口径（`{前缀 名字|默认值}`） */
const PLACEHOLDER_RE_SRC = '\\{([@#/]?)([^{}\\r\\n\\t]{1,60}?)(?:\\|([^{}\\r\\n\\t]{0,120}))?\\}';

/**
 * 一段模板文本 → 预览文本。
 *
 * 处理顺序（与渲染器一致）：循环标记整段先按集合展开（展开由调用方按块做），
 * 顶层变量替换；`{@序号}`/`{_行号}` 没有行号上下文时原样留着（与真实文书一致）。
 */
function previewLines(lines: string[], scope: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const line of lines) {
    /** `{#循环 集合}` / `{/循环}` 出现在普通段落里时直接去掉标记（行本身仍显示，便于定位） */
    if (/\{#\s*循环|\{\/\s*循环/.test(line)) {
      const cleaned = renderPreviewValue(line.replace(/\{#\s*循环[^{}\r\n\t]{0,60}?\}/g, '').replace(/\{\/\s*循环[^{}\r\n\t]{0,60}?\}/g, ''), scope);
      if (cleaned.trim()) out.push(cleaned);
      continue;
    }
    out.push(renderPreviewValue(line, scope));
  }
  while (out.length && !out[0]!.trim()) out.shift();
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out;
}

/**
 * 渲染出来的成品到底能不能打开 —— **产物合法性校验**（docs/11 B4-12「必做②」）。
 *
 * 口径与"模板体检"完全同源：复用 `core/template.ts` 的 `checkTemplateHealth()`，
 * 它对内存里的字节跑的就是 PizZip 打开 + 每个参与渲染的部件 XML 良构判定。
 * 这里**不再另写一套 XML 校验**（两套口径必然漂移），所以叫 validateXmlStructure。
 *
 * 为什么校验的是渲染结果、而不是模板源文件：「文件到底能不能打开」取决于**成品**；
 * 而实测的坏模板（zip 正常、XML 非法）在渲染后 XML 依然非法，于是坏产物一定会被拦下。
 */
export function validateXmlStructure(bytes: Buffer | undefined, fmt: TemplateFormat): PreviewCheck {
  if (!bytes || !bytes.length) {
    return { ok: false, kind: 'output-xml', reason: '渲染没有产出任何字节，无法判断产物是否合法', errors: ['渲染结果为空'] };
  }
  /** 纯文本模板不是 XML：这里如实说"无需校验"，而不是给一个假的绿勾 */
  if (fmt === 'text') {
    return {
      ok: true,
      kind: 'plain-text',
      reason: '纯文本模板（.txt/.md/.csv）没有 XML 结构，无需结构校验',
      errors: [],
    };
  }
  if (fmt !== 'docx' && fmt !== 'xlsx') {
    return { ok: false, kind: 'output-xml', reason: `不支持的模板格式：${fmt}`, errors: [`不支持的格式 ${fmt}`] };
  }
  const tmp = join(
    ensureDir(join(RUNTIME_ROOT, 'preview')),
    `validate-${randomUUID()}.${fmt}`,
  );
  try {
    writeFileSync(tmp, bytes);
    const h = checkTemplateHealth(tmp);
    if (h.ok) {
      return {
        ok: true,
        kind: 'output-xml',
        reason: fmt === 'docx' ? '产物结构合法，Word 能正常打开' : '产物结构合法，Excel 能正常打开',
        errors: [],
      };
    }
    const reason = (h.reason ?? '产物结构异常').trim();
    return { ok: false, kind: 'output-xml', reason, errors: [reason] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, kind: 'output-xml', reason: `产物校验本身失败：${msg}`, errors: [msg] };
  } finally {
    /** 校验用的临时文件**立即删掉**：它只是"体检取样"，不是产物、不进 artifact、不留在盘上 */
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 删不掉不算功能失败（托盘里留一个几百 KB 的取样文件，比把校验判成失败好） */
    }
  }
}

/** 图片素材 → 预览段（图注形如「图 1：现场照片（2026-09-16 09:24 摄）」） */
function imageSegmentsFrom(assets: RenderAssets, missingImages: string[]): PreviewSegment[] {
  const out: PreviewSegment[] = [];
  for (const img of assets.images) {
    /** 缩略图地址走既有的受限接口 `/api/artifacts/:id/preview/raw`（只服务图片/PDF），不新开路径出口 */
    const url = renderImageUrl(img.absPath);
    const info = imageArtifactOf(img.absPath);
    const at = info?.captured_at ? fmtMinute(info.captured_at) : null;
    out.push({
      kind: 'image',
      caption: `图 ${img.index}：${img.label}${at ? `（${at} 摄）` : ''}`,
      url,
      takenAt: info?.captured_at ?? null,
      inserted: true,
    });
  }
  for (const name of missingImages) {
    out.push({ kind: 'image', caption: `图（未能插入）：${name}`, inserted: false, missingNote: `影像库里没有找到「${name}」，真实文书里这一处会保留 {@图片 ${name}} 字样` });
  }
  return out;
}

function fmtMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 从素材里给「图片占位名」找一张能插的图（与渲染器同一套名称匹配口径） */
function matchImage(assets: RenderAssets, name: string): RenderImageAsset | undefined {
  const n = name.toLowerCase();
  for (const a of assets.images) {
    if (a.names.some((x) => x.toLowerCase() === n)) return a;
  }
  for (const a of assets.images) {
    if (a.names.some((x) => x.toLowerCase().includes(n))) return a;
  }
  /** 「照片/图片」这类通用叫法：按序取第一张（与渲染器的 GENERIC_IMAGE_NAMES 语义一致） */
  if (/照片|图片|影像|图像|photo|image|picture/.test(n)) return assets.images[0];
  return undefined;
}

/** 图片段里的图片占位换成图注文字（docx 里显示的是图，HTML 里显示缩略图 + 图注，位置对应） */
function replaceImageTokens(text: string, assets: RenderAssets): string {
  return text.replace(/\{@\s*图片\s*([^{}\r\n\t]{0,60}?)\}/g, (whole, rawName: string) => {
    const hit = matchImage(assets, (rawName ?? '').trim());
    return hit ? `［图片 ${hit.index}：${hit.label}］` : whole;
  });
}

/** 整段文本逐行把图片占位换成图注文字（docx 里显示的是图，HTML 里显示缩略图 + 图注，位置对应） */
function replaceImageTokensLines(lines: string[], assets: RenderAssets): string[] {
  return lines.map((l) => replaceImageTokens(l, assets));
}

/**
 * 结构化预览（docs/11 B4-12「必做①」）：把渲染器**实际使用的数据结构**（模板结构 +
 * 补齐后的变量 + 影像素材）渲染成页面可读的 text / table / image 段。
 *
 * 与真实 docx 的一致性从哪来：表格行 = `{#循环}` 区域 × 集合数组长度，单元格文本 = 同一个
 * `renderText`（core/placeholders）替换后的值。渲染器走的是同一份 `values` 与同一份
 * `buildRenderAssets()` 结果，所以"预览 5 行 / docx 5 行"不是巧合。
 */
async function buildPreviewPlan(
  t: Template,
  abs: string,
  fmt: TemplateFormat,
  values: Record<string, unknown>,
  assets: RenderAssets,
  missingImages: string[],
  opts: { rowLimit?: number; renderedBytes: number; renderedData:Buffer },
): Promise<PreviewPlan> {
  const rowLimit = opts.rowLimit ?? PREVIEW_TABLE_ROW_LIMIT;
  const segments: PreviewSegment[] = [];
  let tableRows = 0;
  let truncatedRows = 0;

  /** 集合值：统一取成项数组（字符串形式的 JSON 也认） */
  const collectionOf = (name: string): unknown[] | null => collectionItemsOf(values[name]);

  if (fmt === 'docx') {
    let zip: PizZip | null = null;
    try {
      zip = new PizZip(readFileSync(abs));
    } catch {
      zip = null;
    }
    if (zip) {
      for (const part of previewParts(zip)) {
        const f = zip.file(part);
        if (!f) continue;
        const blocks = parseDocxBlocks(f.asText());
        if (!blocks.length) continue;
        for (const b of blocks) {
          if (b.kind === 'para') {
            const lines = previewLines(replaceImageTokensLines(b.lines ?? [], assets), values);
            if (!lines.length) continue;
            segments.push({ kind: 'text', part: partLabel(part), lines });
            continue;
          }
          /** 表格：识别循环行，按集合数据展开 */
          const rows = b.rows ?? [];
          const out: string[][] = [];
          let headers: string[] | null = null;
          let collection: string | null = null;
          let i = 0;
          while (i < rows.length) {
            const row = rows[i]!;
            if (!row.loop) {
              const cells = row.cells.map((cl) => previewLines(replaceImageTokensLines(cl, assets), values).join('\n'));
              out.push(cells);
              i += 1;
              continue;
            }
            /** 收集整块连续的循环行（循环体常常只写了 1 行） */
            const bodyStart = i;
            while (i < rows.length && rows[i]!.loop) i += 1;
            const body = rows.slice(bodyStart, i);
            const first = body[0]!.cells.map((cl) => cl.join('\n')).join(' ');
            const m = /\{#\s*循环\s*([^{}\r\n\t]{1,60}?)\}/.exec(first) ?? /\{#\s*循环\s*([^{}\r\n\t]{1,60}?)\}/.exec(
              body.flatMap((r) => r.cells.flat()).join(' '),
            );
            const name = (m?.[1] ?? '').trim();
            if (name && !collection) collection = name;
            const items = name ? collectionOf(name) : null;
            if (items === null) {
              /** 集合没有数据：渲染器会原样保留标记（不是删掉），预览也照原样显示 */
              for (const r of body) {
                out.push(r.cells.map((cl) => previewLines(replaceImageTokensLines(cl, assets), values).join('\n')));
              }
              continue;
            }
            for (const item of items) {
              const itemScope: Record<string, unknown> = { ...values };
              if (item && typeof item === 'object') for (const [k, v] of Object.entries(item as Record<string, unknown>)) itemScope[k] = v;
              const idx = items.indexOf(item) + 1;
              itemScope[ROW_NUMBER_AT] = idx;
              itemScope[ROW_NUMBER_PLAIN] = idx;
              for (const r of body) {
                const cells = r.cells.map((cl) => {
                  let text = cl.join('\n');
                  text = text.replace(/\{@\s*序号\}/g, String(idx));
                  const imgTok = /\{@\s*图片\s*([^{}\r\n\t]{0,60}?)\}/.exec(text);
                  if (imgTok) {
                    const hit = matchImage(assets, (imgTok[1] ?? '').trim());
                    /** 循环里的图片：按"行号取图"口径（渲染器同一条规则），取第 idx 张 */
                    const byIndex = assets.images[idx - 1] ?? hit;
                    text = text.replace(/\{@\s*图片[^{}\r\n\t]{0,60}?\}/g, byIndex ? `［图片 ${byIndex.index}：${byIndex.label}］` : (imgTok[0] ?? ''));
                  }
                  return previewLines(text.split(/\r?\n/), itemScope).join('\n');
                });
                out.push(cells);
              }
            }
          }
          /** 有循环的表格：循环前最后一行当作表头（模板通常写成表头行 + 循环数据行） */
          if (collection && out.length) headers = out[0]!;
          tableRows += out.length;
          let shown = out;
          let cut = 0;
          if (out.length > rowLimit) {
            shown = out.slice(0, rowLimit);
            cut = out.length - rowLimit;
            truncatedRows += cut;
          }
          segments.push({
            kind: 'table',
            headers,
            rows: headers ? shown.slice(1) : shown,
            collection,
            truncatedRows: cut,
          });
        }
      }
    }
  } else if (fmt === 'xlsx') {
    // 预览直接读渲染后的字节，包含循环展开；不能再扫描模板并替换顶层变量。
    const workbook=new ExcelJS.Workbook();
    await workbook.xlsx.load(opts.renderedData as unknown as ExcelJS.Buffer);
    for(const sheet of workbook.worksheets){
      const rows:string[][]=[];let count=0;
      sheet.eachRow(row=>{count++;if(rows.length>=rowLimit)return;const cells:string[]=[];row.eachCell({includeEmpty:true},cell=>cells.push(cell.isMerged&&cell.master.address!==cell.address?'':cell.text));rows.push(cells);});
      tableRows+=count;truncatedRows+=Math.max(0,count-rows.length);
      segments.push({kind:'table',part:sheet.name,rows,truncatedRows:Math.max(0,count-rows.length)});
    }
  } else {
    const src = readFileSync(abs).toString('utf8');
    segments.push({ kind: 'text', part: '纯文本', lines: previewLines(src.split(/\r?\n/), values) });
  }

  /** 图片段统一放在文字/表格之后（页面里显示缩略图 + 图注），顺序与素材顺序一致 */
  for (const seg of imageSegmentsFrom(assets, missingImages)) segments.push(seg);

  const counts = {
    text: segments.filter((s) => s.kind === 'text').length,
    table: segments.filter((s) => s.kind === 'table').length,
    image: segments.filter((s) => s.kind === 'image').length,
  };
  const limitations: string[] = [
    '只做"内容预览"（变量替换后的文字与表格），不做排版预览：字体、字号、行距、分页、页码以 Word/Excel 为准。',
    '图片以缩略图 + 图注显示在图片段里，位置与文档中的图片占位一一对应，但不还原浮动/环绕排版。',
    '表格的行列由渲染器使用的同一份数据（模板循环 + 变量值）展开，行数与真实文书一致；合并单元格的显示可能不同。',
  ];
  if (truncatedRows) {
    limitations.push(`表格总共 ${tableRows} 行，页面里只展开前 ${rowLimit} 行（折叠 ${truncatedRows} 行），完整内容请下载或用系统打开。`);
  }
  return {
    template: { id: t.id, name: t.name, format: fmt, fileFormat: t.file_format },
    segments,
    counts,
    tableRows,
    paginationNote: PREVIEW_PAGINATION_NOTE,
    limitations,
    renderedBytes: opts.renderedBytes,
  };
}

/** 与渲染器同一套部件口径：正文最前，其余页眉页脚/脚注尾注/批注按名字排序 */
const PREVIEW_PART_RE = /^word\/(?:header|footer)\d*\.xml$/;
const PREVIEW_CORE_PARTS = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml'];

function previewParts(zip: PizZip): string[] {
  const found = Object.keys(zip.files)
    .filter((name) => PREVIEW_PART_RE.test(name) || PREVIEW_CORE_PARTS.includes(name))
    .sort();
  const ordered = ['word/document.xml', ...found.filter((name) => name !== 'word/document.xml')];
  return ordered.filter((name) => Boolean(zip.file(name)));
}

/**
 * 模板/产物里的图片 → 登记记录。
 *
 * 按**登记记录里的绝对路径**反查（不是按文件名），所以不会把同名文件认错；
 * 找不到就返回 undefined（找不到不等于报错）。
 */
function imageArtifactOf(absPath: string): Artifact | undefined {
  let items: Artifact[] = [];
  try {
    items = listArtifacts({ limit: 2000 }).items;
  } catch {
    return undefined;
  }
  const want = toPosix(absPath).toLowerCase();
  for (const a of items) {
    try {
      if (toPosix(artifactAbsPath(a)).toLowerCase() === want) return a;
    } catch {
      /* 定位不到的记录跳过（文件被移走 / 目录已解绑） */
    }
  }
  return undefined;
}

/**
 * 图片 → 页面可直接显示的地址。
 *
 * 地址必须走**既有的受限路径** `/api/artifacts/:id/preview/raw`
 * （routes-preview.ts 里那个只服务图片与 PDF 的白名单接口），
 * 所以这里拿登记记录的 id 拼地址 —— 不是新开一个任意路径出口。
 */
function renderImageUrl(absPath: string): string | undefined {
  const a = imageArtifactOf(absPath);
  return a ? `/api/artifacts/${a.id}/preview/raw` : undefined;
}

/** 仅清空模板说明明确允许留空的普通字段；必填、图片、循环仍按原规则校验。 */
function optionalRenderValues(t:Template,values:Record<string,unknown>):Record<string,unknown>{
  const result={...values};
  for(const spec of readTemplateVars(t).variables){
    if(spec.required!==false||spec.type==='table')continue;
    const value=result[spec.name];
    if(value===undefined||value===null||String(value).trim()==='')result[spec.name]=OPTIONAL_EMPTY;
  }
  return result;
}

/* ---------------------- B4-12：预览（plan）与产物校验 ---------------------- */

/**
 * 预览接口的入口（docs/11 B4-12）。
 *
 * 三条硬约束（逐条对应文档的"怎么做"）：
 *   ① **只渲染、不落盘**：全程不写正式文书目录、不登记 artifact、不写生成日志；
 *      唯一的写盘是产物体检的临时取样文件（`RUNTIME_ROOT/preview/`，用完立即删）。
 *   ② **plan 由渲染器实际使用的数据结构产出**（模板结构 + 补齐后的变量 + 影像素材），
 *      不另写一套解析，所以与真实 docx 天然一致。
 *   ③ **产物合法性校验必做**：渲染出的字节过一遍结构校验，界面据此显示红/绿横幅。
 */
export async function renderPreviewPlan(
  templateId: number,
  values: Record<string, unknown>,
  opts: PreviewPlanOptions = {},
): Promise<PreviewDocResult> {
  assertPeriodContext(opts.workbenchId, opts.periodId);
  assertInspectionRevision(opts.inspectionId,opts.periodId,opts.inspectionRevision);
  const period = opts.periodId ? requirePeriod(opts.periodId,opts.workbenchId) : null;
  if(opts.inspectionId)requireInspection(opts.inspectionId,period?.id);
  const t = getTemplate(templateId);
  if (!t) {
    const reason = '模板不存在';
    return { ok: false, fileName: '', missing: [], warnings: [reason], check: { ok: false, kind: 'skipped', reason, errors: [reason] }, message: reason };
  }
  assertInspectionScope(t,period,opts.inspectionId);

  assertGenerationScope(t,opts.workbenchId,opts.positionCode,opts.periodId);
  if (period) assertPeriodTemplate(period,t);
  else assertInstanceTemplate(opts.workbenchId,opts.positionCode,t);
  const abs = templateAbsPath(t);
  if (!existsSync(abs)) {
    const reason = `模板文件已丢失：${t.file_rel}`;
    return { ok: false, fileName: '', missing: [], warnings: [reason], check: { ok: false, kind: 'template-xml', reason, errors: [reason] }, message: reason };
  }
  const fmt = detectFormat(abs);
  if (!canRender(fmt)) {
    const reason = `该格式（${fmt}）不支持填充，请改用 .docx / .xlsx 模板。`;
    return { ok: false, fileName: '', missing: [], warnings: [reason], check: { ok: false, kind: 'skipped', reason, errors: [reason] }, message: reason };
  }

  /**
   * 坏模板**不在这里抛 400**：产物校验会把「模板源文件本身结构非法」这条摆到界面上
   * （红横幅 + 原因），这比一个错误码更符合 B4-12 验收②③要的"看得见为什么"。
   * 生成/保存两条路仍然照旧在动手之前把它拦下（`templateForRender` 未改动）。
   */
  const warnings: string[] = [];
  const templateHealth = (() => {
    if (t.health_ok !== null && t.health_ok !== undefined) return { ok: Number(t.health_ok) !== 0, reason: t.health_note };
    try {
      const h = refreshTemplateHealth(t);
      return { ok: h.ok, reason: h.reason };
    } catch {
      return { ok: true, reason: null as string | null };
    }
  })();
  if (!templateHealth.ok) {
    const note = (templateHealth.reason ?? '').trim() || '文件结构已损坏，Word 打不开';
    warnings.push(`这个模板源文件本身有问题（${note}）。出文书前请先修好或重新上传：${t.name}`);
  }

  const structure = scanTemplateStructure(abs);
  for (const w of structure.warnings) warnings.push(`模板结构提醒：${w}`);

  /**
   * 素材与循环补齐：有 workbenchId 时按「本阶段优先」取影像证据（验收第 4 条的排序口径），
   * **没有 workbenchId 时一张图都不给**（缺陷修复：以前会退化成"按名字在全库影像里找"，
   * 于是 A 的文书里会插进 B 的照片）。找不到的图片名由 `missingImageNotes` 如实回报。
   */
  const workbenchId = opts.workbenchId ?? null;
  if(opts.periodId){if(!workbenchId)throw new ApiError('WORK_REQUIRED','期次预览必须指定工作');requirePeriod(opts.periodId,workbenchId);}
  const positionCode = opts.positionCode ?? t.position_code ?? null;
  const enriched = enrichCollections(values, structure, {
    workTypeId: t.work_type_id ?? null,
    archive: workbenchId ? readArchiveValues(workbenchId) : {},
    native: buildNativeContext(workbenchId, positionCode),
  });
  const missingImageNotes: string[] = [];
  const assets = buildRenderAssets(
    {
      absPath: abs,
      workbenchId,
      periodId:opts.periodId,
      inspectionId:opts.inspectionId,
      positionCode,
      values: enriched.values,
      structure,
    },
    missingImageNotes,
  );

  const renderValues=optionalRenderValues(t,enriched.values);
  const r = await renderTemplate(abs, renderValues, undefined, assets);
  if (!r.ok || !r.bytes) {
    const reason = r.message ?? '渲染失败';
    return { ok: false, fileName: '', missing: r.missing ?? [], warnings, check: { ok: false, kind: 'output-xml', reason, errors: [reason] }, message: reason };
  }

  const check = validateXmlStructure(r.bytes, fmt);
  /**
   * 两类"没插进去"的图都走同一条 `missingImages` 通道：
   *   · 渲染器自己回报的（文件读不到、格式不认、没能写入图片部件）；
   *   · 本工作台里根本没有这个名字的影像（缺陷修复：以前会拿别的工作台的照片顶上）。
   */
  const missingImages = [...(r.missingImages ?? []), ...missingImageNotes];
  const plan = await buildPreviewPlan(t, abs, fmt, renderValues, assets, missingImages, {
    rowLimit: opts.rowLimit,
    renderedBytes: r.bytes.byteLength,
    renderedData:r.bytes,
  });

  if (r.notes?.length) warnings.push(...r.notes);
  if (r.missing?.length) warnings.push(`有 ${r.missing.length} 项没有值，真实文书里会原样保留 {变量名} 占位。`);
  if (!check.ok) {
    /** 校验不通过要说清"已阻止保存"：横幅上那句话的依据就是这里，不是一句泛泛的失败 */
    warnings.push(`产物结构异常，已阻止保存：${check.reason}`);
  }

  return {
    ok: check.ok,
    fileName: previewFileName(t, fmt),
    bytes: r.bytes,
    missing: r.missing ?? [],
    missingImages,
    notes: r.notes,
    warnings,
    check,
    plan,
  };
}

/**
 * 兼容旧调用（只传 templateId + values）：返回渲染结果本身，字段名与改造前一致。
 *
 * `opts` 是**纯增量**的第三个参数：不传时与改造前逐字一致（`renderPreviewPlan(templateId, values)`）；
 * 传了就把 `workbenchId` / `positionCode` 透传下去，影像素材按"本工作台 / 本阶段优先"取，
 * 而不是退回全库按名字找同名的（那会让预览与正式生成不同源）。
 */
export async function previewDocument(
  templateId: number,
  values: Record<string, unknown>,
  opts: PreviewPlanOptions = {},
): Promise<PreviewResult> {
  const r = await renderPreviewPlan(templateId, values, opts);
  return {
    ok: Boolean(r.bytes) && r.check.ok,
    fileName: r.fileName,
    bytes: r.bytes,
    missing: r.missing,
    missingImages: r.missingImages,
    notes: r.notes,
    message: r.ok ? undefined : r.check.reason,
  };
}

function previewFileName(t: Template, fmt: string): string {
  const ext = fmt === 'xlsx' ? 'xlsx' : fmt === 'text' ? 'txt' : 'docx';
  return `${safeName(t.name)}_预览_${stamp()}.${ext}`;
}

/* ------------------- B4-12：「用系统打开」的预览临时文件 ------------------- */

/**
 * 预览临时目录：**平台自己的运行目录**（`RUNTIME_ROOT/preview/`），
 * 绝不落在用户绑定的资料目录里，也绝不进 `artifact`。
 *
 * 清理策略（两处）：
 *   ① 每个进程第一次要用预览临时文件时清一次（`cleanupPreviewDir()`）——「启动时清理」在本文件里
 *      挂不到 index.ts 的启动流程上（那个文件不归本次改动范围），所以做成"首次使用时清"：
 *      进程起来后第一次预览之前，残留一定会先被扫一遍，效果等价。
 *   ② `PREVIEW_TTL_MS = 24 小时`：超过 24 小时的一律删。产物体检用的 `validate-<uuid>.<ext>`
 *      取样文件走 `validateXmlStructure()` 的 finally **立即删**；万一进程被强杀留下孤儿，
 *      也会在 24 小时后被 ① 清掉 —— 不会无限堆积。
 */
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
let previewCleaned = false;

export function previewDirAbs(): string {
  return join(RUNTIME_ROOT, 'preview');
}

/** 清掉预览目录里超过 24 小时的残留；返回删掉的条数。删不掉只记日志，不影响预览本身 */
export function cleanupPreviewDir(now: number = Date.now()): number {
  const dir = previewDirAbs();
  if (!existsSync(dir)) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      try {
        if (now - statSync(abs).mtimeMs > PREVIEW_TTL_MS) {
          rmSync(abs, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        /* 单个条目读不到/删不掉，跳过 */
      }
    }
  } catch (e) {
    console.warn(`[预览] 清理预览临时目录失败（不影响预览）：${e instanceof Error ? e.message : String(e)}`);
  }
  return removed;
}

/** 预览临时文件的落点（实测断言用；界面拿不到、也不需要它） */
export function previewTempPath(ext: string): string {
  return join(ensureDir(previewDirAbs()), `${randomUUID()}.${ext}`);
}

export interface PreviewOpenResult {
  opened: boolean;
  /** 给界面显示的原始文件名（不含 uuid） */
  fileName: string;
  /** 预览临时文件的绝对路径：只用于日志与实测断言，界面不显示 */
  path: string;
}

/**
 * 「用系统打开」：把这一次的渲染结果写进运行目录的预览临时文件，再交给系统默认程序打开。
 *
 * 为什么这是"最准的预览"：本机装了 Word 时打开的是**真正的产物**，字体分页一目了然，
 * 也是 HTML 近似的兜底（docs/11 B4-12 的兼容路径）。
 *
 * 三条约束：
 *   ① 落点只能是 `RUNTIME_ROOT/preview/`，文件名用 uuid —— 不在用户绑定目录里、不与正式文书混淆；
 *   ② 不阻塞、不解析返回值：`cmd /c start` 即使成功也常以非零码结束，等它只会把接口拖慢；
 *   ③ 机器上没关联 Word 时**不报 500**：`spawn` 的 error 只记日志，
 *      界面自己写「本机未关联 Word，请下载后查看」（进程没起来 ≠ 平台故障）。
 */
export async function openPreviewInSystem(
  templateId: number,
  values: Record<string, unknown>,
  opts: PreviewPlanOptions = {},
): Promise<PreviewOpenResult & { render: PreviewDocResult }> {
  const render = await renderPreviewPlan(templateId, values, opts);
  if (!render.bytes) {
    const err = new Error(render.check.reason || '渲染失败') as Error & { statusCode: number; code: string };
    err.statusCode = 400;
    err.code = 'RENDER_FAILED';
    throw err;
  }
  /** 第一次用到预览临时文件时先清一遍 24 小时前的残留（见 cleanupPreviewDir 的说明） */
  if (!previewCleaned) {
    previewCleaned = true;
    cleanupPreviewDir();
  }
  const lower = render.fileName.toLowerCase();
  const ext = lower.endsWith('.xlsx') ? 'xlsx' : lower.endsWith('.txt') ? 'txt' : 'docx';
  const path = previewTempPath(ext);
  writeFileSync(path, render.bytes);

  const fileName = `${safeName(render.plan?.template.name ?? '预览')}_预览.${ext}`;
  const { spawn } = await import('node:child_process');
  const child =
    process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', path], { stdio: 'ignore', detached: true, windowsHide: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], { stdio: 'ignore', detached: true });
  child.on('error', (e: Error) => console.warn(`[预览] 调用系统打开失败（不影响预览内容）：${path}（${e.message}）`));
  child.unref();
  return { opened: true, fileName, path, render };
}

export interface SaveGeneratedInput {
  materialId?:number|null;
  /** Internal scoped draft service only; never copied from an HTTP payload. */
  inspectionDraft?: {id:number;revision:number};
  expectedSourceSignature?:string;
  expectedContextSignature?:string;
  /** Head displayed when the editor opened; null means there was no version yet. */
  expectedHeadId?: number|null;
  sourceArtifactIds?: number[];
  /** Internal assistant caller persists its own snapshot; never accepted from an HTTP body. */
  businessEvidenceManaged?: boolean;
  onBusinessCommit?: (artifact:Artifact)=>void;
  factChoices?: Record<string,FactChoice>;
  periodId?: number | null;
  inspectionId?:number|null;
  inspectionRevision?:number|null;
  templateId: number;
  workbenchId?: number | null;
  positionCode?: string | null;
  values: Record<string, unknown>;
  /** 覆盖生成的文件名（不含扩展名） */
  fileName?: string;
  mode?: 'ai' | 'manual' | 'hybrid';
  checklistItemId?: number | null;
  /**
   * 版本链怎么走（B1-4，迁移 017）。**缺省是 `'new'`**，理由有两条，都是刻意的：
   *
   *   1. **向后兼容**：`test:e2e` 与既有调用方依赖改造前的契约「重名自动加 `_v2`、不覆盖」，
   *      把缺省值改成"更新这一版"会让"我再出一份同名文件"变成"把上一份挪走"，
   *      这是**默认动作里的文件移动**，不该在调用方没要求时发生。
   *   2. **界面默认与接口默认分开**：`docs/11` B1-4 说的"默认"是**生成对话框的默认选项**
   *      （「更新这一版（推荐默认）」），对话框显式传 `'update'`；
   *      接口这一层保持"不传就是不出意外"。
   *
   *   · `'new'`    另起一条链（另一份不同用途），命名与改造前逐字一致；
   *   · `'update'` 接着这条链的最新一版走：旧版文件搬到 `.versions/<group>/v<N>.<ext>`，
   *                新版占正式文件名，`revision+1`；
   *   · `'final'`  同 `'update'`，出完直接置 `is_final=1`（之后这条链不许再覆盖）。
   */
  saveMode?: SaveMode;
}

export interface SaveGeneratedResult {
  artifact: Artifact;
  missing: string[];
  /** 缺失的图片名（本工作台的影像里没有找到，**没有拿别的工作台/别的照片顶替**） */
  missingImages: string[];
  /** 版本链信息（老库缺迁移 017 时为 null，那时行为与改造前一致） */
  version: { group: string; revision: number; isFinal: boolean; supersedesId: number | null } | null;
  /** 落盘过程的提醒（旧版搬到哪了、上一版文件找不到…）——如实说，不静默 */
  warnings: string[];
}

export async function saveGeneratedDocument(input: SaveGeneratedInput): Promise<SaveGeneratedResult> {
  return withDocumentWrite(input.workbenchId,input.templateId,()=>saveGeneratedDocumentLocked(input));
}

async function saveGeneratedDocumentLocked(input: SaveGeneratedInput): Promise<SaveGeneratedResult> {
  const sourceArtifactIds=input.sourceArtifactIds??[];
  if(sourceArtifactIds.some(id=>{const a=getArtifact(id);return !a||a.workbench_id!==input.workbenchId||(input.periodId&&(a as Artifact&{work_period_id?:number}).work_period_id!==input.periodId);}))throw new ApiError('WRONG_REFERENCE','参考资料必须属于本工作及所选期次');
  const sourceSignature=documentSourceSignature(input.workbenchId,input.periodId,input.templateId,sourceArtifactIds,input.inspectionId);
  if((input.expectedSourceSignature&&input.expectedSourceSignature!==sourceSignature)||(input.expectedContextSignature&&input.expectedContextSignature!==documentSourceSignature(input.workbenchId,input.periodId,input.templateId,[],input.inspectionId)))throw new ApiError('SOURCE_CHANGED','起草或打开窗口后业务来源已变化，请重新带入已知信息或重新起草后核对；已填写内容保留',409);
  assertPeriodContext(input.workbenchId, input.periodId);
  assertInspectionRevision(input.inspectionId,input.periodId,input.inspectionRevision);
  // 路径③save：坏模板不允许落盘 —— 存进去的是"看起来成功、打不开"的正式文书
  const t = templateForRender(input.templateId);
  if (!t) throw new Error('模板不存在');
  assertGenerationScope(t,input.workbenchId,input.positionCode,input.periodId);
  const abs = templateAbsPath(t);
  const fmt = detectFormat(abs);
  if (!canRender(fmt)) throw new Error(`该格式（${fmt}）不支持填充`);

  const wb = input.workbenchId ? getWorkbench(input.workbenchId) : undefined;
  const factReview = reviewMemoryFacts(input.workbenchId,input.periodId,input.values,input.factChoices);
  if (input.saveMode === 'final') assertFactReview(factReview);
  const period=input.periodId?requirePeriod(input.periodId,input.workbenchId):null;
  const resultTarget=period?resolvePeriodResultTarget(period,t.id,input.materialId):undefined;
  if(!period&&input.materialId!=null)throw new ApiError('WRONG_MATERIAL','成果要求须属于明确期次',409);
  if(input.inspectionDraft){
    const {requireDraft}=await import('./inspection-drafts.ts');
    requireDraft(period!.id,input.inspectionDraft.id,input.inspectionDraft.revision);
    if(templateGenerationScope(t)==='period')throw new ApiError('BAD_SCOPE','草稿需要单次检查模板');
  }else assertInspectionScope(t,period,input.inspectionId);
  const inspectionSources=inspectionSourceSignature(t,period,input.inspectionId);
  if(period)assertPeriodTemplate(period,t);
  else assertInstanceTemplate(input.workbenchId,input.positionCode,t);
  if(period&&!wb)throw new ApiError('PERIOD_CLOSED','请选择所属工作');
  const explicitKey=documentPeriodKey(period,input.inspectionId);
  const inspection=input.inspectionId?requireInspection(input.inspectionId,period?.id):null;
  /**
   * 输出目录按工作台的输出位置模式算（契约 §4），实现在 `domain/service.ts` 的
   * `workbenchOutputDirAbs()` —— 三条落盘路径（文书/影像/资料）共用同一个函数：
   *   inline（默认，NULL 视作它）→ `<阶段目录>\<期次>\`
   *   subdir                    → `<阶段目录>\<期次>\_生成文书\`
   *   custom                    → 工作台配置的自定义绝对路径
   *
   * 【未绑定的工作台保持改造前的落点，逐字不变】：`<DATA_ROOT>\<folder_path>\_生成文书\`
   * （阶段能解析出来时，现有实现会再套一层阶段/期次末段 —— 也原样保留）。
   * 存量文件的位置一个都不动。
   */
  const dirAbs = period && wb ? join(workbenchOutputDirAbs(wb,'generated'), '期次',period.report_period,...(inspection?['检查',String(inspection.id)]:[])) : wb
    ? workbenchOutputDirAbs(wb, 'generated', { positionCode: input.positionCode ?? null })
    : join(DATA_ROOT, DIRS.inbox);

  const ext = fmt === 'xlsx' ? 'xlsx' : fmt === 'text' ? 'txt' : 'docx';

  /**
   * 版本链（B1-4）：默认 `'new'`（见 SaveGeneratedInput.saveMode 的注释）。
   * 只有显式 `'update'` / `'final'` 才会动磁盘上的上一版文件 —— 而且只动**平台自己生成、
   * 库里登记过**的那一个文件（`artifact.file_rel` 记着它），用户自己的文件一个都不碰。
   */
  const saveMode: SaveMode = input.saveMode === 'update' || input.saveMode === 'final' ? input.saveMode : 'new';
  const policyRequirement: PolicyRequirement = { mode: 'off', documentIds: [] };
  const warnings: string[] = [];
  let fileName = '';
  let plan:
    | {
        group: string;
        revision: number;
        supersedesId: number | null;
        isFinal: boolean;
        officialName: string;
        periodKey: string | null;
        adoptPeriodId: number | null;
      }
    | null = null;
  let planHead: Artifact | null = null;

  if (ensureDocVersionSchema()) {
    const head = resultTarget&&period?periodResultHead(period,t.id,resultTarget):findChainHead({
      periodKey: explicitKey,
      workbenchId: input.workbenchId ?? null,
      templateId: t.id,
      checklistItemId: input.checklistItemId ?? null,
      positionCode: input.positionCode ?? null,
    });
    if(saveMode!=='new' && input.expectedHeadId!==undefined && input.expectedHeadId!==(head?.id??null))
      throw new ApiError('STALE_DOCUMENT','文书已有新版本，请保留当前内容，关闭后重新打开核对最新版本。',409);
    /**
     * 【定稿拦在门口】：链上有定稿时不允许被静默覆盖（docs/11 B1-4）。
     * 信息里把"怎么办"说清楚（取消定稿，或另起一条链），不只是一个 error code。
     */
    const blocker = saveMode !== 'new' && head ? finalBlockerOf(head) : null;
    if (blocker) {
      // 用 VersionRuleError：路由层据此回 400 + 这句话（而不是 500「服务出错了」）
      throw new VersionRuleError(
        `这份文书（v${Number(blocker.revision ?? 1)}，${blocker.file_name}）已经标为最终版，不能再覆盖。` +
          '要改请先在「版本」里取消定稿，或者选「新建」另出一份。',
      );
    }
    const p = planVersionSave({
      mode: saveMode,
      head: saveMode === 'new' ? null : head,
      templateName: t.name,
      ext,
      requestedName: input.fileName,
      periodKey: explicitKey ?? resolvePeriodKey({
        workbenchId: input.workbenchId ?? null,
        checklistItemId: input.checklistItemId ?? null,
        positionCode: input.positionCode ?? null,
      }),
      // 退化匹配命中的是老链（没有期次）时，这次更新顺手把它归到当前期次
      headFromLegacy: Boolean(head && !(head.period_key ?? null) && head.version_group),
    });
    plan = {
      group: p.group,
      revision: p.revision,
      supersedesId: p.supersedesId,
      isFinal: p.isFinal,
      officialName: p.officialName,
      periodKey: p.periodKey,
      adoptPeriodId: p.adoptPeriodId,
    };
    planHead = saveMode !== 'new' && head ? head : null;
    warnings.push(...p.warnings);
    fileName = plan.officialName;
  } else {
    // 老库（缺迁移 017）：行为与改造前逐字一致
    const base = input.fileName?.trim() || generatedFileName(t.name, ext, new Date(), 1);
    fileName = base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
  }

  /**
   * 素材与循环项补齐都在这里做：落盘这条路径是**知道工作台**的（input.workbenchId），
   * 所以照片按「本阶段优先」排序，`{@图片 1}` 这类按序号取才符合预期。
   * **影像素材只来自 input.workbenchId 这个工作台**（缺陷修复：不再全库按名字找，
   * 否则 A 的文书里会插进 B 的照片）；本工作台找不到的名字如实回报，不拿别的照片顶替。
   */
  const structure = scanTemplateStructure(abs);
  const enriched = enrichCollections(input.values, structure, {
    workTypeId: t.work_type_id ?? wb?.work_type_id ?? null,
    archive: input.workbenchId ? readArchiveValues(input.workbenchId) : {},
    native: buildNativeContext(input.workbenchId ?? null, input.positionCode ?? null),
  });
  const missingImageNotes: string[] = [];
  const assets = buildRenderAssets(
    {
      absPath: abs,
      workbenchId: input.workbenchId ?? null,
      periodId:input.periodId,
      inspectionId:input.inspectionId,
      positionCode: input.positionCode ?? null,
      values: enriched.values,
      structure,
    },
    missingImageNotes,
  );
  // 缺图如实进 warnings（正式文书里那一处会原样保留 {@图片 名}，用户必须知道）
  warnings.push(...missingImageNotes.map((n) => `有图片没有插入：${n}`));
  /**
   * 【先渲染与校验，成功后再提交版本变更】（缺陷修复①）
   * 改造前这里之前就把上一版搬进归档目录并改了库的 `file_rel`：渲染这一步一失败，
   * 就留下"旧版本已经搬走、新版本还没生成"的不可回滚中间态，重试还会把旧版本的文件 unlink 掉。
   * 现在**任何磁盘/库的版本变更都在这之后**：渲染不过就直接抛错，磁盘与库一个字节没动。
   */
  const renderValues=optionalRenderValues(t,enriched.values);
  const r = await renderTemplate(abs, renderValues, undefined, assets);
  if (!r.ok || !r.bytes) throw new Error(r.message ?? '渲染失败');
  if (saveMode === 'final') {
    if (r.missing.length || missingImageNotes.length) throw new ApiError('MISSING_FACTS','必填内容或图片缺失，不能定稿');
    assertFinalBytes(r.bytes, '.' + (fmt === 'text' ? 'txt' : fmt));
  }

  assertInspectionRevision(input.inspectionId,input.periodId,input.inspectionRevision);
  if(inspectionSources!==inspectionSourceSignature(t,period,input.inspectionId))throw new ApiError('STALE_INSPECTIONS','汇总来源的检查记录已变化，请重新生成',409);
  if(planHead && input.saveMode==='final' && get('SELECT id FROM business_ai_run WHERE artifact_id=?',[planHead.id]))throw new ApiError('EVIDENCE_REVIEW_REQUIRED','业务助手文书修改后请先保存草稿，再在助手证据面板核对当前版本，最后明确确认定稿。',409);
  const saved = await saveGeneratedArtifact({
    dirAbs,
    fileName,
    bytes: r.bytes,
    plan,
    planHead,
    values: input.values,
    t,
    input,
    warnings,
    policyRequirement,
    onCommit: (artifact) => {
      if(sourceSignature!==documentSourceSignature(input.workbenchId,input.periodId,input.templateId,sourceArtifactIds,input.inspectionId))throw new ApiError('SOURCE_CHANGED','生成期间业务来源或模板发生变化，请重新核对后保存',409);
      assertInspectionRevision(input.inspectionId,input.periodId,input.inspectionRevision);
      if(period&&resultTarget){const current=resolvePeriodResultTarget(period,t.id,resultTarget.id);if(current?.artifact_id!==resultTarget.artifact_id||current?.status!==resultTarget.status)throw new ApiError('STALE_MATERIAL','成果材料关联已变化，请保留输入并重新核对',409);}
      if(period){const fresh=requirePeriod(period.id,input.workbenchId);if(fresh.snapshot!==period.snapshot||fresh.content!==period.content)throw new ApiError('STALE_PERIOD','期次内容或模板已变化，请重新核对后保存',409);}
      run('INSERT INTO artifact_fact_review(artifact_id,snapshot) VALUES(?,?)',[artifact.id,JSON.stringify({...factReview,digest:artifact.sha256,inspectionSources,sourceSignature,sourceArtifactIds})]);
      if(period){
        run('UPDATE artifact SET work_period_id=?,inspection_id=?,inspection_revision=? WHERE id=?',[period.id,inspection?.id??null,inspection?.revision??null,artifact.id]);
        const entry=JSON.parse(period.snapshot).templates.find((x:{id:number})=>x.id===t.id);
        const materialId=resultTarget?.id??entry?.materialId??get<{id:number}>('SELECT id FROM period_material WHERE period_id=? AND title=? AND config_key IS NULL',[period.id,t.name])?.id;
        if(materialId)run("UPDATE period_material SET artifact_id=?,status=?,note=? WHERE id=? AND period_id=? AND requirement_kind='generated' AND (status<>'verified' OR ?=1)",[artifact.id,plan?.isFinal?'verified':'provided','已自动关联模板成果；定稿由用户核对确认',Number(materialId),period.id,plan?.isFinal?1:0]);
        event(period.id,'generated',JSON.stringify({artifactId:artifact.id,templateId:t.id,materialId:materialId??null,templateUpdatedAt:t.updated_at,reportPeriod:period.report_period}));
      }
      input.onBusinessCommit?.(artifact);
      if(planHead&&!input.businessEvidenceManaged)inheritBusinessEvidence(planHead.id,artifact.id,input.values);
    },
  });
  return {
    artifact: getArtifact(saved.artifact.id) ?? saved.artifact,
    missing: r.missing,
    missingImages: missingImageNotes,
    version: plan
      ? { group: plan.group, revision: plan.revision, isFinal: plan.isFinal, supersedesId: plan.supersedesId }
      : null,
    warnings,
  };
}

/**
 * 「更新这一版 / 另存为定稿」的**落盘 + 提交**（缺陷修复①的落点）。
 *
 * 顺序（每一步失败都补偿回操作前的状态）：
 *   1. 老正式件搬进 `.versions/<group>/v<N>.<ext>`（只动磁盘，**先不动库**）；
 *   2. `saveArtifact()` 写新文件；
 *   3. 在其事务内登记 artifact、版本链、生成日志、事实核对、期次及证据关联。
 * 写入或登记失败时回滚整笔事务、移除本次新文件并恢复老文件位置。
 *
 * 名字被占用时 `saveArtifact` 会自己加 `_v2` 兜底 —— 那不是计划里的名字，必须说出来，
 * 但**不能**因此把新版本丢掉（记录与文件始终成对）。
 */
async function saveGeneratedArtifact(args: {
  dirAbs: string;
  fileName: string;
  bytes: Buffer;
  plan: {
    group: string;
    revision: number;
    supersedesId: number | null;
    isFinal: boolean;
    officialName: string;
    periodKey: string | null;
    adoptPeriodId: number | null;
  } | null;
  planHead: VersionedArtifact | null;
  values: Record<string, unknown>;
  t: Template;
  input: SaveGeneratedInput;
  warnings: string[];
  policyRequirement: PolicyRequirement;
  onCommit: (artifact:Artifact)=>void;
}): Promise<Awaited<ReturnType<typeof saveArtifact>>> {
  const { dirAbs, fileName, bytes, plan, planHead, values, t, input, warnings } = args;
  let move: ArchiveMove | null = null;
  if (plan && planHead) {
    move = archiveHeadForVersion(planHead, dirAbs, plan.group);
    warnings.push(...move.warnings);
  }

  let saved: Awaited<ReturnType<typeof saveArtifact>>;
  try {
    saved = await saveArtifact({
      dirAbs,
      fileName,
      data: bytes,
      workbenchId: input.workbenchId ?? null,
      positionCode: input.positionCode ?? null,
      kind: 'generated',
      title: t.name,
      templateId: t.id,
      checklistItemId: input.checklistItemId ?? null,
      docDate: dateOnly(),
      index: true,
      onCommit: artifact => {
        if(plan)commitVersionSave({head:planHead,move:move as ArchiveMove,plan,newArtifactId:artifact.id,log:{workbenchId:input.workbenchId??null,templateId:t.id,variables:values,mode:input.mode??'ai'}});
        else writeGenerationLog({workbenchId:input.workbenchId??null,templateId:t.id,artifactId:artifact.id,variables:values,mode:input.mode??'ai'});
        run('INSERT INTO artifact_policy_requirement(artifact_id,snapshot) VALUES(?,?)',[artifact.id,JSON.stringify(args.policyRequirement)]);
        args.onCommit(artifact);
      },
    });
  } catch (e) {
    /**
     * 新版本没登记成（只读目录、磁盘错误、清单校验…）：把老正式件搬回原位再抛错。
     * 库这一步还没开始，所以搬回去之后就是**操作前的状态**。
     */
    if (!move) throw e;
    const restore = rollbackArchive(move);
    if (!restore) throw e;
    throw new Error(
      `${(e as Error).message}（本次没有生成新版本：已把上一版搬回原位置，但没搬成 —— ${restore}）`,
    );
  }

  // 同名文件已存在时 saveArtifact 会加 `_v2` 兜底：这不是计划内的名字，必须说出来
  if (plan && saved.artifact.file_name !== plan.officialName) {
    warnings.push(`正式文件名被占用，这次实际落成了「${saved.artifact.file_name}」（原计划「${plan.officialName}」）。`);
  }

  return saved;
}

/* ------------------------------ 缺口分析 ------------------------------ */

export interface GapAnalysis {
  ok: boolean
  text: string
  error?: string
  model?: string
}

/** 让模型检查某个工作台还缺什么，用于验收前自查 */
export async function analyzeGaps(workbenchId: number): Promise<GapAnalysis> {
  const wb = getWorkbench(workbenchId);
  if (!wb) return { ok: false, text: '', error: '工作台不存在' };
  const detail = getWorkbenchDetail(workbenchId);
  if (!detail) return { ok: false, text: '', error: '工作台不存在' };
  const lines: string[] = [];
  for (const p of detail.positions) {
    lines.push(`阶段 ${p.seq}. ${p.name}（${p.status}）`);
    for (const c of p.checklist) {
      const done =
        c.kind === 'evidence' ? c.done_count >= c.min_count || c.status === 'na' : c.status === 'done' || c.status === 'na';
      lines.push(`  - [${done ? '✓' : ' '}] ${c.kind === 'evidence' ? '影像' : '材料'}：${c.title}${c.detail ? `（${c.detail}）` : ''}${c.required ? '' : ' [非必需]'}`);
    }
  }
  const res = await chat({
    purpose: 'reasoning',
    messages: [
      { role: 'system', content: '你是项目验收资料审核专家，说话直接、具体，不客套。' },
      {
        role: 'user',
        content: [
          `项目：${wb.code} ${wb.name}`,
          `工作类型：${detail.workType?.name ?? ''}`,
          wb.plan_end_date ? `计划完工：${wb.plan_end_date}` : '',
          '',
          '当前清单完成情况：',
          lines.join('\n'),
          '',
          '请输出：',
          '一、验收前必须补齐的关键缺口（按严重程度排序，说明缺了会有什么后果）',
          '二、容易被忽略但评委/审计常查的项',
          '三、建议的下一步动作（3 条以内）',
          '不要重复我给你的清单内容，只说问题和动作。',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    ref: { type: 'workbench', id: workbenchId },
  });
  if (!res.ok) return { ok: false, text: '', error: res.error };
  return { ok: true, text: res.text, model: res.model };
}

export { toPosix };
