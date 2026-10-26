import {checkedOfficeBytes,readOfficeBytes} from './office-package.ts';
/**
 * 模板引擎
 *
 * docx：直接对 word/document.xml、页眉页脚做文本替换。占位符与 Runs 在同段时最可靠；
 *       跨 Run 的情况用「同段落内合并匹配」兜底。
 * xlsx：用 exceljs 读入 → 逐单元格替换 → 另存，公式、样式、列宽全部保留。
 *
 * Word 使用本模块的 XML 替换器，跨 Run 变量在同段落内合并匹配。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import PizZip from './office-package.ts';
import { ensureDir } from './paths.ts';
import { renderText, scanPlaceholders, missingVariables, OPTIONAL_EMPTY, type PlaceholderHit } from './placeholders.ts';

export type TemplateFormat = 'docx' | 'xlsx' | 'doc' | 'xls' | 'pdf' | 'image' | 'text' | 'other';

export function detectFormat(file: string): TemplateFormat {
  const ext = extname(file).toLowerCase();
  switch (ext) {
    case '.docx':
      return 'docx';
    case '.xlsx':
    case '.xlsm':
      return 'xlsx';
    case '.doc':
      return 'doc';
    case '.xls':
      return 'xls';
    case '.pdf':
      return 'pdf';
    case '.txt':
    case '.md':
    case '.csv':
      return 'text';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
    case '.gif':
    case '.bmp':
    case '.tif':
    case '.tiff':
      return 'image';
    default:
      return 'other';
  }
}

export function canRender(format: TemplateFormat): boolean {
  return format === 'docx' || format === 'xlsx' || format === 'text';
}

/* ---------------------------- 模板健康校验 ---------------------------- */

export interface TemplateHealth {
  ok: boolean;
  reason: string | null;
  checkedAt: string;
}

/**
 * 校验 docx/xlsx 是否真的能被渲染：打不开或 XML 不合法就 ok:false + 可读 reason。
 *
 * 为什么需要它：源文件损坏（word/document.xml 被截断、`<w:p ...>` 开头被删掉、
 * `<w:tc>` 少一个闭合）时，PizZip 照样能读出字节、`generate()` 也能生成出一个 zip，
 * 于是接口一路"成功"，用户拿到一个 Word 打不开的文件，还以为是 Word 的问题。
 * 实测的 6 个坏模板（id 65/73/76/77/84/96）全是这种"zip 正常、XML 非法"。
 *
 * 判定口径：
 *   docx → PizZip 打得开 + 有 word/document.xml + **参与渲染的每个 XML 部件**都良构
 *          （正文/页眉/页脚/脚注/尾注/批注，与渲染用的 docxParts 同一个来源，
 *            因为页眉里的坏 XML 一样会让成品打不开）
 *   xlsx → PizZip 打得开 + 有 xl/workbook.xml 且良构 + 至少一个工作表部件且良构
 *   其它格式（text/pdf/image/doc/xls…）→ 一律 ok：本系统不渲染它们，不该拦
 *
 * 只读文件、不修改、不落盘；单次校验是几次 indexOf 级扫描，毫秒级。
 */
export function checkTemplateHealth(absPath: string, bytes?: Buffer): TemplateHealth {
  const checkedAt = new Date().toISOString();
  let buf: Buffer;
  try {
    buf = bytes ?? readFileSync(absPath);
  } catch (e) {
    return { ok: false, reason: `模板文件读不到（${errText(e)}），可能已被移动或删除，请在界面上重新上传`, checkedAt };
  }

  let zip: PizZip;
  try {
    zip = new PizZip(buf);
  } catch (e) {
    return { ok: false, reason: `这个文件打不开（${errText(e)}），本身已经损坏，请用 Word/Excel 打开原件另存后重新上传`, checkedAt };
  }

  const fmt = detectFormat(absPath);
  if (fmt === 'xlsx') return checkXlsxHealth(zip, checkedAt);
  if (fmt !== 'docx') return { ok: true, reason: null, checkedAt };

  if (!zip.file('word/document.xml')) {
    return { ok: false, reason: '这个 .docx 里没有正文部件 word/document.xml（文件损坏或不是 Word 文档），请重新上传', checkedAt };
  }
  for (const part of docxParts(zip)) {
    const f = zip.file(part);
    if (!f) continue;
    const bad = xmlMalformed(f.asText());
    if (bad) {
      return {
        ok: false,
        reason: `${part} 的 XML 不合法（第 ${bad.line} 行）：${bad.message}。生成出来的文件 Word 打不开，请用 Word 打开原件另存为 .docx 后重新上传`,
        checkedAt,
      };
    }
  }
  return { ok: true, reason: null, checkedAt };
}

/** xlsx：结构上必须能读到一个工作簿与至少一张工作表（与 docx 同一套 XML 良构判定） */
function checkXlsxHealth(zip: PizZip, checkedAt: string): TemplateHealth {
  const wb = zip.file('xl/workbook.xml');
  if (!wb) return { ok: false, reason: '这个 .xlsx 里没有工作簿部件 xl/workbook.xml（文件损坏或不是 Excel 文档），请重新上传', checkedAt };
  const badWb = xmlMalformed(wb.asText());
  if (badWb) {
    return { ok: false, reason: `xl/workbook.xml 的 XML 不合法（第 ${badWb.line} 行）：${badWb.message}。生成出来的文件 Excel 打不开，请重新上传`, checkedAt };
  }
  const sheets = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d*\.xml$/.test(n));
  if (!sheets.length) return { ok: false, reason: '这个 .xlsx 里没有任何工作表部件（xl/worksheets/sheet*.xml），文件不完整，请重新上传', checkedAt };
  for (const s of sheets) {
    const f = zip.file(s);
    if (!f) continue;
    const bad = xmlMalformed(f.asText());
    if (bad) {
      return { ok: false, reason: `${s} 的 XML 不合法（第 ${bad.line} 行）：${bad.message}。生成出来的文件 Excel 打不开，请重新上传`, checkedAt };
    }
  }
  return { ok: true, reason: null, checkedAt };
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 160);
}

/**
 * 轻量 XML 良构（well-formedness）校验 —— 自己写的，不引第三方依赖。
 *
 * 只回答一个问题：这段 XML 解析器能不能吃下去。不做 schema / 命名空间 / 语义校验，
 * 所以**不会**因为"标签不认识、属性不认识"把正常模板判坏。判据只有下面这些硬规则：
 *   · 标签必须成对（含自闭合 `<x/>`）、不能交叉
 *   · 属性值必须用引号括起来、引号必须闭合
 *   · `&` 只能是合法实体（`&amp;` `&#12290;` `&#x3002;` …），正文里裸 `&` 非法
 *   · 注释 `<!-- -->`、CDATA `<![CDATA[ ]]>`、处理指令 `<? ?>` 必须闭合
 *   · 必须有且只有一个根元素
 * 报错带行号 + 出错标签名，够用户和界面看懂"坏在哪"。
 *
 * 实现是单次从左到右的 indexOf/字符扫描（没有正则回溯），150KB 的 document.xml
 * 实测不到 1ms，且完全不碰文件。
 */
function xmlMalformed(xml: string): { line: number; message: string } | null {
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const n = src.length;
  /** 栈里只存标签名与下标；行号只在报错时算一次（每次都算会把校验拖成 O(n²)） */
  const stack: { name: string; index: number }[] = [];
  let roots = 0;
  const lineOf = (idx: number): number => {
    let line = 1;
    const end = Math.min(idx, n);
    for (let k = 0; k < end; k++) if (src.charCodeAt(k) === 10) line++;
    return line;
  };
  const bad = (idx: number, message: string) => ({ line: lineOf(idx), message });

  let i = 0;
  while (i < n) {
    const lt = src.indexOf('<', i);
    // 标签之间的正文：只查没转义的 &
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      const ent = BAD_ENTITY_RE.exec(src.slice(i, textEnd));
      if (ent) return bad(i + ent.index, '有没转义的 "&"（正文里的 & 要写成 &amp;）');
    }
    if (lt < 0) break;
    i = lt;

    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4);
      if (e < 0) return bad(i, '注释 <!-- 没有闭合');
      i = e + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9);
      if (e < 0) return bad(i, 'CDATA 段 <![CDATA[ 没有闭合');
      i = e + 3;
      continue;
    }
    if (src.startsWith('<!', i)) {
      // 文档类型声明（docx/xlsx 实际不会用，但别在这里误判）
      let e = src.indexOf('>', i + 2);
      const lb = src.indexOf('[', i + 2);
      if (lb >= 0 && (e < 0 || lb < e)) {
        const rb = src.indexOf(']', lb);
        if (rb < 0) return bad(i, '文档类型声明 <!…[ 没有闭合');
        e = src.indexOf('>', rb);
      }
      if (e < 0) return bad(i, '文档声明 <! 没有结束');
      i = e + 1;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i + 2);
      if (e < 0) return bad(i, '处理指令 <? 没有闭合');
      i = e + 2;
      continue;
    }
    if (src.startsWith('</', i)) {
      const e = src.indexOf('>', i + 2);
      if (e < 0) return bad(i, '结束标签缺少 ">"');
      const name = src.slice(i + 2, e).trim();
      if (!name) return bad(i, '空的结束标签 "</>"');
      const top = stack[stack.length - 1];
      if (!top) {
        return bad(i, `多了一个结束标签 </${name}>：前面没有与之配对的开始标签（通常是某个开始标签被截断或删掉了）`);
      }
      if (top.name !== name) {
        return bad(i, `标签 <${top.name}>（第 ${lineOf(top.index)} 行）没有正确闭合，这里遇到的却是 </${name}>（通常是某对标签被删掉或截断了）`);
      }
      stack.pop();
      i = e + 1;
      continue;
    }

    // 开始标签
    const first = src[i + 1];
    if (first === undefined) return bad(i, '文件在一个没写完的 "<" 处结束');
    if (!isNameStart(first)) return bad(i, '"<" 后面不是合法的标签名（正文里的 "<" 要写成 &lt;）');
    let j = i + 1;
    while (j < n && isNameChar(src[j]!)) j++;
    const name = src.slice(i + 1, j);
    let selfClose = false;
    for (;;) {
      while (j < n && isWs(src[j]!)) j++;
      if (j >= n) return bad(i, `标签 <${name}> 没有 ">" 收尾`);
      const c = src[j]!;
      if (c === '>') {
        j++;
        break;
      }
      if (c === '/') {
        if (src[j + 1] === '>') {
          selfClose = true;
          j += 2;
          break;
        }
        return bad(j, `标签 <${name}> 里的 "/" 后面必须是 ">"`);
      }
      if (!isNameStart(c)) return bad(j, `标签 <${name}> 的属性名不合法`);
      const aStart = j;
      while (j < n && isNameChar(src[j]!)) j++;
      const attr = src.slice(aStart, j);
      while (j < n && isWs(src[j]!)) j++;
      if (src[j] !== '=') return bad(j, `标签 <${name}> 的属性 ${attr} 后面缺少 "="`);
      j++;
      while (j < n && isWs(src[j]!)) j++;
      const quote = src[j];
      if (quote !== '"' && quote !== "'") return bad(j, `标签 <${name}> 的属性 ${attr} 的值没有用引号括起来`);
      const vEnd = src.indexOf(quote, j + 1);
      if (vEnd < 0) return bad(j, `标签 <${name}> 的属性 ${attr} 的引号没有闭合`);
      const ent = BAD_ENTITY_RE.exec(src.slice(j + 1, vEnd));
      if (ent) return bad(j + 1 + ent.index, `标签 <${name}> 的属性 ${attr} 里有没转义的 "&"`);
      j = vEnd + 1;
    }
    if (stack.length === 0) roots++;
    if (!selfClose) stack.push({ name, index: i });
    i = j;
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) return { line: lineOf(unclosed.index), message: `标签 <${unclosed.name}> 一直没有闭合` };
  if (roots === 0) return { line: 1, message: '里面没有任何 XML 元素' };
  if (roots > 1) return { line: 1, message: `有 ${roots} 个根元素，XML 只能有一个根元素` };
  return null;
}

