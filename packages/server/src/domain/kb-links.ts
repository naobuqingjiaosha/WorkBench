/**
 * 文书 ↔ 制度双链（B3-10）
 *
 * 解决的问题（docs/11 §B3-10）：这份文书依据的是哪几条制度？制度改了，哪些文书要跟着复核？
 *
 * 三件事，都不调模型、全部确定性：
 *
 * 一、**写链**（`syncArtifactLinks` / `linkManual`）
 *   · 自动链的**解析一律复用 B3-9**：条号解析（`parseCitations`）、制度定位（`resolveCitation`）、
 *     条款路径匹配（`matchClausePath`）都在 `domain/kb-cite.ts` 里，这里**一行解析逻辑都没有**——
 *     引用这件事只能有一套算法，否则"校验时对得上、链接时对不上"是必然的。
 *     自动链的落点也很省事：口径校验的 preHandler 已经把 `ResolvedCitation[]` 算好了挂在请求上
 *     （`__wbCompliance`），保存成功时直接拿它写链，不重复解包 docx。
 *   · 人工链（`manual`）：制度 + 条款由人给，走 `lookupClause` 核到具体片段再落库，留下 `created_by`。
 *   · 软删（`deleted_at`）而不是 DELETE：取消过的链接要能看出"曾经连过、谁在什么时候拿掉的"。
 *
 * 二、**读链**（`listArtifactLinks` 正查 / `listDocumentUsages` 反查）
 *   · 【软删除口径，本次明确选它并写进回复】**读时过滤掉已删对象，但链接行一律保留**：
 *     - 反查（制度 → 文书）过滤掉**回收站里的文书**（`artifact.deleted_at IS NOT NULL`）
 *       与回收站里工作台下的文书 —— docs/11 B3-10 验收⑤要的就是这个（与 B1-1 口径贯通）；
 *     - 正查（文书 → 制度）过滤掉**已经不在知识库里的制度**（物理删/被口径清理掉的），
 *       但这类链接不删行、单独计入 `staleCount`，并给出 `document_missing` 理由；
 *     - 制度"移除了又按同一路径重新入库"时按 `kb_rel_path` **自动认回**（`recovered: true`）。
 *     理由：链接是"当时确实引用过"的**事实**，删掉它等于篡改历史；而"现在还成不成立"是**判断**，
 *     判断应该发生在读的时候。用软删口径还能让回收站恢复（清空 deleted_at）之后链接原样回来。
 *
 * 三、**变更影响**（`documentImpact` / `pendingImpacts`）
 *   · **选了"自动判差异"，但判据是条款文本哈希（`clause_sha256`），不是逐字 diff**：
 *     制度文件 sha256 没变 → 直接判"没变"；变了 → 逐条把**当前**该条正文按同一套归一化
 *     算哈希，与建链时存的比：不同 = `changed`、找不到该条 = `clause_removed`、
 *     相同 = `unchanged`。三态都是**事实**，不掺"看起来改了什么"的猜测。
 *   · 每一行受影响记录都附上**该条款的当前正文**（`currentText`）与建链时的原文（`quote`），
 *     到底改了什么由人自己看 —— 不做 docx 级内容 diff（docs/11 §9 明确不做，XML 噪声会淹没真改动）。
 *   · 读点是**现算**（几毫秒），`kb_change_impact` 只写历史留痕、不当缓存读 ——
 *     缓存一旦不失效就会出现"缓存说没变、实际变了"，那是本项最不能接受的错。
 */
import { all, get, run, tx } from '../db/index.ts';
import { CLAUSE_PATH_SEP } from '../core/kb.ts';
import { sha256Hex } from '../core/kb-extract.ts';
import { liveFilter } from '../core/trash.ts';
import { matchClausePath, clauseNoOfSegment, subNoOfSegment, parseClauseSpec, type ResolvedCitation } from './kb-cite.ts';

/* ============================================================================
 * 类型
 * ==========================================================================*/

export type LinkKind = 'explicit' | 'suggested' | 'manual';
export const LINK_KINDS: readonly LinkKind[] = ['explicit', 'suggested', 'manual'];

export interface DocKbLinkRow {
  id: number;
  artifact_id: number;
  kb_document_id: number | null;
  kb_rel_path: string | null;
  kb_chunk_id: number | null;
  clause_path: string | null;
  link_kind: LinkKind;
  confidence: number | null;
  quote: string | null;
  clause_sha256: string | null;
  doc_sha256: string | null;
  raw_cite: string | null;
  created_at: string;
  created_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  delete_reason: string | null;
}

interface KbDocRow {
  id: number;
  title: string;
  doc_no: string | null;
  rel_path: string | null;
  scope_layer: string | null;
  version_status: string | null;
  decision: string | null;
  doc_sha256: string | null;
  source_id: number | null;
}

const LINK_COLS = `id, artifact_id, kb_document_id, kb_rel_path, kb_chunk_id, clause_path, link_kind,
                   confidence, quote, clause_sha256, doc_sha256, raw_cite, created_at, created_by,
                   deleted_at, deleted_by, delete_reason`;

