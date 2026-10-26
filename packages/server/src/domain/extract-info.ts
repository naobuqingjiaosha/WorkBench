/**
 * 从资料里抽取项目信息（A：AI 读资料 → 项目信息）
 *
 * 场景：项目开局时手上有合同、批复、中标通知，里面本来就写着甲乙方、金额、账号、日期。
 * 与其对着 46 个空白框手打，不如让模型读一遍，把值连**出处**一起提出来，你确认后落盘。
 *
 * 铁律：
 *   1. 抽取值绝不直接写入项目信息 —— 必须过人工确认（见 confirmExtraction）。
 *   2. 每条都要带出处（来自哪个文件、哪句话），读错了你一眼能看出来。
 *   3. 抽不到就留空，**不许猜**。这条比「多抽几个」重要得多。
 *
 * 实现要点：这不是「调一次模型」那么简单，有三处必须处理好：
 *   · 文本超长要截断（合同动辄几万字，不可能整篇喂进去）
 *   · 字段值可能重复出现在多处，要挑最权威的那处（如金额以合同正文为准，不是附件清单）
 *   · 模型返回的值要和「已有值」对比，让用户选择保留哪个
 */
import { chat, parseJsonLoose } from '../ai/gateway.ts';
import { extractAny } from '../core/extract.ts';
import { listArchiveFields, readArchiveValues, writeArchiveValues, type ArchiveField } from './archive.ts';
import { getWorkbench } from './service.ts';

/* ============================== 类型 ============================== */

export interface ExtractedValue {
  field_key: string;
  label: string;
  /** 模型抽到的值 */
  value: string;
  /** 该项目信息里已有的值（有值则界面上让用户选保留哪个） */
  current?: string;
  /** 出处：文件名 + 位置/原文片段 */
  source: string;
  /** 模型自评把握程度 */
  confidence: 'high' | 'medium' | 'low';
  /** 字段类型，界面据此渲染 */
  type: string;
}

export interface ExtractResult {
  ok: boolean;
  /** 成功抽到的字段值 */
  items: ExtractedValue[];
  /** 模型认为这个文件里没有的字段（让它显式说明，避免我们误以为漏了） */
  notFound: string[];
  /** 资料文本抽取情况 */
  textInfo: { method: string; chars: number; truncated: boolean; ok: boolean; message?: string };
  usage: { prompt: number; output: number };
  model: string;
  /** 模型给的整体说明，如「这是一份设备采购合同」 */
  summary?: string;
  error?: string;
  rawText?: string;
}

/* ============================== 正文截断 ============================== */
/**
 * 合同动辄几万字，整篇喂进去既贵又容易被截断。
 * 但合同的关键信息（甲乙方、金额、账号、日期）通常在**开头和结尾**：
 * 开头是当事人条款，结尾是签署页和账户信息。所以保留首尾、掐掉中间，
 * 比从头截断合理得多。
 */
const HEAD_CHARS = 12_000;
const TAIL_CHARS = 6_000;
const MAX_CHARS = 40_000;

export function condenseText(text: string): { text: string; truncated: boolean } {
  const t = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= MAX_CHARS) return { text: t, truncated: false };
  const head = t.slice(0, HEAD_CHARS);
  const tail = t.slice(-TAIL_CHARS);
  const omitted = t.length - HEAD_CHARS - TAIL_CHARS;
  return {
    text: `${head}\n\n……（中间省略约 ${omitted} 字，此处多为合同正文条款，如需其中信息请单独提供）……\n\n${tail}`,
    truncated: true,
  };
}

/* ============================== 抽取 ============================== */

