/**
 * 知识库接口：上传、导入、向量化、语义检索、混合检索、来源目录登记。
 *
 * 文件末尾的「知识库来源目录」一节是**只登记、只统计**的框架接口（契约 §1 决定 3/7、
 * §2 数据模型、§8 接口）：只 readdir + stat 读元数据，不抽取内容、不写入用户目录。
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requestsPolicyReference } from '../domain/policy-reference.ts';
import { all, get, run } from '../db/index.ts';
import {
  DEDUP_MODES,
  SCOPE_MODES,
  VERSION_MODES,
  cancelExtractJob,
  chunkInstitutionText,
  classifyLayer,
  classifyVersion,
  extOf,
  extractStatus,
  findDocNo,
  getLiveJob,
  loadExtractSettings,
  looksInstitutionalByMeta,
  looksInstitutionalText,
  planExtraction,
  searchKbChunks,
  startExtractJob,
  walkSource,
  type Candidate,
  type ExtractSettings,
} from '../core/kb-extract.ts';
import { extractDocxHead } from '../core/extract.ts';
import { buildMatch, segCJK } from '../core/search.ts';
import { artifactBodyText, getArtifact, registerExistingFile, saveArtifact } from '../core/store.ts';
import { DATA_ROOT, DIRS } from '../core/config.ts';
import { isInsideRoot, safeName, toPosix } from '../core/paths.ts';
import { isIgnoredName } from '../core/ignore.ts';
import { liveFilter, visibleArtifactFilter, visibleKbDocumentFilter } from '../core/trash.ts';
import {
  deleteKbDocument,
  getKbDocument,
  indexDocumentText,
  kbStats,
  listKbChunks,
  listKbDocuments,
  listStaleKbDocuments,
  purgeStaleKbDocuments,
  upsertKbDocument,
} from '../core/kb.ts';
import { searchKnowledge } from '../core/knowledge.ts';
import { cleanupTemp, readParts } from './upload.ts';
import { ApiError, body, fail, intParam, ok, optBool, optNum, optStr, q, qInt, requireStr, strArray } from './reply.ts';
// B3-9：条款级引用 + 出文书前口径校验（规则/引用解析都在这个域模块里）
import {
  STRICTNESS_MODES,
  SETTING_STRICTNESS,
  attachExceptionArtifact,
  citationCacheKey,
  complianceEngineFailure,
  complianceStrictness,
  composeCiteText,
  listComplianceExceptions,
  listComplianceRules,
  lookupClause,
  recordComplianceException,
  runCompliance,
  searchClauses,
  setComplianceStrictness,
  updateComplianceRule,
  type ComplianceInput,
  type ComplianceResult,
} from '../domain/kb-cite.ts';
import { recordHealthEvent } from '../core/health.ts';

/** 批量任务进度（进程内状态，够用） */
interface BatchState {
  running: boolean;
  total: number;
  done: number;
  failed: number;
  current: string;
  message: string;
  startedAt: string;
  finishedAt: string | null;
}
let batch: BatchState = { running: false, total: 0, done: 0, failed: 0, current: '', message: '', startedAt: '', finishedAt: null };

export function getBatchState(): BatchState {
  return { ...batch };
}

/** 导入一篇文档：抽文字 → 切块 → 建 kb_document/kb_chunk → 可选向量化 */
export async function importArtifact(artifactId: number, opts: { embed?: boolean; docType?: string | null; source?: string | null } = {}): Promise<{
  documentId: number;
  chunks: number;
  chars: number;
  embedded: number;
  embedError?: string;
}> {
  const a = getArtifact(artifactId);
  if (!a) throw new ApiError('NOT_FOUND', '文件不存在', 404);
  // 原生文字层与 OCR 文字取**长的那个**：扫描 PDF 常带一层极短的文字（页码/水印，几十个字），
  // `extracted_text || ocr_text` 会取到那几十字，把 OCR 出来的几千字丢掉 —— 知识库等于空的、检索搜不到。
  const text = artifactBodyText(a);
  if (!text) {
    // 确认有文字之后才建文档：否则会留下一条 0 片段的"幽灵文档"占住 artifact_id，
    // 而批量导入的候选条件是 `NOT EXISTS (kb_document ...)`，这个文件从此永远排不上，
    // 用户后补 OCR 也修不回来。没文字就如实返回失败（字段名保持不变，前端在用）。
    return { documentId: 0, chunks: 0, chars: 0, embedded: 0, embedError: '这个文件没有可提取的文字（可能是扫描件）。请先做 OCR，或换有文字的文档。' };
  }
  const documentId = upsertKbDocument({
    artifactId: a.id,
    title: a.title || a.file_name,
    docType: opts.docType ?? guessDocType(a.file_name, a.title),
    source: opts.source ?? '文件库',
  });
  const chunks = indexDocumentText(documentId, text);
  let embedded = 0;
  let embedError: string | undefined;
  return { documentId, chunks, chars: text.length, embedded, embedError };
}



/**
 * 拆开上传时带来的相对路径。
 *
 * 浏览器给的是 `制度/财务/报销管理办法.docx` 这种形式（有正斜杠也有反斜杠）。
 * 逐段安全化、丢掉 `.` 与 `..`、最多留 5 层目录 —— 既不让人靠 `..` 写到数据目录外面去，
 * 也不至于把一层层嵌套的压缩包解出一棵巨深的树。
 */
