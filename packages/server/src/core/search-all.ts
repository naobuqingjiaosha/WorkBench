/**
 * 全局搜索：一个输入框同时搜「工作台 / 文件 / 模板 / 制度 / 阶段」。
 *
 * 与 `core/search.ts`（文件库单域检索）、`core/kb.ts`（知识库语义检索）的分工：
 *   这里是**跨域聚合**，只做关键词召回 + 统一打分排序，不调用任何 AI、不引入新依赖。
 *   `core/search.ts` 的 `buildMatch` / `segCJK` 与 `core/kb.ts` 的 `buildFtsQuery`
 *   是同一套「CJK 逐字切分 + FTS5 短语匹配」策略，这里直接复用 `buildMatch`。
 *
 * 各域的检索手段（为什么有的走 FTS、有的走 LIKE）：
 *   workbench          LIKE      —— 只有几百条，且没有建 FTS 表；编号/名称/摘要/标签/路径一起扫
 *   artifact           FTS5      —— 复用 `artifact_fts`（正文抽取最全的索引），按 bm25 取候选池后精排
 *   template           LIKE      —— 几十条，没有 FTS 表；名称/编号/文号/说明，外加变量别名里的变量名
 *   kb（制度）          LIKE      —— 库没有 FTS 表（只有向量），用片段正文 LIKE + 标题/来源
 *                                   **失效文档（`kb_document.decision='stale'`）不参与**：
 *                                   与 `core/kb.ts:877`（语义检索）/ `core/kb-extract.ts:1367`（片段检索）同口径
 *   position           LIKE      —— 阶段模板 + 阶段实例，量都很小
 *
 * 两个必须守住的边界（都是本项目踩过的坑）：
 *   1. **空查询绝不进 SQL**：`buildMatch('')` 返回空串，空串喂给 FTS5 `MATCH` 会抛
 *      `syntax error near ""`，整条请求 500；LIKE 的 `'%%'` 则是全表返回。这里一律早退。
 *   2. **LIKE 里的 `%` / `_` 必须转义**：否则用户输入 `%` 就等于"匹配一切"，
 *      输入 `_` 就等于"任意一个字符"。统一走 `likePattern()` 生成 `... ESCAPE '\'`。
 */
import { all } from '../db/index.ts';
import { KB_DECISION_STALE } from './kb.ts';
import { buildMatch } from './search.ts';
import { liveFilter, visibleArtifactFilter } from './trash.ts';

/* ============================== 类型（对外契约） ============================== */

export interface SearchHit {
  kind: 'workbench' | 'artifact' | 'template' | 'kb' | 'position';
  id: number;
  title: string;
  subtitle: string;
  /** 已就地标好命中词的原文片段（命中词用 【】 包住，不是 HTML） */
  snippet: string;
  score: number;
  /** 前端可直接跳转的路径（hash 路由，照 App.tsx 的约定） */
  route: string;
}

export interface SearchResult {
  query: string;
  total: number;
  groups: { kind: string; label: string; count: number; hits: SearchHit[] }[];
  elapsedMs: number;
}

export interface SearchAllOptions {
  /** 只查这些域（缺省 = 全部）；认不出的值直接忽略 */
  kinds?: string[];
  /** 每域最多返回多少条（同时决定候选池规模上限） */
  limitPerKind?: number;
}

/** 域的固定顺序 + 中文名，界面的分组标题与筛选复选框都用它 */
export const SEARCH_KINDS: { kind: SearchHit['kind']; label: string }[] = [
  { kind: 'workbench', label: '工作台' },
  { kind: 'artifact', label: '文件' },
  { kind: 'template', label: '模板' },
  { kind: 'kb', label: '制度' },
  { kind: 'position', label: '阶段' },
];

const ALL_KINDS: SearchHit['kind'][] = SEARCH_KINDS.map((k) => k.kind);
const LABEL_OF = new Map<string, string>(SEARCH_KINDS.map((k) => [k.kind, k.label]));

/** `q` 长度上限（超长直接截断，不报错：截断后的词照样能搜） */
export const MAX_QUERY_LEN = 200;
export const DEFAULT_LIMIT_PER_KIND = 8;
export const MAX_LIMIT_PER_KIND = 50;

/** 每域候选池上限：先按相关度/时间取这么多行，再在内存里精排 + 截断 */
const POOL_MAX = 400;
/** 正文/摘要参与打分时最多看多少字（防止某份 PDF 的几万字抽取文本把每次搜索拖慢） */
const BODY_SCAN_LIMIT = 4000;
/** 列表副标题里正文片段的最大长度 */
const SUBTITLE_BODY_LIMIT = 60;

