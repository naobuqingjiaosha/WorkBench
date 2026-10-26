/** 共享异常事件记录：供 OCR、校验和看门狗记录错误，不承担首页展示。 */
import { all, run } from '../db/index.ts';

/** 一条健康事件。`at` 由 {@link recordHealthEvent} 补齐，调用方不必自己造 */
export interface HealthEvent {
  at: string;
  kind: 'uncaughtException' | 'unhandledRejection' | 'ocrFailure' | 'selfCheckFailed';
  /** 一行摘要（已经截断，可直接显示） */
  message: string;
  /** 堆栈开头（只留前几行，避免把整页堆栈塞进界面） */
  stackHead?: string;
}

/** 落库连续失败多少次之后彻底放弃（避免每条事件都去撞一个坏表） */
const MAX_PERSIST_FAILURES = 5;

/** unknown = 还没探过 / table = 可以落库 / memoryOnly = 已降级为仅内存 */
let persistState: 'unknown' | 'table' | 'memoryOnly' = 'unknown';
/** 表里实际用的列名（表不存在时为 null） */
let schema: { at: string; stack: string | null } | null = null;
let persistFailures = 0;
let warnedMemoryOnly = false;

/** 统一取错误文本；`recordHealthEvent` 里连这一步都不允许抛错 */
function textOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** 摘要：只留第一行、限长。堆栈/多行错误直接进来会把界面撑爆 */
function oneLine(raw: unknown, max: number): string {
  const s = raw === undefined || raw === null ? '' : String(raw);
  const line = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * 探一次表结构。三态要分清，否则会把"库暂时连不上"误判成"没有表"而永久降级：
 *   found = 列名映射 | null（表不存在/列不全）
 *   dbReadable = PRAGMA 是否真的执行成功
 */
function probeSchema(): { found: { at: string; stack: string | null } | null; dbReadable: boolean } {
  try {
    const cols = all<{ name: string }>('PRAGMA table_info(app_health_event)');
    if (!cols.length) return { found: null, dbReadable: true }; // 表不存在（迁移 020 还没落地）
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('kind') || !names.has('message')) return { found: null, dbReadable: true };
    const at = names.has('at') ? 'at' : names.has('created_at') ? 'created_at' : null;
    if (!at) return { found: null, dbReadable: true };
    const stack = names.has('stack_head') ? 'stack_head' : names.has('stack') ? 'stack' : null;
    return { found: { at, stack }, dbReadable: true };
  } catch {
    // 库还没开、或正被恢复流程换掉：只是"这次探不了"，不降级、下次再探
    return { found: null, dbReadable: false };
  }
}

/** 首次降级时打印一行原因（只说一次，否则每条事件都刷屏） */
function warnMemoryOnly(reason: string): void {
  if (warnedMemoryOnly) return;
  warnedMemoryOnly = true;
  console.warn(`[健康] 异常事件未落库，详情见服务日志：${reason}`);
}

/**
 * 取当前可用的表结构（惰性解析，只探一次）。
 *
 * 写入前惰性检查表结构，数据库暂时不可用时下次重试。
 *
 * @returns 表可用时返回列名映射；表不存在（迁移 020 未落地）或已降级时返回 null
 */
function activeSchema(): { at: string; stack: string | null } | null {
  if (persistState === 'memoryOnly') return null;
  if (!schema) {
    const probe = probeSchema();
    if (!probe.dbReadable) return null; // 库暂时不可用：保持 unknown，下次再探
    if (!probe.found) {
      persistState = 'memoryOnly';
      warnMemoryOnly('app_health_event 表不存在（迁移 020 未落地），本模块不建表、不报错');
      return null;
    }
    schema = probe.found;
  }
  persistState = 'table';
  return schema;
}

/**
 * 尽力把一条事件写进 `app_health_event`。
 *
 * **所有失败路径都只是"这次没落库"**：表不存在、库没开、列不匹配、SQLITE_BUSY…一律咽掉，
 * 服务日志仍保留错误摘要。
 */
function persistEvent(event: HealthEvent): void {
  if (persistState === 'memoryOnly') return;
  try {
    const s = activeSchema();
    if (!s) return;
    const cols: string[] = [s.at, 'kind', 'message'];
    const vals: (string | null)[] = [event.at, event.kind, event.message];
    if (s.stack && event.stackHead) {
      cols.push(s.stack);
      vals.push(event.stackHead);
    }
    run(`INSERT INTO app_health_event (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, vals);
    persistFailures = 0;
  } catch (e) {
    // 不立刻永久放弃：可能是瞬时的（库正在被恢复流程换掉等），连续失败若干次才降级
    persistFailures += 1;
    schema = null;
    if (persistFailures >= MAX_PERSIST_FAILURES) {
      persistState = 'memoryOnly';
      warnMemoryOnly(`连续 ${persistFailures} 次写入 app_health_event 失败：${textOf(e)}`);
    }
  }
}

/**
 * 记一条健康事件。**这是本模块唯一写入口，绝不抛错。**
 *
 * 调用点（`index.ts` 的 `uncaughtException` / `unhandledRejection` 处理器、看门狗）
 * 都处在"已经出事了"的路径上，所以这里连 `new Date()` 都可能失败都要兜住。
 */
export function recordHealthEvent(e: Omit<HealthEvent, 'at'>): void {
  try {
    const at = new Date().toISOString();
    const message = oneLine(e.message, 300) || '(没有摘要)';
    const stackHead = e.stackHead === undefined || e.stackHead === null ? '' : oneLine(e.stackHead, 400);
    const event: HealthEvent = stackHead ? { at, kind: e.kind, message, stackHead } : { at, kind: e.kind, message };

    console.warn(`[健康] ${event.kind}：${event.message}`);

    persistEvent(event);
  } catch {
    // 记事件本身失败也不能再抛 —— 调用方是"接住崩溃"的代码
  }
}
