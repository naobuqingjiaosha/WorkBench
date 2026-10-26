/**
 * 文件与产出 Store —— 所有"落盘"动作的唯一出口
 *
 * 落盘同时做三件事：
 *   1. 写文件（数据目录里可读可同步的普通文件）
 *   2. 写 artifact 记录（数据库里的元数据：谁、什么时候、属于哪个工作台）
 *   3. 抽文本写 FTS 索引（能抽到就抽，抽不到不阻塞）
 */
import { syncEvidence,validateChecklist } from './checklist.ts';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { all, get, run, tx } from '../db/index.ts';
import { DATA_ROOT } from './config.ts';
import {
  assertDeletableFile, assertUsable, artifactFileAbs, ensureDir, getBoundRoots, isInsideRoot,
  parseRootId, relativeToRoot, resolveInAnyRoot, rootIdFor, rootKindOf, rootOf, SafetyRefusal, toPosix, uniqueFileName,
} from './paths.ts';
import { segCJK } from './search.ts';
import { extractAny, type ExtractResult } from './extract.ts';
import { detectFormat } from './template.ts';
import { ocrEnabled } from './ocr.ts';
import { enqueueOcr, processQueue } from './ocr-queue.ts';
import { assertNoOtherLiveArtifactRefers, liveFilter, visibleArtifactFilter, tableHasDeletedAt } from './trash.ts';

export type ArtifactKind = 'generated' | 'evidence' | 'source' | 'scan' | 'template' | 'other';

export interface Artifact {
  id: number;
  workbench_id: number | null;
  position_code: string | null;
  kind: ArtifactKind;
  title: string;
  file_rel: string;
  /**
   * `file_rel` 相对哪个根：'data' = DATA_ROOT（存量记录默认值），
   * 'external' = 该 artifact 所属工作台的 external_root。
   * 绝对路径不落库，下载/预览/OCR 都由 `artifactAbsPath` 按这个字段现算。
   *
   * 【新记录一定同时有 root_id】`root_kind` 只是老语义的兜底：有了 `root_id`
   * （登记时那个根的稳定身份，见 `core/paths.ts` 的 `rootIdFor`）之后，
   * **改绑资料目录不会再改变这条记录指向哪个目录**。`root_kind` 保留是为了存量记录
   * （迁移前后没跑到的行）仍能按老口径定位，不是为了新记录。
   */
  root_kind: 'data' | 'external';
  /** 登记时的根身份：'data' 或 'ext:<规范化路径>'；老记录为 NULL（可选列，见 ensureArtifactIdentitySchema） */
  root_id?: string | null;
  /**
   * 这份文件的来路（可选列）：
   *   platform 平台产物 —— 平台自己写进可写产物区的（上传/生成/影像），删它就是删平台自己的东西
   *   user     用户原件 —— 原地登记的（导入/纳管），平台只是"登记在册"
   * 回收站与排障界面据此区分"平台生成件 / 用户原件"，与根的用途（只读来源 / 可写产物区）
   * 一起构成完整的授权模型（见 core/paths.ts 的 RootPurpose / RootAction）。
   */
  origin?: string | null;
  file_name: string;
  file_ext: string | null;
  mime: string | null;
  size_bytes: number | null;
  sha256: string | null;
  template_id: number | null;
  checklist_item_id: number | null;
  version: number;
  doc_date: string | null;
  captured_at: string | null;
  exif: string | null;
  extracted_text: string | null;
  ocr_text: string | null;
  ocr_status: string | null;
  summary: string | null;
  tags: string | null;
  created_at: string;
  updated_at: string;
  /**
   * 版本链（迁移 017 / B1-4，见 `domain/versions.ts`）。**可选**：老库还没跑 017 时这几列不存在，
   * 所以一律 `Number(x ?? 默认值)` 读，别写 `a.revision + 1`。
   *   · version_group 同一条版本链的 id（NULL = 分链之前的旧生成件）
   *   · revision      链内第几版（默认 1）
   *   · supersedes_id 上一版 artifact.id
   *   · is_final      是否「最终版」（同一条链最多一个）
   *   · final_at      定稿时间
   * 顺带说明：001 起就有的 `version` 列以前没有任何写入路径，现在由
   * `attachVersion()` 与 `revision` 写同一个值（同一件事同一个值，不留两套口径）。
   */
  version_group?: string | null;
  revision?: number | null;
  supersedes_id?: number | null;
  is_final?: number | null;
  final_at?: string | null;
}

export const MIME_BY_EXT: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