/** 裸 & —— 不是 &amp;/&lt;… 也不是 &#12290;/&#x3002; 这类字符引用 */
const BAD_ENTITY_RE = /&(?!#[0-9]+;|#x[0-9A-Fa-f]+;|[A-Za-z_][A-Za-z0-9_.:-]*;)/;
const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\n';
const isNameStart = (c: string): boolean => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' || c === ':';
const isNameChar = (c: string): boolean => isNameStart(c) || (c >= '0' && c <= '9') || c === '-' || c === '.';

/* ------------------------------ 变量扫描 ------------------------------ */

/**
 * docx 里参与变量扫描与渲染的 XML 部件。
 *
 * 以前这里是硬编码的 header1-3 / footer1-3 —— 多节文档（公文常见的"首页不同/
 * 横向页/附件页"）会把第 2 节的页眉存进 word/header4.xml 甚至 header7.xml：
 * 那些部件既扫不出 `{变量}`（界面不列、也不提示漏填），渲染时也不替换，
 * 生成物里原样留着 `{甲方}`。
 * 所以不枚举部件名，改为遍历 zip 内所有 header1、header4…以及 footer 这类部件，并带上正文/脚注/尾注/批注。
 * 扫描（scanDocx）与渲染（renderDocxBuffer）共用这一个来源，避免两边不一致。
 */
const DOCX_PART_RE = /^word\/(?:header|footer)\d*\.xml$/;
const DOCX_CORE_PARTS = [
  'word/document.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'word/comments.xml',
];

function docxParts(zip: PizZip): string[] {
  const found = Object.keys(zip.files)
    .filter((name) => DOCX_PART_RE.test(name) || DOCX_CORE_PARTS.includes(name))
    .sort();
  // 正文排最前，预览与漏填提示的顺序才符合阅读习惯
  const ordered = ['word/document.xml', ...found.filter((name) => name !== 'word/document.xml')];
  return ordered.filter((name) => Boolean(zip.file(name)));
}

function docxXmlToPlain(xml: string): string {
  return decodeXml(
    xml
      .replace(/<w:tab\s*\/>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

export interface ScanResult {
  format: TemplateFormat;
  variables: PlaceholderHit[];
  /** 模板里出现的示例值/说明，便于人工对照 */
  preview: string;
  warnings: string[];
  previewTruncated?: boolean;
  /** 独立于摘要长度保存命中位置，摘要之外的变量也能核对。 */
  locations?: { name: string; raw: string; location: string; context: string }[];
}

/**
 * 扫描 docx 变量（含循环集合名、图片名）。
 *
 * 走的是 analyzeDocxText（同一套标记口径）：
 *   · `{#循环 集合名}` → 变量「集合名」，raw 里保留标记原文（界面据此标出「这是循环」）
 *   · `{@图片 图片名}` → 变量「图片名」
 *   · 循环体内的 `{字段}` **不**再当成顶层变量（避免变量清单与覆盖率重复计）
 * 集合名/图片名的 prefix 留空，是为了让 domain/service.ts 的
 * `scan.variables.filter(v => !v.prefix)` 不把它们过滤掉（那条链路不归本文件管）；
 * 是不是循环/图片看 `raw` 就知道。
 */
export function scanDocx(absPath: string | Buffer): ScanResult {
  const zip = new PizZip(typeof absPath === 'string' ? readFileSync(absPath) : absPath);
  const texts: string[] = [];
  const seen = new Map<string, PlaceholderHit>();
  const warnings: string[] = [];
  const locations: NonNullable<ScanResult['locations']> = [];
  for (const part of docxParts(zip)) {
    const f = zip.file(part);
    if (!f) continue;
    const plain = docxXmlToPlain(f.asText());
    texts.push(plain);
    const analysis = analyzeDocxText(plain);
    const label = part === 'word/document.xml' ? '正文' : /^word\/header/.test(part) ? '页眉' : /^word\/footer/.test(part) ? '页脚' : part;
    plain.split('\n').forEach((line, index) => {
      for (const hit of scanPlaceholders(line)) {
        const recognized = analysis.hits.find(v => v.raw === hit.raw || (!hit.prefix && v.name === hit.name));
        if (recognized) locations.push({ name: recognized.name, raw: hit.raw, location: `${label} · 第 ${index + 1} 段`, context: line.slice(Math.max(0, hit.index - 120), hit.index + hit.raw.length + 120) });
      }
    });
    for (const hit of analysis.hits) if (!seen.has(hit.name)) seen.set(hit.name, hit);
    for (const w of analysis.warnings) if (!warnings.includes(w)) warnings.push(w);
  }
  if (!seen.size) {
    warnings.push('没有扫描到 {变量}。若模板里用的是其它写法（如【变量】），请告诉我，我来适配扫描规则。');
  }
  return {
    format: 'docx',
    variables: [...seen.values()],
    preview: texts.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000),
    warnings,
    previewTruncated: texts.join('\n').replace(/\n{3,}/g, '\n\n').trim().length > 8000,
    locations,
  };
}

export async function scanXlsx(absPath: string): Promise<ScanResult> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readOfficeBytes(absPath) as never);
  const seen = new Map<string, PlaceholderHit>();
  const lines: string[] = [];
  const locations: NonNullable<ScanResult['locations']> = [];
  wb.eachSheet((ws) => {
    lines.push(`【工作表：${ws.name}】`);
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        // 合并区域只读取主单元格，避免将一个变量误报成多个位置。
        if (cell.isMerged && cell.master.address !== cell.address) return;
        const s = cellText(cell.value);
        if (!s) return;
        cells.push(s);
        for (const hit of scanPlaceholders(s)) {
          if (!seen.has(hit.name)) seen.set(hit.name, hit);
          locations.push({ name: hit.name, raw: hit.raw, location: `${ws.name}!${cell.address}`, context: s.slice(Math.max(0, hit.index - 120), hit.index + hit.raw.length + 120) });
        }
      });
      if (cells.length) lines.push(cells.join('\t'));
    });
  });
  const analysis = scanTemplateStructure(absPath);
  return {
    format: 'xlsx',
    variables: analysis.collections.length ? analyzeDocxText(lines.join('\n')).hits : [...seen.values()],
    preview: lines.join('\n').slice(0, 8000),
    warnings: seen.size ? [] : ['没有扫描到 {变量}，请确认模板里已把固定文字换成 {变量名}。'],
    previewTruncated: lines.join('\n').length > 8000,
    locations,
  };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('text' in o) return String(o.text);
    if ('result' in o) return String(o.result ?? '');
    if ('formula' in o) return `=${String(o.formula)}`;
  }
  return '';
}

export async function scanTemplate(absPath: string): Promise<ScanResult> {
  const fmt = detectFormat(absPath);
  if (fmt === 'docx') return scanDocx(absPath);
  if (fmt === 'xlsx') return await scanXlsx(absPath);
  if (fmt === 'text') {
    const text = readFileSync(absPath, 'utf8');
    return { format: 'text', variables: scanPlaceholders(text), preview: text.slice(0, 8000), previewTruncated: text.length > 8000, warnings: [] };
  }
  return {
    format: fmt,
    variables: [],
    preview: '',
    warnings:
      fmt === 'doc' || fmt === 'xls'
        ? [`${fmt} 是旧版 Office 二进制格式，无法填充变量。请用 Word/Excel 打开后"另存为" .${fmt === 'doc' ? 'docx' : 'xlsx'}。`]
        : ['该格式不支持变量填充，可作为参考资料或影像证据使用。'],
  };
}