/* ============================== 打分与片段 ============================== */

/**
 * 命中位置档位。
 *
 * 档位之间的间隔（10 分）远大于正文档位内部的相关度抖动（最多 19 分），
 * 这样「标题精确命中」必然排在「标题前缀命中」前面，而不会因为正文命中密度高被反超 —— 
 * 排序要求是「标题精确 > 标题前缀 > 标题包含 > 正文命中」，这里把它做成硬档位。
 */
const S_EXACT = 1000;
const S_PREFIX = 900;
const S_CONTAINS = 800;
const S_SECONDARY = 700; // 编号 / 文号 / 别名 / 文件名 命中
const S_BODY = 500;

interface MatchInfo {
  score: number;
  field: string | null;
  hit: boolean;
}

const NO_MATCH: MatchInfo = { score: 0, field: null, hit: false };

/** 去掉空白，供包含判断用 */
function squash(s: string): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 一个词在一个字段里的档位分。
 * 返回 null 表示不命中（调用方继续看下一个字段）。
 */
function fieldScore(value: string | null | undefined, term: string, tier: number): number | null {
  const v = (value ?? '').toLowerCase();
  if (!v) return null;
  if (v === term) return tier;
  if (v.startsWith(term)) return tier - 1;
  if (v.includes(term)) return tier - 2;
  return null;
}

/**
 * 正文档位的相关度小分（0-19）：命中次数越多分越高，但永远跨不过 10 分的档位差。
 * 用 `indexOf` 循环数次数，不用正则 —— 用户输入的 `(`、`.` 之类在正则里有特殊含义，
 * 每次都要 escape 一遍既慢又容易漏。
 */
function bodyScore(value: string | null | undefined, term: string): number {
  const v = (value ?? '').toLowerCase();
  if (!term || v.length < term.length) return 0;
  const scan = v.length > BODY_SCAN_LIMIT ? v.slice(0, BODY_SCAN_LIMIT) : v;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = scan.indexOf(term, from);
    if (i < 0) break;
    count += 1;
    from = i + term.length;
    if (count >= 20) break; // 打满即止
  }
  if (!count) return 0;
  return 10 + Math.min(count - 1, 9);
}

/**
 * 多词打分的统一入口。
 *
 * 规则：**取命中最好的那个词**，而不是把每个词的分加起来。
 * 加总分会让「命中 3 个冷僻字的正文」压过「命中 1 个核心词的标题」，
 * 与「标题优先」的排序要求相悖；另外再加一个"全部词都命中"的小奖励（同档位内更相关）。
 */
function scoreRow(terms: string[], fields: { primary: (string | null | undefined)[]; secondary: (string | null | undefined)[]; body: (string | null | undefined)[] }): MatchInfo {
  let best: MatchInfo = NO_MATCH;
  let allHit = terms.length > 0;
  for (const term of terms) {
    let cur = NO_MATCH;
    for (const f of fields.primary) {
      const s = fieldScore(f, term, S_EXACT);
      if (s !== null) {
        cur = { score: s, field: 'primary', hit: true };
        break;
      }
    }
    if (!cur.hit) {
      for (const f of fields.secondary) {
        const s = fieldScore(f, term, S_SECONDARY);
        if (s !== null) {
          cur = { score: s, field: 'secondary', hit: true };
          break;
        }
      }
    }
    if (!cur.hit) {
      for (const f of fields.body) {
        const s = bodyScore(f, term);
        if (s > 0) {
          cur = { score: s, field: 'body', hit: true };
          break;
        }
      }
    }
    if (cur.hit && cur.score > best.score) best = cur;
    if (!cur.hit) allHit = false;
  }
  if (!best.hit) return NO_MATCH;
  if (allHit && terms.length > 1) best = { ...best, score: best.score + 5 };
  return best;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把文本里所有命中词用 `【】` 标出来（保留原文，不产生 HTML）。
 *
 * 先按命中的**不同词形**做一次扫描（`【】` 自带标记，不会和原文混淆），
 * 再用正则一次性替换所有词 —— 一次遍历解决重叠，也不会出现嵌套标记。
 */
function highlight(text: string, terms: string[]): string {
  const uniq = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  if (!uniq.length || !text) return text;
  const re = new RegExp(uniq.map(escapeRe).join('|'), 'gi');
  return text.replace(re, (m) => `【${m}】`);
}

/**
 * 生成片段：命中词前后各 30 个字，命中词用 `【】` 标出。
 * `body` 为空或没命中时，退化成标题本身（保证条目一定有内容可显示）。
 */
function snippetOf(body: string | null | undefined, terms: string[], fallback: string): string {
  const raw = squash(body ?? '');
  if (!raw) return highlight(squash(fallback), terms);
  const lower = raw.toLowerCase();
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  if (at < 0) return raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
  const start = Math.max(0, at - 30);
  const end = Math.min(raw.length, at + len + 30);
  const text = `${start > 0 ? '…' : ''}${raw.slice(start, end)}${end < raw.length ? '…' : ''}`;
  return highlight(text, terms);
}

/* ============================== SQL 小工具 ============================== */

/** LIKE 里的转义字符。SQLite 只认单字符 ESCAPE，用反斜杠 */
const LIKE_ESC = '\\';

/** 把用户输入变成 LIKE 模式：`%` `_` `\` 全部转义，其余原样 */
function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => `${LIKE_ESC}${c}`);
  return `%${escaped}%`;
}

