/**
 * B3-8 知识库内容抽取与向量化
 *
 * 从「只统计元数据」（012 的框架）走到「真抽内容」：遍历来源目录 → 判定制度/版本/分区 →
 * 按去重口径算清「哪一份留下、哪些是副本」→ 抽文本 → 按章节/条款路径切块 → FTS5 → 向量化。
 *
 * 六条硬边界（都写在这里，改动前先看一遍）：
 *
 * 1. **绝不写用户目录**。全程只有 `readdir` / `stat` / `read`。不建目录、不写文件、
 *    不改名、不移动、不删除（契约 §11、§12.6）。中间产物（xlsx 解析用的临时文件）落在
 *    自己 `data/runtime/kb-tmp` 下，读完立刻删。
 * 2. **只读登记，不复制**。文件留在原地，库里只记 `kb_source.path + rel_path`。
 * 3. **可中断可续跑**。单文件失败只记一条 `kb_extract_item`（result='fail' + 原因），
 *    整批继续；`AbortSignal` 可随时停，已入库的成果保留，下次重跑按文件哈希跳过。
 * 4. **幂等**。`kb_document` 的稳定键是 `(source_id, rel_path)`（019 的唯一索引），
 *    同口径重跑 = 原地 UPDATE + 内容哈希未变就跳过切块/向量化 → **新增 0 行**。
 *    换口径重跑 = 同一个文件还是那一行（更新 decision/分区/版本），不会长出第二条。
 * 5. **不阻塞事件循环**。批量读文件（`readFile` 异步 + 固定并发），每批之间 `setImmediate`
 *    让出控制权；不出现同步读大文件。
 * 6. **失败要响**。抽不到文字、坏文件、向量化失败都进 `kb_extract_item`，
 *    接口能按 `result='fail'` 列出来（含原因），不静默。
 * 7. **收尾绝不删库**。换口径后不再该入库的文档只**标记失效**（`decision='stale'`，正文、片段、
 *    向量全部原地保留），而且必须"本次扫描完整"才允许判定失效；扫描不完整（截断 / readdir
 *    失败 / maxFiles 截断 / 有读不到的项）一律**中止标记**并把原因写进任务结果。
 *    物理删除只走用户显式确认的那一条路（`purgeStaleKbDocuments`）。
 *    （旧写法是 `全部文档 - 本次 keep` 直接物理删除三张表：`readdir` 一次抖动 →
 *    `walk.files=[]` → keep 为空 → 整个来源的知识库连同已付费向量被删空。已修。）
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { all, get, run, tx } from '../db/index.ts';
import { RUNTIME_ROOT, getSetting } from './config.ts';
import { extractAnyFromBuffer, extractDocxHead } from './extract.ts';
import { isIgnoredName } from './ignore.ts';
import { toPosix } from './paths.ts';
import { visibleKbDocumentFilter } from './trash.ts';
import {
  chunkTextWithClauses,
  indexDocumentChunksFs,
  KB_DECISION_STALE,
  kbChunkSignature,
  markKbDocumentsStale,
  restoreKbDocumentActive,
  stripClauseNoise,
  type ClausePathPair,
} from './kb.ts';
import { isOcrCandidate, ocrEnabled, ocrFile, summarizeOcrError } from './ocr.ts';

/* ============================== 口径（三个设置项） ============================== */

export type DedupMode = 'prefer_docx' | 'all' | 'by_name' | 'by_hash';
export type ScopeMode = 'mark' | 'exclude' | 'plain';
export type VersionMode = 'final_only' | 'all' | 'latest_only';
export type ScopeLayer = 'unit' | 'regulation' | 'reference';
export type VersionStatus = 'final' | 'current' | 'superseded';
/** 抽取结论：only 'extract' 会写 kb_document；其余都是「按口径不入库」 */
export type Decision = 'extract' | 'dedup' | 'scope' | 'version' | 'kind';

export const DEDUP_MODES: readonly DedupMode[] = ['prefer_docx', 'all', 'by_name', 'by_hash'];
export const SCOPE_MODES: readonly ScopeMode[] = ['mark', 'exclude', 'plain'];
export const VERSION_MODES: readonly VersionMode[] = ['final_only', 'all', 'latest_only'];

export const SETTING_DEDUP = 'kb.dedup';
export const SETTING_SCOPE = 'kb.scope';
export const SETTING_VERSION = 'kb.version';

export interface ExtractSettings {
  dedup: DedupMode;
  scope: ScopeMode;
  version: VersionMode;
}

function pick<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = getSetting<string>(key, fallback);
  const v = String(raw ?? '').trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * 读三个口径设置。**默认值就是设置项里的默认值**，这里再兜一层：
 * 用户把值改成了不认识的字符串（手改数据库、旧版本残留）时回退到默认，
 * 而不是让整批抽取抛错 —— 但回退这件事会写进 job.settings_json，事后能查。
 */
export function loadExtractSettings(): ExtractSettings {
  return {
    dedup: pick<DedupMode>(SETTING_DEDUP, DEDUP_MODES, 'prefer_docx'),
    scope: pick<ScopeMode>(SETTING_SCOPE, SCOPE_MODES, 'mark'),
    version: pick<VersionMode>(SETTING_VERSION, VERSION_MODES, 'final_only'),
  };
}

/* ============================== 分类（纯函数，单测直接打） ============================== */

/** 制度类关键词：命中了才认为这份文件「本身是制度文本」 */
const DOC_KEYWORDS = /制度|办法|规定|规程|细则|条例|规范|标准|预案|职责|准则|守则|管理体系|操作规程/;
/** 印发/载体信号：文件本身可能是「关于印发 X 的通知」，正文里带着制度本体 */
const ISSUE_KEYWORDS = /印发|发布|实施方案|三年行动|任务安排|负面清单/;
/** 流程件关键词：议题表/请示/汇报/征求意见 这类是过程件，不是制度本体 */
const PROCESS_KEYWORDS = /议题表|审查建议|汇报|请示|征求意见|发函|纪要|目录|列表|明细|通报|总结|计划|方案|附件|转发|审批表|签到表|记录表/;
/** 废弃自述：文件名自己说「旧版/作废」，直接不入库（识别预览的 R3c） */
const DEPRECATED_KEYWORDS = /废弃|作废|无效|失效|旧版|历史版本|不适用|已删除/;
/** 定稿前缀：`0.` 起头的文件是用户自己的定稿标记（docs/15 §三 的建议口径） */
const FINAL_PREFIX = /(^|[\\/])0[.\-、]/;
/** 历史/过程稿信号 */
const SUPERSEDED_KEYWORDS = /上会|制作中|准备文件|汇报格式|补盖章|征求意见|讨论稿|修改稿|修订稿|（改）|\(改\)|历史|旧稿|草稿|试行稿/;
/** 外部法规/标准信号（目录或文件名） */
const REGULATION_KEYWORDS = /法规|法律|条例|国家标准|行业标准|标准文本|规范标准|部委|国务院|人大|司法|应急管理部|住建部|标准库/;
/** 参考制度信号（他单位发文） */
const REFERENCE_KEYWORDS = /参考制度|他人印发|兄弟单位|外单位|参考文本/;
/** 文号：示例科技有限公司安〔2026〕12号 / 示例安〔2026〕12号 */
const DOC_NO_RE = /[\u4e00-\u9fa5A-Za-z]{0,12}[〔\[【（(]\s*(\d{4})\s*[〕\]】）)]\s*\d{1,4}\s*号/;
/** 《…》里的制度名 */
const TITLE_RE = /《([^》]{2,60})》/;