/* ------------------------------ 模板渲染 ------------------------------ */

export interface RenderResult {
  ok: boolean;
  bytes?: Buffer;
  missing: string[];
  /** 未能插入的图片（可读提示；同时以「图片：名字」的形式并入 missing，让预览提示也能看到） */
  missingImages?: string[];
  /** 渲染过程中的提醒（循环不配对、集合没数据、图片走了兜底…） */
  notes?: string[];
  message?: string;
}

export async function renderTemplate(
  absPath: string,
  values: Record<string, unknown>,
  outAbsPath?: string,
  assets?: RenderAssets,
): Promise<RenderResult> {
  const fmt = detectFormat(absPath);
  const missing: string[] = [];
  let missingImages: string[] = [];
  let notes: string[] = [];
  let bytes: Buffer;

  if (fmt === 'docx') {
    const r = renderDocxBuffer(absPath, values, assets);
    bytes = r.bytes;
    /**
     * docx 也要回报漏填变量。
     *
     * 服务端一直用 `X-Missing-Vars` 响应头当契约、界面据此提示"有 N 项没填"，
     * 但只有 xlsx 分支会填这个数组 —— 而 docx 是项目里的主力模板格式，
     * 等于这条提示对最常用的场景**永远不出现**，用户以为都填好了。
     * 做法：渲染前拿变量表与 values 求差（见 renderDocxBuffer）。
     */
    missing.push(...r.missing);
    missingImages = r.missingImages;
    notes = r.notes;
  } else if (fmt === 'xlsx') {
    const r = await renderXlsxBuffer(absPath, values);
    bytes = r.bytes;
    missing.push(...r.missing);
  } else if (fmt === 'text') {
    const src = readFileSync(absPath, 'utf8');
    /**
     * 文本模板以前用 keepUnfilled:false 且不填 missing —— 缺的变量被静默抹成空白，
     * 服务端的 `X-Missing-Vars` 契约（routes-generate.ts）对 .txt/.md/.csv **永远不提示**，
     * 用户交出去的是一份少了内容的文件还以为填好了。
     * 改成保留 `{变量}` 便于发现遗漏，并用 missingVariables 如实回报漏填项。
     */
    bytes = Buffer.from(renderText(src, values, { keepUnfilled: true }), 'utf8');
    missing.push(...missingVariables(src, values));
  } else {
    return {
      ok: false,
      missing: [],
      message: `不支持的模板格式：${fmt}。请使用 .docx / .xlsx。`,
    };
  }

  if (outAbsPath) {
    ensureDir(dirname(outAbsPath));
    writeFileSync(outAbsPath, bytes);
  }
  return { ok: true, bytes, missing, missingImages, notes };
}

/**
 * docx：按 XML 部件做替换，保留所有格式。
 *
 * 一轮里跑四步（顺序有讲究）：
 *   ① 扫描结构（集合/图片/顶层变量）→ 漏填项在**渲染前**求差
 *   ② 展开循环（克隆 + 逐份替换字段 + 逐份插图片）
 *   ③ 顶层占位符替换（覆盖循环外的普通变量）
 *   ④ 顶层图片插入
 * 值里的花括号全程由 TokenPool 保护，整篇处理完再还原。
 * 旧模板（没有 `{#循环` / `{@图片`）走的就是原来那条路：结构分析与替换都是空转。
 */
function renderDocxBuffer(
  absPath: string,
  values: Record<string, unknown>,
  assets?: RenderAssets,
): { bytes: Buffer; missing: string[]; missingImages: string[]; notes: string[] } {
  const zip = new PizZip(readFileSync(absPath));
  const report: RenderReport = { missing: new Set<string>(), missingImages: [], notes: [] };
  const tokens = createTokenPool();
  const media = new DocxMediaWriter(zip);
  for (const part of docxParts(zip)) {
    const f = zip.file(part);
    if (!f) continue;
    const originalXml = f.asText();
    const plain = docxXmlToPlain(originalXml);
    const analysis = analyzeDocxText(plain);
    /**
     * 漏填项在**渲染前**求差（与 xlsx 分支同一套做法）。
     *
     * 以前是"渲染完再扫残留的 `{...}`"，只要还有花括号就算缺项 ——
     * 于是某个变量的**值里含花括号**（例如"待{甲方}确认"）时就会虚报漏填，
     * 用户回去找不到到底哪一项没填。
     * 有循环/图片时，循环区域整段抹掉再求差：循环体内的字段由集合的每一项提供，
     * 不该按顶层变量报缺；集合名本身则要报（否则集合没给数据时没人提醒）。
     */
    if (!analysis.collections.length && !analysis.images.length) {
      for (const name of missingVariables(plain, values)) report.missing.add(name);
    } else {
      for (const name of missingVariables(stripLoopRegions(plain), values)) {
        if (name !== ROW_NUMBER_PLAIN) report.missing.add(name);
      }
    }

    const ctx: DocxCtx = { part, assets, media, tokens, report };
    let xml = originalXml;
    xml = expandLoops(xml, values, ctx);
    xml = replaceInXml(xml, values, { tokens });
    xml = insertImages(xml, ctx);
    xml = tokens.restore(xml);
    if (xml !== originalXml) zip.file(part, xml);
  }
  media.finalize();
  for (const label of report.missingImages) report.missing.add(`图片：${label}`);
  return {
    bytes: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer,
    missing: [...report.missing],
    missingImages: report.missingImages,
    notes: report.notes,
  };
}

/* ---------------------- 段落文本槽 / 花括号保护（共用底层） ---------------------- */

/** 段落的 XML 片段正则：扫描与渲染两处共用，口径必须一致（含正文、表格单元格里的段落） */
const PARA_SRC = '<w:p(?:\\s[^>]*)?>[\\s\\S]*?</w:p>';
const TXT_SRC = '<w:t(?:\\s[^>]*)?>([\\s\\S]*?)</w:t>';

interface TextSlot {
  /** `<w:t …>` 开标签原文（写回时要按需补 xml:space="preserve"） */
  readonly open: string;
  /** `<w:t>` 在段落 XML 里的下标（图片插入要定位到所在的 `<w:r>`） */
  readonly ws: number;
  text: string;
}

function readSlots(para: string): TextSlot[] {
  const out: TextSlot[] = [];
  const re = new RegExp(TXT_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(para))) {
    const tag = m[0]!.slice(0, m[0]!.indexOf('>') + 1);
    out.push({ open: tag, ws: m.index, text: decodeXml(m[1] ?? '') });
  }
  return out;
}

const joinedText = (slots: TextSlot[]): string => slots.map((s) => s.text).join('');

function slotStarts(slots: TextSlot[]): number[] {
  const out: number[] = [];
  let cursor = 0;
  for (const s of slots) {
    out.push(cursor);
    cursor += s.text.length;
  }
  return out;
}

/**
 * 把若干处改写（坐标 = 段落合并后的文本）落到各个 `<w:t>` 槽里。
 *
 * 一条占位符可能被 Word 拆进多个 `<w:t>`：改写只把替换文本落在**包含改写起点**的那个槽，
 * 其余被覆盖到的槽只删掉自己那一截，绝不搬动标签 —— 这样 `<w:rPr>`/`<w:pPr>` 与 run 的
 * 划分原样保留。edits 之间互不重叠，倒序处理保证坐标不互相影响。
 */
function spliceSlots(slots: TextSlot[], original: string, edits: { a: number; b: number; text: string }[]): void {
  const starts = slotStarts(slots);
  for (const e of [...edits].sort((x, y) => y.a - x.a)) {
    const { a, b, text } = e;
    for (let i = slots.length - 1; i >= 0; i--) {
      const start = starts[i]!;
      const end = i + 1 < starts.length ? starts[i + 1]! : original.length;
      if (start >= b || end <= a) continue;
      const left = Math.max(0, a - start);
      const right = Math.min(end - start, b - start);
      slots[i]!.text = slots[i]!.text.slice(0, left) + (a >= start ? text : '') + slots[i]!.text.slice(right);
    }
  }
}

/**
 * 把改好的槽写回段落。
 *
 * 这一段没有被改动 → 原样返回原始片段。
 *
 * 以前对所有段落（哪怕一个占位符都没有）都重建 <w:t>，等于做一次
 * decodeXml → encodeXml 往返；而这两个函数**并不互逆**（原 decodeXml 不认 `&#12290;`
 * 这类数字实体，encodeXml 又把 & 转成 &amp;），于是 WPS / Google Docs / pandoc /
 * python-docx 导出的数字实体被二次转义，Word 里出现字面 `&#12290;`。
 * 未变化就跳过，从根上避免"无关段落也被改写"。
 */
function encodeWordText(text: string): string {
  return encodeXml(text)
    .replace(/\r?\n/g, '</w:t><w:br/><w:t xml:space="preserve">')
    .replace(/\t/g, '</w:t><w:tab/><w:t xml:space="preserve">');
}

function writeSlotsBack(para: string, slots: TextSlot[], original: string): string {
  if (joinedText(slots) === original) return para;
  let i = 0;
  return para.replace(new RegExp(TXT_SRC, 'g'), () => {
    const s = slots[i++]!;
    const open = s.open.replace(/\sxml:space=["'][^"']*["']/, '').replace(/^<w:t/, '<w:t xml:space="preserve"');
    return (
      open +
      encodeWordText(s.text) +
      '</w:t>'
    );
  });
}

