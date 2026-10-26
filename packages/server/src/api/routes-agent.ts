/**
 * AI 助手接口：对话、待确认动作、记忆 + 操作审计（助手动作 / 出文书）
 *
 * 写入全部走「提议 → 人确认」两步，所以这里有 apply/discard 这类端点；
 * 读类工具在对话里直接执行，不经过这里。
 *
 * 文件末尾的「操作审计」一节提供 GET /api/audit/{actions,generations,summary}，
 * 由本文件的 `registerAgentRoutes` 一并注册 —— `packages/server/src/index.ts`
 * 只调用这一个注册函数（该文件不允许改），所以审计路由必须挂在这里，
 * 而不是另开一个 `registerAuditRoutes(app)` 去等 index.ts 调用。
 */
import {registerRecordRoutes} from './routes-records.ts';
import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { collectBusinessEvidence } from '../domain/business-evidence.ts';
import { getBusinessRun, runBusinessAssistant, saveBusinessDraft } from '../domain/business-assistant.ts';
import {
  applyAction,
  deleteMemory,
  discardAction,
  listMemories,
  listMessages,
  listPendingActions,
  listSessions,
  runAgentTurn,
  undoAction,
  type AgentAction,
} from '../domain/agent.ts';
import { all, get, run } from '../db/index.ts';
import { artifactAbsPath, getArtifact, sha256 } from '../core/store.ts';
import { notDeleted, tableHasDeletedAt } from '../core/trash.ts';
import { ApiError, body, fail, intParam, ok, optBool, optNum, optStr, q, requireStr } from './reply.ts';