export function extOf(fileName: string): string {
  const m = /\.[^.\\/]+$/.exec(fileName);
  return m ? m[0].toLowerCase() : '';
}

/** 逐段跑匹配：路径分段 + 文件名，谁命中算谁（`0.` 这类前缀只在**分段开头**有意义） */
function haystack(relPath: string, fileName: string): string {
  return `${relPath.replace(/\\/g, '/')} ${fileName}`;
}

/** 目录/文件名里以 `0.` 开头的分段 = 用户标了「定稿」 */
export function hasFinalPrefix(relPath: string, fileName: string): boolean {
  const segs = relPath.replace(/\\/g, '/').split('/');
  if (FINAL_PREFIX.test(fileName) || segs.some((s) => FINAL_PREFIX.test(s))) return true;
  // 「已印发」目录 = 正式印发那一版，同样算定稿（识别预览的 B1/F1 组就是这一类）
  return /已印发/.test(haystack(relPath, fileName)) && !/上会|制作中/.test(haystack(relPath, fileName));
}

export function classifyVersion(relPath: string, fileName: string): VersionStatus {
  if (hasFinalPrefix(relPath, fileName)) return 'final';
  if (SUPERSEDED_KEYWORDS.test(haystack(relPath, fileName))) return 'superseded';
  return 'current';
}

export function classifyLayer(relPath: string, fileName: string): ScopeLayer {
  const s = haystack(relPath, fileName);
  if (REGULATION_KEYWORDS.test(s)) return 'regulation';
  if (REFERENCE_KEYWORDS.test(s)) return 'reference';
  return 'unit';
}

/**
 * 这份文件「本身是不是制度文本」。
 *
 * 判据与 docs/制度识别预览.md 的 R3/R3b 同口径，但更保守：
 *   · 文件名/路径命中制度关键词 → 是（`关于印发 X 的通知` 也算，正文通常随文附上）；
 *   · 只命中流程词（议题表/请示/记录表…）→ 不是；
 *   · 自述废弃（旧版/作废…）→ 不是；
 *   · 其它（扫描件、没起好名字的）→ 先当「不是」，正文抽出来后再由
 *     {@link looksInstitutionalText} 用正文兜一次 —— 只靠文件名会把扫描件全判死。
 */
export function looksInstitutionalByMeta(relPath: string, fileName: string): boolean {
  const s = haystack(relPath, fileName);
  // 自述废弃（旧版/作废/无效）：文件名自己说了不算数，先排掉（识别预览的 R3c）
  if (DEPRECATED_KEYWORDS.test(s)) return false;
  // 流程件**优先于**制度关键词判定：`关于开展X大检查的通知` 里「通知」和「制度」都不在，
  // 但 `关于印发《X制度》的通知` 两者都在 —— 后者是制度本体随文附上，必须留；
  // 前者只是过程件。所以顺序是：废弃 → 纯流程件 → 制度关键词。
  const processOnly = PROCESS_KEYWORDS.test(s) && !DOC_KEYWORDS.test(s);
  if (processOnly) return false;
  if (DOC_KEYWORDS.test(s) || ISSUE_KEYWORDS.test(s)) return true;
  /**
   * 文件名里一个字都没提制度，但这个扩展名**只可能是文档正文**（不是表格/清单/记录）：
   * 先放它过去，由正文兜底判定（{@link looksInstitutionalText}）把非制度的筛掉。
   *
   * 为什么不能在这里直接返回 false（实测踩过）：一份扫描件、或者一份叫「安全检查」的
   * 制度文本，文件名里可能压根没有「制度/办法/规定」字样，但它们是真语料。
   * 只看文件名就会把它们整批漏掉 —— 而这一步的代价只是"多读一次抬头/正文"。
   * 反过来 `.txt/.csv/.xlsx` 这些更像清单/导出件，仍然按「不像制度」处理。
   */
  const ext = extOf(fileName);
  return ext === '.docx' || ext === '.doc' || ext === '.pdf' || ext === '.pptx';
}

/** 正文兜底：正文里出现足够多制度结构词，就认它是制度文本 */
export function looksInstitutionalText(text: string): boolean {
  const head = text.slice(0, 4000);
  if (DOC_KEYWORDS.test(head) === false && TITLE_RE.test(head) === false) return false;
  const hits = (head.match(/第[一二三四五六七八九十百零\d]+[条章节]|本办法|本制度|本规定|本细则|特制定|适用于/g) ?? []).length;
  return hits >= 2;
}

/** 文号：先看抬头/页眉（最准），再看文件名 */
export function findDocNo(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const m = DOC_NO_RE.exec(c.replace(/\s+/g, ' '));
    if (m) return m[0].replace(/\s+/g, '');
  }
  return null;
}

/** 制度名：文件名里《…》优先，其次去掉扩展名与「关于印发…的通知」外壳 */
export function guessTitle(relPath: string, fileName: string, headText?: string | null): string {
  const noExt = fileName.replace(/\.[^.]+$/, '');
  for (const src of [noExt, headText ?? '']) {
    const m = TITLE_RE.exec(src);
    if (m?.[1]) return m[1].trim();
  }
  const stripped = noExt
    .replace(/^0[.\-、]\s*/, '')
    .replace(/^关于印发/, '')
    .replace(/的通知$/, '')
    .trim();
  if (stripped) return stripped;
  return toPosix(relPath).replace(/\.[^.]+$/, '');
}

/** 归一化文本哈希：去掉空白、页眉页脚噪声与常见编号，用来判「内容是不是同一份」 */
export function normalizeForHash(text: string): string {
  return stripClauseNoise(text)
    .replace(/\s+/g, '')
    .replace(/[\u3000\u00a0]/g, '')
    .replace(/-?\d{1,3}-/g, '') // 页码
    .slice(0, 200_000);
}

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/* ============================== 遍历来源目录 ============================== */

export interface WalkedFile {
  relPath: string;
  absPath: string;
  fileName: string;
  size: number;
  mtimeMs: number;
}

export interface WalkResult {
  files: WalkedFile[];
  dirs: number;
  /** 读不到的目录项（stat 失败：权限 / 链接失效 / 云端占位） */
  skippedEntries: number;
  /**
   * `readdir` 失败的目录数（网络盘掉线、ACL 抖动、目录被删）。
   * **这个数 >0 时必须当真**：一个目录读不到 = 它下面的文件这次一个都没扫到，
   * 而"没扫到"绝不能被当成"应该失效/删除"（缺陷：一次 readdir 抖动会清空整个来源的知识库）。
   */
  readdirErrors: number;
  truncated: boolean;
}

export const WALK_MAX_ITEMS = 20_000;
export const WALK_MAX_MS = 60_000;

/**
 * 遍历来源根目录。**只 readdir + stat**，不 open/read（iCloud 占位不触发下载）。
 *
 * 沿用契约 §12.5：`.`/`_` 开头目录与 `scan.ignore` 名单里的名字一律不看。
 * 用显式栈而不是递归：用户目录嵌套很深，20000 项的栈比调用栈好控。
 * 上限（项数 / 时间）先到先停，并把 `truncated` 如实带出去。
 */
