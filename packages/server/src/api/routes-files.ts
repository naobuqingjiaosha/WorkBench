import {requireInspection,assertInspectionRevision} from '../domain/inspections.ts';
import { validateChecklist } from '../core/checklist.ts';
/** 文件库接口：上传、影像证据、浏览、下载、删除、全文检索 */
import { createReadStream, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { all, get, run } from '../db/index.ts';
import { DATA_ROOT, DIRS, getSetting } from '../core/config.ts';
import { evidenceFileName, isPlatformProtected, safeName, sourceFileName, toPosix, workbenchRootAbs } from '../core/paths.ts';
import { artifactAbsPath, deleteArtifact, getArtifact, listArtifacts, registerExistingFile, saveArtifact, updateArtifact, type Artifact, type ArtifactKind } from '../core/store.ts';
import { isIgnoredName, isIgnoredRelPath } from '../core/ignore.ts';
import { searchArtifacts } from '../core/search.ts';
import { cancelPending, enqueueMissing, ocrSummary, processQueue, queueState, artifactOcrState, requeueOcr } from '../core/ocr-queue.ts';
import { ensureLang, isOcrCandidate, listLangStatus, ocrLangs, tessdataInfo } from '../core/ocr.ts';
import { getTemplate, getWorkbenchLive, getWorkbench, listBoundRootGrants, reloadBoundRoots, updateChecklistItem, workbenchOutputDirAbs } from '../domain/service.ts';
import { diffVersions, listVersionChain, markFinal, rollbackToRevision } from '../domain/versions.ts';
import { emptyTrash, isTrashKind, listTrash, liveFilter, purgeFromTrash, restoreFromTrash, TRASH_KINDS, trashCount } from '../core/trash.ts';
import { ApiError, body, fail, intParam, ok, optNum, optStr, q, qBool, qInt, strArray } from './reply.ts';
import { cleanupTemp, readParts } from './upload.ts';
import { requirePeriod,event } from '../domain/periods.ts';

async function readExif(abs: string): Promise<{ capturedAt: string | null; exif: Record<string, unknown> | null }> {
  try {
    const exifr = (await import('exifr')).default;
    const data = (await exifr.parse(abs, { pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'GPSLatitude', 'GPSLongitude', 'ExifImageWidth', 'ExifImageHeight', 'Orientation'] })) as Record<string, unknown> | undefined;
    if (!data) return { capturedAt: null, exif: null };
    const dt = (data.DateTimeOriginal ?? data.CreateDate) as Date | undefined;
    const capturedAt = dt instanceof Date && !Number.isNaN(dt.getTime()) ? dt.toISOString() : null;
    const exif: Record<string, unknown> = {};
    if (data.Make) exif.设备品牌 = String(data.Make);
    if (data.Model) exif.设备型号 = String(data.Model);
    if (data.GPSLatitude !== undefined && data.GPSLongitude !== undefined) {
      exif.GPS = `${Number(data.GPSLatitude).toFixed(6)}, ${Number(data.GPSLongitude).toFixed(6)}`;
    }
    if (data.ExifImageWidth) exif.宽度 = data.ExifImageWidth;
    if (data.ExifImageHeight) exif.高度 = data.ExifImageHeight;
    return { capturedAt, exif: Object.keys(exif).length ? exif : null };
  } catch {
    return { capturedAt: null, exif: null };
  }
}

