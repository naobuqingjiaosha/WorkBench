/**
 * 知识库：语义检索的底座
 *
 * 分三层：
 *   1. 切块      —— 把长文档切成有语义边界的片段（chunk）
 *   2. 向量化    —— 调 embedding 接口把每块转成向量，存进 kb_chunk.embedding
 *   3. 检索      —— 全文（FTS5）+ 语义（余弦相似度）混合排序
 *
 * 向量存储：Float32 二进制 BLOB。1024 维 = 4KB/块，一万块约 40MB，SQLite 完全够用。
 * 相似度计算：启动时把全部向量读进内存做矩阵乘法。一万块 × 1024 维的一次全量打分约几十毫秒，
 *            在这个量级下不需要 HNSW 之类的索引结构。
 */
import { all, get, run, tx } from '../db/index.ts';
import { embed,embeddingSignature } from '../ai/gateway.ts';
import type { AiPurpose } from '../ai/providers.ts';
import { segCJK } from './search.ts';

/* ============================== 切块 ============================== */

export interface Chunk {
  seq: number;
  heading: string | null;
  content: string;
}

export interface ChunkOptions {
  /** 每块目标字数（中文按字数算） */
  size?: number;
  /** 相邻块重叠字数，避免答案正好被切断 */
  overlap?: number;
  /** 单文档最多切多少块，防止超长文档把接口打爆 */
  maxChunks?: number;
}

/**
 * 按「段落 → 句子」的边界切块，尽量不把一句话切断。
 * 纯字符数硬切会把语义切断，检索质量会明显下降，所以优先在空行、换行、句号处断开。
 *
 * 默认 500 字/块、60 字重叠：中文文档里这个尺寸检索精度和上下文完整性的平衡最好——
 * 块太大（1000+）会让命中内容被无关段落稀释，太小（<200）会丢上下文。
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const size = Math.max(120, opts.size ?? 500);
  const overlap = Math.max(0, Math.min(opts.overlap ?? 60, Math.floor(size / 3)));
  const maxChunks = opts.maxChunks ?? 800;

  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return [];

  // 先按标题/空行切成段，标题作为 heading 带上，便于回答时给出处
  const blocks: { heading: string | null; body: string }[] = [];
  let heading: string | null = null;
  for (const raw of normalized.split(/\n\s*\n/)) {
    const block = raw.trim();
    if (!block) continue;
    // 短行且不以句号结尾 —— 视为标题
    const isHeading = block.length <= 40 && !/[。；;：:！!？?]$/.test(block) && !block.includes('\n');
    if (isHeading) {
      heading = block;
      continue;
    }
    blocks.push({ heading, body: block });
  }
  if (!blocks.length) blocks.push({ heading: null, body: normalized });

  // 段落超长时按句子再切
  const pieces: { heading: string | null; body: string }[] = [];
  for (const b of blocks) {
    if (b.body.length <= size) {
      pieces.push(b);
      continue;
    }
    const sentences = b.body.split(/(?<=[。；！？!?;])/).filter((s) => s.trim());
    let cur = '';
    for (const s of sentences) {
      if ((cur + s).length > size && cur) {
        pieces.push({ heading: b.heading, body: cur });
        cur = '';
      }
      cur += s;
      // 单句本身就超长（例如一大段没有标点），硬切
      while (cur.length > size * 2) {
        pieces.push({ heading: b.heading, body: cur.slice(0, size) });
        cur = cur.slice(size - overlap);
      }
    }
    if (cur.trim()) pieces.push({ heading: b.heading, body: cur });
  }

  // 合并碎片。用显式的字符累加器，不用闭包改外部变量，避免状态看不清。
  // 规则：凑到目标长度就收一块；不足目标长度一半时不收，继续攒，
  //       免得产生一堆几十字的碎块（碎块会让检索命中很碎、上下文不足）。
  const minFill = Math.max(80, Math.floor(size * 0.45));
  const chunks: Chunk[] = [];
  const debugChunk = Boolean(process.env.WB_DEBUG_CHUNK);

  const parts: string[] = [];
  let partsLen = 0;
  let chunkHeading: string | null = null;
  const seal = (): void => {
    const content = parts.join('\n').trim();
    if (content.length >= 10) chunks.push({ seq: chunks.length + 1, heading: chunkHeading, content });
    parts.length = 0;
    partsLen = 0;
    chunkHeading = null;
    if (debugChunk && chunks.length <= 8) {
      console.error('[chunk]', chunks.length, 'len', content.length);
    }
  };

  for (let i = 0; i < pieces.length; i += 1) {
    const p = pieces[i] as { heading: string | null; body: string };
    if (!parts.length) chunkHeading = p.heading;

    // 加上这一段会不会超过目标长度？会、且已经攒够半块 → 先收口
    if (partsLen > 0 && partsLen + p.body.length > size && partsLen >= minFill) seal();
    if (!parts.length) chunkHeading = p.heading;

    parts.push(p.body);
    partsLen += p.body.length + 1;

    // 攒够了就收口，继续下一块
    if (partsLen >= size) {
      seal();
      continue;
    }
    // 下一段加上来会溢出、且当前已够半块 → 现在收口，并把尾部重叠留给下一块
    const next = pieces[i + 1] as { heading: string | null; body: string } | undefined;
    if (next && partsLen >= minFill && partsLen + next.body.length > size) {
      const content = parts.join('\n');
      const tail = overlap > 0 ? content.slice(-overlap) : '';
      seal();
      if (tail) {
        parts.push(tail);
        partsLen = tail.length + 1;
      }
    }
  }
  if (parts.length) seal();

  if (debugChunk) {
    console.error('[chunk-debug]', JSON.stringify({ size, overlap, minFill, pieces: pieces.length, chunks: chunks.length, lens: chunks.map((c) => c.content.length) }));
  }

  return chunks.slice(0, maxChunks);
}

/* ============================== 章节/条款路径（B3-8/B3-9） ============================== */