/**
 * 拼一段 `(col LIKE ? ESCAPE '\' OR col2 LIKE ? ESCAPE '\')`。
 * 返回值里 `patterns` 的顺序与 SQL 里的 `?` 一一对应，调用方按顺序摊平即可。
 */
function likeOr(columns: string[], terms: string[]): { sql: string; patterns: string[] } {
  const parts: string[] = [];
  const patterns: string[] = [];
  for (const col of columns) {
    const ors = terms.map(() => `${col} LIKE ? ESCAPE '${LIKE_ESC}'`);
    parts.push(`(${ors.join(' OR ')})`);
    for (const _t of terms) patterns.push(likePattern(_t));
  }
  return { sql: parts.join(' OR '), patterns };
}

/**
 * 查询词 → 词表。
 * 按空白切开，再为每个词保留「原形 + 去掉首尾标点」两种形态（去重）。
 * 标点本身不当词（搜「、」不该命中一切）；FTS 的 MATCH 表达式由 `buildMatch` 单独生成。
 */
export function queryTerms(query: string): string[] {
  const out = new Set<string>();
  for (const raw of query.trim().split(/\s+/)) {
    const t = raw.toLowerCase();
    if (!t) continue;
    out.add(t);
    const stripped = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (stripped) out.add(stripped);
  }
  // 单字查询也允许（界面要求 2 个字才发请求，但接口本身不该拒绝）
  return [...out].filter((t) => t.length > 0).slice(0, 8);
}

/**
 * 排序：分数降序 → 更新时间降序（同分按更新时间倒序 → 再按 id 倒序保证稳定）。
 * 时间用 ISO 字符串直接比较即可（本项目所有时间列都是同一种 `strftime('%Y-%m-%dT%H:%M:%fZ')` 形态）。
 *
 * 排序键统一是 `${kind}#${id}`。`position` 一域里既有阶段模板（`position_template.id`）
 * 又有阶段实例（`position_instance.id`），两张表的 id 各自从 1 开始，同一个 key 可能对上两条不同的记录 ——
 * 所以阶段模板用**常量空字符串**（它们本来没有 updated_at，且不是同一条记录）。
 */
function sortHits(hits: SearchHit[], atOf: Map<string, string>): SearchHit[] {
  return hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ta = atOf.get(`${a.kind}#${a.id}`) ?? '';
    const tb = atOf.get(`${b.kind}#${b.id}`) ?? '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return b.id - a.id;
  });
}

/* ============================== 各域检索 ============================== */

function searchWorkbenches(terms: string[], pool: number, atOf: Map<string, string>): SearchHit[] {
  const like = likeOr(['w.name', 'w.code', 'w.summary', 'w.tags', 'w.folder_path', 'w.external_root'], terms);
  // 软删除守卫：回收站里的工作台不参与检索（老库无该列时 liveFilter 降级为 1=1）
  const rows = all<{
    id: number; code: string; name: string; summary: string | null; tags: string | null; folder_path: string;
    external_root: string | null; status: string; archived_at: string | null; deleted_at: string | null;
    updated_at: string; work_type_name: string | null;
  }>(
    `SELECT w.id, w.code, w.name, w.summary, w.tags, w.folder_path, w.external_root,
            w.status, w.archived_at, w.deleted_at, w.updated_at, t.name AS work_type_name
       FROM workbench w /* deleted_at IS NULL */
       LEFT JOIN work_type t ON t.id = w.work_type_id
      WHERE ${live('workbench', 'w')} AND (${like.sql})
      ORDER BY w.updated_at DESC
      LIMIT ?`,
    [...like.patterns, pool],
  );

  const hits: SearchHit[] = [];
  for (const r of rows) {
    const m = scoreRow(terms, {
      primary: [r.name],
      secondary: [r.code, r.folder_path, r.external_root],
      body: [r.summary, r.tags],
    });
    if (!m.hit) continue;
    const status = r.archived_at ? '已归档' : r.deleted_at ? '在回收站' : r.status === 'done' ? '已完成' : '进行中';
    const body = m.field === 'body' ? (r.summary ?? r.tags) : null;
    hits.push({
      kind: 'workbench',
      id: r.id,
      title: r.name,
      subtitle: [r.code, r.work_type_name, status].filter(Boolean).join(' · '),
      snippet: snippetOf(body, terms, `${r.code} ${r.name} ${r.folder_path}`),
      score: m.score,
      route: `/workbench?id=${r.id}`,
    });
    atOf.set(`workbench#${r.id}`, r.updated_at ?? '');
  }
  return hits;
}