export function mimeOf(file: string): string {
  return MIME_BY_EXT[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function isImage(file: string): boolean {
  return detectFormat(file) === 'image';
}

/* ------------------------- 来源身份 / 来路（可选列） ------------------------- */

/** 文件来路：平台产物 / 用户原件（原地登记） */
export type ArtifactOrigin = 'platform' | 'user';

/**
 * `artifact.root_id` / `artifact.origin` 这两列（本次授权改造新增）**按需补列**。
 *
 * 为什么不做成迁移文件、而在这里幂等补：本次改动不动 `db/migrations`（另一个改动
 * 正在动那块），而"老库缺列"必须是**降级**而不是 500 —— 与本项目既有的
 * `liveFilter` / `ensureDocVersionSchema` 一个口径：探测不到就补，补不上（只读库）
 * 就退回改造前的行为，绝不让接口挂掉。
 * 逐列 `pragma_table_info` 探测（SQLite 没有 ADD COLUMN IF NOT EXISTS），结果缓存。
 */
const IDENTITY_COLUMN_PLAN: { column: string; ddl: string }[] = [
  { column: 'root_id', ddl: 'ALTER TABLE artifact ADD COLUMN root_id TEXT' },
  { column: 'origin', ddl: 'ALTER TABLE artifact ADD COLUMN origin TEXT' },
];

let identitySchemaReady: boolean | null = null;

export function ensureArtifactIdentitySchema(): boolean {
  if (identitySchemaReady !== null) return identitySchemaReady;
  try {
    for (const p of IDENTITY_COLUMN_PLAN) {
      const has = Boolean(
        get<{ name: string }>("SELECT name FROM pragma_table_info('artifact') WHERE name = ?", [p.column]),
      );
      if (!has) run(p.ddl);
    }
    /**
     * 存量回填：`root_kind='data'` 的记录来源身份就是数据根，直接写死 'data'。
     * 外部的老记录**不猜**（猜错就等于改绑后指到别人的文件上）——它们保持 NULL，
     * 由读路径按"当前绑定"解释；真正需要钉住的是**改绑那一刻**（见 bindExternalRoot）。
     */
    run("UPDATE artifact SET root_id = 'data' WHERE root_id IS NULL AND COALESCE(root_kind,'data') <> 'external'");
    identitySchemaReady = true;
  } catch (e) {
    console.warn(`[文件] 来源身份列（root_id/origin）不可用，本次按改造前行为处理（不影响增删改查）：${(e as Error).message}`);
    identitySchemaReady = false;
  }
  return identitySchemaReady;
}

/** 测试/排障用：丢掉列探测缓存 */
export function resetArtifactIdentitySchema(): void {
  identitySchemaReady = null;
}

/**
 * 文件内容是不是真的图片。
 *
 * 只看扩展名是不够的：把任意文件改名成 `.png` 传上来，OCR 引擎读到一半会
 * 在 worker 线程里抛错 —— tesseract 用 `process.nextTick(() => { throw err })`
 * 往上抛，那是**抓不住的未捕获异常**，整个服务会直接退出。
 * 所以进 OCR 之前先验一下文件头，宁可当成「没有可识别文字」跳过。
 */
export function looksLikeImage(buf: Buffer, fileName: string): boolean {
  const ext = extname(fileName).toLowerCase();
  const head = (n: number) => buf.subarray(0, n).toString('latin1');
  switch (ext) {
    case '.png':
      return head(8) === '\x89PNG\r\n\x1a\n';
    case '.jpg':
    case '.jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case '.gif':
      return head(3) === 'GIF';
    case '.bmp':
      return head(2) === 'BM';
    case '.webp':
      return head(4) === 'RIFF' && head(12).slice(8) === 'WEBP';
    case '.tif':
    case '.tiff':
      return head(4) === 'II*\u0000' || head(4) === 'MM\u0000*';
    default:
      return false;
  }
}

/* ------------------------------ 写入 ------------------------------ */

/** 登记一个文件要写的业务字段（saveArtifact 与 registerExistingFile 共用，保证两条入口一致） */
export interface ArtifactFields {
  /** Internal synchronous commit hook: version, scope and evidence join the artifact transaction. */
  onCommit?: (artifact: Artifact) => void;
  workbenchId?: number | null;
  positionCode?: string | null;
  kind: ArtifactKind;
  title: string;
  templateId?: number | null;
  checklistItemId?: number | null;
  docDate?: string | null;
  capturedAt?: string | null;
  exif?: unknown;
  tags?: string[];
  summary?: string | null;
  /** 是否抽取文本建索引，默认按图片以外都抽 */
  index?: boolean;
}

export interface SaveArtifactInput extends ArtifactFields {
  /** 目标目录（绝对路径），会自动创建 */
  dirAbs: string;
  /** 期望文件名，含扩展名；重名自动加 _v2 */
  fileName: string;
  data?: Buffer | string;
  /** 已有文件路径：给 sourcePath 时直接把该文件复制/移动进来 */
  sourcePath?: string;
  move?: boolean;
  /** 相同 sha256 已存在时是否复用记录 */
  dedupe?: boolean;
}

/** 原地登记一个已经在允许根内的文件（dataRoot 或绑定的工作台目录），见 registerExistingFile */
export interface RegisterExistingInput extends ArtifactFields {
  /** 已在磁盘上的文件绝对路径，必须命中某个允许根（DATA_ROOT 或已绑定工作台的 external_root） */
  absPath: string;
  /** 真实文件名；缺省取 absPath 的最后一段 */
  fileName?: string;
}

export interface SaveArtifactResult {
  artifact: Artifact;
  absPath: string;
  duplicateOf?: number;
}

export async function saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> {
  validateChecklist(input.workbenchId,input.checklistItemId,input.kind);
  if(!['generated','evidence','source','scan','template','other'].includes(input.kind)) throw new Error('文件类型无效');

  // 目标目录必须是绝对路径，且命中某个允许根（DATA_ROOT 或已绑定工作台的外部根）。
  // 未绑定工作台的 dirAbs 都落在 DATA_ROOT 下，与改造前逐字节一致。
  const dirKind = rootKindOf(input.dirAbs);
  const dirAbs = rootOf(input.dirAbs)?.root;
  if (!dirAbs) throw new Error(`路径越界，拒绝访问：${input.dirAbs}`);
  /**
   * **平台产物只落在可写区**：命令落点允许根还不够，还得是"可写"的根 ——
   * 只读来源（iCloud 原件目录、显式声明的只读来源）在这里被挡住，
   * 而不是等 writeFileSync 报 EPERM（那时用户只看到"文件写入失败"）。
   */
  assertUsable(input.dirAbs, 'write', '目录');
  ensureDir(join(dirAbs, relativeToRoot(input.dirAbs)));

  let buf: Buffer;
  if (input.sourcePath) {
    buf = readFileSync(input.sourcePath);
  } else if (input.data !== undefined) {
    buf = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8');
  } else {
    throw new Error('saveArtifact 需要 data 或 sourcePath 之一');
  }

  if(input.kind==='evidence' && !looksLikeImage(buf,input.fileName)) throw new Error('影像证据必须是有效图片');
  const hash = sha256(buf);
  if (input.dedupe) {
    const dup = get<Artifact>(
      `SELECT * FROM artifact WHERE sha256 = ? AND workbench_id IS ? AND kind = ? AND ${liveFilter('artifact')} LIMIT 1`,
      [hash,input.workbenchId ?? null,input.kind],
    );
    if (dup) {
      return { artifact: dup, absPath: artifactAbsPath(dup), duplicateOf: dup.id };
    }
  }

  let finalName = uniqueFileName(input.dirAbs, input.fileName);
  let abs = fileAbsUnder(dirKind, input.dirAbs, finalName);
  for(;;) {try {writeFileSync(abs,buf,{flag:'wx'});break;} catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e;finalName=uniqueFileName(input.dirAbs,input.fileName);abs=fileAbsUnder(dirKind,input.dirAbs,finalName);}}
  const rel = relativeToRoot(abs);
  try {
    const artifact = await insertArtifactRecord({ abs, rel, rootKind: dirKind, fileName: finalName, buf, hash, origin: 'platform', fields: input });
    return { artifact, absPath: abs };
  } catch(e) {
    // 写库失败要把刚落的文件收回来。收不回来也不能让 unlinkSync 的异常
    // 盖掉真正的失败原因（比如清单校验、唯一约束），否则排查时只看得到 EPERM/EBUSY。
    try { if (existsSync(abs)) unlinkSync(abs); } catch { /* 保留真实错误 */ }
    throw e;
  }
}

/** 在指定根（'data' / 'external'）下的绝对路径，越界抛错 */
function fileAbsUnder(kind: 'data' | 'external', dir: string, name: string): string {
  const hit = rootOf(dir);
  if (!hit || hit.kind !== kind) throw new Error(`路径越界，拒绝访问：${dir}`);
  // 相对所属根拼一次再规范化，`..` 逃逸会被下面的 isInsideRoot 挡住
  const abs = join(hit.root, relativeToRoot(dir), name);
  if (!isInsideRoot(hit.root, abs)) throw new Error(`路径越界，拒绝访问：${abs}`);
  assertUsable(abs, 'write');
  return abs;
}

/**
 * 原地登记一个**已经在数据目录里**的文件：不复制、不改名、不生成 `_v2`。
 *
 * `_规范库` 里的文件是用户自己用资源管理器拷进去的，它本来就在数据目录里。
 * 走 saveArtifact 会先 `uniqueFileName` 再 `writeFileSync`，而 `uniqueFileName`
 * 一看到同名文件已存在就返回 `xxx_v2.ext` —— 于是"纳管"变成了"复制一份"：
 *   1. 用户的原文件永远没有 artifact 记录，应用里"删除"删掉的是副本；
 *   2. 每点一次「导入全部文件」就多一份 `_v2/_v3`，磁盘无上限增长；
 *   3. 副本的 sha256 是空串，按内容去重永久失效。
 * 这里直接用文件**自己**的相对路径登记，并把 sha256 真算一遍。
 *
 * 建记录那一步与 saveArtifact 共用 `insertArtifactRecord`，所以抽文字（extracted_text）、
 * 摘要索引（artifact_search / artifact_fts）、OCR 状态与正常上传的文件完全一致 ——
 * 不会再出现"文件进了库但检索不到"。
 */
export async function registerExistingFile(input: RegisterExistingInput): Promise<SaveArtifactResult> {
  validateChecklist(input.workbenchId, input.checklistItemId, input.kind);
  if(!['generated','evidence','source','scan','template','other'].includes(input.kind)) throw new Error('文件类型无效');

  // 允许根白名单：绑定的工作台目录里的文件也能原地登记（依旧不复制、不改名）
  const abs = resolveInAnyRoot(input.absPath);
  const rootKind = rootKindOf(abs);
  const fileName = input.fileName ? basename(input.fileName) : basename(abs);
  if (!existsSync(abs)) throw new Error(`文件不在磁盘上：${relativeToRoot(abs)}`);
  const buf = readFileSync(abs);
  if (input.kind === 'evidence' && !looksLikeImage(buf, fileName)) throw new Error('影像证据必须是有效图片');

  const rel = relativeToRoot(abs);
  const artifact = await insertArtifactRecord({ abs, rel, rootKind, fileName, buf, hash: sha256(buf), origin: 'user', fields: input });
  return { artifact, absPath: abs };
}

/**
 * 建记录这一步：抽文字 → 定 OCR 状态 → 写 artifact 记录 → 建全文索引 → 按需登记 OCR。
 *
 * `saveArtifact`（把文件复制/写进数据目录）与 `registerExistingFile`（原地登记已有文件）
 * 共用这一段，两条入口产出的记录因此不会各写各的：以前纳管走的是另一份手写实现，
 * 把 `extracted_text` 写死成 null、`sha256` 写成空串，文件进了库却永远检索不到。
 */
async function insertArtifactRecord(args: {
  abs: string;
  rel: string;
  rootKind: 'data' | 'external';
  fileName: string;
  buf: Buffer;
  hash: string;
  /** platform = 平台自己写出来的产物；user = 原地登记的用户原件 */
  origin: ArtifactOrigin;
  fields: ArtifactFields;
}): Promise<Artifact> {
  const { abs, rel, rootKind, fileName, buf, hash, origin, fields: input } = args;
  const stat = statSync(abs);

  const shouldIndex = input.index ?? !isImage(fileName);
  let extracted = '';
  let extractResult: ExtractResult | null = null;
  if (shouldIndex) {
    try { extractResult = await extractAny(abs); } catch { extractResult={text:'',format:'unknown',warnings:['抽取失败，原文件已保留']} as unknown as ExtractResult; }
    extracted = extractResult.text ?? '';
  }

  // OCR 状态：
  //   图片 → 待识别（文字抽不出来，只能靠 OCR）
  //   扫描件 PDF（文本流为空）→ 待识别
  //   其它 → 不需要
  const ocrWanted = ocrEnabled();
  const isPdf = extname(fileName).toLowerCase() === '.pdf';
  const badImage = isImage(fileName) && !looksLikeImage(buf, fileName);
  if (badImage) {
    console.warn(`[文件] ${fileName} 扩展名是图片但内容不是，已跳过 OCR（避免识别引擎崩掉整个服务）`);
  }
  const ocrStatus = !ocrWanted
    ? 'skipped'
    : isImage(fileName)
      ? badImage
        ? 'skipped'
        : 'pending'
      : isPdf && extracted.trim().length < 50
        ? 'pending'
        : 'skipped';

  const artifact = tx(() => {
    /**
     * 来源身份与来路列是本次改造新增的可选列：老库还没补上（只读库 / 补列失败）时
     * 退回改造前的 INSERT —— 少两列不影响"文件进库"，但绝不因此整条上传 500。
     */
    const withIdentity = ensureArtifactIdentitySchema();
    const rootId = withIdentity ? rootIdFor(abs) : null;
    const r = withIdentity
      ? run(
          `INSERT INTO artifact
            (workbench_id, position_code, kind, title, file_rel, root_kind, file_name, file_ext, mime, size_bytes, sha256,
             template_id, checklist_item_id, doc_date, captured_at, exif, extracted_text, ocr_status, summary, tags, root_id, origin)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.workbenchId ?? null,
            input.positionCode ?? null,
            input.kind,
            input.title,
            rel,
            rootKind,
            fileName,
            extname(fileName).toLowerCase(),
            mimeOf(fileName),
            stat.size,
            hash,
            input.templateId ?? null,
            input.checklistItemId ?? null,
            input.docDate ?? null,
            input.capturedAt ?? null,
            input.exif ? JSON.stringify(input.exif) : null,
            extracted || null,
            ocrStatus,
            input.summary ?? null,
            input.tags?.length ? JSON.stringify(input.tags) : null,
            rootId,
            origin,
          ],
        )
      : run(
          `INSERT INTO artifact
            (workbench_id, position_code, kind, title, file_rel, root_kind, file_name, file_ext, mime, size_bytes, sha256,
             template_id, checklist_item_id, doc_date, captured_at, exif, extracted_text, ocr_status, summary, tags)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.workbenchId ?? null,
            input.positionCode ?? null,
            input.kind,
            input.title,
            rel,
            rootKind,
            fileName,
            extname(fileName).toLowerCase(),
            mimeOf(fileName),
            stat.size,
            hash,
            input.templateId ?? null,
            input.checklistItemId ?? null,
            input.docDate ?? null,
            input.capturedAt ?? null,
            input.exif ? JSON.stringify(input.exif) : null,
            extracted || null,
            ocrStatus,
            input.summary ?? null,
            input.tags?.length ? JSON.stringify(input.tags) : null,
          ],
        );
    const id = r.lastInsertRowid;
    indexArtifact(id);
    input.onCommit?.(get<Artifact>('SELECT * FROM artifact WHERE id=?',[id])!);
    if(input.workbenchId)syncEvidence(input.workbenchId);
    return get<Artifact>(`SELECT * FROM artifact WHERE id = ? AND ${liveFilter('artifact')}`, [id]) as Artifact;
  });

  // 事务提交后再登记 OCR 任务（ocr_item 表有外键指向 artifact，必须等记录写完）
  if (ocrStatus === 'pending') {
    try {
      enqueueOcr(artifact.id);
      // 后台异步跑，不阻塞上传响应
      setTimeout(() => {
        void processQueue().catch(() => undefined);
      }, 50);
    } catch {
      /* OCR 登记失败不影响文件入库 */
    }
  }

  void extractResult;
  return artifact;
}

