import {rejectLegacyConfigWrite} from '../domain/workflow-config.ts';
import {realpathSync,createReadStream} from 'node:fs';
import {isAbsolute,relative,resolve} from 'node:path';
import {isPlatformProtected} from '../core/paths.ts';
/** 工作台、阶段、清单、流程规范接口 */
import type { FastifyInstance } from 'fastify';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { get, run, tx } from '../db/index.ts';
import {
  getWorkType,
  archiveWorkbench,
  unarchiveWorkbench,
  bindExternalRoot,
  unbindExternalRoot,
  getBoundFolderInfo,
  completeWorkbench,
  createWorkbench,
  deleteWorkbench,
  deleteRule,
  getWorkbench,
  getWorkbenchDetail,
  instantiatePositions,
  getPosition,
  getBoundTemplateIds,
  listBoundRoots,
  listDueWork,
  listPositions,
  listPositionDocTemplates,
  setPositionDocTemplates,
  listWorkbenchPositionDocs,
  listTemplatesForWorkbench,
  listWorkbenches,
  nextWorkbenchCode,
  recalcProgress,
  reloadBoundRoots,
  scanWorkbenchFolder,
  setBoundTemplateIds,
  setPositionFolderName,
  setPositionPeriodDir,
  setWorkbenchOutputMode,
  setPositionStatus,
  updateChecklistItem,
  updateWorkbench,
  upsertEvidence,
  upsertMaterial,
  upsertPosition,
  listWorkTypes,
} from '../domain/service.ts';
import { getBoundRoots, isInsideRoot } from '../core/paths.ts';
import { liveFilter, purgeFromTrash } from '../core/trash.ts';
import { ApiError, body, fail, intParam, ok, optBool, optNum, optStr, q, qBool, qInt, requireStr, strArray } from './reply.ts';