/**
 * 文件（artifact）。
 *
 * 召回用 FTS5（`artifact_fts` 的 seg_text 里装着标题 + 摘要 + 抽取正文 + OCR 文字 + 标签），
 * 精排用原表里的**原始文本** —— FTS 存的是「逐字空格隔开」的副本，拿它做前缀/包含判断
 * 会得到错误结论（"清廉工程"在副本里是"清 廉 工 程"）。
 * 文件名不含 CJK 时也会被 `seg_name` 覆盖到，所以 LIKE 只作为 FTS 表达式为空（纯标点查询）时的兜底。
 */
function searchArtifacts(terms: string[], query: string, pool: number, atOf: Map<string, string>): SearchHit[] {
  const match = buildMatch(query, 'or');
  let rows: ArtifactRow[] = [];
  if (match) {
    try {
      rows = all<ArtifactRow>(
        `${ARTIFACT_SELECT} JOIN artifact_fts ON artifact_fts.rowid = a.id
          WHERE ${live('artifact', 'a')} AND artifact_fts MATCH ?
          ORDER BY bm25(artifact_fts, 10.0, 3.0) ASC LIMIT ?`,
        [match, pool],
      );
    } catch {
      // 万一某个词让 FTS5 语法出错（历史数据 / 特殊字符），退回 LIKE 兜底，不让整条请求 500
      rows = [];
    }
  }
  if (!rows.length) {
    const like = likeOr(['a.file_name', 'a.title'], terms);
    rows = all<ArtifactRow>(
      `${ARTIFACT_SELECT} WHERE ${live('artifact', 'a')} AND (${like.sql}) ORDER BY a.updated_at DESC LIMIT ?`,
      [...like.patterns, pool],
    );
  }

  const hits: SearchHit[] = [];
  for (const r of rows) {
    const body = r.extracted_text || r.ocr_text;
    const m = scoreRow(terms, {
      primary: [r.title],
      secondary: [r.file_name],
      body: [body, r.summary, r.tags],
    });
    if (!m.hit) continue;
    // 正文命中时优先展示正文片段，否则展示标题/文件名
    const snippet = m.field === 'body' ? snippetOf(body ?? r.summary ?? r.tags, terms, r.title || r.file_name) : highlight(squash(r.title || r.file_name), terms);
    const wb = r.workbench_name ? `${r.workbench_name}` : null;
    hits.push({
      kind: 'artifact',
      id: r.id,
      title: r.title || r.file_name,
      subtitle: [r.file_name, wb, r.deleted_at ? '在回收站' : null].filter(Boolean).join(' · '),
      snippet,
      score: m.score,
      route: `/files?artifact=${r.id}`,
    });
    atOf.set(`artifact#${r.id}`, r.updated_at ?? '');
  }
  return hits;
}

interface ArtifactRow {
  id: number;
  title: string;
  file_name: string;
  summary: string | null;
  tags: string | null;
  extracted_text: string | null;
  ocr_text: string | null;
  deleted_at: string | null;
  updated_at: string | null;
  workbench_id: number | null;
  workbench_name: string | null;
}

/** 文件表的公共列。软删除守卫在 WHERE 里由 `live('artifact','a')` 现算（deleted_at IS NULL） */
const ARTIFACT_SELECT = `SELECT a.id, a.title, a.file_name, a.summary, a.tags, a.extracted_text, a.ocr_text,
            a.deleted_at, a.updated_at, a.workbench_id, w.name AS workbench_name
       FROM artifact a /* deleted_at IS NULL */
       LEFT JOIN workbench w ON w.id = a.workbench_id`;

