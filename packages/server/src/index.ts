import {registerWorkflowConfigRoutes} from './api/routes-workflow-config.ts';
/**
 * HTTP 服务入口
 *   node packages/server/src/index.ts
 *   或 npm start
 *
 * 一个进程同时提供：
 *   /api/*   JSON 接口
 *   /files/* 受限的数据目录静态访问（仅限数据库里登记过的文件）
 *   /*       Web 界面（packages/web/dist 构建产物）
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {all} from './db/index.ts';
import {resolveRegisteredFile,artifactAbsPath,getArtifact} from './core/store.ts';
import {liveFilter} from './core/trash.ts';
import {registerRequestGuard} from './core/request-guard.ts';
import { bootstrap } from './core/bootstrap.ts';
import { DATA_ROOT, RUNTIME_ROOT, SERVER_HOST, SERVER_PORT, WEB_DIST } from './core/config.ts';
import { recordHealthEvent } from './core/health.ts';
import { fail, ok, ApiError, apiErrorBody } from './api/reply.ts';
import { registerCoreRoutes } from './api/routes-core.ts';
import { registerConsentRoutes } from './api/routes-consent.ts';
import { registerWorkflowRoutes } from './api/routes-workflow.ts';
import { registerTimesheetRoutes } from './api/routes-timesheets.ts';
import { registerLedgerRoutes } from './api/routes-ledger.ts';
import { registerWorkRoutes } from './api/routes-work.ts';
import { registerTemplateRoutes } from './api/routes-template.ts';
import { registerGenerateRoutes } from './api/routes-generate.ts';
import { registerArchiveRoutes } from './api/routes-archive.ts';
import { registerFileRoutes, registerTrashRoutes } from './api/routes-files.ts';
import { registerAiRoutes } from './api/routes-ai.ts';
import { registerKbRoutes } from './api/routes-kb.ts';
import { registerAgentRoutes } from './api/routes-agent.ts';
import { registerVisionRoutes } from './api/routes-vision.ts';
import { registerSearchRoutes } from './api/routes-search.ts';
import { registerPreviewRoutes } from './api/routes-preview.ts';

import {acquireServerLock} from './core/server-lock.ts';
import {closeDatabase} from './db/index.ts';
import {isOcrProcessing} from './core/ocr-queue.ts';
import {isBackupTickRunning,stopBackupScheduler} from './core/backup.ts';
import {getBatchState} from './api/routes-kb.ts';
import {liveExtractJobs} from './core/kb-extract.ts';
acquireServerLock();
const started = bootstrap();

/**
 * 兜底：worker / 第三方库里抛出来的异常抓不住，会直接把进程带走
 * （例如 tesseract 在 worker 消息回调里 `throw Error(data)`，或者
 *  `process.nextTick(() => { throw err })` 式上抛 —— await 包不住这两种）。
 *
 * 处理办法是**只记一笔，然后继续活着**：
 * 这是本地单用户工具，服务突然消失比带着一条错误日志继续跑糟糕得多；
 * 而且进程里没有"只存在于内存里的权威状态"——数据都在 SQLite 和磁盘上，
 * 每条写库都走事务，出问题的那次请求自己会失败（例如 OCR 侧把该条 ocr_item
 * 标成 failed 并写清原因），不需要用"整个服务停掉"去换一致性。
 * 以前这里写的是 `app.close()` + `process.exit(1)`，与上面这段意图正好相反：
 * 一张坏图就能把大家正在用的服务打死（验收问题 A）。
 *
 * 边界：启动阶段的致命错误**仍然应该退出**，而且现在也确实会退出 ——
 * `acquireServerLock()` / `bootstrap()` 在上面就已经同步跑完了，本处理器是在它们
 * **之后**才注册的，所以那之前抛出来的异常根本不会走到这里，走的是 Node 默认行为
 * （打印后退出，非零码）。那时服务还没起来，"进程消失"才是对的：数据库没迁移完、
 * 服务锁没拿到的情况下带病启动，比起不来更危险。
 * ⇒ 因此这段注册代码**不要**往上挪到 `bootstrap()` 之前。
 */
