/**
 * 条款级引用 + 出文书前口径校验（B3-9）
 *
 * 两件事，一件数据、一件判断：
 *
 * 一、**条款级引用**（解决 docs/09 §4.6.1 的第 2 个问题："引用只给到某文件某段，给不出条号"）
 *   · 制度抽取时已经按条/款/项算出了 `kb_chunk.clause_path`（019 + core/kb.ts，B3-8 落地）；
 *   · 这里把它变成**能引用的落点**：正文里写 `《设备验收管理办法》第五条`（docs/09 §4.6.3 第 3 条
 *     指定的引用格式就是 `《清廉工程建设管理办法》第十二条`），系统解析到**具体片段**，
 *     返回 文号 + 条款路径 + 原文，并给出可粘进文书的规范出处串（{@link composeCiteText}）。
 *   · 引用一律靠**字面解析正文与变量值**，不调用模型 —— 条号错一个数字公文就会被退回
 *     （docs/09 §4.6.3 的"被否决的方案"：绝不让模型去认或生成条号）。
 *
 * 二、**出文书前口径校验**（docs/09 §4.6.4，本域最重要的一块）
 *   · 规则是**数据**（`compliance_rule` 表）：severity/enabled 改了立刻生效，不改代码；
 *   · 判断全部是**确定性规则**，绝不交给模型；
 *   · 每条问题都给出**位置**（哪个变量 / 模板正文）与**依据**（哪份制度、哪一条、原文），
 *     不是笼统的"校验失败"；
 *   · 求值分三态：**通过 / 不通过 / 未求值**。"未求值"单独计数（docs/11 B3-9 风险③：
 *     求值为空与求值为假必须分开），而且**未求值不产生问题**（验收⑥：无假阳性）。
 *
 * 本轮落地的 5 条规则（`compliance_rule` 里 implemented=1）就是 B3-9 的 4 类检查：
 *   CITE_SOURCE_UNINDEXED（未入库/重名 → warn）/ CITE_CLAUSE_MISSING（悬空 → block）/
 *   CITE_CLAUSE_SUPERSEDED（引的是被替换的版本 → block）/ CITE_CONFLICT（同事项两个口径 → block）/
 *   CITE_VALUE_MISMATCH（变量值与条款数字不一致 → block）。
 * docs/11 B3-9 表里的 12 条公文惯例规则按文档要求**先做草案**（enabled=0、implemented=0 入库），
 * 由用户逐条确认后才算数；接口拒绝启用没有实现的规则，避免"启用了却永远不响"。
 *
 * 【与 docs/09 的命名差异（有意，已写回 docs/11 §10.1）】docs/09 §4.6.4 写的是 `core/compliance.ts`，
 * 本轮按 B3-9 的落地指派放在 `domain/kb-cite.ts`：引用与口径在本域是同一件事（口径校验要读引用），
 * 拆成两个文件只会让"引用解析"被复制两份。
 */
import { existsSync, statSync } from 'node:fs';
import { all, get, run } from '../db/index.ts';
import { getSetting, setSetting } from '../core/config.ts';
import { CLAUSE_PATH_SEP } from '../core/kb.ts';
import { extractText } from '../core/extract.ts';
import { segCJK } from '../core/search.ts';
import { searchKbChunks } from '../core/kb-extract.ts';
import { getTemplate, readTemplateVars, templateAbsPath } from './service.ts';

/* ============================================================================
 * 一、数字与条号：全部确定性解析
 * ==========================================================================*/

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

/** 全角数字 → 半角 */
function toHalfWidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xfee0));
}

/**
 * 中文数字 / 阿拉伯数字 → number。
 * 认不出来返回 null（**不猜**）：宁可计成"未求值"，也不要猜出一个错条号。
 */
export function cnNumToArabic(raw: string): number | null {
  // 千分位（半角/全角）在这里吃掉：`6,000,000` 与 `6000000` 必须是同一个数
  const s = toHalfWidthDigits(String(raw ?? '').replace(/[,，\s]+/g, '')).trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  let total = 0;
  let section = 0;
  let number = 0;
  let seen = false;
  for (const ch of s) {
    const d = CN_DIGIT[ch];
    if (d !== undefined) {
      number = d;
      seen = true;
      continue;
    }
    const u = CN_UNIT[ch];
    if (u !== undefined) {
      section += (number || 1) * u;
      number = 0;
      seen = true;
      continue;
    }
    if (ch === '万') {
      section = (section + number) * 10000;
      total += section;
      section = 0;
      number = 0;
      seen = true;
      continue;
    }
    if (ch === '亿') {
      total = (total + section + number) * 100000000;
      section = 0;
      number = 0;
      seen = true;
      continue;
    }
    return null; // 出现不认识的字符：整串作废，不返回半个数字
  }
  if (!seen) return null;
  const v = total + section + number;
  return Number.isFinite(v) && v >= 0 && v < 1e12 ? v : null;
}

/** 条号：`第五条` → 5，`第 5 条` → 5，`第十二条` → 12 */
const CLAUSE_NUM_RE = /第\s*([0-9０-９一二三四五六七八九十百千零〇两]{1,8})\s*条/g;
/** 款/项号：`第二款` / `（二）` */
const SUB_NUM_RE = /(?:第\s*([0-9０-９一二三四五六七八九十百千零〇两]{1,6})\s*[款项]|[（(]\s*([0-9０-９一二三四五六七八九十百千零〇两]{1,4})\s*[）)])/g;

function firstNumberByRe(text: string, re: RegExp): number | null {
  const r = new RegExp(re.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = r.exec(text))) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const n = cnNumToArabic(raw);
    if (n !== null) return n;
  }
  return null;
}

/** 路径分段里的条号：`第五条 检查频次` → 5 */
export function clauseNoOfSegment(segment: string): number | null {
  return firstNumberByRe(segment, CLAUSE_NUM_RE);
}

/** 路径分段里的款/项号：`第二款` / `（二）` → 2 */
export function subNoOfSegment(segment: string): number | null {
  return firstNumberByRe(segment, SUB_NUM_RE);
}

/** 款/项号的人话写法（提示文案用）：2 → `第 2 款/项` */
export function subNoLabel(no: number | null): string {
  return no === null ? '这一款/项' : `第 ${no} 款/项`;
}

/** 归一化（去空格、全角转半角），用于字面比对 */
function normSeg(s: string): string {
  return toHalfWidthDigits(s).replace(/\s+/g, '').trim();
}

/* ============================================================================
 * 二、条款级引用：解析 → 落到具体片段
 * ==========================================================================*/

/**
 * 正文里的引用形态：
 *   `《制度名》第五条` / `《制度名》（文号）第五条第（二）款`
 *   `《制度名》（文号）第二章 到货验收要求/第五条 检查频次`（**规范出处串**——composeCiteText 产出的就是这一种，
 *     必须能被重新解析回来，否则"插进文书的出处"就成了校验引擎看不见的东西）
 * 括号里那一截**只有看起来像文号时**才算文号（否则 `《XX办法》（试行）第五条` 会被读成文号）。
 */
const CITE_RE = new RegExp(
  '《([^》\\n]{2,60})》' +
    '\\s*(?:[（(]([^）)\\n]{2,40})[）)])?' +
    // 可选：章/节/路径前缀，必须以 / 或 > 结尾（`第二章 到货验收要求/`），否则不吃
    '\\s*(?:([^\\n《》]{1,40}?\\s*[\\/>])\\s*)?' +
    '\\s*(第\\s*[0-9０-９一二三四五六七八九十百千零〇两]{1,8}\\s*条)' +
    '(?:\\s*(第\\s*[0-9０-９一二三四五六七八九十百千零〇两]{1,6}\\s*[款项]))?' +
    '(?:\\s*([（(]\\s*[0-9０-９一二三四五六七八九十百千零〇两]{1,4}\\s*[）)]))?',
  'g',
);

/** 括号里像不像发文字号（如 `晋清廉办〔2026〕3号`） */
function looksLikeDocNo(s: string): boolean {
  return /[〔\[【（(]?\s*\d{4}\s*[〕\]】）)]?\s*\d{1,4}\s*号\s*$/.test(s) || /\d{4}.*号/.test(s);
}

export interface CitationWhere {
  /** variable：引用写在某个变量的值里；template：写在模板正文里 */
  kind: 'variable' | 'template';
  variable?: string | null;
  variableLabel?: string | null;
  templateId?: number | null;
  templateName?: string | null;
  /** 命中位置前后的一小段原文，界面上直接显示"在哪" */
  excerpt?: string | null;
}

export interface Citation {
  /** 原文写法，如 `《设备验收管理办法》第五条` */
  raw: string;
  documentName: string;
  /** 引用里带的发文字号（可选） */
  docNoText: string | null;
  /** 条款写法，如 `第五条` */
  clauseText: string;
  clauseNo: number | null;
  /** 款/项号（有就一起比） */
  subNo: number | null;
  /** 引用里写了完整路径时（`第二章 到货验收要求/第五条`）的路径分段；没有就是空数组 */
  pathSegments: string[];
  where: CitationWhere;
}

/** 从一段文本里解析出全部引用（按出现顺序；同一写法出现在两处各留一条 —— 位置不同要分别报） */
export function parseCitations(text: string, where: CitationWhere): Citation[] {
  const out: Citation[] = [];
  if (!text) return out;
  const re = new RegExp(CITE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const documentName = String(m[1] ?? '').trim();
    const paren = String(m[2] ?? '').trim();
    const prefix = String(m[3] ?? '').trim();
    const clauseText = normSeg(String(m[4] ?? ''));
    const subText = m[5] ? normSeg(String(m[5])) : m[6] ? normSeg(String(m[6])) : '';
    if (!documentName || !clauseText) continue;
    const start = Math.max(0, m.index - 12);
    out.push({
      raw: String(m[0]).replace(/\s+/g, ' ').trim(),
      documentName,
      docNoText: paren && looksLikeDocNo(paren) ? paren : null,
      clauseText,
      clauseNo: clauseNoOfSegment(clauseText),
      subNo: subText ? subNoOfSegment(subText) : null,
      pathSegments: prefix
        .split(/[\/>]+/)
        .map((s) => normSeg(s))
        .filter(Boolean),
      where: { ...where, excerpt: text.slice(start, Math.min(text.length, m.index + m[0].length + 12)).replace(/\s+/g, ' ') },
    });
  }
  return out;
}

/**
 * 段尾的款/项标记：`第五条第九款` 的 `第九款`、`第五条第（九）款` 的 `第（九）款`。
 * 只在**结尾**匹配 —— `（一）总则` 这种"项名在开头"的写法不受影响。
 */
const TRAILING_SUB_RE = /第\s*[0-9０-９一二三四五六七八九十百千零〇两]{1,6}\s*[款项]\s*$|[（(]\s*[0-9０-９一二三四五六七八九十百千零〇两]{1,4}\s*[）)]\s*$/;

/**
 * 解析"条款路径"参数：`第五条`、`第五条第九款`、`第二章/第五条`、`第二章 > 第五条 检查频次`、或条款名 `检查频次`。
 *
 * 多段路径的**末段**才可能是"这一条"；末段尾巴上的款/项标记要摘出来单独作为 `subNo` ——
 * 不摘的话它会粘在段名里（`第五条第九款`），永远 `includes` 不上任何真实分段，
 * 于是"明明存在的款号"被判成找不到（假阳性）。
 */