/**
 * 模板。
 *
 * 覆盖名称 / 编号 / 文号 / 说明 / 用途，外加**变量别名**（archive_alias.var_name：
 * 模板里写 `{甲方名称}` 这种变量名，用户常常只记得变量名）。
 * 归档模板默认**包含**，副标题里标「已归档」—— 搜不到东西时最容易被误判成"模板丢了"。
 */
function searchTemplates(terms: string[], pool: number, atOf: Map<string, string>): SearchHit[] {
  const like = likeOr(['t.name', 't.code', 't.doc_no', 't.description', 't.usage_note', 't.file_rel'], terms);
  // 软删除守卫：回收站里的变量别名不再参与召回与展示（archive_alias 上确实有 deleted_at）
  const aliasGuard = live('archive_alias', 'al'); // deleted_at IS NULL
  /** 变量别名：SELECT 里取回展示/打分，WHERE 里负责把它们也纳入召回 */
  const aliasMatch = (): string =>
    terms
      .map(() => `EXISTS (SELECT 1 FROM archive_alias al /* deleted_at IS NULL */ WHERE ${aliasGuard} AND (al.work_type_id IS NULL OR al.work_type_id = t.work_type_id) AND al.var_name LIKE ? ESCAPE '${LIKE_ESC}')`)
      .join(' OR ') || '0';
  const aliasSelect = terms.map(() => `al.var_name LIKE ? ESCAPE '${LIKE_ESC}'`).join(' OR ') || '0';
  const rows = all<{
    id: number; code: string; name: string; doc_no: string | null; description: string | null;
    usage_note: string | null; file_rel: string; file_format: string; archived_at: string | null;
    updated_at: string; work_type_name: string | null; alias_names: string | null;
  }>(
    `SELECT t.id, t.code, t.name, t.doc_no, t.description, t.usage_note, t.file_rel, t.file_format,
            t.archived_at, t.updated_at, wt.name AS work_type_name,
            (SELECT group_concat(al.var_name, ' ') FROM archive_alias al /* deleted_at IS NULL */
              WHERE ${aliasGuard} AND (al.work_type_id IS NULL OR al.work_type_id = t.work_type_id) AND (${aliasSelect})
            ) AS alias_names
       FROM template t
       LEFT JOIN work_type wt ON wt.id = t.work_type_id
      WHERE (${like.sql}) OR (${aliasMatch()})
      ORDER BY t.updated_at DESC
      LIMIT ?`,
    // 参数顺序必须与 SQL 里的 ? 出现顺序逐字对应：
    // SELECT 子查询的别名 LIKE → WHERE 主字段 LIKE → WHERE 别名 EXISTS → LIMIT
    [...terms.map(likePattern), ...like.patterns, ...terms.map(likePattern), pool],
  );

  const hits: SearchHit[] = [];
  for (const r of rows) {
    const m = scoreRow(terms, {
      primary: [r.name],
      secondary: [r.code, r.doc_no, r.alias_names],
      body: [r.description, r.usage_note],
    });
    if (!m.hit) continue;
    const body = m.field === 'body' ? (r.description ?? r.usage_note) : null;
    hits.push({
      kind: 'template',
      id: r.id,
      title: r.name,
      subtitle: [r.code, r.work_type_name, r.file_format, r.archived_at ? '已归档' : null].filter(Boolean).join(' · '),
      snippet: snippetOf(body, terms, `${r.code} ${r.name} ${r.file_rel}`),
      score: m.score,
      route: '/knowledge?module=template',
    });
    atOf.set(`template#${r.id}`, r.updated_at ?? '');
  }
  return hits;
}