/** 取错误文本（异常处理器与看门狗共用；连"不是 Error"的东西也要能说出话） */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

process.on('uncaughtException', (e) => {
  console.error('');
  console.error('  ⚠ 出现未捕获异常（服务继续运行）：');
  console.error(`  ${(e as Error)?.stack ?? String(e)}`);
  console.error('');
  /**
   * B4-11：光打印没人看得见（用户不会盯着启动窗口）。这里再记一笔健康事件，
   * `/api/health` 与首页「运行状态」卡片就能显示"上次未捕获异常 + 近 24 小时计数"。
   * 只是**追加一行记录**，上面"记日志后继续运行"的语义一个字都没改。
   */
  recordHealthEvent({ kind: 'uncaughtException', message: errorText(e), stackHead: (e as Error)?.stack });
});
process.on('unhandledRejection', (reason) => {
  console.error('');
  console.error('  ⚠ 出现未处理的 Promise 失败（服务继续运行）：');
  console.error(`  ${reason instanceof Error ? reason.stack : String(reason)}`);
  console.error('');
  // B4-11：同上，只加一行记录，不改变"继续运行"的行为
  recordHealthEvent({
    kind: 'unhandledRejection',
    message: errorText(reason),
    stackHead: reason instanceof Error ? reason.stack : undefined,
  });
});

const app = Fastify({
  logger: false,
  bodyLimit: 200 * 1024 * 1024,
});

/**
 * 全局错误处理器。必须**在注册任何路由之前**装好，这一点是有讲究的：
 *
 * Fastify 的路由在 `after()` 回调里才会读取当前上下文的 errorHandler（fastify/lib/route.js），
 * 而 `after()` 是**启动（boot）时**执行的 —— 已经注册的路由，一旦被
 * `await app.register(...)`（本文件里的 multipart）触发的那次 boot 收走，
 * 之后再把处理器换成自己的就来不及了：那条路由从此永远走 Fastify 的默认处理器。
 * 默认处理器只认 statusCode/status，返回的是 {statusCode,code,error,message}，
 * 不是本项目的 {ok:false,error:{...}} 信封，前端读不到 message 就只会说"服务出错了"。
 *
 * 处理器本身分成两条：
 *   1. ApiError 自带状态码（code + status/statusCode），直接按它回，返回值与 fail() 逐字节一致；
 *      这样任何路由——包括**忘记包 try/catch** 的——都不会把 410/404/409 这类业务错误
 *      降级成 500 INTERNAL；
 *   2. 其他错误（fetch/fs/multipart 等第三方异常）原样交给 fail()，行为与以前完全相同。
 */
app.setErrorHandler((error, _req, reply) => {
  if (error instanceof ApiError) {
    return reply.code(error.statusCode).send(apiErrorBody(error));
  }
  fail(reply, error);
});

registerRequestGuard(app);

// Stop new requests, drain current requests and background writers before releasing the DB lock.
let stopping = false;
app.addHook('onRequest', async (_req, reply) => {
 if(stopping)return reply.code(503).send({ok:false,error:{code:'STOPPING',message:'工作台正在更新，请等待启动窗口完成后刷新页面'}});
});
// In-flight keep-alive responses must close their socket after completion during update.
app.addHook('onSend', async (_req, reply, payload) => {
 if(stopping)reply.header('Connection','close');
 return payload;
});
const backgroundBusy=()=>isOcrProcessing()||isBackupTickRunning()||getBatchState().running||liveExtractJobs().length>0;
app.post('/api/system/shutdown',async(req,reply)=>{
 const {loadedBuild}=await import('./core/build-identity.ts');
 const b=req.body as {startedAt?:string;confirmed?:boolean}|null;
 if(!loadedBuild.sourceBuildId||!b?.confirmed||b.startedAt!==loadedBuild.startedAt)throw new ApiError('STALE_INSTANCE','运行实例已变化，请重新启动更新',409);
 if(backgroundBusy())throw new ApiError('BACKGROUND_BUSY','OCR、知识库导入或备份尚在运行，请等任务完成后再更新',409);
 stopping=true;stopBackupScheduler();
 reply.send({ok:true,data:{stopping:true}});
 setTimeout(()=>{void (async()=>{
  await app.close();
  // A request already in flight can have queued work just before close drained it.
  while(backgroundBusy())await new Promise(r=>setTimeout(r,100));
  closeDatabase();process.exit(0);
 })().catch(e=>console.error('停止未完成，保留数据库锁，请核对日志',e));},100);
});