/** 更新索引表（触发器同步到 FTS） */
export function indexArtifact(id: number): void {
  const a = get<Artifact>(`SELECT * FROM artifact WHERE id = ? AND ${visibleArtifactFilter()}`, [id]);
  if (!a) {
    run('DELETE FROM artifact_search WHERE id = ?', [id]);
    return;
  }
  const body = [a.title, a.summary ?? '', a.extracted_text ?? '', a.ocr_text ?? '', a.tags ?? ''].join('\n');
  const name = [a.file_name, a.title].join(' ');
  run(
    `INSERT INTO artifact_search (id, wb_id, kind, seg_text, seg_name) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET wb_id = excluded.wb_id, kind = excluded.kind,
       seg_text = excluded.seg_text, seg_name = excluded.seg_name`,
    [a.id, a.workbench_id, a.kind, segCJK(body), segCJK(name)],
  );
}

export function reindexWorkbench(workbenchId: number): number {
  const rows = all<{ id: number }>(`SELECT id FROM artifact WHERE workbench_id = ? AND ${liveFilter('artifact')}`, [workbenchId]);
  rows.forEach((r) => indexArtifact(r.id));
  return rows.length;
}

/* ------------------------------ 读取 ------------------------------ */

export interface ListArtifactsQuery {
  workbenchId?: number | null;
  kind?: ArtifactKind | null;
  checklistItemId?: number | null;
  positionCode?: string | null;
  limit?: number;
  offset?: number;
}