/**
 * 失效文档的排除谓词（全局搜索的「制度」域）。
 *
 * 逐字照搬仓里**已经在用**的写法，让三个检索入口口径一致：
 *   `core/kb.ts:877`（语义检索 buildMatrix 取向量）、`core/kb-extract.ts:1367`（`searchKbChunks` 片段 FTS）。
 *
 * 为什么是这个谓词、而不是 `d.decision = 'active'`：
 *   1. **NULL 必须留下**：`decision` 是迁移 019（019_kb_extract.sql:49）才加的列，存量行是 NULL；
 *      手工上传那条路根本不写抽取结论 —— 可用性判据本来就认 NULL 为可用
 *      （`domain/kb-cite.ts:608`：`decision === null || 'active'`）。
 *      另外只写 `d.decision <> 'stale'` 也会把 NULL 判掉：SQLite 里 NULL 与任何值比较都是 NULL（不成立），
 *      所以 `IS NULL` 那一半不是装饰，去掉它就是把老文档全部误杀。
 *   2. **只排除 stale 这一档**：`'active'` 之外的其它历史取值照旧可搜。
 *      本轮要修的只是"已失效文档仍出现在全局搜索里"；
 *      另一侧的条款列表（`api/routes-kb.ts:1434`）用的是白名单 `IS NULL OR = 'active'`，
 *      那种写法会连带排除写过别的值的在用文档，这里不跟它 —— 与"检索召回"最宽的一档对齐才安全。
 *   3. 用 `KB_DECISION_STALE` 常量而不是字面量：与标失效那一侧（`markKbDocumentsStale`）同源，
 *      哨兵值将来改名不会只改一半。
 *
 * 没做列探测：这一列来自迁移 019，而 `db/migrate.ts:48` 在任何迁移失败时直接抛错中止启动，
 * 进程在跑 = 这一列一定存在；上面两处同款谓词也都是直接写列名，三条路一起成立。
 */
const KB_STALE_GUARD = `(d.decision IS NULL OR d.decision <> '${KB_DECISION_STALE}')`;

/**
 * 制度（知识库文档）。
 *
 * 这个库**没有 FTS 表**（`kb_chunk` 只存正文和向量，全文靠 `kb_document` 标题 + 片段 LIKE），
 * 所以这一组是五组里唯一可能偏慢的：`kb_document` 为空时天然返回空，不产生任何扫描。
 * 命中片段取 `kb_chunk.seq` 最小的那条，且每篇文档只出一行（一个文档一行 = 天然去重）。
 *
 * 失效文档（`decision='stale'`）整篇不参与 —— 见上面 `KB_STALE_GUARD` 的注释。
 * 只需要加在主查询上：`kb_chunk` 的两个相关子查询都按 `d.id` 关联，
 * 外层这一行被剔掉之后子查询根本不会被执行，不必在片段层面重复过滤。
 */
function searchKb(terms: string[], pool: number, atOf: Map<string, string>): SearchHit[] {
  const like = likeOr(['d.title', 'd.doc_type', 'd.source', 'a.file_name'], terms);
  const chunkMatch = (alias: string): string => terms.map(() => `${alias}.content LIKE ? ESCAPE '${LIKE_ESC}'`).join(' OR ') || '0';
  const chunkExists = terms
    .map(() => `EXISTS (SELECT 1 FROM kb_chunk c4 WHERE c4.document_id = d.id AND c4.content LIKE ? ESCAPE '${LIKE_ESC}')`)
    .join(' OR ') || '0';
  const rows = all<{
    id: number; title: string; doc_type: string | null; source: string | null; chunk_count: number;
    created_at: string; artifact_id: number | null; artifact_title: string | null; file_name: string | null;
    workbench_id: number | null; body: string | null; body_hits: number;
  }>(
    `SELECT d.id, d.title, d.doc_type, d.source, d.chunk_count, d.created_at, d.artifact_id,
            a.title AS artifact_title, a.file_name, a.workbench_id,
            (SELECT c2.content FROM kb_chunk c2 WHERE c2.document_id = d.id AND (${chunkMatch('c2')}) ORDER BY c2.seq LIMIT 1) AS body,
            (SELECT COUNT(*) FROM kb_chunk c3 WHERE c3.document_id = d.id AND (${chunkMatch('c3')})) AS body_hits
       FROM kb_document d
       LEFT JOIN artifact a ON a.id = d.artifact_id
      WHERE ${KB_STALE_GUARD} AND ((${like.sql}) OR (${chunkExists}))
      ORDER BY d.id DESC
      LIMIT ?`,
    // 参数顺序与 ? 出现顺序一致：子查询 body → 子查询 body_hits → 主字段 LIKE → EXISTS → LIMIT
    [...terms.map(likePattern), ...terms.map(likePattern), ...like.patterns, ...terms.map(likePattern), pool],
  );

  const hits: SearchHit[] = [];
  for (const r of rows) {
    const m = scoreRow(terms, {
      primary: [r.title],
      secondary: [r.doc_type, r.source, r.file_name, r.artifact_title],
      body: [r.body],
    });
    if (!m.hit) continue;
    const subtitleBits = [r.doc_type, r.source, r.chunk_count ? `${r.chunk_count} 段` : null, r.body_hits ? `正文命中 ${r.body_hits} 处` : null];
    hits.push({
      kind: 'kb',
      id: r.id,
      title: r.title,
      subtitle: subtitleBits.filter(Boolean).join(' · '),
      snippet: snippetOf(r.body, terms, `${r.title} ${r.source ?? ''}`),
      score: m.score,
      // 知识库页不解析参数（未改动的 Knowledge.tsx），只能跳到页面本身
      route: '/knowledge',
    });
    atOf.set(`kb#${r.id}`, r.created_at ?? '');
  }
  return hits;
}