// 没有请求体的请求（例如 curl -X POST）不要求声明 Content-Type
app.addHook('preValidation', async (req, reply) => {
  const ct = req.headers['content-type'];
  const len = Number(req.headers['content-length'] ?? 0);
  const hasBody = req.headers['transfer-encoding'] !== undefined || len > 0;
  if (!hasBody && ct && ct.includes('application/x-www-form-urlencoded')) {
    req.headers['content-type'] = 'application/json';
  }
  void reply;
});

await app.register(multipart, {
  limits: { fileSize: 200 * 1024 * 1024, files: 50 },
});

registerCoreRoutes(app);
registerWorkflowConfigRoutes(app);
registerConsentRoutes(app);
registerWorkflowRoutes(app);
registerTimesheetRoutes(app);
registerLedgerRoutes(app);
registerWorkRoutes(app);
registerTemplateRoutes(app);
registerGenerateRoutes(app);
registerArchiveRoutes(app);
registerFileRoutes(app);
// 回收站（迁移 015）：GET/POST/DELETE /api/trash*。定义在 api/routes-files.ts 里，
// 必须在这里显式挂上 —— 不挂的话 /api/trash 一律 404，回收站页面和恢复/彻底删除全都用不了。
registerTrashRoutes(app);
registerAiRoutes(app);
registerKbRoutes(app);
registerAgentRoutes(app);
registerVisionRoutes(app);
registerSearchRoutes(app);
// B4-12 真·预览：GET /api/artifacts/:id/preview（说明 + 文本内容）与 /preview/raw（图片/PDF 字节流）
registerPreviewRoutes(app);

// 兼容旧文件 URL，但只提供数据库登记的附件及模板。
app.get('/files/*',async(req,reply)=>{
 const rel=String((req.params as {'*':string})['*']).replace(/\\/g,'/');
 /**
  * 只认**在用**的附件记录（`liveFilter('artifact')` → deleted_at IS NULL；老库没这一列时降级成 1=1）：
  * 软删除只打标记、磁盘文件还在，不过滤的话"移入回收站"的文件照样能从这个旧 URL 下载 ——
  * 那就是"删了还活着"。这与 `/api/artifacts/:id/file`（走 `getArtifact()`，已经在过滤）口径一致；
  * 恢复（`restoreFromTrash`）会把标记清掉，链接立刻又能用。
  */
 const artRows=all<{id:number}>(`SELECT id FROM artifact WHERE file_rel=? AND ${liveFilter('artifact')}`,[rel]);
 const tplRows=all<{id:number}>('SELECT id FROM template WHERE file_rel=? OR vars_rel=?',[rel,rel]);
 if(!artRows.length&&!tplRows.length)throw new ApiError('NOT_FOUND','文件未登记',404);
 /**
  * `file_rel` 相对哪个根，只能按**这条记录自己**算：
  *   - 附件：按 `root_kind`（'data' → DATA_ROOT，'external' → 该工作台的 external_root）
  *   - 模板：恒定相对 DATA_ROOT（模板只在数据目录里）
  * 不能拿 rel 去白名单里「挑一个存在的同名文件」—— `_影像证据/x/shot.png`
  * 在两个根下都可能存在，那样会把别人工作台的文件当成本条记录发出去。
  * 定位不到（工作台被删 / 已解绑 / 文件真没了）统一 410，别让前端当成服务故障。
  */
  // 这条记录自己认的绝对路径：附件按 root_kind 现算（外部根由所属工作台决定），模板恒在 DATA_ROOT 下
  let preferredAbs:string|null=null;
  const artId=artRows[0]?.id;
  if(artId!==undefined){const a=getArtifact(artId);if(a){try{preferredAbs=artifactAbsPath(a);}catch{preferredAbs=null;}}}
  else preferredAbs=join(DATA_ROOT,rel);
  const abs=resolveRegisteredFile(rel,preferredAbs);
 if(!abs)throw new ApiError('FILE_MISSING','文件已不存在',410);
 reply.header('Content-Security-Policy',"sandbox; default-src 'none'");reply.header('Cache-Control','no-store');
 return reply.send(createReadStream(abs));
});