export function parseClauseSpec(spec: string): { no: number | null; subNo: number | null; segments: string[]; raw: string } {
  const raw = String(spec ?? '').trim();
  const parts = raw
    .split(/[>/\\|]+|\s{2,}/)
    .map((s) => normSeg(s))
    .filter(Boolean);
  if (parts.length > 1) {
    const last = parts[parts.length - 1] as string;
    const subNo = subNoOfSegment(last);
    const trimmed = subNo === null ? last : last.replace(TRAILING_SUB_RE, '').trim() || last;
    return { no: clauseNoOfSegment(trimmed), subNo, segments: [...parts.slice(0, -1), trimmed], raw };
  }
  return { no: clauseNoOfSegment(raw), subNo: subNoOfSegment(raw), segments: [], raw: normSeg(raw) };
}

/**
 * 一个片段路径是否命中条款写法。
 *
 * **条、款、项必须一起比**（这是修掉的 P1）：旧实现只要求"路径里存在某个分段含该条号"
 * 和"路径里存在某个分段含该款号"，款/项号在 `resolveCitation` 里根本没传进来 ——
 * 于是引用「第五条第九款」、库里只有「第五条第一款」时照样 `resolved`，
 * `CITE_CLAUSE_MISSING` 静默失效（引用悬空却报通过）。现在的口径：
 *   · 先用条号（或路径分段）定位到**这一条**所在的分段；
 *   · 引用了款/项号时，款/项号必须落在**这一条之下**（`idx >= clauseAt`）:
 *     `第二章 检查考核 > 第五条 检查频次 > （二）问题登记` 里 `（二）` 在 `第五条` 之后才对；
 *   · 款号也可能直接写在条的那一段里（`第五条 检查频次（二）`，一款一行没写成独立标题），
 *     所以下界取 `>=` 而不是 `>`；
 *   · 按"条款名"字面匹配的那一支不再单独比款号：写法本身就带款号（`（一）总则`），
 *     字面命中即命中（不然 `（一）` 开头的节标题会被冤枉成"款号不存在"）。
 */
export function matchClausePath(clausePath: string | null, spec: ReturnType<typeof parseClauseSpec>): boolean {
  if (!clausePath) return false;
  const segs = clausePath.split(CLAUSE_PATH_SEP).map(normSeg).filter(Boolean);
  if (spec.segments.length) {
    let i = 0;
    let clauseAt = -1;
    for (let idx = 0; idx < segs.length; idx += 1) {
      const want = spec.segments[i];
      if (want && (segs[idx] as string).includes(want)) {
        if (i === spec.segments.length - 1) clauseAt = idx; // 命中的最后一段 = 引用的这一条
        i += 1;
      }
    }
    if (i !== spec.segments.length) return false;
    if (spec.subNo === null) return true;
    return segs.some((s, idx) => idx >= clauseAt && subNoOfSegment(s) === spec.subNo);
  }
  if (spec.no !== null) {
    const clauseAt = segs.findIndex((s) => clauseNoOfSegment(s) === spec.no);
    if (clauseAt < 0) return false;
    if (spec.subNo === null) return true;
    return segs.some((s, idx) => idx >= clauseAt && subNoOfSegment(s) === spec.subNo);
  }
  // 既没有条号也不是路径写法：按"条款名"字面匹配（如 `检查频次`；`（一）总则` 也走这一支）
  if (!spec.raw) return false;
  return segs.some((s) => s.includes(spec.raw));
}

export interface ClauseHit {
  documentId: number;
  title: string;
  docNo: string | null;
  scopeLayer: string | null;
  versionStatus: string | null;
  decision: string | null;
  docSha256: string | null;
  /** 命中的片段（一条可能被切成多个片段，全部给出来） */
  chunkIds: number[];
  seq: number;
  clausePath: string | null;
  clauseNo: number | null;
  /** 引用的款/项号（`第五条第二款` 的「二」）；没写款号时为 null */
  subNo: number | null;
  /** 路径里属于该条的那一段原文，如 `第五条 检查频次` */
  clauseLabel: string | null;
  content: string;
  quote: string;
}

export type CitationStatus = 'resolved' | 'clause_missing' | 'document_missing' | 'ambiguous' | 'superseded';

export interface ResolvedCitation extends Citation {
  status: CitationStatus;
  hit: ClauseHit | null;
  /** 匹配到（或疑似匹配到）的制度 */
  candidates: { documentId: number; title: string; docNo: string | null; versionStatus: string | null; decision: string | null; scopeLayer: string | null }[];
  /** 该制度里实际有哪些条（给"怎么改"用） */
  availableClauses: string[];
  /** 引用了款/项号却没核到时，这一条下面**实际有哪些款/项号**（给"怎么改"用） */
  availableSubClauses: string[];
  reason: string;
}

interface DocRow {
  id: number;
  title: string;
  doc_no: string | null;
  scope_layer: string | null;
  version_status: string | null;
  decision: string | null;
  doc_sha256: string | null;
  rel_path: string | null;
  file_name: string | null;
}

const DOC_SELECT = `SELECT d.id, d.title, d.doc_no, d.scope_layer, d.version_status, d.decision,
                           d.doc_sha256, d.rel_path, a.file_name
                      FROM kb_document d LEFT JOIN artifact a ON a.id = d.artifact_id`;

function docMatchScore(d: DocRow, name: string, docNoText: string | null): number {
  const base = (d.file_name ?? '').replace(/\.[^.]+$/, '');
  const target = normSeg(name);
  if (!target) return 0;
  let score = 0;
  if (docNoText && d.doc_no && normSeg(d.doc_no) === normSeg(docNoText)) score += 200;
  if (d.doc_no && normSeg(d.doc_no) === target) score += 180;
  if (normSeg(d.title) === target) score += 100;
  else if (base && normSeg(base) === target) score += 95;
  else if (normSeg(d.title).includes(target)) score += 70;
  else if (base && normSeg(base).includes(target)) score += 65;
  else if (d.rel_path && normSeg(d.rel_path).includes(target)) score += 50;
  return score;
}

/**
 * 按「制度名 / 文号」找制度。**纯字面匹配**，不用向量、不用模型：
 * 引用里写的是什么名字，就必须能在标题/文件名/文号/相对路径里找到它。
 * 找不到时给出"疑似是你想引的那几份"（按字面重合度排），让人一眼看出是名字写错了还是没入库。
 */