/**
 * 块的条款归属：内容 + 它在原文里的章节/条款路径。
 * 路径形如 `S2 第二章 检查考核 > 一 第五条 > （二）`，检索出处与 B3-9 的条款级引用都用它。
 */
export interface ClausePathPair {
  content: string;
  clausePath: string | null;
}

/** 章节：`第一章 …` / `一、…` / `1. …` / `（一）…`，只认「整行就是标题」的行（≤60 字） */

/** 路径分段之间的连接符（界面与检索结果里直接展示） */
export const CLAUSE_PATH_SEP = ' > ';

/** 识别一行是不是章节/条款/项标题；是就返回它的路径分段标签 */
function headingLabel(line: string): { kind: 'section' | 'clause' | 'item'; label: string } | null {
  const t = line.trim();
  if (!t || t.length > 60) return null;
  const m1 = /^(第[一二三四五六七八九十百零\d]+[章篇节])\s*(.{0,40})$/.exec(t);
  if (m1) return { kind: 'section', label: `${m1[1]}${m1[2] ? ` ${m1[2].trim()}` : ''}` };
  const m2 = /^(第[一二三四五六七八九十百零\d]+条)\s*(.{0,60})$/.exec(t);
  if (m2) return { kind: 'clause', label: `${m2[1]}${m2[2] ? ` ${m2[2].trim()}` : ''}` };
  const m3 = /^([一二三四五六七八九十]+)[、.．]\s*(.{0,40})$/.exec(t);
  if (m3) return { kind: 'section', label: `${m3[1] as string}、${(m3[2] ?? '').trim()}`.trim() };
  const m4 = /^(\d{1,2})[.．、]\s*(.{0,40})$/.exec(t);
  if (m4) return { kind: 'section', label: `${m4[1] as string}.${(m4[2] ?? '').trim()}` };
  const m5 = /^[（(]([一二三四五六七八九十\d]+)[）)]\s*(.{0,40})$/.exec(t);
  if (m5) return { kind: 'item', label: `（${m5[1] as string}）${(m5[2] ?? '').trim()}` };
  return null;
}

/**
 * 从正文里抽出「标题行 + 它后面那一段」的配对标（供路径演示与自检用）。
 * 只认**独立的标题行**（整行就是标题，长度 ≤ 60），避免把正文里恰好的"第X条"当标题 —— B3-9 的
 * 假阳性防范就靠这一条：写在句子中间的「依据第五条规定」不会命中。
 */
export function scanClauseHeadings(text: string): { label: string; kind: 'section' | 'clause' | 'item'; line: number }[] {
  const out: { label: string; kind: 'section' | 'clause' | 'item'; line: number }[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const h = headingLabel(line);
    if (h) out.push({ label: h.label, kind: h.kind, line: i + 1 });
  });
  return out;
}

/**
 * 同 {@link chunkText}，但给每块带上**章节/条款路径**。
 *
 * 实现要点（有意为之，别改成"重新写一套切块"）：
 *   · 分段、切句、合并的逻辑**完全复用 `chunkText`**，只是把每个 piece 的路径一起带上，
 *     合并成块时取「块里第一个 piece 的路径」。这样块的内容长度与块数跟 `chunkText`
 *     一字不差 —— 既有单测与既有语料不会因为加了路径而变样。
 *   · 条款边界**不强制切块**（500 字一块是检索质量的既定口径，切碎反而更差），
 *     只在块内保留"从哪一条开始"的路径，B3-9 引用条款时用 `scanClauseHeadings` 精确定位。
 */
