/**
 * 统一知识检索
 *
 * 知识库分两个模块：
 *   模板库    Word/Excel 模板 —— 「这件事该用哪张表、表里要填什么」
 *   公司制度  制度、规范、纪要等资料 —— 「这件事该照哪条规矩」
 *
 * 分开组织是为了人看着清楚；但模型思考时**两者都是依据**，不该分两次问。
 * 这个模块把两个模块合起来检索，每条结果标清来自哪个模块、出自哪份文件，
 * 供生成与问答时引用。
 *
 * 两个模块的检索方式不同（这是它们各自的本质决定的）：
 *   制度 —— 保留原文，仅使用本地关键词与全文索引
 *   模板 —— 是文件不是文章，靠**名称 + 说明 + 变量名**匹配（「要填检查人」能搜到含该变量的表）
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, run, tx } from '../db/index.ts';
import { DATA_ROOT } from './config.ts';
import { buildMatch, segCJK } from './search.ts';

export type KnowledgeSource = 'template' | 'policy';

export interface KnowledgeHit {
  source: KnowledgeSource;
  /** 人看的来源名：「模板库」/「公司制度」 */
  sourceLabel: string;
  id: number;
  title: string;
  /** 片段：制度正文节选 / 模板的可填项摘要 */
  snippet: string;
  /** 命中位置说明，如「第二条 适用范围」「变量：检查人」 */
  heading?: string | null;
  score: number;
  /**
   * 没有命中、只是「本类工作可用的表」。
   * 和命中项区别对待：命中项是依据（可以引用），可选项是候选（按需选用）。
   */
  optional?: boolean;
  /** 模板才有的字段 */
  template?: { code: string; format: string; variableCount: number; workTypeId: number | null };
  /** 制度才有的字段 */
  documentId?: number | null;
  artifactId?: number | null;
  chunkId?: number;
  docNo?: string | null;
  scopeLayer?: string | null;
  retrieval?: 'fulltext' | 'semantic' | 'both' | 'specified';
}

export interface KnowledgeSearchResult {
  ok: boolean;
  error?: string;
  hits: KnowledgeHit[];
  /** 各模块命中的条数，便于判断「没搜到是因为哪边是空的」 */
  counts: { template: number; policy: number };
  /** 语料规模 —— 搜不到时用来解释原因 */
  corpus: { templates: number; documents: number; chunks: number };
  /** 本轮是否真的做了检索（没做则 hits 为空且 skipped 有原因） */
  skipped?: string;
}

/* ============================== 模板检索 ============================== */

interface TemplateRow {
  id: number;
  code: string;
  name: string;
  category: string;
  work_type_id: number | null;
  file_format: string;
  vars_rel: string | null;
  variable_count: number;
  description: string | null;
  usage_note: string | null;
}

/**
 * 不参与匹配的泛词。
 *
 * 检索词是从一句大白话里切出来的（「本月对清廉工程开展月度检查，重点看制度…」），
 * 其中「开展」「重点」「情况」这类词几乎每份模板都沾边，会让所有模板得分一样高，
 * 等于把排序变成随机。宁可丢掉它们，也不要让噪声压过「检查」这种真信号。
 */
const STOP_TERMS = new Set([
  '开展', '进行', '重点', '主要', '有关', '相关', '情况', '工作', '本次', '本月', '本年度',
  '一个', '我们', '他们', '这个', '那个', '以下', '如上', '根据', '按照', '关于', '要求',
  '需要', '可以', '应该', '已经', '以及', '或者', '但是', '因为', '所以', '如果', '为了',
  '什么', '怎么', '哪些', '如何', '一份', '一份', '时间', '过程',
]);

/**
 * 把一句大白话切成可匹配的词。
 *
 * 两个来源，缺一不可：
 *   ① 标点切出的整块 —— 用于「查询里有完整模板名」这种精确命中（「开箱验收」）
 *   ② 块内的 2~4 字词 —— 用于「查询里只提到某个词」时的模糊命中（「检查」）
 * 整块太长时不能拿去做包含判断（「本月对清廉工程开展月度检查」不可能出现在模板名里），
 * 所以必须有 ② 这一路。
 */