export function registerAgentRoutes(app: FastifyInstance): void {
  registerRecordRoutes(app);
  app.get('/api/agent/business',async(_req,reply)=>ok(reply,{items:all('SELECT id,question,artifact_id,created_at,parent_id FROM business_ai_run ORDER BY id DESC LIMIT 30')}));
  app.post('/api/agent/evidence',async(req,reply)=>{try{return ok(reply,await collectBusinessEvidence(body(req)));}catch(e){return fail(reply,e);}});
  app.get('/api/agent/business/:id',async(req,reply)=>{try{return ok(reply,getBusinessRun(intParam(req,'id')));}catch(e){return fail(reply,e);}});
  app.post('/api/agent/business/:id/draft',async(req,reply)=>{try{const b=body(req);return ok(reply,await saveBusinessDraft(intParam(req,'id'),b.values as Record<string,string>|undefined),201);}catch(e){return fail(reply,e);}});
  app.post('/api/agent/business/:id/recollect',async(req,reply)=>{try{
    const current=getBusinessRun(intParam(req,'id')),b=body(req),question=get<{question:string}>('SELECT question FROM business_ai_run WHERE id=?',[current.id])!.question;
    const requested=b.periodIds===undefined?undefined:b.periodIds as number[];
    const automatic=current.evidence.sources.filter(s=>s.table==='work_period').map(s=>s.recordId);
    // Keeping the complete automatic selection must also retain annual ledgers and temporary work.
    const periodIds=Array.isArray(requested)&&requested.length===automatic.length&&automatic.every(id=>requested.includes(id))?undefined:requested;
    return ok(reply,await runBusinessAssistant({question,scope:{...current.evidence.scope,periodIds},draft:!!current.draft,targetWorkbenchId:current.draft?.workbenchId}),201);
  }catch(e){return fail(reply,e);}});
  app.post('/api/agent/business/:id/review',async(req,reply)=>{try{
    const current=getBusinessRun(intParam(req,'id')),b=body(req),note=requireStr(b,'note','人工核对依据');
    if(b.confirmed!==true||note.length>5000)throw new ApiError('REVIEW_REQUIRED','请明确确认已核对事实、冲突及待补事项，并填写核对依据');
    if(current.changes.length)throw new ApiError('EVIDENCE_STALE','来源已变化，请重新收集资料',409,current.changes);
    const a=current.artifactId?getArtifact(current.artifactId):undefined;if(!a)throw new ApiError('NO_DRAFT','请先保存Word草稿');
    run('UPDATE business_ai_run SET review_note=?,reviewed_digest=? WHERE id=?',[note,sha256(readFileSync(artifactAbsPath(a))),current.id]);
    return ok(reply,{reviewed:true,note:'已记录人工核对。尚未定稿，请到所属工作的文书版本入口确认。'});
  }catch(e){return fail(reply,e);}});
  /** 对话：跑一轮，返回助手的回复与本轮待确认动作 */
  app.post('/api/agent/chat', async (req, reply) => {
    try {
      const b = body(req);
      const message = requireStr(b, 'message', '内容');
      const r = await runAgentTurn({
        sessionId: optNum(b, 'sessionId') ?? null,
        message,
        requestKey:optStr(b,'requestKey')??undefined,
        recordMode:b.recordMode==='capture'||b.recordMode==='query'?b.recordMode:undefined,
        workbenchId: optNum(b, 'workbenchId') ?? null,
        periodId: optNum(b, 'periodId') ?? null,
        artifactIds: Array.isArray(b.artifactIds) ? (b.artifactIds as unknown[]).map(Number).filter(Number.isFinite) : [],
      });
      return ok(reply, r, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/agent/sessions', async (_req, reply) => ok(reply, { items: listSessions() }));

  app.get('/api/agent/messages', async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      const sessionId = Number(q.sessionId);
      if (!Number.isFinite(sessionId)) throw new ApiError('MISSING_FIELD', '需要 sessionId');
      return ok(reply, { items: listMessages(sessionId) });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 待确认动作：不传 sessionId 就是全部 */
  app.get('/api/agent/actions', async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      const sessionId = q.sessionId ? Number(q.sessionId) : undefined;
      const pending = listPendingActions(Number.isFinite(sessionId) ? sessionId : undefined);
      return ok(reply, { items: pending, count: pending.length });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 确认执行一条动作 */
  app.post('/api/agent/actions/:id/apply', async (req, reply) => {
    try {
      const r = applyAction(intParam(req, 'id'));
      if (!r.ok) throw new ApiError('APPLY_FAILED', r.error ?? '执行失败');
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 忽略一条动作 */
  app.post('/api/agent/actions/:id/discard', async (req, reply) => {
    try {
      discardAction(intParam(req, 'id'));
      return ok(reply, { discarded: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 撤销一条**已执行**的动作（按 `before_json` 快照恢复改动前的值）。
   *
   * 拒绝的理由（没有快照 / 已被更晚的改动覆盖 / 目标已被删除 / 已经撤过）全部由
   * `domain/agent.ts` 的 `undoAction` 抛成 400 + 可读中文的 `ApiError`，
   * 这里**原样透出**（`fail()` 认 `ApiError`），不包装、也不兜成 500 ——
   * 用户必须看到"为什么不能撤"，而不是"服务出错了"。
   *
   * 动作 id 不存在时是 404（`undoAction` 抛 NOT_FOUND），与仓库里其它"按 id 取对象"
   * 的接口口径一致；`id` 不是正整数时是 400（`intParam`）。
   *
   * 请求体可选 `{ "force": true }`（也认 `1` / `"1"` / `"true"`，走现成的 `optBool`）：
   * **只做参数透传**，含义与边界全在 `undoAction` 那边（只放宽"目标被改过名"这一项复核，
   * 其余复核照样拒），这里不加任何判断逻辑。不带请求体 = 普通撤销，与改动前完全一致。
   */
  app.post('/api/agent/actions/:id/undo', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      return ok(reply, undoAction(intParam(req, 'id'), { force: optBool(b, 'force') === 1 }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 批量处理。默认**只执行普通动作**，破坏性动作（删除工作台这类）必须逐条确认 ——
   * 「全部执行」一键把工作台删掉是绝对不能有的交互。
   */
  app.post('/api/agent/actions/apply-all', async (req, reply) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = optNum(b, 'sessionId') ?? undefined;
      const includeDestructive = b.includeDestructive === true;
      const pending = listPendingActions(sessionId).filter((a) => includeDestructive || a.risk !== 'destructive');
      const applied: AgentAction[] = [];
      const failed: { id: number; error: string }[] = [];
      for (const a of pending) {
        const r = applyAction(a.id);
        if (r.ok) applied.push({ ...a, status: 'applied' });
        else failed.push({ id: a.id, error: r.error ?? '执行失败' });
      }
      return ok(reply, {
        applied: applied.length,
        failed,
        skippedDestructive: listPendingActions(sessionId).filter((a) => a.risk === 'destructive').length,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* ------------------------------ 记忆 ------------------------------ */

  app.get('/api/agent/memories', async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      return ok(reply, { items: listMemories(q.status ?? 'active') });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /**
   * 直接记一条备忘（不走模型）。
   * 界面上有个输入框，用户想手动记一笔时用；走对话记的那条要确认，这条不用 ——
   * 因为是人自己敲的，没有"模型理解错"的风险。
   */
  app.post('/api/agent/memories', async (req, reply) => {
    try {
      const b = body(req);
      const { run } = await import('../db/index.ts');
      const text = requireStr(b, 'text', '内容');
      const r = run('INSERT INTO agent_memory (text, workbench_id, due_date, source,confirmed) VALUES (?,?,?,?,1)', [
        text,
        optNum(b, 'workbenchId') ?? null,
        optStr(b, 'dueDate') ?? null,
        '手工',
      ]);
      return ok(reply, { id: r.lastInsertRowid }, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/agent/memories/:id', async (req, reply) => {
    try {
      deleteMemory(intParam(req, 'id'));
      return ok(reply, { deleted: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  registerAuditRoutes(app);
}

/* ==================================================================== */
/*                          操作审计（回溯入口）                          */
/* ==================================================================== */

/**
 * 这一节解决的是「出了问题无法回溯谁在什么时候改了哪个字段、用了哪个模板、花了多少 token」：
 *   · `agent_action`   —— 助手提了什么、改哪个字段、从什么改成什么、谁确认的、什么时候
 *   · `generation_log` —— 什么时候用哪张模板给哪份工作出了文书、落到哪个文件、多大
 *   · `ai_call_log`    —— 花了多少 token（有计价配置才估算费用）
 *
 * 两条硬约束，都来自**真实库实测**而不是猜：
 *
 *   1. **不臆造列名**。表结构随迁移逐版本变化，真实库可能停在旧版本
 *      （实测 D:\project\工作台\data\runtime\workbench.db 只跑到 `013_output_mode`，
 *      迁移 015 才加的 `agent_action.before_json` 在那份库里**根本不存在**）。
 *      所以启动后按 `pragma_table_info` 探一次列：有就用，没有就降级到
 *      `payload._before` / `result.before`，并把降级原因写进响应的 `degraded[]`。
 *
 *   2. **分页用游标（自增 id）而不是 offset**。offset 在翻页期间有新记录写入时会错位
 *      （同一行看两次、有的行永远看不到）。`id < 上一页最后一条` 天然不重不漏；
 *      接口同时把 `nextBefore` 明确回给前端，前端不需要自己推算。
 */
function registerAuditRoutes(app: FastifyInstance): void {
  /* 助手动作记录 */
  app.get('/api/audit/actions', async (req, reply) => {
    try {
      const workbenchId = auditWorkbenchFilter(q(req, 'workbenchId'));
      const status = auditStatusFilter(q(req, 'status'));
      const lim = auditLimit(q(req, 'limit'), 50);
      const cursor = auditCursor(q(req, 'before'));
      return ok(reply, auditListActions({ workbenchId, status, limit: lim.limit, limitRequested: lim.requested, limitClamped: lim.clamped, cursor }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* 出文书记录 */
  app.get('/api/audit/generations', async (req, reply) => {
    try {
      const workbenchId = auditWorkbenchFilter(q(req, 'workbenchId'));
      const lim = auditLimit(q(req, 'limit'), 50);
      const cursor = auditCursor(q(req, 'before'));
      return ok(reply, auditListGenerations({ workbenchId, limit: lim.limit, limitRequested: lim.requested, limitClamped: lim.clamped, cursor }));
    } catch (e) {
      return fail(reply, e);
    }
  });

  /* 概览：数量 / 按状态 / 按类型 / token 合计 / 费用估算 */
  app.get('/api/audit/summary', async (req, reply) => {
    try {
      return ok(reply, auditSummary(auditDays(q(req, 'days'))));
    } catch (e) {
      return fail(reply, e);
    }
  });
}

/* ------------------------------ 常量与映射 ------------------------------ */

/** `limit` 上限：一次最多 200 条，防止有人 limit=999999 把服务拖住 */
const AUDIT_LIMIT_MAX = 200;

const AUDIT_STATUS_LABEL: Record<string, string> = {
  pending: '待确认',
  applied: '已执行',
  discarded: '已拒绝',
  failed: '失败',
  undone: '已撤销',
};

/** 状态白名单：不在里面的一律 400（不猜、也不静默给全量） */
const AUDIT_STATUSES = new Set(Object.keys(AUDIT_STATUS_LABEL));

/** 工具名 → 中文标签（键逐个对照 `domain/agent.ts` 的 TOOLS 表，不是编的） */
const AUDIT_TOOL_LABEL: Record<string, string> = {
  mark_checklist: '核销清单项',
  note_artifact: '给文件写说明',
  remember: '记一条备忘',
  set_archive_value: '写项目信息字段',
  set_workbench_field: '改工作字段',
  add_archive_alias: '归并变量名称',
  add_archive_field: '新建项目信息字段',
  update_setting: '改系统设置',
  update_ai_profile: '改模型配置',
  delete_workbench: '删除工作',
  list_workbenches: '查看工作列表',
  get_workbench: '查看工作详情',
  list_templates: '查看模板',
  get_due_work: '查看待办',
  search_knowledge: '检索知识库',
  get_settings: '查看设置',
  list_memories: '查看备忘',
  list_evidence: '查看影像证据',
  review_photos: '看照片',
};

/** `workbench` 表字段名 → 中文（白名单取自 agent.ts 里 set_workbench_field 的 ALLOW 集合） */
const AUDIT_FIELD_LABEL: Record<string, string> = {
  owner: '负责人',
  counterpart: '对方单位',
  contract_no: '合同编号',
  contract_amount: '合同金额',
  start_date: '开工日期',
  plan_end_date: '计划完成日期',
  actual_end_date: '实际完成日期',
  summary: '备注',
  progress: '进度',
  recur_day: '每月执行日',
  remind_days: '提前提醒天数',
  status: '状态',
  tags: '标签',
  folder_path: '资料目录',
  code: '编号',
  name: '名称',
  external_root: '外部资料目录',
  output_mode: '输出位置模式',
};

const AUDIT_CHECKLIST_LABEL: Record<string, string> = { done: '已完成', na: '不适用', pending: '未完成' };

const AUDIT_MODE_LABEL: Record<string, string> = { ai: '模型填写', manual: '人工填写', hybrid: '模型+人工' };

/** 出文书的 token 只能按「同一模板最近一次写作调用」估算，超过这个间隔就不认（宁缺勿错） */
const AUDIT_TOKEN_MATCH_WINDOW_MS = 30 * 60 * 1000;

/* ------------------------------ 列探测 ------------------------------ */

const auditColumnCache = new Map<string, Set<string>>();

/**
 * 这张表有没有这一列？
 * 表名只来自本文件的字面量（不是请求参数），拼进 SQL 没有注入面。
 * 探测失败（表不存在）当作「没有」，调用方据此降级 —— 而不是让接口 500。
 */
function auditHas(table: string, column: string): boolean {
  let cols = auditColumnCache.get(table);
  if (!cols) {
    cols = new Set<string>();
    try {
      for (const r of all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)) cols.add(String(r.name));
    } catch {
      /* 探测不了就当作全都没有 */
    }
    auditColumnCache.set(table, cols);
  }
  return cols.has(column);
}

/* ------------------------------ 取值小工具 ------------------------------ */

function auditJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 软删除（迁移 015）标记表达式。
 *
 * `core/trash.ts` 的 `notDeleted()` 给的是「未删除」过滤片段；审计这边要的恰好相反 ——
 * **不排除已删除对象，而是把它们标出来**（见 `auditDeletedFlag` 调用点的口径说明）。
 * 所以这里按同一个 `tableHasDeletedAt` 探列结果生成 `x.deleted_at IS NOT NULL`，
 * 老库（还没跑 015）退回常量 0，绝不因为少一列让整个列表 500。
 */
function auditDeletedFlag(table: string, alias: string): string {
  if (!tableHasDeletedAt(table)) return '0';
  // 与 notDeleted 同源，只是取反：notDeleted(alias) 生成的是 `alias.deleted_at IS NULL`
  return `(NOT (${notDeleted(alias)}))`;
}

function auditObj(raw: unknown): Record<string, unknown> | null {
  const v = auditJson(raw);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function auditStamp(raw: unknown): string {
  return typeof raw === 'string' && raw ? raw : String(raw ?? '');
}

function auditText(v: unknown, empty = '（空）'): string {
  if (v === null || v === undefined) return empty;
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.trim() === '' ? empty : s;
}

/**
 * 给人看的「值」。
 *
 * 与 `auditText` 的区别：对象**不原样贴 JSON**（快照往往是整行 workbench，贴出来没法看），
 * 优先取对象里有意义的短字段（label/name/title），实在没有才退化成截断的 JSON。
 */
function auditValueText(v: unknown, empty = '（空）'): string {
  if (v === null || v === undefined) return empty;
  if (typeof v === 'string') return v.trim() === '' ? empty : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => auditValueText(x, '')).join('、') : empty;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['label', 'name', 'title', 'text', 'value']) {
      const inner = o[k];
      if (typeof inner === 'string' && inner.trim()) return inner;
    }
    const json = JSON.stringify(o);
    return json.length > 80 ? `${json.slice(0, 80)}…（整行快照）` : `${json}（整行快照）`;
  }
  return String(v);
}

function auditShort(v: unknown, n = 80): string {
  const s = auditText(v, '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function auditNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/* ------------------------------ 参数校验 ------------------------------ */

interface AuditCursor {
  mode: 'id' | 'time' | null;
  id?: number;
  time?: string;
  /** 传了看不懂的值：不当错误，忽略并退回第一页（一并写进 degraded） */
  ignored: boolean;
}

function auditCursor(raw: string | undefined): AuditCursor {
  if (raw === undefined) return { mode: null, ignored: false };
  const s = raw.trim();
  if (!s) return { mode: null, ignored: false };
  if (/^\d+$/.test(s)) return { mode: 'id', id: Number(s), ignored: false };
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?Z?$/.test(s)) return { mode: 'time', time: s, ignored: false };
  return { mode: null, ignored: true };
}

function auditLimit(raw: string | undefined, fallback: number): { limit: number; requested: number | null; clamped: boolean } {
  if (raw === undefined || !raw.trim()) return { limit: fallback, requested: null, clamped: false };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { limit: fallback, requested: null, clamped: true };
  const want = Math.trunc(n);
  const limit = Math.min(Math.max(want, 1), AUDIT_LIMIT_MAX);
  return { limit, requested: want, clamped: limit !== want };
}

/** 工作台筛选：给了就必须是数字（静默忽略筛选条件比报错更坑人） */
function auditWorkbenchFilter(raw: string | undefined): number | null {
  if (raw === undefined || !raw.trim()) return null;
  if (!/^\d+$/.test(raw.trim())) throw new ApiError('BAD_PARAM', 'workbenchId 必须是数字');
  return Number(raw.trim());
}

function auditStatusFilter(raw: string | undefined): string | null {
  if (raw === undefined || !raw.trim()) return null;
  const s = raw.trim();
  if (!AUDIT_STATUSES.has(s)) {
    throw new ApiError('BAD_PARAM', `status 只能是 ${[...AUDIT_STATUSES].join(' / ')}，收到：${s}`);
  }
  return s;
}

function auditDays(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return 7;
  return Math.min(Math.max(Math.trunc(n), 1), 365);
}

/* ------------------------------ 列表查询 ------------------------------ */

const AUDIT_ACTION_COLUMNS = [
  'id',
  'session_id',
  'message_id',
  'tool',
  'payload',
  'summary',
  'risk',
  'status',
  'result',
  'error',
  'applied_at',
  'created_at',
];

function auditWorkbenchMap(): Map<number, { code: string; name: string; deleted: boolean }> {
  const m = new Map<number, { code: string; name: string; deleted: boolean }>();
  const flag = auditDeletedFlag('workbench', 'workbench');
  /**
   * 审计口径：**已软删除的工作台照样要查出来**（删掉的对象的历史动作更要能倒查），
   * 所以这里故意不加 `deleted_at IS NULL` 过滤，而是把删除状态取出来打「（已删除）」标记。
   * 老库没有这一列时 `auditDeletedFlag` 返回 0，语句照样能跑。
   */
  for (const r of all<{ id: number; code: string; name: string; is_deleted: number }>(
    // flag 展开后是 `(NOT (workbench.deleted_at IS NULL))`；没有这列的老库退回 0（不写 deleted_at IS NULL）
    `SELECT id, code, name, ${flag} AS is_deleted FROM workbench`,
  )) {
    m.set(Number(r.id), { code: String(r.code), name: String(r.name), deleted: Number(r.is_deleted) === 1 });
  }
  return m;
}

/** field_key → 中文（archive_field 可能还没有数据，取不到就显示 key 本身） */
function auditFieldLabelMap(): Map<string, string> {
  const m = new Map<string, string>();
  const flag = auditDeletedFlag('archive_field', 'archive_field');
  /**
   * 审计口径：已软删除的字段定义也要能翻译出中文名（否则历史动作会显示成一串 field_key），
   * 因此同样不过滤 `deleted_at IS NULL`，只把删除状态一并读出来。
   */
  try {
    for (const r of all<{ field_key: string; label: string; is_deleted: number }>(
      // 同上：flag 展开为 `(NOT (archive_field.deleted_at IS NULL))`，老库退回 0
      `SELECT field_key, label, ${flag} AS is_deleted FROM archive_field`,
    )) {
      // 已删除的字段放最后覆盖：同名 key 优先显示还活着的那个定义
      if (Number(r.is_deleted) === 1 && m.has(String(r.field_key))) continue;
      m.set(String(r.field_key), String(r.label));
    }
  } catch {
    /* 表不存在 → 退化成显示 field_key */
  }
  return m;
}

/**
 * 改动前的值，按可信度依次取：`before_json`（迁移 015 才有） → `payload._before` → `result.before`。
 * 三种形态都要认：标量（旧值本身）、整行快照对象（set_workbench_field 的 _before）、
 * JSON 字符串（delete_workbench 的 _before 是 stringify 过的整行）。
 * 全都没有就明确回 `known:false` 并说明原因（列不存在 / 这条没留快照），界面照实显示「无法对比」——
 * 既不报错，也不显示 `null`，更不编一个旧值出来。
 */
function auditBeforeValue(
  row: Record<string, unknown>,
  payload: Record<string, unknown>,
  result: Record<string, unknown> | null,
  field: string | null,
): { known: boolean; value: unknown; source: 'before_json' | 'payload._before' | 'result.before' | null; columnPresent: boolean } {
  const columnPresent = auditHas('agent_action', 'before_json');
  const candidates: { from: 'before_json' | 'payload._before' | 'result.before'; value: unknown }[] = [];
  if (columnPresent) candidates.push({ from: 'before_json', value: row.before_json });
  candidates.push({ from: 'payload._before', value: payload._before });
  if (result) candidates.push({ from: 'result.before', value: result.before });
  for (const c of candidates) {
    if (c.value === null || c.value === undefined) continue;
    if (typeof c.value === 'string') {
      const parsed = auditObj(c.value);
      if (parsed) {
        if (field && field in parsed) return { known: true, value: parsed[field], source: c.from, columnPresent };
        continue; // 是整行快照但没有这个字段 → 当作没记录
      }
      return { known: true, value: c.value, source: c.from, columnPresent };
    }
    if (typeof c.value === 'object') {
      const o = c.value as Record<string, unknown>;
      if (field && field in o) return { known: true, value: o[field], source: c.from, columnPresent };
      continue;
    }
    return { known: true, value: c.value, source: c.from, columnPresent };
  }
  return { known: false, value: null, source: null, columnPresent };
}

interface AuditActionsInput {
  workbenchId: number | null;
  status: string | null;
  limit: number;
  limitRequested: number | null;
  limitClamped: boolean;
  cursor: AuditCursor;
}

function auditListActions(input: AuditActionsInput): Record<string, unknown> {
  const degraded: string[] = [];
  const hasBeforeJson = auditHas('agent_action', 'before_json');
  if (!hasBeforeJson) {
    degraded.push(
      'agent_action.before_json 列不存在（迁移 015 未执行）：改动前值改用 payload._before / result.before 解析，两者都没有时显示「没有留快照，无法对比」',
    );
  }
  if (input.cursor.ignored) degraded.push('before 不是合法游标（应为数字 id 或 ISO 时间）：已忽略、返回第一页');
  if (input.limitClamped) degraded.push(`limit 超出 1~${AUDIT_LIMIT_MAX}：已收敛为 ${input.limit}`);

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (input.status) {
    where.push('a.status = ?');
    params.push(input.status);
  }
  if (input.cursor.mode === 'id') {
    where.push('a.id < ?');
    params.push(input.cursor.id as number);
  } else if (input.cursor.mode === 'time') {
    where.push('a.created_at < ?');
    params.push(input.cursor.time as string);
  }
  const wbId = input.workbenchId;
  if (wbId !== null) {
    /*
     * 目标工作台藏在 payload JSON 里（agent_action 没有 workbench_id 列，实测列清单确认）。
     *   · 新版动作：`_target.id`（数字）+ `workbench`（id 的字符串形式）
     *   · 旧版动作（015 之前写入的存量，实测 id ≤ 49 那批）：只有 `workbench`（名称或编号）
     *   · mark_checklist / note_artifact：payload 里根本没有工作台，只能顺清单项/文件反查
     * 所以这四条路都要认，缺一条筛选就会漏记录。
     * json_extract 前先 json_valid：payload 是外部模型给的参数，历史行里万一是坏 JSON，
     * 不加这层守卫整个查询会抛错 → 接口 500。
     *
     * 软删除口径：这里的子查询**故意不过滤** `deleted_at IS NULL` —— 已删除工作台的历史动作
     * 必须还能按它筛出来（审计就是为了倒查，删掉的对象恰恰最需要留痕）；对象是否已删除
     * 由 auditWorkbenchMap / itemInfo / artInfo 读 deleted_at 打标记。
     */
    where.push(`(
      (json_valid(a.payload) AND json_extract(a.payload,'$._target.id') = ?)
      OR (json_valid(a.payload) AND json_extract(a.payload,'$.workbench') = ?)
      -- 目标工作台：不过滤 deleted_at IS NULL（已删除工作的历史动作也要能按它筛出来）
      OR (json_valid(a.payload) AND json_extract(a.payload,'$.workbench') IN (SELECT name FROM workbench WHERE id = ?))
      OR (json_valid(a.payload) AND json_extract(a.payload,'$.workbench') IN (SELECT code FROM workbench WHERE id = ?))
      -- 清单项所属阶段：不过滤 deleted_at IS NULL（p = position_instance），删除的阶段同样命中
      OR (json_valid(a.payload) AND CAST(json_extract(a.payload,'$.itemId') AS INTEGER) IN (
            SELECT c.id FROM checklist_item c JOIN position_instance p ON p.id = c.position_instance_id WHERE p.workbench_id = ?))
      -- 附件所属工作台：不过滤 deleted_at IS NULL（ar = artifact），回收站里的文件同样命中
      OR (json_valid(a.payload) AND CAST(json_extract(a.payload,'$.artifactId') AS INTEGER) IN (
            SELECT ar.id FROM artifact ar WHERE ar.workbench_id = ?))
    )`);
    // `_target.id` 是 JSON 数字 → 绑数字；`workbench` 是字符串 → 绑字符串。类型不匹配 SQLite 判不等。
    params.push(wbId, String(wbId), wbId, wbId, wbId, wbId);
  }

  const cols = [...AUDIT_ACTION_COLUMNS];
  if (hasBeforeJson) cols.push('before_json');
  const rows = all<Record<string, unknown>>(
    `SELECT ${cols.map((c) => `a.${c}`).join(', ')} FROM agent_action a
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY a.id DESC LIMIT ?`,
    // 多取一条用来判断还有没有下一页：不做 COUNT 全表，翻页也不受新写入影响
    [...params, input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;

  const wbMap = auditWorkbenchMap();
  const fieldLabels = auditFieldLabelMap();

  /* 清单项标题 / 文件标题：只对本页出现过的 id 查一次 */
  const itemDeletedFlag = auditDeletedFlag('position_instance', 'p');
  const artDeletedFlag = auditDeletedFlag('artifact', 'artifact');
  const payloads = page.map((r) => auditObj(r.payload) ?? {});
  const itemIds = [...new Set(payloads.map((p) => auditNum(p.itemId)).filter((x): x is number => x !== null))];
  const artIds = [...new Set(payloads.map((p) => auditNum(p.artifactId)).filter((x): x is number => x !== null))];
  const itemInfo = new Map<number, { title: string; workbenchId: number | null; deleted: boolean }>();
  if (itemIds.length) {
    /**
     * 软删除口径：已删除的阶段（position_instance）下的清单项标题也要能显示出来，
     * 所以不加 `deleted_at IS NULL` 过滤，只把 `p.deleted_at IS NOT NULL` 读出来打标记。
     */
    for (const r of all<{ id: number; title: string; workbench_id: number | null; is_deleted: number }>(
      `SELECT c.id, c.title, p.workbench_id, ${itemDeletedFlag} AS is_deleted FROM checklist_item c
         JOIN position_instance p ON p.id = c.position_instance_id
        WHERE c.id IN (${itemIds.map(() => '?').join(',')})`,
      itemIds,
    )) {
      itemInfo.set(Number(r.id), {
        title: String(r.title),
        workbenchId: r.workbench_id === null ? null : Number(r.workbench_id),
        deleted: Number(r.is_deleted) === 1,
      });
    }
  }
  const artInfo = new Map<number, { title: string; fileName: string; workbenchId: number | null; deleted: boolean }>();
  if (artIds.length) {
    /** 同上：已进回收站的附件也要显示（带「已删除」标记），因此不过滤 `deleted_at IS NULL` */
    for (const r of all<{ id: number; title: string; file_name: string; workbench_id: number | null; is_deleted: number }>(
      `SELECT id, title, file_name, workbench_id, ${artDeletedFlag} AS is_deleted FROM artifact
        WHERE id IN (${artIds.map(() => '?').join(',')})`,
      artIds,
    )) {
      artInfo.set(Number(r.id), {
        title: String(r.title),
        fileName: String(r.file_name),
        workbenchId: r.workbench_id === null ? null : Number(r.workbench_id),
        deleted: Number(r.is_deleted) === 1,
      });
    }
  }

  const items = page.map((row, i) =>
    auditDescribeAction(row, payloads[i] ?? {}, { wbMap, fieldLabels, itemInfo, artInfo }),
  );

  const last = page[page.length - 1];
  return {
    items,
    count: items.length,
    limit: input.limit,
    limitRequested: input.limitRequested,
    hasMore,
    /** 下一页的游标：本页最后一条的 id；没有下一页时是 null */
    nextBefore: last ? Number(last.id) : null,
    cursorMode: input.cursor.mode,
    filters: { workbenchId: input.workbenchId, status: input.status },
    /** 口径声明：软删除对象**不隐藏**，只标记（审计的意义就是留痕） */
    scope: {
      softDelete: tableHasDeletedAt('workbench') ? 'include-and-mark' : 'trash-not-active（老库还没有 deleted_at 列）',
      deletedMarkedAs: '（已删除）',
      beforeSnapshot: hasBeforeJson ? 'before_json' : 'payload._before / result.before（无 before_json 列）',
    },
    degraded,
  };
}

interface AuditActionContext {
  wbMap: Map<number, { code: string; name: string; deleted: boolean }>;
  fieldLabels: Map<string, string>;
  itemInfo: Map<number, { title: string; workbenchId: number | null; deleted: boolean }>;
  artInfo: Map<number, { title: string; fileName: string; workbenchId: number | null; deleted: boolean }>;
}

/** 把一行 agent_action 翻译成人能读的东西 */
function auditDescribeAction(row: Record<string, unknown>, payload: Record<string, unknown>, ctx: AuditActionContext): Record<string, unknown> {
  const tool = String(row.tool);
  const status = String(row.status);
  const result = auditObj(row.result);
  const target = payload._target && typeof payload._target === 'object' ? (payload._target as Record<string, unknown>) : null;

  /* ---- 目标工作台 ---- */
  let wbId = auditNum(target?.id) ?? auditNum(payload.workbench);
  let wb = wbId !== null ? ctx.wbMap.get(wbId) ?? null : null;
  if (!wb && typeof payload.workbench === 'string' && !/^\d+$/.test(payload.workbench.trim())) {
    const needle = payload.workbench.trim();
    for (const [id, v] of ctx.wbMap) {
      if (v.name === needle || v.code === needle) {
        wbId = id;
        wb = v;
        break;
      }
    }
  }
  let wbSource = wb ? 'payload' : '';
  if (!wb) {
    const itemId = auditNum(payload.itemId);
    const artId = auditNum(payload.artifactId);
    const viaItem = itemId !== null ? ctx.itemInfo.get(itemId) : undefined;
    const viaArt = artId !== null ? ctx.artInfo.get(artId) : undefined;
    const fallbackId = viaItem?.workbenchId ?? viaArt?.workbenchId ?? null;
    if (fallbackId !== null) {
      wbId = fallbackId;
      wb = ctx.wbMap.get(fallbackId) ?? null;
      wbSource = viaItem ? 'checklist_item' : 'artifact';
    }
  }
  const wbName = wb?.name ?? (typeof payload.workbench === 'string' && !/^\d+$/.test(payload.workbench.trim()) ? payload.workbench.trim() : null);

  /* ---- 字段与值 ---- */
  let field: string | null = null;
  let after: unknown;
  let beforeLabel = '字段';
  if (tool === 'set_workbench_field' || tool === 'set_archive_value') {
    field = typeof payload.field === 'string' ? payload.field : null;
    after = payload.value;
  } else if (tool === 'mark_checklist') {
    beforeLabel = '状态';
    after = payload.status;
  } else if (tool === 'note_artifact') {
    beforeLabel = '说明';
    after = payload.note;
  } else if (tool === 'remember') {
    beforeLabel = '备忘';
    after = payload.text;
  } else if (tool === 'add_archive_field') {
    beforeLabel = '字段';
    after = payload.label ?? payload.field_key;
  } else if (tool === 'add_archive_alias') {
    beforeLabel = '归属';
    after = payload.field_key;
  } else if (tool === 'update_setting') {
    field = typeof payload.key === 'string' ? payload.key : null;
    beforeLabel = '设置';
    after = payload.value;
  } else if (tool === 'update_ai_profile') {
    beforeLabel = '模型';
    after = payload.model ?? payload.provider ?? payload.code;
  } else if (tool === 'delete_workbench') {
    beforeLabel = '删除';
  }

  const fieldLabel =
    field === null
      ? null
      : ctx.fieldLabels.get(field) ?? AUDIT_FIELD_LABEL[field] ?? field;
  const beforeInfo = auditBeforeValue(row, payload, result, field);
  const valueText = (v: unknown) =>
    tool === 'mark_checklist' ? AUDIT_CHECKLIST_LABEL[String(v)] ?? auditValueText(v) : auditValueText(v);
  /** 没有快照时的说法要分清是「列还没有」还是「这条没留」—— 别让人以为是自己漏看了 */
  const noSnapshot = beforeInfo.columnPresent ? '这条改动没有留快照，无法对比' : '当前库还没有快照列（迁移 015 未执行），无法对比';

  /* ---- 改动摘要（"字段 X：旧值 → 新值"） ---- */
  let change: string;
  if (tool === 'set_workbench_field' || tool === 'set_archive_value') {
    const name = `${beforeLabel} ${fieldLabel ?? field ?? '（未知字段）'}`;
    change = beforeInfo.known
      ? `${name}：${auditShort(valueText(beforeInfo.value), 60)} → ${auditShort(valueText(after), 60)}`
      : `${name}：${noSnapshot}（新值 ${auditShort(valueText(after), 60)}）`;
  } else if (tool === 'mark_checklist' || tool === 'note_artifact') {
    change = beforeInfo.known
      ? `${beforeLabel}：${auditShort(valueText(beforeInfo.value), 60)} → ${auditShort(valueText(after), 60)}`
      : `${beforeLabel}：${noSnapshot}（新值 ${auditShort(valueText(after), 60)}）`;
  } else if (tool === 'update_setting') {
    change = beforeInfo.known
      ? `${beforeLabel} ${field ?? ''}：${auditShort(valueText(beforeInfo.value), 60)} → ${auditShort(valueText(after), 60)}`
      : `${beforeLabel} ${field ?? ''}：${noSnapshot}（新值 ${auditShort(valueText(after), 60)}）`;
  } else if (tool === 'remember') {
    change = `新增备忘：${auditShort(payload.text, 100)}`;
  } else if (tool === 'add_archive_field') {
    change = `新建项目信息字段：${auditShort(payload.label ?? payload.field_key, 60)}${payload.field_key ? `（${String(payload.field_key)}）` : ''}`;
  } else if (tool === 'add_archive_alias') {
    change = `变量 {${auditText(payload.var_name, '?')}} → 字段 ${auditText(payload.field_key, '?')}`;
  } else if (tool === 'delete_workbench') {
    change = `删除整份工作${wbName ? `「${wbName}」` : ''}及其全部文件与资料（破坏性，快照见 result）`;
  } else {
    change = auditShort(row.summary, 120) || `${tool}（无可读摘要）`;
  }

  /* ---- 人话目标描述 ---- */
  const itemId = auditNum(payload.itemId);
  const artId = auditNum(payload.artifactId);
  const viaItem = itemId !== null ? ctx.itemInfo.get(itemId) : undefined;
  const viaArt = artId !== null ? ctx.artInfo.get(artId) : undefined;
  const wbDeleted = wb?.deleted === true;
  /** 已软删除的对象后面挂这个后缀（审计不隐藏它们，但要让人一眼看出"这东西已经删了"） */
  const del = (flag: boolean | undefined) => (flag ? '（已删除）' : '');
  const wbPart = wbName
    ? `工作台「${wbName}」${del(wbDeleted)}${wbSource === 'payload' && wbId !== null ? `#${wbId}` : ''}`
    : wbId !== null
      ? `工作台 #${wbId}（名称未知）`
      : '（未指定工作台）';
  let targetText: string;
  switch (tool) {
    case 'set_workbench_field':
      targetText = `${wbPart} · 字段 ${fieldLabel ?? field ?? '?'}`;
      break;
    case 'set_archive_value':
      targetText = `${wbPart} · 项目信息 ${fieldLabel ?? field ?? '?'}`;
      break;
    case 'mark_checklist':
      targetText = `${wbPart} · 清单项 #${itemId ?? '?'}${viaItem ? `（${viaItem.title}${del(viaItem.deleted)}）` : ''}`;
      break;
    case 'note_artifact':
      targetText = `${wbPart} · 文件 #${artId ?? '?'}${viaArt ? `（${viaArt.fileName}${del(viaArt.deleted)}）` : ''}`;
      break;
    case 'remember':
      targetText = `${wbPart} · 备忘`;
      break;
    case 'add_archive_field':
      targetText = `${wbPart} · 项目信息字段 ${auditText(payload.label ?? payload.field_key, '?')}`;
      break;
    case 'add_archive_alias':
      targetText = `${wbPart} · 变量归属 {${auditText(payload.var_name, '?')}}`;
      break;
    case 'update_setting':
      targetText = `系统设置 ${auditText(payload.key, '?')}`;
      break;
    case 'update_ai_profile':
      targetText = `模型用途 ${auditText(payload.purpose ?? payload.code, '?')}`;
      break;
    default:
      targetText = wbPart;
  }

  return {
    id: Number(row.id),
    createdAt: auditStamp(row.created_at),
    appliedAt: row.applied_at ? auditStamp(row.applied_at) : null,
    status,
    statusLabel: AUDIT_STATUS_LABEL[status] ?? status,
    tool,
    toolLabel: AUDIT_TOOL_LABEL[tool] ?? tool,
    actionType: AUDIT_TOOL_LABEL[tool] ?? tool,
    risk: String(row.risk ?? 'normal'),
    destructive: String(row.risk ?? 'normal') === 'destructive',
    sessionId: row.session_id === null || row.session_id === undefined ? null : Number(row.session_id),
    messageId: row.message_id === null || row.message_id === undefined ? null : Number(row.message_id),
    /** agent_action 没有 operator 列（实测列清单确认）：这一行永远由助手提议 */
    source: 'assistant',
    sourceLabel: row.session_id === null || row.session_id === undefined ? '助手（未挂会话，多为界面/自检触发）' : '助手（对话中提议）',
    /** applied 只能来自 POST /api/agent/actions/:id/apply，也就是界面上人点的那一下 */
    confirmedBy: status === 'applied' ? '人（界面确认执行）' : null,
    workbench: wbId !== null ? { id: wbId, name: wb?.name ?? null, code: wb?.code ?? null, deleted: wbDeleted } : null,
    workbenchSource: wbSource || null,
    /** 目标对象当前是否在回收站里（迁移 015 之后才有意义；老库恒 false） */
    targetDeleted: wbDeleted || viaItem?.deleted === true || viaArt?.deleted === true,
    target: targetText,
    field,
    fieldLabel,
    before: beforeInfo.known ? beforeInfo.value : null,
    beforeKnown: beforeInfo.known,
    /** 快照从哪来的：before_json / payload._before / result.before；null = 没留快照 */
    beforeSource: beforeInfo.source,
    snapshotColumnPresent: beforeInfo.columnPresent,
    snapshotNote: beforeInfo.known ? null : noSnapshot,
    after: after === undefined ? null : after,
    change,
    summary: String(row.summary ?? ''),
    error: row.error ? String(row.error) : null,
    resultPreview: row.result ? auditShort(row.result, 160) : null,
  };
}

interface AuditGenerationsInput {
  workbenchId: number | null;
  limit: number;
  limitRequested: number | null;
  limitClamped: boolean;
  cursor: AuditCursor;
}

function auditListGenerations(input: AuditGenerationsInput): Record<string, unknown> {
  const degraded: string[] = [];
  if (input.cursor.ignored) degraded.push('before 不是合法游标（应为数字 id 或 ISO 时间）：已忽略、返回第一页');
  if (input.limitClamped) degraded.push(`limit 超出 1~${AUDIT_LIMIT_MAX}：已收敛为 ${input.limit}`);
  degraded.push(
    'generation_log 没有 token 列（实测列清单确认）：单次出文书的 token 只能按「同一模板最近一次写作调用」估算（标 ≈），没有对应调用时显示 —',
  );

  const hasIsTest = auditHas('ai_call_log', 'is_test');
  const hasRootKind = auditHas('artifact', 'root_kind');
  const wbDeleted = auditDeletedFlag('workbench', 'w');
  const artDeleted = auditDeletedFlag('artifact', 'ar');
  const notTest = hasIsTest ? ' AND c.is_test = 0' : '';
  /*
   * token 归因：ai_call_log.ref_type='generate' / 'generate-retry'，ref_id=template_id
   * （见 domain/generate.ts 的 ref 参数），**没有** generation_log 的外键。
   * 所以只能取「该模板在本条记录之前最近一次写作调用」，且间隔不超过 30 分钟才认。
   */
  const nearTokens = auditHas('ai_call_log', 'total_tokens')
    ? `(SELECT c.total_tokens FROM ai_call_log c
          WHERE c.ref_type IN ('generate','generate-retry') AND c.ref_id = g.template_id
            AND c.created_at <= g.created_at${notTest}
          ORDER BY c.created_at DESC LIMIT 1)`
    : 'NULL';
  const nearAt = `(SELECT c.created_at FROM ai_call_log c
          WHERE c.ref_type IN ('generate','generate-retry') AND c.ref_id = g.template_id
            AND c.created_at <= g.created_at${notTest}
          ORDER BY c.created_at DESC LIMIT 1)`;

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (input.workbenchId !== null) {
    where.push('g.workbench_id = ?');
    params.push(input.workbenchId);
  }
  if (input.cursor.mode === 'id') {
    where.push('g.id < ?');
    params.push(input.cursor.id as number);
  } else if (input.cursor.mode === 'time') {
    where.push('g.created_at < ?');
    params.push(input.cursor.time as string);
  }

  const rows = all<Record<string, unknown>>(
    /**
     * 软删除口径（迁移 015 给 workbench / artifact 加了 deleted_at）：
     * 这里的 LEFT JOIN **故意不过滤** `deleted_at IS NULL` —— 文书是给某份工作出的，
     * 那份工作后来被删了，这条出文书记录照样要能看见（并且标出来），否则审计就断了。
     * 所以把删除状态当列读出来，交给前端打「（已删除）」/「已进回收站」标记。
     * 老库没这一列时 auditDeletedFlag 返回常量 0，语句照跑。
     */
    `SELECT g.id, g.workbench_id, g.template_id, g.artifact_id, g.profile_purpose, g.variables,
            g.mode, g.status, g.message, g.created_at,
            t.name AS template_name, t.category AS template_category,
            w.name AS workbench_name, w.code AS workbench_code, ${wbDeleted} AS workbench_deleted,
            ar.title AS artifact_title, ar.file_name, ar.file_rel, ar.size_bytes, ${artDeleted} AS artifact_deleted,
            ${hasRootKind ? 'ar.root_kind AS root_kind' : 'NULL AS root_kind'},
            ${nearTokens} AS near_tokens, ${nearAt} AS near_at
       FROM generation_log g
       LEFT JOIN template t ON t.id = g.template_id
       LEFT JOIN workbench w ON w.id = g.workbench_id
       LEFT JOIN artifact ar ON ar.id = g.artifact_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY g.id DESC LIMIT ?`,
    [...params, input.limit + 1],
  );
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;

  const items = page.map((r) => {
    const variables = auditObj(r.variables);
    const status = String(r.status ?? 'ok');
    const artifactId = auditNum(r.artifact_id);
    const fileRel = r.file_rel === null || r.file_rel === undefined ? null : String(r.file_rel);
    const artifactDeleted = Number(r.artifact_deleted ?? 0) === 1;
    /* 「是否落盘」按文件**真的在不在**判断：库里有记录但文件被移走/删除，也要看得出来 */
    let onDisk: boolean | null = null;
    if (artifactId !== null) {
      try {
        // includeDeleted：已进回收站的文件也要定位得到，否则"文件不在了"会掩盖"其实在回收站里"
        const art = getArtifact(artifactId, { includeDeleted: true });
        onDisk = art ? existsSync(artifactAbsPath(art)) : false;
      } catch {
        onDisk = null; // 外部根没绑定/路径越界：无法判定就不猜
      }
    }
    const nearTokensRaw = r.near_tokens === null || r.near_tokens === undefined ? null : Number(r.near_tokens);
    const nearAtRaw = r.near_at ? String(r.near_at) : null;
    let tokensApprox: number | null = null;
    if (nearTokensRaw !== null && nearAtRaw) {
      const gap = Date.parse(String(r.created_at)) - Date.parse(nearAtRaw);
      if (Number.isFinite(gap) && gap >= 0 && gap <= AUDIT_TOKEN_MATCH_WINDOW_MS) tokensApprox = nearTokensRaw;
    }
    return {
      id: Number(r.id),
      createdAt: auditStamp(r.created_at),
      status,
      statusLabel: status === 'ok' ? '成功' : status === 'failed' ? '失败' : status,
      mode: String(r.mode ?? ''),
      modeLabel: AUDIT_MODE_LABEL[String(r.mode ?? '')] ?? String(r.mode ?? ''),
      purpose: r.profile_purpose ? String(r.profile_purpose) : null,
      templateId: r.template_id === null ? null : Number(r.template_id),
      templateName: r.template_name ? String(r.template_name) : null,
      templateCategory: r.template_category ? String(r.template_category) : null,
      workbenchId: r.workbench_id === null ? null : Number(r.workbench_id),
      workbenchName: r.workbench_name ? String(r.workbench_name) : null,
      workbenchCode: r.workbench_code ? String(r.workbench_code) : null,
      workbenchDeleted: Number(r.workbench_deleted ?? 0) === 1,
      artifactId,
      artifactTitle: r.artifact_title ? String(r.artifact_title) : null,
      artifactDeleted,
      fileName: r.file_name ? String(r.file_name) : null,
      filePath: fileRel,
      fileRootKind: r.root_kind ? String(r.root_kind) : null,
      sizeBytes: r.size_bytes === null || r.size_bytes === undefined ? null : Number(r.size_bytes),
      onDisk,
      variableCount: variables ? Object.keys(variables).length : 0,
      variablesPreview: r.variables ? auditShort(r.variables, 200) : null,
      tokensApprox,
      tokensSource: tokensApprox !== null ? '同一模板最近一次写作调用（ai_call_log.ref_type=generate, ref_id=template_id，间隔 ≤30 分钟）' : null,
      message: r.message ? String(r.message) : null,
    };
  });

  const last = page[page.length - 1];
  return {
    items,
    count: items.length,
    limit: input.limit,
    limitRequested: input.limitRequested,
    hasMore,
    nextBefore: last ? Number(last.id) : null,
    cursorMode: input.cursor.mode,
    filters: { workbenchId: input.workbenchId },
    /** 口径声明：已删除的工作台/附件照常出现在出文书记录里，只打标记 */
    scope: {
      softDelete: tableHasDeletedAt('artifact') || tableHasDeletedAt('workbench') ? 'include-and-mark' : 'trash-not-active（老库还没有 deleted_at 列）',
      deletedMarkedAs: '（已删除）',
    },
    degraded,
  };
}

/* ------------------------------ 概览 ------------------------------ */

/**
 * 计价配置：本项目**目前没有任何计价键**（实测 app_setting 只有 app.name / app.operator /
 * app.org / app.data_root / ai.writing_style / artifact.index_extract / ocr.enabled /
 * ocr.lang / work_types.deleted）。
 * 所以这里按约定探测三个键，配了才算钱、没配就只报 token：
 *   · ai.price.prompt_per_1k / ai.price.output_per_1k —— 输入/输出分别计价
 *   · ai.price.per_1k                              —— 不分输入输出的单一价
 */
function auditCost(promptTokens: number, outputTokens: number, totalTokens: number): Record<string, unknown> {
  const settings = new Map<string, string>();
  try {
    for (const r of all<{ key: string; value: string | null }>('SELECT key, value FROM app_setting')) {
      if (r.value !== null) settings.set(String(r.key), String(r.value));
    }
  } catch {
    /* 没有 app_setting 表 → 当作没配价格 */
  }
  const price = (k: string): number | null => {
    const raw = settings.get(k);
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const perPrompt = price('ai.price.prompt_per_1k');
  const perOutput = price('ai.price.output_per_1k');
  const blended = price('ai.price.per_1k');
  if (perPrompt !== null || perOutput !== null) {
    const amount = (promptTokens / 1000) * (perPrompt ?? 0) + (outputTokens / 1000) * (perOutput ?? 0);
    return {
      available: true,
      currency: 'CNY',
      amount: Math.round(amount * 10000) / 10000,
      unit: '每 1000 tokens',
      promptPricePer1k: perPrompt,
      outputPricePer1k: perOutput,
      basis: `输入 ${promptTokens} tokens${perPrompt !== null ? ` × ${perPrompt}/1k` : '（未配价，按 0 计）'} + 输出 ${outputTokens} tokens${perOutput !== null ? ` × ${perOutput}/1k` : '（未配价，按 0 计）'}`,
      note: '价格取自 app_setting 的 ai.price.* 键，只做估算，实际以服务商账单为准',
    };
  }
  if (blended !== null) {
    const amount = (totalTokens / 1000) * blended;
    return {
      available: true,
      currency: 'CNY',
      amount: Math.round(amount * 10000) / 10000,
      unit: '每 1000 tokens',
      blendedPer1k: blended,
      basis: `${totalTokens} tokens × ${blended}/1k`,
      note: '价格取自 app_setting 的 ai.price.per_1k，只做估算，实际以服务商账单为准',
    };
  }
  return {
    available: false,
    currency: 'CNY',
    amount: null,
    reason: '没有计价配置：app_setting 里没有 ai.price.prompt_per_1k / ai.price.output_per_1k / ai.price.per_1k 任何一个键，因此只报 token 数、不估算费用',
    settingsKeys: [...settings.keys()].sort(),
  };
}

function auditSummary(days: number): Record<string, unknown> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const degraded: string[] = [];

  /* ---- 助手动作 ---- */
  const byStatusRows = all<{ status: string; c: number }>(
    'SELECT status, COUNT(*) AS c FROM agent_action WHERE created_at >= ? GROUP BY status ORDER BY c DESC',
    [since],
  );
  const byToolRows = all<{ tool: string; c: number }>(
    'SELECT tool, COUNT(*) AS c FROM agent_action WHERE created_at >= ? GROUP BY tool ORDER BY c DESC, tool',
    [since],
  );
  const actionsRecent = byStatusRows.reduce((n, r) => n + Number(r.c), 0);
  const pendingRecent = byStatusRows.find((r) => r.status === 'pending')?.c ?? 0;
  /* 待确认是「全部」口径：一条 20 天前提的动作还没人处理，照样要出现在概览条上 */
  const pendingTotal = Number(get<{ c: number }>("SELECT COUNT(*) AS c FROM agent_action WHERE status = 'pending'")?.c ?? 0);
  const actionsTotal = Number(get<{ c: number }>('SELECT COUNT(*) AS c FROM agent_action')?.c ?? 0);

  /* ---- 出文书 ---- */
  const genStatusRows = all<{ status: string; c: number }>(
    'SELECT status, COUNT(*) AS c FROM generation_log WHERE created_at >= ? GROUP BY status ORDER BY c DESC',
    [since],
  );
  const genRecent = genStatusRows.reduce((n, r) => n + Number(r.c), 0);
  const genTotal = Number(get<{ c: number }>('SELECT COUNT(*) AS c FROM generation_log')?.c ?? 0);
  const genOk = genStatusRows.find((r) => r.status === 'ok')?.c ?? 0;
  const genFailed = genStatusRows.find((r) => r.status === 'failed')?.c ?? 0;

  /* ---- token ---- */
  const hasIsTest = auditHas('ai_call_log', 'is_test');
  const notTest = hasIsTest ? ' AND is_test = 0' : '';
  const t = get<{ calls: number; p: number; o: number; total: number }>(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(output_tokens),0) AS o,
            COALESCE(SUM(total_tokens),0) AS total
       FROM ai_call_log WHERE created_at >= ?${notTest}`,
    [since],
  ) ?? { calls: 0, p: 0, o: 0, total: 0 };
  const byPurpose = all<{ purpose: string | null; calls: number; tokens: number }>(
    `SELECT purpose, COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens
       FROM ai_call_log WHERE created_at >= ?${notTest}
      GROUP BY purpose ORDER BY tokens DESC`,
    [since],
  );
  const allTime = get<{ calls: number; total: number }>(
    `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS total FROM ai_call_log WHERE 1=1${notTest}`,
  ) ?? { calls: 0, total: 0 };
  /* 测试调用单独报：不然自检产生的 fake-* 调用会把「花了多少」算歪 */
  const testOnly = hasIsTest
    ? get<{ calls: number; total: number }>(
        'SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS total FROM ai_call_log WHERE is_test = 1',
      ) ?? { calls: 0, total: 0 }
    : { calls: 0, total: 0 };
  if (!hasIsTest) degraded.push('ai_call_log.is_test 列不存在（迁移 009 未执行）：token 合计没有排除测试调用');

  const promptTokens = Number(t.p);
  const outputTokens = Number(t.o);
  const totalTokens = Number(t.total);
  if (totalTokens === 0 && promptTokens + outputTokens > 0) {
    degraded.push('ai_call_log.total_tokens 多为空：token 合计退化为「输入+输出」，明细里出现的 0 表示该次调用没记用量');
  }

  return {
    days,
    since,
    windowLabel: `最近 ${days} 天（${since.slice(0, 10)} 起）`,
    actions: {
      recent: actionsRecent,
      total: actionsTotal,
      pending: pendingTotal,
      pendingRecent,
      byStatus: byStatusRows.map((r) => ({ status: r.status, label: AUDIT_STATUS_LABEL[r.status] ?? r.status, count: Number(r.c) })),
      byTool: byToolRows.map((r) => ({ tool: r.tool, label: AUDIT_TOOL_LABEL[r.tool] ?? r.tool, count: Number(r.c) })),
    },
    generations: {
      recent: genRecent,
      total: genTotal,
      ok: genOk,
      failed: genFailed,
      byStatus: genStatusRows.map((r) => ({ status: r.status, label: r.status === 'ok' ? '成功' : '失败', count: Number(r.c) })),
    },
    tokens: {
      calls: Number(t.calls),
      prompt: promptTokens,
      output: outputTokens,
      total: totalTokens,
      byPurpose: byPurpose.map((r) => ({ purpose: r.purpose ? String(r.purpose) : '（未标注）', calls: Number(r.calls), tokens: Number(r.tokens) })),
      allTimeCalls: Number(allTime.calls),
      allTimeTokens: Number(allTime.total),
      testCalls: Number(testOnly.calls),
      testTokens: Number(testOnly.total),
      scope: hasIsTest ? '只统计 is_test=0（排除自检/假服务商调用）' : '未排除测试调用（缺 is_test 列）',
    },
    cost: auditCost(promptTokens, outputTokens, totalTokens),
    degraded,
  };
}