/**
 * 值里的花括号保护池。
 *
 * 循环是「克隆 N 份 → 逐份替换」的，同一个段落会被替换**多轮**（内层循环一轮、外层一轮、
 * 最后整篇再来一轮）。某个变量的值本身就可能含花括号（例如"待{甲方}确认"），
 * 不保护的话下一轮会把值里的 {甲方} 当占位符再替换一次。
 * 做法：插入时先用私用区标记占位（encodeXml 不碰这两个字符），整篇处理完再还原。
 */
export interface TokenPool {
  add(text: string): string;
  restore(xml: string): string;
}

function createTokenPool(): TokenPool {
  const items: string[] = [];
  return {
    add(text: string): string {
      if (!/[{}]/.test(text)) return text;
      items.push(text);
      return `\uE000${items.length - 1}\uE001`;
    },
    restore(xml: string): string {
      if (!items.length) return xml;
      return xml.replace(/\uE000(\d+)\uE001/g, (raw, d: string) => items[Number(d)] === undefined ? raw : encodeWordText(items[Number(d)]!));
    },
  };
}

/* ------------------------- 循环 / 图片的语法常量 ------------------------- */

/**
 * 语法（界面用法说明、扫描、渲染三处口径一致）：
 *
 *   {#循环 集合名} … {/循环}     重复区域。可跨多个段落，也可以只在同一表格行（<w:tr>）里
 *   {字段名}                     循环体内取「当前项」的字段；顶层同名值作为回落
 *   {@序号} / {_行号}            循环体内取 1 起的行号（{_行号} 是等价别名）
 *   {@图片 图片名}               插入图片，独占段落/单元格时按原段落位置插入
 *
 * 集合为空数组/空串 → 整段/整行删掉；集合压根没给值 → 原样保留标记并回报
 * （把「集合名写错」变成「内容凭空消失」比留着标记更糟）。
 */
export const ROW_NUMBER_AT = '序号';
export const ROW_NUMBER_PLAIN = '_行号';
export const DEFAULT_IMAGE_NAME = '照片';

/**
 * docx 正文里所有「高级/普通」写法的统一扫描器（组号必须与 analyzeDocxText 一一对应）：
 *   组 1     = {#循环 集合名} 的集合名
 *   组 2     = {/循环} 整段
 *   组 3     = {@图片 图片名} 的图片名
 *   组 4/5/6 = 普通变量：前缀 / 名字 / 默认值
 * 跨 run 拆分的写法由「同段落合并文本」兜住（与渲染同一条链路）。
 */
const DOCX_TOKEN_SRC =
  '\\{#\\s*循环\\s*([^{}\\r\\n\\t]{1,60}?)\\}' +
  '|(\\{\\/\\s*循环[^{}\\r\\n\\t]{0,60}?\\})' +
  '|\\{@\\s*图片\\s*([^{}\\r\\n\\t]{0,60}?)\\}' +
  '|\\{([@#/]?)([^{}\\r\\n\\t]{1,60}?)(?:\\|([^{}\\r\\n\\t]{0,120}))?\\}';

/** 循环标记（在合并文本里定位用） */
const LOOP_MARKER_SRC = '\\{#\\s*循环\\s*([^{}\\r\\n\\t]{1,60}?)\\}|\\{\\/\\s*循环[^{}\\r\\n\\t]{0,60}?\\}';
/** 图片标记 */
const IMAGE_MARKER_SRC = '\\{@\\s*图片\\s*([^{}\\r\\n\\t]{0,60}?)\\}';

/** 「照片」这类通用叫法：没有同名影像时按序取（循环体内按行号取），而不是判定为缺图 */
const GENERIC_IMAGE_NAMES = ['照片', '图片', '现场照片', '影像', '影像证据', '图像', 'photo', 'image', 'picture'];

/**
 * 在 WordprocessingML 里替换占位符。
 * 难点：Word 会把 {项目名称} 拆进多个 <w:r><w:t> 里。
 * 做法：先把每个 <w:p> 段落里的全部 <w:t> 文本抽出来拼成整段，找到占位符后，
 *       把结果写回该段第一个 <w:t>，其余 <w:t> 清空，保证段落格式不乱。
 *
 * `ctx` 是**显式传入**的上下文（循环当前项与行号），不是全局状态：
 *   · item     循环体内 `{字段}` 优先从这里取（当前项），取不到才回落到 values
 *   · rowIndex `{@序号}` / `{_行号}` 的取值（1 起）
 *   · tokens   值里花括号的保护池（整篇渲染时跨多轮替换复用；不传就当场还原）
 */
export interface ReplaceContext {
  item?: Record<string, unknown>;
  rowIndex?: number;
  tokens?: TokenPool;
}

export function replaceInXml(xml: string, values: Record<string, unknown>, ctx: ReplaceContext = {}): string {
  const own = ctx.tokens ? null : createTokenPool();
  const tokens = ctx.tokens ?? own!;
  const scope: Record<string, unknown> = ctx.item ? { ...values, ...ctx.item } : values;
  const out = xml.replace(new RegExp(PARA_SRC, 'g'), (para) => {
    const slots = readSlots(para);
    const original = joinedText(slots);
    if (original.indexOf('{') < 0) return para;
    const edits: { a: number; b: number; text: string }[] = [];
    for (const m of original.matchAll(/\{([@#/]?)([^{}\r\n\t]{1,60}?)(?:\|([^{}\r\n\t]{0,120}))?\}/g)) {
      const prefix = m[1] ?? '';
      const name = (m[2] ?? '').trim();
      let rendered: string;
      if ((prefix === '@' && name === ROW_NUMBER_AT) || name === ROW_NUMBER_PLAIN) {
        /** 行号只在循环体内有意义；循环外原样留着，让人一眼看出写错了地方 */
        if (ctx.rowIndex === undefined || ctx.rowIndex === null) continue;
        rendered = String(ctx.rowIndex);
      } else {
        rendered = renderText(m[0]!, scope, { keepUnfilled: true });
        if (rendered === m[0]) continue;
      }
      edits.push({ a: m.index!, b: m.index! + m[0]!.length, text: tokens.add(rendered) });
    }
    if (!edits.length) return para;
    spliceSlots(slots, original, edits);
    return writeSlotsBack(para, slots, original);
  });
  return own ? own.restore(out) : out;
}

/**
 * XML 实体还原。
 *
 * 注意顺序：`&amp;` 必须最后还原，否则 `&amp;lt;`（字面文本 "&lt;"）会被还原两次。
 * 数字实体（`&#12290;` / `&#x3002;`）必须认 —— WPS、Google Docs、pandoc、python-docx
 * 导出的 docx 大量使用它们，不还原就会被 encodeXml 二次转义成字面量。
 */
function decodeXml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (m, d: string) => codePointToChar(Number(d), m))
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h: string) => codePointToChar(parseInt(h, 16), m))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
/** 非法码点（越界、NaN、超出 Unicode 范围）不抛异常，原样保留，坏模板不该让整次渲染失败 */
function codePointToChar(cp: number, raw: string): string {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return raw;
  try {
    return String.fromCodePoint(cp);
  } catch {
    return raw;
  }
}
function encodeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ====================== 循环与图片：结构扫描 ====================== */

export interface DocxCollection {
  /** 集合名（模板里 `{#循环 集合名}` 的那个名字） */
  name: string;
  /** 标记原文，给界面/提示用 */
  raw: string;
  /** 循环体里用到的字段名（含嵌套循环体），按项补档案值时用 */
  fields: string[];
}

export interface DocxImageRef {
  name: string;
  raw: string;
  /** 是否写在循环体内（体内按行号取图，体外按名称取） */
  inLoop: boolean;
}

export interface DocxTextAnalysis {
  collections: DocxCollection[];
  images: DocxImageRef[];
  /** 循环体之外的普通变量名（去重、按出现顺序） */
  fields: string[];
  /** 命中的变量（集合名/图片名也在里面，raw 保留标记原文） */
  hits: PlaceholderHit[];
  warnings: string[];
}

/** 集合名在变量清单里的「示例」（会被 rescanTemplate 落进 example，界面与提示词都用得上） */
function collectionExample(): string {
  return '表格循环：给出数组，例：[{"序号":1,"名称":"水泥","单位":"吨","数量":10}]';
}
function imageExample(): string {
  return '图片：按名称或序号取自工作台/本阶段的影像证据（如 照片、1、某张照片的文件名）';
}

/**
 * 扫描一段 docx 纯文本里的循环、图片与顶层变量。
 *
 * 三个必须守住的判据：
 *   ① 循环体内的 `{字段}` **不算顶层变量**（否则变量清单与覆盖率都会重复计一遍）；
 *   ② `{@序号}` / `{_行号}` 是行号，不是变量、更不是图片；
 *   ③ 集合名与图片名要作为变量暴露出来（否则变量清单里看不到它们）。
 *
 * 纯函数，只吃文本；跨 run 的拆分已经由 docxXmlToPlain 合并掉了。
 */
export function analyzeDocxText(text: string): DocxTextAnalysis {
  const hits: PlaceholderHit[] = [];
  const seen = new Set<string>();
  const collections: DocxCollection[] = [];
  const images: DocxImageRef[] = [];
  const fieldList: string[] = [];
  const fieldSeen = new Set<string>();
  const warnings: string[] = [];
  const stack: { name: string; raw: string; fields: Set<string> }[] = [];
  let depth = 0;

  const pushHit = (raw: string, name: string, fallback: string | null, index: number): void => {
    if (seen.has(name)) return;
    seen.add(name);
    hits.push({ raw, name, prefix: '', fallback, index });
  };

  const re = new RegExp(DOCX_TOKEN_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0]!;
    if (m[1] !== undefined) {
      // 组 1：{#循环 集合名}
      const name = m[1].trim();
      if (!name) {
        warnings.push('有一个 {#循环} 没写集合名，不会被展开');
        continue;
      }
      if (depth === 0) pushHit(raw, name, collectionExample(), m.index);
      stack.push({ name, raw, fields: new Set<string>() });
      depth += 1;
      continue;
    }
    if (m[2] !== undefined) {
      // 组 2：{/循环}
      const open = stack.pop();
      if (!open) {
        warnings.push(`有多余的 ${raw}，没有对应的 {#循环}（这一段会原样留在文档里）`);
        continue;
      }
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        collections.push({ name: open.name, raw: open.raw, fields: [...open.fields] });
      } else {
        // 嵌套循环体的字段也算外层的「当前项可能提供的字段」
        for (const s of stack) for (const f of open.fields) s.fields.add(f);
      }
      continue;
    }
    if (m[3] !== undefined) {
      // 组 3：{@图片 图片名}
      const name = m[3].trim() || DEFAULT_IMAGE_NAME;
      images.push({ name, raw, inLoop: depth > 0 });
      pushHit(raw, name, imageExample(), m.index);
      continue;
    }
    // 组 4/5/6：普通变量
    const prefix = m[4] ?? '';
    const name = (m[5] ?? '').trim();
    const fallback = m[6]?.trim() ?? null;
    if (!name) continue;
    if (depth > 0) {
      for (const s of stack) s.fields.add(name);
      continue;
    }
    if (prefix === '@') continue; // {@序号} 之类的行号：不是变量也不是图片
    if (name === ROW_NUMBER_PLAIN) continue;
    if (prefix === '#' && name.startsWith('循环')) {
      warnings.push(`有一个 {#${name}} 没写集合名，不会被展开`);
      continue;
    }
    if (!fieldSeen.has(name)) {
      fieldSeen.add(name);
      fieldList.push(name);
    }
    pushHit(raw, name, fallback, m.index);
  }
  if (depth > 0) {
    warnings.push(`有 ${depth} 个 {#循环} 没有对应的 {/循环}，这些循环不会展开（文档里会原样留着标记）`);
  }
  return { collections, images, fields: fieldList, hits, warnings };
}