export function registerFileRoutes(app: FastifyInstance): void {
  app.get('/api/artifacts/:id/generation-values', async(req,reply)=>{try{
   const a=getArtifact(intParam(req,'id'));if(!a)throw new ApiError('NOT_FOUND','成果不存在',404);
   const row=get<{variables:string}>("SELECT variables FROM generation_log WHERE artifact_id=? AND status='ok' ORDER BY id DESC LIMIT 1",[a.id]);
   if(!row)throw new ApiError('NO_VALUES','此文件不是模板生成成果，请使用外部文件预览或导入入口');
   return ok(reply,{values:JSON.parse(row.variables)});
  }catch(e){return fail(reply,e);}});

  /** 文件列表 */
  app.get('/api/artifacts', async (req, reply) => {
    try {
      const r = listArtifacts({
        periodId: qInt(req,'periodId'),
        workbenchId: qInt(req, 'workbenchId') ?? null,
        kind: (q(req, 'kind') as ArtifactKind) ?? null,
        checklistItemId: qInt(req, 'checklistItemId') ?? null,
        positionCode: q(req, 'positionCode') ?? null,
        limit: qInt(req, 'limit'),
        offset: qInt(req, 'offset'),
      });
      return ok(reply, {
        ...r,
        items: r.items.map((a) => ({ ...a, url: `/api/artifacts/${a.id}/file`, thumb: a.file_ext && /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.file_ext) ? `/api/artifacts/${a.id}/file` : null })),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/artifacts/:id', async (req, reply) => {
    try {
      const a = getArtifact(intParam(req, 'id'));
      if (!a) throw new ApiError('NOT_FOUND', '文件不存在', 404);
      // 外部根的文件要靠所属工作台定位：工作台被删/已解绑时会抛明确错误。
      // 详情页不该因此 500 —— 定位不到就是 exists:false（解绑后文件还在，只是暂时没根）。
      let absPath = '';
      let located = true;
      try { absPath = artifactAbsPath(a); } catch { located = false; }
      return ok(reply, {
        artifact: a,
        abs_path: absPath,
        exists: located && existsSync(absPath),
        ocr: artifactOcrState(a),
        can_ocr: isOcrCandidate(a.file_name),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 下载/预览文件本体 */
  app.get('/api/artifacts/:id/file', async (req, reply) => {
    try {
      const a = getArtifact(intParam(req, 'id'));
      if (!a) throw new ApiError('NOT_FOUND', '文件不存在', 404);
      const abs = artifactAbsPath(a);
      if (!existsSync(abs)) throw new ApiError('FILE_MISSING', `文件已不在磁盘上：${a.file_rel}`, 410);
      reply.type(a.mime ?? 'application/octet-stream').header('Content-Security-Policy',"sandbox; default-src 'none'");
      return reply.send(createReadStream(abs));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 通用上传：原始资料 / 扫描件 / 补充文件 */
  app.post('/api/artifacts/upload', async (req, reply) => {
    const saved: unknown[] = [];
    let uploadFiles: {tempPath:string}[]=[];
    try {
      const { fields, files } = await readParts(req); uploadFiles=files;
      if (!files.length) throw new ApiError('NO_FILE', '没有收到文件');
      const workbenchId = fields.workbenchId ? Number(fields.workbenchId) : null;
      const templateId=fields.templateId?Number(fields.templateId):null;
      const kind:ArtifactKind = templateId?'generated':(fields.kind as ArtifactKind) || 'source';
      const fileRole=fields.fileRole||'source';
      if(!['source','external'].includes(fileRole))throw new ApiError('BAD_ROLE','资料用途无效');
      const note = fields.note || '';
      const checklistItemId=fields.checklistItemId?Number(fields.checklistItemId):null;
      validateChecklist(workbenchId,checklistItemId,kind);
      if(checklistItemId){
        if(fields.periodId)throw new ApiError('BAD_SCOPE','阶段材料不能同时归属独立期次');
        const pos=get<{code:string}>('SELECT p.code FROM checklist_item c JOIN position_instance p ON p.id=c.position_instance_id WHERE c.id=?',[checklistItemId]);
        if(fields.positionCode && fields.positionCode!==pos?.code)throw new ApiError('BAD_STAGE','阶段与清单归属不一致');
        fields.positionCode=pos!.code;
      }
      const wb = workbenchId ? getWorkbenchLive(workbenchId) : undefined;
      if (workbenchId && !wb) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      if(templateId){
        const t=getTemplate(templateId);
        if(!wb||!t||t.work_type_id!==wb.work_type_id)throw new ApiError('BAD_TEMPLATE','导入成果的模板必须属于当前工作类型');
        if(files.some(f=>f.ext.toLowerCase()!=='.'+t.file_format))throw new ApiError('BAD_FORMAT','导入成果格式必须与所选模板一致');
        if(fields.positionCode&&!get('SELECT id FROM position_instance WHERE workbench_id=? AND code=? AND deleted_at IS NULL',[wb.id,fields.positionCode]))throw new ApiError('BAD_STAGE','阶段不存在');
        if(fields.final==='true'&&fields.reviewed!=='true')throw new ApiError('REVIEW_REQUIRED','导入定稿前需要确认已人工核对原文');
      }
      const periodId=fields.periodId?Number(fields.periodId):null;
      if(periodId&&!workbenchId)throw new ApiError('WORK_REQUIRED','期次上传必须指定工作');
      const period=periodId?requirePeriod(periodId,workbenchId):null;
      const inspectionId=fields.inspectionId?Number(fields.inspectionId):null;
      if(inspectionId&&!templateId)throw new ApiError('BAD_INSPECTION','检查成果须指定适用模板');
      assertInspectionRevision(inspectionId,period?.id,Number(fields.inspectionRevision));
      const inspection=inspectionId?requireInspection(inspectionId,period?.id):null;
      if(period?.status==='done')throw new ApiError('PERIOD_CLOSED','请先重新打开本期');
      /**
       * 落点由 `workbenchOutputDirAbs` 统一算（契约 §4，三条路径共用同一套函数）：
       *   绑定的工作台按 output_mode —— inline 就地 `<阶段目录>\<期次>\`、subdir `…\_原始资料\`、custom 自定义目录；
       *   未绑定的工作台保持改造前的 `<根>\_原始资料\`。
       * 没有工作台的上传仍进平台的 `_待归档`（与改造前一致）。
       */
      const dirAbs = wb
        ? workbenchOutputDirAbs(wb, kind === 'evidence' ? 'evidence' : kind === 'generated' ? 'generated' : 'source', {
            positionCode: fields.positionCode || null,
            stageLabel: kind === 'scan' ? '扫描件' : null,
          })
        : join(DATA_ROOT, DIRS.inbox);
      const targetDirAbs=period?join(dirAbs,'期次',period.report_period,...(inspection?['检查',String(inspection.id)]:[])):dirAbs;

      for (const f of files) {
        try {
          const baseName = note ? sourceFileName(kind === 'scan' ? '扫描件' : '资料', note, f.ext || '.bin') : safeName(f.fileName, 'file');
          const extra = await readExif(f.tempPath);
          const r = await saveArtifact({
            sourcePath: f.tempPath,
            dirAbs:targetDirAbs,
            fileName: baseName,
            workbenchId: workbenchId ?? null,
            checklistItemId,
            templateId,
            positionCode: fields.positionCode || null,
            kind,
            title: note || f.fileName,
            capturedAt: extra.capturedAt,
            exif: extra.exif,
            docDate: fields.docDate || null,
            summary: fields.summary || null,
            tags: fields.tags ? String(fields.tags).split(/[,，]/).filter(Boolean) : undefined,
          });
          run('UPDATE artifact SET file_role=? WHERE id=?',[fileRole,r.artifact.id]);
          if(period){run('UPDATE artifact SET work_period_id=?,inspection_id=?,inspection_revision=? WHERE id=?',[period.id,inspection?.id??null,inspection?.revision??null,r.artifact.id]);event(period.id,'upload',JSON.stringify({artifactId:r.artifact.id,fileName:r.artifact.file_name}));}
          if(templateId&&fields.final==='true'){
            try{markFinal(r.artifact.id,true);}catch(e){throw new ApiError('FINAL_CHECK',`文件已导入为草稿，定稿检查未通过：${(e as Error).message}`,409,{artifactId:r.artifact.id});}
          }
          saved.push(getArtifact(r.artifact.id)??r.artifact);
        } finally {
          cleanupTemp(f.tempPath);
        }
      }
      return ok(reply, { items: saved }, 201);
    } catch (e) {
      return fail(reply, e);
    } finally { for(const f of uploadFiles) cleanupTemp(f.tempPath); }
  });

  /** 影像证据上传：按阶段规则命名归档，并自动核销清单 */
  app.post('/api/artifacts/evidence', async (req, reply) => {
    const saved: unknown[] = [];
    let uploadFiles: {tempPath:string}[]=[];
    try {
      const { fields, files } = await readParts(req); uploadFiles=files;
      if (!files.length) throw new ApiError('NO_FILE', '没有收到照片');
      const workbenchId = Number(fields.workbenchId);
      const checklistItemId = fields.checklistItemId ? Number(fields.checklistItemId) : null;
      const wb = getWorkbenchLive(workbenchId);
      if (!wb) throw new ApiError('NOT_FOUND', '工作台不存在', 404);

      let positionCode = fields.positionCode || null;
      let phaseName = fields.phase || '';
      if (checklistItemId) {
        const row = get<{ position_code: string; position_name: string }>(
          `SELECT p.code AS position_code, p.name AS position_name
             FROM checklist_item c JOIN position_instance p ON p.id = c.position_instance_id
            WHERE c.id = ? AND p.workbench_id = ? AND c.kind = 'evidence' AND ${liveFilter('position_instance', 'p')}`,
          [checklistItemId,workbenchId],
        );
        if(!row) throw new ApiError('BAD_CHECKLIST','清单不属于本工作台或不是影像清单');
        if (row) {
          positionCode = positionCode ?? row.position_code;
          phaseName = phaseName || row.position_name;
        }
      }
      /**
       * 影像落点同样走 `workbenchOutputDirAbs`（契约 §4）：
       *   绑定的工作台 inline → `<阶段目录>\<期次>\照片\`；subdir → `<阶段目录>\<期次>\_影像证据\`；custom → 自定义目录；
       *   未绑定的工作台 → 老布局 `<根>\_影像证据\<阶段名>\`（行为与改造前一致）。
       * 阶段目录名由 positionDirAbs/stageDirName 现算，不在这里手拼。
       */
      const dirAbs = workbenchOutputDirAbs(wb, 'evidence', {
        positionCode,
        stageLabel: phaseName || positionCode,
      });
      const startIndex =
        (get<{ n: number }>(
          // 数的是"当前在用的照片数"，回收站里的（deleted_at IS NULL 之外的）不算
          `SELECT COUNT(*) AS n FROM artifact
            WHERE workbench_id = ? AND kind = ? AND position_code IS ?
              AND deleted_at IS NULL`,
          [
            workbenchId,
            'evidence',
            positionCode,
          ],
        )?.n ?? 0) + 1;

      let i = 0;
      for (const f of files) {
        try {
          const extra = await readExif(f.tempPath);
          const fileName = evidenceFileName(phaseName || positionCode || '阶段', startIndex + i, fields.note || f.fileName, f.ext || '.jpg');
          const r = await saveArtifact({
            sourcePath: f.tempPath,
            dirAbs,
            fileName,
            workbenchId,
            positionCode,
            kind: 'evidence',
            title: fields.note || f.fileName,
            checklistItemId,
            capturedAt: extra.capturedAt,
            exif: extra.exif,
          });
          saved.push(r.artifact);
          i += 1;
        } finally {
          cleanupTemp(f.tempPath);
        }
      }

      if (checklistItemId && saved.length) {
        const item = get<{ done_count: number; min_count: number }>('SELECT done_count, min_count FROM checklist_item WHERE id = ?', [checklistItemId]);
        if (item) updateChecklistItem(checklistItemId, { done_count: item.done_count + saved.length });
      }
      return ok(reply, { items: saved, count: saved.length }, 201);
    } catch (e) {
      return fail(reply, e);
    } finally { for(const f of uploadFiles) cleanupTemp(f.tempPath); }
  });

  /** 修改文件信息 */
  app.put('/api/artifacts/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getArtifact(id)) throw new ApiError('NOT_FOUND', '文件不存在', 404);
      const b = body(req);
      updateArtifact(id, {
        title: optStr(b, 'title'),
        summary: optStr(b, 'summary'),
        tags: strArray(b, 'tags') ? JSON.stringify(strArray(b, 'tags')) : undefined,
        doc_date: optStr(b, 'docDate'),
        checklist_item_id: optNum(b, 'checklistItemId'),
        position_code: optStr(b, 'positionCode'),
        ocr_text: optStr(b, 'ocrText'),
      });
      return ok(reply, getArtifact(id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 把文件**移到回收站**（可选连磁盘文件一起删）。
   *
   * 与改造前的区别：库记录不再 `DELETE`，只打 `deleted_at` 标记 —— 回收站里能恢复。
   * `withFile` 在此入口表示「软删除记录时是否同时删除磁盘文件」：
   *   · 不带 / `withFile=0` → 文件仍在磁盘上，回收站里恢复后照样能下载；原文件从此也从
   *     列表/检索/统计/清单里消失；
   *   · `withFile=1` → 顺手把磁盘文件删掉。这时**记录恢复出来也只是空壳**，所以响应里明说
   *     "文件已从磁盘删除，恢复后只有记录"。
   * 真删（连记录一起清）走 `DELETE /api/trash/artifact/:id?withFile=1`。
   *
   * 【本次修复】`withFile=1` 以前**只算了绝对路径就 unlink**，没有走 `core/trash.ts` 那套
   * 「允许根复核」。现在两条路的磁盘删除共用 `core/paths.ts` 的 `assertDeletableFile`：
   * 不在允许根内、只读来源（用户原件目录）、绑定根本身、内容与登记指纹不符、还被别的在用记录
   * 引用着 —— 任一条命中就**只移动记录、不动磁盘**，并把原因原样回给界面（`fileSkipped`）。
   *
   * 还有一条老契约要保留：`deleteArtifact` 在 `root_kind='external'` 且**工作台已解绑**时
   * 定位不到文件（core/store.ts 的 `artifactAbsPath`），那种情况下用户要的是"只删平台记录也能成功"。
   * 所以先自己判一次能不能定位：定位不到就只移动记录，并在响应里给 `fileRemoved:false` 与一句可读说明。
   * 其它错误（文件被占用、只读、数据库出错）照旧原样报错，绝不吞掉。
   */
  app.delete('/api/artifacts/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const a = getArtifact(id);
      if (!a) throw new ApiError('NOT_FOUND', '文件不存在（也可能已在回收站里，见「回收站」页）', 404);
      const withFile = qBool(req, 'withFile') === true;

      let absPath: string | null = null;
      try { absPath = artifactAbsPath(a); } catch { absPath = null; }

      if (withFile && absPath === null) {
        // 定位不到（典型是工作台解绑后 root_kind='external' 的老记录）：只移动记录
        const r = deleteArtifact(id, { withFile: false });
        return ok(reply, {
          ...r,
          deleted: true,
          trashed: true,
          fileRemoved: false,
          fileSkipped: null,
          message: `已移到回收站；原文件在工作台解绑后无法定位，未动磁盘（${a.file_rel}）。可在「回收站」页恢复` + (r.kbDocumentsRemoved ? `；已移除 ${r.kbDocumentsRemoved} 篇派生知识库文档，恢复后须重新导入知识库` : ''),
        });
      }

      const r = deleteArtifact(id, { withFile });
      /**
       * 四种情况要分开说清楚，别让界面统一显示"已删除文件"：
       *   · 带 withFile 但被安全阀跳过（只读来源 / 指纹不符 / 还被在用记录引用）→ 记录已进回收站，磁盘没动；
       *   · 带 withFile 但磁盘上本来就没有 → 只移动了记录；
       *   · 带 withFile 且真删了          → 明确告知"文件已从磁盘删除，恢复后只有记录"；
       *   · 不带 withFile                → 文件还在，恢复即可下载。
       */
      const message = r.fileSkipped
        ? `已移到回收站，但磁盘上的文件按安全规则未删除：${r.fileSkipped}。恢复记录后文件仍在原处`
        : withFile
          ? r.fileRemoved
            ? `已移到回收站，并删除了磁盘上的文件（${a.file_rel}）；恢复后只有记录，文件需要重新上传或放回原处`
            : `磁盘上已经没有这个文件了，只把记录移到了回收站（${a.file_rel}）`
          : `已移到回收站，磁盘文件仍在原处（${a.file_rel}），恢复后即可下载`;
      return ok(reply, { deleted: true, trashed: true, ...r, message: message +
        (r.kbDocumentsRemoved ? `；已移除 ${r.kbDocumentsRemoved} 篇派生知识库文档，恢复后须重新导入知识库` : '') +
        (r.warnings?.length ? `；${r.warnings.join('；')}` : ''), });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 全文检索 */
  app.get('/api/search', async (req, reply) => {
    try {
      const keyword = q(req, 'q') ?? '';
      if (!keyword.trim()) return ok(reply, { total: 0, items: [], keyword });
      const r = searchArtifacts(keyword, {
        workbenchId: qInt(req, 'workbenchId') ?? null,
        kind: q(req, 'kind') ?? null,
        mode: (q(req, 'mode') as 'or' | 'and') ?? 'or',
        limit: qInt(req, 'limit'),
        offset: qInt(req, 'offset'),
      });
      return ok(reply, { ...r, keyword });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 文件库总览统计 */
  app.get('/api/files/stats', async (_req, reply) => {
    /**
     * 统计口径：**只算没进回收站的**（软删除的记录不计入总数、字节数，也不算"缺失文件"）。
     * 下面每条 SQL 都显式带 `deleted_at IS NULL`，别看变量名猜。
     */
    const byKind = all<{ kind: string; n: number; bytes: number }>(
      `SELECT kind, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM artifact
        WHERE deleted_at IS NULL GROUP BY kind ORDER BY n DESC`,
    );
    const total = get<{ n: number; bytes: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM artifact
        WHERE deleted_at IS NULL`,
    );
    // 缺失统计要覆盖外部根（按 root_kind 解析），并且**单个坏记录不能让接口 500**：
    // 工作台被删、绑定被解、file_rel 有脏数据时，异常一律计入 missing。
    const missing = all<Artifact>('SELECT * FROM artifact WHERE deleted_at IS NULL')
      .filter((a) => {
        try {
          return !existsSync(artifactAbsPath(a));
        } catch {
          return true; // 工作台被删 / 已解绑 / file_rel 有脏数据 → 算缺失，不让接口 500
        }
      })
      .map((a) => ({ id: a.id, file_rel: a.file_rel }));
    // 索引行在软删除时就被摘掉了（供排障看一眼"索引表里还剩多少"）
    const indexed = get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact_search')?.n ?? 0;
    return ok(reply, {
      total: total?.n ?? 0,
      bytes: total?.bytes ?? 0,
      byKind,
      indexed,
      missingFiles: missing,
      dataRoot: toPosix(DATA_ROOT),
      dirs: DIRS,
      /**
       * 生效中的允许根**及其用途**（排障用，也是这次"授权模型"的可观测面）：
       *   platform 平台数据目录（读写删全开）
       *   writable 可写产物区（当前绑定目录 + 记录里出现过的历史来源根）
       *   readonly 只读来源（iCloud 原件 / 显式声明 / 写不进去的目录 / 平台受保护目录）
       * 只读来源里的文件一律不会被平台 unlink / rename / 写入 —— 界面据此解释"为什么删不掉"。
       */
      rootGrants: listBoundRootGrants(),
    });
  });

  /**
   * 重建全文索引。
   *
   * 除了重扫每份文件的文字，还要**清掉幽灵行** —— 索引表 `artifact_search`
   * 与 `artifact_fts` 没有外键约束，任何绕过 deleteArtifact 的删除（脚本、手工 SQL）
   * 都会留下对不上任何文件的索引行：检索命中后 JOIN 又把它过滤掉，
   * 于是「总数」和「实际列出条数」对不上，而且此前没有任何入口能修。
   */
  app.post('/api/files/reindex', async (_req, reply) => {
    // 只重扫**在用**的文件：回收站里的（deleted_at IS NOT NULL）不重建索引
    const rows = all<{ id: number }>('SELECT id FROM artifact WHERE deleted_at IS NULL');
    const { indexArtifact } = await import('../core/store.ts');
    let n = 0;
    for (const r of rows) {
      indexArtifact(r.id);
      n += 1;
    }
    // 幽灵行清理：对不上任何 artifact 的索引行（含刚被软删除、索引已被摘掉的），一并清掉
    const removed = run('DELETE FROM artifact_search WHERE id NOT IN (SELECT id FROM artifact WHERE deleted_at IS NULL)').changes;
    run('INSERT INTO artifact_fts(artifact_fts) VALUES (\'rebuild\')');
    return ok(reply, { reindexed: n, removedOrphans: Number(removed) });
  });

  /**
   * 把资料目录里手工放进来的文件纳入管理（扫描工作台目录）。
   *
   * **原地登记，绝不复制**（契约 §7.5）：以前走 `saveArtifact`，它会先 `uniqueFileName` 再写文件 ——
   * 于是"导入"变成了"复制一份"：每点一次「导入」就多出一份 `_v2`/`_v3` 副本，用户的原文件永远
   * 没有 artifact 记录（应用里"删除"删掉的是副本），副本的 sha256 还是空串、按内容去重永久失效。
   * 现在走 `registerExistingFile`：用文件自己的路径登记、真算 sha256、真抽文字，
   * 与 `_规范库` 的纳管完全一致（两条入口在 core/store.ts 里共用 `insertArtifactRecord`）。
   */
  app.post('/api/files/import-folder', async (req, reply) => {
    try {
      const b = body(req);
      const workbenchId = optNum(b, 'workbenchId');
      if (!workbenchId) throw new ApiError('MISSING_FIELD', '需要 workbenchId');
      const wb = getWorkbench(workbenchId);
      if (!wb) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      // 未绑定 = 原来的 DATA_ROOT/wb.folder_path；绑定后 = 用户的资料目录
      const root = workbenchRootAbs(wb);
      const { readdirSync, statSync } = await import('node:fs');
      // 已登记的相对路径（**回收站里的不算**，否则同名文件重新导入会被当成"已经有了"而跳过）
      const known = new Set(
        all<{ file_rel: string }>(
          `SELECT file_rel FROM artifact
            WHERE workbench_id = ? AND deleted_at IS NULL`,
          [workbenchId],
        ).map((a) => a.file_rel),
      );
      const added: string[] = [];
      const failed: { path: string; error: string }[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 4) return;
        for (const name of readdirSync(dir)) {
          /**
           * 排除规则统一走 `core/ignore.ts`（契约 §7.6）——点开头的名字（`.workbuddy`/`.git`/`.tmp`…）
           * 与 tmp/output/node_modules 及用户在 `scan.ignore` 里追加的名单，一处定义、处处一致；
           * 平台自己的 `_` 目录（`_生成文书`/`_影像证据`/`_规范库`…）也不纳管。
           */
          if (name.startsWith('_') || isIgnoredName(name)) continue;
          const abs = join(dir, name);
          /**
           * **平台自己的地方一个都不纳管**（本次修复的结构性一道）：
           * 目录绑定已经双向拒绝了"绑定平台数据目录 / 安装目录 / 运行目录 / 备份目录及其祖先"，
           * 但**存量数据**里可能已经绑了这样的根（旧版本放行的）。扫到这里就跳过，
           * 免得平台的数据库、备份、运行目录被登记成"用户文件"（登记之后就删得动了）。
           */
          if (isPlatformProtected(abs)) continue;
          let st;
          try {
            st = statSync(abs);
          } catch {
            continue; // iCloud 占位读不到 / 权限问题：跳过这一个，别让整次导入白干
          }
          if (st.isDirectory()) {
            await walk(abs, depth + 1);
            continue;
          }
          // 相对**工作台的根**登记（外部根的文件以前按 DATA_ROOT 切，会切出一堆 `..\..\` 脏路径）
          const rel = toPosix(relative(root, abs));
          if (known.has(rel) || isIgnoredRelPath(rel)) continue;
          try {
            const r = await registerExistingFile({
              absPath: abs,
              workbenchId,
              kind: 'source',
              title: name,
              index: true,
            });
            known.add(r.artifact.file_rel);
            added.push(r.artifact.file_rel);
          } catch (e) {
            // 单个文件失败（读不了、内容与类型不符…）不该让整次导入失败；原因带上，界面能列出来
            failed.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
          }
        }
      };
      await walk(root, 0);
      return ok(reply, { added: added.length, files: added, failed });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 生成文书一览 */
  app.get('/api/files/generated', async (req, reply) => {
    try {
      const r = listArtifacts({ kind: 'generated', workbenchId: qInt(req, 'workbenchId') ?? null, limit: qInt(req, 'limit') });
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ------------------------------ OCR ------------------------------ */

  /** 队列状态（界面轮询用） */
  app.get('/api/ocr/status', async (_req, reply) => {
    try {
      return ok(reply, { ...queueState(30), ...ocrSummary(), tessdata: tessdataInfo(), langs: listLangStatus(ocrLangs()) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 把库里还没识别的图片/扫描件排上队，并立刻开跑 */
  app.post('/api/ocr/scan-missing', async (_req, reply) => {
    try {
      if (!getSetting('ocr.enabled', false)) throw new ApiError('OCR_DISABLED', 'OCR 还没启用。请到「系统配置」打开「扫描件 OCR」开关。');
      const queued = enqueueMissing();
      void processQueue().catch(() => undefined);
      return ok(reply, { queued });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 对指定文件重新识别（界面上的「重新识别 / 开始识别」）。
   *
   * 用 `requeueOcr` 而不是 `enqueueOcr`：后者对 `status='done'` 的行直接 return
   * （那是上传路径该有的行为 —— 已识别好的文件不该被重新烧 CPU），
   * 于是这个接口以前对"已识别成功"的文件回 `{"queued":true}`，**实际什么都没做**：
   * 库里 `attempts` 不变、任务也不会跑。用户点「重新识别」的意图就是要重跑一次，
   * 所以现在真的重排（`done`/`failed`/`skipped` 都置回 pending，`attempts` 清零 ——
   * 理由见 ocr-queue.ts 的 requeueOcr 注释），并把**实际结果**返回给界面。
   *
   * 返回的 `queued` 说的是"这次有没有排上队"，不是"接口成功了"：
   * 重复点击（已经在排队/正在识别）时为 false + 当前 status，界面不会再说"已重新排队"骗用户。
   * 既有结果（ocr_text/chars/confidence）在重排时**保留**，重跑失败也不会把上次认出来的文字弄丢。
   */
  app.post('/api/ocr/artifacts/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const a = getArtifact(id);
      if (!a) throw new ApiError('NOT_FOUND', '文件不存在', 404);
      if (!isOcrCandidate(a.file_name)) throw new ApiError('NOT_IMAGE', `${a.file_ext} 不支持 OCR，只能识别图片（PNG/JPG/BMP/TIFF 等）。`);
      const outcome = requeueOcr(id);
      if (outcome.queued) void processQueue().catch(() => undefined);
      return ok(reply, {
        queued: outcome.queued,
        status: outcome.status,
        // previous_attempts：重排前的尝试次数（attempts 会被清零，原值在这里留个底）
        previous_attempts: outcome.previousAttempts,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 先把语言包下载好（首次 OCR 前调用，避免用户等太久） */
  app.post('/api/ocr/prepare', async (req, reply) => {
    try {
      const langs = ocrLangs();
      const results = [];
      for (const l of langs) {
        results.push(await ensureLang(l));
      }
      const bad = results.filter((r) => !r.ready);
      if (bad.length) throw new ApiError('LANG_FAILED', bad.map((b) => b.error).join('\n'));
      return ok(reply, { langs: results.map((r) => ({ lang: r.lang, bytes: r.bytes })) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 取消排队中的任务 */
  app.post('/api/ocr/cancel', async (_req, reply) => {
    try {
      return ok(reply, { cancelled: cancelPending() });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ------------------------------ 文书版本链（B1-4，迁移 017） ------------------------------ */

  /**
   * ```
   * GET  /api/artifacts/:id/versions               这条文书的版本链（revision/时间/怎么生成的/是否定稿）
   * POST /api/artifacts/:id/mark-final  {final}    标 / 取消「最终版」（同一条链只能有一个）
   * POST /api/artifacts/:id/rollback-to/:revision  回滚：那一版复制回来成为新的一版（中间版本永不删）
   * GET  /api/artifacts/:id/diff?from=&to=         只比变量（“哪个字段改了”），不做 docx 正文 diff
   * ```
   *
   * 错误映射（与路由层的分工一致）：
   *   · `VersionRuleError`（用户操作不合法：定稿不能覆盖、版本不存在、没有链…）→ **400 + 原文**，
   *     界面 toast 直接显示后端那句话，不吞成 500「服务出错了」；
   *   · 领域层其它普通 Error 同样按用户可见的业务错误转 400（与回收站那组接口同一口径）。
   */
  const versionDomain400 = (e: unknown): ApiError =>
    e instanceof ApiError ? e : new ApiError('BAD_REQUEST', e instanceof Error ? e.message : String(e), 400);

  app.get('/api/artifacts/:id/versions', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getArtifact(id)) throw new ApiError('NOT_FOUND', '文件不存在（也可能已在回收站里，见「回收站」页）', 404);
      const chain = listVersionChain(id);
      if (!chain) throw new ApiError('NOT_FOUND', '文件不存在', 404);
      return ok(reply, {
        ...chain,
        items: chain.items.map((v) => ({
          ...v,
          url: v.exists ? `/api/artifacts/${v.id}/file` : null,
          /** 界面上的版本名：迁移前的旧生成件明确写「未分链」，不假装它是链上的一版 */
          label: chain.unchained ? 'v1（未分链）' : `v${v.revision}`,
        })),
        final: chain.finalId
          ? { id: chain.finalId, revision: chain.finalRevision, label: `v${chain.finalRevision}` }
          : null,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/artifacts/:id/mark-final', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getArtifact(id)) throw new ApiError('NOT_FOUND', '文件不存在（也可能已在回收站里）', 404);
      const raw: Record<string, unknown> = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const v = raw.final === undefined ? q(req, 'final') : raw.final;
      // 不传就是"标为最终版"（这个接口的主用途）；传 false/0 表示取消
      const final = v === undefined ? true : v === true || v === 1 || v === '1' || v === 'true';
      let r;
      try {
        r = markFinal(id, final);
      } catch (e) {
        throw versionDomain400(e);
      }
      return ok(reply, { ...r, artifact: getArtifact(id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/artifacts/:id/rollback-to/:revision', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const revision = intParam(req, 'revision');
      if (!getArtifact(id)) throw new ApiError('NOT_FOUND', '文件不存在（也可能已在回收站里）', 404);
      let r;
      try {
        r = await rollbackToRevision(id, revision);
      } catch (e) {
        throw versionDomain400(e);
      }
      return ok(reply, {
        ...r,
        artifact: getArtifact(r.artifactId),
        message: r.warnings.join(' '),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/artifacts/:id/diff', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getArtifact(id)) throw new ApiError('NOT_FOUND', '文件不存在（也可能已在回收站里）', 404);
      const from = qInt(req, 'from');
      const to = qInt(req, 'to');
      if (!from || !to) throw new ApiError('MISSING_FIELD', '需要 from 与 to（两个版本号），例如 ?from=1&to=3');
      let r;
      try {
        r = diffVersions(id, from, to);
      } catch (e) {
        throw versionDomain400(e);
      }
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });
}

/* ------------------------------ 回收站（迁移 015） ------------------------------ */

/**
 * 回收站接口。
 *
 * ```
 * GET    /api/trash?kind=&limit=        回收站列表（含 kind/title/deletedAt/额外信息）
 * POST   /api/trash/:kind/:id/restore   恢复（不完整时带 warnings，恢复不了就 400 + 原因）
 * DELETE /api/trash/:kind/:id           彻底删除（带 ?withFile=1 才删磁盘文件）
 * DELETE /api/trash                     清空（可带 ?olderThanDays=N）
 * ```
 *
 * 错误映射（与领域层分工一致）：
 *   · `kind` 不在白名单 → 400，并把可用取值列出来（不静默当成"空结果"）；
 *   · 恢复/彻底删除被业务规则拒绝（父记录不在、编号冲突、没先移入回收站…）→ **400 + 领域层原文**，
 *     界面 toast 直接显示后端那句话，不吞成 500 "服务出错了"；
 *   · 记录根本不存在 → 列表/恢复 404。
 */
export function registerTrashRoutes(app: FastifyInstance): void {
  /** 领域层抛的是普通 Error（用户操作不合法），转成 400 + 原文 */
  const domain400 = (e: unknown): ApiError =>
    e instanceof ApiError ? e : new ApiError('BAD_REQUEST', e instanceof Error ? e.message : String(e), 400);

  const kindParam = (req: { params: unknown }): string => {
    const raw = String((req.params as { kind?: string }).kind ?? '');
    if (!isTrashKind(raw)) {
      throw new ApiError('BAD_PARAM', `回收站类型不认识：${raw}（可用：${TRASH_KINDS.join(' / ')}）`);
    }
    return raw;
  };

  app.get('/api/trash', async (req, reply) => {
    try {
      const kind = q(req, 'kind');
      if (kind !== undefined && !isTrashKind(kind)) {
        throw new ApiError('BAD_PARAM', `kind 只能是 ${TRASH_KINDS.join(' / ')}：${kind}`);
      }
      const items = listTrash({ kind, limit: qInt(req, 'limit') });
      return ok(reply, { items, total: items.length, count: trashCount(), kinds: TRASH_KINDS });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/trash/:kind/:id/restore', async (req, reply) => {
    try {
      const kind = kindParam(req);
      const id = intParam(req, 'id');
      let r;
      try {
        r = restoreFromTrash(kind, id);
      } catch (e) {
        throw domain400(e);
      }
      /**
       * **恢复之后必须把允许根刷回来**（与 `core/trash.ts` 里那次是同一件事的两道保险）。
       * 删除工作台时它的 external_root 被摘出允许根；不刷回来的话，紧接着的上传/纳管会报
       * 「路径越界」、预览打不开、**彻底删除时磁盘文件一个都删不掉**，而用户没有任何入口能修。
       * 放在回复之前同步刷（这里在 API 层，可以同步调），失败不影响恢复本身。
       */
      try {
        reloadBoundRoots();
      } catch {
        /* 下次启动会重算：库已经改对了 */
      }
      return ok(reply, {
        ...r,
        // 界面 toast 用它：恢复成功但"只回来一半"时要把 warnings 说给用户听
        message: r.warnings.length ? `已恢复，但有需要注意的地方：${r.warnings.join('；')}` : '已恢复',
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/trash/:kind/:id', async (req, reply) => {
    try {
      const kind = kindParam(req);
      const id = intParam(req, 'id');
      /**
       * `withFile` 三态：缺省（不传）= **删磁盘文件**（"彻底删除"就是这个意思）；
       * `withFile=0/false` = 只删库记录、磁盘文件留着。
       */
      const asked = qBool(req, 'withFile');
      const withFile = asked === undefined ? true : asked;
      let r;
      try {
        r = purgeFromTrash(kind, id, { withFile });
      } catch (e) {
        throw domain400(e);
      }
      return ok(reply, {
        ...r,
        withFile,
        message: (r.skipped?.length
          ? `已彻底删除记录，但有 ${r.skipped.length} 份磁盘文件按安全规则未删除（只读来源 / 内容与登记不符 / 还被在用记录引用）：${r.skipped.join('；')} —— 不可恢复`
          : withFile
            ? `已彻底删除（含磁盘文件，共删掉 ${r.filesRemoved} 个文件）—— 不可恢复`
            : '已彻底删除记录（磁盘文件保留）—— 不可恢复') + (r.warnings?.length ? `；${r.warnings.join('；')}` : ''),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/trash', async (req, reply) => {
    try {
      let r;
      try { r = emptyTrash(qInt(req, 'olderThanDays')); } catch (e) { throw domain400(e); }
      return ok(reply, {
        ...r,
        message: `本次处理结束：独立删除 ${r.purged} 项，随父项删除 ${r.covered} 项，保留期内 ${r.retained} 项，安全拒绝 ${r.protected} 项，失败 ${r.failed} 项，未执行 ${r.notExecuted} 项；删除磁盘文件 ${r.filesRemoved} 份` +
          (r.skipped?.length ? `；安全规则保留 ${r.skipped.length} 份磁盘文件` : '') +
          (r.warnings?.length ? `；清理警告 ${r.warnings.length} 条：${r.warnings.join('；')}` : '') +
          (r.scope.outsideSnapshot ? `；另有 ${r.scope.outsideSnapshot} 条未纳入本次列表快照（部分可能随父项删除）` : '') +
          `。回收站当前剩余 ${r.scope.remaining} 项，请查看逐项结果。`,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