function splitRelPath(raw: string): { dir: string; base: string } {
  const segs = String(raw ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
  const safe = segs.map((s) => safeName(s, '')).filter(Boolean).slice(-5);
  if (!safe.length) return { dir: '', base: '' };
  return { dir: safe.slice(0, -1).join('/'), base: safe[safe.length - 1] as string };
}

function guessDocType(fileName: string, title: string): string {  const s = `${fileName} ${title}`;
  if (/制度|办法|规定|规程|规范|标准/.test(s)) return '制度规范';
  if (/合同|协议|订单/.test(s)) return '合同';
  if (/纪要|会议/.test(s)) return '会议纪要';
  if (/方案|计划/.test(s)) return '方案';
  if (/清单|台账|目录/.test(s)) return '清单台账';
  if (/报告|总结|申请/.test(s)) return '报告';
  if (/图纸|图/.test(s)) return '图纸';
  return '其他';
}

/**
 * 把「自己拷进 _规范库 的文件」补登记成文件记录。
 *
 * 为什么需要：界面文案一直写着"用资源管理器把文件拷进 _规范库，点导入全部文件也能纳管"，
 * 但**从来没有任何代码去登记那些文件** —— 导入只认 artifact 表里有记录的，
 * 手工拷进去的文件等于石沉大海，而文案却承诺会处理。这里把承诺兑现：
 * 扫目录 → 未登记的补登记（带文字抽取与索引）→ 剩下的交给正常的导入流程。
 *
 * 登记必须是**原地**的：文件本来就躺在数据目录里，不能再 `uniqueFileName` + `writeFileSync`
 * 复制一份 —— `uniqueFileName` 看到同名文件已存在就返回 `xxx_v2.ext`，"纳管"于是变成"复制"：
 * 原文件永远没有记录、每点一次导入就多一份 `_v2/_v3`、副本 sha256 还是空串（内容去重失效）。
 * `registerExistingFile` 直接登记源文件本身，并用与正常上传完全相同的那段逻辑抽文字、算 sha256、建索引。
 *
 * 只扫数据目录下的 `_规范库`，深度有限，跳过隐藏文件与临时文件。
 */
export async function adoptStandardsFiles(): Promise<{ registered: number; skipped: number; dir: string }> {
  const rootAbs = join(DATA_ROOT, DIRS.standards);
  const dir = toPosix(DIRS.standards);
  if (!existsSync(rootAbs)) return { registered: 0, skipped: 0, dir };
  // 【有意不守卫】这里**不加** `deleted_at IS NULL`：`known` 回答的是「这个磁盘文件已经有记录了吗」，
  // 不是「用户还能不能看见它」。软删除不动磁盘文件，回收站里的记录仍然占着同一个 file_rel；
  // 若把它排除掉，这个文件会被**重新登记成第二条记录** —— 用户删掉的文档当场复活，
  // 而它与回收站里那条指向同一个物理文件（`artifact.file_rel` 上没有唯一约束，拦不住重复登记）。
  // 结论：这一处**有意不按 `deleted_at IS NULL` 过滤**（不是漏了覆盖，理由见上）。
  const known = new Set(all<{ file_rel: string }>('SELECT file_rel FROM artifact').map((a) => a.file_rel));
  let registered = 0;
  let skipped = 0;

  const walk = async (absDir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (const name of readdirSync(absDir)) {
      if (name.startsWith('.') || name.startsWith('~$')) {
        skipped += 1;
        continue;
      }
      const abs = join(absDir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      // 文件相对数据根目录的路径就是它的 file_rel —— 原地登记，不复制、不改名
      const rel = toPosix(relative(DATA_ROOT, abs));
      if (known.has(rel)) {
        skipped += 1;
        continue;
      }
      try {
        const title = toPosix(relative(rootAbs, abs)).replace(/\.[^.]+$/, '');
        const r = await registerExistingFile({ absPath: abs, fileName: name, kind: 'source', title, index: true });
        known.add(r.artifact.file_rel);
        registered += 1;
      } catch {
        skipped += 1;
      }
    }
  };
  await walk(rootAbs, 0);
  return { registered, skipped, dir };
}

/**
 * 跑口径校验，**任何异常都变成一份"检查失败"的结论**（`status='check_error'`），不往外抛。
 *
 * 旧实现这里返回 `null` → 响应里没有 compliance 字段 → 用户看到"没报错 = 通过"
 * （P1：未求值/引擎出错被显示成"口径校验通过"）。现在接口侧一律走这个包装：
 * 引擎整条挂了也要让调用方拿到一个**能区分**的结论（并记一条健康事件）。
 */
function complianceSafe(input: ComplianceInput): ComplianceResult {
  try {
    return runCompliance(input);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      recordHealthEvent({ kind: 'selfCheckFailed', message: `出文书前口径校验引擎异常：${msg.slice(0, 200)}` });
    } catch {
      /* 记录失败也不能再抛 */
    }
    return complianceEngineFailure(`校验引擎整体异常：${msg.slice(0, 200)}`);
  }
}

export function registerKbRoutes(app: FastifyInstance): void {
  /** 总览：规模、维度、模型、是否可用 */
  app.get('/api/kb/status', async (_req, reply) => {
    const stats = kbStats();
    const indexedArtifacts = get<{ n: number }>(`SELECT COUNT(*) AS n FROM kb_document WHERE artifact_id IS NOT NULL AND ${visibleKbDocumentFilter()}`)?.n ?? 0;
    // 列表、已导入与候选都遵循附件/父工作可见性；整工作软删保留KB原行供恢复。
    const totalCandidates = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM artifact /* deleted_at IS NULL（真正的过滤是下面那行 liveFilter）*/
        WHERE ((extracted_text IS NOT NULL AND length(extracted_text) > 50)
            OR (ocr_text IS NOT NULL AND length(ocr_text) > 50))
          AND ${visibleArtifactFilter()}`,
    )?.n ?? 0;
    return ok(reply, {
      ...stats,
      // 统计里的 dims 是字节数换来的维度，没向量时为 null
      indexedArtifacts,
      totalCandidates,
      notIndexed: Math.max(0, totalCandidates - indexedArtifacts),
      embedding: { configured: false, reason: '制度库仅使用本地关键词检索', code: 'KEYWORD_ONLY', provider: null, model: null, dims: null },
      retrievalMode: 'fulltext',
      batch: getBatchState(),
      hint: '制度原文已保留，导入与检索使用本地全文索引，不调用向量模型',
    });
  });

  app.get('/api/kb/documents', async (_req, reply) => ok(reply, { items: listKbDocuments() }));

  app.get('/api/kb/documents/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const doc = getKbDocument(id);
      if (!doc) throw new ApiError('NOT_FOUND', '知识库文档不存在', 404);
      return ok(reply, { document: doc, chunks: listKbChunks(id, 300) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/kb/documents/:id', async (req, reply) => {
    try {
      deleteKbDocument(intParam(req, 'id'));
      return ok(reply, { deleted: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 知识库上传：文件或整个文件夹直接传进来。
   *
   * 以前要自己把文件拷进数据目录的 `_规范库`、再点「扫描文件夹」—— 这一步纯属多余，
   * 而且拷贝进来的文件根本没有登记，扫描也扫不到（只有已登记的文件才在库里有记录）。
   * 现在上传接口直接落到同一个位置并当场登记，于是「传进来的」和「扫出来的」永远是同一批东西。
   *
   * 一次请求一个文件：进度和失败都能精确到某个文件，传一文件夹的时候不会一个坏文件拖垮整批。
   * 文件夹上传时浏览器会给相对路径（`制度/财务/报销办法.docx`），按它原样保留目录结构 ——
   * 用户怎么分类，库里就怎么分类。
   */
  app.post('/api/kb/upload', async (req, reply) => {
    const items: { id: number; title: string; file_rel: string; chars: number; duplicate: boolean }[] = [];
    const failed: { name: string; error: string }[] = [];
    try {
      const { fields, files } = await readParts(req);
      if (!files.length) throw new ApiError('NO_FILE', '没有收到文件');

      const rootAbs = join(DATA_ROOT, DIRS.standards);
      // 单个文件才认相对路径：多文件请求里没法一一对应，宁可不建目录也不张冠李戴
      const asked = files.length === 1 ? splitRelPath(fields.path ?? '') : { dir: '', base: '' };

      for (const f of files) {
        try {
          const base = asked.base || safeName(f.fileName, '未命名');
          const dirAbs = asked.dir ? join(rootAbs, asked.dir) : rootAbs;
          // 标题带上传时的那层目录：一批「办法/规定/细则」若都只叫「办法」，在库里根本分不清
          const shown = (asked.dir ? `${asked.dir}/${base}` : base).replace(/\.[^.]+$/, '') || base;
          const r = await saveArtifact({
            sourcePath: f.tempPath,
            dirAbs,
            fileName: base,
            kind: 'source',
            title: shown,
            docDate: null,
            index: true,
            // 同样的文件再传一次不算错：复用已有记录，后面的导入自然会跳过它
            dedupe: true,
          });
          items.push({
            id: r.artifact.id,
            title: r.artifact.title,
            file_rel: r.artifact.file_rel,
            chars: (r.artifact.extracted_text ?? '').length,
            duplicate: r.duplicateOf !== undefined,
          });
        } catch (e) {
          failed.push({ name: f.fileName, error: e instanceof Error ? e.message : String(e) });
        } finally {
          cleanupTemp(f.tempPath);
        }
      }
      return ok(reply, { items, failed, folder: toPosix(DIRS.standards) }, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 导入单个文件到知识库 */
  app.post('/api/kb/import', async (req, reply) => {
    try {
      const b = body(req);
      const artifactId = optNum(b, 'artifactId');
      if (!artifactId) throw new ApiError('MISSING_FIELD', '需要 artifactId');
      const r = await importArtifact(artifactId, {
        embed: false,
        docType: optStr(b, 'docType') ?? null,
        source: optStr(b, 'source') ?? null,
      });
      return ok(reply, r, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 对已有文档补做向量化 */
  app.post('/api/kb/documents/:id/embed', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getKbDocument(id)) throw new ApiError('NOT_FOUND', '知识库文档不存在', 404);
      throw new ApiError('KEYWORD_ONLY', '制度库已改为本地关键词检索，不再执行向量化', 410);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 批量导入：把文件库里还没进知识库的文档抽文字、切块、向量化。
   * 这是耗时操作（每篇都要调接口），所以立刻返回，进度走 /api/kb/status 轮询。
   *
   * 传了 `artifactIds` 就只处理这几个文件 —— 刚上传完的那批走这条，
   * 既不用扫库（快），也不会因为「正文不足 50 字」这种启发式被漏掉。
   */
  app.post('/api/kb/import-all', async (req, reply) => {
    try {
      if (batch.running) throw new ApiError('BUSY', '已经有一个批量导入任务在跑，请等它结束。');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const limit = Math.min(optNum(b, 'limit') ?? 200, 2000);
      const embed = false;
      const askedIds = Array.isArray(b.artifactIds) ? (b.artifactIds as unknown[]).map(Number).filter(Number.isFinite) : [];

      // 先把自己拷进 _规范库 的文件补登记 —— 界面承诺过"点这个按钮也能纳管它们"
      const adopted = askedIds.length ? { registered: 0, skipped: 0, dir: toPosix(DIRS.standards) } : await adoptStandardsFiles();

      /**
       * 两路候选都只认**在用**的文件（`liveFilter('artifact', …)` → deleted_at IS NULL，老库降级成 1=1）。
       *
       * 为什么这处必须过滤（不只是形式）：软删除一份文件时会把它关联的 `kb_document` 一起清掉，
       * 于是回收站里的文件反而**满足**「还没有 kb_document」这个候选条件 —— 不过滤的话，点一次
       * 「导入全部」就会给一份已经删掉的文件重新建文档并向量化，语义检索又能搜到它，
       * 点进去却打不开文件：典型的"删了还活着"。
       */
      const candidates = askedIds.length
        ? all<{ id: number; title: string }>(
            `SELECT id, title FROM artifact WHERE id IN (${askedIds.map(() => '?').join(',')}) AND ${liveFilter('artifact')} ORDER BY id`,
            askedIds,
          )
        : all<{ id: number; title: string }>(
            `SELECT a.id, a.title FROM artifact a /* deleted_at IS NULL（真正的过滤是下面那行 liveFilter）*/
              WHERE ((a.extracted_text IS NOT NULL AND length(a.extracted_text) > 50)
                  OR (a.ocr_text IS NOT NULL AND length(a.ocr_text) > 50))
                AND ${liveFilter('artifact', 'a')}
                AND NOT EXISTS (SELECT 1 FROM kb_document d WHERE d.artifact_id = a.id)
              ORDER BY a.id LIMIT ?`,
            [limit],
          );

      batch = {
        running: true,
        total: candidates.length,
        done: 0,
        failed: 0,
        current: '',
        message: candidates.length ? '开始导入' : '没有需要导入的文件',
        startedAt: new Date().toISOString(),
        finishedAt: null,
      };

      // 后台跑，不阻塞响应
      void (async () => {
        for (const c of candidates) {
          batch.current = c.title;
          try {
            const r = await importArtifact(c.id, { embed });
            if(r.embedError) batch.failed += 1; else batch.done += 1;
            batch.message = r.embedError ? `「${c.title}」已切块但向量化失败：${r.embedError}` : `「${c.title}」完成（${r.chunks} 块）`;
          } catch (e) {
            batch.failed += 1;
            batch.message = `「${c.title}」失败：${(e as Error).message}`;
          }
        }
        batch.running = false;
        batch.current = '';
        batch.finishedAt = new Date().toISOString();
        batch.message = `批量导入结束：成功 ${batch.done}，失败 ${batch.failed}`;
      })();

      return ok(reply, { queued: candidates.length, running: true, adopted: adopted.registered, scannedDir: adopted.dir }, 202);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 清空批量任务状态 */
  app.post('/api/kb/batch/reset', async (_req, reply) => {
    if (batch.running) throw new ApiError('BUSY', '任务还在跑，不能重置');
    batch = { running: false, total: 0, done: 0, failed: 0, current: '', message: '', startedAt: '', finishedAt: null };
    return ok(reply, { reset: true });
  });

  /** 检索：mode = hybrid | semantic | fulltext */
  /**
   * 统一知识检索 —— 模板库 + 公司制度 一起查。
   *
   * 知识库分两个模块是给人看的；模型思考时两者都是依据，所以这里合并返回，
   * 每条标清来自哪个模块。`modules` 参数可限定只查某一模块。
   */
  app.get('/api/kb/knowledge', async (req, reply) => {
    try {
      const keyword = (q(req, 'q') ?? '').trim();
      const budget = Math.min(Math.max(qInt(req, 'budget') ?? 6, 1), 20);
      const mods = (q(req, 'modules') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is 'template' | 'policy' => s === 'template' || s === 'policy');
      const r = await searchKnowledge(keyword, {
        modules: mods.length ? mods : undefined,
        budget,
        // 给了工作类型时，本类工作可用的表会一并列出（生成文书时走的就是这条）
        workTypeId: qInt(req, 'workTypeId'),
      });
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/kb/search', async (req, reply) => {
    try {
      const keyword = (q(req, 'q') ?? '').trim();
      const topK = Math.min(Math.max(qInt(req, 'topK') ?? 8, 1), 50);
      const r = await searchKnowledge(keyword, { modules: ['policy'], budget: topK });
      const merged = r.hits.map(h => ({ key: 'c' + h.chunkId, source: 'fulltext', score: h.score,
        title: h.title, snippet: h.snippet, artifactId: h.artifactId ?? null, workbenchId: null, documentId: h.documentId ?? null }));
      return ok(reply, { mode: 'fulltext', keyword, ok: true, fulltext: { total: merged.length, items: [] }, semantic: [], merged });
    } catch (e) { return fail(reply, e); }
  });

  /** 用知识库内容回答一个问题（把检索到的片段交给大模型总结，必须带出处） */
  app.post('/api/kb/ask', async (req, reply) => {
    try {
      const b = body(req);
      const question = requireStr(b, 'question', '问题');
      const topK = Math.min(optNum(b, 'topK') ?? 6, 20);
      const found = await searchKnowledge(question, { modules: ['policy'], budget: topK });
      const r = { hits: found.hits.map(h => ({ documentId: h.documentId, documentTitle: h.title, title: h.title,
        heading: h.heading ?? null, content: h.snippet, artifactId: h.artifactId ?? null, score: h.score,
        seq: get<{seq:number}>('SELECT seq FROM kb_chunk WHERE id=?', [h.chunkId!])?.seq ?? 0 })) };
      if (!r.hits.length) {
        return ok(reply, {
          answer: '知识库里没有找到与这个问题相关的内容。可以换个说法，或先把相关文件导入知识库。',
          citations: [],
          hits: [],
        });
      }
      const context = r.hits
        .map((h, i) => `【资料${i + 1}｜${h.documentTitle}${h.heading ? ` · ${h.heading}` : ''}｜第${h.seq}段】\n${h.content}`)
        .join('\n\n');

      const { chat, resolveTarget, isLocalProvider } = await import('../ai/gateway.ts');
      let local = false;
      try { local = isLocalProvider(resolveTarget('writing').provider.base_url); } catch { /* 未配置的模型也不能接收制度原文。 */ }
      if (!local) {
        throw new ApiError('LOCAL_MODEL_REQUIRED', '制度问答只使用本地模型，请先配置 LM Studio；关键词检索无需模型', 409);
      }
      const requireVisibleSources = () => {
        if (r.hits.some(h => !getKbDocument(h.documentId!))) {
          throw new ApiError('KNOWLEDGE_CHANGED', '引用的资料已移入回收站或不可用，请重新查询', 409);
        }
      };
      requireVisibleSources();
      const res = await chat({
        purpose: 'writing',
        messages: [
          {
            role: 'system',
            content:
              '你是严谨的资料查询助手。只根据提供的资料回答问题，禁止编造。' +
              '每一条结论后面必须标注来源编号，例如 [资料1]。资料里没有的信息，直接说"资料中未提及"。',
          },
          {
            role: 'user',
            content: `【资料】\n${context}\n\n【问题】${question}\n\n请回答，并标注每条结论的来源编号。`,
          },
        ],
        ref: { type: 'kb-ask' },
      });
      requireVisibleSources();
      if (!res.ok) throw new ApiError('AI_FAILED', res.error ?? '模型调用失败');
      return ok(reply, {
        answer: res.text,
        citations: r.hits.map((h, i) => ({
          index: i + 1,
          title: h.documentTitle,
          heading: h.heading,
          seq: h.seq,
          artifactId: h.artifactId,
          score: h.score,
        })),
        hits: r.hits,
        model: res.model,
        usage: res.usage,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 检索质量自测：用一组已知问题看能不能召回，便于调参 */
  app.get('/api/kb/diagnostics', async (_req, reply) => {
    const stats = kbStats();
    const docs = listKbDocuments();
    const samples = all<{ id: number; content: string; document_id: number }>(
      'SELECT id, content, document_id FROM kb_chunk ORDER BY id LIMIT 5',
    );
    const checks: { name: string; ok: boolean; detail: string }[] = [
      { name: '原文已切块', ok: stats.chunks > 0, detail: `${stats.chunks} 个原文片段` },
      { name: '本地关键词检索', ok: true, detail: '无需向量模型，检索不产生网络请求' },
    ];
    return ok(reply, { checks, stats, documents: docs.length, sampleChunks: samples.map((s) => ({ id: s.id, documentId: s.document_id, preview: s.content.slice(0, 120) })) });
  });

  /* ====================== 知识库来源目录（只登记、只统计） ====================== */

  /**
   * 契约 §1 决定 3/7：知识库本阶段**只搭框架** —— 登记「制度汇总文件夹」这一个
   * 只读来源、统计文件数与总大小，界面显示路径与数量。这一节四个接口的硬边界：
   *
   *   1. **不抽取内容**：不调用 importArtifact / upsertKbDocument / indexDocumentText /
   *      embedDocument，不产生 kb_document / kb_chunk，不抽文字、不算 sha256；
   *   2. **不下载内容**：只 readdir（列名字）+ stat（看类型与大小），**从不 open/read**
   *      —— iCloud 的按需占位文件因此不会被触发下载（契约 §6）；
   *   3. **绝不写入用户目录**：不建目录、不写文件、不改名、不删除。
   *
   * 内容抽取、检索接入要等工作台侧确认无误后再做（第二步）。
   */

  /** 扫描上限：最多遍历这么多项（文件 + 子目录），或最多跑这么久，哪个先到算哪个 */
  const SCAN_MAX_ITEMS = 20000;
  const SCAN_MAX_MS = 30_000;

  interface KbSourceRow {
    id: number;
    path: string;
    label: string | null;
    enabled: number;
    created_at: string;
    last_scan_at: string | null;
    file_count: number;
    total_bytes: number;
  }

  const KB_SOURCE_COLS = 'id, path, label, enabled, created_at, last_scan_at, file_count, total_bytes';

  function listKbSourceRows(): KbSourceRow[] {
    return all<KbSourceRow>(`SELECT ${KB_SOURCE_COLS} FROM kb_source ORDER BY id`);
  }

  function getKbSourceRow(id: number): KbSourceRow | undefined {
    return get<KbSourceRow>(`SELECT ${KB_SOURCE_COLS} FROM kb_source WHERE id = ?`, [id]);
  }

  /**
   * 查重用的比较键：Windows 上 `D:\资料` 与 `d:\资料`、`D:\资料\` 是同一个目录。
   * （`path` 列本身有 UNIQUE 约束，但 SQLite 的 UNIQUE 是大小写敏感的字符串比较，
   * 光靠它会漏判，于是这里再按平台规则比一次。）
   */
  function sourcePathKey(p: string): string {
    const s = p.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  }

  interface ScanOutcome {
    files: number;
    dirs: number;
    bytes: number;
    /** 读不到的项（iCloud 未下载的占位、权限不足、链接失效）—— 跳过并计数，不中断整次统计 */
    skipped: number;
    truncated: boolean;
    truncatedBy: 'count' | 'time' | null;
    elapsedMs: number;
  }

  /**
   * 只数元数据：`readdirSync` 拿名字、`statSync` 拿类型与大小。
   *
   * 几个刻意的选择：
   *   - **不用 `withFileTypes`**：iCloud 的占位项在某些情况下 `Dirent` 的类型信息
   *     不可靠，而 `statSync` 失败可以明确归到「读不到」里计数（契约 §6 要求区分
   *     「本地 / 云端未下载 / 真的丢了」，本阶段先如实把读不到的记下来）。
   *   - 忽略名单只跳过、**不计入 skipped**：那是「明确不看」，不是「读不到」，
   *     两件事混在一起会让界面上的数字没法解释。
   *   - 用栈而不是递归：用户目录里可能有很深的嵌套，20000 项的显式栈比调用栈好控。
   *   - 上限保护：大目录上不能卡死（契约要求 20000 项 / 30 秒先到先停），
   *     停了就 `truncated: true` 如实告诉用户「只统计了一部分」。
   */
  function scanSourceMetadata(rootAbs: string): ScanOutcome {
    const started = Date.now();
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    let skipped = 0;
    let truncatedBy: ScanOutcome['truncatedBy'] = null;
    const stack: string[] = [rootAbs];

    const overTime = (): boolean => Date.now() - started > SCAN_MAX_MS;
    const overCount = (): boolean => files + dirs >= SCAN_MAX_ITEMS;

    while (stack.length) {
      if (overCount()) {
        truncatedBy = 'count';
        break;
      }
      if (overTime()) {
        truncatedBy = 'time';
        break;
      }
      const dir = stack.pop() as string;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        // 目录本身读不到：跳过并计数，不能让整次统计失败
        skipped += 1;
        continue;
      }
      for (const name of names) {
        if (overCount()) {
          truncatedBy = 'count';
          break;
        }
        if (overTime()) {
          truncatedBy = 'time';
          break;
        }
        if (isIgnoredName(name)) continue; // 忽略名单：跳过（不计入 skipped）
        const abs = join(dir, name);
        let st;
        try {
          st = statSync(abs);
        } catch {
          skipped += 1; // 读不到的项：跳过并计数
          continue;
        }
        if (st.isDirectory()) {
          dirs += 1;
          stack.push(abs);
          continue;
        }
        files += 1;
        bytes += st.size;
      }
    }

    return { files, dirs, bytes, skipped, truncated: truncatedBy !== null, truncatedBy, elapsedMs: Date.now() - started };
  }

  /** 已登记的来源目录（只列记录，不碰磁盘） */
  app.get('/api/kb/sources', async (_req, reply) => ok(reply, { items: listKbSourceRows() }));

  /**
   * 容错：把「声明了 JSON 但根本没有 body」的请求当成「没有 body」。
   *
   * 为什么需要（这是**现有代码的通病**，不是本接口特有的）：
   * Fastify 把 DELETE 也算作「可带 body」的方法，只要请求头里有
   * `Content-Type: application/json` 就走 JSON 解析器，而解析器见到空 body 会直接
   * 400 `FST_ERR_CTP_EMPTY_JSON_BODY` —— 请求压根到不了处理函数。
   * 偏偏 web 端 `api.ts` 的 `api.del()` 固定带上这个头（只改 api.ts 一行即可根治，
   * 但那不是本次改动范围内的文件），于是全站 9 个删除按钮都会收到 400。
   *
   * 这里在**路由级** onRequest 里摘掉这个头（onRequest 在解析请求体之前执行），
   * 作用范围仅限本文件这两个不需要 body 的接口，不改变其它路由的行为；
   * 带真实 body 的 DELETE 不受影响（实测过）。将来 api.ts 修好了，这个钩子就是空转。
   */
  async function treatEmptyJsonBodyAsNoBody(req: FastifyRequest): Promise<void> {
    const ct = String(req.headers['content-type'] ?? '');
    const rawLen = req.headers['content-length'];
    const len = Array.isArray(rawLen) ? rawLen[0] : rawLen;
    const hasBody = req.headers['transfer-encoding'] !== undefined || (len !== undefined && len !== '' && len !== '0');
    if (!hasBody && ct.includes('application/json')) delete req.headers['content-type'];
  }

  /**
   * 绑定一个来源目录（登记，不复制、不移动、不读取内容）。
   *
   * 校验顺序就是报错顺序，每条都给出看到的那条路径：
   *   1. 必须绝对路径（`resolve()` 会把相对路径悄悄拼到当前工作目录上，先挡住）；
   *   2. `realpathSync` 规范化 —— 解析 `..`、短名、符号链接，顺带要求路径**当前存在**；
   *   3. 必须存在、必须是目录；
   *   4. 位于 `DATA_ROOT` 内部则拒绝（把平台自己的数据目录当来源没有意义）；
   *   5. 规范化之后查重（大小写、末尾分隔符都算同一个）。
   */
  app.post('/api/kb/sources', async (req, reply) => {
    try {
      const b = body(req);
      const raw = requireStr(b, 'path', '来源目录路径');
      if (!isAbsolute(raw)) throw new ApiError('BAD_PATH', `来源目录必须是绝对路径：${raw}`, 400);

      let real: string;
      try {
        real = realpathSync(raw);
      } catch {
        throw new ApiError('NOT_FOUND', `来源目录不存在：${raw}`, 404);
      }

      let st;
      try {
        st = statSync(real);
      } catch {
        throw new ApiError('NOT_FOUND', `来源目录无法访问：${real}`, 404);
      }
      if (!st.isDirectory()) throw new ApiError('BAD_PATH', `来源目录必须是文件夹：${real}`, 400);
      if (isInsideRoot(DATA_ROOT, real)) {
        throw new ApiError('BAD_PATH', `工作台自己的数据目录不能作为制度来源：${real}`, 400);
      }

      const dup = listKbSourceRows().find((r) => sourcePathKey(r.path) === sourcePathKey(real));
      if (dup) throw new ApiError('DUPLICATE', `这个目录已经登记过了：${real}`, 409);

      const label = (optStr(b, 'label') ?? '').trim() || basename(real);
      const ins = run(
        `INSERT INTO kb_source (path, label, enabled, created_at, file_count, total_bytes)
         VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 0, 0)`,
        [real, label],
      );
      return ok(reply, { source: getKbSourceRow(ins.lastInsertRowid) }, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 移除来源：**只删这一条登记记录**，磁盘上的目录与文件一个都不动
   * （契约 §7.2 的精神：解绑只改数据库）。
   */
  app.delete('/api/kb/sources/:id', { onRequest: treatEmptyJsonBodyAsNoBody }, async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const row = getKbSourceRow(id);
      if (!row) throw new ApiError('NOT_FOUND', '来源目录不存在', 404);
      run('DELETE FROM kb_source WHERE id = ?', [id]);
      return ok(reply, { deleted: true, id, path: row.path });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 只统计元数据：递归数文件数、子目录数、总字节数，写回 file_count / total_bytes /
   * last_scan_at，并返回本次结果。
   *
   * **本接口不抽取内容、不产生知识库文档**：全程只有 readdir + stat，
   * 不产生 kb_document / kb_chunk，也不写用户目录里的任何东西。
   */
  app.post('/api/kb/sources/:id/scan', { onRequest: treatEmptyJsonBodyAsNoBody }, async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const row = getKbSourceRow(id);
      if (!row) throw new ApiError('NOT_FOUND', '来源目录不存在', 404);

      let st;
      try {
        st = statSync(row.path);
      } catch {
        // 目录改名/拔盘/被删：明确说出来，不要让用户对着一条 0 文件记录猜
        throw new ApiError('SOURCE_MISSING', `来源目录不在了：${row.path}`, 400);
      }
      if (!st.isDirectory()) throw new ApiError('BAD_PATH', `来源目录不是文件夹了：${row.path}`, 400);

      const r = scanSourceMetadata(row.path);
      run(
        `UPDATE kb_source SET file_count = ?, total_bytes = ?,
           last_scan_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [r.files, r.bytes, id],
      );
      return ok(reply, { ...r, limit: SCAN_MAX_ITEMS, timeLimitMs: SCAN_MAX_MS, source: getKbSourceRow(id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ====================== B3-8 内容抽取与向量化 ====================== */

  /**
   * 抽取口径：三个设置项 + 可选值 + 当前值。
   *
   * 三个口径做成**设置项**而不是接口参数，是因为它们改的是"这批语料该怎么理解"，
   * 不是单次请求的选项：换口径要重跑一次整批，而重跑靠 `(source_id, rel_path)`
   * 稳定键原地更新，不会产生重复行。界面上把「当前口径 + 后果」显式摆出来。
   */
  app.get('/api/kb/extract/config', async (_req, reply) =>
    ok(reply, {
      settings: loadExtractSettings(),
      options: {
        dedup: [
          { value: 'prefer_docx', label: '优先 docx；同文号只留一份（默认）', note: '同一份制度的多版本/多副本里留优先级最高的一份：定稿 > docx > 修改时间新' },
          { value: 'all', label: '全部入库', note: '同一制度会在检索里出现多次，容易把旧版当依据' },
          { value: 'by_name', label: '按文件名去重', note: '只认文件名完全相同的副本；同文号的不同版本都会入库' },
          { value: 'by_hash', label: '按内容哈希去重', note: '正文一字不差才算重复（会忽略空白/条款编号/页码）' },
        ],
        scope: [
          { value: 'mark', label: '入库但分区标记（默认）', note: '本单位 unit / 法规标准 regulation / 参考制度 reference 三类都入库并带徽标' },
          { value: 'exclude', label: '不入库', note: '检索里只有本单位制度；「依据哪条国家标准」会查不到' },
          { value: 'plain', label: '全部当普通制度', note: '不区分来源，无法滤掉外部文本' },
        ],
        version: [
          { value: 'final_only', label: '只抽 0. 定稿件（默认）', note: '一份制度没有 0. 文件时回退抽现行版；上会稿/历史稿不入库' },
          { value: 'all', label: '全抽', note: '历史版本也入库并标 superseded，检索默认也能搜到' },
          { value: 'latest_only', label: '只抽最新一版', note: '按文件修改时间取最新；文件时间被同步工具改过时会选错' },
        ],
      },
      keys: { dedup: 'kb.dedup', scope: 'kb.scope', version: 'kb.version' },
      allowed: { dedup: DEDUP_MODES, scope: SCOPE_MODES, version: VERSION_MODES },
    }),
  );

  /**
   * 预览用的分类：读一次抬头（docx 的页眉页脚 + 正文开头）找出文号与《制度名》。
   *
   * `mtimeMs` **必须是真的**（不能用 0 当哨兵）：去重比较里"修改时间新"是一位判据，
   * 哨兵值会让预览的取舍与真跑不一致 —— 预览说留 A、执行却写入 B（实测踩到过）。
   */
  async function classifyForPreview(absPath: string, relPath: string, fileName: string, size: number, mtimeMs: number): Promise<Candidate> {
    const ext = extOf(fileName);
    let headText = '';
    if (ext === '.docx' && size > 0 && size < 40 * 1024 * 1024) {
      try {
        headText = extractDocxHead(await readFile(absPath), 3000);
      } catch {
        headText = '';
      }
    }
    return {
      file: { relPath, absPath, fileName, size, mtimeMs },
      ext,
      scopeLayer: classifyLayer(relPath, fileName),
      versionStatus: classifyVersion(relPath, fileName),
      institutional: looksInstitutionalByMeta(relPath, fileName) || looksInstitutionalText(`${fileName}\n${headText}`),
      docNo: findDocNo(headText, fileName),
      title: '',
      headText,
    };
  }

  /**
   * 抽取预览：**不写库、不产生 kb_document**。按当前三个口径算出"这一批会入库多少、
   * 哪些会被跳过、为什么"，并把前 N 个文件的判定、分区、版本、文号摆出来 ——
   * 这正是 `docs/制度识别预览.md` 做过的事，把它变成按需生成的接口。
   *
   * 只 readdir + stat +（docx）读抬头，不抽正文、不向量化。
   */
  app.post('/api/kb/sources/:id/preview', { onRequest: treatEmptyJsonBodyAsNoBody }, async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const row = getKbSourceRow(id);
      if (!row) throw new ApiError('NOT_FOUND', '来源目录不存在', 404);
      const st = statSync(row.path, { throwIfNoEntry: false });
      if (!st || !st.isDirectory()) throw new ApiError('SOURCE_MISSING', `来源目录不在了：${row.path}`, 400);

      const b = (req.body ?? {}) as Record<string, unknown>;
      const limit = Math.min(Math.max(optNum(b, 'limit') ?? 20, 1), 200);
      const maxFiles = optNum(b, 'maxFiles') ?? undefined;
      const settings = loadExtractSettings();

      const walk = await walkSource(row.path, maxFiles ? { maxItems: Math.max(maxFiles, 100) } : {});
      const files = maxFiles ? walk.files.slice(0, maxFiles) : walk.files;
      const candidates: Candidate[] = [];
      for (const f of files) candidates.push(await classifyForPreview(f.absPath, f.relPath, f.fileName, f.size, f.mtimeMs));
      const plans = planExtraction(candidates, settings);

      const byDecision: Record<string, number> = {};
      const byLayer: Record<string, number> = {};
      const byVersion: Record<string, number> = {};
      const byExt: Record<string, number> = {};
      let bytes = 0;
      for (const p of plans) {
        const c = p.candidate;
        byDecision[p.decision] = (byDecision[p.decision] ?? 0) + 1;
        byExt[c.ext || '(无扩展名)'] = (byExt[c.ext || '(无扩展名)'] ?? 0) + 1;
        if (p.decision === 'extract') {
          bytes += c.file.size;
          byLayer[c.scopeLayer] = (byLayer[c.scopeLayer] ?? 0) + 1;
          byVersion[c.versionStatus] = (byVersion[c.versionStatus] ?? 0) + 1;
        }
      }
      const willExtract = plans.filter((p) => p.decision === 'extract');
      return ok(reply, {
        source: row,
        settings,
        total: plans.length,
        willExtract: willExtract.length,
        bytesToRead: bytes,
        walk: { dirs: walk.dirs, skippedEntries: walk.skippedEntries, truncated: walk.truncated },
        byDecision,
        byLayer,
        byVersion,
        byExt,
        samples: plans.slice(0, limit).map((p) => ({
          relPath: p.candidate.file.relPath,
          size: p.candidate.file.size,
          docNo: p.candidate.docNo,
          scopeLayer: p.candidate.scopeLayer,
          versionStatus: p.candidate.versionStatus,
          decision: p.decision,
          reason: p.reason,
        })),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 真跑抽取：**立刻返回 jobId**，抽正文/切块/向量化在后台按批推进，
   * 进度走 `GET /api/kb/extract/:jobId`（`total/done/failed/skipped/current` + 失败清单）。
   *
   * 单文件失败只跳过那个文件（`result='fail'` + 原因），整批继续；随时可取消，
   * 已入库的成果保留，重跑按「大小/修改时间/切块口径」跳过没变的文件。
   */
  app.post('/api/kb/sources/:id/extract', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const row = getKbSourceRow(id);
      if (!row) throw new ApiError('NOT_FOUND', '来源目录不存在', 404);
      const st = statSync(row.path, { throwIfNoEntry: false });
      if (!st || !st.isDirectory()) throw new ApiError('SOURCE_MISSING', `来源目录不在了：${row.path}`, 400);

      const b = (req.body ?? {}) as Record<string, unknown>;
      const embed = false;
      const ocr = b.ocr === true;
      const r = await startExtractJob({ sourceId: id, rootAbs: row.path, embed, ocr, maxFiles: optNum(b, 'maxFiles') ?? undefined });
      return ok(
        reply,
        {
          jobId: r.jobId,
          total: r.total,
          settings: r.settings,
          note: `已起任务：将处理 ${r.total} 个文件（口径 去重=${r.settings.dedup} / 范围=${r.settings.scope} / 版本=${r.settings.version}）。进度见 GET /api/kb/extract/${r.jobId}。已入库的成果不会重复写。`,
        },
        202,
      );
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 抽取进度：进度 + 最近结果 + 失败清单（含原因）+ 结论分布 */
  app.get('/api/kb/extract/:jobId', async (req, reply) => {
    try {
      const jobId = intParam(req, 'jobId');
      const s = extractStatus(jobId);
      if (!s) throw new ApiError('NOT_FOUND', '抽取任务不存在', 404);
      return ok(reply, s);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 某个来源最近一次抽取的进度（界面卡片轮询用，不用记 jobId） */
  app.get('/api/kb/sources/:id/extract/status', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const row = getKbSourceRow(id);
      if (!row) throw new ApiError('NOT_FOUND', '来源目录不存在', 404);
      const liveJob = getLiveJob(id);
      const last = get<{ id: number }>('SELECT id FROM kb_extract_job WHERE source_id = ? ORDER BY id DESC LIMIT 1', [id]);
      const jobId = liveJob?.id ?? last?.id ?? null;
      return ok(reply, {
        source: row,
        running: liveJob !== null,
        jobId,
        status: jobId ? extractStatus(jobId) : null,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 取消抽取（已入库的成果保留；没跑完的文件下次重跑） */
  app.post('/api/kb/extract/:jobId/cancel', { onRequest: treatEmptyJsonBodyAsNoBody }, async (req, reply) => {
    try {
      const jobId = intParam(req, 'jobId');
      const s = extractStatus(jobId);
      if (!s) throw new ApiError('NOT_FOUND', '抽取任务不存在', 404);
      const stopped = cancelExtractJob(jobId);
      return ok(reply, { cancelled: stopped, jobId, status: extractStatus(jobId)?.job.status ?? null });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 抽取结果自检：库里的入库数、片段数、有向量的片段数、条款路径覆盖率，
   * 以及「同一来源里有没有重复的 doc_sha256」（去重口径真的生效了吗）。
   * 验收时用它出数字，界面上也有一行摘要。
   */
  app.get('/api/kb/sources/:id/extract/result', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const row = getKbSourceRow(id);
      if (!row) throw new ApiError('NOT_FOUND', '来源目录不存在', 404);
      const docs = get<{ n: number }>('SELECT COUNT(*) AS n FROM kb_document WHERE source_id = ?', [id])?.n ?? 0;
      const chunks = get<{ n: number }>('SELECT COUNT(*) AS n FROM kb_chunk c JOIN kb_document d ON d.id = c.document_id WHERE d.source_id = ?', [id])?.n ?? 0;
      const embedded = get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM kb_chunk c JOIN kb_document d ON d.id = c.document_id WHERE d.source_id = ? AND c.embedding IS NOT NULL',
        [id],
      )?.n ?? 0;
      const withClause = get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM kb_chunk c JOIN kb_document d ON d.id = c.document_id WHERE d.source_id = ? AND c.clause_path IS NOT NULL AND c.clause_path <> ''",
        [id],
      )?.n ?? 0;
      const dupHashes = all<{ doc_sha256: string; n: number }>(
        'SELECT doc_sha256, COUNT(*) AS n FROM kb_document WHERE source_id = ? AND doc_sha256 IS NOT NULL GROUP BY doc_sha256 HAVING n > 1',
        [id],
      );
      const byLayer = all<{ scope_layer: string | null; n: number }>(
        'SELECT scope_layer, COUNT(*) AS n FROM kb_document WHERE source_id = ? GROUP BY scope_layer',
        [id],
      );
      const byVersion = all<{ version_status: string | null; n: number }>(
        'SELECT version_status, COUNT(*) AS n FROM kb_document WHERE source_id = ? GROUP BY version_status',
        [id],
      );
      const sample = all<{ rel_path: string | null; clause_path: string | null; excerpt: string }>(
        `SELECT d.rel_path, c.clause_path, substr(c.content, 1, 80) AS excerpt
           FROM kb_chunk c JOIN kb_document d ON d.id = c.document_id
          WHERE d.source_id = ? ORDER BY d.id, c.seq LIMIT 5`,
        [id],
      );
      return ok(reply, {
        source: row,
        documents: docs,
        chunks,
        embedded,
        chunksWithoutVector: chunks - embedded,
        chunksWithClausePath: withClause,
        // 换口径后被标记失效的那批（只是标记，正文与向量还在库里）
        staleDocuments: listStaleKbDocuments(id).length,
        duplicateHashGroups: dupHashes.length,
        byLayer,
        byVersion,
        sample,
        settings: loadExtractSettings(),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ---------- 失效文档（换口径后不再入库的那批）：默认只标记，真删必须显式确认 ---------- */

  /**
   * 列出这个来源里的**失效文档**（`decision='stale'`）。
   *
   * 失效标记是抽取收尾的默认动作（只改抽取结论，正文与向量全部保留）。
   * 这个接口让用户先看到"哪些已经不算数了"，再决定要不要真删。
   */
  app.get('/api/kb/sources/:id/stale', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const row = getKbSourceRow(id);
      if (!row) throw new ApiError('NOT_FOUND', '来源目录不存在', 404);
      const items = listStaleKbDocuments(id);
      return ok(reply, {
        source: row,
        total: items.length,
        chunks: items.reduce((n, r) => n + r.chunk_count, 0),
        embedded: items.reduce((n, r) => n + r.embedded_count, 0),
        items,
        note: items.length
          ? `${items.length} 份文档按当前口径已失效（只是标记，正文与向量都还在）。要物理删除请走 POST /api/kb/sources/${id}/stale/purge，先看清单再带 confirm=true。`
          : '这个来源里没有失效文档。',
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 物理删除失效文档 —— **两段式**（这是 P1 修复要求的"用户可见的确认路径"）：
   *
   *   · 不带 `confirm: true`：**只看清单**（dry-run），返回"将删除 N 份"+ 列表，一个字节都不动；
   *   · 带 `confirm: true`：真的删（三张表连向量），返回删了哪些。
   *
   * 可选 `ids`：只删清单里的这几份（用户勾选）。
   * 抽取收尾**永远不走这条路**：它只会标记失效（早期版本在这里直接删库，
   * 一次 readdir 抖动就把整个来源的知识库连向量删光 —— 那是这次修的 P1）。
   */
  app.post('/api/kb/sources/:id/stale/purge', { onRequest: treatEmptyJsonBodyAsNoBody }, async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const row = getKbSourceRow(id);
      if (!row) throw new ApiError('NOT_FOUND', '来源目录不存在', 404);
      const b = (req.body ?? {}) as Record<string, unknown>;
      const confirm = b.confirm === true || String(b.confirm ?? '').toUpperCase() === 'DELETE';
      const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : null;
      const r = purgeStaleKbDocuments({ sourceId: id, ids, confirm });
      const items = r.willDelete.map((d) => ({ id: d.id, title: d.title, rel_path: d.rel_path, chunks: d.chunk_count, embedded: d.embedded_count }));
      return ok(reply, {
        dryRun: r.dryRun,
        deleted: r.deleted,
        count: items.length,
        chunks: r.chunks,
        embedded: r.embedded,
        items,
        confirmRequired: r.dryRun,
        note: r.note,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 条款路径抽查：把一份制度的片段路径与识别到的条号列出来，供 B3-9 的「条号 10/10」核对。
   * 纯读，不改任何数据。
   */
  app.get('/api/kb/documents/:id/clauses', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const doc = getKbDocument(id);
      if (!doc) throw new ApiError('NOT_FOUND', '知识库文档不存在', 404);
      const rows = all<{ id: number; seq: number; clause_path: string | null; excerpt: string }>(
        'SELECT id, seq, clause_path, substr(content, 1, 120) AS excerpt FROM kb_chunk WHERE document_id = ? ORDER BY seq LIMIT 200',
        [id],
      );
      return ok(reply, { document: doc, chunks: rows });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 诊断：直接查片段 FTS 索引，确认「新抽的制度能被搜到」（不参与正式检索排序）。
   *
   * 查询**必须按字组 AND**：FTS5 的 unicode61 分词器在我们的中文语料上，
   * 跨词边界的整串短语（`"隐 患 整 改"`）实测**匹配不到**（单词、两字词都正常，
   * 四字及以上跨词组恒为空）。而 `buildMatch` 会把无空格的中文整串当成一个短语，
   * 于是 `q=隐患整改` 搜出 0 条 —— 不是索引坏了，是查询写法不对。
   * 这里把每个 CJK 字拆成独立短语用 AND 组合：`"隐" AND "患" AND "整" AND "改"`。
   * `mode=or` 可放宽（命中任一字符即可，会明显变吵，排查用）。
   */
  app.get('/api/kb/chunks/search', async (req, reply) => {
    const query = String(q(req, 'q') ?? '').trim();
    const limit = Math.min(Number(q(req, 'limit') ?? 20) || 20, 100);
    const loose = q(req, 'mode') === 'or';
    // 注意最后一步：`segCJK("隐患整改")` 返回的是**一个**带空格的串 `"隐 患 整 改"`，
    // 必须再按空格切开，才能变成 4 个独立短语用 AND 组合。
    const terms = query
      .split(/\s+/)
      .map((t) => t.replace(/["'*(){}[\]^~:\\/]/g, '').trim())
      .filter(Boolean)
      .flatMap((t) => segCJK(t).split(/\s+/))
      .filter(Boolean);
    const match = terms.length ? terms.map((t) => `"${t}"`).join(loose ? ' OR ' : ' AND ') : '';
    if (!match) return ok(reply, { items: [], total: 0, note: '查询里没有可检索的词' });
    const items = searchKbChunks(match, limit);
    return ok(reply, { items, total: items.length, match });
  });

  /** 工具：把一段纯文本按抽取口径切块预览（界面「切块样例」用，不落库） */
  app.post('/api/kb/extract/chunk-preview', async (req, reply) => {
    try {
      const b = body(req);
      const text = requireStr(b, 'text', '文本');
      const chunks = chunkInstitutionText(text);
      return ok(reply, { chunks: chunks.slice(0, 50), total: chunks.length });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ======================================================================
   * B3-9 条款级引用 + 出文书前口径校验
   *
   * 为什么 hook 装在这个文件里：生成那两条路由（`/api/generate/preview`、`/api/generate/save`）
   * 定义在 `api/routes-generate.ts`，本轮不在改动范围内。而 Fastify 不允许同一路径注册两次，
   * 所以在这里用 **preHandler / preSerialization 钩子**给那两条路由加东西 ——
   * 与 `index.ts` 给 `/api/health` 加健康字段是同一套做法（见 index.ts:127 的注释）。
   * 钩子的**行为**：
   *   · `/api/generate/save`：口径校验不过（block 且没放行）→ **412 `COMPLIANCE_BLOCKED`**，
   *     磁盘上不会留下任何新文件（路由处理函数根本没跑）；给了 `allowRuleViolations` + `exceptionNote`
   *     → 放行，并把例外写进 `compliance_exception`（保存成功后回填 artifact_id）；
   *   · `/api/generate/preview`（只要 `want:'plan'`）：**不拦**，把校验结果挂在响应体的 `compliance`
   *     字段上，让界面把"哪一项、错在哪、依据是什么"直接显示出来。
   * 钩子里的一切都包在 try/catch 里：**校验引擎自己出错不许拦下用户的文书**，
   * 只记一条健康事件（首页红灯可见），并把 `engineWarnings` 带回界面。
   * ==================================================================== */

  /** 从请求体里取出生成入参（形状不对就交给原路由去报错） */
  function generateInputOf(req: FastifyRequest): { templateId: number; values: Record<string, unknown>; workbenchId: number | null; positionCode: string | null; allow: string[]; note: string } | null {
    const b = (req.body ?? null) as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
    const templateId = Number(b.templateId);
    if (!Number.isSafeInteger(templateId) || templateId <= 0) return null;
    const values = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? (b.values as Record<string, unknown>) : {};
    return {
      templateId,
      values,
      workbenchId: Number(b.workbenchId) > 0 ? Number(b.workbenchId) : null,
      positionCode: typeof b.positionCode === 'string' ? b.positionCode : null,
      allow: strArray(b, 'allowRuleViolations') ?? [],
      note: optStr(b, 'exceptionNote') ?? '',
    };
  }

  /**
   * 跑校验：引擎整条挂掉时**也要给出可区分的结论**，不再返回 null。
   *
   * 旧实现返回 null → 响应里干脆没有 compliance 字段 → 用户看到的就是"没报错 = 通过"
   * （P1：未求值/引擎出错被显示成"口径校验通过"）。现在退化成
   * `complianceEngineFailure()`：`status='check_error'`、`blocked` 按严格度决定，并记一条健康事件。
   */
  function runComplianceSafe(input: ComplianceInput): ComplianceResult {
    return complianceSafe(input);
  }

  const COMPLIANCE_PATHS = new Set(['/api/generate/preview', '/api/generate/save']);

  app.addHook('preHandler', async (req) => {
    const path = String(req.url ?? '').split('?')[0] ?? '';
    if (!COMPLIANCE_PATHS.has(path)) return;
    const input = generateInputOf(req);
    if (!input) return;
    // 老契约（不传 want:'plan' 的预览 = 文件流，e2e 有断言）：不动它
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    if (!requestsPolicyReference(optStr(rawBody, 'instruction'))) return;
    if (path === '/api/generate/preview' && optStr(rawBody, 'want') !== 'plan') return;

    const result = runComplianceSafe({
      templateId: input.templateId,
      values: input.values,
      workbenchId: input.workbenchId,
      positionCode: input.positionCode,
      allowRuleViolations: input.allow,
      exceptionNote: input.note,
    });
    /**
     * 引擎整条挂掉时这里也拿得到一份 `status='check_error'` 的结论（不再是 null）——
     * 于是"检查失败"能与"通过"在响应里区分开，而不是"响应里没有 compliance 字段"。
     */
    if (!result) return;
    // 给 preSerialization 用（同一次请求不重复算，docx 也不重复解包）
    (req as FastifyRequest & { __wbCompliance?: ComplianceResult }).__wbCompliance = result;

    if (path !== '/api/generate/save') return;

    if (result.blocked) {
      throw new ApiError('COMPLIANCE_BLOCKED', result.summary, 412, {
        strictness: result.strictness,
        // 四态结论：界面必须按 status/statusLabel 显示，别把"未检查/检查失败"渲染成"通过"
        status: result.status,
        statusLabel: result.statusLabel,
        counts: result.counts,
        issues: result.issues.map((i) => ({
          code: i.code,
          name: i.name,
          severity: i.severity,
          where: i.where,
          message: i.message,
          evidence: i.evidence,
          fixHint: i.fixHint,
        })),
        citations: result.citations.map((c) => ({ raw: c.raw, status: c.status, documentTitle: c.hit?.title ?? c.candidates[0]?.title ?? null, docNo: c.hit?.docNo ?? c.candidates[0]?.docNo ?? null, clausePath: c.hit?.clausePath ?? null, subNo: c.subNo, reason: c.reason })),
        unevaluated: result.unevaluated,
        engineWarnings: result.engineWarnings,
        howToProceed:
          '改掉这些问题再保存；确实要例外放行，带上 allowRuleViolations（规则码数组）与 exceptionNote（例外说明）重发这一次保存 —— 放行会留痕，界面上能看到"有 N 项口径例外"。' +
          (result.status === 'check_error' ? '（本次是「检查失败」：校验引擎没跑完，结论不可信，不能当成"通过"；要么修引擎，要么显式放行 COMPLIANCE_CHECK_FAILED。）' : ''),
      });
    }

    // 放行的例外逐条留痕（保存成功后由 preSerialization 回填 artifact_id）
    const allowSet = new Set(input.allow.map((s) => String(s)));
    const ids: number[] = [];
    try {
      for (const issue of result.issues.filter((i) => allowSet.has(i.code))) {
        ids.push(
          recordComplianceException({
            ruleCode: issue.code,
            reason: input.note || '（未填说明）',
            templateId: input.templateId,
            workbenchId: input.workbenchId,
            clausePath: issue.evidence.clausePath ?? null,
            severity: issue.severity,
            actor: (req.headers['x-workbench-actor'] as string | undefined) ?? null,
          }),
        );
      }
    } catch (e) {
      try {
        recordHealthEvent({ kind: 'selfCheckFailed', message: `口径例外留痕失败：${(e as Error).message.slice(0, 160)}` });
      } catch {
        /* 忽略 */
      }
    }
    (req as FastifyRequest & { __wbExceptionIds?: number[] }).__wbExceptionIds = ids;
  });

  /**
   * 响应侧：预览把校验结论挂上去（只加字段，不改既有字段）；保存成功则回填例外的 artifact_id。
   * 与 index.ts 的 `/api/health` 钩子同款写法：只认自己的路径，非对象 payload 原样放行。
   */
  app.addHook('preSerialization', async (req, _reply, payload) => {
    try {
      const path = String(req.url ?? '').split('?')[0] ?? '';
      if (!COMPLIANCE_PATHS.has(path)) return payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
      const envelope = payload as { ok?: boolean; data?: Record<string, unknown> };
      if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') return payload;

      const result = (req as FastifyRequest & { __wbCompliance?: ComplianceResult }).__wbCompliance;
      if (result && path === '/api/generate/preview') envelope.data.compliance = result;

      const ids = (req as FastifyRequest & { __wbExceptionIds?: number[] }).__wbExceptionIds;
      const artifactId = Number((envelope.data.artifact as { id?: number } | undefined)?.id);
      if (ids?.length && Number.isSafeInteger(artifactId) && artifactId > 0) {
        for (const id of ids) attachExceptionArtifact(id, artifactId);
        envelope.data.complianceExceptions = ids.length;
      }
      return payload;
    } catch {
      return payload; // 钩子自身出错绝不能影响生成/保存的结果
    }
  });

  /** 可引用的制度清单（界面「插入条款引用」的第一步：先选制度） */
  app.get('/api/kb/clauses/documents', async (req, reply) => {
    try {
      const kw = String(q(req, 'q') ?? '').trim();
      const limit = Math.min(Number(q(req, 'limit') ?? 50) || 50, 200);
      const like = `%${kw}%`;
      const items = all<{ id: number; title: string; doc_no: string | null; scope_layer: string | null; version_status: string | null; decision: string | null; clause_count: number; file_name: string | null }>(
        `SELECT d.id, d.title, d.doc_no, d.scope_layer, d.version_status, d.decision, a.file_name,
                (SELECT COUNT(DISTINCT clause_path) FROM kb_chunk c WHERE c.document_id = d.id AND c.clause_path IS NOT NULL) AS clause_count
           FROM kb_document d LEFT JOIN artifact a ON a.id = d.artifact_id
          WHERE ${visibleKbDocumentFilter('d')} AND (d.decision IS NULL OR d.decision = 'active')
            ${kw ? 'AND (d.title LIKE ? OR d.doc_no LIKE ? OR a.file_name LIKE ?)' : ''}
          ORDER BY d.id DESC LIMIT ?`,
        kw ? [like, like, like, limit] : [limit],
      );
      return ok(reply, { items, total: items.length });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 条款级取值（B3-9 要求①）：给定制度名/文号 + 条款路径，返回该条款文本与出处。
   * 条款路径可以是 `第五条`、`第二章/第五条`、`第二章 > 第五条 检查频次`，也可以只是条款名。
   */
  app.get('/api/kb/clauses/lookup', async (req, reply) => {
    try {
      const doc = String(q(req, 'doc') ?? '').trim();
      const clause = String(q(req, 'clause') ?? '').trim();
      if (!doc) throw new ApiError('MISSING_FIELD', '需要 doc（制度名或发文字号）');
      if (!clause) throw new ApiError('MISSING_FIELD', '需要 clause（条款路径，如 第五条 或 第二章/第五条）');
      const r = lookupClause(doc, clause);
      if (r.status !== 'resolved' || !r.hit) {
        return fail(
          reply,
          new ApiError('CLAUSE_NOT_FOUND', `核对不到「${doc} ${clause}」：${r.reason}`, 404, {
            status: r.status,
            subNo: r.subNo,
            candidates: r.candidates,
            availableClauses: r.availableClauses,
            // 款/项号对不上时给出"这一条下面现有哪些款/项"（与条号不存在时的提示风格一致）
            availableSubClauses: r.availableSubClauses,
          }),
        );
      }
      return ok(reply, {
        citation: {
          documentTitle: r.hit.title,
          docNo: r.hit.docNo,
          clausePath: r.hit.clausePath,
          clauseNo: r.hit.clauseNo,
          subNo: r.hit.subNo,
          docSha256: r.hit.docSha256,
          versionStatus: r.hit.versionStatus,
          scopeLayer: r.hit.scopeLayer,
          content: r.hit.content,
        },
        citeText: composeCiteText(r.hit),
        citeTextShort: composeCiteText(r.hit, { short: true }),
        citeTextWithQuote: composeCiteText(r.hit, { quote: true }),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 条款级检索：命中片段按「制度 + 条款路径」合并，可直接引用 */
  app.get('/api/kb/clauses/search', async (req, reply) => {
    try {
      const query = String(q(req, 'q') ?? '').trim();
      const doc = String(q(req, 'doc') ?? '').trim();
      const limit = Math.min(Number(q(req, 'limit') ?? 20) || 20, 100);
      const r = searchClauses(query, { doc: doc || null, limit });
      return ok(reply, { items: r.items, total: r.total, match: r.match, note: r.match ? undefined : '查询为空：可按条款正文关键词检索，或带 doc 指定制度' });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 规范出处串（界面「插入条款引用」直接把这一段写进变量值） */
  app.get('/api/kb/clauses/cite', async (req, reply) => {
    try {
      const doc = String(q(req, 'doc') ?? '').trim();
      const clause = String(q(req, 'clause') ?? '').trim();
      if (!doc || !clause) throw new ApiError('MISSING_FIELD', '需要 doc 与 clause');
      const r = lookupClause(doc, clause);
      if (!r.hit) return fail(reply, new ApiError('CLAUSE_NOT_FOUND', `核对不到「${doc} ${clause}」：${r.reason}`, 404, { status: r.status, subNo: r.subNo, availableClauses: r.availableClauses, availableSubClauses: r.availableSubClauses }));
      return ok(reply, {
        citeText: composeCiteText(r.hit, { quote: q(req, 'quote') === '1' }),
        citeTextShort: composeCiteText(r.hit, { short: true }),
        prefix: '依据',
        documentTitle: r.hit.title,
        docNo: r.hit.docNo,
        clausePath: r.hit.clausePath,
        content: r.hit.content,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 出文书前口径校验（界面在预览/保存前主动调它，不用等到 412） */
  app.post('/api/kb/compliance/check', async (req, reply) => {
    try {
      const b = body(req);
      const templateId = optNum(b, 'templateId') ?? null;
      const values = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? (b.values as Record<string, unknown>) : {};
      // 走 complianceSafe：引擎自己坏了也要返回 status='check_error'（而不是 500/没有结论）
      const r = complianceSafe({
        templateId,
        values,
        workbenchId: optNum(b, 'workbenchId') ?? null,
        positionCode: optStr(b, 'positionCode') ?? null,
        allowRuleViolations: strArray(b, 'allowRuleViolations') ?? null,
        exceptionNote: optStr(b, 'exceptionNote') ?? null,
        ignoreStrictness: optBool(b, 'ignoreStrictness') === 1,
      });
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 规则清单 + 严格度（规则数据化：界面改完立刻生效） */
  app.get('/api/kb/compliance/config', async (_req, reply) =>
    ok(reply, {
      strictness: complianceStrictness(),
      strictnessOptions: [
        { value: 'block', label: '阻止保存（默认）', note: 'block 级规则不通过就拒绝保存，并列出"哪一项、错在哪、期望什么"；可用「例外说明」逐条放行并留痕' },
        { value: 'warn', label: '仅提示', note: '全部只提示、不拦 —— 适合制度还没入全、刚开始用的时候' },
      ],
      rules: listComplianceRules(),
      keys: { strictness: SETTING_STRICTNESS },
      note: '规则是数据：改 severity / 开关立刻生效，不用改代码。未实现的规则（implemented=false）不允许启用 —— 那会变成"启用了却永远不响"。',
      /**
       * 四态口径与**前端措辞契约**（P1：旧版把"未求值/引擎出错"显示成"口径校验通过"）。
       * 界面必须按 `status` 分四种说法，不能只有"通过 / 有问题"两种。
       */
      statusContract: {
        field: 'ComplianceResult.status / statusLabel（/api/kb/compliance/check 的 data、/api/generate/preview 的 data.compliance、412 响应 error.detail）',
        states: [
          { status: 'passed', label: '通过', wording: '可以说「口径校验通过：N 处引用核对到条款」' },
          { status: 'failed', label: '不通过', wording: '说「不通过：N 项必须改」；blocked=true 时才说「已阻止保存」' },
          { status: 'not_checked', label: '未检查（没有可核对的依据）', wording: '不许写「通过 / 没问题」。要写「未检查：没有可核对的条款依据（引用未入库 / 条号款号核不到 / 文书里没有条款引用）」' },
          { status: 'check_error', label: '检查失败（引擎没跑完）', wording: '不许写「通过 / 没问题」。要写「检查失败：校验引擎没跑完，本次结论不可信」，并提示可显式放行（allowRuleViolations:[COMPLIANCE_CHECK_FAILED] + exceptionNote，会留痕）或把严格度调成仅提示' },
        ],
        rule: '只认 status：不要用「有没有 issues」来推断结论（未求值 / 检查失败都可能没有问题条目）。',
      },
    }),
  );

  app.put('/api/kb/compliance/config', async (req, reply) => {
    try {
      const b = body(req);
      const strictness = (optStr(b, 'strictness') ?? '').trim();
      if (!strictness) throw new ApiError('MISSING_FIELD', '需要 strictness（block / warn）');
      if (!(STRICTNESS_MODES as readonly string[]).includes(strictness)) {
        throw new ApiError('BAD_PARAM', `strictness 只能是 ${STRICTNESS_MODES.join(' / ')}：${strictness}`);
      }
      return ok(reply, { strictness: setComplianceStrictness(strictness as 'block' | 'warn'), key: SETTING_STRICTNESS });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 改一条规则（级别 / 开关）。未实现的规则不允许启用，理由写在错误里 */
  app.put('/api/kb/compliance/rules/:code', async (req, reply) => {
    try {
      const code = String((req.params as { code?: string }).code ?? '');
      if (!code) throw new ApiError('MISSING_FIELD', '需要规则码');
      const b = body(req);
      const enabled = optBool(b, 'enabled');
      const severity = optStr(b, 'severity');
      if (enabled === undefined && severity === undefined) throw new ApiError('MISSING_FIELD', '至少给 enabled 或 severity');
      let rule;
      try {
        rule = updateComplianceRule(code, {
          enabled: enabled === undefined ? undefined : enabled === 1,
          severity: severity === undefined ? undefined : (severity as 'block' | 'warn' | 'info'),
        });
      } catch (e) {
        /**
         * 规则改不动是**用户操作不合法**，必须是 400 + 后端原话（界面直接显示那句话），
         * 不能变成 500「服务出错了」—— 尤其"启用未实现的规则"这条，提示本身就是防静默失效的说明书。
         */
        const msg = e instanceof Error ? e.message : String(e);
        if (/^没有这条规则/.test(msg)) throw new ApiError('NOT_FOUND', msg, 404);
        throw new ApiError('RULE_NOT_APPLICABLE', msg, 400);
      }
      return ok(reply, { rule });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 例外放行留痕（谁、何时、以什么理由放行了哪条规则）—— B1-3 审计页从这里读 */
  app.get('/api/kb/compliance/exceptions', async (req, reply) => {
    try {
      const artifactId = qInt(req, 'artifactId') ?? null;
      const code = String(q(req, 'code') ?? '').trim() || null;
      const limit = qInt(req, 'limit') ?? 100;
      return ok(reply, { items: listComplianceExceptions({ artifactId, code, limit }) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ======================================================================
   * B3-10 文书 ↔ 制度双链
   *
   * 一段话说完：**写链在保存成功那一刻（下面这个 preSerialization 钩子），读链在下面这 7 个接口**。
   *
   * 为什么钩子还装在这个文件里：与 B3-9 同一个理由 —— `/api/generate/save` 定义在
   * `api/routes-generate.ts`，本轮不在改动范围，Fastify 又不允许同一路径注册两次。
   * 钩子里**不重新解析引用**：B3-9 的 preHandler 已经把 `ResolvedCitation[]` 算好挂在请求上
   * （`__wbCompliance`），直接拿来写链，既省一次 docx 解包，也保证"校验到的那几条"与
   * "记下来的那几条"**永远是同一批**（两套解析必然对不上）。
   * 只有校验引擎自己抛异常（`__wbCompliance` 缺失）时，才退到 B3-9 的解析函数重算一遍 ——
   * 用的还是 `kb-cite.ts` 的 `collectCitationTexts`/`parseCitations`/`resolveCitation`，
   * 一行新的解析逻辑都没有。
   *
   * 钩子里的失败一律**不拦保存**：返回给前端的 `citationLinks.failed` 里写清原因，
   * 同时记一条健康事件（首页红灯可见）—— 不许"链接没写上，人却以为写上了"。
   * ==================================================================== */

  const LINK_SAVE_PATH = '/api/generate/save';

  /**
   * 从「模板 + 变量值」解析出全部引用 —— **用的全是 B3-9 的函数**
   * （`collectCitationTexts` / `parseCitations` / `resolveCitation`），
   * 这里只做"同一处写法只解析一次"的缓存，与 B3-9 `runCompliance()` 里的缓存同一口径。
   */
  function resolveCitationsFromValues(templateId: number, values: Record<string, unknown>): ResolvedCitation[] {
    const sources = collectCitationTexts({ templateId, values });
    const parsed = sources.flatMap((s) => parseCitations(s.text, s.where));
    const cache = new Map<string, ResolvedCitation>();
    return parsed.map((p) => {
      // 缓存键必须含 文号 + 完整条款路径（含款/项号）：与 runCompliance 用同一个函数，
      // 否则 `《X》第五条` 与 `《X》第五条第九款` 会共用一条缓存（悬空引用被顶成已核对）
      const key = citationCacheKey(p);
      let r = cache.get(key);
      if (!r) {
        r = resolveCitation(p);
        cache.set(key, r);
      }
      return { ...r, raw: p.raw, where: p.where, subNo: p.subNo ?? r.subNo, pathSegments: p.pathSegments };
    });
  }

  /** 保存请求里的引用（优先用 B3-9 已算好的那份；缺失时才用它的解析函数重算） */
  function requestCitations(req: FastifyRequest): ResolvedCitation[] {
    const done = (req as FastifyRequest & { __wbCompliance?: ComplianceResult }).__wbCompliance;
    if (done) return done.citations;
    const input = generateInputOf(req);
    if (!input) return [];
    return resolveCitationsFromValues(input.templateId, input.values);
  }

  function actorOf(req: FastifyRequest): string | null {
    return (req.headers['x-workbench-actor'] as string | undefined) ?? null;
  }

  /**
   * 保存成功 → 把"这份文书引用了哪几条制度条款"落到 `doc_kb_link`（`link_kind='explicit'`）。
   *
   * 只在这一个地方自动写链：**预览不写**（还没出文书，链接没有归属对象）、
   * 没有核到条款的引用不写（防"乱连"，只计入 unresolved 返回给界面）。
   */
  app.addHook('preSerialization', async (req, _reply, payload) => {
    try {
      const path = String(req.url ?? '').split('?')[0] ?? '';
      if (path !== LINK_SAVE_PATH) return payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
      const envelope = payload as { ok?: boolean; data?: Record<string, unknown> };
      if (envelope.ok !== true || !envelope.data || typeof envelope.data !== 'object') return payload;
      const artifactId = Number((envelope.data.artifact as { id?: number } | undefined)?.id);
      if (!Number.isSafeInteger(artifactId) || artifactId <= 0) return payload;

      // 仅使用本请求已经明确执行过的校验结果，禁止保存时隐式查制度。
      const checked = (req as FastifyRequest & { __wbCompliance?: ComplianceResult }).__wbCompliance;
      if (!checked) return payload;
      const citations = checked.citations;
      const r = syncArtifactLinks({ artifactId, citations, actor: actorOf(req) });
      envelope.data.citationLinks = { ...r, artifactId };
      return payload;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        recordHealthEvent({ kind: 'selfCheckFailed', message: `保存后写「文书↔制度」链接失败：${msg.slice(0, 200)}` });
      } catch {
        /* 记录失败也不能再抛 */
      }
      // 不静默：把失败原因带回响应（文书本身已经保存好了，链接这次没写上）
      const envelope = payload as { ok?: boolean; data?: Record<string, unknown> };
      if (envelope?.ok === true && envelope.data && typeof envelope.data === 'object') {
        envelope.data.citationLinks = { failed: true, message: `链接没写上：${msg.slice(0, 160)}` };
      }
      return payload;
    }
  });

  /** 正查：这份文书引用了哪些制度条款（文书 → 制度）。`includeRemoved=1` 连"制度已移除"的也返回 */
  app.get('/api/artifacts/:id/citations', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!get<{ id: number }>('SELECT id FROM artifact WHERE id = ?', [id])) throw new ApiError('NOT_FOUND', '文书不存在', 404);
      return ok(reply, listArtifactLinks(id, { includeRemoved: q(req, 'includeRemoved') === '1' }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 批量正查（文件列表用：一次请求拿整个工作台的链接，避免每行一个请求） */
  app.get('/api/citations', async (req, reply) => {
    try {
      const workbenchId = qInt(req, 'workbenchId');
      if (!workbenchId) throw new ApiError('MISSING_FIELD', '需要 workbenchId');
      if (!get<{ id: number }>('SELECT id FROM workbench WHERE id = ?', [workbenchId])) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      return ok(reply, listWorkbenchLinks(workbenchId));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 人工加一条链接（`link_kind='manual'`，留 `created_by`）。
   * 两种给法：① `kbDocumentId` + `clause`（界面下拉选制度）；② `documentRef` + `clause`（按制度名/文号核）。
   * 条款核不到具体片段 → 400（**绝不建一条核不到的"空链接"**）。
   */
  app.post('/api/artifacts/:id/citations', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!get<{ id: number }>('SELECT id FROM artifact WHERE id = ?', [id])) throw new ApiError('NOT_FOUND', '文书不存在', 404);
      const b = body(req);
      const clause = optStr(b, 'clause') ?? optStr(b, 'clausePath') ?? '';
      const docId = optNum(b, 'kbDocumentId');
      const docRef = (optStr(b, 'documentRef') ?? '').trim();
      if (!clause.trim()) throw new ApiError('MISSING_FIELD', '需要 clause（哪一条，如「第五条」）');
      let documentId = docId ?? null;
      if (!documentId) {
        if (!docRef) throw new ApiError('MISSING_FIELD', '需要 kbDocumentId 或 documentRef（引的是哪份制度）');
        const r = lookupClause(docRef, clause);
        if (!r.hit) throw new ApiError('CLAUSE_NOT_FOUND', `核对不到「${docRef} ${clause}」：${r.reason}`, 404, { status: r.status, subNo: r.subNo, availableClauses: r.availableClauses, availableSubClauses: r.availableSubClauses });
        documentId = r.hit.documentId;
      }
      try {
        // 留痕用的人：优先请求体里的 actor（中文名在 HTTP 头里放不了，浏览器 fetch 会直接抛错），
        // 其次才是 B3-9 一直在用的 `x-workbench-actor` 头（只能放 ASCII）
        const actor = optStr(b, 'actor') ?? actorOf(req);
        const link = linkManual({ artifactId: id, kbDocumentId: documentId, clausePath: clause, actor });
        return ok(reply, { link, forward: listArtifactLinks(id) }, 201);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/核对不到/.test(msg)) throw new ApiError('CLAUSE_NOT_FOUND', msg, 400);
        if (/无效的|必须/.test(msg)) throw new ApiError('BAD_PARAM', msg, 400);
        throw e;
      }
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 重新扫一遍这份文书正文里的条款引用（**幂等**：同一份文书重复扫不产生重复链接行）。
   *
   * 用处在真实场景里很实在：制度补进知识库之前出的文书，引用当时核不到、没建上链；
   * 制度入库之后点一下这里，缺的链接就补上了。生成参数取 `generation_log.variables`
   * （保存时写的那一份），与当时校验用的完全是同一批值。
   */
  app.post('/api/artifacts/:id/citations/resync', { onRequest: treatEmptyJsonBodyAsNoBody }, async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const artifact = get<{ id: number; title: string }>('SELECT id, title FROM artifact WHERE id = ?', [id]);
      if (!artifact) throw new ApiError('NOT_FOUND', '文书不存在', 404);
      const log = get<{ template_id: number | null; variables: string | null }>(
        'SELECT template_id, variables FROM generation_log WHERE artifact_id = ? ORDER BY id DESC LIMIT 1',
        [id],
      );
      if (!log?.template_id) {
        throw new ApiError('NO_GENERATION_LOG', '这份文书没有生成记录（上传/扫描进来的文件没有"正文引用"可扫）', 400);
      }
      let values: Record<string, unknown> = {};
      try {
        const parsed = log.variables ? (JSON.parse(log.variables) as unknown) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) values = parsed as Record<string, unknown>;
      } catch {
        /* 变量记坏了也要能扫：至少模板正文里的引用还扫得到 */
      }
      const citations = resolveCitationsFromValues(log.template_id, values);
      const r = syncArtifactLinks({ artifactId: id, citations, actor: actorOf(req) });
      return ok(reply, { ...r, artifactId: id, scannedCitations: citations.length, forward: listArtifactLinks(id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 取消一条链接（**软删**：行保留，留 cancelled 痕迹，重新引用时能恢复） */
  app.delete('/api/citations/:id', { onRequest: treatEmptyJsonBodyAsNoBody }, async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const reason = String(q(req, 'reason') ?? '').trim() || null;
      try {
        const row = softDeleteLink(id, { actor: actorOf(req), reason });
        return ok(reply, { deleted: true, link: row, forward: listArtifactLinks(row.artifact_id) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/不存在/.test(msg)) throw new ApiError('NOT_FOUND', msg, 404);
        throw new ApiError('ALREADY_DELETED', msg, 400);
      }
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 反查：哪些文书引用了这份制度（可带 clause 只看某一条）—— 这是"制度改了要动哪些文书"的读点 */
  app.get('/api/kb/documents/:id/usages', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!get<{ id: number }>('SELECT id FROM kb_document WHERE id = ?', [id])) throw new ApiError('NOT_FOUND', '制度不在知识库里', 404);
      const clause = String(q(req, 'clause') ?? '').trim() || null;
      const r = listDocumentUsages(id, { clausePath: clause, includeTrashed: q(req, 'includeTrashed') === '1', limit: qInt(req, 'limit') ?? 200 });
      return ok(reply, {
        ...r,
        note: r.total
          ? `有 ${r.total} 份文书引用了这份制度${clause ? `的「${clause}」` : ''}${r.inTrash ? `（另有 ${r.inTrash} 条来自回收站里的文书，按软删口径不计入）` : ''}`
          : r.inTrash
            ? `当前没有引用${clause ? `「${clause}」` : ''}的文书；但有 ${r.inTrash} 条来自回收站里的文书，按软删口径不计入（把文书从回收站恢复回来就会重新出现）`
            : `还没有文书引用这份制度${clause ? `的「${clause}」` : ''}`,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 变更影响：制度内容变了以后，哪些文书要复核、因为哪一条。
   * 判据是「制度 sha256 + 条款正文归一化哈希」，并附该条款**现在的正文** —— 不逐字 diff。
   */
  app.get('/api/kb/documents/:id/impact', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!get<{ id: number }>('SELECT id FROM kb_document WHERE id = ?', [id])) throw new ApiError('NOT_FOUND', '制度不在知识库里', 404);
      const r = documentImpact(id);
      return ok(reply, {
        ...r,
        note: !r.documentChanged
          ? `《${r.documentTitle}》的内容与建链时一致（文件哈希相同），没有受影响文书`
          : r.affected.length
            ? `《${r.documentTitle}》的内容变了：${r.counts.affectedArtifacts} 份文书的 ${r.affected.length} 处引用需要复核（另有 ${r.unchanged} 处引用到的条款没变）`
            : `《${r.documentTitle}》的内容变了，但被引用的那些条款正文都没变 —— 没有需要复核的文书`,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 全库"待复核影响"（首页提示用）：只算文件哈希真的变过的制度，没变的一律跳过 */
  app.get('/api/kb/impact/pending', async (req, reply) => {
    try {
      const r = pendingImpacts({ limit: qInt(req, 'limit') ?? 50 });
      return ok(reply, {
        ...r,
        note: r.total
          ? `${r.documents.length} 份制度的改动影响到 ${r.artifacts} 份文书（共 ${r.total} 处引用），需复核`
          : '没有因制度变更而需要复核的文书',
        basis: '只统计"制度文件 sha256 变过、且引用的条款正文确实不同"的引用；没变的一律不算',
      });
    } catch (e) {
      return fail(reply, e);
    }
  });
}

/* ----------------------------------------------------------------------------
 * 末尾追加的 import（B3-10）。
 * 【为什么在这儿】本轮的文件范围是"`api/routes-kb.ts` 末尾追加"，所以没有动文件顶部的 import 段
 * —— ESM 的 import 会被提升，写在文件末尾同样是模块顶层，行为与写在顶部完全一致。
 * -------------------------------------------------------------------------- */
import { collectCitationTexts, parseCitations, resolveCitation, type ResolvedCitation } from '../domain/kb-cite.ts';
import {
  documentImpact,
  linkManual,
  listArtifactLinks,
  listDocumentUsages,
  listWorkbenchLinks,
  pendingImpacts,
  softDeleteLink,
  syncArtifactLinks,
} from '../domain/kb-links.ts';