/**
 * 把循环区域整段抹掉后的文本（含标记本身）。
 *
 * 用途：算「漏填变量」时，循环体内的字段不该按顶层变量报缺
 * （它们由集合里的每一项提供），但它外面同一段文字里的变量照样要报。
 */
export function stripLoopRegions(text: string): string {
  const re = new RegExp(`(${LOOP_MARKER_SRC})`, 'g');
  let depth = 0;
  let out = '';
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (depth === 0) out += text.slice(cursor, m.index);
    if (m[0]!.startsWith('{#')) depth += 1;
    else depth = Math.max(0, depth - 1);
    cursor = m.index + m[0]!.length;
  }
  if (depth === 0) out += text.slice(cursor);
  return out;
}

export interface TemplateStructure {
  format: TemplateFormat;
  collections: DocxCollection[];
  images: DocxImageRef[];
  /** 循环体之外的顶层变量名 */
  fields: string[];
  warnings: string[];
}

/**
 * 只看结构：这个模板里有哪些循环集合、哪些图片占位、哪些顶层变量。
 *
 * 生成链路（domain/generate.ts）拿它来：
 *   · 告诉模型「这个变量是表格循环集合，请给数组」
 *   · 把循环体里的字段按当前项 + 档案/工作台字段补齐
 *   · 图片占位交给影像证据自动插入，不当成要人手填的文字变量
 * xlsx 支持末尾数据行的集合循环；图片仍不支持。
 */
export function scanTemplateStructure(absPath: string): TemplateStructure {
  const fmt = detectFormat(absPath);
  const empty: TemplateStructure = { format: fmt, collections: [], images: [], fields: [], warnings: [] };
  if (fmt === 'xlsx') {
    try {
      const zip = new PizZip(readFileSync(absPath));
      const strings = [...(zip.file('xl/sharedStrings.xml')?.asText() ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
        .map(m => [...m[1]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1]!)).join(''));
      const lines: string[] = [];
      for (const name of Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
        for (const row of zip.file(name)!.asText().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
          lines.push([...row[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(c => {
            const value = c[2]!.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '';
            return /\bt="s"/.test(c[1]!) ? strings[Number(value)] ?? '' : [...c[2]!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => decodeXml(t[1]!)).join('');
          }).join('\t'));
        }
      }
      const a = analyzeDocxText(lines.join('\n'));
      return {format:fmt,collections:a.collections,images:[],fields:a.fields,warnings:a.warnings};
    } catch { return empty; }
  }
  if (fmt !== 'docx') return empty;
  let zip: PizZip;
  try {
    zip = new PizZip(readFileSync(absPath));
  } catch {
    return empty;
  }
  const collections = new Map<string, DocxCollection>();
  const images = new Map<string, DocxImageRef>();
  const fields = new Set<string>();
  const warnings: string[] = [];
  for (const part of docxParts(zip)) {
    const f = zip.file(part);
    if (!f) continue;
    const a = analyzeDocxText(docxXmlToPlain(f.asText()));
    for (const c of a.collections) {
      const prev = collections.get(c.name);
      if (prev) {
        for (const x of c.fields) if (!prev.fields.includes(x)) prev.fields.push(x);
      } else {
        collections.set(c.name, { ...c, fields: [...c.fields] });
      }
    }
    for (const i of a.images) if (!images.has(i.name)) images.set(i.name, i);
    for (const x of a.fields) fields.add(x);
    for (const w of a.warnings) if (!warnings.includes(w)) warnings.push(w);
  }
  return {
    format: fmt,
    collections: [...collections.values()],
    images: [...images.values()],
    fields: [...fields],
    warnings,
  };
}

/* ====================== 循环与图片：渲染 ====================== */

export interface RenderImageAsset {
  /** 给人看的名字（提示里显示它） */
  label: string;
  /** 可按名称匹配的别名：标题、文件名、去扩展名的文件名 */
  names: string[];
  /** 1 起的序号，`{@图片 2}` 用 */
  index: number;
  /** 图片绝对路径；渲染时才读，读不到/不是图片按「未能插入」回报 */
  absPath: string;
}

export interface RenderAssets {
  /** 可插入的图片清单（按该工作台/该阶段的影像证据顺序） */
  images: RenderImageAsset[];
  /** 集合名 → 项数组（values 里没给这个集合时的兜底，例如「现场照片」直接取影像证据） */
  collections: Record<string, unknown[]>;
}

interface RenderReport {
  missing: Set<string>;
  missingImages: string[];
  notes: string[];
}

interface DocxCtx {
  part: string;
  assets?: RenderAssets;
  media: DocxMediaWriter;
  tokens: TokenPool;
  report: RenderReport;
  /** 循环当前项（对象则按字段取，字符串则当作图片引用） */
  item?: unknown;
  rowIndex?: number;
}

function pushNote(report: RenderReport, note: string): void {
  if (!report.notes.includes(note)) report.notes.push(note);
}
function pushMissingImage(report: RenderReport, label: string): void {
  if (!report.missingImages.includes(label)) report.missingImages.push(label);
}

interface ParaSpan {
  start: number;
  end: number;
  text: string;
}

/** 段落片段 + 合并后的文本（跨 run 的标记靠这个才能定位） */
function paragraphSpans(xml: string): ParaSpan[] {
  const out: ParaSpan[] = [];
  const re = new RegExp(PARA_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push({ start: m.index, end: m.index + m[0]!.length, text: joinedText(readSlots(m[0]!)) });
  }
  return out;
}

/**
 * 「只含循环标记」的段落能不能整段删掉。
 *
 * 正文段落可以删；表格单元格里的段落要留一个 —— `<w:tc>` 里一个 `<w:p>` 都没有，
 * Word 会判文件损坏。判不准时一律**不删**（宁可多一个空段落，也不能出坏文件）。
 */
function canDropParagraph(xml: string, p: ParaSpan): boolean {
  const cellOpen = lastOpenCellPos(xml, p.start);
  if (cellOpen < 0) return true;
  const cellClose = xml.indexOf('</w:tc>', p.end);
  const inner = xml.slice(cellOpen, cellClose < 0 ? xml.length : cellClose);
  return (inner.match(/<w:p(?:\s[^>]*)?>/g) ?? []).length > 1;
}

function lastOpenCellPos(xml: string, pos: number): number {
  const re = /<w:tc(?:\s[^>]*)?>|<\/w:tc>/g;
  let open = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m.index >= pos) break;
    open = m[0]!.startsWith('</') ? -1 : m.index;
  }
  return open;
}

/** 包住某段区间的**最内层** `<w:tr>`（嵌套表格也能正确配对） */
function rowSpanContaining(xml: string, from: number, to: number): { start: number; end: number } | null {
  const re = /<w:tr(?:\s[^>]*)?>|<\/w:tr>/g;
  const stack: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0]!.startsWith('</')) {
      const start = stack.pop();
      if (start === undefined) continue;
      const end = m.index + m[0]!.length;
      if (start <= from && end >= to) return { start, end };
    } else {
      stack.push(m.index);
    }
  }
  return null;
}

/** 一个完整的最外层循环：要克隆的区间 + 标记原文 */
interface LoopSite {
  collection: string;
  regionStart: number;
  regionEnd: number;
  /** 副本里要删掉的「只含标记」段落（区域内的段落序号） */
  dropParas: number[];
  /** 段落下标（区域内）→ 要删掉的标记原文 */
  markers: { ordinal: number; marker: string }[];
}