export function listArtifacts(q: ListArtifactsQuery = {}): { total: number; items: Artifact[] } {
  // where 的第一项就是软删除过滤：只有 `deleted_at IS NULL` 的记录会进列表与总数
  const where: string[] = [visibleArtifactFilter()];
  const params: (string | number)[] = [];
  if (q.workbenchId !== undefined && q.workbenchId !== null) {
    where.push('workbench_id = ?');
    params.push(q.workbenchId);
  }
  if (q.kind) {
    where.push('kind = ?');
    params.push(q.kind);
  }
  if (q.checklistItemId) {
    where.push('checklist_item_id = ?');
    params.push(q.checklistItemId);
  }
  if (q.positionCode) {
    where.push('position_code = ?');
    params.push(q.positionCode);
  }
  const sql = where.join(' AND ');
  // 软删除过滤：where 的第一项就是 deleted_at IS NULL（见 listArtifacts 开头），下面两条读它
  const total = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM artifact
      WHERE ${sql}`,
    params,
  )?.n ?? 0;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  // 同上：列表与总数用同一段 where（含 deleted_at IS NULL），口径一致
  const items = all<Artifact>(
    `SELECT * FROM artifact
      WHERE ${sql}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, Math.max(q.offset ?? 0, 0)],
  );
  return { total, items };
}