// Web 界面（若已构建）
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST,
    prefix: '/',
    decorateReply: false,
    index: ['index.html'],
    // 构建后文件名会变化，按请求查找文件，避免必须重启才能访问新资源。
    wildcard: true,
  });
  // 单页应用入口随构建更新，不能缓存启动时的旧资源文件名。
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return fail(reply, new ApiError('NOT_FOUND', '接口不存在', 404));
    }
    // 静态资源类请求（带扩展名）找不到就是真找不到
    if (extname(req.url) && !req.url.endsWith('.html')) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND', message: '文件不存在' } });
    }
    return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(readFileSync(join(WEB_DIST, 'index.html'), 'utf8'));
  });
} else {
  app.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>工作台</title>
       <body style="font-family:system-ui;max-width:720px;margin:60px auto;line-height:1.8">
       <h1>工作台后端已启动</h1>
       <p>前端界面还没有构建。在项目目录执行：</p>
       <pre style="background:#f4f4f5;padding:12px;border-radius:8px">npm run build</pre>
       <p>然后刷新本页。当前可以先访问接口自检：<a href="/api/health">/api/health</a></p>
       </body></html>`,
    ),
  );
}

for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().finally(()=>{closeDatabase();process.exit(0);});});

// 健康检查与信息接口在 routes-core.ts 里注册

try {
  await app.listen({ host: SERVER_HOST, port: SERVER_PORT });
  const url = `http://${SERVER_HOST}:${SERVER_PORT}`;
  console.log('');
  console.log('  工作台已启动');
  console.log(`  界面地址：${url}`);
  console.log(`  数据目录：${DATA_ROOT}`);
  console.log(`  数据库　：${started.dbFile}`);
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('');
} catch (e) {
  console.error('启动失败：', (e as Error).message);
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`端口 ${SERVER_PORT} 已被占用。改端口：设置环境变量 PORT，或修改 workbench.config.json。`);
  }
  process.exit(1);
}

/* ============================== 看门狗（B4-11） ============================== */

/**
 * 看门狗：每 30 秒自检一次"服务自己还健康吗"，**异常时只记录、只打印，绝不重启/退出自己**。
 *
 * 为什么不做自愈式重启：这是本地单用户工具，进程管理器不是它的职责 ——
 * 一个会 `process.exit()` 的看门狗，碰上误判就等于"自己把自己弄死"，
 * 那正是 B4-11 要消灭的那类事故（历史上一次坏图片就让服务消失）。
 * 服务真挂了，用户重启一下即可；看门狗的价值在于**把"刚才出过什么事"留下来给界面看**。
 *
 * 看门狗**不会把服务搞死**的代码依据（逐条对应本段实现）：
 *   ① `selfCheck()` 只返回"问题字符串数组"，没有任何 `throw`；每一项检查各自 try/catch，
 *      前一项失败不影响后一项 —— 检查失败 ≠ 抛错。
 *   ② 定时器回调整个包在 try/catch 里：连 `selfCheck()` 自己写出 bug 也只会落进 catch 分支，
 *      在那里再 `recordHealthEvent` + `console.warn`，并且这一步仍然包在 try/catch 里
 *      （"报信的代码不能成为新的崩溃源"）。
 *   ③ 全文件本段**没有** `process.exit` / `app.close` / 重新 `listen` —— 没有自杀路径。
 *   ④ `recordHealthEvent()` 自身也不抛错（见 core/health.ts），落库失败只降级为仅内存。
 *   ⑤ `timer.unref()`：定时器不参与"事件循环还有没有活干"的判定，绝对不会拦住进程正常退出。
 *   ⑥ 同一问题连续出现只记第一条（`lastProblem` 去重），避免刷爆 200 条事件缓冲。
 */