function buildLoopSite(
  xml: string,
  paras: ParaSpan[],
  startPara: number,
  endPara: number,
  collection: string,
  startRaw: string,
  endRaw: string,
): LoopSite | null {
  const sp = paras[startPara];
  const ep = paras[endPara];
  if (!sp || !ep) return null;
  let regionStart = sp.start;
  let regionEnd = ep.end;
  /**
   * 容器定位：**同一个 `<w:tr>` 优先**。
   * 表格行的循环（清单/台账）标记常在首尾两个单元格里，两个段落属于同一行时，
   * 克隆单元就是整行 —— 逐格插行才是用户要的效果。
   * 标记在同一段落里（例如 `{#循环 X}{名称}{/循环}` 挤在一个单元格里）时不做行克隆，
   * 否则会把整行（含表头行）重复 N 遍。
   */
  if (startPara !== endPara) {
    const row = rowSpanContaining(xml, sp.start, ep.end);
    if (row) {
      regionStart = row.start;
      regionEnd = row.end;
    }
  }
  const region = xml.slice(regionStart, regionEnd);
  const regionParas = paragraphSpans(region);
  const firstGlobal = paras.findIndex((p) => p.start >= regionStart);
  const base = firstGlobal < 0 ? startPara : firstGlobal;
  const markers = [
    { ordinal: startPara - base, marker: startRaw },
    { ordinal: endPara - base, marker: endRaw },
  ];
  const dropParas: number[] = [];
  regionParas.forEach((p, i) => {
    const rest = p.text.split(startRaw).join('').split(endRaw).join('').trim();
    if (rest) return;
    if (canDropParagraph(region, p)) dropParas.push(i);
  });
  return { collection, regionStart, regionEnd, dropParas, markers };
}

/** 找出所有**最外层**循环（不重叠、按出现顺序），交给一次顺序拼接完成展开 */
function findLoopSites(xml: string, report: RenderReport): LoopSite[] {
  const paras = paragraphSpans(xml);
  const sites: LoopSite[] = [];
  const stack: { name: string; raw: string }[] = [];
  let depth = 0;
  let start: { name: string; raw: string; para: number } | null = null;
  for (let pi = 0; pi < paras.length; pi++) {
    const text = paras[pi]!.text;
    if (text.indexOf('循环') < 0) continue;
    const re = new RegExp(LOOP_MARKER_SRC, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const raw = m[0]!;
      if (m[1] !== undefined) {
        const name = m[1].trim();
        if (!name) continue;
        if (depth === 0) start = { name, raw, para: pi };
        stack.push({ name, raw });
        depth += 1;
        continue;
      }
      const open = stack.pop();
      if (!open) {
        pushNote(report, `有多余的 ${raw}，没有对应的 {#循环}，已忽略`);
        continue;
      }
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start) {
        const site = buildLoopSite(xml, paras, start.para, pi, start.name, start.raw, raw);
        if (site) sites.push(site);
        start = null;
      }
    }
  }
  if (depth > 0) {
    pushNote(report, `模板里有 ${depth} 个 {#循环} 没有对应的 {/循环}，这些循环不会展开（原样保留标记）`);
  }
  return sites;
}

/** 集合取值：数组 / JSON 数组字符串 / 每行一项的文本；都没有则看 assets 的兜底集合 */
function asItemArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    if (s.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* 不是 JSON 就当普通文本按行拆 */
      }
    }
    return s
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (v && typeof v === 'object') return [v]; // 单项对象 = 只有一项的集合
  return null;
}

function collectionItems(name: string, values: Record<string, unknown>, ctx: DocxCtx): unknown[] | null {
  if (Object.prototype.hasOwnProperty.call(values, name)) {
    const own = asItemArray(values[name]);
    if (own) return own;
  }
  const fb = asItemArray(ctx.assets?.collections?.[name]);
  if (fb) return fb;
  return null;
}

function itemObject(item: unknown): Record<string, unknown> | undefined {
  return item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
}

/** 删掉标记文本（可能跨 run；按段落合并文本定位） */
function removeFirstEach(para: string, markers: string[]): string {
  if (!markers.length) return para;
  const slots = readSlots(para);
  const original = joinedText(slots);
  if (original.indexOf('{') < 0) return para;
  const edits: { a: number; b: number; text: string }[] = [];
  for (const mk of markers) {
    const at = original.indexOf(mk);
    if (at < 0) continue;
    edits.push({ a: at, b: at + mk.length, text: '' });
  }
  if (!edits.length) return para;
  spliceSlots(slots, original, edits);
  return writeSlotsBack(para, slots, original);
}

function stripMarkers(xml: string, markers: { ordinal: number; marker: string }[]): string {
  if (!markers.length) return xml;
  const spans = paragraphSpans(xml);
  let out = '';
  let cursor = 0;
  spans.forEach((p, i) => {
    out += xml.slice(cursor, p.start);
    out += removeFirstEach(xml.slice(p.start, p.end), markers.filter((mk) => mk.ordinal === i).map((mk) => mk.marker));
    cursor = p.end;
  });
  return out + xml.slice(cursor);
}

/** 按段落序号整段删除（只删 `<w:p>` 本身，段落之间的标签原样保留） */
function dropParagraphsByIndex(xml: string, idxs: number[]): string {
  if (!idxs.length) return xml;
  const drop = new Set(idxs);
  const spans = paragraphSpans(xml);
  let out = '';
  let cursor = 0;
  spans.forEach((p, i) => {
    if (!drop.has(i)) return;
    out += xml.slice(cursor, p.start);
    cursor = p.end;
  });
  return out + xml.slice(cursor);
}

/**
 * 展开所有循环（递归：循环体里的循环在克隆出的副本里继续展开）。
 *
 * 克隆顺序刻意是「先把内层/本层的字段替换掉，再替换最外层」的反面 ——
 * 即：先展开嵌套循环，再做本层的字段替换。这样内层字段不会被外层同名字段顶掉；
 * 而值里的花括号由 tokens 保护，多轮替换也不会把值里的 `{…}` 再替换一次。
 */
function expandLoops(xml: string, values: Record<string, unknown>, ctx: DocxCtx): string {
  if (xml.indexOf('循环') < 0) return xml;
  const sites = findLoopSites(xml, ctx.report);
  if (!sites.length) return xml;
  let out = '';
  let cursor = 0;
  for (const site of sites) {
    out += xml.slice(cursor, site.regionStart);
    out += renderLoopSite(xml, site, values, ctx);
    cursor = site.regionEnd;
  }
  return out + xml.slice(cursor);
}

function renderLoopSite(xml: string, site: LoopSite, values: Record<string, unknown>, ctx: DocxCtx): string {
  const region = xml.slice(site.regionStart, site.regionEnd);
  const items = collectionItems(site.collection, values, ctx);
  if (items === null) {
    ctx.report.missing.add(site.collection);
    pushNote(
      ctx.report,
      `循环集合「${site.collection}」没有数据：这一段/这一行原样保留，请在填写变量里给出该集合（数组或每行一项的文本）`,
    );
    return region;
  }
  let out = '';
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let copy = region;
    copy = stripMarkers(copy, site.markers);
    copy = dropParagraphsByIndex(copy, site.dropParas);
    const itemCtx: DocxCtx = { ...ctx, item, rowIndex: i + 1 };
    // ① 嵌套循环先展开（内层字段由内层项提供）
    copy = expandLoops(copy, values, itemCtx);
    // ② 本层字段替换：当前项优先，顶层 values 回落
    copy = replaceInXml(copy, values, { item: itemObject(item), rowIndex: i + 1, tokens: ctx.tokens });
    // ③ 本层图片：循环体内的 {@图片} 能按当前项/行号取到对应的照片
    copy = insertImages(copy, itemCtx);
    out += copy;
  }
  return out;
}

/* ---------------------- 图片：读文件 / 量尺寸 / 写部件 ---------------------- */

const IMAGE_EXT_MIME: Record<string, { ext: string; mime: string }> = {
  '.jpg': { ext: 'jpeg', mime: 'image/jpeg' },
  '.jpeg': { ext: 'jpeg', mime: 'image/jpeg' },
  '.png': { ext: 'png', mime: 'image/png' },
  '.gif': { ext: 'gif', mime: 'image/gif' },
  '.bmp': { ext: 'bmp', mime: 'image/bmp' },
  '.webp': { ext: 'webp', mime: 'image/webp' },
  '.tif': { ext: 'tiff', mime: 'image/tiff' },
  '.tiff': { ext: 'tiff', mime: 'image/tiff' },
};

interface LoadedImage {
  data: Buffer;
  ext: string;
  mime: string;
  width: number;
  height: number;
}

function looksLikeImageBytes(b: Buffer, ext: string): boolean {
  if (b.length < 12) return false;
  switch (ext) {
    case 'png':
      return b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG';
    case 'jpeg':
      return b[0] === 0xff && b[1] === 0xd8;
    case 'gif':
      return b.toString('latin1', 0, 3) === 'GIF';
    case 'bmp':
      return b.toString('latin1', 0, 2) === 'BM';
    case 'webp':
      return b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
    case 'tiff':
      return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a);
    default:
      return false;
  }
}