/**
 * 按 id 取文件记录。**默认排除回收站里的**——删掉的文件不该再能下载、预览、写说明。
 * 需要连回收站一起看（恢复、彻底删除、排障）时传 `{ includeDeleted: true }`，
 * 或者直接用 `core/trash.ts` 的接口。
 */
export function getArtifact(id: number, opts: { includeDeleted?: boolean } = {}): Artifact | undefined {
  if (opts.includeDeleted || !tableHasDeletedAt('artifact')) {
    return get<Artifact>('SELECT * FROM artifact WHERE id = ?', [id]);
  }
  return get<Artifact>(`SELECT * FROM artifact WHERE id = ? AND ${visibleArtifactFilter()}`, [id]);
}

/**
 * 产出的绝对路径 —— 下载 / 预览 / OCR / 抽文字 / 影像张数**都走这里**。
 *
 * 定位链（**来源身份优先**，见 `core/paths.ts` 的 `artifactFileAbs`）：
 *   1. `root_id` 有值 → 按**登记时那个根**算：'data' → DATA_ROOT；'ext:<路径>' → 那个具体目录。
 *      改绑资料目录**不会**改变这条记录指向哪里 —— 否则同一个相对路径会突然被解释成
 *      新目录里的另一个文件（删除时就会误删用户放在新目录、平台从没登记过的原件）。
 *   2. `root_id` 为空的老记录 → 与改造前逐字一致：'data' 走 DATA_ROOT，
 *      'external' 走该 artifact **所属工作台当前的 external_root**。
 *
 * 定位完再过一次**读授权**：只读来源可以读（这正是它存在的意义），不在任何允许根内则拒绝。
 */