export function registerWorkRoutes(app: FastifyInstance): void {
  function referencePath(id:number,path:string) {
    const w=getWorkbench(id);if(!w || w.deleted_at || !w.reference_root)throw new ApiError('NO_REFERENCE','尚未设置参考目录',404);
    const root=realpathSync(w.reference_root),candidate=resolve(root,path);
    const requested=relative(root,candidate);
    if(requested.startsWith('..')||isAbsolute(requested))throw new ApiError('BAD_PATH','不能访问参考目录之外的文件',403);
    if(!existsSync(candidate))throw new ApiError('FILE_MISSING','参考文件已不存在',404);
    const target=realpathSync(candidate);
    const rel=relative(root,target);if(rel.startsWith('..')||isAbsolute(rel))throw new ApiError('BAD_PATH','不能访问参考目录之外的文件',403);
    return {root,target};
  }
  app.put('/api/workbenches/:id/reference-folder',async(req,reply)=>{try{
    const id=intParam(req,'id'),w=getWorkbench(id),b=body(req);if(!w||w.deleted_at)throw new ApiError('NOT_FOUND','工作不存在',404);
    let root:string|null=null;
    if(b.path){if(typeof b.path!=='string'||!isAbsolute(b.path))throw new ApiError('BAD_PATH','请填写绝对目录路径');root=realpathSync(b.path);if(!statSync(root).isDirectory()||isPlatformProtected(root))throw new ApiError('BAD_PATH','请选择业务资料目录');}
    run('UPDATE workbench SET reference_root=? WHERE id=?',[root,id]);return ok(reply,{root});
  }catch(e){return fail(reply,e);}});
  app.get('/api/workbenches/:id/reference-folder',async(req,reply)=>{try{
    const id=intParam(req,'id'),w=getWorkbench(id);if(!w||w.deleted_at)throw new ApiError('NOT_FOUND','工作不存在',404);
    if(!w.reference_root)return ok(reply,{root:null,items:[]});
    const {root,target}=referencePath(id,(req.query as {path?:string}).path??'');
    const items=readdirSync(target,{withFileTypes:true}).filter(f=>!f.isSymbolicLink()).slice(0,500).map(f=>({name:f.name,path:relative(root,resolve(target,f.name)).replaceAll('\\','/'),directory:f.isDirectory()}));
    return ok(reply,{root,items});
  }catch(e){return fail(reply,e);}});
  app.get('/api/workbenches/:id/reference-file',async(req,reply)=>{try{
    const {target}=referencePath(intParam(req,'id'),(req.query as {path?:string}).path??'');
    if(!statSync(target).isFile())throw new ApiError('BAD_PATH','请选择文件');
    return reply.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(basename(target))}`).send(createReadStream(target));
  }catch(e){return fail(reply,e);}});

  /* ------------------------------ 工作台 ------------------------------ */

  // 导航角标只统计未结束的工作，不受列表分页与提醒日期影响。
  app.get('/api/workbenches/count', async (_req, reply) =>
    ok(reply, get<{ total: number; project: number; admin: number }>(
      `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN t.domain='project' THEN 1 ELSE 0 END),0) AS project,
       COALESCE(SUM(CASE WHEN t.domain='project' THEN 0 ELSE 1 END),0) AS admin
       FROM workbench w LEFT JOIN work_type t ON t.id=w.work_type_id
       WHERE w.archived_at IS NULL AND w.status IN ('active','paused') AND ${liveFilter('workbench', 'w')}`,
    ) ?? { total: 0, project: 0, admin: 0 }),
  );

  app.get('/api/workbenches', async (req, reply) =>
    ok(reply, {
      items: listWorkbenches({
        workTypeId: qInt(req, 'workTypeId'),
        status: q(req, 'status'),
        keyword: q(req, 'keyword'),
        limit: qInt(req, 'limit'), offset: qInt(req,'offset'), archived:qBool(req,'archived'),
      }),
    }),
  );

  /** 新建工作台时给界面用的建议编号 */
  app.get('/api/workbenches/next-code', async (req, reply) => {
    try {
      const workTypeId = qInt(req, 'workTypeId');
      if (!workTypeId) throw new ApiError('MISSING_FIELD', '需要 workTypeId');
      const wt = listWorkTypes().find((t) => t.id === workTypeId);
      if (!wt) throw new ApiError('NOT_FOUND', '工作类型不存在', 404);
      return ok(reply, { code: nextWorkbenchCode(wt) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 首页用：需要处理的工作。
   * 分三档 —— 逾期 / 即将到期（周期性工作）/ 进行中（项目工作）。
   */
  app.get('/api/workbenches/due', async (_req, reply) => {
    try {
      const r = listDueWork();
      return ok(reply, {
        overdue: r.overdue,
        dueSoon: r.dueSoon,
        active: r.active,
        counts: { overdue: r.overdue.length, dueSoon: r.dueSoon.length, active: r.active.length },
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/workbenches', async (req, reply) => {
    try {
      const b = body(req);
      /**
       * 先确认工作类型存在，再创建。
       * 否则 createWorkbench 会抛一个普通 Error（领域层不认 HTTP 状态码），
       * 最终变成 500 INTERNAL —— 用户看到"服务出错了"，其实是选了个不存在的工作类型。
       * 同一个文件里的 next-code 接口对同样的情况返回的是 404，这里保持一致。
       */
      const workTypeId = optNum(b, 'workTypeId') ?? 0;
      if (!getWorkType(workTypeId)) throw new ApiError('NOT_FOUND', `工作类型不存在：#${workTypeId}`, 404);
      const wb = createWorkbench({
        instantiatePositions: b.instantiatePositions===false?false:undefined,
        publishedConfigId: optNum(b,'publishedConfigId'),
        navigationGroup: optStr(b,'navigationGroup'), domain: optStr(b,'domain'),
        periodRule: b.periodRule && typeof b.periodRule==='object' && !Array.isArray(b.periodRule) ? b.periodRule as Record<string,unknown>:undefined,
        historical: b.historical===true, actualEndDate: optStr(b,'actualEndDate'), firstPeriod: optStr(b,'firstPeriod'),
        name: requireStr(b, 'name', '名称'),
        workTypeId,
        code: optStr(b, 'code'),
        owner: optStr(b, 'owner'),
        counterpart: optStr(b, 'counterpart'),
        contractNo: optStr(b, 'contractNo'),
        contractAmount: optNum(b, 'contractAmount'),
        startDate: optStr(b, 'startDate'),
        planEndDate: optStr(b, 'planEndDate'),
        summary: optStr(b, 'summary'),
        tags: strArray(b, 'tags'),
        profile: (b.profile && typeof b.profile === 'object' ? (b.profile as Record<string, unknown>) : undefined),
        recurrence: optStr(b, 'recurrence'),
        recurDay: optNum(b, 'recurDay') ?? null,
        recurMonth: optNum(b, 'recurMonth') ?? null,
        remindDays: optNum(b, 'remindDays') ?? null,
        templateIds: Array.isArray(b.templateIds) ? (b.templateIds as unknown[]).map(Number).filter(Number.isFinite) : undefined,
      });
      return ok(reply, wb, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 这份工作「出文书」时该显示哪些模板。
   * 绑定过就只给绑定的，没绑定则回退到该工作类型的全部模板。
   */
  app.get('/api/workbenches/:id/templates', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getWorkbench(id)) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      return ok(reply, {
        items: listTemplatesForWorkbench(id),
        boundIds: getBoundTemplateIds(id),
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 更新这份工作绑定的模板（空数组 = 取消绑定，走该类型的全部模板） */
  app.put('/api/workbenches/:id/templates', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getWorkbench(id)) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      const b = body(req);
      const ids = Array.isArray(b.templateIds) ? (b.templateIds as unknown[]).map(Number).filter(Number.isFinite) : [];
      const saved = setBoundTemplateIds(id, ids, Array.isArray(b.requiredIds)?b.requiredIds.map(Number):ids);
      return ok(reply, { templateIds: saved, items: listTemplatesForWorkbench(id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/workbenches/:id', async (req, reply) => {
    try {
      const detail = getWorkbenchDetail(intParam(req, 'id'), false);
      if (!detail) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      return ok(reply, detail);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/api/workbenches/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const b = body(req);
      if (!getWorkbench(id)) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      /**
       * 文本字段要能「显式清空」。
       * optStr 把 null 当成"没传"，于是「把负责人清掉」这种要求根本做不到 ——
       * AI 助手改错了想撤回、或者负责人换人后要留空，都卡在这里。
       * 传 null 或空串 = 清空；完全不传 = 不动。
       */
      const text = (key: string): string | null | undefined => {
        if (!(key in b)) return undefined;
        const v = b[key];
        if (v === null) return null;
        return String(v);
      };
      /** 数值字段同理：不传就是不动，传 null 才是清空 */
      const num = (key: string): number | null | undefined => {
        if (!(key in b)) return undefined;
        const v = b[key];
        if (v === null || v === '') return null;
        const n = Number(v);
        if(!Number.isFinite(n))throw new ApiError('BAD_FIELD',`${key} 必须是数字`);
        return n;
      };
      updateWorkbench(id, {
        name: optStr(b, 'name'),
        status: optStr(b, 'status'),
        priority: optStr(b, 'priority'),
        owner: text('owner'),
        counterpart: text('counterpart'),
        contract_no: text('contractNo'),
        // 注意不能写 `?? null`：那会把"没传"变成"清空"，
        // 「只改负责人」的请求就会顺手抹掉金额、起止日期和备注（实测复现过）
        contract_amount: num('contractAmount'),
        start_date: text('startDate'),
        plan_end_date: text('planEndDate'),
        actual_end_date: text('actualEndDate'),
        summary: text('summary'),
        business_content: text('businessContent')??undefined,
        tags: strArray(b, 'tags') ? JSON.stringify(strArray(b, 'tags')) : undefined,
        profile: b.profile && typeof b.profile === 'object' ? JSON.stringify(b.profile) : undefined,
      });
      return ok(reply, getWorkbenchDetail(id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/workbenches/:id/archive', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      // 先在路由层确认存在：领域层抛的是普通 Error，落到全局处理器就是 500，
      // 而"这个工作台不存在"应该是 404 —— 其他接口都是这么做的。
      if (!getWorkbench(id)) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      // 加个 undo：归档之后要能收回来。以前只能归档不能取消，误点就没救了。
      const undo = qBool(req, 'undo') === true;
      if (undo) unarchiveWorkbench(id);
      else archiveWorkbench(id);
      return ok(reply, { archived: !undo });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 完成这份工作。
   * 单次工作 → 状态置 done，结束；周期性工作 → 记下本期完成时间并算下一期，工作继续留着。
   */
  app.post('/api/workbenches/:id/complete', async (req, reply) => {
    try {
      const r = completeWorkbench(intParam(req, 'id'));
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 把这份工作**移到回收站**（默认），或**彻底删除**（`?purge=1`）。
   *
   * 改造前这个接口带不带 `withFile` 都是"真删"：库记录清空 + 磁盘文件/目录清掉，删错了没退路。
   * 现在两条路分开、且都要求用户明确表达意图：
   *   · 不带 `purge`     → `deleteWorkbench()`：**软删除**。工作台、阶段实例、文件记录一起进回收站，
   *     磁盘一个字节都不动。可在「回收站」页恢复（原样回来）或彻底删除。
   *   · `?purge=1`       → `purgeFromTrash('workbench', id)`：**彻底删除**，不可恢复。
   *     要求这份工作**已经在回收站里**（先软删一次），否则 400 明确拒绝 ——
   *     不允许一个请求同时越过"确认"和"再确认"两道门槛：
   *       磁盘上只删**平台登记过的文件**；绑定型工作台绝不 `rmSync` 绑定根，
   *       只回收平台自己建的空目录（用户自己的文件和非空文件夹一个都不碰）。
   * 返回里 `files` / `filesRemoved` / `dirsRecycled` 如实报告动了多少磁盘。
   */
  app.delete('/api/workbenches/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      // 先在路由层确认存在：领域层抛的是普通 Error，裸抛会被 fail() 兜成 500，
      // 而"这个工作台不存在"应该是 404 —— 本文件里其它接口都是这么做的。
      if (!getWorkbench(id)) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      const purge = qBool(req, 'purge') === true;

      if (purge) {
        /**
         * `withFile` 保留给"彻底删除时是否连磁盘文件一起删"：缺省 = 删（彻底删除的语义），
         * `withFile=0` = 只清库记录、磁盘文件留着（排障/换盘时用得上）。
         */
        const asked = qBool(req, 'withFile');
        const withFile = asked === undefined ? true : asked;
        let r;
        try {
          r = purgeFromTrash('workbench', id, { withFile });
        } catch (e) {
          throw e instanceof ApiError ? e : new ApiError('BAD_REQUEST', e instanceof Error ? e.message : String(e), 400);
        }
        return ok(reply, {
          deleted: true,
          purged: true,
          filesRemoved: r.filesRemoved,
          withFile,
          message: withFile
            ? `已彻底删除这份工作及其平台登记的文件（共删掉 ${r.filesRemoved} 个磁盘文件）—— 不可恢复`
            : '已彻底删除这份工作的平台记录（磁盘文件保留）—— 不可恢复',
        });
      }

      /**
       * 软删除分支：**有意不看 `withFile`**（语义见上面的说明）。
       * `withFile` 只在 `?purge=1` 的彻底删除里成立 —— "连磁盘文件一起删"这一步发生在回收站里
       * （那里有二次确认，且请求必须已经指向一条软删除过的记录）。
       * 软删除请求即使带上 `withFile=1` 也不会有任何磁盘动作，所以界面**不再提供**这个选项：
       * `packages/web/src/pages/Workbench.tsx` 的删除弹窗现在是单一动作「移到回收站」，
       * 只拼不带 `purge` / 不带 `withFile` 的 URL，并指路到「回收站」页做彻底删除。
       */
      const r = deleteWorkbench(id);
      /**
       * 拆开 `trashed`：领域层返回的 `trashed` 是**各项计数**（`{workbench, positions, artifacts, checklist}`），
       * 而外层的 `trashed: true` 想表达的是"这次调用是软删除、不是彻底删除"。
       * 两者同名会互相覆盖（TS 直接报错、运行时丢掉计数），所以计数放在 `trashedDetail` 里，
       * 原来那个布尔标记保持原样（界面/脚本已经在读它）。
       */
      const { trashed, ...rest } = r;
      return ok(reply, { ...rest, trashed: true, trashedDetail: trashed });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/workbenches/:id/instantiate', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const created = instantiatePositions(id);
      return ok(reply, { created });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/workbenches/:id/recalc', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getWorkbench(id) || getWorkbench(id)?.deleted_at) throw new ApiError('NOT_FOUND', '工作台不存在或已删除', 404);
      return ok(reply, { progress: recalcProgress(id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 工作台目录里的实际文件（含手工放进去的） */
  app.get('/api/workbenches/:id/folder', async (req, reply) => {
    try {
      return ok(reply, { items: scanWorkbenchFolder(intParam(req, 'id')) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* --------------------------- 目录绑定（契约 §8） --------------------------- */

  /**
   * 领域层抛的是普通 Error（绑定目录不存在、期次格式非法…），那是**用户输入不合法**，
   * 不是服务故障。裸抛出去会被 fail() 兜成 500 INTERNAL，界面只能说"服务出错了"，
   * 把用户真正要看的那句中文丢掉。这里统一转成 400 + 原文，界面原样展示即可。
   */
  const domain400 = (e: unknown): ApiError =>
    e instanceof ApiError ? e : new ApiError('BAD_REQUEST', e instanceof Error ? e.message : String(e), 400);

  /** 排除规则：点开头目录 + tmp/output/node_modules（契约 §7.6） */
  const SKIP_DIR_NAMES = new Set(['tmp', 'output', 'node_modules', '$recycle.bin', 'system volume information']);
  const skipEntry = (name: string): boolean => name.startsWith('.') || SKIP_DIR_NAMES.has(name.toLowerCase());

  /** 数一个目录里有多少文件（递归，带上限 —— 界面只需要一个量级，不需要精确到个位时卡住） */
  function countFilesRecursive(dir: string, cap = 5000): { files: number; capped: boolean } {
    let files = 0;
    const walk = (d: string, depth: number): void => {
      if (depth > 12 || files >= cap) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const name of entries) {
        if (files >= cap) return;
        if (skipEntry(name)) continue;
        let s;
        try {
          s = statSync(join(d, name));
        } catch {
          continue;
        }
        if (s.isDirectory()) walk(join(d, name), depth + 1);
        else files += 1;
      }
    };
    walk(dir, 0);
    return { files, capped: files >= cap };
  }

  /**
   * 列某个目录下的**一层**子目录 —— 给「阶段目录选择」用（用户在已有文件夹里挑，不手打）。
   * 只允许列已注册的允许根（DATA_ROOT 或某个已绑定的资料目录）内部的目录：
   * 这个接口会读磁盘，不能让它变成"任意路径探测"的入口。
   */
  app.get('/api/folders/subdirs', async (req, reply) => {
    try {
      const raw = (q(req, 'path') ?? '').trim();
      if (!raw) throw new ApiError('MISSING_FIELD', '需要 path 参数（要列出的目录绝对路径）');
      const looksAbsolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/');
      if (!looksAbsolute) throw new ApiError('BAD_PARAM', `path 必须是绝对路径：${raw}`);
      const abs = resolvePath(raw);

      let roots: string[] = [];
      try {
        roots = getBoundRoots();
      } catch {
        roots = [];
      }
      if (!roots.length) roots = listBoundRoots();
      /**
       * 必须在某个允许根内部：盘根、桌面、别人电脑上的共享目录一律拒绝。
       * 判据用 isInsideRoot（relative 判断），不用字符串前缀 —— 前缀会把 `D:\data2`
       * 当成 `D:\data` 内部放行。
       */
      if (!roots.some((r) => isInsideRoot(r, abs))) {
        throw new ApiError('FORBIDDEN_PATH', `只能浏览已绑定的资料目录内部：${abs}`, 400);
      }

      if (!existsSync(abs)) throw new ApiError('NOT_FOUND', `目录不存在：${abs}`, 400);
      let st;
      try {
        st = statSync(abs);
      } catch {
        throw new ApiError('NOT_FOUND', `目录无法访问：${abs}`, 400);
      }
      if (!st.isDirectory()) throw new ApiError('BAD_PARAM', `这不是一个文件夹：${abs}`, 400);

      let names: string[] = [];
      try {
        names = readdirSync(abs);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        throw new ApiError('READ_FAILED', `目录读不了：${abs}（${code || '未知错误'}）`, 400);
      }

      const items = names
        .filter((name) => !skipEntry(name))
        .map((name) => {
          const child = join(abs, name);
          let s;
          try {
            s = statSync(child);
          } catch {
            return null;
          }
          if (!s.isDirectory()) return null;
          const counted = countFilesRecursive(child);
          return { name, path: child, hasFiles: counted.files > 0, fileCount: counted.files, countCapped: counted.capped };
        })
        .filter((x): x is { name: string; path: string; hasFiles: boolean; fileCount: number; countCapped: boolean } => x !== null)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));

      return ok(reply, { path: abs, parent: resolvePath(abs, '..'), items });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 绑定资料目录：只写库、刷新允许根，不动任何文件 */
  app.post('/api/workbenches/:id/bind-folder', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const b = body(req);
      const raw = optStr(b, 'path') ?? q(req, 'path');
      if (!raw || !raw.trim()) throw new ApiError('MISSING_FIELD', '需要 path（要绑定的文件夹绝对路径）');
      let r: { externalRoot: string };
      try {
        r = bindExternalRoot(id, raw);
      } catch (e) {
        throw domain400(e);
      }
      return ok(reply, { ...getBoundFolderInfo(id), ...r });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 解绑：只把 external_root 置空，磁盘上的文件一个都不动（契约 §7.2） */
  app.delete('/api/workbenches/:id/bind-folder', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      try {
        unbindExternalRoot(id);
      } catch (e) {
        throw domain400(e);
      }
      return ok(reply, getBoundFolderInfo(id));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 当前绑定信息：路径 + 在不在 + 文件数 */
  app.get('/api/workbenches/:id/bound-folder', async (req, reply) => {
    try {
      let info;
      try {
        info = getBoundFolderInfo(intParam(req, 'id'));
      } catch (e) {
        throw domain400(e);
      }
      /**
       * 目录改名或消失时给一句明确的话（契约 §7.4）：
       * 不能含糊成一个空的文件列表，用户会以为"文件都没了"。
       */
      const missing = Boolean(info.externalRoot) && !info.exists;
      return ok(reply, { ...info, missing, message: missing ? `绑定的目录不在了：${info.externalRoot}` : null });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 输出位置模式（契约 §4）：`inline`（默认，就地）/ `subdir`（平台子目录）/ `custom`（自定义目录）。
   *
   * 取值白名单、`customDir` 的绝对路径与「必须在本工作台根之内」这几层校验**全部**在领域层
   * `setWorkbenchOutputMode` 里，这里一个都不重写 —— 只有一处真相，界面/助手/脚本走同一条路。
   * 路由层只补两件它管得着的事：
   *   ① 工作台不存在要 404（领域层抛的是普通 Error，裸抛会被 fail() 兜成 500，用户看到"服务出错了"）；
   *   ② 领域层的输入校验错误经 domain400 转成 400 + 中文原文，界面原样展示。
   */
  app.put('/api/workbenches/:id/output-mode', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getWorkbench(id)) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      const b = body(req);
      /**
       * mode 不在这里判白名单，也不给默认值：漏传/写错都让领域层抛那句
       * 「输出位置模式只能是 inline（就地）/ subdir（平台子目录）/ custom（自定义目录）：<值>」，
       * 用户一眼看到合法取值。路由自己猜一个默认值反而会把写错的值悄悄改掉。
       */
      const mode = optStr(b, 'mode') ?? '';
      /**
       * customDir 的**三态**语义（与领域层一致，别压成两态）：
       * 不传 = 保留原来的自定义目录（在 inline/subdir/custom 之间来回切不会冲掉已填的路径）；
       * 传 null 或空串 = 清空；传值 = 改成它（仍然要过"在本工作台根之内"那关）。
       */
      const customDir = 'customDir' in b ? (b.customDir === null ? null : String(b.customDir)) : undefined;
      let r: { outputMode: string; customOutputDir: string | null };
      try {
        r = setWorkbenchOutputMode(id, mode, customDir);
      } catch (e) {
        throw domain400(e);
      }
      return ok(reply, { output_mode: r.outputMode, custom_output_dir: r.customOutputDir });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ------------------------------ 阶段与清单 ------------------------------ */

  app.put('/api/positions/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const b = body(req);
      /**
       * periodDir 的入口在这里（界面上「阶段 → 按期次分目录」就在工作台详情里），
       * 但规则本身挂在阶段模板上：同一个工作类型的所有工作台共用一套流程规范。
       * 传 null / '' = 关掉期次分目录；不传 = 不动。
       */
      if ('periodDir' in b) {
        try {
          setPositionPeriodDir(id, b.periodDir === null ? null : String(b.periodDir));
        } catch (e) {
          throw domain400(e);
        }
      }
      /**
       * folderName 的入口也在这里（工作台详情里「阶段 → 目录名」）。
       * 目录名同样挂在阶段模板上（一个阶段一个目录，见契约 §10）：
       *   · 传了名字 → 更新模板的 folder_name（同名模板的**所有**工作台一起生效，
       *     所以把 affectedWorkbenches 带回去，界面上要能提示"这条规范被 N 个工作台共用"）；
       *   · 传 null / '' → 清掉自定义目录名，回退到按阶段名自动生成；不传 = 不动。
       * 改不了（阶段没有对应模板、名字非法）就**明确 400 报错**并说明该去哪改 ——
       * 以前这个字段被静默丢掉，用户以为改了目录名、文件其实落到别处（验收问题②）。
       */
      let folderPatch: { folderName: string | null; affectedWorkbenches: number } | null = null;
      if ('folderName' in b) {
        try {
          folderPatch = setPositionFolderName(id, b.folderName === null ? null : String(b.folderName));
        } catch (e) {
          throw domain400(e);
        }
      }
      const status = optStr(b, 'status');
      if (status) setPositionStatus(id, status, { note: optStr(b, 'note'), owner: optStr(b, 'owner') });
      else if (optStr(b, 'note') !== undefined || optStr(b, 'owner') !== undefined) {
        run(
          `UPDATE position_instance SET note = COALESCE(?, note), owner = COALESCE(?, owner),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
          [optStr(b, 'note') ?? null, optStr(b, 'owner') ?? null, id],
        );
      }
      return ok(reply, folderPatch ? { ok: true, ...folderPatch } : { ok: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/api/checklist/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const b = body(req);
      updateChecklistItem(id, {
        status: optStr(b, 'status'),
        done_count: optNum(b, 'doneCount'),
        note: optStr(b, 'note'),
        done_by: optStr(b, 'doneBy'),
      });
      return ok(reply, { ok: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ------------------------------ 流程规范（阶段模板） ------------------------------ */

  app.get('/api/position-templates', async (req, reply) => {
    try {
      const workTypeId = qInt(req, 'workTypeId');
      if (!workTypeId) throw new ApiError('MISSING_FIELD', '需要 workTypeId');
      return ok(reply, { items: listPositions(workTypeId) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/position-templates', async (_req, reply) => {
    try { rejectLegacyConfigWrite(); } catch (e) { return fail(reply,e); }
  });

  app.put('/api/position-templates/:id', async (_req, reply) => {
    try { rejectLegacyConfigWrite(); } catch (e) { return fail(reply,e); }
  });

  app.delete('/api/position-templates/:id', async (_req, reply) => {
    try { rejectLegacyConfigWrite(); } catch (e) { return fail(reply,e); }
  });

  /* --------------------- 阶段↔文书模板绑定（B2-7，迁移 018） --------------------- */

  /**
   * 领域层在保存阶段模板绑定时抛的是普通 Error（模板不存在 / 已归档 / 坏模板 / 不属于
   * 这个工作类型），那是**用户选错了**，不是服务故障。
   *
   * 裸抛出去走 `fail()` 的 native 分支要看 `statusCode`，普通 Error 没有它 —— 结果是
   * `400` 状态码配 `code: "INTERNAL"`（实测复现），界面只能把 `INTERNAL` 当系统错误，
   * 用户真正要看的那句中文就降级了。这里统一转成 `400 + BAD_TEMPLATE_BINDING + 中文原文`；
   * 已经是 ApiError 的原样放行（404 / 400 各自的意思不要被抹平）。
   */
  const binding400 = (e: unknown): ApiError =>
    e instanceof ApiError ? e : new ApiError('BAD_TEMPLATE_BINDING', e instanceof Error ? e.message : String(e), 400);

  /**
   * 这个阶段该用哪几个模板出文书：**已绑 + 候选**。
   *
   * 候选只列该阶段所属**工作类型**的模板（`work_type_id = 该类型 OR IS NULL`），
   * 与「出文书」回退时的候选集逐条一致 —— 界面在这里选的就是之后能用的那些。
   * 每个候选都带 `health_ok / health_note / bindable / unbindableReason`：
   * 坏模板（health_ok=0）在界面**置灰并给出原因**，且服务端在 PUT 时也会拦一道。
   */
  app.get('/api/position-templates/:id/templates', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const r = listPositionDocTemplates(id);
      if (!r.position) throw new ApiError('NOT_FOUND', '阶段不存在', 404);
      return ok(reply, { position: r.position, items: r.bound, boundIds: r.bound.map((b) => b.templateId), candidates: r.candidates });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 保存这个阶段绑定的文书模板 —— **整表替换**，传进来的就是要的最终状态。
   *
   * `{items:[{templateId,required,seq,note}]}`；空数组 = 绑定清零，展示回到
   * 「该类型全部模板」（与改造前完全一致，不报错）。
   * 校验不过 → 400 + 人话原因（模板不存在/已归档/坏模板/不属于该工作类型），不静默丢弃。
   */
  app.put('/api/position-templates/:id/templates', async (_req, reply) => {
    try { rejectLegacyConfigWrite(); } catch (e) { return fail(reply,e); }
  });

  /**
   * 这份工作台**每个阶段该出哪些文书、已出几份**（B2-7）。
   *
   * 优先级在领域层定死：阶段绑定 > 工作台绑定 > 工作类型全部；每行都带 `source`
   * 说明这份清单是从哪一层来的 —— 界面据此把"为什么是这几个"讲清楚，不让用户猜。
   */
  app.get('/api/workbenches/:id/position-docs', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      if (!getWorkbench(id)) throw new ApiError('NOT_FOUND', '工作台不存在', 404);
      const r = listWorkbenchPositionDocs(id);
      const rows = r.items;
      /** 逐阶段总口径（含回退到"工作类型全部模板"的阶段）——与 `items` 逐条对得上 */
      const sum = (list: typeof rows) => ({
        total: list.reduce((s, d) => s + d.total, 0),
        done: list.reduce((s, d) => s + d.done, 0),
        requiredTotal: list.reduce((s, d) => s + d.requiredTotal, 0),
        requiredDone: list.reduce((s, d) => s + d.requiredDone, 0),
        shortfall: list.reduce((s, d) => s + d.shortfall, 0),
      });
      return ok(reply, {
        workbench: r.workbench,
        items: rows,
        /** 全部阶段相加（含回退层）——数字可能很大，因为回退层是"该类型的全部模板" */
        stats: sum(rows),
        /**
         * 「应出文书」的**可信**口径：只统计阶段绑定那一层（`source === 'position'`）。
         * 一份都没绑过时为 `null` —— 界面据此不显示这一项，而不是显示「0/912」。
         * 与 `getWorkbenchDetail().docStats` 同一口径（同一个 filter）。
         */
        boundStats: rows.some((d) => d.source === 'position') ? sum(rows.filter((d) => d.source === 'position')) : null,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ------------------------------ 材料 / 影像规则 ------------------------------ */

  app.post('/api/materials', async (_req, reply) => {
    try { rejectLegacyConfigWrite(); } catch (e) { return fail(reply,e); }
  });

  app.post('/api/evidences', async (_req, reply) => {
    try { rejectLegacyConfigWrite(); } catch (e) { return fail(reply,e); }
  });

  app.delete('/api/rules/:kind/:id', async (_req, reply) => {
    try { rejectLegacyConfigWrite(); } catch (e) { return fail(reply,e); }
  });
}

/**
 * 【已移除】`deleteWorkbenchRecords()`
 *
 * 它原本是 `DELETE /api/workbenches/:id` 不带 `withFile` 时走的"只删库记录"分支 ——
 * 在路由层照抄一遍领域层的清理 SQL。软删除上线后这条路没必要了，而且**有害**：
 * 它仍然 `DELETE` 真删记录，绕过回收站，删错了没退路。
 * 现在两种意图都由领域层统一表达：
 *   · 移到回收站 → `domain/service.ts` 的 `deleteWorkbench()`（写 `deleted_at`，磁盘不动）
 *   · 彻底删除   → `core/trash.ts` 的 `purgeFromTrash('workbench', id)`
 * 于是"删记录"的 SQL 只有一处，不会再出现两条路删出来的库状态不一致的问题。
 */