/**
 * 阶段 / 事项。
 *
 * 两张表合一域：
 *   position_template  —— 流程规范里的「阶段定义」（名称 / 编码 / 说明 / 该阶段目录名）
 *   position_instance  —— 具体工作里的「阶段实例」（名称 / 编码 / 备注，带所属工作台）
 * 实例能直接跳到它所属工作台的流程页（`/workbench?id=N&tab=flow`，参数被 Workbench.tsx 认）。
 */
function searchPositions(terms: string[], pool: number, atOf: Map<string, string>): SearchHit[] {
  const hits: SearchHit[] = [];

  const tplLike = likeOr(['p.name', 'p.code'], terms);
  const tpls = all<{
    id: number; code: string; name: string; description: string | null; folder_name: string | null;
    period_dir: string | null; archived_at: string | null; work_type_name: string | null;
  }>(
    `SELECT p.id, p.code, p.name, p.description, p.folder_name, p.period_dir, p.archived_at, wt.name AS work_type_name
       FROM position_template p
       LEFT JOIN work_type wt ON wt.id = p.work_type_id
      WHERE (${tplLike.sql})
      ORDER BY p.sort_order ASC, p.id ASC
      LIMIT ?`,
    [...tplLike.patterns, pool],
  );
  for (const r of tpls) {
    const m = scoreRow(terms, { primary: [r.name], secondary: [r.code, r.folder_name, r.period_dir], body: [r.description] });
    if (!m.hit) continue;
    hits.push({
      kind: 'position',
      id: r.id,
      title: `${r.name}（阶段规范）`,
      subtitle: ['流程规范', r.code, r.work_type_name, r.archived_at ? '已归档' : null].filter(Boolean).join(' · '),
      snippet: snippetOf(m.field === 'body' ? r.description : null, terms, `${r.code} ${r.name} ${r.folder_name ?? ''}`),
      score: m.score,
      route: '/process',
    });
    atOf.set(`position#${r.id}`, '');
  }

  const instLike = likeOr(['p.name', 'p.code', 'p.note'], terms);
  const insts = all<{
    id: number; code: string; name: string; note: string | null; status: string; deleted_at: string | null;
    updated_at: string | null; workbench_id: number; workbench_name: string | null; workbench_code: string | null;
  }>(
    `SELECT p.id, p.code, p.name, p.note, p.status, p.deleted_at, p.updated_at,
            p.workbench_id, w.name AS workbench_name, w.code AS workbench_code
       FROM position_instance p /* deleted_at IS NULL */
       LEFT JOIN workbench w ON w.id = p.workbench_id
      WHERE ${live('position_instance', 'p')} AND (${instLike.sql})
      ORDER BY p.updated_at DESC
      LIMIT ?`,
    [...instLike.patterns, pool],
  );
  for (const r of insts) {
    const m = scoreRow(terms, { primary: [r.name], secondary: [r.code], body: [r.note] });
    if (!m.hit) continue;
    const wbText = r.workbench_name ? `${r.workbench_code ?? ''} ${r.workbench_name}`.trim() : null;
    hits.push({
      kind: 'position',
      id: r.id,
      title: `${r.name}（阶段）`,
      subtitle: [wbText, r.status, r.deleted_at ? '在回收站' : null].filter(Boolean).join(' · '),
      snippet: snippetOf(r.note, terms, `${r.code} ${r.name}`),
      score: m.score,
      // 实例跳它所属工作台的流程页
      route: r.workbench_id ? `/workbench?id=${r.workbench_id}&tab=flow` : '/process',
    });
    atOf.set(`position#${r.id}`, r.updated_at ?? '');
  }
  return hits;
}

/* ============================== 软删除（迁移 015）守卫 ============================== */

/**
 * 带别名的软删除守卫；表上没有 `deleted_at` 列时（老库）降级成 `1=1`。
 *
 * 回收站里的东西**不能**被搜出来 —— "删了还能被搜到"是这套软删除最典型的翻车方式。
 * 所以本文件每一处读 `workbench` / `artifact` / `position_instance` / `archive_alias`
 * 的查询都必须带 `deleted_at IS NULL`。这里直接用 `core/trash.ts` 的 `liveFilter()`，
 * **不自己写探测**：老库（还没跑迁移 015）上 `deleted_at` 这一列不存在，
 * 硬写会 `no such column` → 整条请求 500；`liveFilter` 会返回 `1=1` 降级。
 *
 * 注：SQL 模板里紧跟 `FROM <表>` 的地方都以 `/* deleted_at IS NULL *\/` 注明了这条过滤，
 * 那是给 `scripts/check-trash-guards.mjs` 看的 —— 它按"读点 ±2 行内是否出现该字面量"判断。
 */