export function artifactAbsPath(a: Artifact): string {
  const legacyRoot = a.root_kind === 'external' && !parseRootId(a.root_id) ? externalRootOf(a) : null;
  const abs = artifactFileAbs({
    file_rel: a.file_rel,
    root_kind: a.root_kind,
    root_id: a.root_id,
    externalRoot: legacyRoot,
  });
  assertUsable(abs, 'read');
  return abs;
}

/**
 * 外部根工作台的绑定目录；查不到工作台或没绑定时抛明确错误（不是路径越界）。
 * 导出只为单测/排查用（`artifactAbsPath` 的定位链靠它）。
 */
export function externalRootOf(a: Artifact): string {
  if (!a.workbench_id) {
    throw new Error(`文件「${a.title}」登记在外部资料目录，但没有关联工作台，无法定位：${a.file_rel}`);
  }
  /**
   * 这里**故意不加** `deleted_at IS NULL`：这不是"给用户看的列表"，而是给一条已有记录
   * 定位它在磁盘上的根。工作台进了回收站（deleted_at IS NOT NULL），它的文件记录同样在回收站里，
   * 恢复时要能原样指回那个目录；加了过滤反而会让"恢复后仍无法定位"。
   * 用户能看到的列表/详情早就把它们排除了（见 NOT_DELETED）。
   */
  const wb = get<{ external_root: string | null }>('SELECT external_root FROM workbench WHERE id = ?', [a.workbench_id]);
  if (!wb) throw new Error(`文件「${a.title}」关联的工作台（id=${a.workbench_id}）已不存在：${a.file_rel}`);
  const root = wb.external_root?.trim();
  if (!root) throw new Error(`工作台（id=${a.workbench_id}）已解绑资料目录，文件「${a.title}」暂时无法定位：${a.file_rel}`);
  return root;
}

export function artifactExists(a: Artifact): boolean {
  return existsSync(artifactAbsPath(a));
}

/**
 * 把一份文件**移到回收站**（软删除）。
 *
 * 以前这里是硬删除（`DELETE FROM artifact`），删错了没有任何退路。现在只写 `deleted_at`：
 *   · 记录留着 → 回收站里看得见、能恢复；
 *   · 所有读路径（列表/详情/搜索/统计/清单/助手/导出）默认都排除它（见 core/trash.ts 的 NOT_DELETED）。
 *
 * `withFile` 的参数名保持兼容，语义按本次改造收敛成「**彻底删除时要不要连磁盘文件一起删**」：
 *   · `withFile: true`  → 顺手把磁盘文件删掉。安全阀与 `core/trash.ts` 的彻底删除**完全同一套**
 *     （共用 `core/paths.ts` 的 `assertDeletableFile`）：
 *       ① 必须命中允许根 —— 不在白名单里的绝对路径一律不碰（这次修复补上的：以前这里
 *          只算了绝对路径就直接 `unlinkSync`，绕过 `trash.ts` 那套允许根复核）；
 *       ② **只读来源里的文件绝不删**（iCloud 原件 / 显式声明的只读来源）；
 *       ③ 绑定根/工作台根本身绝不删；
 *       ④ 有登记指纹时，磁盘内容（大小 + sha256）必须与登记时一致；
 *       ⑤ 还被别的**存活** artifact 记录指着的文件不删（回收站里的旧工作台不占位时，
 *          它就是新工作台正在用的那一份 —— 详见 core/trash.ts 的 `assertNoOtherLiveArtifactRefers`）。
 *     ①②③④⑤ 任一条不过时**不删磁盘**，但记录照常移动（不把"删不掉"变成"删不了记录"），
 *     跳过原因随返回值给调用方，在响应里说清楚是哪一份、为什么没删。
 *   · `withFile: false` → 磁盘一个字节都不动，文件仍在原处（回收站里恢复记录后照样能下载）。
 *
 * **真删**走 `core/trash.ts` 的 `purgeFromTrash()` / `emptyTrash()`。
 */