/* ============================================================================
 * 小工具：归一化与哈希
 * ==========================================================================*/

/** 条款正文归一化：只去空白（**两边必须用同一个函数**，否则哈希比对就是假的） */
export function normClauseText(text: string | null | undefined): string {
  return String(text ?? '').replace(/\s+/g, '').trim();
}

/** 条款正文哈希：判"这条改了没有"的唯一依据 */
export function clauseHash(text: string | null | undefined): string {
  return sha256Hex(normClauseText(text));
}

function prettyPath(path: string | null): string | null {
  if (!path) return null;
  return path
    .split(CLAUSE_PATH_SEP)
    .map((s) => s.trim().replace(/[。；;]+$/, ''))
    .filter(Boolean)
    .join(CLAUSE_PATH_SEP);
}

/** 条款路径里属于某条的那一段（`第二章 … > 第五条 检查频次` → `第五条 检查频次`） */
export function clauseLabelOf(path: string | null, clausePath: string | null): string | null {
  if (!path) return clausePath;
  const segs = path.split(CLAUSE_PATH_SEP).map((s) => s.trim().replace(/[。；;]+$/, '')).filter(Boolean);
  if (!segs.length) return null;
  const spec = parseClauseSpec(clausePath ?? '');
  return segs.find((s) => matchClausePath(s, spec)) ?? segs[segs.length - 1] ?? null;
}

function quoteOf(text: string, max = 300): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function nowSql(): string {
  return "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
}

/* ============================================================================
 * 一、写链
 * ==========================================================================*/

export interface SyncResult {
  /** 新加的自动链接 */
  added: number;
  /** 之前软删过、这次正文里又出现，恢复的行 */
  revived: number;
  /** 已经在了，原地保留（幂等的证据） */
  kept: number;
  /** 正文里已不再引用，本轮软删的行 */
  retired: number;
  /** 没解析到条款的引用（悬空/未入库）—— 只报数，**不建链**（防"乱连"） */
  unresolved: number;
}

/**
 * 保存文书时同步自动链接（`link_kind='explicit'`）。
 *
 * 只处理 `status==='resolved'` 的引用：解析不到具体条款的引用（制度没入库、条号写错、重名）
 * **不建链** —— 链接必须是"核到过"的，否则反查就会把不相干的文书算进影响面。
 * 人工链（manual）与建议链（suggested）**不动**：自动同步不能删人加的东西。
 */
export function syncArtifactLinks(input: {
  artifactId: number;
  citations: ResolvedCitation[];
  actor?: string | null;
}): SyncResult {
  const artifactId = Number(input.artifactId);
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error(`无效的文书 id：${input.artifactId}`);

  // 同一次保存里同一处引用可能出现多次（模板正文 + 变量值），按 制度+条款 去重
  const desired = new Map<string, ResolvedCitation>();
  let unresolved = 0;
  for (const c of input.citations ?? []) {
    if (c.status === 'resolved' && c.hit) {
      const key = `${c.hit.documentId}|${normClauseText(c.hit.clausePath ?? '')}`;
      if (!desired.has(key)) desired.set(key, c);
    } else if (['document_missing', 'ambiguous', 'clause_missing', 'superseded'].includes(c.status)) {
      unresolved += 1;
    }
  }

  const result: SyncResult = { added: 0, revived: 0, kept: 0, retired: 0, unresolved };
  const live = all<DocKbLinkRow>(
    `SELECT ${LINK_COLS} FROM doc_kb_link WHERE artifact_id = ? AND link_kind = 'explicit' AND deleted_at IS NULL`,
    [artifactId],
  );
  const liveByKey = new Map(live.map((r) => [`${r.kb_document_id ?? `rel:${r.kb_rel_path ?? ''}`}|${normClauseText(r.clause_path ?? '')}`, r]));

  tx(() => {
    const touched = new Set<number>();
    for (const cite of desired.values()) {
      const hit = cite.hit!;
      const key = `${hit.documentId}|${normClauseText(hit.clausePath ?? '')}`;
      const meta = kbDocRow(hit.documentId);
      // 已经有一条活链接：**原地保留**（幂等）；只有明显缺字段时才补，不重写哈希
      const existed = liveByKey.get(key);
      const soft = get<{ id: number }>(
        `SELECT id FROM doc_kb_link WHERE artifact_id = ? AND link_kind = 'explicit' AND deleted_at IS NOT NULL
           AND clause_path = ? AND (kb_document_id = ? OR (kb_document_id IS NULL AND kb_rel_path = ?))
         ORDER BY id DESC LIMIT 1`,
        [artifactId, hit.clausePath, hit.documentId, meta?.rel_path ?? null],
      );
      if (existed) {
        touched.add(existed.id);
        result.kept += 1;
        continue;
      }
      const payload = {
        kbDocumentId: hit.documentId,
        relPath: meta?.rel_path ?? null,
        chunkId: hit.chunkIds[0] ?? null,
        clausePath: hit.clausePath,
        quote: hit.quote,
        clauseSha: clauseHash(hit.content),
        docSha: hit.docSha256 ?? meta?.doc_sha256 ?? null,
        rawCite: cite.raw,
        actor: input.actor ?? null,
      };
      if (soft) {
        run(
          `UPDATE doc_kb_link SET kb_document_id = ?, kb_rel_path = ?, kb_chunk_id = ?, quote = ?, clause_sha256 = ?,
             doc_sha256 = ?, raw_cite = ?, confidence = 1, deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
           WHERE id = ?`,
          [payload.kbDocumentId, payload.relPath, payload.chunkId, payload.quote, payload.clauseSha, payload.docSha, payload.rawCite, soft.id],
        );
        result.revived += 1;
        touched.add(soft.id);
        continue;
      }
      run(
        `INSERT INTO doc_kb_link (artifact_id, kb_document_id, kb_rel_path, kb_chunk_id, clause_path, link_kind,
           confidence, quote, clause_sha256, doc_sha256, raw_cite, created_by)
         VALUES (?,?,?,?,?,'explicit',1,?,?,?,?,?)`,
        [artifactId, payload.kbDocumentId, payload.relPath, payload.chunkId, payload.clausePath, payload.quote, payload.clauseSha, payload.docSha, payload.rawCite, payload.actor],
      );
      result.added += 1;
    }

    // 正文里已经不再引用的自动链接 → 软删（**保留行**，将来又写上还能恢复）
    for (const r of live) {
      if (touched.has(r.id)) continue;
      run(
        `UPDATE doc_kb_link SET deleted_at = ${nowSql()}, deleted_by = ?, delete_reason = ?
          WHERE id = ? AND deleted_at IS NULL`,
        [input.actor ?? null, '自动同步：这份文书的正文里已不再引用该条款（改回引用会自动恢复）', r.id],
      );
      result.retired += 1;
    }
  });

  return result;
}