export async function extractProjectInfo(input: {
  workbenchId: number;
  /** 已归档文件的绝对路径 */
  absPath: string;
  /** 出处用的文件名 */
  fileName: string;
  /** 只抽这些字段；不给就抽该工作类型的全部字段 */
  fieldKeys?: string[];
  model?: string;
  maxTokens?: number;
}): Promise<ExtractResult> {
  const wb = getWorkbench(input.workbenchId);
  if (!wb) throw new Error('工作台不存在');

  // 取文本
  const ex = await extractAny(input.absPath);
  if (!ex.ok || !ex.text.trim()) {
    return {
      ok: false, items: [], notFound: [],
      textInfo: { method: ex.method, chars: 0, truncated: false, ok: false, message: ex.message },
      usage: { prompt: 0, output: 0 }, model: '',
      error: ex.message ?? '没能从这个文件里读出文字',
    };
  }
  const { text, truncated } = condenseText(ex.text);

  // 取字段定义与已有值
  const allFields = listArchiveFields(wb.work_type_id);
  const wanted = input.fieldKeys?.length
    ? allFields.filter((f) => input.fieldKeys?.includes(f.field_key))
    : allFields;
  if (!wanted.length) {
    return {
      ok: false, items: [], notFound: [],
      textInfo: { method: ex.method, chars: text.length, truncated, ok: true },
      usage: { prompt: 0, output: 0 }, model: '',
      error: '这个工作类型还没有定义项目信息字段',
    };
  }
  const current = readArchiveValues(input.workbenchId);

  const fieldLines = wanted
    .map((f) => {
      const bits = [`- ${f.field_key}｜${f.label}｜${f.type}`];
      if (f.hint) bits.push(`（${f.hint}）`);
      if (current[f.field_key]) bits.push(`［项目信息里已有：${current[f.field_key]}］`);
      return bits.join('');
    })
    .join('\n');

  const instruction = [
    '从下面的资料里抽取「项目信息」字段的值。',
    '',
    '【要抽取的字段】格式：字段标识｜显示名称｜类型',
    fieldLines,
    '',
    '【资料正文】',
    text,
    '',
    '【抽取规则】—— 严格遵守，这比多抽几个更重要',
    '1. 只抽资料里**明确写着**的值。资料里没有的，不要放进结果，也不要猜、不要推算。',
    '2. 同一个字段在资料里出现多次时，取**最权威**的那处：',
    '   · 金额以合同正文/价款条款为准，不要用附件清单或报价单的数字',
    '   · 单位名称以签署页盖章处为准，不要用正文里的简称',
    '   · 日期以签署页为准',
    '3. 值要**原样照抄**，不要改写、不要补全、不要规范化格式。',
    '   · 资料写「壹佰贰拾伍万元整」就照抄大写，不要转成数字',
    '   · 资料写「2026.9.16」就照抄，不要改成「2026年9月16日」',
    '4. 每条都要给出处：写清来自哪一部分，能引原文最好（如「第三条 合同价款」「签署页甲方盖章处」）。',
    '5. 把握程度：high=原文明确写着；medium=需要从上下文推断；low=不确定。',
    '',
    '【输出】只输出 JSON，不要解释文字，不要代码围栏：',
    '{"summary":"一句话说明这是什么资料",',
    ' "items":[{"k":"contract_no","v":"WJZ-2026-018","src":"首页右上角编号","conf":"high"}],',
    ' "notFound":["supervisor_org","party_b_bank"]}',
    '',
    'k=字段标识（必须与上面清单里的完全一致）',
    'v=抽到的值（原样照抄）',
    'src=出处',
    'conf=high|medium|low',
    'notFound=清单里有、但资料里确实没有的字段标识',
  ].join('\n');

  const res = await chat({
    purpose: 'extract',
    json: true,
    model: input.model,
    maxTokens: input.maxTokens ?? 8192,
    temperature: 0.1, // 抽取任务要确定性，不要发挥
    messages: [
      {
        role: 'system',
        content: '你是严谨的合同与公文信息抽取助手。只输出 JSON，只抽原文明确写着的内容，绝不编造、绝不推算。',
      },
      { role: 'user', content: instruction },
    ],
    ref: { type: 'project-info-extract', id: input.workbenchId },
  });

  const textInfo = { method: ex.method, chars: text.length, truncated, ok: true };

  if (!res.ok) {
    return {
      ok: false, items: [], notFound: [], textInfo,
      usage: res.usage, model: res.model,
      error: res.error ?? '模型调用失败',
      rawText: res.text?.slice(0, 4000),
    };
  }

  const parsed = parseJsonLoose<{ summary?: string; items?: unknown[]; notFound?: unknown[] }>(res.text);
  if (!parsed.ok || !parsed.value) {
    return {
      ok: false, items: [], notFound: [], textInfo,
      usage: res.usage, model: res.model,
      error: '模型返回的不是合法 JSON',
      rawText: res.text.slice(0, 4000),
    };
  }

  const byKey = new Map(wanted.map((f) => [f.field_key, f]));
  const items: ExtractedValue[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.value.items ?? []) {
    const o = raw as Record<string, unknown>;
    const key = String(o.k ?? o.field_key ?? '').trim();
    const value = o.v ?? o.value;
    if (!key || value === undefined || value === null) continue;
    const f = byKey.get(key);
    if (!f) continue;                                  // 不在请求清单里的字段，丢弃
    if (seen.has(key)) continue;                       // 同字段只取第一条
    const v = String(value).trim();
    if (!v) continue;
    seen.add(key);
    const conf = String(o.conf ?? o.confidence ?? 'medium');
    items.push({
      field_key: key,
      label: f.label,
      value: v,
      current: current[key] || undefined,
      source: String(o.src ?? o.source ?? '').trim() || '（模型未给出处）',
      confidence: conf === 'high' || conf === 'low' ? conf : 'medium',
      type: f.type,
    });
  }

  return {
    ok: true,
    items,
    notFound: (parsed.value.notFound ?? []).map((x) => String(x)).filter((k) => byKey.has(k)),
    textInfo,
    usage: res.usage,
    model: res.model,
    summary: parsed.value.summary ? String(parsed.value.summary) : undefined,
  };
}

/* ============================== 确认落盘 ============================== */

/**
 * 把用户确认过的抽取值写进项目信息。
 *
 * 只写用户明确勾选的字段 —— 抽取值从不自动落盘，
 * 调用方必须显式传入要采纳的键值对。
 */
export function confirmExtraction(
  workbenchId: number,
  accepted: Record<string, string>,
): { written: number; values: Record<string, string> } {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(accepted)) {
    if (typeof v === 'string' && v.trim() !== '') clean[k] = v.trim();
  }
  const values = writeArchiveValues(workbenchId, clean);
  return { written: Object.keys(clean).length, values };
}

/** 供界面用：把字段定义转成「哪些字段值得从资料里抽」的提示 */
export function extractableFields(fields: ArchiveField[]): ArchiveField[] {
  return fields.filter((f) => f.type !== 'longtext');
}