export function deleteArtifact(id: number, opts: { withFile?: boolean } = {}): {
  /** 磁盘文件是不是真的被删掉了 */
  fileRemoved: boolean;
  /** 被安全阀跳过时的原因（没有跳过就是 null） */
  fileSkipped: string | null;
} {
  const a = getArtifact(id, { includeDeleted: true });
  if (!a) return { fileRemoved: false, fileSkipped: null };

  /**
   * 删文件会连坐知识库：`kb_document.artifact_id` 是 ON DELETE CASCADE，
   * 删掉这份文件，它的知识库文档和全部片段（含向量）会**静默消失**。
   * 静默是最糟的部分 —— 用户以为只是删了个文件，语义检索那边却少了一篇。
   * 所以这里先把要连坐的文档找出来、明确告诉调用方，并且让向量缓存立刻失效，
   * 否则接下来 30 秒的检索还会拿已经删掉的片段算相似度。
   *
   * 软删除这一轮**不动** kb_document：记录还在、还能恢复，等彻底删除时才真级联。
   */
  const linkedDocs = all<{ id: number; title: string }>(
    'SELECT id, title FROM kb_document WHERE artifact_id = ?',
    [id],
  );

  let fileRemoved = false;
  let fileSkipped: string | null = null;
  if (opts.withFile) {
    try {
      const abs = artifactAbsPath(a);
      if (existsSync(abs)) {
        /**
         * 授权与内容核对：与 trash.ts 的 `removeArtifactFile` 同一套判据。
         * 跳过（只读来源 / 指纹不符 / 被别的存活记录引用 / 绑定根本身）不是错误 ——
         * 记录该进回收站还是进，只是磁盘那一份不动。
         */
        assertDeletableFile(abs, a, '文件');
        assertNoOtherLiveArtifactRefers(a);
        unlinkSync(abs);
        fileRemoved = true;
        pruneEmptyDirs(a, abs);
      }
    } catch (e) {
      /**
       * 分两类：
       *   · **安全阀拒绝**（`SafetyRefusal`）→ 跳过磁盘那一份、继续软删除，原因回报给调用方；
       *   · 其它（被占用 EPERM/EBUSY、定位不到…）→ 保持原样抛错，让调用方知道"这次没删成"。
       */
      if (e instanceof SafetyRefusal) fileSkipped = e.message;
      else throw new Error(`文件删除失败，记录未变动：${(e as Error).message}`);
    }
  }
  // 软删除：索引行也一起摘掉，否则检索会命中一条"已删除"的文件（详情页打开就是 404）
  tx(() => {
    run('DELETE FROM artifact_search WHERE id = ?', [id]);
    run("UPDATE artifact SET deleted_at = COALESCE(deleted_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ?", [id]);
    /**
     * OCR 队列里的这一条也要收尾：待识别的任务留着不动，它会一直占着队列
     * （`queueState` 的 pending 计数永不归零，界面上的"排队中"下不去）。
     * 标成 skipped + 一句原因，与 `cancelPending()` 的收尾口径一致。
     */
    run(
      "UPDATE ocr_item SET status = 'skipped', ocr_error = '文件已移入回收站，不再识别' WHERE artifact_id = ? AND status IN ('pending','running')",
      [id],
    );
    /**
     * 影像初检结论（`evidence_review`）**跟着删掉**，不能留。
     *
     * 它原来是靠 `ON DELETE CASCADE` 随记录一起消失的，软删除不再触发级联 —— 于是
     * 「删了照片，`GET /api/evidence/reviews` 还能看到它的初检结论」。那是**派生的中间结果**
     * （重跑一次初检就有），不是用户的原始资料，留着只会让人以为这张照片还在库里；
     * 反过来，把它们一起清掉不影响"恢复照片"这件事 —— 恢复后重新初检即可。
     * 唯一要如实说清的地方：恢复照片不会连初检结论一起回来（`restoreFromTrash` 的 warnings
     * 里会提到"只有记录"）。`kb_document` 的处理见下面：那是知识库文档，不能悄悄丢。
     */
    run('DELETE FROM evidence_review WHERE artifact_id = ?', [id]);
  });
  if(a.workbench_id) syncEvidence(a.workbench_id);
  if (linkedDocs.length) {
    /**
     * 知识库文档（`kb_document` + `kb_chunk`）也是靠级联删的，软删除不再触发它。
     * 但这次**主动清掉**，理由与 `evidence_review` 不同、必须写清楚：
     *   · 知识库是**全局检索**（不分工作台），一条指向已删除文件的文档会一直被语义检索命中，
     *     点进去却打不开文件 —— 比"少一篇"更糟；
     *   · `listKbDocuments()` 用的是 `LEFT JOIN artifact`，本来也过滤不了已删除的，
     *     想靠读路径挡住就得改 `api/routes-kb.ts`（不在本次范围内）。
     * 所以这里显式删掉它，并让向量缓存立刻失效；恢复文件后可以重新「导入知识库」。
     */
    for (const d of linkedDocs) {
      run('DELETE FROM kb_document WHERE id = ?', [d.id]);
    }
    invalidateKbCache();
    console.warn(
      `[文件] 「${a.title}」移入回收站，它关联的 ${linkedDocs.length} 篇知识库文档已一并移除：${linkedDocs.map((d) => d.title).join('、')}`,
    );
  }
  /**
   * 被安全阀跳过磁盘那一份时留一行日志：回收站里那条记录的说明仍然是"磁盘文件还在"，
   * 与 `listTrash` 的 `artifactFileExists()` 判断口径一致 —— 不要在这里假装删掉了。
   */
  if (fileSkipped) console.warn(`[文件] 「${a.title}」已移入回收站，但磁盘那一份按规则未删除：${fileSkipped}`);
  return { fileRemoved, fileSkipped };
}

/** 删文件时让知识库的向量缓存失效（core/kb.ts 的内存矩阵） */
function invalidateKbCache(): void {
  try {
    // 动态引入避免 store ↔ kb 的循环依赖
    void import('./kb.ts').then((m) => m.invalidateCache());
  } catch {
    /* 缓存失效失败不影响删除 */
  }
}