export async function walkSource(rootAbs: string, opts: { maxItems?: number; maxMs?: number } = {}): Promise<WalkResult> {
  const maxItems = opts.maxItems ?? WALK_MAX_ITEMS;
  const maxMs = opts.maxMs ?? WALK_MAX_MS;
  const started = Date.now();
  const files: WalkedFile[] = [];
  let dirs = 0;
  let skippedEntries = 0;
  let readdirErrors = 0;
  let truncated = false;
  const stack: string[] = [rootAbs];

  while (stack.length) {
    if (files.length + dirs >= maxItems || Date.now() - started > maxMs) {
      truncated = true;
      break;
    }
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // 目录读不到：计数（**不是**简单的跳过 —— 它会让本次遍历不完整，判定失效时必须据此中止）
      readdirErrors += 1;
      skippedEntries += 1;
      continue;
    }
    for (const name of names) {
      if (isIgnoredName(name)) continue; // 明确不看：不计入 skipped
      if (files.length + dirs >= maxItems || Date.now() - started > maxMs) {
        truncated = true;
        break;
      }
      const abs = join(dir, name);
      let st;
      try {
        st = await stat(abs);
      } catch {
        skippedEntries += 1; // 读不到的项（权限 / 链接失效 / 云端占位）：跳过并计数
        continue;
      }
      if (st.isDirectory()) {
        dirs += 1;
        stack.push(abs);
        continue;
      }
      files.push({
        relPath: toPosix(relative(rootAbs, abs)),
        absPath: abs,
        fileName: name,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, dirs, skippedEntries, readdirErrors, truncated };
}

/* ============================== 扫描完整性 / 失效判定 ============================== */

/**
 * 本次扫描到底"完整不完整"。**这是"标记失效"的唯一闸门**。
 *
 * 背景（本次修的 P1）：旧代码用「本次计划里 decision==='extract' 的路径」当 `keep`，
 * 用「该来源下全部 kb_document 减 keep」当 stale，然后**物理删除**（三张表 + 向量）。
 * 于是：readdir 瞬时失败 / maxFiles 截断 / 遍历截断 / 部分项读不到 —— 任何一种都会让
 * keep 变空或变小，直接把已有知识库（含已付费向量）删光。
 * "本次没扫到"绝不等于"应该删除/失效"，所以这里先把完整性算清楚。
 */
export interface ScanCompleteness {
  /** 遍历触到项数/时间上限，只走了一部分 */
  truncated: boolean;
  /** readdir 失败的目录数 */
  readdirErrors: number;
  /** 读不到的目录项数（stat 失败） */
  skippedEntries: number;
  /** 调用方带了 maxFiles，本次只处理了前 N 个文件 */
  maxFilesTruncated: boolean;
}

/** 扫描不完整的原因（人话）；完整时返回 null */
export function scanIncompleteReason(c: ScanCompleteness): string | null {
  const parts: string[] = [];
  if (c.truncated) parts.push(`目录项数触到上限（${WALK_MAX_ITEMS} 项 / ${Math.round(WALK_MAX_MS / 1000)} 秒），只遍历了一部分`);
  if (c.readdirErrors > 0) parts.push(`${c.readdirErrors} 个目录读不到（网络盘掉线 / 权限抖动 / 目录已删）`);
  if (c.skippedEntries > 0) parts.push(`${c.skippedEntries} 个目录项读不到（权限 / 云端未下载的占位 / 链接失效）`);
  if (c.maxFilesTruncated) parts.push('本次带了 maxFiles 限制，只处理了排在前面的那部分文件');
  return parts.length ? parts.join('；') : null;
}

export interface StaleCandidate {
  id: number;
  rel_path: string | null;
  title: string;
}

export interface StaleMarkingPlan {
  /** mark = 允许判定失效（**只标记，不删除**）；abort = 本次扫描不完整，一份都不动 */
  action: 'mark' | 'abort';
  /** abort 的原因（人话）；mark 时为 null */
  reason: string | null;
  /** 判定为失效的文档（action='mark' 时才该用），不删任何行 */
  rows: StaleCandidate[];
  scan: ScanCompleteness;
}

/**
 * 「哪些已入库文档按本次口径不再算数」→ 只出**标记计划**，绝不删除。
 *
 * 判定前提：**本次扫描必须完整**（无截断、无 readdir 失败、非 maxFiles 截断、无读不到的项）。
 * 不完整 → `action='abort'` + 原因：宁可这一轮口径没生效，也不能因为一次网络抖动把知识库标废/删空。
 */
export function planStaleMarking(input: { sourceId: number; keep: ReadonlySet<string>; scan: ScanCompleteness }): StaleMarkingPlan {
  const why = scanIncompleteReason(input.scan);
  const rows = all<StaleCandidate>(
    'SELECT id, rel_path, title FROM kb_document WHERE source_id = ? ORDER BY id',
    [input.sourceId],
  ).filter((r) => !input.keep.has(r.rel_path ?? ''));
  if (why) return { action: 'abort', reason: why, rows: [], scan: input.scan };
  return { action: 'mark', reason: null, rows, scan: input.scan };
}

/* ============================== 判定（分类 + 去重口径） ============================== */

export interface Candidate {
  file: WalkedFile;
  ext: string;
  scopeLayer: ScopeLayer;
  versionStatus: VersionStatus;
  institutional: boolean;
  docNo: string | null;
  title: string;
  /** 抬头/文件名里带出来的短文本（用来找文号与《…》），几十到几百字 */
  headText: string;
}

export interface Planned {
  candidate: Candidate;
  decision: Decision;
  reason: string;
  /** decision='dedup' 时指向留下的那一份 */
  dupOf?: Candidate;
}

/** 文件类型优先级（同一文号有多份时留哪一份）：docx 最优，其次其它可抽文本的格式 */
function extPriority(ext: string): number {
  switch (ext) {
    case '.docx':
      return 0;
    case '.doc':
      return 3; // 旧版二进制抽不出文字，优先级排后
    case '.pdf':
      return 2;
    case '.txt':
    case '.md':
      return 1;
    default:
      return 4;
  }
}

/** 同类里留哪一份：定稿 > `0.` 前缀（用户自己标的定稿件）> 文件类型 > 修改时间新 > 路径（结果稳定可复现） */
function preferRank(c: Candidate): [number, number, number, number, string] {
  const canonical = FINAL_PREFIX.test(c.file.fileName) ? 0 : 1;
  /**
   * 修改时间这一位要**设上限**（`mtimeMs: 0` 在预览里是"没取到时间"的哨兵值）。
   * 不用哨兵的话排序会在 `-0` 与 `-真实值` 之间比大小 → 预览选中的是 0. 定稿件，
   * 真跑时又因为 `-mtime` 更小而选中修改时间更新的副本 —— 同一批文件、同一口径
   * 选出两份不同的"同一份制度"，实测正是这么踩到的（预览说 0.、执行却写入了副本）。
   * 这一位只用来在"其它都相同"时挑更新的那份，放在最后一位之前就够了。
   */
  const freshness = c.file.mtimeMs > 0 ? -c.file.mtimeMs : Number.MIN_SAFE_INTEGER;
  return [c.versionStatus === 'final' ? 0 : 1, canonical, extPriority(c.ext), freshness, c.file.relPath];
}

function better(a: Candidate, b: Candidate): Candidate {
  const ra = preferRank(a);
  const rb = preferRank(b);
  for (let i = 0; i < 4; i += 1) {
    const x = ra[i] as number;
    const y = rb[i] as number;
    if (x !== y) return x < y ? a : b;
  }
  return (ra[4] as string) <= (rb[4] as string) ? a : b;
}

/**
 * 「这一份制度」的标识：来源分区 + 文号（没文号时退化成制度名）+ 版本状态。
 *
 * **版本状态要参与**：否则「上会稿」和「定稿件」会被当成同一组的副本，
 * 去重先跑就把历史版本整个吞掉，`kb.version=all`（全抽）于是形同虚设 ——
 * 这正是实测踩到的坑（切到 all 之后历史版本依然不入库）。
 * 加上版本状态后，`all` 口径下每个版本各自成组，只在**同一版本内**去重。
 */
function identityKey(c: Candidate): string {
  return `${c.scopeLayer}|${c.docNo ?? c.title}|${c.versionStatus}`;
}

/** 「制度本体」的键（**不含版本状态**）：latest_only 按它分组 */
function docKey(c: Candidate): string {
  return `${c.scopeLayer}|${c.docNo ?? c.title}`;
}

/** 同一份制度的**同一版本**内的副本组键 */
function docNoVersionKey(c: Candidate): string | null {
  return c.docNo ? `${c.scopeLayer}|${c.docNo}|${c.versionStatus}` : null;
}

/**
 * 按三个口径算出「每个文件是入库还是跳过」。
 *
 * 顺序是有讲究的（每一步都能解释给用户听）：
 *   ① 非制度文本 → kind（先排掉议题表/请示/记录表，别让它们占去重名额）
 *   ② 范围口径 → scope（法规/参考制度是否入库）
 *   ③ 版本口径 → version（上会稿/历史版本是否抽取）
 *   ④ 去重口径 → dedup
 *
 * **为什么版本在去重之前**：去重的粒度是「同一份制度的同一版本内的副本」。
 * 若先按文号去重，同一文号的上会稿与定稿件会被判成互为副本，历史版本永远进不了库，
 * 「全抽」这个选项就等于没实现。反过来先按版本收敛，再在同版本内去重，
 * 三种去重口径与三种版本口径才互不干扰。
 */
export function planExtraction(candidates: Candidate[], settings: ExtractSettings): Planned[] {
  const decided = new Map<string, Planned>();

  const mark = (c: Candidate, decision: Decision, reason: string, dupOf?: Candidate): void => {
    decided.set(c.file.relPath, { candidate: c, decision, reason, dupOf });
  };
  const decide = (c: Candidate, decision: Decision, reason: string, dupOf?: Candidate): void => {
    if (decided.has(c.file.relPath)) return; // 先到先定（① 的结论不被后面覆盖）
    mark(c, decision, reason, dupOf);
  };

  // ① 非制度
  for (const c of candidates) {
    if (!c.institutional) mark(c, 'kind', '文件名/路径不像制度文本（无制度关键词，或命中流程件/废弃标记）');
  }

  // ② 范围：法规与参考制度
  if (settings.scope === 'exclude') {
    for (const c of candidates) {
      if (c.scopeLayer === 'unit') continue;
      mark(c, 'scope', `范围口径=不入库：${c.scopeLayer === 'regulation' ? '外部法规/标准' : '参考制度（非本单位发文）'}`);
    }
  }

  // ③ 版本
  if (settings.version !== 'all') {
    const groups = new Map<string, Candidate[]>();
    for (const c of candidates) groups.set(identityKey(c), [...(groups.get(identityKey(c)) ?? []), c]);
    const keepSet = new Set<string>();
    for (const [, g] of groups) {
      if (settings.version === 'final_only') {
        const finals = g.filter((c) => c.versionStatus === 'final');
        if (finals.length) {
          for (const c of finals) keepSet.add(c.file.relPath);
        } else {
          // 一份制度一个 0. 定稿件都没有：回退抽现行版（否则这份制度永远进不了库）
          const cur = g.filter((c) => c.versionStatus === 'current').sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
          if (cur[0]) keepSet.add(cur[0].file.relPath);
        }
      }
    }
    if (settings.version === 'latest_only') {
      /**
       * 「只抽最新一版」按**制度本体**（分区 + 文号/制度名）分组，**不含版本状态**：
       * 版本状态进了组键的话，同一份制度的上会稿与定稿件会落在两个组里各自保留一份，
       * 这个口径就等于没生效（实测踩过）。这里每组只留修改时间最新的一份，
       * 它的 version_status 如实记录（最新一版恰好是上会稿时，库里就存 superseded —— 这是对的结果）。
       */
      const byDoc = new Map<string, Candidate[]>();
      for (const c of candidates) byDoc.set(docKey(c), [...(byDoc.get(docKey(c)) ?? []), c]);
      for (const [, g] of byDoc) {
        const newest = g.reduce((x, y) => (y.file.mtimeMs > x.file.mtimeMs ? y : x));
        keepSet.add(newest.file.relPath);
      }
    }
    for (const c of candidates) {
      const p = decided.get(c.file.relPath);
      if (p && p.decision !== 'extract') continue; // ① 判非制度、② 判不入库的结论保留
      if (keepSet.has(c.file.relPath)) continue;
      mark(
        c,
        'version',
        settings.version === 'final_only'
          ? c.versionStatus === 'superseded'
            ? '版本口径=只抽 0. 定稿件：本文件是上会稿/制作中/历史稿'
            : '版本口径=只抽 0. 定稿件：同一制度已有定稿件，本文件不是定稿'
          : '版本口径=只抽最新一版：同一制度已有修改时间更新的文件',
      );
    }
  }

  // ④ 去重（此时剩下的都是"该入库"的候选，只在同版本内判副本）
  for (const c of candidates) {
    if (!decided.has(c.file.relPath)) mark(c, 'extract', '命中当前口径，待入库');
  }

  if (settings.dedup === 'all') {
    // 全部入库：不改任何结论（同一制度的多份都会进库，这是这个口径的明示意图）
    return candidates.map((c) => decided.get(c.file.relPath) as Planned);
  }

  if (settings.dedup === 'by_name') {
    const byName = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const p = decided.get(c.file.relPath) as Planned;
      if (p.decision !== 'extract') continue;
      const k = c.file.fileName.toLowerCase();
      byName.set(k, [...(byName.get(k) ?? []), c]);
    }
    for (const [, g] of byName) {
      if (g.length < 2) continue;
      const keep = g.reduce((x, y) => better(x, y));
      for (const c of g) {
        if (c.file.relPath === keep.file.relPath) mark(c, 'extract', `去重口径=按文件名：同名 ${g.length} 份里留优先级最高的这份`);
        else mark(c, 'dedup', `与「${keep.file.relPath}」文件名完全相同（去重口径=按文件名），已跳过`, keep);
      }
    }
    return candidates.map((c) => decided.get(c.file.relPath) as Planned);
  }

  // prefer_docx / by_hash：同一文号 + 同一版本内只留一份（决定性比较用 preferRank）
  const byNoVer = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const p = decided.get(c.file.relPath) as Planned;
    if (p.decision !== 'extract') continue;
    const k = docNoVersionKey(c);
    if (!k) continue;
    byNoVer.set(k, [...(byNoVer.get(k) ?? []), c]);
  }
  for (const [, g] of byNoVer) {
    if (g.length < 2) continue;
    const keep = g.reduce((x, y) => better(x, y));
    for (const c of g) {
      if (c.file.relPath === keep.file.relPath) {
        mark(c, 'extract', `同文号 ${c.docNo} 同版本的多份里留优先级最高的这份（共 ${g.length} 份：定稿 > 0. 前缀 > docx > 修改时间新）`);
      } else {
        mark(c, 'dedup', `与「${keep.file.relPath}」同文号 ${c.docNo} 且同为${c.versionStatus === 'final' ? '定稿' : c.versionStatus === 'superseded' ? '历史稿' : '现行版'}，已跳过`, keep);
      }
    }
  }

  return candidates.map((c) => decided.get(c.file.relPath) as Planned);
}