export function extractTerms(text: string): { chunks: string[]; terms: string[] } {
  const clean = text.replace(/[a-zA-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const chunks = clean
    .split(/[\s,，、。；;：:！!？?（）()【】\[\]「」《》/\\|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const longChunks = chunks.filter((s) => s.length <= 20);

  const terms = new Set<string>();
  for (const c of chunks) {
    // 整块本身就是个词（如「清廉工程」「月度检查」）
    if (c.length <= 6 && !STOP_TERMS.has(c)) terms.add(c);
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= c.length; i++) {
        const g = c.slice(i, i + n);
        if (!STOP_TERMS.has(g)) terms.add(g);
      }
    }
  }
  return { chunks: longChunks, terms: [...terms].slice(0, 300) };
}

/**
 * 匹配模板。
 *
 * 为什么不用向量：模板正文几乎全是固定套话（「甲方：」「签订日期：」），
 * 把它向量化既贵又没用 —— 真正区分模板的是它叫什么、给谁用、要填哪几项。
 *
 * 判据分两种，都是「能解释得清」的：
 *   ① 命中：查询里的某个片段出现在模板名/说明/可填项里。
 *      查询是「开箱验收」就是命中；查询是一整句话（「本月对清廉工程开展月度检查…」）
 *      时不会有片段命中 —— 这是对的，硬凑只会把「工程开」这种巧合当成信号，
 *      结果推荐出一堆工程表。
 *   ② 可选：没命中时，列出**本类工作**可用的表。
 *      不知道具体是哪张表时，与其乱猜一张，不如把这类工作的表都摆出来 ——
 *      模型和你都能一眼认出该用哪张，而且不会把不相干的表混进来。
 */
function searchTemplates(keyword: string, limit: number, workTypeId?: number | null): KnowledgeHit[] {
  const kw = keyword.trim();
  if (!kw) return [];
  const rows = all<TemplateRow>(
    `SELECT id, code, name, category, work_type_id, file_format, vars_rel, variable_count, description, usage_note
       FROM template WHERE archived_at IS NULL ORDER BY work_type_id, id`,
  );
  const { chunks, terms } = extractTerms(kw);
  if (!chunks.length) return [];

  const hits: KnowledgeHit[] = [];
  const hitIds = new Set<number>();

  for (const t of rows) {
    const vars = readVarNames(t.vars_rel);
    const varText = vars.join(' ');
    const otherText = `${t.description ?? ''} ${t.usage_note ?? ''}`;

    const inName = chunks.find((c) => t.name.includes(c));
    const nameInChunk = inName ? undefined : chunks.find((c) => c.includes(t.name));
    const inDesc = chunks.find((c) => otherText.includes(c));
    const inVars = chunks.find((c) => varText.includes(c));

    let score = 0;
    const where: string[] = [];
    if (inName) { score = 1; where.push('模板名'); }
    else if (nameInChunk) { score = 0.95; where.push('查询里点名'); }
    else if (inDesc) { score = 0.7; where.push('模板说明'); }
    else if (inVars) { score = 0.6; where.push('可填项'); }
    if (score <= 0) continue;

    hitIds.add(t.id);
    hits.push({
      source: 'template',
      sourceLabel: '模板库',
      id: t.id,
      title: t.name,
      snippet: templateSnippet(t, vars, terms, inName ?? nameInChunk ?? inDesc ?? inVars),
      heading: where.join(' / '),
      score: Math.min(1, Math.round(score * 100) / 100),
      template: { code: t.code, format: t.file_format, variableCount: t.variable_count, workTypeId: t.work_type_id },
    });
  }

  hits.sort((a, b) => b.score - a.score || a.id - b.id);

  // ② 可选：同类工作的其余模板，附在后面（分数 0，界面上标「可选」）
  if (workTypeId) {
    for (const t of rows) {
      if (hitIds.has(t.id) || t.work_type_id !== workTypeId) continue;
      hits.push({
        source: 'template',
        sourceLabel: '模板库',
        id: t.id,
        title: t.name,
        snippet: `${t.file_format}，可填 ${t.variable_count} 项`,
        heading: '本类工作可用',
        score: 0,
        optional: true,
        template: { code: t.code, format: t.file_format, variableCount: t.variable_count, workTypeId: t.work_type_id },
      });
    }
  }

  return hits.slice(0, limit);
}

function templateSnippet(t: TemplateRow, vars: string[], terms: string[], exact?: string): string {
  const bits: string[] = [];
  bits.push(`格式 ${t.file_format}，可填 ${t.variable_count} 项`);
  if (t.description) bits.push(t.description);
  if (t.usage_note) bits.push(t.usage_note);
  const hitVars = vars.filter((v) => terms.some((n) => v.includes(n)));
  if (hitVars.length) bits.push(`含可填项：${hitVars.slice(0, 8).join('、')}`);
  else if (vars.length) bits.push(`可填项举例：${vars.slice(0, 8).join('、')}`);
  if (exact) bits.push(`匹配「${exact}」`);
  return bits.join('　|　');
}

/** 读模板的变量名清单（.vars.json），读不到就空数组 —— 不该让检索因缺文件而失败 */
function readVarNames(varsRel: string | null): string[] {
  if (!varsRel) return [];
  try {
    const abs = join(DATA_ROOT, varsRel);
    if (!existsSync(abs)) return [];
    const parsed = JSON.parse(readFileSync(abs, 'utf8')) as { variables?: { name?: string }[] };
    return (parsed.variables ?? []).map((v) => String(v.name ?? '')).filter(Boolean);
  } catch {
    return [];
  }
}

/* ============================== 制度检索 ============================== */

async function searchPolicies(keyword: string, limit: number, documentIds: number[] = [], authorityOnly = false): Promise<{ hits: KnowledgeHit[]; error?: string }> {
  if (!keyword.trim()) return { hits: [] };
  const docs = all<{ id: number; title: string; doc_no: string | null; scope_layer: string | null; artifact_id: number | null }>(
    `SELECT id,title,doc_no,scope_layer,artifact_id FROM kb_document
     WHERE (decision IS NULL OR decision='active')
       AND (version_status IS NULL OR version_status IN ('current','final'))`);
  const eligible = new Map(docs.filter(d => (!documentIds.length || documentIds.includes(d.id))
    && (!authorityOnly || d.scope_layer !== 'reference')).map(d => [d.id, d]));
  if (!eligible.size) return { hits: [], error: '没有可用的制度正文；请先抽取制度，确认版本及适用范围。' };
  // 老上传数据可能只有 kb_chunk；补齐本地 FTS，不需要外发或向量化。
  const unindexed = all<{ id: number; document_id: number; clause_path: string | null; content: string }>(
    'SELECT c.* FROM kb_chunk c WHERE NOT EXISTS(SELECT 1 FROM kb_chunk_search s WHERE s.id=c.id)');
  if (unindexed.length) tx(() => {
    for (const c of unindexed) run('INSERT INTO kb_chunk_search(id,document_id,clause_path,seg_text) VALUES(?,?,?,?)',
      [c.id, c.document_id, c.clause_path, segCJK(c.content)]);
  });
  const { chunks, terms } = extractTerms(keyword);
  const match = buildMatch([...chunks, ...terms.filter(t => t.length >= 3).slice(0, 24)].join(' '));
  const ids = [...eligible.keys()];
  const clauseRows = match ? all<{ chunkId: number; documentId: number; content: string; heading: string | null }>(
    `SELECT c.id AS chunkId,c.document_id AS documentId,c.content,COALESCE(c.clause_path,c.heading) AS heading
     FROM kb_chunk_fts JOIN kb_chunk c ON c.id=kb_chunk_fts.rowid
     WHERE kb_chunk_fts MATCH ? AND c.document_id IN (${ids.map(() => '?').join(',')})
     ORDER BY bm25(kb_chunk_fts) LIMIT ?`, [match, ...ids, Math.max(limit * 3, documentIds.length)]) : [];
  const merged = new Map<number, KnowledgeHit>();
  const makeHit = (c: { chunkId: number; documentId: number; content: string; heading: string | null }, score: number, retrieval: KnowledgeHit['retrieval']): KnowledgeHit => {
    const d = eligible.get(c.documentId)!;
    return { source: 'policy', sourceLabel: d.scope_layer === 'reference' ? '参考制度（非本单位）' : '制度依据',
      id: d.id, title: d.title, snippet: c.content, heading: c.heading, score,
      documentId: d.id, artifactId: d.artifact_id, chunkId: c.chunkId, docNo: d.doc_no, scopeLayer: d.scope_layer, retrieval };
  };
  clauseRows.forEach((c, i) => merged.set(c.chunkId, makeHit(c, 0.8 / (1 + i * 0.1), 'fulltext')));
  // 制度名称与文号也可定位正文，不依赖正文重复出现文件标题。
  for (const doc of eligible.values()) {
    if (!keyword.includes(doc.title) && !doc.title.includes(keyword)
      && !(doc.doc_no && (keyword.includes(doc.doc_no) || doc.doc_no.includes(keyword)))) continue;
    const first = all<{ chunkId: number; documentId: number; content: string; heading: string | null }>(
      `SELECT id AS chunkId,document_id AS documentId,content,COALESCE(clause_path,heading) AS heading
       FROM kb_chunk WHERE document_id=? ORDER BY seq LIMIT 1`, [doc.id])[0];
    if (first) merged.set(first.chunkId, makeHit(first, 1, 'fulltext'));
  }
  // 点名的制度至少提供一条正文；不得被其他制度的高分结果挤掉。
  for (const id of documentIds) {
    if ([...merged.values()].some(h => h.documentId === id)) continue;
    if (!eligible.has(id)) continue;
    const c = all<{ chunkId: number; documentId: number; content: string; heading: string | null }>(
      `SELECT id AS chunkId,document_id AS documentId,content,COALESCE(clause_path,heading) AS heading
       FROM kb_chunk WHERE document_id=? ORDER BY seq LIMIT 1`, [id])[0];
    if (c) merged.set(c.chunkId, makeHit(c, 0.1, 'specified'));
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
  const selected = documentIds.map(id => ranked.find(h => h.documentId === id)).filter((h): h is KnowledgeHit => !!h);
  const seen = new Set(selected.map(h => h.chunkId));
  const hits = [...selected, ...ranked.filter(h => !seen.has(h.chunkId))].slice(0, Math.max(limit, selected.length));
  return { hits };
}

/* ============================== 统一检索 ============================== */

/**
 * 同时检索两个模块。
 *
 * @param modules 限定检索模块；默认只查模板，制度需要调用方明确启用。
 * @param budget  总条数上限，按分数在模块间分配 —— 避免一个模块把位置占满
 * @param workTypeId 当前工作的工作类型，用于给同类模板加分
 */
export async function searchKnowledge(
  keyword: string,
  opts: { modules?: KnowledgeSource[]; budget?: number; policyMinScore?: number; workTypeId?: number | null; documentIds?: number[]; authorityOnly?: boolean } = {},
): Promise<KnowledgeSearchResult> {
  const kw = keyword.trim();
  const budget = Math.max(1, opts.budget ?? 6);
  const modules = opts.modules?.length ? opts.modules : (['template'] as KnowledgeSource[]);

  const corpus = kbCorpus(modules.includes('policy'));
  if (!kw) {
    return { ok: true, hits: [], counts: { template: 0, policy: 0 }, corpus, skipped: '没有给出检索词' };
  }
  // 检索词里切不出任何关键词（例如只有标点或符号）时不必往下跑 ——
  // 否则会返回「知识库里没有向量化内容」这种牛头不对马嘴的原因
  if (!extractTerms(kw).chunks.length) {
    return { ok: true, hits: [], counts: { template: 0, policy: 0 }, corpus, skipped: '检索词里没有可用的关键词' };
  }

  // 两个模块各取 budget 条，再合并排序后截到 budget
  const [tplHits, polRes] = await Promise.all([
    Promise.resolve(modules.includes('template') ? searchTemplates(kw, budget, opts.workTypeId) : []),
    modules.includes('policy')
      ? searchPolicies(kw, budget, opts.documentIds, opts.authorityOnly)
      : Promise.resolve({ hits: [] as KnowledgeHit[], error: undefined as string | undefined }),
  ]);
  const polHits = polRes.hits;

  const merged = modules.length === 1 && modules[0] === 'policy' ? polHits
    : [...tplHits, ...polHits].sort((a, b) => b.score - a.score).slice(0, budget);
  return {
    ok: true,
    hits: merged,
    counts: { template: tplHits.length, policy: polHits.length },
    corpus,
    // 两个模块都空时给个能解释的原因
    error: polRes.error,
  };
}

function kbCorpus(includePolicy: boolean): { templates: number; documents: number; chunks: number } {
  const templates = all<{ n: number }>('SELECT COUNT(*) AS n FROM template WHERE archived_at IS NULL')[0]?.n ?? 0;
  const documents = includePolicy ? all<{ n: number }>('SELECT COUNT(*) AS n FROM kb_document')[0]?.n ?? 0 : 0;
  const chunks = includePolicy ? all<{ n: number }>('SELECT COUNT(*) AS n FROM kb_chunk')[0]?.n ?? 0 : 0;
  return { templates, documents, chunks };
}

/* ============================== 给模型的上下文 ============================== */

/**
 * 把检索结果拼成提示词片段。
 *
 * 两个模块的条目格式统一，但标出各自来源 —— 这样模型知道
 * 「这条是制度规定」还是「这条是可用模板」，用起来的语气和方式不同。
 * 没命中的候选表另外归成一组：它们是「可以用的表」，不是「必须照的依据」，
 * 混在一起会让模型误以为每张表都要出一份。
 */
export function formatKnowledgeForPrompt(hits: KnowledgeHit[]): string {
  if (!hits.length) return '';
  const main = hits.filter((h) => !h.optional);
  const optional = hits.filter((h) => h.optional);

  const parts = main.map((h, i) => {
    const role = h.source === 'template' ? '模板格式参考，不作为制度规定' : h.scopeLayer === 'reference' ? '外单位参考，不作为本单位强制要求' : `制度依据${i + 1}`;
    const head = `【${role}｜《${h.title}》${h.docNo ? `（${h.docNo}）` : ''}${h.heading ? ` · ${h.heading}` : ''}】`;
    return `${head}\n${h.snippet}`;
  });
  if (optional.length) {
    parts.push(
      `【本类工作还有这些表可用】（来自模板库，按需选用，不是每张都要出）\n` +
        optional.map((h) => `- ${h.title}（${h.snippet}）`).join('\n'),
    );
  }
  return parts.join('\n\n');
}

/**
 * 决定这一轮要不要检索。
 *
 * 「大模型思考的时候可以把他俩都作为依据，不需要每次思考都要」——
 * 所以不是无条件检索：没有可依据的线索时直接跳过，省一次调用。
 * 判据：有没有足够具体的线索（本次特别要求 / 参考资料正文 / 模板可填项里的长文本项）。
 */
export function shouldSearchKnowledge(input: {
  instruction?: string;
  referenceText?: string;
  templateVars?: { name: string; type?: string | null }[];
  explicit?: boolean;
}): { search: boolean; reason: string } {
  if (input.explicit) return { search: true, reason: '调用方显式要求' };

  const instr = (input.instruction ?? '').trim();
  if (instr.length >= 8) return { search: true, reason: '有本次特别要求，可作为检索线索' };

  const ref = (input.referenceText ?? '').trim();
  if (ref.length >= 30) return { search: true, reason: '有参考资料，取其要点作检索线索' };

  // 模板里有需要成段撰写的项（longtext）时，制度类依据往往有用
  const longText = (input.templateVars ?? []).filter((v) => v.type === 'longtext');
  if (longText.length > 0) return { search: true, reason: `模板含 ${longText.length} 个成段填写项` };

  return { search: false, reason: '没有足够具体的线索，跳过检索' };
}

/** 从线索里抽出检索词：取要求/参考的开头部分，去掉换行，压到几十字 */
export function buildKnowledgeQuery(input: { instruction?: string; referenceText?: string; templateName?: string }): string {
  const src = (input.instruction?.replace(/(?:请\s*)?帮我参考制度/g, '').trim() || input.referenceText?.trim() || '');
  const flat = src.replace(/\s+/g, ' ').slice(0, 120);
  const base = flat || (input.templateName ?? '');
  return base.trim();
}