export function chunkTextWithClauses(text: string, opts: ChunkOptions = {}): ClausePathPair[] {
  const paths = clausePathMap(text);
  const size = Math.max(120, opts.size ?? 500);
  const overlap = Math.max(0, Math.min(opts.overlap ?? 60, Math.floor(size / 3)));

  // 与 chunkText 的分段口径保持一致，同时算出每段的路径
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) return [];

  const pieces: { heading: string | null; body: string; path: string | null }[] = [];
  let heading: string | null = null;
  // 分段用与 chunkText 相同的 `\n\s*\n`，但这里要拿到**每一段在原文里的真实偏移**：
  // 用 `indexOf` 找第一处会出现"同一段文字在文中出现两次 → 两段的偏移都指到第一处"，
  // 于是后一段的条款路径张冠李戴（实测踩过）。带 g 标志的正则 + match.index 没有这个问题。
  const blockRe = /\n\s*\n/g;
  const spans: { start: number; end: number }[] = [];
  {
    let pos = 0;
    let m: RegExpExecArray | null;
    blockRe.lastIndex = 0;
    while ((m = blockRe.exec(normalized))) {
      spans.push({ start: pos, end: m.index });
      pos = m.index + m[0].length;
    }
    spans.push({ start: pos, end: normalized.length });
  }
  for (const span of spans) {
    const block = normalized.slice(span.start, span.end).trim();
    if (!block) continue;
    const at = span.start + (normalized.slice(span.start, span.end).length - normalized.slice(span.start, span.end).trimStart().length);
    const blockPath = pathAt(paths, at);
    const isHeading = block.length <= 40 && !/[。；;：:！!？?]$/.test(block) && !block.includes('\n');
    if (isHeading) {
      heading = block;
      continue;
    }
    if (block.length <= size) {
      pieces.push({ heading, body: block, path: blockPath });
      continue;
    }
    // 超长段落按句再切：逐句把偏移往前推，每句带自己的路径
    const sentences = block.split(/(?<=[。；！？!?;])/).filter((s) => s.trim());
    let cur = '';
    let curPath: string | null = null;
    let offset = at;
    for (const s of sentences) {
      const sPath = pathAt(paths, offset);
      if ((cur + s).length > size && cur) {
        pieces.push({ heading, body: cur, path: curPath });
        cur = '';
        curPath = null;
      }
      if (!cur) curPath = sPath;
      cur += s;
      offset += s.length;
      while (cur.length > size * 2) {
        pieces.push({ heading, body: cur.slice(0, size), path: curPath });
        cur = cur.slice(size - overlap);
        curPath = null;
      }
    }
    if (cur.trim()) pieces.push({ heading, body: cur, path: curPath ?? blockPath });
  }
  if (!pieces.length) {
    const only = normalized;
    return [{ content: only, clausePath: paths.length ? pathAt(paths, 0) : null }];
  }

  const minFill = Math.max(80, Math.floor(size * 0.45));
  const out: ClausePathPair[] = [];
  const parts: string[] = [];
  let partsLen = 0;
  let chunkPath: string | null = null;
  const seal = (): void => {
    const content = parts.join('\n').trim();
    if (content.length >= 10) out.push({ content, clausePath: chunkPath });
    parts.length = 0;
    partsLen = 0;
    chunkPath = null;
  };
  for (let i = 0; i < pieces.length; i += 1) {
    const p = pieces[i] as { heading: string | null; body: string; path: string | null };
    /**
     * 条款边界即块边界（这一行是"每块都有准确条款路径"的关键）。
     *
     * 不这么做的话，一个 500 字的块会横跨好几条（实测：块 1 从"第一章"开始、
     * 一直吃到"第八条"中间），块的 `clause_path` 只能写第一段的路径，
     * 后面那些条就成了"没有路径"的内容 —— B3-9 想引用"第八条"就找不到。
     * 代价是块可能比 size 短一些（换来的是引用能精确定位），检索质量不受影响：
     * 一条制度里相邻条款本来就是一个语义单元。
     */
    if (parts.length && p.path !== chunkPath) seal();
    if (!parts.length) chunkPath = p.path;
    if (partsLen > 0 && partsLen + p.body.length > size && partsLen >= minFill) seal();
    // 上面 seal() 之后是空块：**重新**给这一块定路径（不能只在 `!parts.length` 里赋一次，
    // 否则 seal 后的新块会继承上一块的路径）。本轮刚 seal 出来的重叠尾巴是上一块末尾的
    // 文字，它属于上一块的路径，而这一块从这里开始属于 p.path。
    if (!parts.length) chunkPath = p.path;
    parts.push(p.body);
    partsLen += p.body.length + 1;
    if (partsLen >= size) {
      seal();
      continue;
    }
    const next = pieces[i + 1] as { heading: string | null; body: string; path: string | null } | undefined;
    if (next && next.path === chunkPath && partsLen >= minFill && partsLen + next.body.length > size) {
      const content = parts.join('\n');
      const tail = overlap > 0 ? content.slice(-overlap) : '';
      seal();
      // 重叠尾巴只在与下一段同属一个条款时才带过去：跨条款带过去会让新块的
      // 开头是上一条的残句，而块头挂的是下一条的路径（引用时张冠李戴）。
      if (tail && next.path === p.path) {
        parts.push(tail);
        partsLen = tail.length + 1;
      }
    }
  }
  if (parts.length) seal();
  return out.map((c) => ({ content: c.content, clausePath: c.clausePath ?? null }));
}

/** `[偏移, 路径]` 升序表：给正文里任意位置找它属于哪个章节/条款 */
function clausePathMap(text: string): { at: number; path: string }[] {
  const list: { at: number; path: string }[] = [];
  let section: string | null = null;
  let clause: string | null = null;
  let item: string | null = null;
  let offset = 0;
  for (const rawLine of text.split('\n')) {
    const lineLen = rawLine.length + 1; // +1：换行符
    const h = headingLabel(rawLine);
    if (h) {
      if (h.kind === 'section') {
        section = h.label;
        clause = null;
        item = null;
      } else if (h.kind === 'clause') {
        clause = h.label;
        item = null;
      } else {
        item = h.label;
      }
      const segs = [section, clause, item].filter((x): x is string => Boolean(x));
      list.push({ at: offset, path: segs.length ? segs.join(CLAUSE_PATH_SEP) : '' });
    }
    offset += lineLen;
  }
  return list.filter((x) => x.path);
}

function pathAt(paths: { at: number; path: string }[], offset: number): string | null {
  let found: string | null = null;
  for (const p of paths) {
    if (p.at <= offset) found = p.path;
    else break;
  }
  return found;
}

/** 切块口径签名：算法或参数一变就要重切（登记在 kb_document.chunk_config 上） */
export function kbChunkSignature(): string {
  return `kb-chunk-v2:size=500,overlap=60,max=800`;
}

/** 去掉条款编号噪声后的可比文本（`第X条`/`（一）`/页码/空白），用于归一化哈希与重复判定 */
export function stripClauseNoise(text: string): string {
  return text
    .replace(/第[一二三四五六七八九十百零\d]+[条章节篇款项]/g, '')
    .replace(/[（(][一二三四五六七八九十\d]+[）)]/g, '')
    .replace(/^\s*\d{1,2}[.．、]\s*/gm, '')
    .replace(/-?\s*\d{1,3}\s*-/g, '');
}

/** 诊断用：把一段向量编码成可比较的文本签名（不参与检索） */
export function encodeVectorText(v: number[] | Float32Array): string {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return `${f.length}:${Array.from(f.slice(0, 3)).map((x) => x.toFixed(4)).join(',')}`;
}

/** 当前 embedding 档案的指纹（服务商+模型+维度）。抽取任务用它判断"要不要重新向量化" */
export { embeddingSignature };