/** 图片像素尺寸：只认头部几个字节，不引依赖；认不出来返回 null（用默认比例兜底） */
function imagePixelSize(b: Buffer, ext: string): { width: number; height: number } | null {
  if (ext === 'png' && b.length > 24 && b.toString('latin1', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (ext === 'gif' && b.length > 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (ext === 'bmp' && b.length > 26) return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
  if (ext === 'jpeg') return jpegPixelSize(b);
  if (ext === 'webp') return webpPixelSize(b);
  return null;
}

function jpegPixelSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpPixelSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const fourcc = b.toString('latin1', 12, 16);
  if (fourcc === 'VP8X') {
    const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return { width: w, height: h };
  }
  if (fourcc === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (fourcc === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function loadImage(absPath: string): LoadedImage | { error: string } {
  let data: Buffer;
  try {
    data = readFileSync(absPath);
  } catch (e) {
    return { error: `文件读不到（${errText(e)}）` };
  }
  const info = IMAGE_EXT_MIME[extname(absPath).toLowerCase()];
  if (!info) return { error: '不是支持的图片格式（支持 jpg/png/gif/bmp/webp/tiff）' };
  if (!looksLikeImageBytes(data, info.ext)) return { error: '文件内容不是有效的图片' };
  const size = imagePixelSize(data, info.ext);
  return { data, ext: info.ext, mime: info.mime, width: size?.width ?? 0, height: size?.height ?? 0 };
}

const EMU_PER_PX = 9525; // 96 DPI
const EMU_PER_CM = 360000;
const MAX_IMG_W = 14 * EMU_PER_CM;
const MAX_IMG_H = 10 * EMU_PER_CM;

/** 展示尺寸：按原始宽高比缩放进 14cm × 10cm，且不放大 */
function drawingExtent(img: LoadedImage): { cx: number; cy: number } {
  const w = img.width > 0 ? img.width : 800;
  const h = img.height > 0 ? img.height : 600;
  let cx = w * EMU_PER_PX;
  let cy = h * EMU_PER_PX;
  const scale = Math.min(1, MAX_IMG_W / cx, MAX_IMG_H / cy);
  return { cx: Math.max(1, Math.round(cx * scale)), cy: Math.max(1, Math.round(cy * scale)) };
}

function relsPathFor(part: string): string {
  const i = part.lastIndexOf('/');
  return i < 0 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

function nextRelId(relsXml: string): number {
  let max = 0;
  for (const m of relsXml.matchAll(/Id="rId(\d+)"/g)) max = Math.max(max, Number(m[1]));
  return max + 1;
}

/**
 * 图片部件写入器：一次渲染里集中管理 media 部件、关系表与内容类型。
 *
 * 四个部件改动都在这里（顺序即 OOXML 的引用链）：
 *   ① `word/media/imageN.<ext>`   新增图片部件（同一张图重复插入只存一份）
 *   ② `word/_rels/<part>.rels`    新增 image 关系（rId 从现有最大值往后排）
 *   ③ `[Content_Types].xml`       补 `<Default Extension="jpeg" ContentType="image/jpeg"/>`
 *   ④ 正文里的 `<w:drawing><wp:inline>`（见 drawingRunXml）
 * 任一环节不成立（缺内容类型表、关系表 XML 坏）就拒绝这张图并回报，绝不写出半截引用。
 */
class DocxMediaWriter {
  private readonly zip: PizZip;
  private readonly media = new Map<string, { name: string; ext: string; mime: string; data: Buffer }>();
  private readonly rels = new Map<string, { rId: string; target: string }[]>();
  private readonly perPart = new Map<string, Map<string, string>>();
  private readonly relsBase = new Map<string, number>();
  private readonly defaults = new Map<string, string>();
  private readonly existingDefaults: Set<string>;
  private seq = 0;
  private docPr = 0;
  private readonly canAddParts: boolean;

  constructor(zip: PizZip) {
    this.zip = zip;
    for (const name of Object.keys(zip.files)) {
      const m = /^word\/media\/image(\d+)\.[A-Za-z0-9]+$/.exec(name);
      if (m) this.seq = Math.max(this.seq, Number(m[1]));
    }
    const ct = zip.file('[Content_Types].xml')?.asText() ?? '';
    this.canAddParts = ct.includes('</Types>');
    this.existingDefaults = new Set(
      [...ct.matchAll(/<Default\s+Extension="([^"]+)"/gi)].map((m) => (m[1] ?? '').toLowerCase()),
    );
    for (const part of docxParts(zip)) {
      const xml = zip.file(part)?.asText() ?? '';
      for (const m of xml.matchAll(/<wp:docPr[^>]*\sid="(\d+)"/g)) this.docPr = Math.max(this.docPr, Number(m[1]));
    }
  }

  nextDocPrId(): number {
    this.docPr += 1;
    return this.docPr;
  }

  /** 取（或分配）某个部件里这张图的关系 id；返回 null 表示这个文件不允许新增部件 */
  rIdFor(part: string, asset: RenderImageAsset, img: LoadedImage): string | null {
    if (!this.canAddParts) return null;
    let per = this.perPart.get(part);
    if (!per) {
      per = new Map();
      this.perPart.set(part, per);
    }
    const existed = per.get(asset.absPath);
    if (existed) return existed;

    const relsPath = relsPathFor(part);
    const relsFile = this.zip.file(relsPath);
    const relsXml = relsFile?.asText() ?? '';
    if (relsFile && !relsXml.includes('</Relationships>')) return null;

    let media = this.media.get(asset.absPath);
    if (!media) {
      this.seq += 1;
      media = { name: `word/media/image${this.seq}.${img.ext}`, ext: img.ext, mime: img.mime, data: img.data };
      this.media.set(asset.absPath, media);
    }
    let base = this.relsBase.get(part);
    if (base === undefined) {
      base = nextRelId(relsXml);
      this.relsBase.set(part, base);
    }
    const list = this.rels.get(part) ?? [];
    const rId = `rId${base + list.length}`;
    list.push({ rId, target: media.name.replace(/^word\//, '') });
    this.rels.set(part, list);
    per.set(asset.absPath, rId);
    if (!this.existingDefaults.has(img.ext)) this.defaults.set(img.ext, img.mime);
    return rId;
  }

  finalize(): void {
    for (const media of this.media.values()) this.zip.file(media.name, media.data);
    for (const [part, list] of this.rels) {
      const path = relsPathFor(part);
      const body = list
        .map(
          (r) =>
            `<Relationship Id="${r.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`,
        )
        .join('');
      const existed = this.zip.file(path)?.asText();
      if (existed) this.zip.file(path, existed.replace('</Relationships>', `${body}</Relationships>`));
      else {
        this.zip.file(
          path,
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`,
        );
      }
    }
    if (this.defaults.size) {
      const part = this.zip.file('[Content_Types].xml');
      const ct = part?.asText() ?? '';
      if (ct.includes('</Types>')) {
        const add = [...this.defaults].map(([ext, mime]) => `<Default Extension="${ext}" ContentType="${mime}"/>`).join('');
        this.zip.file('[Content_Types].xml', ct.replace('</Types>', `${add}</Types>`));
      }
    }
  }
}

interface ImagePlan {
  a: number;
  b: number;
  rId: string;
  img: LoadedImage;
  label: string;
  rPr: string;
  run: { start: number; end: number } | null;
}

function itemImageRef(item: unknown, wanted: string): string | null {
  if (typeof item === 'string') return item.trim() || null;
  if (typeof item === 'number') return String(item);
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const o = item as Record<string, unknown>;
    const v = o[wanted] ?? o['照片'] ?? o['图片'] ?? o['文件名'];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

function matchImage(images: RenderImageAsset[], ref: string): RenderImageAsset | null {
  const key = ref.trim().toLowerCase();
  if (!key) return null;
  const bare = (s: string): string => s.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '');
  const exact = images.find((a) => a.names.some((n) => n.toLowerCase() === key));
  if (exact) return exact;
  const stem = images.find((a) => a.names.some((n) => bare(n) === bare(key)));
  if (stem) return stem;
  if (key.length >= 2) return images.find((a) => a.names.some((n) => n.toLowerCase().includes(key))) ?? null;
  return null;
}

/** `{@图片 图片名}` → 具体图片：当前项给的引用 → 按名称 → 按序号 → 通用叫法按序取 */
function resolveImageAsset(wanted: string, ctx: DocxCtx): RenderImageAsset | null {
  const images = ctx.assets?.images ?? [];
  if (!images.length) return null;
  const fromItem = itemImageRef(ctx.item, wanted);
  if (fromItem) {
    const hit = matchImage(images, fromItem);
    if (hit) return hit;
  }
  const byName = matchImage(images, wanted);
  if (byName) return byName;
  const n = Number(wanted);
  if (Number.isInteger(n) && n >= 1) return images[(n - 1) % images.length] ?? null;
  if (GENERIC_IMAGE_NAMES.includes(wanted.toLowerCase()) || GENERIC_IMAGE_NAMES.includes(wanted)) {
    if (ctx.rowIndex !== undefined) return images[(ctx.rowIndex - 1) % images.length] ?? null;
    pushNote(ctx.report, `「${wanted}」没有同名的影像，已按第 1 张插入（${images[0]!.label}）`);
    return images[0]!;
  }
  return null;
}

function slotIndexAt(starts: number[], pos: number): number {
  for (let i = starts.length - 1; i >= 0; i--) if (pos >= starts[i]!) return i;
  return 0;
}

function runSpanAt(para: string, tPos: number): { start: number; end: number } | null {
  if (tPos < 0) return null;
  const re = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(para))) {
    if (m.index <= tPos && m.index + m[0]!.length >= tPos) return { start: m.index, end: m.index + m[0]!.length };
  }
  return null;
}

/** `<w:drawing><wp:inline>` 的完整片段（给定 EMU 尺寸与关系 id） */
function drawingRunXml(p: ImagePlan, ctx: DocxCtx): string {
  const { cx, cy } = drawingExtent(p.img);
  const id = ctx.media.nextDocPrId();
  const label = encodeXml(p.label).replace(/"/g, '&quot;');
  return (
    `<w:r>${p.rPr}<w:drawing>` +
    '<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
    ' distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${id}" name="图片${id}" descr="${label}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="图片${id}" descr="${label}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${p.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/>' +
    `<a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  );
}

/**
 * 插入图片。
 *
 * 「独占一个段落/单元格」→ 整段重建：保留 `<w:pPr>`，正文只留图片 run（原段落位置不变）；
 * 「和文字混排」→ 图片 run 插在原占位符所在 run 之后，占位符文本删掉，其余文字与样式不动。
 * 图片找不到（没登记、文件读不到、格式不认）→ 原样保留 `{@图片 名}`（绝不静默丢），并回报名字。
 */
function insertImages(xml: string, ctx: DocxCtx): string {
  if (xml.indexOf('{@') < 0) return xml;
  return xml.replace(new RegExp(PARA_SRC, 'g'), (para) => {
    if (para.indexOf('{@') < 0) return para;
    const slots = readSlots(para);
    const original = joinedText(slots);
    if (original.indexOf('图片') < 0) return para;
    const starts = slotStarts(slots);
    const plans: ImagePlan[] = [];
    for (const m of original.matchAll(new RegExp(IMAGE_MARKER_SRC, 'g'))) {
      const wanted = (m[1] ?? '').trim() || DEFAULT_IMAGE_NAME;
      const asset = resolveImageAsset(wanted, ctx);
      if (!asset) {
        pushMissingImage(ctx.report, wanted);
        continue;
      }
      const img = loadImage(asset.absPath);
      if ('error' in img) {
        pushMissingImage(ctx.report, `${wanted}（${img.error}）`);
        continue;
      }
      const rId = ctx.media.rIdFor(ctx.part, asset, img);
      if (!rId) {
        pushMissingImage(ctx.report, `${wanted}（这个文档缺少可写入的图片部件/关系表）`);
        continue;
      }
      const slot = slotIndexAt(starts, m.index!);
      const run = runSpanAt(para, slots[slot]?.ws ?? -1);
      const rPr = run ? (para.slice(run.start, run.end).match(/<w:rPr>[\s\S]*?<\/w:rPr>/) ?? [''])[0]! : '';
      plans.push({ a: m.index!, b: m.index! + m[0]!.length, rId, img, label: asset.label, rPr, run });
    }
    if (!plans.length) return para;
    spliceSlots(slots, original, plans.map((p) => ({ a: p.a, b: p.b, text: '' })));

    if (joinedText(slots).trim() === '') {
      // 独占段落：保留段落属性（对齐/样式/行距），只放图片
      const pOpen = (para.match(/^<w:p(?:\s[^>]*)?>/) ?? [''])[0]!;
      const pPr = (para.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) ?? [''])[0]!;
      let runs = '';
      for (const p of plans) runs += drawingRunXml(p, ctx);
      return `${pOpen}${pPr}${runs}</w:p>`;
    }

    // 混排：图片插到原占位符所在 run 之后（从后往前插，坐标不受影响）
    let out = para;
    for (const p of [...plans].sort((x, y) => (y.run?.end ?? -1) - (x.run?.end ?? -1))) {
      const at = p.run ? p.run.end : out.lastIndexOf('</w:p>');
      const pos = at < 0 ? out.length : at;
      out = out.slice(0, pos) + drawingRunXml(p, ctx) + out.slice(pos);
    }
    return writeSlotsBack(out, slots, original);
  });
}

async function renderXlsxBuffer(
  absPath: string,
  values: Record<string, unknown>,
): Promise<{ bytes: Buffer; missing: string[] }> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readOfficeBytes(absPath) as never);
  const missing = new Set<string>();
  // Excel collections deliberately occupy the final data row. No shifting of
  // footer formulas or merged ranges is attempted; unsupported layouts fail.
  const expandedCells=new Set<string>();
  wb.eachSheet(ws => {
    const loopRows: number[] = [];
    ws.eachRow(row => {if(row.values && JSON.stringify(row.values).includes('{#循环 '))loopRows.push(row.number);});
    for(const rowNo of loopRows.reverse()) {
      const row=ws.getRow(rowNo), text=Array.from({length:ws.columnCount},(_,i)=>row.getCell(i+1).text).join('\t');
      const analysis=analyzeDocxText(text),loop=analysis.collections[0];
      if(!loop||analysis.collections.length!==1||analysis.warnings.length)throw new Error('Excel循环须在同一行内成对出现');
      if(rowNo!==ws.actualRowCount && Array.from({length:Math.max(0,ws.rowCount-rowNo)},(_,i)=>ws.getRow(rowNo+i+1)).some(r=>r.hasValues))throw new Error('Excel循环行后不能有其他内容，请将汇总公式放在表头或独立工作表');
      if(row.hasValues && Array.from({length:ws.columnCount},(_,i)=>row.getCell(i+1)).some(c=>c.isMerged||c.type===6))throw new Error('Excel循环行暂不支持合并单元格或公式');
      let items:unknown=values[loop.name];
      if(typeof items==='string'){try{items=JSON.parse(items);}catch{throw new Error(`集合「${loop.name}」须为JSON数组`);}}
      if(items===undefined||items===null){missing.add(loop.name);return;}
      if(!Array.isArray(items)||items.length>2000||items.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw new Error(`集合「${loop.name}」须为最多2000条对象记录`);
      const cells=Array.from({length:ws.columnCount},(_,i)=>{const c=row.getCell(i+1);return {value:c.value,style:structuredClone(c.style),validation:structuredClone(c.dataValidation)};});
      const height=row.height;
      if(!items.length){row.eachCell(c=>{c.value=null;});return;}
      items.forEach((item,index)=>{
        const target=ws.getRow(rowNo+index);target.height=height;
        let requiredHeight=height??15;
        cells.forEach((source,col)=>{
          const c=target.getCell(col+1);c.style=structuredClone(source.style);c.dataValidation=structuredClone(source.validation);
          const raw=cellText(source.value).replace(/\{#循环\s+[^{}]+\}|\{\/循环\}/g,'');
          const context:Record<string,unknown>={...values,...item as Record<string,unknown>,'序号':index+1,'_行号':index+1};
          // 集合对象显式提供空字符串表示该格留空；未提供的键仍保留占位。
          // 未确认的业务信息由来源层提供【待补】标记，定稿时另行阻断。
          for(const [key,value] of Object.entries(item as Record<string,unknown>))if(typeof value==='string'&&!value.trim())context[key]=OPTIONAL_EMPTY;
          missingVariables(raw,context).forEach(n=>missing.add(`${loop.name}[${index+1}].${n}`));
          const exact=raw.match(/^\{([^{}]+)\}$/),value=exact?context[exact[1] as keyof typeof context]:undefined;
          c.value=typeof value==='number'||typeof value==='boolean'||value instanceof Date ? value : renderText(raw,context,{keepUnfilled:true});
          if(typeof c.value==='string'&&c.value){
            c.alignment={...c.alignment,wrapText:true,vertical:'top'};
            const width=Math.max(4,ws.getColumn(col+1).width??8.43);
            const lines=c.value.split('\n').reduce((n,line)=>n+Math.max(1,Math.ceil([...line].reduce((s,ch)=>s+(ch.charCodeAt(0)>255?2:1),0)/width)),0);
            requiredHeight=Math.max(requiredHeight,lines*(c.font?.size??11)*1.35+8);
          }
          expandedCells.add(ws.id+':'+c.address);
        });
        if(requiredHeight>409.5)throw new Error(`集合「${loop.name}」第${index+1}条正文超出Excel单行可显示高度，请在台账填摘要并将详细内容保留到Word记录`);
        target.height=requiredHeight;
      });
      if(ws.pageSetup.printArea)ws.pageSetup.printArea=ws.pageSetup.printArea.replace(/(:\$?[A-Z]+\$?)\d+$/,`$1${rowNo+items.length-1}`);
    }
  });
  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if(expandedCells.has(ws.id+':'+cell.address))return;
        const v = cell.value;
        if (typeof v === 'string') {
          if (!v.includes('{')) return;
          for (const hit of scanPlaceholders(v)) {
            const val = values[hit.name];
            if ((val === undefined || val === null || String(val).trim() === '') && !hit.fallback) missing.add(hit.name);
          }
          cell.value = renderText(v, values, { keepUnfilled: true });
        } else if (v && typeof v === 'object' && Array.isArray((v as { richText?: unknown[] }).richText)) {
          const rt = (v as { richText: { text: string }[] }).richText;
          const joined = rt.map((r) => r.text).join('');
          if (!joined.includes('{')) return;
          const rendered = renderText(joined, values, { keepUnfilled: true });
          missingVariables(joined,values).forEach(n=>missing.add(n));
          if(rendered!==joined){
            const starts:number[]=[];let offset=0;for(const r of rt){starts.push(offset);offset+=r.text.length;}
            for(const m of [...joined.matchAll(/\{([@#/]?)([^{}\r\n\t]{1,60}?)(?:\|([^{}\r\n\t]{0,120}))?\}/g)].reverse()){
              const value=renderText(m[0],values);if(value===m[0])continue;const a=m.index!,b=a+m[0].length;
              for(let i=rt.length-1;i>=0;i--){const s=starts[i]!,e=starts[i+1] ?? joined.length;if(s>=b || e<=a)continue;rt[i]!.text=rt[i]!.text.slice(0,Math.max(0,a-s))+(a>=s?value:'')+rt[i]!.text.slice(Math.min(e-s,b-s));}
            }
            cell.value={richText:rt};
          }
        }
      });
    });
  });
  const out = await wb.xlsx.writeBuffer();
  return { bytes: Buffer.from(out), missing: [...missing] };
}

export function templateDisplayName(absPath: string): string {
  return basename(absPath, extname(absPath));
}