function kbDocRow(id: number): KbDocRow | null {
  return (
    get<KbDocRow>('SELECT id, title, doc_no, rel_path, scope_layer, version_status, decision, doc_sha256, source_id FROM kb_document WHERE id = ?', [id]) ??
    null
  );
}

/** 人工加链：给制度 + 条款，核到具体片段再落库（核不到就报错，绝不建"空链接"） */
export function linkManual(input: {
  artifactId: number;
  kbDocumentId?: number | null;
  clausePath: string;
  actor?: string | null;
  confidence?: number | null;
}): DocKbLinkRow {
  const artifactId = Number(input.artifactId);
  const documentId = Number(input.kbDocumentId);
  const clausePath = String(input.clausePath ?? '').trim();
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error('无效的文书 id');
  if (!Number.isSafeInteger(documentId) || documentId <= 0) throw new Error('人工建链必须指定 kbDocumentId（制度）');
  if (!clausePath) throw new Error('人工建链必须写条款（如「第五条」或条款名）');
  if (!get<{ id: number }>('SELECT id FROM artifact WHERE id = ?', [artifactId])) throw new Error(`文书不存在：#${artifactId}`);
  const doc = kbDocRow(documentId);
  if (!doc) throw new Error(`制度不存在：#${documentId}`);

  const cur = currentClause(documentId, clausePath);
  if (!cur.chunks.length) {
    const avail = availableClausePaths(documentId);
    throw new Error(
      `《${doc.title}》里核对不到「${clausePath}」${avail.length ? `，这份制度里有：${avail.slice(0, 12).join('、')}${avail.length > 12 ? ' 等' : ''}` : '（这份制度没有识别到条号，可能是通知类文件）'}`,
    );
  }
  const clause = cur.path ?? clausePath;
  const content = cur.chunks.map((c) => c.content).join('\n');
  // 幂等：同一条人工链重复加不再插一行。**按条号比对**，不按路径整串比 ——
  // 制度正文改过以后路径串会变，按整串比就会插出第二条"同一条"的人工链。
  const spec = clauseSpecOf(clause);
  const existingManual = all<DocKbLinkRow>(
    `SELECT ${LINK_COLS} FROM doc_kb_link
      WHERE artifact_id = ? AND link_kind = 'manual' AND deleted_at IS NULL
        AND (kb_document_id = ? OR kb_rel_path = ?)`,
    [artifactId, documentId, doc.rel_path],
  ).find((r) => matchClausePath(r.clause_path, spec));
  if (existingManual) return existingManual;
  const ins = run(
    `INSERT INTO doc_kb_link (artifact_id, kb_document_id, kb_rel_path, kb_chunk_id, clause_path, link_kind,
       confidence, quote, clause_sha256, doc_sha256, raw_cite, created_by)
     VALUES (?,?,?,?,?,'manual',?,?,?,?,?,?)`,
    [
      artifactId,
      documentId,
      doc.rel_path,
      cur.chunks[0]?.id ?? null,
      clause,
      input.confidence ?? 1,
      quoteOf(content),
      clauseHash(content),
      doc.doc_sha256,
      `《${doc.title}》${clauseLabelOf(clause, clause) ?? clause}`,
      input.actor ?? null,
    ],
  );
  return get<DocKbLinkRow>(`SELECT ${LINK_COLS} FROM doc_kb_link WHERE id = ?`, [ins.lastInsertRowid]) as DocKbLinkRow;
}