/* ============================== 向量编解码 ============================== */

export function encodeVector(v: number[] | Float32Array): Uint8Array {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

export function decodeVector(blob: Uint8Array | null | undefined): Float32Array | null {
  if (!blob || blob.byteLength < 4 || blob.byteLength % 4 !== 0) return null;
  const copy = new Uint8Array(blob); // 复制，避免对齐问题
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ============================== 导入与向量化 ============================== */

export interface KbDocument {
  id: number;
  artifact_id: number | null;
  title: string;
  doc_type: string | null;
  work_type_id: number | null;
  source: string | null;
  chunk_count: number;
  embedded_at: string | null;
  created_at: string;
}

/** 新建知识库文档（幂等：同一个 artifact 只建一次） */
export function upsertKbDocument(input: {
  artifactId?: number | null;
  title: string;
  docType?: string | null;
  workTypeId?: number | null;
  source?: string | null;
}): number {
  if (input.artifactId) {
    const existing = get<{ id: number }>('SELECT id FROM kb_document WHERE artifact_id = ?', [input.artifactId]);
    if (existing) return existing.id;
  }
  const r = run(
    'INSERT INTO kb_document (artifact_id, title, doc_type, work_type_id, source) VALUES (?,?,?,?,?)',
    [input.artifactId ?? null, input.title, input.docType ?? null, input.workTypeId ?? null, input.source ?? null],
  );
  return r.lastInsertRowid;
}

/** 文档列表：带上每个文档的片段数与其中已向量化的数量（界面上的「片段 / 已向量化」两列） */
export function listKbDocuments(): (KbDocument & { embedded_count: number; file_name: string | null; workbench_id: number | null })[] {
  return all(
    `SELECT d.*,
            (SELECT COUNT(*) FROM kb_chunk c WHERE c.document_id = d.id AND c.embedding IS NOT NULL) AS embedded_count,
            a.file_name, a.workbench_id
       FROM kb_document d LEFT JOIN artifact a ON a.id = d.artifact_id
      ORDER BY d.id DESC`,
  );
}

export function getKbDocument(id: number): KbDocument | undefined {
  return get<KbDocument>('SELECT * FROM kb_document WHERE id = ?', [id]);
}

export function listKbChunks(documentId: number, limit = 200): { id: number; seq: number; heading: string | null; content: string; has_vector: number }[] {
  return all(
    `SELECT id, seq, heading, content, CASE WHEN embedding IS NULL THEN 0 ELSE 1 END AS has_vector
       FROM kb_chunk WHERE document_id = ? ORDER BY seq LIMIT ?`,
    [documentId, limit],
  );
}

/** 用文本切块并写入 kb_chunk（先不向量化） */
export function indexDocumentText(documentId: number, text: string, opts: ChunkOptions = {}): number {
  const chunks = chunkTextWithClauses(text, opts);
  tx(() => {
    run('DELETE FROM kb_chunk_search WHERE document_id = ?', [documentId]);
    run('DELETE FROM kb_chunk WHERE document_id = ?', [documentId]);
    for (const [index, c] of chunks.entries()) {
      const ins = run('INSERT INTO kb_chunk (document_id, seq, heading, content, clause_path) VALUES (?,?,?,?,?)', [
        documentId,
        index + 1,
        c.clausePath,
        c.content,
        c.clausePath,
      ]);
      run('INSERT INTO kb_chunk_search(id,document_id,clause_path,seg_text) VALUES(?,?,?,?)',
        [ins.lastInsertRowid, documentId, c.clausePath, segCJK(c.content)]);
    }
    run('UPDATE kb_document SET chunk_count = ?, embedded_at = NULL WHERE id = ?', [chunks.length, documentId]);
  });
  invalidateCache();
  return chunks.length;
}

export interface EmbedProgress {
  documentId: number;
  done: number;
  total: number;
  failed: number;
  message: string;
}

/**
 * 写入「已经切好的块」并同步维护 FTS 索引（B3-8 的抽取任务走这条路）。
 *
 * 与 {@link indexDocumentText} 的区别只有一个：块是调用方切好的（带章节/条款路径），
 * 这里不再调 `chunkText`。`kb_chunk_search` 是 019 建的 FTS5 内容表，
 * 由它的触发器同步 `kb_chunk_fts`，所以**必须**在这里维护 —— 少写一行，
 * 「换了口径重跑」之后 FTS 里就会留下指向已删块的行（搜到点开是空的）。
 *
 * @param sig 切块口径签名，写进 `kb_document.chunk_config`；变了就说明该重切
 * @returns 实际写入的块数
 */
export function indexDocumentChunksFs(
  documentId: number,
  chunks: { content: string; clausePath: string | null; seq?: number }[],
  sig: string,
  fullText: string,
  method: string,
): number {
  const rows = chunks
    .map((c, i) => ({ seq: c.seq ?? i + 1, content: c.content.trim(), clausePath: c.clausePath ?? null }))
    .filter((c) => c.content.length >= 10);
  tx(() => {
    // 先清 FTS 内容表（按 document_id），再清 kb_chunk：顺序反了会留下 FTS 幽灵行
    run('DELETE FROM kb_chunk_search WHERE document_id = ?', [documentId]);
    run('DELETE FROM kb_chunk WHERE document_id = ?', [documentId]);
    for (const c of rows) {
      const ins = run('INSERT INTO kb_chunk (document_id, seq, heading, content, clause_path) VALUES (?,?,?,?,?)', [
        documentId,
        c.seq,
        null,
        c.content,
        c.clausePath,
      ]);
      run('INSERT INTO kb_chunk_search (id, document_id, clause_path, seg_text) VALUES (?,?,?,?)', [
        ins.lastInsertRowid,
        documentId,
        c.clausePath,
        segCJK(c.content),
      ]);
    }
    run(
      `UPDATE kb_document SET chunk_count = ?, embedded_at = NULL, chunk_config = ?,
         chars = ?, extract_method = ? WHERE id = ?`,
      [rows.length, sig, fullText.length, method, documentId],
    );
  });
  invalidateCache();
  return rows.length;
}

/**
 * 给某文档里还没向量的块做向量化。
 *
 * 批量提交（默认 16 块一次）以减少接口调用，但**每个服务商对单次条数都有限制**，
 * 而且限制不一样：阿里 `text-embedding-v3` 只允许 10 条，`qwen3.7-text-embedding-flash`
 * 能到 24 条以上。撞上限时接口返回 400，如果就此放弃，一篇文档只要超过 10 块
 * 就永远向量化不了，而且错误信息看起来像"参数写错了"，很难联想到"批量太大"。
 *
 * 所以这里做自适应：批量被拒就把这一批劈成两半重试，直到单条为止；
 * 劈小之后成功过，就把尺寸记住，后面的批次直接用，不用每批都撞一次墙。
 */
export async function embedDocument(
  documentId: number,
  onProgress?: (p: EmbedProgress) => void,
  batchSize = 16,
): Promise<EmbedProgress> {
  let signature:string;try{signature=embeddingSignature();}catch(e){return {documentId,done:0,total:0,failed:1,message:(e as Error).message};}
  const pending = all<{ id: number; content: string }>(
    'SELECT id, content FROM kb_chunk WHERE document_id = ? AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model<>?) ORDER BY seq',
    [documentId,signature],
  );
  const result: EmbedProgress = { documentId, done: 0, total: pending.length, failed: 0, message: '' };
  if (!pending.length) {
    result.message = '所有片段都已有向量';
    return result;
  }

  let size = Math.max(1, batchSize);
  let singleFails = 0; // 连续单条失败次数：用来区分"某一段内容有问题"和"接口整个不行了"
  const MAX_SINGLE_FAILS = 3;
  let i = 0;

  const store = (b: { id: number }, vec: number[] | undefined, model: string | undefined): boolean => {
    if (!vec) return false;
    run('UPDATE kb_chunk SET embedding = ?, embedding_model = ? WHERE id = ?', [encodeVector(vec), signature, b.id]);
    return true;
  };

  while (i < pending.length) {
    const batch = pending.slice(i, i + size);
    const res = await embed(batch.map((b) => b.content));

    if (res.ok && res.vectors.length === batch.length) {
      tx(() => {
        batch.forEach((b, idx) => store(b, res.vectors[idx], res.model));
      });
      result.done += batch.length;
      singleFails = 0;
      result.message = '';
      i += batch.length;
      onProgress?.({ ...result });
      continue;
    }

    if (res.ok) {
      // 条数对不上：逐条重试，避免整批作废
      for (const b of batch) {
        const one = await embed([b.content]);
        if (one.ok && store(b, one.vectors[0], one.model)) result.done += 1;
        else result.failed += 1;
      }
      i += batch.length;
      onProgress?.({ ...result });
      continue;
    }

    // 批量被拒：先怀疑"批量太大"，劈一半再来
    if (batch.length > 1) {
      size = Math.max(1, Math.floor(batch.length / 2));
      result.message = `接口拒收 ${batch.length} 条一批（${(res.error ?? '').slice(0, 80)}），已降到 ${size} 条重试`;
      onProgress?.({ ...result });
      continue;
    }

    // 单条都失败：可能是这一段内容有问题，也可能是 Key/额度/网络整体不行
    result.failed += 1;
    result.message = res.error ?? '向量化失败';
    i += 1;
    singleFails += 1;
    if (singleFails >= MAX_SINGLE_FAILS) {
      result.failed += pending.length - i;
      result.message = `${result.message}（连续 ${singleFails} 条都失败，剩下的先跳过）`;
      break;
    }
  }

  const left = get<{ n: number }>('SELECT COUNT(*) AS n FROM kb_chunk WHERE document_id = ? AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model<>?)', [documentId, signature])?.n ?? 0;
  if (left === 0) {
    run("UPDATE kb_document SET embedded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [documentId]);
  } else {
    run('UPDATE kb_document SET embedded_at = NULL WHERE id = ?', [documentId]);
  }
  invalidateCache();
  if (!result.message) result.message = result.failed ? `完成，${result.failed} 块失败` : '全部向量化完成';
  return result;
}

export function deleteKbDocument(id: number): void {
  tx(() => {
    // FTS 内容表先删（它带触发器同步 kb_chunk_fts），再删块本体
    run('DELETE FROM kb_chunk_search WHERE document_id = ?', [id]);
    run('DELETE FROM kb_chunk WHERE document_id = ?', [id]);
    run('DELETE FROM kb_document WHERE id = ?', [id]);
  });
  invalidateCache();
}

/* ============================== 失效标记（不删库） ============================== */

/**
 * 「失效但保留」的抽取结论值，写进**既有的** `kb_document.decision` 列 —— **不需要迁移**。
 *
 * 为什么不新加一列：
 *   1. `decision` 的语义本来就是"这份文档按当前口径算不算数"，'stale' 只是补上它缺的那一档；
 *   2. 可用性判据在别处已经写好了：`domain/kb-cite.ts` 认 `decision === null || 'active'`，
 *      `domain/kb-links.ts` 认 `decision && decision !== 'active'` 为"依据核不到了，要复核"。
 *      标成 stale 之后这两条路**一行都不用改**就正确了（引用被拦、链接标成待复核）；
 *   3. 新列要动 `db/migrations/`（本轮的文件范围之外），而且对这一档语义没有任何增益。
 *
 * 与 {@link deleteKbDocument} 的分界：标失效**一个字节都不删** —— 正文、`kb_chunk`、
 * `embedding` 向量（已经付过钱的）全部原地留着，只是不再被当成依据。真删必须走
 * {@link purgeStaleKbDocuments} 并且显式确认。
 */
export const KB_DECISION_STALE = 'stale';

export interface StaleKbDocument {
  id: number;
  title: string;
  rel_path: string | null;
  chunk_count: number;
  embedded_count: number;
  size_bytes: number | null;
  decision_reason: string | null;
  extracted_at: string | null;
}

/**
 * 标记失效：只写 `decision='stale'` + `decision_reason`，**不删任何行、不动任何向量**。
 * 幂等：同样的理由重复标记只计入 `already`，不会反复改写 `extracted_at`。
 */
export function markKbDocumentsStale(ids: number[], reason: string): { marked: number; already: number; missing: number } {
  const list = ids.filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!list.length) return { marked: 0, already: 0, missing: 0 };
  let marked = 0;
  let already = 0;
  let missing = 0;
  tx(() => {
    for (const id of list) {
      const cur = get<{ decision: string | null; decision_reason: string | null }>(
        'SELECT decision, decision_reason FROM kb_document WHERE id = ?',
        [id],
      );
      if (!cur) {
        missing += 1;
        continue;
      }
      if (cur.decision === KB_DECISION_STALE && cur.decision_reason === reason) {
        already += 1;
        continue;
      }
      run(
        `UPDATE kb_document SET decision = ?, decision_reason = ?, dup_of_id = NULL,
           extracted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [KB_DECISION_STALE, reason, id],
      );
      marked += 1;
    }
  });
  if (marked) invalidateCache(); // 检索矩阵里要立刻把失效文档剔出去
  return { marked, already, missing };
}

/** 把一份文档恢复成可用（换回口径时用；与 `upsertExtractDocument` 的写法保持一致） */
export function restoreKbDocumentActive(id: number): void {
  run(
    `UPDATE kb_document SET decision = 'active', decision_reason = NULL, dup_of_id = NULL,
       extracted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [id],
  );
  invalidateCache();
}

/** 列出失效文档（`sourceId` 给了就只看这个来源；`ids` 给了就只按 id 过滤） */
export function listStaleKbDocuments(sourceId?: number | null, ids?: number[] | null): StaleKbDocument[] {
  const where: string[] = [`d.decision = '${KB_DECISION_STALE}'`];
  const params: (string | number)[] = [];
  if (sourceId !== undefined && sourceId !== null) {
    where.push('d.source_id = ?');
    params.push(sourceId);
  }
  if (ids && ids.length) {
    where.push(`d.id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  return all<StaleKbDocument>(
    `SELECT d.id, d.title, d.rel_path, d.chunk_count, d.size_bytes, d.decision_reason, d.extracted_at,
            (SELECT COUNT(*) FROM kb_chunk c WHERE c.document_id = d.id AND c.embedding IS NOT NULL) AS embedded_count
       FROM kb_document d
      WHERE ${where.join(' AND ')}
      ORDER BY d.id`,
    params,
  );
}

export interface PurgeStaleResult {
  /** true = 只是"将要删除什么"的清单（dry-run），一个字节都没动 */
  dryRun: boolean;
  deleted: number;
  /** 将要删除 / 已经删除的那几份（人可见的清单） */
  willDelete: StaleKbDocument[];
  chunks: number;
  embedded: number;
  note: string;
}

/**
 * 物理删除失效文档 —— 抽取收尾**永不**走这条路，只有用户显式确认才走。
 *
 * 契约：`confirm !== true` 时**只返回清单**（"将删除 N 份"+列表），不删任何东西；
 * 调用方（接口）必须先把这份清单给用户看，再带 `confirm: true` 重发一次。
 * 只删 `decision='stale'` 的行：可用文档（active）不在这条路的范围内。
 */
export function purgeStaleKbDocuments(opts: { sourceId?: number | null; ids?: number[] | null; confirm?: boolean } = {}): PurgeStaleResult {
  const rows = listStaleKbDocuments(opts.sourceId ?? null, opts.ids ?? null);
  const chunks = rows.reduce((n, r) => n + r.chunk_count, 0);
  const embedded = rows.reduce((n, r) => n + r.embedded_count, 0);
  if (opts.confirm !== true) {
    return {
      dryRun: true,
      deleted: 0,
      willDelete: rows,
      chunks,
      embedded,
      note: rows.length
        ? `将要物理删除 ${rows.length} 份失效文档（共 ${chunks} 块正文、${embedded} 个向量，删除后不可恢复）。确认无误请带 confirm=true 重发这一次请求。`
        : '没有失效文档，不需要清理。',
    };
  }
  for (const r of rows) deleteKbDocument(r.id);
  return {
    dryRun: false,
    deleted: rows.length,
    willDelete: rows,
    chunks,
    embedded,
    note: rows.length ? `已物理删除 ${rows.length} 份失效文档（${chunks} 块正文、${embedded} 个向量）。` : '没有失效文档，不需要清理。',
  };
}

export function kbStats(): {
  documents: number;
  chunks: number;
  embedded: number;
  pending: number;
  dims: number | null;
  models: string[];
} {
  const documents = get<{ n: number }>('SELECT COUNT(*) AS n FROM kb_document')?.n ?? 0;
  const chunks = get<{ n: number }>('SELECT COUNT(*) AS n FROM kb_chunk')?.n ?? 0;
  const embedded = get<{ n: number }>('SELECT COUNT(*) AS n FROM kb_chunk WHERE embedding IS NOT NULL')?.n ?? 0;
  const sample = get<{ embedding: Uint8Array | null }>('SELECT embedding FROM kb_chunk WHERE embedding IS NOT NULL LIMIT 1');
  const dims = sample?.embedding ? sample.embedding.byteLength / 4 : null;
  const models = all<{ embedding_model: string | null }>(
    'SELECT DISTINCT embedding_model FROM kb_chunk WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL LIMIT 10',
  )
    .map((m) => m.embedding_model)
    .filter((m): m is string => Boolean(m));
  return { documents, chunks, embedded, pending: chunks - embedded, dims, models };
}

/**
 * 让 FTS 索引与 `kb_chunk` 重新对齐。
 *
 * 为什么需要：`kb_chunk_search`（019 的 FTS5 内容表）只有本文件的两个 io 函数在维护。
 * 库里还有别的写点会绕过它 —— 回归测试直接 `INSERT INTO kb_chunk`、`cli/reset.ts` 整表清、
 * 手工 SQL 删行（回收站清空走的是 `ON DELETE CASCADE`，那条路**不触发** kb_chunk 上的触发器）。
 * 那些路径会在 FTS 里留下"指向已删块的幽灵行"（搜得到、点开是空的）。
 * 这个函数把幽灵行按 id 对齐删掉，再让 FTS 从内容表重读一遍 —— 与 `core/search.ts`
 * 的 `purgeOrphanIndexRows()` 是同一套做法，两边都只清"确实对不上"的行。
 */
export function rebuildKbChunkFts(): number {
  const removed = run(
    `DELETE FROM kb_chunk_search
      WHERE NOT EXISTS (SELECT 1 FROM kb_chunk k WHERE k.id = kb_chunk_search.id)
         OR document_id NOT IN (SELECT id FROM kb_document)`,
  ).changes;
  run("INSERT INTO kb_chunk_fts(kb_chunk_fts) VALUES('rebuild')");
  return Number(removed);
}

/* ============================== 检索 ============================== */

interface CachedChunk {
  id: number;
  documentId: number;
  seq: number;
  heading: string | null;
  content: string;
  vector: Float32Array;
  signature:string;
}

let matrix: CachedChunk[] | null = null;
let matrixBuiltAt = 0;

export function invalidateCache(): void {
  matrix = null;
}

/** 把全部向量读进内存（带 30 秒缓存，避免每次搜索都读库） */
function buildMatrix(force = false): CachedChunk[] {
  if (matrix && !force && Date.now() - matrixBuiltAt < 30_000) return matrix;
  /**
   * 失效文档（`decision='stale'`）的向量**留在库里但不参与检索** —— 这正是"标记失效"
   * 与"删库"的区别：换口径后不该被检索到的，检索不到（口径照样生效），
   * 但已经付过钱的向量一个字都没丢（换回口径立刻又能用）。
   */
  const rows = all<{ id: number; document_id: number; seq: number; heading: string | null; content: string; embedding: Uint8Array; embedding_model:string|null }>(
    `SELECT c.id, c.document_id, c.seq, COALESCE(c.clause_path,c.heading) AS heading, c.content, c.embedding, c.embedding_model
       FROM kb_chunk c JOIN kb_document d ON d.id = c.document_id
      WHERE c.embedding IS NOT NULL AND (d.decision IS NULL OR d.decision <> '${KB_DECISION_STALE}')`,
  );
  const m: CachedChunk[] = [];
  for (const r of rows) {
    const v = decodeVector(r.embedding);
    if (!v) continue;
    m.push({ id: r.id, documentId: r.document_id, seq: r.seq, heading: r.heading, content: r.content, vector: v,signature:r.embedding_model ?? '' });
  }
  matrix = m;
  matrixBuiltAt = Date.now();
  return m;
}

export interface SemanticHit {
  chunkId: number;
  documentId: number;
  documentTitle: string;
  docType: string | null;
  fileRel: string | null;
  artifactId: number | null;
  workbenchId: number | null;
  seq: number;
  heading: string | null;
  content: string;
  score: number;
}

export interface SemanticSearchResult {
  ok: boolean;
  hits: SemanticHit[];
  error?: string;
  /** 语料规模，便于判断为什么搜不到 */
  corpus: { chunks: number; documents: number };
}

/** 语义检索：把问题向量化，和全部块算余弦相似度，取 topK */
export async function semanticSearch(query: string, topK = 8, minScore = 0.2, opts: { documentIds?: number[] } = {}): Promise<SemanticSearchResult> {
  const m = buildMatrix().filter(c => !opts.documentIds || opts.documentIds.includes(c.documentId));
  const corpus = { chunks: m.length, documents: kbStats().documents };
  if (!query.trim()) return { ok: true, hits: [], corpus };
  if (!m.length) {
    return { ok: false, hits: [], corpus, error: '知识库里还没有向量化的内容。请先导入文档并点「向量化」。' };
  }

  const res = await embed([query]);
  if (!res.ok || !res.vectors[0]) {
    return { ok: false, hits: [], corpus, error: res.error ?? '查询向量化失败' };
  }
  const qv = Float32Array.from(res.vectors[0]);
  const compatible=m.filter(c=>c.signature===embeddingSignature() && c.vector.length===qv.length);
  if(!compatible.length)return {ok:false,hits:[],corpus,error:'已有向量的服务商、模型或维度与当前配置不一致，请重新向量化。'};

  const scored = compatible
    .map((c) => ({ c, score: cosine(qv, c.vector) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // 补上文档信息
  const docIds = [...new Set(scored.map((s) => s.c.documentId))];
  const docs = new Map<number, { title: string; doc_type: string | null; file_rel: string | null; artifact_id: number | null; workbench_id: number | null }>();
  for (const id of docIds) {
    const row = get<{ title: string; doc_type: string | null; file_rel: string | null; artifact_id: number | null; workbench_id: number | null }>(
      `SELECT d.title, d.doc_type, a.file_rel, d.artifact_id, a.workbench_id
         FROM kb_document d LEFT JOIN artifact a ON a.id = d.artifact_id WHERE d.id = ?`,
      [id],
    );
    if (row) docs.set(id, row);
  }

  return {
    ok: true,
    corpus,
    hits: scored.map((s) => {
      const d = docs.get(s.c.documentId);
      return {
        chunkId: s.c.id,
        documentId: s.c.documentId,
        documentTitle: d?.title ?? `#${s.c.documentId}`,
        docType: d?.doc_type ?? null,
        fileRel: d?.file_rel ?? null,
        artifactId: d?.artifact_id ?? null,
        workbenchId: d?.workbench_id ?? null,
        seq: s.c.seq,
        heading: s.c.heading,
        content: s.c.content,
        score: Number(s.score.toFixed(4)),
      };
    }),
  };
}

/**
 * 混合检索：全文命中 + 语义命中，加权合并。
 * 语义权重略高（0.6），因为"意思相近"是这套系统的重点；精确关键词命中仍有 0.4 的话语权。
 */
export async function hybridSearch(
  query: string,
  opts: { topK?: number; semanticWeight?: number; workTypeId?: number | null } = {},
): Promise<{
  ok: boolean;
  error?: string;
  fulltext: { total: number; items: { id: number; title: string; file_name: string; workbench_id: number | null; score: number }[] };
  semantic: SemanticHit[];
  merged: { key: string; source: 'both' | 'fulltext' | 'semantic'; score: number; title: string; snippet: string; artifactId: number | null; workbenchId: number | null; documentId: number | null }[];
}> {
  const topK = opts.topK ?? 8;
  const w = opts.semanticWeight ?? 0.6;

  // 全文检索：复用 artifact 的 FTS 索引（KB 文档通常挂在 artifact 上）。
  // 纯标点/纯符号的查询（`q=*`、`q=()`）切不出词，buildFtsQuery 返回空串 —— 这时必须
  // **整段跳过**：把空串喂给 MATCH 只会得到 FTS5 语法错，整条请求 500。
  const fts = buildFtsQuery(query);
  const raw = fts
    ? all<{ id: number; title: string; file_name: string; workbench_id: number | null; score: number }>(
        `SELECT a.id, a.title, a.file_name, a.workbench_id, bm25(artifact_fts, 10.0, 3.0) AS score
           FROM artifact_fts f
           JOIN artifact_search s ON s.id = f.rowid
           JOIN artifact a ON a.id = s.id
          WHERE artifact_fts MATCH ?
          ORDER BY score ASC LIMIT ?`,
        [fts, topK * 2],
      )
    : [];

  const sem = await semanticSearch(query, topK * 2);

  // 没有全文条件、语义又用不了：两半段都给不出结果，直接回空结果和原因，
  // 不要再往下堆一个空壳 merged 让人以为"搜过了但什么都没有"。
  if (!fts && !sem.ok) {
    return { ok: false, error: sem.error, fulltext: { total: 0, items: [] }, semantic: [], merged: [] };
  }

  const merged = new Map<string, { key: string; source: 'both' | 'fulltext' | 'semantic'; score: number; title: string; snippet: string; artifactId: number | null; workbenchId: number | null; documentId: number | null }>();

  // bm25 越小越相关（通常是负值）。
  // 不能用"除以最大值"归一化——那会让全文第一名恒等于 1，
  // 语义分数再高也翻不了身。改用按名次的指数衰减：第 1 名 ≈0.82，第 2 名 ≈0.67……
  // 这样"全文很弱但语义很强"的文档才有机会冒头。
  raw.forEach((r, i) => {
    const norm = Math.exp(-i / 2.2);
    merged.set(`a${r.id}`, {
      key: `a${r.id}`,
      source: 'fulltext',
      score: (1 - w) * norm,
      title: r.title || r.file_name,
      snippet: `文件：${r.file_name}`,
      artifactId: r.id,
      workbenchId: r.workbench_id,
      documentId: null,
    });
  });

  const seen=new Set<string>();
  for (const h of sem.hits) {
    const key = h.artifactId ? `a${h.artifactId}` : `d${h.documentId}`;
    if(seen.has(key))continue;seen.add(key);
    const prev = merged.get(key);
    const add = w * h.score;
    if (prev) {
      prev.source = 'both';
      prev.score += add;
      prev.snippet = h.content.slice(0, 300);
      prev.documentId = h.documentId;
    } else {
      merged.set(key, {
        key,
        source: 'semantic',
        score: add,
        title: h.documentTitle,
        snippet: h.content.slice(0, 300),
        artifactId: h.artifactId,
        workbenchId: h.workbenchId,
        documentId: h.documentId,
      });
    }
  }

  return {
    ok: sem.ok,
    error: sem.error,
    fulltext: { total: raw.length, items: raw },
    semantic: sem.hits,
    merged: [...merged.values()].sort((a, b) => b.score - a.score).slice(0, topK),
  };
}

/**
 * 把用户输入转成安全的 FTS5 查询（复用 artifact 检索的切分策略）。
 *
 * 切不出词时返回**空串**（与 core/search.ts 的 buildMatch 一致），调用方必须先判空再决定要不要查：
 * 空串喂给 `MATCH` 会直接抛 FTS5 语法错（`syntax error near ""`），整条请求 500。
 * （`'""'` 那种写法同样不该出现：它是一个空短语，语义含糊，且和别的调用方不一致。）
 */
function buildFtsQuery(query: string): string {
  const terms = query
    .replace(/["'*(){}[\]^~:\\/]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => segCJK(t))
    .filter(Boolean);
  if (!terms.length) return '';
  return terms.map((t) => `"${t}"`).join(' OR ');
}
