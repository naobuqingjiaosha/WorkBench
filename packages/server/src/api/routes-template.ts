import {checkedOfficeBytes,readOfficeBytes} from '../core/office-package.ts';
/** 模板库接口：上传、扫描变量、编辑变量说明、下载、删除 */
import { readFileSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { all, get, tx, run, pluck1 } from '../db/index.ts';
import { DATA_ROOT, DIRS } from '../core/config.ts';
import { join, basename, dirname, resolve } from 'node:path';
import type { Template } from '../domain/service.ts';

/** 归档后的模板文件挪到这里，不再占着模板库目录 */
const ARCHIVED_TEMPLATE_DIR = '_归档模板';

/**
 * 把归档模板的文件从 `_模板库` 挪进 `_归档模板`。
 * 挪不动（被 Word 占用等）不算失败：归档本身已经生效，文件留着只是没整理。
 * 文件缺失时仍允许归档记录，方便清理缺失模板。
 */
function archiveTemplateFiles(t:Template):number {
 if(t.archived_at)return 0;
 const destDir=join(DATA_ROOT,ARCHIVED_TEMPLATE_DIR,String(t.id));mkdirSync(destDir,{recursive:true});
 const copies:{source:string;target:string;column:string}[]=[];
 try{
  for(const [source,column] of [[templateAbsPath(t),'file_rel'],[varsAbsPath(t),'vars_rel']] as const){if(!source)continue;
    if(!existsSync(source))continue;
    const target=join(destDir,uniqueFileName(destDir,basename(source)));copyFileSync(source,target,constants.COPYFILE_EXCL);copies.push({source,target,column});}
  tx(()=>{for(const c of copies)run('UPDATE template SET '+c.column+'=? WHERE id=?',[relFrom(DATA_ROOT,c.target),t.id]);run("UPDATE template SET archived_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",[t.id]);});
 }catch(e){for(const c of copies)rmSync(c.target,{force:true});throw e;}
 for(const c of copies){try{rmSync(c.source,{force:true});}catch{/* 有引用的新副本已保存，旧文件占用时保留。 */}}
 return copies.length;
}

/**
 * 取消归档：把归档时挪进 `_归档模板/<id>/` 的文件搬回 `_模板库`，并更新 file_rel / vars_rel。
 *
 * 归档是「复制进归档目录 + 删源文件」，所以取消归档必须把文件搬回来 ——
 * 否则记录恢复了、文件还躺在 `_归档模板/` 下，预览与生成都会报「模板文件已丢失」。
 * 搬不回来（文件本来就不在，例如早期只改了 archived_at、没搬过文件的历史归档）**不算失败**：
 * 记一行日志，照常取消归档，记录先恢复可见，用户再去补文件。
 */
function restoreArchivedTemplateFiles(t:Template):number {
 const destDir=join(DATA_ROOT,DIRS.templates);
 const archiveDir=join(DATA_ROOT,ARCHIVED_TEMPLATE_DIR,String(t.id));
 let moved=0;
 for(const [abs,column] of [[templateAbsPath(t),'file_rel'],[varsAbsPath(t),'vars_rel']] as const){
  if(!abs)continue;
  if(resolve(dirname(abs))===resolve(destDir)){
   // 记录本来就在模板库：文件还在就没什么要搬的，不在就如实记一行（历史归档常见）
   if(!existsSync(abs))console.warn(`模板 #${t.id} 取消归档：${column} 的文件不在模板库（${abs}），请从备份找回`);
   continue;
  }
  if(!existsSync(abs)){console.warn(`模板 #${t.id} 取消归档：${column} 指向的归档文件不存在，已跳过（${abs}）`);continue;}
  try{
   mkdirSync(destDir,{recursive:true});
   const target=join(destDir,uniqueFileName(destDir,basename(abs)));
   renameSync(abs,target);
   run('UPDATE template SET '+column+'=? WHERE id=?',[relFrom(DATA_ROOT,target),t.id]);
   moved++;
  }catch(e){console.warn(`模板 #${t.id} 取消归档：${column} 文件搬回失败，已跳过（${(e as Error).message}）`);}
 }
 try{if(existsSync(archiveDir)&&!readdirSync(archiveDir).length)rmSync(archiveDir,{recursive:true,force:true});}catch{/* 空目录清理失败不影响取消归档 */}
 return moved;
}

import {
  getTemplate,
  listTemplates,
  readTemplateVars,
  recheckAllTemplates,
  refreshTemplateHealth,
  registerTemplate,
  rescanTemplate,
  templateAbsPath,
  varsAbsPath,
  writeTemplateVars,
  type TemplateVarsFile,
} from '../domain/service.ts';
import { canRender, checkTemplateHealth, detectFormat, scanTemplate, scanTemplateStructure } from '../core/template.ts';
import { renderPreviewPlan } from '../domain/generate.ts';
import { analyzeTemplateFields, applyTemplateFields } from '../core/template-fields.ts';
import { commitTemplateRevision } from '../domain/template-revision.ts';
import { templateAutofill } from '../domain/template-autofill.ts';
import { ApiError, body, fail, intParam, ok, optNum, optStr, q, qInt,qBool, requireStr } from './reply.ts';
import { cleanupTemp, readParts } from './upload.ts';
import { resolveInside,safeName, stamp, toPosix,uniqueFileName,relFrom } from '../core/paths.ts';

export function registerTemplateRoutes(app: FastifyInstance): void {
  app.get('/api/templates/:id/history',async(req,reply)=>{try{const id=intParam(req,'id');if(!getTemplate(id))throw new ApiError('NOT_FOUND','模板不存在',404);return ok(reply,{items:all('SELECT id,digest,vars_rel,created_at FROM template_revision WHERE template_id=? ORDER BY id DESC',[id])});}catch(e){return fail(reply,e);}});
  app.get('/api/templates/:id/history/:revision/file',async(req,reply)=>{try{
    const r=get<{file_rel:string;vars_rel:string|null}>('SELECT * FROM template_revision WHERE template_id=? AND id=?',[intParam(req,'id'),intParam(req,'revision')]);
    if(!r)throw new ApiError('NOT_FOUND','历史修订不存在',404);
    const rel=q(req,'part')==='vars'?r.vars_rel:r.file_rel;
    if(!rel||!existsSync(resolveInside(DATA_ROOT,rel)))throw new ApiError('FILE_MISSING','历史文件丢失，请从文件备份恢复',410);
    return reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(basename(rel))}`).type(rel.endsWith('.json')?'application/json':'application/octet-stream').send(readFileSync(resolveInside(DATA_ROOT,rel)));
  }catch(e){return fail(reply,e);}});
  /**
   * 列表/详情都要带上健康状态，界面据此给坏模板打红标。
   * 这三列由迁移 014 加到 template 表上，`SELECT t.*` 已经带出来了，
   * 这里再显式归一一次（SQLite 的 NULL → null，1/0 → number），
   * 免得哪天查询改成显式列名时静默丢掉。
   */
  const healthFields = (t: Template) => ({
    health_ok: t.health_ok === null || t.health_ok === undefined ? null : Number(t.health_ok),
    health_note: t.health_note ?? null,
    health_checked_at: t.health_checked_at ?? null,
  });

  app.get('/api/templates', async (req, reply) =>
    ok(reply, {
      items: listTemplates({
        category: q(req, 'category'),
        workTypeId: qInt(req, 'workTypeId'),
        keyword: q(req, 'keyword'),archived:qBool(req,'archived'),
      }).map((t) => ({ ...t, ...healthFields(t), renderable: canRender(t.file_format as never), file_exists: existsSync(templateAbsPath(t)) })),
    }),
  );

  app.get('/api/templates/:id', async (req, reply) => {
    try {
      const t = getTemplate(intParam(req, 'id'));
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const vars = readTemplateVars(t);
      return ok(reply, {
        template: { ...t, ...healthFields(t), renderable: canRender(t.file_format as never), file_exists: existsSync(templateAbsPath(t)) },
        vars,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 对所有在用模板重跑一遍健康校验并写回，返回 `{checked, bad}`。
   * 界面上的「检查模板是否可用」按钮调它 —— 修好/换过源文件之后需要重新判定。
   * 放在 `/api/templates/:id/...` 之前不影响路由（Fastify 静态段优先于参数段）。
   */
  app.post('/api/templates/health-check', async (_req, reply) => {
    try {
      const r = recheckAllTemplates();
      return ok(reply, { checked: r.checked, bad: r.bad, items: r.items });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 上传模板：可一次传多个；传完自动扫描变量 */
  app.post('/api/templates/upload', async (req, reply) => {
    const created: unknown[] = [];
    let pendingUploads:{tempPath:string}[]=[];
    try {
      const { fields, files } = await readParts(req);pendingUploads=files;
      if (!files.length) throw new ApiError('NO_FILE', '没有收到文件');
      for (const f of files) {
        try {
          const t = registerTemplate({
            absSourcePath: f.tempPath,
            originalFileName: f.fileName,
            name: fields.name || undefined,
            code: fields.code || undefined,
            category: fields.category || 'general',
            workTypeId: fields.workTypeId ? Number(fields.workTypeId) : null,
            positionCode: fields.positionCode || null,
            description: fields.description || undefined,
            docNo: fields.docNo || null,
          });
          let variableCount = 0;
          let warnings: string[] = [];
          if (canRender(t.file_format as never)) {
            const r = await rescanTemplate(t.id);
            variableCount = r.vars.variables.length;
            warnings = r.scan.warnings;
          } else {
            const s = await scanTemplate(templateAbsPath(t));
            warnings = s.warnings;
          }
          created.push({ template: { ...t, ...healthFields(t), variable_count: variableCount }, warnings });
        } finally {
          cleanupTemp(f.tempPath);
        }
      }
      return ok(reply, { items: created }, 201);
    } catch (e) {
      return fail(reply, e);
    }finally{for(const f of pendingUploads)cleanupTemp(f.tempPath);}
  });

  /** 替换文件，保留模板 ID、设置和引用；旧文件保留以便找回。 */
  app.post('/api/templates/:id/reupload', async (req, reply) => {
    let files: Awaited<ReturnType<typeof readParts>>['files'] = [];
    const staged: string[] = [];
    let committed = false;
    try {
      const id = intParam(req, 'id');
      const t = getTemplate(id);
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      ({ files } = await readParts(req));
      if (files.length !== 1) throw new ApiError('BAD_FILE_COUNT', '请选择一个替换文件');
      const f = files[0]!;
      if (!['.docx', '.xlsx', '.xlsm'].includes(f.ext)) throw new ApiError('BAD_EXT', '请上传 .docx、.xlsx 或 .xlsm 模板');
      const health = checkTemplateHealth(f.tempPath);
      if (!health.ok) throw new ApiError('BAD_TEMPLATE', `新模板不可用：${health.reason ?? '文件结构损坏'}`);
      const scan = await scanTemplate(f.tempPath);
      const current = readTemplateVars(t, false);
      const previous = new Map(current.variables.map(v => [v.name, v]));
      const vars: TemplateVarsFile = {
        ...current,
        template: t.name,
        updatedAt: new Date().toISOString(),
        variables: scan.variables.filter(v => !v.prefix).map(v => previous.get(v.name) ?? {
          name: v.name, label: v.name, type: 'text', required: true, example: v.fallback ?? undefined,
        }),
      };
      // 独立的新路径：校验或保存失败不会覆盖当前文件及其变量说明。
      const dir = join(DATA_ROOT, DIRS.templates);
      mkdirSync(dir, { recursive: true });
      const stem = `${safeName(t.code)}-${randomUUID()}`;
      const filePath = join(dir, stem + f.ext);
      const varsPath = join(dir, stem + '.vars.json');
      staged.push(filePath, varsPath);
      copyFileSync(f.tempPath, filePath, constants.COPYFILE_EXCL);
      writeFileSync(varsPath, JSON.stringify(vars, null, 2), { encoding: 'utf8', flag: 'wx' });
      tx(() => {
        const fresh = getTemplate(id);
        if (!fresh || fresh.file_rel !== t.file_rel || fresh.updated_at !== t.updated_at) {
          throw new ApiError('CONFLICT', '模板已发生变化，请刷新后重新上传', 409);
        }
        run(`UPDATE template SET file_rel=?, file_format=?, vars_rel=?, variable_count=?,
          health_ok=1, health_note=NULL, health_checked_at=?,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        [relFrom(DATA_ROOT, filePath), detectFormat(f.fileName), relFrom(DATA_ROOT, varsPath), vars.variables.length, new Date().toISOString(), id]);
      });
      committed = true;
      return ok(reply, { template: getTemplate(id), warnings: scan.warnings });
    } catch (e) {
      return fail(reply, e);
    } finally {
      for (const f of files) cleanupTemp(f.tempPath);
      if (!committed) for (const path of staged) cleanupTemp(path);
    }
  });

  /** 重新扫描模板里的变量（顺带重新判定健康状态） */
  app.post('/api/templates/:id/scan', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const t = getTemplate(id);
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const r = await rescanTemplate(id);
      return ok(reply, { variables: r.vars.variables, preview: r.scan.preview, warnings: r.scan.warnings, health: r.health });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/templates/:id/smart-fields', async (req, reply) => {
    try {
      const t = getTemplate(intParam(req,'id'));
      if (!t) throw new ApiError('NOT_FOUND','模板不存在',404);
      const path = templateAbsPath(t);
      if (!existsSync(path)) throw new ApiError('FILE_MISSING','模板文件已丢失，请重新上传',410);
      const health = checkTemplateHealth(path);
      if (!health.ok) throw new ApiError('BAD_TEMPLATE',health.reason ?? '模板文件损坏');
      const analysis = await analyzeTemplateFields(path);
      return ok(reply,{fingerprint:analysis.fingerprint,candidates:analysis.candidates.map(({target,start,end,...candidate})=>candidate)});
    } catch(e) {return fail(reply,e);}
  });

  app.post('/api/templates/:id/smart-fields/apply', async (req,reply)=>{
    try {
      const t=getTemplate(intParam(req,'id'));
      if(!t)throw new ApiError('NOT_FOUND','模板不存在',404);
      const b=body(req),path=templateAbsPath(t);
      if(!existsSync(path))throw new ApiError('FILE_MISSING','模板文件已丢失，请重新上传',410);
      const analysis=await analyzeTemplateFields(path);
      if(b.fingerprint!==analysis.fingerprint)throw new ApiError('CONFLICT','模板已经变化，请重新识别后确认',409);
      if(!Array.isArray(b.selections)||!b.selections.length||b.selections.length>200)throw new ApiError('BAD_SELECTION','请选择 1 至 200 个位置');
      const selections=b.selections.map(v=>{
        if(!v||typeof v!=='object'||typeof v.id!=='string'||typeof v.name!=='string')throw new ApiError('BAD_SELECTION','识别项或变量名不合法');
        return {id:v.id,name:v.name};
      });
      let bytes: Buffer;
      try {bytes=await applyTemplateFields(path,analysis.candidates,selections);}catch(e){throw new ApiError('BAD_SELECTION',(e as Error).message);}
      const hints=selections.map(s=>({name:s.name.trim(),type:analysis.candidates.find(c=>c.id===s.id)?.type}));
      return ok(reply,await commitTemplateRevision(t,bytes,hints,analysis.fingerprint));
    }catch(e){return fail(reply,e);}
  });

  app.post('/api/templates/:id/auto-fill',async(req,reply)=>{
    try {
      const t=getTemplate(intParam(req,'id'));if(!t)throw new ApiError('NOT_FOUND','模板不存在',404);
      const b=body(req),rawId=b.workbenchId;
      if(rawId!==undefined&&rawId!==null&&(!Number.isSafeInteger(rawId)||Number(rawId)<=0))throw new ApiError('BAD_FIELD','工作编号不合法');
      const abs=templateAbsPath(t);
      if(!existsSync(abs))throw new ApiError('FILE_MISSING','模板文件已丢失，请重新上传',410);
      const health=checkTemplateHealth(abs);if(!health.ok)throw new ApiError('BAD_TEMPLATE',health.reason ?? '模板文件损坏');
      const scan=await scanTemplate(abs);
      const structure=scanTemplateStructure(templateAbsPath(t));
      const names=scan.variables.filter(v=>!v.prefix&&!structure.collections.some(c=>c.name===v.name)&&!structure.images.some(i=>i.name===v.name)).map(v=>v.name);
      return ok(reply,templateAutofill(t,names,rawId ? Number(rawId):null));
    }catch(e){return fail(reply,e);}
  });

  /** 独立于工作台的模板核对：读取当前文件，不改变变量配置或生成正式文书。 */
  app.get('/api/templates/:id/preview', async (req, reply) => {
    try {
      const t = getTemplate(intParam(req, 'id'));
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const abs = templateAbsPath(t);
      if (!existsSync(abs)) throw new ApiError('FILE_MISSING', '模板文件已丢失，请重新上传', 410);
      const health = checkTemplateHealth(abs);
      const scan = health.ok ? await scanTemplate(abs) : {
        format: detectFormat(abs), variables: [], preview: '', warnings: [health.reason ?? '模板文件已损坏'],
      };
      const structure = scanTemplateStructure(abs);
      const saved = readTemplateVars(t, false);
      const detectedNames = scan.variables.filter(v => !v.prefix).map(v => v.name);
      return ok(reply, {
        template: { id: t.id, name: t.name, file_format: t.file_format },
        health, renderable: canRender(scan.format), scan, structure, savedVariables: saved.variables,
        added: detectedNames.filter(name => !saved.variables.some(v => v.name === name)),
        removed: saved.variables.filter(v => !detectedNames.includes(v.name)).map(v => v.name),
      });
    } catch (e) { return fail(reply, e); }
  });

  /** 与正式生成共用渲染器；不传工作台，不读取任何工作台的照片或档案。 */
  app.post('/api/templates/:id/preview', async (req, reply) => {
    try {
      const t = getTemplate(intParam(req, 'id'));
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const abs = templateAbsPath(t);
      if (!existsSync(abs)) throw new ApiError('FILE_MISSING', '模板文件已丢失，请重新上传', 410);
      const health = checkTemplateHealth(abs);
      if (!health.ok) throw new ApiError('BAD_TEMPLATE', health.reason ?? '模板文件已损坏');
      const b = body(req);
      const values = b.values && typeof b.values === 'object' && !Array.isArray(b.values) ? b.values as Record<string, unknown> : {};
      const r = await renderPreviewPlan(t.id, values, { workbenchId: null, rowLimit: 200 });
      if (b.download === true) {
        if (!r.ok || !r.bytes) throw new ApiError('RENDER_FAILED', r.check.reason);
        reply.type('application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('试填_' + r.fileName)}`);
        reply.header('X-Missing-Vars', encodeURIComponent(JSON.stringify(r.missing)));
        return reply.send(r.bytes);
      }
      // Excel 按真实试填产物的单元格展示，保留行列坐标，方便与原表核对。
      if (detectFormat(abs) === 'xlsx' && r.bytes && r.plan) {
        const ExcelJS = (await import('exceljs')).default;
        const book = new ExcelJS.Workbook();
        await book.xlsx.load(checkedOfficeBytes(r.bytes) as never);
        const segments: typeof r.plan.segments = [];
        book.eachSheet(ws => {
          const width = Math.min(ws.columnCount, 50);
          const rows: string[][] = [];
          let totalRows = 0;
          ws.eachRow({ includeEmpty: false }, row => {
            totalRows++;
            if (rows.length >= 200) return;
            rows.push([String(row.number), ...Array.from({ length: width }, (_, i) => {
              const cell = row.getCell(i + 1);
              return cell.isMerged && cell.master.address !== cell.address ? '' : cell.text;
            })]);
          });
          segments.push({ kind: 'table', part: `工作表：${ws.name}`, headers: ['行号', ...Array.from({ length: width }, (_, i) => ws.getColumn(i + 1).letter)], rows, truncatedRows: Math.max(0, totalRows - rows.length) });
          if (ws.columnCount > 50) r.warnings.push(`工作表「${ws.name}」仅显示前 50 列，完整内容请下载试填文件。`);
        });
        r.plan.segments = segments;
        r.plan.counts = { text: 0, table: segments.length, image: 0 };
        r.plan.tableRows = segments.reduce((sum, seg) => sum + (seg.rows?.length ?? 0) + (seg.truncatedRows ?? 0), 0);
        r.plan.limitations.push('Excel 合并区域仅在左上角显示内容，页面不还原合并单元格和行高列宽。');
      }
      return ok(reply, { check: r.check, plan: r.plan, warnings: r.warnings, missing: r.missing, missingImages: r.missingImages ?? [], fileName: '试填_' + r.fileName });
    } catch (e) { return fail(reply, e); }
  });

  /** 只看不存：扫描预览 */
  app.get('/api/templates/:id/scan-preview', async (req, reply) => {
    try {
      const t = getTemplate(intParam(req, 'id'));
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const s = await scanTemplate(templateAbsPath(t));
      return ok(reply, { preview: s.preview, variables: s.variables, warnings: s.warnings, format: s.format });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 保存变量说明（人工补充标签、类型、是否必填） */
  app.put('/api/templates/:id/vars', async (req, reply) => {
    try {
      const t = getTemplate(intParam(req, 'id'));
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const b = body(req);
      const variables = Array.isArray(b.variables) ? b.variables : [];
      const vars: TemplateVarsFile = {
        description: optStr(b, 'description'),
        variables: variables
          .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
          .map((v) => ({
            name: String(v.name ?? '').trim(),
            label: v.label ? String(v.label) : undefined,
            type: (v.type as TemplateVarsFile['variables'][number]['type']) ?? 'text',
            required: v.required === undefined ? true : Boolean(v.required),
            example: v.example ? String(v.example) : undefined,
            hint: v.hint ? String(v.hint) : undefined,
            options: Array.isArray(v.options) ? v.options.map((x) => String(x)) : undefined,
          }))
          .filter((v) => v.name),
      };
      writeTemplateVars(t, vars);
      return ok(reply, { saved: vars.variables.length });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/api/templates/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const t = getTemplate(id);
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const b = body(req);
      run(
        `UPDATE template SET name = ?, category = ?, work_type_id = ?, position_code = ?, description = ?,
           doc_no = ?, usage_note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [
          optStr(b, 'name') ?? t.name,
          optStr(b, 'category') ?? t.category,
          b.workTypeId === null ? null : (optNum(b, 'workTypeId') ?? t.work_type_id),
          optStr(b, 'positionCode') ?? t.position_code,
          optStr(b, 'description') ?? t.description,
          optStr(b, 'docNo') ?? t.doc_no,
          optStr(b, 'usageNote') ?? t.usage_note,
          id,
        ],
      );
      return ok(reply, { id });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 归档模板。
   *
   * 归档只写 `archived_at`，而列表查询按 `archived_at IS NULL` 过滤 ——
   * 于是模板从界面上消失，文件和它的 `.vars.json` **却永远留在 `_模板库` 里**：
   * 用户既看不到、也没有入口删，磁盘上就这么越堆越多（审计时实测堆了 9 个）。
   * 现在归档时把两份文件一起挪进 `_归档模板/`，回收站式管理：
   * 文件还在（可手工取回），模板库目录保持干净。
   */
  app.delete('/api/templates/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const t = getTemplate(id);
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const moved = archiveTemplateFiles(t);
      return ok(reply, { archived: true, movedFiles: moved });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/templates/:id/unarchive',async(req,reply)=>{
   try{
    const t=getTemplate(intParam(req,'id'));if(!t)throw new ApiError('NOT_FOUND','模板不存在',404);
    /**
     * 取消归档要把文件搬回模板库。
     * 以前这里只把 archived_at 置空，文件还留在 `_归档模板/<id>/` —— 记录看得见、文件不在模板库，
     * 「还原了却打不开」；而且文件缺失时直接抛 410，历史归档模板永远取消不了。
     * 现在：能搬就搬（并更新 file_rel / vars_rel），搬不回来只记日志、照常取消归档。
     */
    const movedFiles=restoreArchivedTemplateFiles(t);
    run('UPDATE template SET archived_at=NULL WHERE id=?',[t.id]);
    /**
     * 归档期间文件可能被换过/丢过，恢复后重新判定一次健康状态。
     * 这里只是刷新标记，不阻断恢复（坏文件同样要能恢复出来、能重新上传）。
     */
    const fresh=getTemplate(t.id);
    const health=fresh?refreshTemplateHealth(fresh):null;
    return ok(reply,{restored:true,movedFiles,health});
   }catch(e){return fail(reply,e);}
  });
  /** 彻底删除（连文件一起） */
  app.delete('/api/templates/:id/permanent', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const t = getTemplate(id);
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const used = pluck1<number>('SELECT COUNT(*) FROM generation_log WHERE template_id = ?', [id]) ?? 0;
      if (used > 0) throw new ApiError('IN_USE', `这个模板已经生成过 ${used} 次文件，为保证可追溯不建议删除。可以先归档。`);
      try {
        const abs = templateAbsPath(t);
        if (existsSync(abs)) rmSync(abs, { force: true });
        const vp = varsAbsPath(t);
        if (vp && existsSync(vp)) rmSync(vp, { force: true });
      } catch(e) {throw new ApiError('FILE_BUSY','文件删除失败，记录已保留：'+(e as Error).message);}
      run('DELETE FROM material_check WHERE template_id = ?', [id]);
      run('DELETE FROM template WHERE id = ?', [id]);
      return ok(reply, { deleted: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 登记一份"外部已有模板"：把数据目录外/内的文件复制进模板库 */
  app.post('/api/templates/register-local', async (req, reply) => {
    try {
      const b = body(req);
      const src = requireStr(b, 'sourcePath', '源文件路径');
      if (!existsSync(src)) throw new ApiError('NOT_FOUND', `文件不存在：${src}`);
      const t = registerTemplate({
        absSourcePath: src,
        originalFileName: basename(src),
        name: optStr(b, 'name'),
        category: optStr(b, 'category') ?? 'general',
        workTypeId: optNum(b, 'workTypeId') ?? null,
        positionCode: optStr(b, 'positionCode') ?? null,
        description: optStr(b, 'description'),
      });
      return ok(reply, { template: t }, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 下载模板文件（查看原件用） */
  app.get('/api/templates/:id/file', async (req, reply) => {
    try {
      const t = getTemplate(intParam(req, 'id'));
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const abs = templateAbsPath(t);
      if (!existsSync(abs)) throw new ApiError('FILE_MISSING', `模板文件已丢失：${t.file_rel}`, 410);
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(t.name + (t.file_format === 'xlsx' ? '.xlsx' : '.docx'))}`);
      reply.type('application/octet-stream');
      const { createReadStream } = await import('node:fs');
      return reply.send(createReadStream(abs));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 把模板复制一份到指定目录（做备份/分享用） */
  app.post('/api/templates/:id/export', async (req, reply) => {
    try {
      const t = getTemplate(intParam(req, 'id'));
      if (!t) throw new ApiError('NOT_FOUND', '模板不存在', 404);
      const b = body(req);
      const targetDir = optStr(b, 'targetDir');
      if (!targetDir) throw new ApiError('MISSING_FIELD', '需要 targetDir');
      /**
       * 先检查两边，再复制。
       * 以前直接 copyFileSync：源模板丢失或目标目录不存在时抛的是原始 ENOENT，
       * 既没有状态码（前端只能看到 500「服务出错了」），消息里还带着绝对路径。
       */
      if (!existsSync(templateAbsPath(t))) throw new ApiError('FILE_MISSING', '模板文件已丢失，请先从备份找回', 410);
      if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
        throw new ApiError('BAD_FIELD', `目标目录不存在或不是文件夹：${targetDir}`, 400);
      }
      const fileName = `${safeName(t.name)}_${stamp()}.${t.file_format}`;
      copyFileSync(templateAbsPath(t), join(targetDir, fileName));
      return ok(reply, { exported: join(targetDir, fileName) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 模板库目录信息 */
  app.get('/api/templates/meta/info', async (_req, reply) =>
    ok(reply, {
      dir: toPosix(join(DATA_ROOT, DIRS.templates)),
      formats: ['docx', 'xlsx', 'pdf', 'jpg', 'png'],
      placeholderSyntax: '{变量名}',
      note: '把 Word/Excel 模板里的固定内容换成 {变量名}，上传后系统会自动扫描出变量清单。',
      hint: detectFormat('a.docx'),
    }),
  );
}