/** 软删一条链接（人工取消 / 自动同步）；已经是删掉的就报错，避免"点了没反应" */
export function softDeleteLink(id: number, opts: { actor?: string | null; reason?: string | null } = {}): DocKbLinkRow {
  const row = get<DocKbLinkRow>(`SELECT ${LINK_COLS} FROM doc_kb_link WHERE id = ?`, [id]);
  if (!row) throw new Error(`链接不存在：#${id}`);
  if (row.deleted_at) throw new Error(`这条链接已经在 ${row.deleted_at} 被取消了`);
  run(`UPDATE doc_kb_link SET deleted_at = ${nowSql()}, deleted_by = ?, delete_reason = ? WHERE id = ?`, [
    opts.actor ?? null,
    opts.reason ?? '人工取消',
    id,
  ]);
  return get<DocKbLinkRow>(`SELECT ${LINK_COLS} FROM doc_kb_link WHERE id = ?`, [id]) as DocKbLinkRow;
}

/* ============================================================================
 * 二、条款正文：当前文本（与 kb-cite 的路径匹配同一套判断）
 * ==========================================================================*/

interface ChunkRow {
  id: number;
  seq: number;
  clause_path: string | null;
  content: string;
}

/**
 * 定位"现在的"那一条条款的匹配条件 —— **先按条号，没有条号才退回路径/名称匹配**。
 *
 * 为什么必须先按条号：制度里"一条一行"的写法会让 `clause_path` 把**整句正文**吃进去
 * （`第二章 检查要求 > 第五条 现场安全检查频次不得低于每月两次…`）。如果按路径整段做
 * 子串匹配，**这条正文一改就匹配不上**，影响面会误报成"这一条没了"（自检实测踩到：
 * 把"每月两次"改成"每月四次"后 status 判成 clause_removed 而不是 changed）。
 * 条号（`第五条`）才是条款的身份，正文是会变的。
 */
function clauseSpecOf(storedPath: string): ReturnType<typeof parseClauseSpec> {
  const segs = String(storedPath ?? '')
    .split(CLAUSE_PATH_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const seg of segs) {
    if (clauseNoOfSegment(seg) !== null) {
      return { no: clauseNoOfSegment(seg), subNo: subNoOfSegment(seg), segments: [], raw: seg };
    }
  }
  return parseClauseSpec(storedPath);
}

function currentClause(documentId: number, clausePath: string): { chunks: ChunkRow[]; path: string | null } {
  const spec = clauseSpecOf(clausePath);
  const rows = all<ChunkRow>('SELECT id, seq, clause_path, content FROM kb_chunk WHERE document_id = ? ORDER BY seq, id', [documentId]);
  const chunks = rows.filter((r) => matchClausePath(r.clause_path, spec));
  return { chunks, path: chunks[0]?.clause_path ?? null };
}

export function availableClausePaths(documentId: number): string[] {
  const rows = all<{ path: string | null }>('SELECT DISTINCT clause_path AS path FROM kb_chunk WHERE document_id = ? AND clause_path IS NOT NULL', [documentId]);
  const out = new Set<string>();
  for (const r of rows) if (r.path) out.add(prettyPath(r.path) ?? r.path);
  return [...out];
}

/* ============================================================================
 * 三、读链：正查（文书 → 制度条款）
 * ==========================================================================*/

export interface ArtifactLinkItem {
  id: number;
  linkKind: LinkKind;
  clausePath: string | null;
  clauseLabel: string | null;
  quote: string | null;
  rawCite: string | null;
  documentId: number | null;
  documentTitle: string | null;
  docNo: string | null;
  scopeLayer: string | null;
  versionStatus: string | null;
  /** 制度现在还在不在知识库里 */
  documentLive: boolean;
  /** 制度被移除后又按同一路径重新入库，链接自动认回 */
  recovered: boolean;
  /** 制度已经不在了：这条链接**不被默认返回**，只在 staleCount / stale 里出现 */
  removed: boolean;
  /** 建链时那份制度的 sha256 与现在是否一致（null = 判不了） */
  documentChanged: boolean | null;
  createdAt: string;
  createdBy: string | null;
}

export interface ArtifactLinkResult {
  artifactId: number;
  artifactTitle: string | null;
  /** 文书自己在回收站里（正查仍返回链接：回收站页面要能看出"这份文书当初依据了什么"） */
  artifactInTrash: boolean;
  items: ArtifactLinkItem[];
  stale: ArtifactLinkItem[];
  counts: { total: number; explicit: number; manual: number; suggested: number; stale: number; changed: number };
}

