/**
 * 模板占位符 —— 全系统对"模板变量"的唯一约定
 *
 * 约定：模板里写 {变量名}，变量名用中文或英文均可，不含空格与花括号。
 * 特殊写法：
 *   {变量名|默认值}   变量为空时使用默认值
 *   {#列表}...{/列表} 循环（暂未启用渲染，但扫描时会识别）
 *   {@图片}          图片占位（暂未启用渲染）
 */

export const PLACEHOLDER_RE = /\{([@#/]?)([^{}\r\n\t]{1,60}?)(?:\|([^{}\r\n\t]{0,120}))?\}/g;
export const SIMPLE_PLACEHOLDER_RE = /\{([^{}\r\n\t|@#/]{1,60})\}/g;
/** 仅供已明确标为非必填的字段使用，不能从外部 JSON 伪造。 */
export const OPTIONAL_EMPTY = Symbol('optional-empty');

export interface PlaceholderHit {
  /** 原始写法，如 {项目名称} */
  raw: string;
  /** 变量名 */
  name: string;
  /** 前缀符号：# 循环开始 / 循环结束 / @ 图片 / 空 普通 */
  prefix: string;
  /** 默认值 */
  fallback: string | null;
  index: number;
}

/** 扫描一段文本里的全部占位符，按出现顺序返回，已去重 */
export function scanPlaceholders(text: string): PlaceholderHit[] {
  const out: PlaceholderHit[] = [];
  const seen = new Set<string>();
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const prefix = m[1] ?? '';
    const name = (m[2] ?? '').trim();
    if (!name) continue;
    const key = `${prefix}${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ raw, name, prefix, fallback: m[3]?.trim() ?? null, index: m.index });
  }
  return out;
}

export function placeholderNames(text: string): string[] {
  return scanPlaceholders(text).map((h) => h.name);
}

export interface RenderOptions {
  /** 未提供值的变量，用什么替代。默认保留原占位符便于发现遗漏 */
  keepUnfilled?: boolean;
  /** 变量值后处理 */
  transform?: (name: string, value: string) => string;
}

/**
 * 渲染文本：把 {变量} 替换成值。
 * 缺失的变量默认原样保留（生成后一眼能看出哪里没填），可由 keepUnfilled=false 改为空串。
 */
export function renderText(text: string, values: Record<string, unknown>, opts: RenderOptions = {}): string {
  const keep = opts.keepUnfilled ?? true;
  return text.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (raw, prefix: string, nameRaw: string, fallback: string | undefined) => {
    const name = (nameRaw ?? '').trim();
    if (prefix === '#' || prefix === '/' || prefix === '@') return raw; // 高级写法暂不处理
    const has = Object.prototype.hasOwnProperty.call(values, name);
    const v = has ? values[name] : undefined;
    if(v===OPTIONAL_EMPTY)return fallback??'';
    const isEmpty = v === null || v === undefined || String(v).trim() === '';
    // 没值但有默认值 → 用默认值。这一条必须在 keepUnfilled 判断之前，
    // 否则 {变量|默认值} 这种写法在没人填时会原样留在文档里。
    if (isEmpty) {
      if (fallback !== undefined && fallback !== '') return fallback;
      return keep ? raw : '';
    }
    const s = String(v);
    return opts.transform ? opts.transform(name, s) : s;
  });
}

/** 找出模板里出现但没给值的变量 */
export function missingVariables(text: string, values: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const hit of scanPlaceholders(text)) {
    if (hit.prefix) continue;
    const v = values[hit.name];
    if(v===OPTIONAL_EMPTY)continue;
    if (v === undefined || v === null || String(v).trim() === '') {
      if (!hit.fallback) missing.push(hit.name);
    }
  }
  return missing;
}