/* ============================== 章节/条款路径 ============================== */

/**
 * 把一篇制度的纯文本切成「带条款路径的块」。
 * 路径形如 `S2 第二章 检查考核 > 一 第五条 > （二）`，供 B3-9 条款级引用。
 */
export function chunkInstitutionText(text: string): { content: string; clausePath: string | null; seq: number; heading: string | null }[] {
  const pairs: ClausePathPair[] = chunkTextWithClauses(text);
  return pairs.map((p, i) => ({ content: p.content, clausePath: p.clausePath, seq: i + 1, heading: null }));
}

/* ============================== 任务状态（进程内 + 库内） ============================== */

export interface JobCounter {
  id: number;
  sourceId: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  skipped: number;
  duplicates: number;
  chunks: number;
  embedded: number;
  current: string | null;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface LiveJob {
  id: number;
  sourceId: number;
  controller: AbortController;
  counter: JobCounter;
  recent: { rel_path: string; result: string; reason: string | null }[];
  since: number;
}

/** 正在跑的抽取任务（进程内）。进度以库里的行为准，这里只放「取消句柄 + 最近错误」。 */
const live = new Map<number, LiveJob>();
/** 同一个来源只允许一个抽取任务在跑（并发跑同一目录没有意义，还会互相删行） */
const liveBySource = new Map<number, number>();

export function liveExtractJobs(): { id: number; sourceId: number; counter: JobCounter }[] {
  return [...live.values()].map((j) => ({ id: j.id, sourceId: j.sourceId, counter: { ...j.counter } }));
}

export function getLiveJob(sourceId: number): { id: number; since: number } | null {
  const id = liveBySource.get(sourceId);
  return id === undefined ? null : { id, since: live.get(id)?.since ?? Date.now() };
}

export function cancelExtractJob(jobId: number): boolean {
  const j = live.get(jobId);
  if (!j) return false;
  j.controller.abort();
  return true;
}

function readCounter(jobId: number): JobCounter | null {
  const r = get<{
    id: number;
    source_id: number;
    status: JobCounter['status'];
    total: number;
    done: number;
    failed: number;
    skipped: number;
    duplicates: number;
    chunks: number;
    embedded: number;
    current: string | null;
    message: string | null;
    started_at: string;
    finished_at: string | null;
  }>(
    `SELECT id, source_id, status, total, done, failed, skipped, duplicates, chunks, embedded,
            current, message, started_at, finished_at FROM kb_extract_job WHERE id = ?`,
    [jobId],
  );
  if (!r) return null;
  return {
    id: r.id,
    sourceId: r.source_id,
    status: r.status,
    total: r.total,
    done: r.done,
    failed: r.failed,
    skipped: r.skipped,
    duplicates: r.duplicates,
    chunks: r.chunks,
    embedded: r.embedded,
    current: r.current,
    message: r.message,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function extractStatus(jobId: number): {
  job: JobCounter;
  settings: Record<string, unknown> | null;
  running: boolean;
  recent: { rel_path: string; result: string; reason: string | null }[];
  items: { rel_path: string; file_name: string | null; result: string; reason: string | null; scope_layer: string | null; version_status: string | null; chunks: number }[];
  failures: { rel_path: string; file_name: string | null; reason: string | null; size_bytes: number | null }[];
  byDecision: { result: string; n: number }[];
  elapsedMs: number;
} | null {
  const job = readCounter(jobId);
  if (!job) return null;
  const l = live.get(jobId);
  const items = all<{ rel_path: string; file_name: string | null; result: string; reason: string | null; scope_layer: string | null; version_status: string | null; chunks: number }>(
    `SELECT rel_path, file_name, result, reason, scope_layer, version_status, chunks
       FROM kb_extract_item WHERE job_id = ? ORDER BY id`,
    [jobId],
  );
  const failures = all<{ rel_path: string; file_name: string | null; reason: string | null; size_bytes: number | null }>(
    `SELECT rel_path, file_name, reason, size_bytes FROM kb_extract_item
      WHERE job_id = ? AND result = 'fail' ORDER BY id LIMIT 200`,
    [jobId],
  );
  const byDecision = all<{ result: string; n: number }>(
    'SELECT result, COUNT(*) AS n FROM kb_extract_item WHERE job_id = ? GROUP BY result ORDER BY n DESC',
    [jobId],
  );
  const endedAt = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const rawSettings = get<{ settings_json: string | null }>('SELECT settings_json FROM kb_extract_job WHERE id = ?', [jobId])?.settings_json ?? null;
  let settings: Record<string, unknown> | null = null;
  try {
    settings = rawSettings ? (JSON.parse(rawSettings) as Record<string, unknown>) : null;
  } catch {
    settings = null;
  }
  return {
    job,
    settings,
    running: l !== undefined,
    recent: l ? [...l.recent] : [],
    items,
    failures,
    byDecision,
    elapsedMs: Math.max(0, endedAt - Date.parse(job.startedAt)),
  };
}

/* ============================== 执行 ============================== */

export interface StartExtractInput {
  sourceId: number;
  rootAbs: string;
  embed?: boolean;
  ocr?: boolean;
  maxFiles?: number;
}

export interface StartExtractResult {
  jobId: number;
  total: number;
  settings: ExtractSettings;
}

/**
 * 起一个抽取任务：同步做完「遍历 + 分类 + 判定（口径①②③④）」，把逐文件计划写进
 * `kb_extract_item`（此时 result 是 'planned' 占位），**然后立即返回**，
 * 真正的抽文本/切块/向量化在后台按批推进（`void run(...)`），进度走
 * `GET /api/kb/extract/:jobId` 或 `/api/kb/sources/:id/extract/status`。
 *
 * 为什么把判定放在同步段：判定只 readdir + stat + 少量抬头读取，跑得快，
 * 而且能立刻把 `total` 告诉用户（"将处理 N 个文件"）。这一步不抽正文，
 * 所以对 iCloud 的触发面也有限。
 */
export async function startExtractJob(input: StartExtractInput): Promise<StartExtractResult> {
  const existing = liveBySource.get(input.sourceId);
  if (existing !== undefined) {
    throw new Error(`这个来源目录已经有一个抽取任务在跑（任务 #${existing}），等它结束或先取消。`);
  }
  const settings = loadExtractSettings();
  const walk = await walkSource(input.rootAbs);
  const files = input.maxFiles ? walk.files.slice(0, input.maxFiles) : walk.files;
  /**
   * 本次扫描的完整性：它决定收尾时**能不能**判定"哪些文档失效了"。
   * `maxFilesTruncated` 必须自己算出来（maxFiles 是按 relPath 排序后的前 N 个，
   * 被切掉的那些文件本次压根不在计划里 —— 和"文件被删了"看起来一模一样）。
   */
  const scan: ScanCompleteness = {
    truncated: walk.truncated,
    readdirErrors: walk.readdirErrors,
    skippedEntries: walk.skippedEntries,
    maxFilesTruncated: input.maxFiles !== undefined && walk.files.length > files.length,
  };
  const incomplete = scanIncompleteReason(scan);

  // 抬头（页眉页脚 + 正文开头）只读 docx 的必要部件，用来找文号和《制度名》。
  // 坏文件在这里读不动，不算失败 —— 真正的失败判定在后面的正文抽取里。
  const candidates: Candidate[] = [];
  for (const f of files) {
    const ext = extOf(f.fileName);
    let headText = '';
    if (ext === '.docx' && f.size > 0 && f.size < 40 * 1024 * 1024) {
      try {
        const buf = await readFile(f.absPath);
        // 只解压一次，抬头（页眉页脚 + 正文开头）从这里取；下一步抽正文时再读一次全文
        headText = extractDocxHead(buf, 3000);
      } catch {
        headText = '';
      }
    }
    const byMeta = looksInstitutionalByMeta(f.relPath, f.fileName);
    // 文件名判「不是制度」时，再用抬头/正文兜一次：扫描件与名字起得随便的真制度靠这一步捞回来
    const institutional = byMeta || looksInstitutionalText(`${f.fileName}\n${headText}`);
    candidates.push({
      file: f,
      ext,
      scopeLayer: classifyLayer(f.relPath, f.fileName),
      versionStatus: classifyVersion(f.relPath, f.fileName),
      institutional,
      docNo: findDocNo(headText, f.fileName),
      title: guessTitle(f.relPath, f.fileName, headText),
      headText,
    });
  }

  const plans = planExtraction(candidates, settings);
  const insert = tx(() => {
    const job = run(
      `INSERT INTO kb_extract_job (source_id, status, settings_json, total, current, message)
       VALUES (?, 'pending', ?, ?, ?, ?)`,
      [
        input.sourceId,
        JSON.stringify({
          ...settings,
          embed: false,
          ocr: input.ocr === true,
          maxFiles: input.maxFiles ?? null,
          walkTruncated: walk.truncated,
          readdirErrors: walk.readdirErrors,
          skippedEntries: walk.skippedEntries,
          maxFilesTruncated: scan.maxFilesTruncated,
          scanComplete: incomplete === null,
        }),
        plans.length,
        '',
        incomplete
          ? `本次扫描不完整（${incomplete}）：只处理扫到的这部分，并且不会判定任何已入库文档失效`
          : null,
      ],
    );
    const jobId = job.lastInsertRowid;
    for (const p of plans) {
      run(
        `INSERT INTO kb_extract_item (job_id, rel_path, file_name, size_bytes, doc_no, scope_layer, version_status, result, reason)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          jobId,
          p.candidate.file.relPath,
          p.candidate.file.fileName,
          p.candidate.file.size,
          p.candidate.docNo,
          p.candidate.scopeLayer,
          p.candidate.versionStatus,
          'planned',
          null,
        ],
      );
    }
    return jobId;
  });

  const counter: JobCounter = {
    id: insert,
    sourceId: input.sourceId,
    status: 'pending',
    total: plans.length,
    done: 0,
    failed: 0,
    skipped: 0,
    duplicates: 0,
    chunks: 0,
    embedded: 0,
    current: null,
    message: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  live.set(insert, {
    id: insert,
    sourceId: input.sourceId,
    controller: new AbortController(),
    counter,
    recent: [],
    since: Date.now(),
  });
  liveBySource.set(input.sourceId, insert);
  run(
    `UPDATE kb_extract_job SET status = 'running', current = '' WHERE id = ?`,
    [insert],
  );

  void runExtractJob(insert, input, plans, scan).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    run(`UPDATE kb_extract_job SET status = 'failed', message = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [
      `抽取任务异常中止：${msg}`,
      insert,
    ]);
    live.delete(insert);
    liveBySource.delete(input.sourceId);
  });

  return { jobId: insert, total: plans.length, settings };
}

/** 每批处理的文件数（批之间让出事件循环，避免长时间占住主线程） */
const BATCH = 8;
/** 批内并发读文件数：iCloud 上并发太高会触发限流，4 是"够快又不吓人"的折中 */
const CONCURRENCY = 4;

function yieldLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

async function runExtractJob(jobId: number, input: StartExtractInput, plans: Planned[], scan: ScanCompleteness): Promise<void> {
  const l = live.get(jobId);
  if (!l) return;
  const { controller, counter } = l;
  const embedOn = false;
  const ocrOn = input.ocr === true;
  const tmpDir = join(RUNTIME_ROOT, 'kb-tmp');
  const keep = new Set(plans.filter((p) => p.decision === 'extract').map((p) => p.candidate.file.relPath));

  const bump = (patch: Partial<JobCounter> & { current?: string | null; message?: string | null }): void => {
    Object.assign(counter, patch);
    run(
      `UPDATE kb_extract_job SET done = ?, failed = ?, skipped = ?, duplicates = ?, chunks = ?, embedded = ?, current = ?, message = ?
        WHERE id = ?`,
      [counter.done, counter.failed, counter.skipped, counter.duplicates, counter.chunks, counter.embedded, counter.current, counter.message, jobId],
    );
  };

  const note = (relPath: string, result: string, reason: string | null): void => {
    l.recent.unshift({ rel_path: relPath, result, reason });
    if (l.recent.length > 20) l.recent.length = 20;
  };

  /** 记一条逐文件结果 */
  const finishItem = (
    p: Planned,
    result: 'ok' | 'skip' | 'fail',
    reason: string | null,
    extra: { documentId?: number; chunks?: number; embedded?: number } = {},
  ): void => {
    run(
      `UPDATE kb_extract_item SET result = ?, reason = ?, document_id = ?, chunks = ?, embedded = ?
        WHERE job_id = ? AND rel_path = ?`,
      [result, reason, extra.documentId ?? null, extra.chunks ?? 0, extra.embedded ?? 0, jobId, p.candidate.file.relPath],
    );
    if (result === 'ok') counter.done += 1;
    else if (result === 'fail') {
      counter.failed += 1;
      note(p.candidate.file.relPath, result, reason);
    } else {
      counter.skipped += 1;
      if (p.decision === 'dedup') counter.duplicates += 1;
    }
  };

  try {
    // ---- 先把「按口径不入库」的写清楚（含重复关系），它们不需要读正文 ----
    for (const p of plans) {
      if (p.decision === 'extract') continue;
      const label =
        p.decision === 'dedup' ? '重复' : p.decision === 'scope' ? '按范围口径排除' : p.decision === 'version' ? '按版本口径排除' : '判定为非制度文本';
      finishItem(p, 'skip', p.reason, {});
      run('UPDATE kb_extract_item SET reason = ? WHERE job_id = ? AND rel_path = ?', [`${label}：${p.reason}`, jobId, p.candidate.file.relPath]);
    }
    bump({ current: '', message: `${plans.length} 个文件里 ${keep.size} 个待抽正文` });

    const toExtract = plans.filter((p) => p.decision === 'extract');
    /** 内容哈希 → 已入库文档（by_hash 口径的第二层收敛用） */
    const hashSeen = new Map<string, { id: number; relPath: string }>();
    if (loadExtractSettings().dedup === 'by_hash') {
      for (const r of all<{ id: number; rel_path: string; norm_sha256: string | null }>(
        'SELECT id, rel_path, norm_sha256 FROM kb_document WHERE source_id = ? AND norm_sha256 IS NOT NULL',
        [input.sourceId],
      )) {
        if (r.norm_sha256 && !hashSeen.has(r.norm_sha256)) hashSeen.set(r.norm_sha256, { id: r.id, relPath: r.rel_path ?? '' });
      }
    }

    // ---- 逐批抽正文 ----
    for (let i = 0; i < toExtract.length; i += BATCH) {
      if (controller.signal.aborted) break;
      const batch = toExtract.slice(i, i + BATCH);
      const results: { p: Planned; promise: Promise<void> }[] = [];
      // 批内并发：切片成 CONCURRENCY 个通道，各自串行
      for (let lane = 0; lane < CONCURRENCY; lane += 1) {
        const slice = batch.filter((_, idx) => idx % CONCURRENCY === lane);
        results.push({
          p: batch[lane] as Planned,
          promise: (async () => {
            for (const p of slice) {
              if (controller.signal.aborted) return;
              await extractOne(p, { jobId, sourceId: input.sourceId, embedOn, ocrOn, tmpDir, hashSeen, finishItem, bump, counter, note });
            }
          })(),
        });
      }
      await Promise.all(results.map((r) => r.promise));
      await yieldLoop();
    }

    if (controller.signal.aborted) {
      run(`UPDATE kb_extract_job SET status = 'cancelled', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), message = ? WHERE id = ?`, [
        `已取消：已处理的成果保留（${counter.done} 份已入库），下次重跑按文件哈希跳过没变的文件`,
        jobId,
      ]);
      return;
    }

    /**
     * ---- 收尾：换口径后不再该入库的（例如把「全抽」改回「只抽定稿件」）**标记失效**，不删库 ----
     *
     * 这里踩过一次大坑（本次修的 P1），三条铁律写在这儿，改动前先读：
     *   1. **"本次没扫到" ≠ "应该删除"**。旧写法是 `stale = 全部 kb_document - keep` 然后
     *      `deleteKbDocument()` 物理删除三张表（含已付费向量）。readdir 一次抖动 → `walk.files=[]`
     *      → keep 为空 → 整个来源的知识库连带向量被删光。现在：扫描不完整**一律不判定失效**。
     *   2. **默认只标记**（`decision='stale'`，正文/片段/向量全部原地保留），
     *      物理删除只走用户显式确认的 {@link purgeStale}（kb.ts）那条路。
     *   3. 标记的**唯一前提是本次扫描完整**（无截断、无 readdir 失败、非 maxFiles 截断、无读不到的项）。
     *      前提不满足就中止，并把原因写进任务结果（`kb_extract_job.message` / `kb_source.extract_note`）。
     */
    const stalePlan = planStaleMarking({ sourceId: input.sourceId, keep, scan });
    let staleNote: string | null = null;
    if (stalePlan.action === 'abort') {
      staleNote =
        `已中止失效标记（一份都没动）：本次扫描不完整 —— ${stalePlan.reason}。` +
        `「本次没扫到」不等于「应该失效/删除」，已入库的文档与向量全部原样保留；` +
        `等目录可正常完整读取后再重跑一次即可。`;
    } else if (stalePlan.rows.length) {
      const cfgNowForStale = loadExtractSettings();
      const reasonText =
        `按当前口径不再入库（口径：去重=${cfgNowForStale.dedup} 范围=${cfgNowForStale.scope} 版本=${cfgNowForStale.version}；` +
        '本次完整扫描未再纳入）—— 只标记失效，正文与向量保留';
      const marked = markKbDocumentsStale(stalePlan.rows.map((r) => r.id), reasonText);
      staleNote =
        `标记失效 ${stalePlan.rows.length} 份（新标 ${marked.marked}，已是失效态 ${marked.already}）；` +
        '正文与向量都留着，检索与条款引用已不再采用；要真删走「POST /api/kb/sources/:id/stale/purge」（先看清单再确认）';
    }

    const cfgNow = loadExtractSettings();
    run(
      `UPDATE kb_source SET last_extract_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), extracted_docs = ?, extracted_chunks = ?,
         extract_note = ? WHERE id = ?`,
      [
        counter.done,
        counter.chunks,
        `口径：去重=${cfgNow.dedup} 范围=${cfgNow.scope} 版本=${cfgNow.version}；入库 ${counter.done} 份 / ${counter.chunks} 块，失败 ${counter.failed}，按口径跳过 ${counter.skipped}${staleNote ? `；${staleNote}` : ''}`,
        input.sourceId,
      ],
    );
    run(`UPDATE kb_extract_job SET status = 'done', current = '', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), message = ? WHERE id = ?`, [
      `完成：入库 ${counter.done} 份 / ${counter.chunks} 块（向量 ${counter.embedded}），失败 ${counter.failed}，跳过 ${counter.skipped}${counter.duplicates ? `（其中重复 ${counter.duplicates}）` : ''}${staleNote ? `；${staleNote}` : ''}`,
      jobId,
    ]);
  } finally {
    live.delete(jobId);
    liveBySource.delete(input.sourceId);
  }
}

/** 抽一个文件：读一次字节（同时算 sha256）→ 抽文本 → 切块 → 写 FTS → 向量化 */
async function extractOne(
  p: Planned,
  ctx: {
    jobId: number;
    sourceId: number;
    embedOn: boolean;
    ocrOn: boolean;
    tmpDir: string;
    hashSeen: Map<string, { id: number; relPath: string }>;
    finishItem: (p: Planned, result: 'ok' | 'skip' | 'fail', reason: string | null, extra?: { documentId?: number; chunks?: number; embedded?: number }) => void;
    bump: (patch: Partial<JobCounter> & { current?: string | null; message?: string | null }) => void;
    counter: JobCounter;
    note: (relPath: string, result: string, reason: string | null) => void;
  },
): Promise<void> {
  const c = p.candidate;
  ctx.bump({ current: c.file.relPath });
  try {
    // ---- 幂等快通道：文件大小/修改时间/哈希都没变、切块口径一致 → 原地不动 ----
    const existing = get<{
      id: number;
      doc_sha256: string | null;
      chunk_config: string | null;
      size_bytes: number | null;
      mtime_ms: number | null;
      chunk_count: number;
      embedded_at: string | null;
      decision: string | null;
    }>(
      `SELECT id, doc_sha256, chunk_config, size_bytes, mtime_ms, chunk_count, embedded_at, decision
         FROM kb_document WHERE source_id = ? AND rel_path = ?`,
      [ctx.sourceId, c.file.relPath],
    );
    const cfgSig = `${kbChunkSignature()}|${c.ext}`;
    if (
      existing &&
      existing.size_bytes === c.file.size &&
      existing.mtime_ms === Math.round(c.file.mtimeMs) &&
      existing.chunk_config === cfgSig &&
      existing.chunk_count > 0
    ) {
      /**
       * 幂等快通道。但**失效态必须在这里被恢复**：换口径把这份标成 stale 之后，
       * 再换回来重跑时快通道会直接"未变化，跳过重抽" —— 只跳重抽、不恢复 active 的话，
       * 文档就永远停在失效态（检索搜不到、引用被拦），看起来就是"换回口径也没用"。
       */
      const restored = existing.decision !== null && existing.decision !== 'active';
      if (restored) restoreKbDocumentActive(existing.id);
      ctx.finishItem(
        p,
        'ok',
        restored ? '未变化（大小/修改时间/切块口径一致），跳过重抽；已从「失效」恢复为可用' : '未变化（大小/修改时间/切块口径一致），跳过重抽',
        { documentId: existing.id, chunks: existing.chunk_count },
      );
      ctx.bump({});
      return;
    }

    // ---- 读一次字节，同时算哈希 ----
    let buf: Buffer;
    try {
      buf = await readFile(c.file.absPath);
    } catch (e) {
      ctx.finishItem(p, 'fail', `读取失败：${(e as Error).message}`);
      return;
    }
    const hash = sha256Hex(buf);

    // ---- 抽文本 ----
    let text = '';
    let method = 'none';
    let errMsg: string | undefined;
    const r = await extractAnyFromBuffer(buf, c.file.fileName, ctx.tmpDir);
    if (r.ok && r.text.trim().length >= 20) {
      text = r.text;
      method = r.method;
    } else {
      errMsg = r.message;
      // 扫描件/图片：走 OCR（可关；关了也要说清为什么跳过）
      if (isOcrCandidate(c.file.fileName) || (extOf(c.file.fileName) === '.pdf' && !r.ok)) {
        if (!ctx.ocrOn || !ocrEnabled()) {
          ctx.finishItem(
            p,
            'fail',
            `${errMsg ?? '没有文字层'}；这是扫描件/图片，需要 OCR${ocrEnabled() ? '（本次抽取勾了"不做 OCR"）' : '（设置里没启用 OCR）'}`,
          );
          return;
        }
        try {
          const ocr = await withTimeout(ocrFile(c.file.absPath), 120_000);
          if (ocr.ok && ocr.text.trim().length >= 20) {
            text = ocr.text;
            method = 'ocr';
          } else {
            ctx.finishItem(p, 'fail', `OCR 未能识别出可用文字：${summarizeOcrError(ocr.error)}`);
            return;
          }
        } catch (e) {
          ctx.finishItem(p, 'fail', `OCR 失败/超时：${(e as Error).message}`);
          return;
        }
      } else {
        ctx.finishItem(p, 'fail', errMsg ?? '没有可提取的文字');
        return;
      }
    }

    // ---- 非制度文本的正文兜底：文件名不像，但正文是制度 → 改判入库 ----
    if (!looksInstitutionalText(`${c.file.fileName}\n${text}`) && /记录表|签到表|审批表|议题表|请示/.test(c.file.fileName)) {
      ctx.finishItem(p, 'skip', '文件名与正文都不像制度文本（流程件/表单），按口径跳过');
      return;
    }

    const normHash = sha256Hex(normalizeForHash(text));
    if (loadExtractSettings().dedup === 'by_hash') {
      const seen = ctx.hashSeen.get(normHash);
      if (seen) {
        ctx.finishItem(p, 'skip', `内容与已入库的「${seen.relPath}」完全一致（去重口径=按内容哈希），已跳过`);
        return;
      }
    }

    // ---- 写 kb_document（稳定键原地更新，绝不 INSERT 出第二行）----
    const chunkSig = cfgSig;
    const documentId = upsertExtractDocument({
      sourceId: ctx.sourceId,
      relPath: c.file.relPath,
      title: c.title,
      docType: '制度规范',
      docNo: c.docNo,
      scopeLayer: loadExtractSettings().scope === 'plain' ? 'unit' : c.scopeLayer,
      versionStatus: c.versionStatus,
      sha: hash,
      normSha: normHash,
      ext: c.ext,
      size: c.file.size,
      mtimeMs: Math.round(c.file.mtimeMs),
      method,
      text,
    });
    ctx.hashSeen.set(normHash, { id: documentId, relPath: c.file.relPath });

    // ---- 切块（章节/条款路径）+ FTS ----
    const chunks = chunkInstitutionText(text);
    const written = indexDocumentChunksFs(documentId, chunks, chunkSig, text, method);
    ctx.counter.chunks += written;

    ctx.finishItem(p, 'ok', `已入库 ${written} 块（${method}，本地关键词索引）`, { documentId, chunks: written, embedded: 0 });
  } catch (e) {
    // 单文件失败只影响这个文件：整批继续（硬要求 4）
    ctx.finishItem(p, 'fail', `抽取异常：${(e as Error).message}`);
  } finally {
    ctx.bump({});
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`超过 ${Math.round(ms / 1000)} 秒没有结果`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e as Error);
      },
    );
  });
}