interface LinkTarget {
  document: KbDocRow | null;
  recovered: boolean;
  removed: boolean;
}

/**
 * 把一条链接解析到"现在的那份制度"：
 *   ① 按 id 命中 → 正常；
 *   ② id 不在（制度被物理删/被口径清理）→ 按 `kb_rel_path` 找同路径的制度 → `recovered`；
 *   ③ 都找不到 → `removed`（链接行保留，读路径把它放到 stale 里）。
 */
function resolveLinkTarget(link: DocKbLinkRow, cache: Map<string, LinkTarget>): LinkTarget {
  const key = `${link.kb_document_id ?? 'null'}|${link.kb_rel_path ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let out: LinkTarget = { document: null, recovered: false, removed: true };
  if (link.kb_document_id) {
    const byId = kbDocRow(link.kb_document_id);
    if (byId) out = { document: byId, recovered: false, removed: false };
  }
  if (!out.document && link.kb_rel_path) {
    const byPath = get<KbDocRow>(
      'SELECT id, title, doc_no, rel_path, scope_layer, version_status, decision, doc_sha256, source_id FROM kb_document WHERE rel_path = ? ORDER BY id LIMIT 1',
      [link.kb_rel_path],
    );
    if (byPath) out = { document: byPath, recovered: true, removed: false };
  }
  cache.set(key, out);
  return out;
}

function toItem(link: DocKbLinkRow, target: LinkTarget): ArtifactLinkItem {
  const doc = target.document;
  return {
    id: link.id,
    linkKind: link.link_kind,
    clausePath: prettyPath(link.clause_path),
    clauseLabel: clauseLabelOf(link.clause_path, link.clause_path),
    quote: link.quote,
    rawCite: link.raw_cite,
    documentId: doc?.id ?? link.kb_document_id,
    documentTitle: doc?.title ?? null,
    docNo: doc?.doc_no ?? null,
    scopeLayer: doc?.scope_layer ?? null,
    versionStatus: doc?.version_status ?? null,
    documentLive: Boolean(doc),
    recovered: target.recovered,
    removed: target.removed,
    documentChanged: doc && link.doc_sha256 ? doc.doc_sha256 !== link.doc_sha256 : null,
    createdAt: link.created_at,
    createdBy: link.created_by,
  };
}

/** 正查：这份文书引用了哪些制度条款（默认不返回"制度已移除"的，见 stale） */
export function listArtifactLinks(artifactId: number, opts: { includeRemoved?: boolean; kinds?: LinkKind[] } = {}): ArtifactLinkResult {
  const a = get<{ id: number; title: string; deleted_at: string | null }>('SELECT id, title, deleted_at FROM artifact WHERE id = ?', [artifactId]);
  if (!a) throw new Error(`文书不存在：#${artifactId}`);
  const kinds = opts.kinds?.length ? opts.kinds : null;
  const rows = all<DocKbLinkRow>(
    `SELECT ${LINK_COLS} FROM doc_kb_link WHERE artifact_id = ? AND deleted_at IS NULL ${kinds ? `AND link_kind IN (${kinds.map(() => '?').join(',')})` : ''} ORDER BY id`,
    kinds ? [artifactId, ...kinds] : [artifactId],
  );
  const cache = new Map<string, LinkTarget>();
  const items: ArtifactLinkItem[] = [];
  const stale: ArtifactLinkItem[] = [];
  for (const r of rows) {
    const target = resolveLinkTarget(r, cache);
    const item = toItem(r, target);
    if (item.removed && !opts.includeRemoved) stale.push(item);
    else items.push(item);
  }
  const counts = {
    total: items.length,
    explicit: items.filter((i) => i.linkKind === 'explicit').length,
    manual: items.filter((i) => i.linkKind === 'manual').length,
    suggested: items.filter((i) => i.linkKind === 'suggested').length,
    stale: stale.length,
    changed: items.filter((i) => i.documentChanged === true).length,
  };
  return { artifactId, artifactTitle: a.title, artifactInTrash: Boolean(a.deleted_at), items, stale, counts };
}

/* ============================================================================
 * 四、读链：反查（制度 / 条款 → 文书）
 * ==========================================================================*/