const WATCHDOG_INTERVAL_MS = 30_000;
/** 事件循环被阻塞多久算"卡住"：连续两个周期都没跑起来 */
const WATCHDOG_LAG_LIMIT_MS = WATCHDOG_INTERVAL_MS * 2;
/**
 * 探针落在运行目录下 —— 那是服务本来就该能写的地方（库、日志、备份都在附近）。
 * 写一个随机名文件再删掉：盘满、目录被删、权限变了，都会在这里暴露。
 */
const WATCHDOG_PROBE_DIR = RUNTIME_ROOT;

/** 自检三项：能连库 / 运行目录能写 / 事件循环没被长时间阻塞。返回问题清单，空数组=健康 */
function selfCheck(lagMs: number): string[] {
  const problems: string[] = [];

  // ① 数据库：最便宜的一次查询。库没开、文件被换掉、句柄坏了都会抛
  try {
    all('SELECT 1 AS ok');
  } catch (e) {
    problems.push(`数据库不可用：${errorText(e)}`);
  }

  // ② 运行目录可写（探针文件用完就删；删不掉不算问题，只说明目录脏了）
  const probe = join(WATCHDOG_PROBE_DIR, `watchdog-probe-${randomUUID()}.tmp`);
  try {
    mkdirSync(WATCHDOG_PROBE_DIR, { recursive: true });
    writeFileSync(probe, 'ok', { encoding: 'utf8', flag: 'wx' });
  } catch (e) {
    problems.push(`运行目录不可写（${WATCHDOG_PROBE_DIR}）：${errorText(e)}`);
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* 删不掉不是"不健康"，忽略 */
    }
  }

  // ③ 事件循环：定时器晚到超过两个周期，说明有同步任务把主线程占住了
  if (lagMs > WATCHDOG_LAG_LIMIT_MS) {
    problems.push(`事件循环被阻塞约 ${Math.round(lagMs / 1000)} 秒`);
  }

  return problems;
}

function startWatchdog(): void {
  // 桌面启动器只启动服务，不运行后台维护任务。
  if (process.env.WORKBENCH_START_ONLY === '1') return;
  /** 测试模式不启动：回归测试用的是临时库/临时目录，自检在那里只会产生噪音 */
  if (process.env.WORKBENCH_TEST_MODE === '1') return;

  let lastTick = Date.now();
  /** 上一轮的问题摘要：与上一轮相同就不再记事件（否则每 30 秒往缓冲里塞一条同样的） */
  let lastProblem = '';

  const report = (message: string): void => {
    if (message === lastProblem) return;
    lastProblem = message;
    recordHealthEvent({ kind: 'selfCheckFailed', message });
    console.warn(`[看门狗] 自检发现异常（服务继续运行，不重启）：${message}`);
  };

  const timer = setInterval(() => {
    try {
      const now = Date.now();
      const lagMs = now - lastTick - WATCHDOG_INTERVAL_MS;
      lastTick = now;
      const problems = selfCheck(lagMs);
      if (!problems.length) {
        lastProblem = ''; // 恢复正常：下一次再出问题会重新记录
        return;
      }
      report(problems.join('；'));
    } catch (e) {
      try {
        report(`看门狗自检自身异常：${errorText(e)}`);
      } catch {
        /* 连记都记不了，就只剩上面这一行控制台输出 */
      }
    }
  }, WATCHDOG_INTERVAL_MS);
  timer.unref(); // 不拦住进程退出

  console.log(`[看门狗] 已启动：每 ${WATCHDOG_INTERVAL_MS / 1000} 秒自检一次（自检失败只记事件，不重启、不退出）`);
}

// 只有 listen 成功才启动（上面 catch 里 process.exit(1)，走不到这里）
startWatchdog();

export { app };