export function findDocuments(name: string, docNoText: string | null = null): { hits: DocRow[]; ambiguous: boolean; near: DocRow[] } {
  const rows = all<DocRow>(DOC_SELECT);
  const scored = rows
    .map((d) => ({ d, s: docMatchScore(d, name, docNoText) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.d.id - b.d.id);
  const top = scored[0];
  if (!top) {
    const near = rows
      .map((d) => ({ d, s: overlapScore(`${d.title} ${d.file_name ?? ''}`, name) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => x.d);
    return { hits: [], ambiguous: false, near };
  }
  const best = scored.filter((x) => x.s === top.s).map((x) => x.d);
  return { hits: best, ambiguous: best.length > 1, near: [] };
}

/** 字面重合度（2-gram 交集 / 较短串的 gram 数），只用于"疑似"提示 */
function overlapScore(a: string, b: string): number {
  const ga = grams(normSeg(a));
  const gb = grams(normSeg(b));
  if (!ga.size || !gb.size) return 0;
  let hit = 0;
  for (const g of gb) if (ga.has(g)) hit += 1;
  return hit / Math.min(ga.size, gb.size);
}
function grams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 该制度里有哪些条（给"怎么改"提示与人工抽查用） */
export function availableClauses(documentId: number, limit = 40): string[] {
  const rows = all<{ path: string | null }>(
    'SELECT DISTINCT clause_path AS path FROM kb_chunk WHERE document_id = ? AND clause_path IS NOT NULL',
    [documentId],
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (!r.path) continue;
    for (const seg of r.path.split(CLAUSE_PATH_SEP)) {
      const t = seg.trim().replace(/[。；;]+$/, '');
      if (clauseNoOfSegment(t) !== null && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  out.sort((a, b) => (clauseNoOfSegment(a) ?? 0) - (clauseNoOfSegment(b) ?? 0));
  return out.slice(0, limit);
}

/** 款/项标记：`第二款` / `（二）`（找款号用；与 SUB_NUM_RE 同口径，但带 g） */
const SUB_MARKER_RE = /(第\s*([0-9０-９一二三四五六七八九十百千零〇两]{1,6})\s*[款项])|([（(]\s*([0-9０-９一二三四五六七八九十百千零〇两]{1,4})\s*[）)])/g;

/**
 * 一段正文里出现的款/项标记（`（一）每月不少于1次` → `{no:1,label:'（一）每月不少于1次'}`）。
 *
 * 为什么要从**正文**里找款号（而不只看 clause_path）：制度里"一款一行"的写法常常是
 * `（一）每月不少于1次。` —— 结尾的句号让它**不算独立标题行**，于是它进不了 `clause_path`。
 * 只在路径里找款号的话，明明存在的第一款也会被判成"款号不存在"（假阳性）。
 */
function subMarkersInText(text: string): { no: number; label: string }[] {
  const out: { no: number; label: string }[] = [];
  const re = new RegExp(SUB_MARKER_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[2] ?? m[4];
    if (!raw) continue;
    const no = cnNumToArabic(raw);
    if (no === null) continue;
    const tail = text
      .slice(m.index + m[0].length, m.index + m[0].length + 18)
      .split(/[。；;\n]/)[0]
      ?.trim() ?? '';
    out.push({ no, label: `${m[0].replace(/\s+/g, '')}${tail}` });
  }
  return out;
}

/**
 * 某一条下面有哪些款/项 —— 给"款号写错"的提示用（与 `availableClauses` 同一风格）。
 * 两个来源都看：`clause_path` 里的项分段（`（一）问题登记`）+ 正文里的款/项标记（`（一）每月…`）。
 */
export function availableSubClauses(documentId: number, clauseNo: number | null, limit = 20): string[] {
  const rows = all<{ clause_path: string | null; content: string }>(
    'SELECT clause_path, content FROM kb_chunk WHERE document_id = ? ORDER BY seq',
    [documentId],
  );
  const seen = new Set<string>();
  const out: { no: number; label: string }[] = [];
  const push = (no: number, label: string): void => {
    const t = label.trim().replace(/[。；;]+$/, '');
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push({ no, label: t });
  };
  // ① 路径分段里的项（`（一）问题登记`）—— 只有落在引用的那一条**之下**才算
  for (const r of rows) {
    if (!r.clause_path) continue;
    const segs = r.clause_path.split(CLAUSE_PATH_SEP).map((s) => s.trim());
    const at = clauseNo === null ? -1 : segs.findIndex((s) => clauseNoOfSegment(s) === clauseNo);
    if (clauseNo !== null && at < 0) continue;
    for (const seg of segs.slice(at + 1)) {
      const no = subNoOfSegment(seg);
      if (no !== null) push(no, seg);
    }
  }
  // ② 条款正文里的款/项标记（一款一行且行尾带句号的写法进不了路径）
  if (clauseNo !== null) {
    const spec = { no: clauseNo, subNo: null, segments: [], raw: '' };
    for (const r of rows) {
      if (!matchClausePath(r.clause_path, spec)) continue;
      for (const mk of subMarkersInText(r.content)) push(mk.no, mk.label);
    }
  }
  out.sort((a, b) => a.no - b.no);
  return out.map((x) => x.label).slice(0, limit);
}

interface ClauseMatch {
  chunks: { id: number; seq: number; path: string | null; content: string }[];
  path: string | null;
  /** 款/项号是在哪一层对上的：path=路径分段，content=条款正文里的款/项标记，null=引用里没写款号 */
  subMatchedAt: 'path' | 'content' | null;
  /** 引用的**条号本身**在这份制度里存不存在（用来区分"条号写错"与"款号写错"） */
  clauseFound: boolean;
}

/**
 * 按条款写法取片段。三段式：
 *   ① 条 + 款/项**一起**匹配（{@link matchClausePath}）；
 *   ② 路径里没有该款号 → 退回"条号匹配 + 正文里有该款/项标记"（一款一行的写法进不了路径）；
 *   ③ 都没有 → 返回空，但把 `clauseFound` 带上，好让提示能分清"条号不存在"与"款号不存在"。
 */
function clauseContent(documentId: number, spec: ReturnType<typeof parseClauseSpec>): ClauseMatch {
  const rows = all<{ id: number; seq: number; clause_path: string | null; content: string }>(
    'SELECT id, seq, clause_path, content FROM kb_chunk WHERE document_id = ? ORDER BY seq',
    [documentId],
  );
  const pick = (from: typeof rows): ClauseMatch['chunks'] => from.map((r) => ({ id: r.id, seq: r.seq, path: r.clause_path, content: r.content }));

  const exact = rows.filter((r) => matchClausePath(r.clause_path, spec));
  if (exact.length) return { chunks: pick(exact), path: exact[0]?.clause_path ?? null, subMatchedAt: spec.subNo === null ? null : 'path', clauseFound: true };

  // 引用了款/项号却没匹配上：先看"这一条"在不在，再看它的正文里有没有这个款/项标记
  const clauseOnly = { ...spec, subNo: null };
  const base = rows.filter((r) => matchClausePath(r.clause_path, clauseOnly));
  if (!base.length) return { chunks: [], path: null, subMatchedAt: null, clauseFound: false };
  if (spec.subNo === null) return { chunks: [], path: base[0]?.clause_path ?? null, subMatchedAt: null, clauseFound: true };
  const withSub = base.filter((r) => subMarkersInText(r.content).some((mk) => mk.no === spec.subNo));
  if (withSub.length) return { chunks: pick(withSub), path: withSub[0]?.clause_path ?? null, subMatchedAt: 'content', clauseFound: true };
  return { chunks: [], path: base[0]?.clause_path ?? null, subMatchedAt: null, clauseFound: true };
}

function quoteOf(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 条款路径的**可读形态**：分段去尾部的句号/分号。
 * 制度里"一条一行"的写法会让路径分段带上句号（`第三条 现场安全检查频次不得低于每月2次。`），
 * 直接拼进文书或提示里就是"两个句号"，很难看。
 */
function prettyPath(path: string | null): string | null {
  if (!path) return null;
  return path
    .split(CLAUSE_PATH_SEP)
    .map((s) => s.trim().replace(/[。；;]+$/, ''))
    .filter(Boolean)
    .join(CLAUSE_PATH_SEP);
}

/** 条款的可引用标签（路径里属于该条的那一段，去尾部标点） */
function prettyLabel(label: string | null): string | null {
  return label ? label.trim().replace(/[。；;]+$/, '') : null;
}

/** 条款路径里属于该条的那一段（`第二章 到货验收 > 第五条 检查频次` → `第五条 检查频次`） */
function clauseLabelOf(path: string | null, no: number | null): string | null {
  if (!path) return null;
  const segs = path.split(CLAUSE_PATH_SEP).map((s) => s.trim());
  if (no === null) return segs[segs.length - 1] ?? null;
  return segs.find((s) => clauseNoOfSegment(s) === no) ?? segs[segs.length - 1] ?? null;
}

/**
 * 把一处引用解析到具体片段。
 *
 * **入参必须带 `subNo`（款/项号）**：旧实现只接收 `documentName/docNoText/clauseText/pathSegments`，
 * 解析出来的款/项号（`第五条**第二款**`）不参与匹配，只在返回对象里露一下 ——
 * 「第五条第九款」于是被当成「第五条」核对通过。现在款/项号一路参与
 * {@link parseClauseSpec} → {@link matchClausePath} → {@link clauseContent}。
 */
export function resolveCitation(
  cite: Pick<Citation, 'documentName' | 'docNoText' | 'clauseText' | 'pathSegments'> & { subNo?: number | null },
): ResolvedCitation {
  const found = findDocuments(cite.documentName, cite.docNoText);
  const subNoFromText = subNoOfSegment(cite.clauseText);
  const subNo = cite.subNo ?? subNoFromText;
  const base: ResolvedCitation = {
    raw: '',
    documentName: cite.documentName,
    docNoText: cite.docNoText,
    clauseText: cite.clauseText,
    clauseNo: clauseNoOfSegment(cite.clauseText),
    subNo,
    pathSegments: cite.pathSegments ?? [],
    where: { kind: 'template' },
    status: 'document_missing',
    hit: null,
    candidates: [],
    availableClauses: [],
    availableSubClauses: [],
    reason: '',
  };
  if (!found.hits.length) {
    const near = found.near.length
      ? `知识库里名字最接近的是：${found.near.map((d) => `《${d.title}》${d.doc_no ? `（${d.doc_no}）` : ''}`).join('、')}`
      : '知识库里还没有任何制度（先到「知识库」绑定来源目录或上传制度并抽取）';
    return { ...base, status: 'document_missing', reason: `知识库里没有《${cite.documentName}》这份制度 —— 无法核对条号。${near}` };
  }
  if (found.ambiguous) {
    return {
      ...base,
      status: 'ambiguous',
      candidates: found.hits.map((d) => ({ documentId: d.id, title: d.title, docNo: d.doc_no, versionStatus: d.version_status, decision: d.decision, scopeLayer: d.scope_layer })),
      reason: `有 ${found.hits.length} 份制度都匹配《${cite.documentName}》：${found.hits.map((d) => `#${d.id} ${d.title}${d.doc_no ? `（${d.doc_no}）` : ''}`).join('、')} —— 无法确定依据的是哪一份，请在引用里带上发文字号。`,
    };
  }
  const doc = found.hits[0] as DocRow;
  // decision 为 NULL 的是手工上传那条路（没有抽取结论），同样算可用
  const active = doc.decision === null || doc.decision === undefined || doc.decision === 'active';
  /**
   * 条款写法 → 匹配条件（**条 + 款/项一起进 spec**）：
   *   · 引用里带了路径（规范出处串那种）→ 按路径分段顺序匹配，末段是引用的这一条；
   *   · 只写了条号 → 按条号匹配，款/项号（`第五条第九款` 的「九」）一并带上；
   *   · 只写了条款名（如 `检查频次`）→ 按字面匹配。
   */
  const clauseSpec = parseClauseSpec(cite.clauseText);
  const spec = base.pathSegments.length
    ? { no: null, subNo: base.subNo, segments: [...base.pathSegments, normSeg(cite.clauseText)], raw: normSeg(cite.clauseText) }
    : { ...clauseSpec, subNo: base.subNo ?? clauseSpec.subNo };
  const matched = clauseContent(doc.id, spec);
  const { chunks, path } = matched;
  const common = {
    ...base,
    candidates: [{ documentId: doc.id, title: doc.title, docNo: doc.doc_no, versionStatus: doc.version_status, decision: doc.decision, scopeLayer: doc.scope_layer }],
    availableClauses: availableClauses(doc.id),
  };
  if (!active) {
    return {
      ...common,
      status: 'superseded',
      reason: `《${doc.title}》${doc.doc_no ? `（${doc.doc_no}）` : ''}按当前抽取口径没有入库（结论：${doc.decision ?? '未知'}，版本：${doc.version_status ?? '未知'}）—— 这一条不能作为依据。`,
    };
  }
  if (!chunks.length) {
    const avail = common.availableClauses.length
      ? `这份制度里现有：${common.availableClauses.slice(0, 12).join('、')}${common.availableClauses.length > 12 ? ' 等' : ''}`
      : '这份制度的片段里没有识别到条号（可能是通知类文件，或抽取时没切出条款路径）';
    /**
     * 款/项号对不上时**必须单独说清**（这是最容易静默放过的悬空引用）：
     * 条号本身在、只是这一条下面没有这个款号 → 提示里要给出"这一条下面现有的款/项号"，
     * 与"条号不存在"的提示风格保持一致。
     */
    if (base.subNo !== null && matched.clauseFound) {
      const subList = availableSubClauses(doc.id, base.clauseNo);
      const label = prettyLabel(clauseLabelOf(matched.path ?? path, base.clauseNo)) ?? cite.clauseText;
      const subText = subList.length
        ? `这一条下面现有：${subList.slice(0, 12).join('、')}${subList.length > 12 ? ' 等' : ''}`
        : '这一条下面没有识别到款/项号（可能是"一款一行"的写法没被识别，或抽取时没切出来）';
      return {
        ...common,
        status: 'clause_missing',
        availableSubClauses: subList,
        reason: `《${doc.title}》里有「${label}」，但没有「${subNoLabel(base.subNo)}」—— 引用是悬空的。${subText}`,
      };
    }
    return { ...common, status: 'clause_missing', reason: `《${doc.title}》里找不到「${cite.clauseText}」。${avail}` };
  }
  const content = chunks.map((c) => c.content).join('\n').trim();
  const hit: ClauseHit = {
    documentId: doc.id,
    title: doc.title,
    docNo: doc.doc_no,
    scopeLayer: doc.scope_layer,
    versionStatus: doc.version_status,
    decision: doc.decision,
    docSha256: doc.doc_sha256,
    chunkIds: chunks.map((c) => c.id),
    seq: chunks[0]?.seq ?? 0,
    clausePath: path,
    clauseNo: base.clauseNo,
    subNo: base.subNo,
    clauseLabel: clauseLabelOf(path, base.clauseNo),
    content,
    quote: quoteOf(content),
  };
  return { ...common, status: 'resolved', hit, reason: `已核对到《${doc.title}》${doc.doc_no ? `（${doc.doc_no}）` : ''}${path ?? ''}${base.subNo !== null ? `（${subNoLabel(base.subNo)}${matched.subMatchedAt === 'content' ? '，按正文里的款/项标记核对' : ''}）` : ''}` };
}

/**
 * 按「制度名/文号 + 条款路径」取值（B3-9 的"按条款检索/取值"接口就是它）。
 * 与 {@link resolveCitation} 的区别：这里允许传完整路径写法（`第二章/第五条`、`第二章 > 第五条`）。
 */
export function lookupClause(documentRef: string, clauseRef: string): ResolvedCitation {
  const parsed = parseClauseSpec(clauseRef);
  const r = resolveCitation({
    documentName: documentRef,
    docNoText: looksLikeDocNo(documentRef) ? documentRef : null,
    clauseText: clauseRef,
    // 款/项号（`第五条第九款`）必须带下去：不然"第九款"不参与匹配，悬空引用会被判成 resolved
    subNo: parsed.subNo,
    pathSegments: [],
  });
  // 传的是多段路径时，resolveCitation 已经按同一份 spec 判过一遍；这里再判一次是为了兜住
  // "路径写法与片段实际路径对不上"的情况。**只覆盖 resolved**：
  // 其它结论（clause_missing 的款号清单、superseded、document_missing）都带着更准的原因和清单，
  // 覆写成一句"找不到路径"会把"这一条下面现有哪些款/项"这类关键提示弄丢。
  if (parsed.segments.length && r.status === 'resolved') {
    if (!r.hit || !matchClausePath(r.hit.clausePath, parsed)) {
      return { ...r, status: 'clause_missing', hit: null, reason: `《${r.candidates[0]?.title ?? documentRef}》里找不到路径「${clauseRef}」。` };
    }
  }
  return r;
}

/**
 * 可粘进文书的**规范出处串**：`《制度名》（文号）第二章 检查考核/第五条 检查频次`。
 * 文号 + 条款路径都在里面 —— 交出去对方能逐字核对（这正是 B3-9 要的"可核对的条款出处"）。
 * `short=true` 用公文更常见的短形态 `《制度名》（文号）第五条`；`quote=true` 再带上原文。
 */
export function composeCiteText(hit: ClauseHit, opts: { short?: boolean; quote?: boolean } = {}): string {
  const no = hit.docNo ? `（${hit.docNo}）` : '';
  const path = prettyPath(hit.clausePath)?.split(CLAUSE_PATH_SEP).map((s) => s.trim()).join('/') ?? prettyLabel(hit.clauseLabel) ?? '';
  const body = opts.short ? prettyLabel(hit.clauseLabel) ?? path : path || (prettyLabel(hit.clauseLabel) ?? '');
  const tail = opts.quote ? `：“${quoteOf(hit.content, 120)}”` : '';
  return `《${hit.title}》${no}${body}${tail}`;
}

export interface ClauseSearchItem {
  documentId: number;
  title: string;
  docNo: string | null;
  clausePath: string | null;
  clauseNo: number | null;
  content: string;
  quote: string;
  chunkId: number;
  citeText: string;
}

/**
 * 条款级检索：命中的片段按「制度 + 条款路径」合并，返回**可直接引用**的条目。
 *
 * 检索复用 B3-8 的 `searchKbChunks`（查 `kb_chunk_fts`），查询串按字组 AND 组：
 * 实测 unicode61 下中文整串短语（`"隐患整改"`）匹配不到，逐字 AND 才行（B3-8 踩坑 5）。
 */
export function searchClauses(query: string, opts: { doc?: string | null; limit?: number } = {}): { items: ClauseSearchItem[]; total: number; match: string } {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const q = String(query ?? '').trim();
  const docFilter = String(opts.doc ?? '').trim();
  const terms = q
    .split(/\s+/)
    .map((t) => t.replace(/["'*(){}[\]^~:\\/]/g, '').trim())
    .filter(Boolean)
    // 与 B3-8 的 /api/kb/chunks/search 同一口径：CJK 逐字拆开再用 AND 组合
    .flatMap((t) => segCJK(t).split(/\s+/))
    .filter((t) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(t));
  const match = terms.length ? terms.map((t) => `"${t}"`).join(' AND ') : '';
  if (!match && !docFilter) return { items: [], total: 0, match: '' };
  const rows = match ? searchKbChunks(match, Math.max(limit * 8, 60)) : [];
  const filtered = docFilter
    ? rows.filter((r) => `${r.title} ${r.relPath ?? ''}`.includes(docFilter))
    : rows;
  const grouped = new Map<string, ClauseSearchItem>();
  for (const r of filtered) {
    const key = `${r.documentId}|${r.clausePath ?? ''}`;
    const existed = grouped.get(key);
    if (existed) {
      existed.content = `${existed.content}\n${r.content}`;
      existed.quote = quoteOf(existed.content);
      continue;
    }
    const hit: ClauseHit = {
      documentId: r.documentId,
      title: r.title,
      docNo: null,
      scopeLayer: r.scopeLayer,
      versionStatus: r.versionStatus,
      decision: 'active',
      docSha256: null,
      chunkIds: [r.chunkId],
      seq: 0,
      clausePath: r.clausePath,
      clauseNo: r.clausePath ? clauseNoOfSegment(r.clausePath) : null,
      subNo: r.clausePath ? subNoOfSegment(r.clausePath) : null,
      clauseLabel: clauseLabelOf(r.clausePath, r.clausePath ? clauseNoOfSegment(r.clausePath) : null),
      content: r.content,
      quote: quoteOf(r.content),
    };
    grouped.set(key, {
      documentId: r.documentId,
      title: r.title,
      docNo: null,
      clausePath: r.clausePath,
      clauseNo: hit.clauseNo,
      content: r.content,
      quote: hit.quote,
      chunkId: r.chunkId,
      citeText: composeCiteText(hit),
    });
  }
  const items = [...grouped.values()].slice(0, limit);
  return { items, total: grouped.size, match };
}

/* ============================================================================
 * 三、口径：从条款里读"关键数字/期限"
 * ==========================================================================*/

export type QtySubject = 'amount' | 'term' | 'frequency' | 'headcount' | 'ratio' | 'copies' | 'pages' | 'other';
export type QtyDirection = 'max' | 'min';

export interface Quantity {
  subject: QtySubject;
  direction: QtyDirection;
  value: number;
  /** 条款里写的单位原文，如 `万元` / `个工作日` / `%` */
  unitRaw: string;
  /** 归一后的单位族（**同族才比较**，"2个月"与"30日"不做数字比较） */
  unitFamily: string;
  /** 事项短语：比较词/数字之前那一截，归一化后用于判"是不是同一件事" */
  phrase: string;
  raw: string;
  sentence: string;
}

const UNIT_ALT =
  '万元|亿元|个百分点|个工作日|工作日|平方米|公里|千米|公斤|小时|分钟|个月|元|％|%|天|日|月|年|周|次|人|份|张|台|套|米|页|吨|项|条|处';

/** 比较词（长的在前，避免"超过"抢先匹配掉"不得超过"） */
const MAX_WORDS = ['不得超过', '不能超过', '不得多于', '不多于', '不得高于', '不高于', '不超过', '最多', '至多', '上限为', '上限', '以内', '以下', '之内', '控制在'];
const MIN_WORDS = ['不得少于', '不能少于', '不得低于', '不低于', '不少于', '最少', '至少', '下限为', '下限', '以上', '需达到', '应达到', '达到'];

const SUBJECT_RULES: { subject: QtySubject; re: RegExp }[] = [
  { subject: 'amount', re: /金额|价款|造价|单价|总价|限额|额度|费用|罚款|违约金|保证金|押金|元/ },
  { subject: 'ratio', re: /比例|百分比|％|%|占比|费率/ },
  { subject: 'frequency', re: /频次|次数|每(?:日|天|周|月|季|年|半年|季度)|巡检|检查/ },
  { subject: 'headcount', re: /人数|人员|配备|专职|兼职|人/ },
  { subject: 'copies', re: /份数|数量|张数|台数|套数|件数|份|张|台|套/ },
  { subject: 'pages', re: /页数|页/ },
  { subject: 'term', re: /期限|工期|时限|有效期|保存期限|归档|日内|天数|天|日|月|年|周|小时|工作日/ },
];

/** 单位族：同族才比较（`天/日/个工作日` 分成两类，避免把"3个工作日"和"3天"当成同一件事） */
export function unitFamily(unit: string): string {
  const u = unit.trim();
  if (!u) return '';
  if (/万元|亿元|元/.test(u)) return 'yuan';
  if (/%|％|个百分点/.test(u)) return 'percent';
  if (/个工作日/.test(u)) return 'workday';
  if (/工作日/.test(u)) return 'workday';
  if (/天|日/.test(u)) return 'day';
  if (/个月|月/.test(u)) return 'month';
  if (/年/.test(u)) return 'year';
  if (/周/.test(u)) return 'week';
  if (/次/.test(u)) return 'times';
  if (/人/.test(u)) return 'person';
  if (/份|张|台|套|件/.test(u)) return 'piece';
  if (/页/.test(u)) return 'page';
  if (/小时|分钟/.test(u)) return 'hour';
  return u;
}

function subjectOf(phrase: string, unit: string): QtySubject {
  const hay = `${phrase}${unit}`;
  for (const r of SUBJECT_RULES) if (r.re.test(hay)) return r.subject;
  return 'other';
}

/** 事项短语归一化：去虚词、标点、方向词残留与**条款编号前缀**，只留"这说的是哪件事" */
function normPhrase(raw: string): string {
  let s = toHalfWidthDigits(raw)
    .replace(/[\s，。；：、,.;:!?！？"'“”（）()《》]/g, '')
    .replace(/(?:应当|应该|应|须|需|必须|不得|不能|由|对|其|该|本|于|在|是|为|的|按|依|和|与|及|或|并|均|一律|一般)+$/g, '')
    .replace(/^(?:应当|应该|应|须|需|必须|由|对|其|该|本|在|是|为|按|依|和|与|及)+/g, '')
    /**
     * 去掉**开头的条款编号**：制度里很多条是「一条一行」的写法（`第三条 现场安全检查频次不得低于每月2次。`），
     * 于是事项短语会带上「第三条」—— 那样两处谈同一件事的条款就会被判成两件事，冲突检测直接失效（实测踩过）。
     */
    .replace(/^第[0-9一二三四五六七八九十百千零〇两]{1,8}[条章节款项]/g, '')
    .replace(/^[（(][0-9一二三四五六七八九十]{1,4}[）)]/g, '');
  if (s.length > 24) s = s.slice(-24);
  return s;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[。；;！!？?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 从一段条款原文里抽出"关键数字/期限"。
 *
 * 只认**带比较词或比较后缀**的定量表述（"不得超过 30 日"、"不少于 1 次"、"500 万元以内"），
 * 认不出来的不产出 —— 宁可计成"未求值"，也不凭一个孤立数字去判别人（验收⑥：无假阳性）。
 */
export function extractQuantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  if (!text) return out;
  const numPat = '([0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+(?:\\.[0-9]+)?|[0-9０-９]+(?:\\.[0-9]+)?|[一二三四五六七八九十百千零〇两]{1,8})';
  const dirAlt = [...MAX_WORDS, ...MIN_WORDS].join('|');
  // 形态 A：比较词 … 数字 [单位]
  const reA = new RegExp(`(${dirAlt})[^。；，,]{0,8}?${numPat}\\s*(${UNIT_ALT})?`, 'g');
  // 形态 B：数字 单位 比较后缀（"30 日以内"）
  const reB = new RegExp(`${numPat}\\s*(${UNIT_ALT})\\s*(${dirAlt})`, 'g');
  for (const sentence of splitSentences(text)) {
    const push = (direction: QtyDirection, valueRaw: string, unitRaw: string, raw: string, at: number): void => {
      const value = cnNumToArabic(valueRaw);
      if (value === null) return;
      const unit = unitRaw || '';
      const phrase = normPhrase(sentence.slice(0, at));
      out.push({
        direction,
        value,
        unitRaw: unit,
        unitFamily: unitFamily(unit),
        phrase,
        subject: subjectOf(phrase, unit),
        raw: raw.replace(/\s+/g, ' ').trim(),
        sentence: sentence.replace(/\s+/g, ' ').trim(),
      });
    };
    {
      const re = new RegExp(reA.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(sentence))) {
        const word = String(m[1] ?? '');
        push(MAX_WORDS.includes(word) ? 'max' : 'min', String(m[2] ?? ''), String(m[3] ?? ''), m[0], m.index);
      }
    }
    {
      const re = new RegExp(reB.source, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(sentence))) {
        const word = String(m[3] ?? '');
        push(MAX_WORDS.includes(word) ? 'max' : 'min', String(m[1] ?? ''), String(m[2] ?? ''), m[0], m.index);
      }
    }
  }
  // A/B 两种形态会重复命中同一处（如 `30 日以内`）：按内容去重
  const seen = new Set<string>();
  return out.filter((q) => {
    const key = `${q.direction}|${q.value}|${q.unitRaw}|${q.phrase}|${q.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 变量名归一：去掉单位/量词后缀，留下"说的是哪件事" */
function varPhrase(name: string): string {
  const stripped = normPhrase(String(name ?? '').replace(/(?:天数|数量|金额|上限|下限|数|值|比例|期限)$/g, ''));
  return stripped || normPhrase(String(name ?? ''));
}

/** 两个事项短语是不是"同一件事"（相等 / 包含 / 公共后缀 ≥3） */
function sameThing(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1;
  return i >= 3;
}

/**
 * 变量值里的「数字 + 单位」（`60` / `60天` / `6,000,000元` / `￥500万元` → 6000000 + `元`）。
 *
 * 修掉的两个坑（P1「金额校验既误报又漏报」的第二个）：
 *   · 旧正则 `(-?\d+(?:\.\d+)?)\s*([^\s\d]{0,4})` 在 `6,000,000元` 上只取到 `6`，
 *     单位被读成 `,000` → 单位族对不上 → 静默跳过 → **该拦的没拦**；
 *   · 现在先吃掉千分位与全角字符（`，`/`,`/全角数字/`￥`/`人民币`），再取**紧跟数字之后**的单位。
 */
export function numberInValue(value: string): { num: number; unitRaw: string } | null {
  const v = toHalfWidthDigits(String(value ?? ''))
    .replace(/[￥¥$]/g, '')
    .replace(/人民币|RMB/g, '');
  const m = /(-?\d[\d,，]*(?:\.\d+)?)\s*([^\s\d,，]{0,4})/.exec(v);
  if (!m) return null;
  const n = Number(String(m[1]).replace(/[,，]/g, ''));
  if (!Number.isFinite(n)) return null;
  return { num: n, unitRaw: (m[2] ?? '').trim() };
}

export interface UnitMagnitude {
  /** 单位族（`yuan` / `day` / `times`…）：**只有同族才能比大小** */
  family: string;
  /** 基准单位（金额统一到 `元`） */
  base: string;
  /** 折算到基准单位的倍数：`万元` → 10000 */
  factor: number;
}

/**
 * 单位的**量级**（修掉 P1「金额校验误报」的那一半）。
 *
 * 为什么必须有它：条款写「不得超过 500 万元」、变量填「4000000 元」时，两边的**单位族**
 * 都是 `yuan`，旧代码就按单位族相等直接比原数 —— 500 vs 4000000 → 误报超限。
 * 单位族相同但量级不同**必须换算**（万元/亿元 → 元，倍数 10000 / 100000000）。
 *
 * 认不出来的单位返回 `null`：**不猜**。调用方据此记成"未求值"，
 * 既不误报（当成通过）也不漏报（当成没这回事）。
 */
export function unitMagnitude(unit: string): UnitMagnitude | null {
  const u = toHalfWidthDigits(String(unit ?? '')).replace(/\s+/g, '').trim();
  if (!u) return null;
  const family = unitFamily(u);
  if (!family) return null;
  if (family === 'yuan') {
    if (/亿/.test(u)) return { family, base: '元', factor: 100_000_000 };
    if (/万/.test(u)) return { family, base: '元', factor: 10_000 };
    return { family, base: '元', factor: 1 };
  }
  const baseOf: Record<string, string> = {
    percent: '%',
    workday: '个工作日',
    day: '天',
    month: '个月',
    year: '年',
    week: '周',
    times: '次',
    person: '人',
    piece: '份',
    page: '页',
    hour: '小时',
  };
  return { family, base: baseOf[family] ?? u, factor: 1 };
}

/** 把「数值 + 单位」折算到基准单位；单位认不出来 → null（未求值，不猜） */
export function toBaseAmount(num: number, unitRaw: string): { value: number; base: string; factor: number } | null {
  const mag = unitMagnitude(unitRaw);
  if (!mag) return null;
  return { value: num * mag.factor, base: mag.base, factor: mag.factor };
}

/* ============================================================================
 * 四、规则数据化（compliance_rule）
 * ==========================================================================*/

export type Severity = 'block' | 'warn' | 'info';

export interface ComplianceRule {
  id: number;
  code: string;
  name: string;
  severity: Severity;
  kind: string;
  checker: string | null;
  expr: string | null;
  params: Record<string, unknown>;
  message: string;
  fix_hint: string | null;
  enabled: boolean;
  /** 库里记的"检查逻辑实现了没有" */
  implemented: boolean;
  /** 引擎里真有这个 checker 函数吗（两者不一致会被报出来，见 engineWarnings） */
  hasChecker: boolean;
  sort_order: number;
  origin: string | null;
  scope_work_type_ids: number[] | null;
  scope_template_ids: number[] | null;
}

interface RuleRow {
  id: number;
  code: string;
  name: string;
  severity: string;
  kind: string;
  checker: string | null;
  expr: string | null;
  params: string | null;
  message: string;
  fix_hint: string | null;
  enabled: number;
  implemented: number;
  sort_order: number;
  origin: string | null;
  scope_work_type_ids: string | null;
  scope_template_ids: string | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRule(r: RuleRow): ComplianceRule {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    severity: (['block', 'warn', 'info'].includes(r.severity) ? r.severity : 'warn') as Severity,
    kind: r.kind,
    checker: r.checker,
    expr: r.expr,
    params: parseJson<Record<string, unknown>>(r.params, {}),
    message: r.message,
    fix_hint: r.fix_hint,
    enabled: r.enabled === 1,
    implemented: r.implemented === 1,
    hasChecker: Boolean(r.checker && r.checker in CHECKERS),
    sort_order: r.sort_order,
    origin: r.origin,
    scope_work_type_ids: parseJson<number[] | null>(r.scope_work_type_ids, null),
    scope_template_ids: parseJson<number[] | null>(r.scope_template_ids, null),
  };
}

export function listComplianceRules(): ComplianceRule[] {
  return all<RuleRow>('SELECT * FROM compliance_rule ORDER BY sort_order, id').map(toRule);
}

/**
 * 改一条规则（界面上改级别/开关，不改代码 —— docs/09 §4.6.6 验收⑤"规则数据化"）。
 * **拒绝启用没有实现的规则**：否则就是"启用了却永远不响"，正是 docs/11 风险③要防的静默失效。
 */
export function updateComplianceRule(code: string, patch: { enabled?: boolean; severity?: Severity }): ComplianceRule {
  const row = get<RuleRow>('SELECT * FROM compliance_rule WHERE code = ?', [code]);
  if (!row) throw new Error(`没有这条规则：${code}`);
  const rule = toRule(row);
  if (patch.severity !== undefined && !['block', 'warn', 'info'].includes(patch.severity)) {
    throw new Error(`severity 只能是 block / warn / info：${patch.severity}`);
  }
  if (patch.enabled === true && !rule.hasChecker) {
    throw new Error(`规则「${rule.code} ${rule.name}」的检查逻辑还没实现（checker=${rule.checker ?? '无'}），启用它只会变成"静默不响"。先实现检查逻辑再启用。`);
  }
  run(`UPDATE compliance_rule SET enabled = ?, severity = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`, [
    patch.enabled === undefined ? row.enabled : patch.enabled ? 1 : 0,
    patch.severity ?? row.severity,
    code,
  ]);
  return toRule(get<RuleRow>('SELECT * FROM compliance_rule WHERE code = ?', [code]) as RuleRow);
}

/* ============================ 严格度（设置项） ============================ */

export type Strictness = 'block' | 'warn';
export const SETTING_STRICTNESS = 'compliance.strictness';
export const STRICTNESS_MODES: readonly Strictness[] = ['block', 'warn'];

/**
 * 严格度：`block`（**默认**，按规则级别拦下保存）/ `warn`（全部只提示，不拦）。
 * 默认值取 docs/11 B3-9 的口径（block 规则不通过 → 拒绝保存），设置项登记在 core/config.ts。
 */
export function complianceStrictness(): Strictness {
  const raw = String(getSetting<string>(SETTING_STRICTNESS, 'block') ?? '').trim();
  return (STRICTNESS_MODES as readonly string[]).includes(raw) ? (raw as Strictness) : 'block';
}

export function setComplianceStrictness(v: Strictness): Strictness {
  if (!(STRICTNESS_MODES as readonly string[]).includes(v)) throw new Error(`严格度只能是 block / warn：${v}`);
  setSetting(SETTING_STRICTNESS, v, { type: 'string', scope: 'app', label: '口径校验严格度' });
  return v;
}

/* ============================================================================
 * 五、校验引擎
 * ==========================================================================*/

export interface ComplianceIssue {
  code: string;
  name: string;
  /** 规则级别（数据里的级别） */
  severity: Severity;
  /** 本次是否真的会拦下保存（严格度=warn 时一律 false，只提示） */
  enforced: boolean;
  message: string;
  where: CitationWhere;
  evidence: {
    documentTitle?: string | null;
    docNo?: string | null;
    clausePath?: string | null;
    quote?: string | null;
    actual?: string | null;
    expected?: string | null;
    /** 冲突的另一处出处 */
    alsoAt?: { documentTitle?: string | null; docNo?: string | null; clausePath?: string | null; quote?: string | null; actual?: string | null } | null;
  };
  fixHint: string;
  citation?: { raw: string; documentTitle: string | null; docNo: string | null; clausePath: string | null } | null;
}

export interface ComplianceUnevaluated {
  code: string;
  reason: string;
  where?: CitationWhere | null;
}

/**
 * 口径校验的**四态结论**（P1：旧实现只有"通过/不通过"两态，未求值与引擎出错都落进"通过"）。
 *
 *   · `passed`      —— 通过：至少一条引用真的核到了条款，且没有 block 级问题；
 *   · `failed`      —— 不通过：有条文依据对不上（block 级问题；是否拦下保存另看 `blocked`）；
 *   · `not_checked` —— **未检查（未求值）**：本轮压根没有可核对的依据
 *                      （文书里没有 `《…》第N条`、或所有引用都没入库/核不到）——
 *                      "没有依据可查"绝不能对外说成"引用全部核对成功"；
 *   · `check_error` —— **检查失败**：校验引擎自己没跑完（异常 / 已启用的规则没有检查函数）。
 *                      这一态的结论**不可信**，`strictness=block` 时默认按 block 处理（fail-closed），
 *                      见 {@link runCompliance} 的说明。
 */
export type ComplianceStatus = 'passed' | 'failed' | 'not_checked' | 'check_error';

export interface ComplianceResult {
  checkedAt: string;
  templateId: number | null;
  templateName: string | null;
  strictness: Strictness;
  /** 四态结论（界面必须按它显示，不能只看 blocked） */
  status: ComplianceStatus;
  /** 结论的人话（界面直接显示这一句，不要自己拼"通过"之类的词） */
  statusLabel: string;
  /** 默认口径下是否阻止保存 */
  blocked: boolean;
  /** 一句话结论（界面顶部用）—— 与 statusLabel 同源，措辞按四态区分 */
  summary: string;
  rules: { code: string; name: string; severity: Severity; enabled: boolean; hasChecker: boolean; implemented: boolean; origin: string | null }[];
  citations: ResolvedCitation[];
  issues: ComplianceIssue[];
  unevaluated: ComplianceUnevaluated[];
  /** 放行的例外（规则码 → 说明） */
  exceptions: { code: string; reason: string }[];
  /** 引擎自身的问题（规则标了已实现却没有检查函数等）—— 绝不静默 */
  engineWarnings: string[];
  counts: { citations: number; resolved: number; block: number; warn: number; info: number; unevaluated: number; checkErrors: number };
}

/** 四态的人话文案（**界面直接用它**，别再自己拼"通过/没问题"这类词） */
export const COMPLIANCE_STATUS_LABEL: Record<ComplianceStatus, string> = {
  passed: '通过',
  failed: '不通过',
  not_checked: '未检查（没有可核对的依据）',
  check_error: '检查失败（校验引擎没跑完，结论不可信）',
};

/**
 * 引擎整条挂掉时用的"检查失败"结论。
 *
 * 为什么要造一个完整的 `ComplianceResult`：旧实现的 `runComplianceSafe()` 在引擎抛错时
 * 返回 `null`，这个 null 一路变成"响应里没有 compliance 字段" —— 用户看到的就是"没报错 =
 * 通过"。现在即便引擎整条挂了，也返回一个 `status='check_error'` 的结论 + 一条 block 级问题
 * （`COMPLIANCE_CHECK_FAILED`，可被 `allowRuleViolations` 显式放行并留痕），
 * 于是接口、文案、留痕三条路都能区分"检查失败"和"通过"。
 */
export function complianceEngineFailure(message: string): ComplianceResult {
  const strictness = complianceStrictness();
  const status: ComplianceStatus = 'check_error';
  const label = COMPLIANCE_STATUS_LABEL[status];
  const issue: ComplianceIssue = {
    code: 'COMPLIANCE_CHECK_FAILED',
    name: '口径校验没能完成（检查失败）',
    severity: 'block',
    enforced: strictness === 'block',
    message: `口径校验没能跑完：${message}`,
    where: { kind: 'template' },
    evidence: { expected: '校验引擎正常运行' },
    fixHint:
      '先把校验引擎修好（看引擎告警/服务日志）；确实要带着这条例外出文书，请带 allowRuleViolations:[COMPLIANCE_CHECK_FAILED] 与 exceptionNote（例外说明，会留痕）。',
    citation: null,
  };
  return {
    checkedAt: new Date().toISOString(),
    templateId: null,
    templateName: null,
    strictness,
    status,
    statusLabel: label,
    blocked: strictness === 'block',
    summary: `口径校验${label}：${message} —— 这不等于"通过"，本次结果不能作为引用已核对的依据。`,
    rules: [],
    citations: [],
    issues: [issue],
    unevaluated: [],
    exceptions: [],
    engineWarnings: [message],
    counts: { citations: 0, resolved: 0, block: strictness === 'block' ? 1 : 0, warn: 0, info: 0, unevaluated: 0, checkErrors: 1 },
  };
}

export interface ComplianceInput {
  templateId: number | null;
  values: Record<string, unknown>;
  workbenchId?: number | null;
  positionCode?: string | null;
  /** 已经读过的模板正文（preview/save 钩子里复用，避免重复解包 docx） */
  templateText?: string | null;
  templateName?: string | null;
  /** 例外放行：这些规则码的问题不拦（docs/09 §4.6.4 的 allowRuleViolations） */
  allowRuleViolations?: string[] | null;
  /** 例外说明（放行必须写，会进 compliance_exception） */
  exceptionNote?: string | null;
  /** 只算不拦（界面上的「只看提示」用） */
  ignoreStrictness?: boolean;
}

/* ------------------------- 模板正文缓存 ------------------------- */

const templateTextCache = new Map<string, string>();

/**
 * 读模板正文（走 B3-8 的 core/extract.ts，同一套抽取口径），按 `路径+修改时间` 缓存。
 * 注：extractText 不认 xlsx（xlsx 模板的抽取是异步的另一条路），xlsx 模板里写的引用本轮扫不到 ——
 * 这会体现为"未求值"，不会误报（见 runCompliance 的 unevaluated）。
 */
export function loadTemplateText(templateId: number): { text: string; name: string | null } {
  const t = getTemplate(templateId);
  if (!t) return { text: '', name: null };
  let abs = '';
  try {
    abs = templateAbsPath(t);
  } catch {
    return { text: '', name: t.name ?? null };
  }
  if (!abs || !existsSync(abs)) return { text: '', name: t.name ?? null };
  let mtime = 0;
  try {
    mtime = statSync(abs).mtimeMs;
  } catch {
    mtime = 0;
  }
  const key = `${templateId}:${mtime}`;
  const cached = templateTextCache.get(key);
  if (cached !== undefined) return { text: cached, name: t.name ?? null };
  let text = '';
  try {
    text = extractText(abs).text ?? '';
  } catch {
    text = '';
  }
  if (templateTextCache.size > 40) templateTextCache.clear();
  templateTextCache.set(key, text);
  return { text, name: t.name ?? null };
}

/* ------------------------- 检查函数（checker） ------------------------- */

interface CheckCtx {
  citations: ResolvedCitation[];
  issues: ComplianceIssue[];
  unevaluated: ComplianceUnevaluated[];
  values: Record<string, unknown>;
  varLabels: Record<string, string>;
  enabled: Set<string>;
  severityOf: (code: string) => Severity;
  paramsOf: (code: string) => Record<string, unknown>;
}

/** 一处引用 → 位置描述 */
function whereText(w: CitationWhere): string {
  if (w.kind === 'variable') {
    const label = w.variableLabel && w.variableLabel !== w.variable ? `${w.variableLabel}（变量 ${w.variable}）` : `变量 ${w.variable}`;
    return `位置：${label} 的值里`;
  }
  return `位置：模板正文《${w.templateName ?? `#${w.templateId ?? '?'}`}》里`;
}

/** 一处引用的可读出处 */
function citeOf(r: ResolvedCitation): string {
  const d = r.hit?.title ?? r.candidates[0]?.title ?? r.documentName;
  const no = r.hit?.docNo ?? r.candidates[0]?.docNo ?? r.docNoText;
  const path = prettyPath(r.hit?.clausePath ?? null);
  return `《${d}》${no ? `（${no}）` : ''}${path ? ` ${path}` : ` ${r.clauseText}`}`;
}

function pushIssue(ctx: CheckCtx, code: string, cite: ResolvedCitation | null, message: string, evidence: ComplianceIssue['evidence'], fixHint: string, where?: CitationWhere): void {
  if (!ctx.enabled.has(code)) return;
  ctx.issues.push({
    code,
    name: RULE_NAMES[code] ?? code,
    severity: ctx.severityOf(code),
    enforced: false, // 由 runCompliance 按严格度统一填
    message,
    where: where ?? cite?.where ?? { kind: 'template' },
    evidence,
    fixHint,
    citation: cite
      ? { raw: cite.raw, documentTitle: cite.hit?.title ?? cite.candidates[0]?.title ?? null, docNo: cite.hit?.docNo ?? null, clausePath: cite.hit?.clausePath ?? null }
      : null,
  });
}

const RULE_NAMES: Record<string, string> = {
  CITE_CLAUSE_MISSING: '引用的条款在制度库里找不到',
  CITE_CLAUSE_SUPERSEDED: '引用的条款来自已被替换/未纳入的版本',
  CITE_CONFLICT: '同一事项引用了两个互相冲突的口径',
  CITE_VALUE_MISMATCH: '变量值与所引条款的关键数字/期限不一致',
  CITE_SOURCE_UNINDEXED: '引用的制度未入库，无法核对',
};

/** 引用的制度没入库 / 重名无法确定（warn：只提示，不拦 —— 大量真实文书会引用库外的上级文件） */
function checkUnindexed(ctx: CheckCtx): void {
  for (const c of ctx.citations) {
    if (c.status === 'document_missing') {
      pushIssue(
        ctx,
        'CITE_SOURCE_UNINDEXED',
        c,
        `${whereText(c.where)}引用了《${c.documentName}》${c.clauseText}，但这份制度没有入库，系统核对不了它的条号。${c.reason}`,
        { documentTitle: c.documentName, docNo: c.docNoText, clausePath: c.clauseText },
        '把这份制度导入知识库（来源目录或上传）并抽取；若确实引用的是库外文件，本条只是提示，不影响保存。',
      );
      continue;
    }
    if (c.status === 'ambiguous') {
      pushIssue(
        ctx,
        'CITE_SOURCE_UNINDEXED',
        c,
        `${whereText(c.where)}引用了《${c.documentName}》，但库里有 ${c.candidates.length} 份制度匹配这个名字，无法确定依据的是哪一份。${c.reason}`,
        {
          documentTitle: c.documentName,
          docNo: c.docNoText,
          expected: `在引用里带上发文字号（如《名称》（XX字〔2026〕1号）${c.clauseText}）；候选：${c.candidates.map((x) => `《${x.title}》${x.docNo ? `（${x.docNo}）` : ''}`).join('、')}`,
        },
        '在引用里补上发文字号；或把重名的制度改名区分。',
      );
    }
  }
}

/** 条号/款号找不到 → 引用悬空（block） */
function checkClauseMissing(ctx: CheckCtx): void {
  for (const c of ctx.citations) {
    if (c.status !== 'clause_missing') continue;
    const doc = c.candidates[0]?.title ?? c.documentName;
    const no = c.candidates[0]?.docNo;
    const avail = c.availableClauses.slice(0, 8);
    /**
     * 款/项号对不上（条号在、款号不在）要**单独说清**，并把"这一条下面现有的款/项号"列出来 ——
     * 否则用户只看到"找不到第五条第九款"，却不知道第五条第一款其实存在。
     */
    const subs = c.availableSubClauses.slice(0, 8);
    const isSubGap = c.subNo !== null && subs.length > 0;
    const what = isSubGap ? `${c.clauseText}的${subNoLabel(c.subNo)}` : c.clauseText;
    const listText = isSubGap
      ? `这一条下面现有：${subs.join('、')}${c.availableSubClauses.length > 8 ? ' 等' : ''}。`
      : avail.length
        ? `这份制度里现有：${avail.join('、')}${c.availableClauses.length > 8 ? ' 等' : ''}。`
        : '这份制度的片段里没有识别到条号（可能是通知类文件，或抽取时没切出条款路径）。';
    pushIssue(
      ctx,
      'CITE_CLAUSE_MISSING',
      c,
      `${whereText(c.where)}引用了《${doc}》${no ? `（${no}）` : ''}${what}，但这份制度里没有这一${isSubGap ? '款/项' : '条'} —— 引用是悬空的。` + listText,
      { documentTitle: doc, docNo: no ?? null, clausePath: isSubGap ? `${c.clauseText}（${subNoLabel(c.subNo)}）` : c.clauseText, expected: (isSubGap ? subs : avail).join('、') || null },
      isSubGap
        ? `核对该款/项号是否写错；这一条下面现有：${subs.join('、')}${c.availableSubClauses.length > 8 ? ' 等' : ''}。`
        : avail.length
          ? `核对条号是否写错；这份制度里现有：${avail.join('、')}${c.availableClauses.length > 8 ? ' 等' : ''}。`
          : '确认这份制度已按条款抽取（到「知识库」看它的条款路径），或改引一份已入库的制度。',
    );
  }
}

/** 引的是被替换/未纳入的版本（block） */
function checkSuperseded(ctx: CheckCtx): void {
  for (const c of ctx.citations) {
    if (c.status !== 'superseded') continue;
    pushIssue(
      ctx,
      'CITE_CLAUSE_SUPERSEDED',
      c,
      `${whereText(c.where)}引用了 ${citeOf(c)}，但这一份制度按当前抽取口径没有入库（结论 ${c.candidates[0]?.decision ?? '未知'} / 版本 ${c.candidates[0]?.versionStatus ?? '未知'}）—— 依据可能已经变了。${c.reason}`,
      { documentTitle: c.candidates[0]?.title ?? null, docNo: c.candidates[0]?.docNo ?? null, clausePath: c.clauseText, expected: '现行版 / 定稿版' },
      '换成现行版（或 0. 定稿件）的同一条款；必要时到「知识库」用当前口径重新抽取后再出文书。',
    );
  }
}

/** 同一事项两处不同数字 → 冲突（block） */
function checkCiteConflict(ctx: CheckCtx): void {
  if (!ctx.enabled.has('CITE_CONFLICT')) return;
  const groups = new Map<string, { cite: ResolvedCitation; qty: Quantity; base: number; baseUnit: string; factor: number }[]>();
  for (const c of ctx.citations) {
    if (c.status !== 'resolved' || !c.hit) continue;
    for (const q of extractQuantities(c.hit.content)) {
      if (!q.phrase || q.subject === 'other' || !q.unitFamily) continue;
      /**
       * 冲突判定同样要**先折算到基准单位**再比：`不得超过500万元` 与 `不得超过6000000元`
       * 在原数上比是 500 vs 6000000（必然"冲突"），折算后是 500 万 vs 600 万（也冲突，但理由真实）；
       * 而 `500万元` vs `5000000元` 折算后相等 → 不该报冲突（旧代码会误报）。
       * 量级认不出来的一律不参与判定（宁可不报，也不误报）。
       */
      const mag = unitMagnitude(q.unitRaw);
      if (!mag) continue;
      const key = `${q.subject}|${mag.family}|${q.phrase}`;
      const list = groups.get(key) ?? [];
      list.push({ cite: c, qty: q, base: q.value * mag.factor, baseUnit: mag.base, factor: mag.factor });
      groups.set(key, list);
    }
  }
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    const first = list[0] as { cite: ResolvedCitation; qty: Quantity; base: number; baseUnit: string; factor: number };
    // 冲突的定义：**不同制度的两处**给出不同数字（同一条里的"不超过/不少于"是正常的）
    const second = list.find((x, i) => i > 0 && x.base !== first.base && x.cite.documentName !== first.cite.documentName);
    if (!second) continue;
    const subjectText = first.qty.phrase;
    const enforcedBy = first.qty.direction === 'max' ? '不得超过' : '不得低于';
    const sameWhere = first.cite.where.kind === second.cite.where.kind && (first.cite.where.variable ?? '') === (second.cite.where.variable ?? '');
    const head = sameWhere
      ? `${whereText(first.cite.where)}同时引用了两份制度，`
      : `${whereText(first.cite.where)}与${whereText(second.cite.where)}分别引用了一份制度，`;
    const converted = first.factor !== 1 || second.factor !== 1 ? `（折算后 ${first.base}${first.baseUnit} vs ${second.base}${second.baseUnit}）` : '';
    pushIssue(
      ctx,
      'CITE_CONFLICT',
      first.cite,
      `${head}两处对同一事项「${subjectText}」给的口径不一样：` +
        `① ${citeOf(first.cite)} 写的是「${first.qty.raw}」；` +
        `② ${citeOf(second.cite)} 写的是「${second.qty.raw}」—— 一个是 ${first.qty.value}${first.qty.unitRaw}、一个是 ${second.qty.value}${second.qty.unitRaw}${converted}，` +
        `文书里两处都在，对方按条核对时必然有一处对不上。`,
      {
        documentTitle: first.cite.hit?.title ?? null,
        docNo: first.cite.hit?.docNo ?? null,
        clausePath: first.cite.hit?.clausePath ?? null,
        quote: first.cite.hit?.quote ?? null,
        actual: `${subjectText}：${enforcedBy} ${first.qty.value}${first.qty.unitRaw}`,
        expected: `${enforcedBy} ${second.qty.value}${second.qty.unitRaw}`,
        alsoAt: {
          documentTitle: second.cite.hit?.title ?? null,
          docNo: second.cite.hit?.docNo ?? null,
          clausePath: second.cite.hit?.clausePath ?? null,
          quote: second.cite.hit?.quote ?? null,
          actual: `${subjectText}：${enforcedBy} ${second.qty.value}${second.qty.unitRaw}`,
        },
      },
      '确认以哪一份为准（通常本单位细则 > 上级办法），把两处改成同一口径，或删掉其中一处引用。',
      first.cite.where,
    );
  }
}

/**
 * 变量值与所引条款的数字/期限不一致（block）。
 *
 * 比较前**先统一到基准单位**（金额 → 元；万元/亿元按 10000 / 100000000 折算），
 * 再用同一量级比大小。修掉的两个方向：
 *   · 误报：`500万元` vs `4000000元` —— 单位族都是 yuan 就直接比原数（500 vs 4000000）→
 *     现在折算成 5000000 vs 4000000 → 通过；
 *   · 漏报：`6,000,000元` 被读成 `6` + 单位 `,000` → 单位族对不上就 `continue` →
 *     现在千分位被吃掉，单位是「元」，折算后 6000000 → 该拦就拦。
 * 量级定不下来时（单位认不出来、两边单位族不同、值没写单位而条款是万元/亿元量级）
 * **记成"未求值"**，不再静默当成通过。
 */
function checkValueMismatch(ctx: CheckCtx): void {
  if (!ctx.enabled.has('CITE_VALUE_MISMATCH')) return;
  const tolerance = Number(ctx.paramsOf('CITE_VALUE_MISMATCH').tolerance ?? 0);
  const resolved = ctx.citations.filter((c) => c.status === 'resolved' && c.hit);
  let evaluated = 0;
  const ambiguous: string[] = [];
  const seeAmbiguous = (msg: string): void => {
    if (ambiguous.length < 5 && !ambiguous.includes(msg)) ambiguous.push(msg);
  };
  for (const [name, raw] of Object.entries(ctx.values)) {
    const value = raw === null || raw === undefined ? '' : String(raw);
    if (!value.trim()) continue;
    const num = numberInValue(value);
    if (!num) continue;
    const key = varPhrase(name);
    if (!key || key.length < 2) continue;
    for (const c of resolved) {
      const qty = extractQuantities(c.hit?.content ?? '').find((q) => q.phrase && q.unitFamily && sameThing(q.phrase, key));
      if (!qty) continue;
      const where = { kind: 'variable' as const, variable: name, variableLabel: ctx.varLabels[name] ?? null };
      const clauseMag = unitMagnitude(qty.unitRaw);
      const valueMag = num.unitRaw ? unitMagnitude(num.unitRaw) : null;
      // ① 条款单位认不出来：没有基准，无法比量级
      if (!clauseMag) {
        seeAmbiguous(`${whereText(where)}的「${qty.phrase}」条款单位「${qty.unitRaw}」无法归一化，本处未求值`);
        continue;
      }
      // ② 值带了单位但认不出来（`6,000,000,元` 之类）：也不猜
      if (num.unitRaw && !valueMag) {
        seeAmbiguous(`${whereText(where)}填的「${value}」里单位「${num.unitRaw}」认不出来，本处未求值`);
        continue;
      }
      // ③ 单位族不同（`2个月` vs `30日`）：不是"跳过"，而是明确记成未求值
      if (valueMag && valueMag.family !== clauseMag.family) {
        seeAmbiguous(
          `${whereText(where)}填的「${value}」（${valueMag.family}）与所引条款的「${qty.raw}」（${clauseMag.family}）不是同一类量，无法比较，本处未求值`,
        );
        continue;
      }
      // ④ 值没写单位：只有条款本身是基准量级（倍数 1）才敢按同单位比；万元/亿元量级下量级无法确定
      if (!num.unitRaw && clauseMag.factor !== 1) {
        seeAmbiguous(
          `${whereText(where)}填的「${value}」没写单位，而所引条款的单位是「${qty.unitRaw}」（${clauseMag.factor} 倍基准单位）—— 量级无法确定，本处未求值`,
        );
        continue;
      }
      const valueBase = num.num * (valueMag?.factor ?? 1);
      const clauseBase = qty.value * clauseMag.factor;
      const tolBase = tolerance * clauseMag.factor; // tolerance 按**条款原始单位**计（条款是万元，tolerance=1 就是 1 万元）
      evaluated += 1;
      const violates = qty.direction === 'max' ? valueBase > clauseBase + tolBase : valueBase < clauseBase - tolBase;
      if (!violates) continue;
      // 折算过的（量级不同）在文案里把折算过程写出来，免得人对着两个数看不懂为什么判它超限
      const converted =
        (valueMag?.factor ?? 1) !== clauseMag.factor || clauseMag.factor !== 1
          ? `（折算后：填的 ${valueBase}${clauseMag.base} vs 条款 ${clauseBase}${clauseMag.base}）`
          : '';
      pushIssue(
        ctx,
        'CITE_VALUE_MISMATCH',
        c,
        `${whereText(where)}填的是「${value}」，` +
          `而文书引用的 ${citeOf(c)} 规定「${qty.raw}」（原文：${qty.sentence}）—— ` +
          `按条款应当 ${qty.direction === 'max' ? '不超过' : '不低于'} ${qty.value}${qty.unitRaw}` +
          `${converted ? `${converted}` : ''}，实际填的是 ${num.num}${num.unitRaw || qty.unitRaw}。`,
        {
          documentTitle: c.hit?.title ?? null,
          docNo: c.hit?.docNo ?? null,
          clausePath: c.hit?.clausePath ?? null,
          quote: c.hit?.quote ?? null,
          actual: `${value}（${qty.phrase}）`,
          expected: `${qty.direction === 'max' ? '≤' : '≥'} ${qty.value}${qty.unitRaw}（折算 ${qty.direction === 'max' ? '≤' : '≥'} ${clauseBase}${clauseMag.base}）`,
        },
        '按所引条款改正文里的数字；若条款本身引错了，改引用。',
        where,
      );
    }
  }
  for (const msg of ambiguous) ctx.unevaluated.push({ code: 'CITE_VALUE_MISMATCH', reason: msg });
  if (!evaluated) {
    ctx.unevaluated.push({
      code: 'CITE_VALUE_MISMATCH',
      reason: resolved.length
        ? '已核对到的条款里没有与变量名同指一件事、且量级可折算的关键数字/期限，本规则本轮未求值（既不算通过、也不算不通过）'
        : '没有任何可核对到条款的引用，本规则本轮未求值',
    });
  }
}

const CHECKERS: Record<string, (ctx: CheckCtx) => void> = {
  cite_source_unindexed: checkUnindexed,
  cite_clause_missing: checkClauseMissing,
  cite_clause_superseded: checkSuperseded,
  cite_conflict: checkCiteConflict,
  cite_value_mismatch: checkValueMismatch,
};

/* ------------------------- 主入口 ------------------------- */

/** 收集"要扫的文本"：模板正文 + 每个变量的值 */
export function collectCitationTexts(input: {
  templateId: number | null;
  values: Record<string, unknown>;
  templateText?: string | null;
  templateName?: string | null;
  varLabels?: Record<string, string>;
}): { text: string; where: CitationWhere }[] {
  const out: { text: string; where: CitationWhere }[] = [];
  let templateText = input.templateText ?? null;
  let templateName = input.templateName ?? null;
  if (templateText === null && input.templateId) {
    const r = loadTemplateText(input.templateId);
    templateText = r.text;
    templateName = templateName ?? r.name;
  }
  if (templateText && input.templateId) {
    out.push({ text: templateText, where: { kind: 'template', templateId: input.templateId, templateName } });
  }
  for (const [name, raw] of Object.entries(input.values ?? {})) {
    const v = raw === null || raw === undefined ? '' : String(raw);
    if (!v.includes('《')) continue; // 绝大多数变量值与引用无关，先按最便宜的条件过滤
    out.push({ text: v, where: { kind: 'variable', variable: name, variableLabel: input.varLabels?.[name] ?? null, templateId: input.templateId, templateName } });
  }
  return out;
}

/** 跑一次口径校验。**不写库**（例外留痕由调用方在放行那一刻写） */
export function runCompliance(input: ComplianceInput): ComplianceResult {
  const rules = listComplianceRules();
  const engineWarnings: string[] = [];
  for (const r of rules) {
    if (r.enabled && !r.hasChecker) {
      engineWarnings.push(`规则 ${r.code}「${r.name}」已启用，但引擎里没有对应的检查函数（checker=${r.checker ?? '无'}）—— 它本轮不会响。`);
    } else if (r.enabled && !r.implemented) {
      engineWarnings.push(`规则 ${r.code}「${r.name}」在库里标为未实现却被启用 —— 已跳过（启用未实现的规则是"静默不响"的典型）。`);
    }
  }
  const usable = rules.filter((r) => r.enabled && r.hasChecker && r.implemented);
  const enabled = new Set(usable.map((r) => r.code));
  const severityOf = (code: string): Severity => rules.find((r) => r.code === code)?.severity ?? 'warn';
  const paramsOf = (code: string): Record<string, unknown> => rules.find((r) => r.code === code)?.params ?? {};

  const strictness = complianceStrictness();
  const allow = new Set((input.allowRuleViolations ?? []).map((s) => String(s)));

  // 变量标签（给"位置"用；读不到就算了，绝不因为读标签失败而拦下文书）
  const varLabels: Record<string, string> = {};
  if (input.templateId) {
    try {
      const t = getTemplate(input.templateId);
      if (t) for (const v of readTemplateVars(t).variables) if (v.label) varLabels[v.name] = v.label;
    } catch {
      /* 忽略 */
    }
  }

  const sources = collectCitationTexts({
    templateId: input.templateId,
    values: input.values ?? {},
    templateText: input.templateText,
    templateName: input.templateName,
    varLabels,
  });

  // 解析：同一处写法只解析一次，位置全部保留。
  //
  // 【缓存键必须含 文号 + 完整条款路径】修掉的 P1：旧键是 `${制度名}|${clauseText}` ——
  // 「《X》第五条」与「《X》第五条第九款」的 clauseText 都是「第五条」（款号在 subNo 上），
  // 于是两处引用命中同一个缓存条目，其中一处的核对结果被另一处顶掉（悬空引用被判成已核对）。
  const parsed = sources.flatMap((s) => parseCitations(s.text, s.where));
  const cache = new Map<string, ResolvedCitation>();
  const citations: ResolvedCitation[] = parsed.map((p) => {
    const key = citationCacheKey(p);
    let r = cache.get(key);
    if (!r) {
      r = resolveCitation(p);
      cache.set(key, r);
    }
    return { ...r, raw: p.raw, where: p.where, subNo: p.subNo ?? r.subNo, pathSegments: p.pathSegments };
  });

  const ctx: CheckCtx = { citations, issues: [], unevaluated: [], values: input.values ?? {}, varLabels, enabled, severityOf, paramsOf };
  /**
   * 每个 checker **单独包一层 catch**：旧实现把整轮循环套在一个 try 里，
   * 一条规则抛错会让后面所有规则**静默不响**（看起来就像"没发现问题"）。
   * 现在单条失败只记成"检查失败"，其余规则照常跑完。
   */
  const checkErrors: string[] = [];
  for (const rule of usable) {
    const fn = rule.checker ? CHECKERS[rule.checker] : undefined;
    if (!fn) continue;
    try {
      fn(ctx);
    } catch (e) {
      checkErrors.push(`规则 ${rule.code}「${rule.name}」的检查函数抛错：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!parsed.length) {
    ctx.unevaluated.push({ code: '*', reason: '模板正文与变量值里没有《…》第N条 形式的条款引用，本轮没有任何口径依据可核对' });
  }
  // 引擎层面的"检查失败"：规则该响却没响（标了实现却没有函数）+ 单条 checker 抛错
  for (const w of engineWarnings) checkErrors.push(w);

  // 同一位置 + 同一规则 + 同一依据只报一次
  const uniq = new Map<string, ComplianceIssue>();
  for (const i of ctx.issues) {
    const key = `${i.code}|${i.where.kind}|${i.where.variable ?? ''}|${i.evidence.clausePath ?? ''}|${i.message}`;
    if (!uniq.has(key)) uniq.set(key, i);
  }
  const ignore = input.ignoreStrictness === true;
  const issues = [...uniq.values()].map((i) => ({ ...i, enforced: !ignore && strictness === 'block' && i.severity === 'block' && !allow.has(i.code) }));
  const warnN = issues.filter((i) => i.severity === 'warn').length;
  const infoN = issues.filter((i) => i.severity === 'info').length;
  const note = String(input.exceptionNote ?? '').trim();
  const resolvedN = citations.filter((c) => c.status === 'resolved').length;

  /**
   * 四态判定（顺序即优先级）：
   *   ① 引擎没跑完 → `check_error`（结论不可信）；
   *   ② 有 block 级问题 → `failed`；
   *   ③ **一条引用都没真正核到**（没有引用，或全都核不到）→ `not_checked`：
   *      "没有依据可查"绝不能说成"引用全部核对成功"；
   *   ④ 其余 → `passed`（至少一条核到了条款，且没有 block 级问题；warn/info 与未求值照旧分别列出）。
   *
   * **检查失败默认 fail-closed**（`strictness=block` 时把 check_error 变成一条 block 级问题
   * `COMPLIANCE_CHECK_FAILED`）：口径校验是出文书前的最后一道闸门，引擎自己坏了就等于这批文书的
   * 引用**没有被核对过**，不能悄悄放行成"通过"。要带着这条例外出文书有两条显式路径：
   * 带 `allowRuleViolations:['COMPLIANCE_CHECK_FAILED']` + `exceptionNote`（会留痕），
   * 或把严格度调成 `warn`（用户显式选择的"只提示"）。
   */
  const status: ComplianceStatus = checkErrors.length ? 'check_error' : issues.some((i) => i.severity === 'block') ? 'failed' : resolvedN === 0 ? 'not_checked' : 'passed';
  const statusLabel = COMPLIANCE_STATUS_LABEL[status];
  const hasBlockIssue = issues.some((i) => i.severity === 'block');
  if (status === 'check_error') {
    issues.unshift({
      code: 'COMPLIANCE_CHECK_FAILED',
      name: '口径校验没能完成（检查失败）',
      severity: 'block',
      enforced: !ignore && strictness === 'block' && !allow.has('COMPLIANCE_CHECK_FAILED'),
      message: `口径校验没跑完：${checkErrors.join('；')} —— 这不等于"通过"，引用是否核对过无法确定。`,
      where: { kind: 'template' },
      evidence: { expected: '校验引擎完整跑完（每条已启用的规则都要响）' },
      fixHint:
        '先修校验引擎（看引擎告警与服务日志）；确实要带这条例外出文书，请带 allowRuleViolations:[COMPLIANCE_CHECK_FAILED] 与 exceptionNote（例外说明，会留痕）。',
      citation: null,
    });
  }
  const blocked = issues.some((i) => i.enforced);
  const blockN = issues.filter((i) => i.enforced).length;
  const unevaluatedNote = ctx.unevaluated.length ? `；另有 ${ctx.unevaluated.length} 项未求值（没有可比对的依据，既不算通过也不算不通过）` : '';
  const summary =
    status === 'check_error'
      ? `口径校验${statusLabel}：${checkErrors.join('；')} —— 这不等于"通过"。${blocked ? '已阻止保存' : '本次未阻止保存（严格度=仅提示或已放行）'}。`
      : status === 'failed'
        ? `口径校验${statusLabel}：${issues.filter((i) => i.severity === 'block').length} 项必须改（共 ${issues.length} 项问题）${blocked ? '，已阻止保存' : '（当前严格度=仅提示，未阻止保存）'}${unevaluatedNote}`
        : status === 'not_checked'
          ? `口径校验${statusLabel}：${
              parsed.length ? `${parsed.length} 处引用一条都没能核对到条款（未入库/条号款号核不到/引擎跳过），所以没有"通过"这个结论。` : '文书里没有《…》第N条 形式的条款引用，没有可核对的依据。'
            }${issues.length ? `另有 ${issues.length} 项提示。` : ''}${unevaluatedNote}`
          : `口径校验${statusLabel}：${resolvedN} 处引用核对到条款，没有发现冲突口径。${issues.length ? `另有 ${issues.length} 项提示（不阻止保存）。` : ''}${unevaluatedNote}`;

  return {
    checkedAt: new Date().toISOString(),
    templateId: input.templateId,
    templateName: input.templateId ? (getTemplate(input.templateId)?.name ?? null) : null,
    strictness,
    status,
    statusLabel,
    blocked,
    summary,
    rules: rules.map((r) => ({ code: r.code, name: r.name, severity: r.severity, enabled: r.enabled, hasChecker: r.hasChecker, implemented: r.implemented, origin: r.origin })),
    citations,
    issues,
    unevaluated: ctx.unevaluated,
    exceptions: issues.filter((i) => allow.has(i.code)).map((i) => ({ code: i.code, reason: note || '（未填说明）' })),
    engineWarnings: [...engineWarnings, ...checkErrors.filter((e) => !engineWarnings.includes(e))],
    counts: {
      citations: parsed.length,
      resolved: resolvedN,
      block: blockN,
      warn: warnN,
      info: infoN,
      unevaluated: ctx.unevaluated.length,
      checkErrors: checkErrors.length,
    },
  };
}

/**
 * 引用缓存的键：**文号 + 完整条款路径（含款/项号）**。
 * 少一样都会串味：少了文号 → 重名制度互相顶；少了款/项号 → `第五条` 与 `第五条第九款` 共用一条缓存。
 */
export function citationCacheKey(c: Pick<Citation, 'documentName' | 'docNoText' | 'clauseText' | 'subNo' | 'pathSegments'>): string {
  const segs = (c.pathSegments ?? []).map(normSeg).filter(Boolean).join('/');
  return `${normSeg(c.documentName)}|${normSeg(c.docNoText ?? '')}|${normSeg(c.clauseText)}|${c.subNo ?? ''}|${segs}`;
}

/* ============================================================================
 * 六、例外放行留痕（compliance_exception）
 * ==========================================================================*/

export interface ComplianceExceptionInput {
  ruleCode: string;
  reason: string;
  artifactId?: number | null;
  templateId?: number | null;
  workbenchId?: number | null;
  clausePath?: string | null;
  severity?: string | null;
  actor?: string | null;
}

export function recordComplianceException(input: ComplianceExceptionInput): number {
  const reason = String(input.reason ?? '').trim();
  if (!reason) throw new Error('例外放行必须写说明（为什么可以例外）');
  const r = run(
    `INSERT INTO compliance_exception (rule_code, artifact_id, template_id, workbench_id, clause_path, severity, reason, actor)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      input.ruleCode,
      input.artifactId ?? null,
      input.templateId ?? null,
      input.workbenchId ?? null,
      input.clausePath ?? null,
      input.severity ?? null,
      reason,
      input.actor ?? null,
    ],
  );
  return r.lastInsertRowid;
}

/** 保存成功后把落盘的文书 id 补到例外记录上（保存那一刻还没有 artifact id） */
export function attachExceptionArtifact(exceptionId: number, artifactId: number): void {
  run('UPDATE compliance_exception SET artifact_id = ? WHERE id = ?', [artifactId, exceptionId]);
}

export interface ComplianceExceptionRow {
  id: number;
  rule_code: string;
  artifact_id: number | null;
  artifact_title: string | null;
  workbench_id: number | null;
  template_id: number | null;
  clause_path: string | null;
  severity: string | null;
  reason: string;
  actor: string | null;
  created_at: string;
}

export function listComplianceExceptions(filter: { artifactId?: number | null; code?: string | null; limit?: number } = {}): ComplianceExceptionRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.artifactId) {
    where.push('e.artifact_id = ?');
    params.push(filter.artifactId);
  }
  if (filter.code) {
    where.push('e.rule_code = ?');
    params.push(filter.code);
  }
  params.push(Math.max(1, Math.min(filter.limit ?? 100, 500)));
  return all<ComplianceExceptionRow>(
    `SELECT e.id, e.rule_code, e.artifact_id, a.title AS artifact_title, e.workbench_id, e.template_id,
            e.clause_path, e.severity, e.reason, e.actor, e.created_at
       FROM compliance_exception e
       LEFT JOIN artifact a ON a.id = e.artifact_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.id DESC LIMIT ?`,
    params,
  );
}