export interface UsageItem {
  linkId: number;
  artifactId: number;
  artifactTitle: string;
  artifactFileRel: string | null;
  workbenchId: number | null;
  workbenchCode: string | null;
  workbenchName: string | null;
  clausePath: string | null;
  clauseLabel: string | null;
  linkKind: LinkKind;
  quote: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface UsageResult {
  documentId: number;
  documentTitle: string;
  clause: string | null;
  items: UsageItem[];
  total: number;
  /** 回收站里因此**没被算进来**的文书数（口径透明：不是漏，是按软删口径排除的） */
  inTrash: number;
  byClause: { clausePath: string | null; clauseLabel: string | null; n: number }[];
  byKind: { explicit: number; manual: number; suggested: number };
}

interface RawUsageRow {
  artifactId: number;
  artifactTitle: string;
  artifactFileRel: string | null;
  artifactDeleted: string | null;
  workbenchId: number | null;
  workbenchCode: string | null;
  workbenchName: string | null;
  workbenchDeleted: string | null;
}

/**
 * 反查：哪些文书引用了这份制度（可再按条款过滤）。
 *
 * 包含两类链接行：`kb_document_id = 这份制度`，以及 `kb_document_id` 已失效但 `kb_rel_path`
 * 与这份制度相同的（制度被移除后重新入库的情形）。**回收站里的文书不计入**（软删口径），
 * 但排除掉多少条要如实回报（`inTrash`）—— 免得看起来像漏算。
 */
export function listDocumentUsages(documentId: number, opts: { clausePath?: string | null; includeTrashed?: boolean; limit?: number } = {}): UsageResult {
  const doc = kbDocRow(documentId);
  if (!doc) throw new Error(`制度不存在：#${documentId}`);
  const links = all<DocKbLinkRow>(
    `SELECT ${LINK_COLS} FROM doc_kb_link
      WHERE deleted_at IS NULL AND (kb_document_id = ? OR (kb_rel_path IS NOT NULL AND kb_rel_path = ?))
      ORDER BY id DESC`,
    [documentId, doc.rel_path],
  );
  const cache = new Map<string, LinkTarget>();
  const live: UsageItem[] = [];
  let inTrash = 0;
  const byClause = new Map<string, { clausePath: string | null; clauseLabel: string | null; n: number }>();
  const byKind = { explicit: 0, manual: 0, suggested: 0 };
  const seenArtifactClause = new Set<string>();
  for (const link of links) {
    // 同一份制度可能有多个 id（重新入库）：只认能解析回这份制度的链接
    if (resolveLinkTarget(link, cache).document?.id !== doc.id) continue;
    if (opts.clausePath && !matchClausePath(link.clause_path, clauseSpecOf(opts.clausePath))) continue;
    const a = get<RawUsageRow>(
      `SELECT a.id AS artifactId, a.title AS artifactTitle, a.file_rel AS artifactFileRel, a.deleted_at AS artifactDeleted,
              w.id AS workbenchId, w.code AS workbenchCode, w.name AS workbenchName, w.deleted_at AS workbenchDeleted
         FROM artifact a LEFT JOIN workbench w ON w.id = a.workbench_id
        WHERE a.id = ?`,
      [link.artifact_id],
    );
    if (!a) continue; // 文书被彻底删除：链接行保留，但反查里没有它
    if (a.artifactDeleted || a.workbenchDeleted) {
      inTrash += 1;
      if (!opts.includeTrashed) continue;
    }
    // 同一份文书对同一条款的多个来源（auto + manual）都算引用，但 byClause 计数按文书去重更直观
    const uniq = `${a.artifactId}|${link.clause_path ?? ''}`;
    if (!seenArtifactClause.has(uniq)) {
      seenArtifactClause.add(uniq);
      const key = link.clause_path ?? '';
      const g = byClause.get(key);
      if (g) g.n += 1;
      else byClause.set(key, { clausePath: prettyPath(link.clause_path), clauseLabel: clauseLabelOf(link.clause_path, link.clause_path), n: 1 });
    }
    byKind[link.link_kind] += 1;
    live.push({
      linkId: link.id,
      artifactId: a.artifactId,
      artifactTitle: a.artifactTitle,
      artifactFileRel: a.artifactFileRel,
      workbenchId: a.workbenchId,
      workbenchCode: a.workbenchCode,
      workbenchName: a.workbenchName,
      clausePath: prettyPath(link.clause_path),
      clauseLabel: clauseLabelOf(link.clause_path, link.clause_path),
      linkKind: link.link_kind,
      quote: link.quote,
      createdAt: link.created_at,
      createdBy: link.created_by,
    });
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
  return {
    documentId: doc.id,
    documentTitle: doc.title,
    clause: opts.clausePath ?? null,
    items: live.slice(0, limit),
    total: live.length,
    inTrash,
    byClause: [...byClause.values()].sort((a, b) => b.n - a.n),
    byKind,
  };
}

/* ============================================================================
 * 五、变更影响
 * ==========================================================================*/

export type ClauseStatus = 'changed' | 'unchanged' | 'clause_removed' | 'document_missing' | 'not_indexed' | 'unknown';

export interface ImpactItem {
  linkId: number;
  artifactId: number;
  artifactTitle: string;
  workbenchCode: string | null;
  workbenchName: string | null;
  clausePath: string | null;
  clauseLabel: string | null;
  linkKind: LinkKind;
  status: ClauseStatus;
  /** 人话理由（界面直接显示） */
  reason: string;
  /** 建链时的原文片段 */
  quote: string | null;
  /** 该条款**现在的**正文（就是"让人自己看"的那一份；找不到则为 null） */
  currentText: string | null;
  createdAt: string;
  inTrash: boolean;
}

export interface ImpactResult {
  documentId: number;
  documentTitle: string;
  docNo: string | null;
  /** 制度文件整体（sha256）是否变了 */
  documentChanged: boolean;
  storedHashes: string[];
  currentHash: string | null;
  /** 判据说明：明确"没做逐字 diff" */
  basis: string;
  affected: ImpactItem[];
  unchanged: number;
  inTrash: number;
  counts: { affectedArtifacts: number; changed: number; clauseRemoved: number; notIndexed: number };
}

function classify(link: DocKbLinkRow, doc: KbDocRow): { status: ClauseStatus; reason: string; currentText: string | null } {
  if (doc.decision && doc.decision !== 'active') {
    return {
      status: 'not_indexed',
      reason: `《${doc.title}》按当前抽取口径没有入库（结论：${doc.decision}）—— 这份文书的依据现在已经核不到了，需要复核`,
      currentText: null,
    };
  }
  if (link.clause_path) {
    const cur = currentClause(doc.id, link.clause_path);
    if (!cur.chunks.length) {
      return {
        status: 'clause_removed',
        reason: `这条引用的「${clauseLabelOf(link.clause_path, link.clause_path) ?? link.clause_path}」在新的制度内容里已经找不到了`,
        currentText: null,
      };
    }
    const text = cur.chunks.map((c) => c.content).join('\n').trim();
    if (link.clause_sha256 && clauseHash(text) !== link.clause_sha256) {
      return { status: 'changed', reason: '这一条的正文与建链时不一致（按归一化文本哈希判定，不是逐字 diff）', currentText: quoteOf(text, 400) };
    }
    return { status: 'unchanged', reason: '这一条的正文没变', currentText: text };
  }
  // 没有条款路径的链接（理论上不该有：写链只写核到条款的）：只能按制度整体判断
  return {
    status: 'unknown',
    reason: '这条链接没有条款路径，无法判断具体哪一条变了（只能看制度整体哈希）',
    currentText: null,
  };
}

/**
 * 一份制度的变更影响：哪些文书要复核、为什么。
 *
 * 读点是**现算**（不读 kb_change_impact 缓存，理由见文件头）。算完如果"文件确实变了且有受影响文书"，
 * 会往 `kb_change_impact` 写一行**历史留痕**（谁在什么时候算出什么结论），供审计追溯。
 */
export function documentImpact(documentId: number): ImpactResult {
  const doc = kbDocRow(documentId);
  if (!doc) throw new Error(`制度不存在：#${documentId}`);
  const links = all<DocKbLinkRow>(
    `SELECT ${LINK_COLS} FROM doc_kb_link
      WHERE deleted_at IS NULL AND (kb_document_id = ? OR (kb_rel_path IS NOT NULL AND kb_rel_path = ?))
      ORDER BY id`,
    [documentId, doc.rel_path],
  );
  const cache = new Map<string, LinkTarget>();
  const resolved = links.filter((l) => resolveLinkTarget(l, cache).document?.id === doc.id);
  const storedHashes = [...new Set(resolved.map((l) => l.doc_sha256).filter((h): h is string => Boolean(h)))];
  const documentChanged = storedHashes.length === 0 ? false : storedHashes.some((h) => h !== doc.doc_sha256);

  let inTrash = 0;
  const affected: ImpactItem[] = [];
  let unchanged = 0;
  for (const link of resolved) {
    const a = get<{ id: number; title: string; deleted_at: string | null; workbench_id: number | null }>(
      'SELECT id, title, deleted_at, workbench_id FROM artifact WHERE id = ?',
      [link.artifact_id],
    );
    if (!a) continue; // 文书被彻底删除：链接行保留，但影响面里没必要报
    const wb = a.workbench_id
      ? get<{ code: string | null; name: string | null; deleted_at: string | null }>('SELECT code, name, deleted_at FROM workbench WHERE id = ?', [a.workbench_id])
      : undefined;
    const trashed = Boolean(a.deleted_at) || Boolean(wb?.deleted_at);
    const c = classify(link, doc);
    if (c.status === 'unchanged') {
      unchanged += 1;
      if (trashed) inTrash += 1;
      continue;
    }
    if (trashed) {
      inTrash += 1;
      continue; // 回收站里的文书不算"要复核的文书"（软删口径），但计数要看得见
    }
    affected.push({
      linkId: link.id,
      artifactId: a.id,
      artifactTitle: a.title,
      workbenchCode: wb?.code ?? null,
      workbenchName: wb?.name ?? null,
      clausePath: prettyPath(link.clause_path),
      clauseLabel: clauseLabelOf(link.clause_path, link.clause_path),
      linkKind: link.link_kind,
      status: c.status,
      reason: c.reason,
      quote: link.quote,
      currentText: c.currentText,
      createdAt: link.created_at,
      inTrash: false,
    });
  }

  const result: ImpactResult = {
    documentId: doc.id,
    documentTitle: doc.title,
    docNo: doc.doc_no,
    documentChanged,
    storedHashes,
    currentHash: doc.doc_sha256,
    basis:
      '判据是「制度文件 sha256 + 该条款归一化正文的 sha256」（不是 docx 逐字 diff，docs/11 §9 明确不做）：' +
      '文件哈希没变 = 没变；变了则逐条比条款正文哈希，并附上该条款**现在的**正文供人核对。',
    affected,
    unchanged,
    inTrash,
    counts: {
      affectedArtifacts: new Set(affected.map((i) => i.artifactId)).size,
      changed: affected.filter((i) => i.status === 'changed').length,
      clauseRemoved: affected.filter((i) => i.status === 'clause_removed').length,
      notIndexed: affected.filter((i) => i.status === 'not_indexed').length,
    },
  };

  if (documentChanged && affected.length) {
    try {
      run(
        `INSERT INTO kb_change_impact (kb_document_id, old_sha256, new_sha256, changed_clauses, affected_artifacts)
         VALUES (?,?,?,?,?)`,
        [
          doc.id,
          storedHashes[0] ?? '',
          doc.doc_sha256 ?? '',
          JSON.stringify(affected.map((i) => ({ clausePath: i.clausePath, clauseLabel: i.clauseLabel, status: i.status }))),
          JSON.stringify(affected.slice(0, 200).map((i) => ({ artifactId: i.artifactId, title: i.artifactTitle, workbenchCode: i.workbenchCode, clausePath: i.clausePath, status: i.status }))),
        ],
      );
    } catch {
      /* 留痕失败不影响结论（历史表，不是读路径） */
    }
  }
  return result;
}

export interface PendingImpact {
  total: number;
  artifacts: number;
  documents: {
    documentId: number;
    documentTitle: string;
    docNo: string | null;
    affectedCount: number;
    changedClauses: string[];
    artifacts: { artifactId: number; title: string; workbenchCode: string | null; clausePath: string | null; status: ClauseStatus }[];
  }[];
}

/** 全库"待复核影响"：只算**文件哈希真的变了**的制度（没变的一律跳过，避免把整个库都算一遍） */
export function pendingImpacts(opts: { limit?: number } = {}): PendingImpact {
  const docIds = all<{ id: number }>(
    `SELECT DISTINCT COALESCE(l.kb_document_id, 0) AS id FROM doc_kb_link l WHERE l.deleted_at IS NULL`,
  )
    .map((r) => r.id)
    .filter((id) => id > 0);
  const out: PendingImpact['documents'] = [];
  let total = 0;
  const arts = new Set<number>();
  for (const id of docIds) {
    const doc = kbDocRow(id);
    if (!doc) continue;
    const hashes = all<{ doc_sha256: string | null }>(
      'SELECT DISTINCT doc_sha256 FROM doc_kb_link WHERE deleted_at IS NULL AND kb_document_id = ?',
      [id],
    )
      .map((r) => r.doc_sha256)
      .filter((h): h is string => Boolean(h));
    // 便宜的先判：文件哈希全都对得上 → 这份制度没动过，不用继续算
    if (!hashes.length || !hashes.some((h) => h !== doc.doc_sha256)) continue;
    const imp = documentImpact(id);
    if (!imp.affected.length) continue;
    total += imp.affected.length;
    for (const a of imp.affected) arts.add(a.artifactId);
    out.push({
      documentId: doc.id,
      documentTitle: doc.title,
      docNo: doc.doc_no,
      affectedCount: imp.affected.length,
      changedClauses: [...new Set(imp.affected.map((i) => i.clauseLabel ?? i.clausePath ?? '').filter(Boolean))],
      artifacts: imp.affected.slice(0, 50).map((i) => ({ artifactId: i.artifactId, title: i.artifactTitle, workbenchCode: i.workbenchCode, clausePath: i.clausePath, status: i.status })),
    });
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  return { total, artifacts: arts.size, documents: out.slice(0, limit) };
}

/* ============================================================================
 * 六、给界面用的批量读（一次请求取整个工作台的链接，避免文件列表 N 个请求）
 * ==========================================================================*/

export interface ArtifactLinkSummary {
  artifactId: number;
  items: ArtifactLinkItem[];
  counts: ArtifactLinkResult['counts'];
}

export function listWorkbenchLinks(workbenchId: number): { byArtifact: Record<string, ArtifactLinkSummary>; total: number } {
  const ids = all<{ id: number }>(
    `SELECT a.id FROM artifact a WHERE a.workbench_id = ? AND ${liveFilter('artifact', 'a')} ORDER BY a.id`,
    [workbenchId],
  ).map((r) => r.id);
  const byArtifact: Record<string, ArtifactLinkSummary> = {};
  let total = 0;
  for (const id of ids) {
    const linkCount = get<{ n: number }>('SELECT COUNT(*) AS n FROM doc_kb_link WHERE artifact_id = ? AND deleted_at IS NULL', [id])?.n ?? 0;
    if (!linkCount) continue;
    const r = listArtifactLinks(id);
    if (!r.counts.total) continue;
    byArtifact[String(id)] = { artifactId: id, items: r.items, counts: r.counts };
    total += r.counts.total;
  }
  return { byArtifact, total };
}