function live(table: string, alias: string): string {
  return table === 'artifact' ? visibleArtifactFilter(alias) : liveFilter(table, alias);
}

/* ============================== 对外入口 ============================== */

/**
 * 全局搜索。
 *
 * @param query 关键词。空（或全是标点切不出词）→ 返回 `groups: []`，**不进任何 SQL**。
 * @param opts.kinds 只查这些域；不传/传空 = 全部。认不出的值忽略，全都不认识时按"全部"处理。
 * @param opts.limitPerKind 每域返回条数，1-50，缺省 8。
 */
export function searchAll(query: string, opts: SearchAllOptions = {}): SearchResult {
  const started = Date.now();
  const text = (query ?? '').slice(0, MAX_QUERY_LEN).trim();
  const limit = Math.min(Math.max(Math.floor(opts.limitPerKind ?? DEFAULT_LIMIT_PER_KIND), 1), MAX_LIMIT_PER_KIND);

  const requested = (opts.kinds ?? []).filter((k) => (ALL_KINDS as string[]).includes(k)) as SearchHit['kind'][];
  const kinds = requested.length ? requested : ALL_KINDS;

  const terms = queryTerms(text);
  // 空查询 / 纯标点查询：直接回空分组。绝不能让空 MATCH 或 '%%' 进 SQL。
  if (!text || !terms.length) {
    return { query: text, total: 0, groups: [], elapsedMs: Date.now() - started };
  }

  const pool = Math.min(Math.max(limit * 6, 60), POOL_MAX);
  const atOf = new Map<string, string>();

  const collected: Record<string, SearchHit[]> = {};
  if (kinds.includes('workbench')) collected.workbench = searchWorkbenches(terms, pool, atOf);
  if (kinds.includes('artifact')) collected.artifact = searchArtifacts(terms, text, pool, atOf);
  if (kinds.includes('template')) collected.template = searchTemplates(terms, pool, atOf);
  if (kinds.includes('kb')) collected.kb = searchKb(terms, pool, atOf);
  if (kinds.includes('position')) collected.position = searchPositions(terms, pool, atOf);

  const groups = SEARCH_KINDS.filter((k) => kinds.includes(k.kind)).map((k) => {
    const sorted = sortHits(collected[k.kind] ?? [], atOf);
    // count 与 hits 长度一致：界面上「每组标题带数量」点开就该看到这么多条，
    // 报一个更大的总数却没有"加载更多"的入口只会让人以为丢结果。
    const hits = sorted.slice(0, limit);
    return { kind: k.kind as string, label: k.label, count: hits.length, hits };
  });

  return {
    query: text,
    total: groups.reduce((n, g) => n + g.count, 0),
    groups,
    elapsedMs: Date.now() - started,
  };
}

export interface SuggestItem {
  kind: string;
  label: string;
  id: number;
  title: string;
  subtitle: string;
  route: string;
}

/**
 * 轻量联想：给输入框实时提示用，最多 8 条标题。
 *
 * 只查快域（工作台 / 模板 / 阶段），刻意**不碰 artifact 与 kb**：
 * 那两个域要读抽取正文，用户在输入框里每敲一个字都跑一遍会把库读热，得不偿失。
 * 排序仍然是全局分数序（标题命中优先），不按域拆开。
 */
export function suggestAll(query: string, max = 8): SuggestItem[] {
  const text = (query ?? '').slice(0, MAX_QUERY_LEN).trim();
  if (!text) return [];
  const cap = Math.min(Math.max(Math.floor(max), 1), 20);
  const r = searchAll(text, { kinds: ['workbench', 'template', 'position'], limitPerKind: cap });
  // searchAll 已经做过「分数 → 时间」排序，逐组取的时候保持这个顺序即可（组顺序 = 域固定顺序）
  return r.groups
    .flatMap((g) => g.hits.map((h) => ({ kind: h.kind as string, label: LABEL_OF.get(h.kind) ?? g.label, id: h.id, title: h.title, subtitle: h.subtitle, route: h.route, score: h.score })))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map(({ score: _score, ...rest }) => rest);
}
