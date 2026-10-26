import {loadedBuild} from '../core/build-identity.ts';
/** 系统与配置相关接口 */
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { all, get, run } from '../db/index.ts';
import { DATA_ROOT, DIRS, DEFAULT_SETTINGS, WEB_DIST, listSettings, markWorkTypeDeleted, setSetting, unmarkWorkTypeDeleted } from '../core/config.ts';
import { getBoundRoots, isInsideRoot } from '../core/paths.ts';
import { PURPOSES, getProfile, listProfiles, listProviders, maskProvider } from '../ai/providers.ts';
import { aiReadiness } from '../ai/gateway.ts';
import { body, fail, ok, optStr, q, requireStr, ApiError } from './reply.ts';
import { getDbPath } from '../db/index.ts';
import { getWorkType, listBoundRoots, listPositions, listWorkTypes, reloadBoundRoots, upsertWorkType } from '../domain/service.ts';
import { liveFilter } from '../core/trash.ts';
import {
  BackupFailure,
  backupOverview,
  createBackup,
  deleteBackup,
  isRestoring,
  restoreBackup,
  trackWriteEnd,
  trackWriteStart,
  verifyAllBackups,
  verifyBackupByName,
} from '../core/backup.ts';

/**
 * core 层的 BackupFailure → 接口层的 ApiError。
 * 分层是单向的：core 不认识 HTTP，错误码在这里翻译成状态码。
 */
function asApiError(e: unknown): unknown {
  if (e instanceof BackupFailure) return new ApiError(e.code, e.message, e.status);
  return e;
}