/**
 * 删掉文件后顺手收走空目录。
 *
 * 上传时按用户的分类建了 `_规范库/公司制度/廉政/` 这样的目录，删文件后目录会留下，
 * 资源管理器里看着像还有东西。这里从文件所在目录往上收，直到遇到非空目录或**所属工作台的根**为止。
 *
 * 停止条件是安全阀（docs/10-目录绑定方案.md §7.3）：绑定型工作台的根是**用户自己的文件夹**，
 * 往上收会删掉用户建的目录。所以最多删到绑定根之下的空目录，绝不删绑定根本身，
 * 也不能越过它继续往上（旧实现一路收到 DATA_ROOT，绑外之后会波及用户的整个资料目录）。
 */
function pruneEmptyDirs(a: Artifact, fileAbs: string): void {
  const stop = stopDirOf(a);
  if (!stop) return; // 定位不到所属根：不收目录（宁可留空目录，也不能越过用户的资料目录往上删）
  let dir = dirname(fileAbs);
  while (dir !== stop && isInsideRoot(stop, dir)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/**
 * 空目录回收的停点：data 产出停在 DATA_ROOT，外部产出停在该 artifact **自己的根**
 * （优先按来源身份；老记录才回退到工作台当前的绑定根）。
 * 工作台被删 / 已解绑且又定位不到时返回 null（调用方据此拒绝收目录）。
 * 导出只为单测/排查用（安全阀 §7.3 的验收点）。
 */
export function stopDirOf(a: Artifact): string | null {
  const byId = parseRootId(a.root_id);
  if (byId?.kind === 'data') return DATA_ROOT;
  if (byId?.kind === 'external') return byId.root;
  if (a.root_kind !== 'external') return DATA_ROOT;
  try {
    return externalRootOf(a);
  } catch {
    return null;
  }
}

/**
 * 按「登记的 `file_rel` + 登记的绝对路径」定位一个已登记的文件。
 *
 * 只给相对路径时**不能**去白名单里挑一个存在的同名文件：`_影像证据/x/shot.png`
 * 在 DATA_ROOT 和某个绑定根下可能同时存在，随便挑一个就会把别的工作台的文件发出去。
 * 所以这里要求调用方给出「这条记录自己认的那个绝对路径」，由它决定往哪个根上找：
 * 找到就返回该路径；绑定的目录没了 / 文件被移走，就在允许根里找同 rel 的那一份（同步盘换盘符的情况）；
 * 都没有则返回 null（调用方按「文件已不存在」处理）。
 */
export function resolveRegisteredFile(rel: string, preferredAbs?: string | null): string | null {
  const posix = toPosix(rel ?? '');
  if (preferredAbs && rootOf(preferredAbs) && existsSync(preferredAbs)) return preferredAbs;
  for (const root of getBoundRoots()) {
    const candidate = join(root, posix);
    if (isInsideRoot(root, candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

export function updateArtifact(id: number, patch: Partial<Pick<Artifact, 'title' | 'summary' | 'tags' | 'ocr_text' | 'ocr_status' | 'captured_at' | 'exif' | 'doc_date' | 'checklist_item_id' | 'position_code'>>): void {
  const old=getArtifact(id); if(!old) throw new Error('文件不存在');
  validateChecklist(old.workbench_id,patch.checklist_item_id === undefined ? old.checklist_item_id : patch.checklist_item_id,old.kind);
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    params.push(v as string | number | null);
  }
  if (!fields.length) return;
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  run(`UPDATE artifact SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
  if(old.workbench_id) syncEvidence(old.workbench_id);
  indexArtifact(id);
}

/**
 * 文件可用正文：原生文字层（extracted_text）与 OCR 文字（ocr_text）里**较长的那个**。
 *
 * 不能写成 `extracted_text || ocr_text` —— 扫描 PDF 常带一层极短的文字（页码、水印，
 * 几十个字），于是取到的是那几十字，而 OCR 出来的几千字被丢掉，知识库几乎是空的、
 * 检索也搜不到。宁可多比一次长度。
 */
export function artifactBodyText(a: Pick<Artifact, 'extracted_text' | 'ocr_text'>): string {
  const extracted = (a.extracted_text ?? '').trim();
  const ocr = (a.ocr_text ?? '').trim();
  return ocr.length > extracted.length ? ocr : extracted;
}

/** 供大模型当参考资料的文本，限制长度防止超上下文 */
export function artifactReferenceText(id: number, maxChars = 6000): string {
  const a = getArtifact(id);
  if (!a) return '';
  const text = artifactBodyText(a);
  const body = text || `（文件「${a.title}」未能抽取到文本，可能是扫描件，需要 OCR）`;
  return `【参考资料：${a.title}｜${a.file_name}】\n${body.slice(0, maxChars)}`;
}

export function artifactStat(a: Artifact): { exists: boolean; size: number } {
  try {
    const abs = artifactAbsPath(a);
    const st = statSync(abs);
    return { exists: true, size: st.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

export { toPosix, basename };