interface UpsertDocInput {
  sourceId: number;
  relPath: string;
  title: string;
  docType: string;
  docNo: string | null;
  scopeLayer: ScopeLayer;
  versionStatus: VersionStatus;
  sha: string;
  normSha: string;
  ext: string;
  size: number;
  mtimeMs: number;
  method: string;
  text: string;
}
/**
 * 写 kb_document：稳定键 `(source_id, rel_path)` 命中就 UPDATE，否则 INSERT。
 * 这条路上**没有第二条 INSERT 的可能**（唯一索引 + 先查），所以换口径重跑不会长行。
 */
function upsertExtractDocument(input: UpsertDocInput): number {
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  return tx(() => {
    const row = get<{ id: number }>('SELECT id FROM kb_document WHERE source_id = ? AND rel_path = ?', [input.sourceId, input.relPath]);
    if (row) {
      run(
        `UPDATE kb_document SET title = ?, doc_type = ?, doc_no = ?, scope_layer = ?, version_status = ?,
           doc_sha256 = ?, norm_sha256 = ?, file_ext = ?, size_bytes = ?, mtime_ms = ?, extract_method = ?,
           decision = 'active', decision_reason = NULL, dup_of_id = NULL,
           extracted_at = ${now}, source = ? WHERE id = ?`,
        [
          input.title,
          input.docType,
          input.docNo,
          input.scopeLayer,
          input.versionStatus,
          input.sha,
          input.normSha,
          input.ext,
          input.size,
          input.mtimeMs,
          input.method,
          '来源目录',
          row.id,
        ],
      );
      return row.id;
    }
    const ins = run(
      // chunk_count 先按 1 记：**不能留 0**。`extractOne` 的幂等快通道判据里有
      // `chunk_count > 0`，留 0 会让同一个文件每次重跑都重新抽一遍（实测踩过：
      // 第二次跑完片段数变成 0）。真正的块数由 indexDocumentChunksFs 覆盖写。
      `INSERT INTO kb_document (artifact_id, title, doc_type, source, chunk_count, embedded_at, created_at,
         source_id, rel_path, doc_sha256, norm_sha256, doc_no, scope_layer, version_status, decision, decision_reason,
         chunk_config, extracted_at, file_ext, size_bytes, mtime_ms, extract_method)
       VALUES (NULL, ?, ?, ?, 1, NULL, ${now}, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ${now}, ?, ?, ?, ?)`,
      [
        input.title,
        input.docType,
        '来源目录',
        input.sourceId,
        input.relPath,
        input.sha,
        input.normSha,
        input.docNo,
        input.scopeLayer,
        input.versionStatus,
        input.ext,
        input.size,
        input.mtimeMs,
        input.method,
      ],
    );
    return ins.lastInsertRowid;
  });
}