export function registerCoreRoutes(app: FastifyInstance): void {
  /**
   * 恢复期间的写闸门（见 core/backup.ts 的"停写"一节）。
   *
   * 恢复要把 workbench.db 整个换掉：换的过程中任何写请求都可能写进"已经被替换掉的文件句柄"
   * 或者在关库瞬间拿到 "数据库尚未初始化"。所以恢复期间对**所有**非 GET 的 /api 请求回 503，
   * 前端会看到一句人话而不是 500。已经在跑的写请求记在 inFlight 里，恢复前等它们跑完。
   *
   * 钩子挂在根实例上、在 listen 之前注册，所以对**所有**路由文件（work 模板 生成 归档 文件 AI …）
   * 都生效，不需要每个路由自己判一遍。
   */
  app.addHook('onRequest', async (req, reply) => {
    const method = String(req.method).toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return;
    if (!req.url.startsWith('/api/')) return;
    if (isRestoring()) {
      return reply.code(503).send({
        ok: false,
        error: { code: 'MAINTENANCE', message: '正在从备份恢复数据库，暂时不接受写入请求。恢复只持续几秒，请稍后重试。' },
      });
    }
    trackWriteStart(String(req.id));
  });
  app.addHook('onResponse', async (req) => trackWriteEnd(String(req.id)));
  // 客户端中途断开时 onResponse 可能不触发；不清理会让恢复白等 DRAIN_MS
  app.addHook('onRequestAbort', async (req) => trackWriteEnd(String(req.id)));

  app.get('/api/health', async (_req, reply) =>
    ok(reply, {
      status: 'ok',
        loadedBuild,
      dataRoot: DATA_ROOT,
      dbFile: getDbPath(),
      webBuilt: existsSync(WEB_DIST),
      time: new Date().toISOString(),
    }),
  );

  app.get('/api/system/info', async (_req, reply) =>
    ok(reply, {
      dataRoot: DATA_ROOT,
      dbFile: getDbPath(),
      dirs: DIRS,
      node: process.version,
      platform: process.platform,
      settings: listSettings().map((s) => ({ ...s, value: s.scope === 'secret' ? '******' : s.value })),
      defaults: DEFAULT_SETTINGS,
    }),
  );

  // scope = secret 的配置（如备用 API Key）永不明文返回
  app.get('/api/settings', async (req, reply) =>
    ok(reply, {
      items: listSettings(q(req, 'scope')).map((s) => (s.scope === 'secret' ? { ...s, value: s.value ? '******' : null } : s)),
    }),
  );

  app.put('/api/settings', async (req, reply) => {
    try {
      const b = body(req) as Record<string, unknown>;
      const entries = Object.entries(b);
      if (!entries.length) throw new ApiError('EMPTY', '没有要保存的配置');
      for (const [key, value] of entries) {
        const def = DEFAULT_SETTINGS.find((d) => d.key === key);
        setSetting(key, value, { type: def?.type, label: def?.label, description: def?.description });
      }
      return ok(reply, { saved: entries.length });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/settings/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const row = all<{ value: string | null; scope: string }>('SELECT value, scope FROM app_setting WHERE key = ?', [key])[0];
    return ok(reply, { key, value: row?.scope === 'secret' ? (row.value ? '******' : null) : row?.value ?? null });
  });

  /** 模型接入总览：服务商 + 档案 + 用途说明 */
  app.get('/api/ai/overview', async (_req, reply) =>
    ok(reply, {
      providers: listProviders().map(maskProvider),
      profiles: listProfiles(),
      purposes: PURPOSES,
      ready: Boolean(getProfile('writing')?.provider_id),
    }),
  );

  /** 调用与用量日志 */
  app.get('/api/ai/logs', async (req, reply) => {
    const limit = Math.min(Number(q(req, 'limit') ?? 100) || 100, 500);
    const items = all(
      `SELECT id, purpose, provider_code, model, mode, ok, latency_ms, prompt_tokens, output_tokens, total_tokens,
              error_code, error_message, created_at
         FROM ai_call_log WHERE is_test=0 ORDER BY id DESC LIMIT ?`,
      [limit],
    );
    const summary = all<{ purpose: string; calls: number; ok_calls: number; tokens: number; avg_ms: number }>(
      // 时间比较必须跟写入格式一致：created_at 存的是 ISO（2026-09-21T01:40:47.173Z），
      // 而 datetime('now','-30 days') 产出的是空格分隔格式（2026-08-22 01:55:14）。
      // 'T'(0x54) > ' '(0x20)，字符串比较会把窗口边界算错（实际变成 31 天），
      // 而且函数包着列名，索引用不上。
      `SELECT purpose, COUNT(*) AS calls, SUM(ok) AS ok_calls, SUM(COALESCE(total_tokens,0)) AS tokens, AVG(latency_ms) AS avg_ms
         FROM ai_call_log WHERE is_test=0 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') GROUP BY purpose`,
    );
    return ok(reply, { items, summary });
  });

  app.delete('/api/ai/logs', async (_req, reply) => {
    run('DELETE FROM ai_call_log WHERE is_test=0');
    return ok(reply, { cleared: true });
  });

  /** 生成记录 */
  app.get('/api/generations', async (req, reply) => {
    const limit = Math.min(Number(q(req, 'limit') ?? 100) || 100, 500);
    const workbenchId = q(req, 'workbenchId');
    const items = all(
      `SELECT g.*, t.name AS template_name, w.name AS workbench_name, a.file_rel, a.file_name
         FROM generation_log g
         LEFT JOIN template t ON t.id = g.template_id
         LEFT JOIN workbench w ON w.id = g.workbench_id
         LEFT JOIN artifact a ON a.id = g.artifact_id
        ${workbenchId ? 'WHERE g.workbench_id = ?' : ''}
        ORDER BY g.id DESC LIMIT ?`,
      workbenchId ? [Number(workbenchId), limit] : [limit],
    );
    return ok(reply, { items });
  });

  app.post('/api/settings/test-path', async (req, reply) => {
    try {
      const b = body(req);
      const dir = optStr(b, 'dataRoot') ?? DATA_ROOT;
      const { existsSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(dir, { recursive: true });
      const {randomUUID}=await import('node:crypto');
      const probe = join(dir, '.workbench-write-test-'+randomUUID());
      writeFileSync(probe, 'ok', {encoding:'utf8',flag:'wx'});
      rmSync(probe, { force: true });
      return ok(reply, { ok: true, exists: existsSync(dir), writable: true, path: dir });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/settings/reset-defaults', async (_req, reply) => {
    for (const d of DEFAULT_SETTINGS) {
      setSetting(d.key, d.value, { type: d.type, label: d.label, description: d.description });
    }
    return ok(reply, { reset: DEFAULT_SETTINGS.length });
  });

  /**
   * 在资源管理器里打开一个目录（界面的「在资源管理器中打开」，契约 §8 / §10.5）。
   *
   * 只读：**只起一个 explorer 进程**，不读文件内容、不写任何东西。
   * 三道校验缺一不可 —— 这个接口会把路径交给系统 shell：
   *   ① 必须是绝对路径（相对路径会被 `resolve` 悄悄拼到服务进程的工作目录上）；
   *   ② 必须落在允许根之内（DATA_ROOT 或某个已绑定工作台的 external_root）——
   *      否则它就成了"任意路径探测 + 任意目录弹出"的入口；
   *   ③ 必须存在且是文件夹（explorer 收到文件会去"打开文件"，那是另一种行为）。
   * 非 Windows 直接 400 说明不支持（本平台目前只支持 Windows）。
   */
  app.post('/api/system/open-folder', async (req, reply) => {
    try {
      if (process.platform !== 'win32') {
        throw new ApiError('UNSUPPORTED', '当前系统不是 Windows，暂不支持在资源管理器中打开目录', 400);
      }
      const raw = (optStr(body(req), 'path') ?? q(req, 'path') ?? '').trim();
      if (!raw) throw new ApiError('MISSING_FIELD', '需要 path（要在资源管理器中打开的目录绝对路径）');
      if (!isAbsolute(raw)) throw new ApiError('BAD_PARAM', `path 必须是绝对路径：${raw}`, 400);
      const abs = resolvePath(raw);

      let roots: string[] = [];
      try {
        roots = getBoundRoots();
      } catch {
        roots = [];
      }
      if (!roots.length) roots = listBoundRoots();
      if (!roots.some((r) => isInsideRoot(r, abs))) {
        throw new ApiError('FORBIDDEN_PATH', `只能打开平台数据目录或已绑定资料目录里的文件夹：${abs}`, 400);
      }

      if (!existsSync(abs)) throw new ApiError('NOT_FOUND', `目录不存在：${abs}`, 400);
      let st;
      try {
        st = statSync(abs);
      } catch {
        throw new ApiError('NOT_FOUND', `目录无法访问：${abs}`, 400);
      }
      if (!st.isDirectory()) throw new ApiError('BAD_PARAM', `这不是一个文件夹：${abs}`, 400);

      // 不等待、不接管道：explorer.exe 即使成功也常以退出码 1 结束，等它只会把接口拖慢
      const { spawn } = await import('node:child_process');
      const child = spawn('explorer.exe', [abs], { stdio: 'ignore', detached: true, windowsHide: false });
      // explorer 起不来（被安全软件拦住之类）不能把接口打成 500：用户要的只是"打开一下"
      child.on('error', (e: Error) => console.warn(`[系统] 打开目录失败：${abs}（${e.message}）`));
      child.unref();
      return ok(reply, { opened: true, path: abs });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 工作类型 */
  app.get('/api/work-types', async (req, reply) => ok(reply, { items: listWorkTypes((req.query as {includeArchived?:string}).includeArchived === '1') }));

  app.get('/api/work-types/:id', async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const wt = getWorkType(id);
      if (!wt) throw new ApiError('NOT_FOUND', '工作类型不存在', 404);
      return ok(reply, { workType: wt, positions: listPositions(id) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.post('/api/work-types', async (req, reply) => {
    try {
      const b = body(req);
      const code = requireStr(b, 'code', '编码');
      if(get('SELECT id FROM work_type WHERE code=?',[code])) throw new ApiError('CODE_EXISTS','工作类型编码已存在，请编辑已有类型',409);
      const id = upsertWorkType({
        navigation_group: optStr(b,'navigationGroup') as import('../domain/work-type-navigation.ts').NavigationGroup | undefined,
        code,
        name: requireStr(b, 'name', '名称'),
        mode: optStr(b,'mode')==='document'?'document':'process',
        domain: optStr(b,'domain') as 'admin'|'project'|undefined,
        executor: optStr(b,'executor') as 'general'|'timesheet'|undefined,
        period_defaults: b.periodDefaults ? JSON.stringify(b.periodDefaults) : null,
        category: optStr(b, 'category') ?? '部门综合管理',
        description: optStr(b, 'description'),
        color: optStr(b, 'color'),
        icon: optStr(b, 'icon'),
      });
      // 重新建了同名的，就别再挡着启动自检了
      unmarkWorkTypeDeleted(code);
      return ok(reply, { id }, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/api/work-types/:id', async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      const b = body(req);
      const cur = getWorkType(id);
      if (!cur) throw new ApiError('NOT_FOUND', '工作类型不存在', 404);
      if(b.code!==undefined && b.code!==cur.code)throw new ApiError('IMMUTABLE_CODE','工作类型编码不可修改',409);
      const newId = upsertWorkType({
        navigation_group: optStr(b,'navigationGroup') as import('../domain/work-type-navigation.ts').NavigationGroup | undefined,
        id, mode: optStr(b,'mode')??cur.mode, domain: (optStr(b,'domain')??cur.domain) as 'admin'|'project',
        executor: (optStr(b,'executor')??cur.executor) as 'general'|'timesheet',
        period_defaults: b.periodDefaults===undefined?cur.period_defaults:b.periodDefaults===null?null:JSON.stringify(b.periodDefaults),
        code: cur.code,
        name: optStr(b, 'name') ?? cur.name,
        category: optStr(b, 'category') ?? cur.category,
        description: optStr(b, 'description') ?? cur.description ?? undefined,
        color: optStr(b, 'color') ?? cur.color ?? undefined,
        icon: optStr(b, 'icon') ?? cur.icon ?? undefined,
        sort_order: cur.sort_order,
      });
      return ok(reply, { id: newId });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/work-types/:id', async (req, reply) => {
    try {
      const id = Number((req.params as { id: string }).id);
      // 「还有 N 个工作台在用这个类型，不能删除」数的是**在用**的工作台：
      // 已经移进回收站的那些不算占用（用户已经把它们删了），
      // 否则"删了工作台却还是删不掉类型"。liveFilter 在没跑迁移 015 的老库上自动降级。
      const used =
        all<{ n: number }>(`SELECT COUNT(*) AS n FROM workbench WHERE work_type_id = ? AND ${liveFilter('workbench')}`, [id])[0]?.n ?? 0;
      if (used > 0) throw new ApiError('IN_USE', `还有 ${used} 个工作台在用这个类型，不能删除。可以先归档这些工作台。`);
      const cur = getWorkType(id);
      if (!cur) throw new ApiError('NOT_FOUND', '工作类型不存在', 404);
      run(`UPDATE work_type SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [id]);
      // 预置类型不记下来的话，下次启动自检会把它种回来，等于删不掉
      markWorkTypeDeleted(cur.code);
      return ok(reply, { archived: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 让界面知道当前是否配好了模型 */
  app.get('/api/ai/status', async (_req, reply) => {
    // 用同一个判定逻辑回答「能不能用」，避免这里说就绪、真调用却报服务商被停用
    const writing = aiReadiness('writing');
    const embedding = aiReadiness('embedding');
    return ok(reply, {
      configured: writing.ready,
      provider: writing.provider ?? null,
      model: writing.model ?? null,
      embedding,
      hint: writing.ready
        ? '模型已就绪'
        : `${writing.reason ?? '还没配好模型'}。不配也能用，只是不能自动生成内容。`,
    });
  });

  /* ============================== 备份与恢复 ============================== */
  /**
   * 数据库自动备份 + 一键恢复（实现见 core/backup.ts）。
   *
   * 为什么清单从磁盘目录读、而不是建一张备份表：备份清单要是存在库里，
   * 一旦"恢复到某个旧备份"，比它新的那些备份记录就跟着没了 —— 那正是最需要它们的时候。
   * 所以文件名 + 同名 .json 边车文件就是清单本身。
   */

  /** 总览：备份目录、生效的自动备份配置（含每项是谁说了算）、每份备份及校验结论 */
  app.get('/api/backups', async (_req, reply) => {
    try {
      return ok(reply, backupOverview());
    } catch (e) {
      return fail(reply, asApiError(e));
    }
  });

  /** 立即备份一次（一致性快照 + quick_check + foreign_key_check） */
  app.post('/api/backups', async (req, reply) => {
    try {
      const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
      const kindRaw = optStr(b, 'kind');
      const kind = kindRaw === 'daily' || kindRaw === 'weekly' || kindRaw === 'manual' ? kindRaw : 'manual';
      const info = await createBackup({ kind, note: optStr(b, 'note') ?? '手动备份' });
      return ok(reply, info, 201);
    } catch (e) {
      return fail(reply, asApiError(e));
    }
  });

  /**
   * 校验所有备份（可选 body.name 只校验一份）。
   * 结论会写回边车文件：**坏备份同样落盘记成坏**，并留在目录里当证据，不静默删除。
   */
  app.post('/api/backups/verify', async (req, reply) => {
    try {
      const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
      const one = optStr(b, 'name');
      const items = one ? [verifyBackupByName(one)] : verifyAllBackups();
      return ok(reply, {
        items,
        total: items.length,
        okCount: items.filter((i) => i.ok === true).length,
        bad: items.filter((i) => i.ok === false).map((i) => ({ name: i.name, errors: i.verify?.errors ?? [] })),
      });
    } catch (e) {
      return fail(reply, asApiError(e));
    }
  });

  /**
   * 恢复到选定的备份。危险操作，三道关：
   *   ① body.confirm 必须正好是「恢复」两个字；
   *   ② core 层会**先把当前库备份一份**才动手（做不出来就中止，当前库不动）；
   *   ③ 恢复期间所有写接口回 503，已在跑的写请求等它结束。
   * data/files 下的用户文件全程不动。
   */
  app.post('/api/backups/:name/restore', async (req, reply) => {
    try {
      const name = (req.params as { name: string }).name;
      const b = (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}) as Record<string, unknown>;
      if (String(b.confirm ?? '').trim() !== '恢复') {
        throw new ApiError('NEED_CONFIRM', '恢复是危险操作：请在确认框里输入「恢复」两个字再提交。');
      }
      const report = await restoreBackup(name, { requestId: String(req.id) });
      // 恢复出来的库里 external_root 可能和现在不一样，重算允许根白名单
      try {
        reloadBoundRoots();
      } catch (e) {
        report.warnings.push(`恢复后刷新目录绑定失败（重启工作台即可恢复）：${(e as Error).message}`);
      }
      return ok(reply, report);
    } catch (e) {
      return fail(reply, asApiError(e));
    }
  });

  /** 删除某份备份（二次确认由界面负责）。恢复进行中拒绝删除。 */
  app.delete('/api/backups/:name', async (req, reply) => {
    try {
      return ok(reply, deleteBackup((req.params as { name: string }).name));
    } catch (e) {
      return fail(reply, asApiError(e));
    }
  });

  /* ============================== 今日待办聚合 ============================== */

  /**
   * 「今天该干什么」一屏（清单 B4-14，只读）。
   *
   * 返回 `{ items, counts, generatedAt, queries, truncated }`，按紧急度排序：
   * 逾期 > 今天到期 > 待定稿 > 缺材料 > 缺影像。每条都带"为什么是待办"（`reason`）与
   * 定位信息（workbenchId / positionInstanceId / checklistItemId / artifactId）+ 跳转用的 `href`。
   *
   * 聚合口径、软删除与归档排除全在 `domain/service.ts` 的 `listTodayTodos()` 里（一处写死，界面不改口径）；
   * 本接口只做"把 query 参数转过去、把结论原样带回去"。
   * `?owner=` 可选（本机单用户时不传 = 全部工作台）；`?limit=` 只截 items，`counts` 仍是完整计数。
   *
   * 【为什么用动态 import】本轮改动限定为"只在 routes-core.ts 末尾追加一个只读接口"，
   * 因此不去改文件开头的 import 块；本文件里打开目录等接口本来也是这么写动态 import 的。
   */
  app.get('/api/todos/today', async (req, reply) => {
    try {
      const { listTodayTodos } = await import('../domain/service.ts');
      const owner = q(req, 'owner') ?? null;
      // 不引 qInt（那要在文件开头的 import 块里加名字）：就地校验
      const limitText = q(req, 'limit');
      const parsed = limitText === undefined ? undefined : Number(limitText);
      if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 0)) {
        throw new ApiError('BAD_PARAM', 'limit 必须是非负整数');
      }
      const limit = parsed === undefined || parsed === 0 ? undefined : parsed;
      return ok(reply, listTodayTodos({ owner, limit }));
    } catch (e) {
      return fail(reply, e);
    }
  });
}