/* ============================== 检索辅助（FTS 命中片段） ============================== */

export interface KbChunkHit {
  chunkId: number;
  documentId: number;
  title: string;
  relPath: string | null;
  scopeLayer: string | null;
  versionStatus: string | null;
  clausePath: string | null;
  content: string;
  score: number;
}

/** 诊断用：直接查 kb_chunk_fts，验证「FTS 能搜到新制度」（不参与正式检索排序） */
export function searchKbChunks(match: string, limit = 20): KbChunkHit[] {
  if (!match.trim()) return [];
  return all<KbChunkHit>(
    `SELECT c.id AS chunkId, c.document_id AS documentId, d.title, d.rel_path AS relPath,
            d.scope_layer AS scopeLayer, d.version_status AS versionStatus, c.clause_path AS clausePath,
            c.content, bm25(kb_chunk_fts) AS score
       FROM kb_chunk_fts f
       JOIN kb_chunk c ON c.id = f.rowid
       JOIN kb_document d ON d.id = c.document_id
      WHERE kb_chunk_fts MATCH ? AND ${visibleKbDocumentFilter('d')}
        AND (d.decision IS NULL OR d.decision <> '${KB_DECISION_STALE}')
      ORDER BY score ASC LIMIT ?`,
    [match, limit],
  );
}
