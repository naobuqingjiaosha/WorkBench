/**
 * API 工具：统一响应格式、错误处理、参数校验
 *
 * 成功：{ ok: true, data: ... }
 * 失败：{ ok: false, error: { code, message, detail? } }
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export class ApiError extends Error {
  code: string;
  status: number;
  detail?: unknown;
  constructor(code: string, message: string, status = 400, detail?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }

  /**
   * 状态码的通用别名。
   *
   * 路由忘包 try/catch 时，异常不经过 `fail()`，而是交给 Fastify 自己的错误处理链 ——
   * 那条链只认 `statusCode`/`status`（见 fastify/lib/error-status.js），
   * 万一将来有人给某条路由单独传 `errorHandler` 绕过全局处理器，
   * 接口就会把"模板文件缺失(410)""任务在跑(400)"这类业务错误降级成 500 INTERNAL，
   * 用户看到像服务崩了。做成 `status` 的读写别名（不是各存一份），
   * 两个字段永远不会不一致，这条路也就自动正确。
   */
  get statusCode(): number {
    return this.status;
  }
  set statusCode(v: number) {
    this.status = v;
  }
}

/** ApiError 的统一响应体：fail() 与全局错误处理器共用，保证两条路径返回的形状一模一样 */
export function apiErrorBody(error: ApiError): { ok: false; error: { code: string; message: string; detail?: unknown } } {
  return { ok: false, error: { code: error.code, message: error.message, detail: error.detail } };
}

export function ok<T>(reply: FastifyReply, data: T, status = 200): FastifyReply {
  return reply.code(status).send({ ok: true, data });
}

export function fail(reply: FastifyReply, error: unknown): FastifyReply {
  // 走 code/status 自带的业务错误（400/404/409/410…）
  if (error instanceof ApiError) {
    return reply.code(error.status).send(apiErrorBody(error));
  }
  const native = error as { statusCode?: number; code?: string; message?: string };
  if (native?.statusCode && native.statusCode >= 400 && native.statusCode < 500) return reply.code(native.statusCode).send({ ok: false, error: { code: native.code ?? 'BAD_REQUEST', message: native.message ?? '请求无效' } });
  const msg = error instanceof Error ? error.message : String(error);
  return reply.code(500).send({ ok: false, error: { code: 'INTERNAL', message: msg } });
}

interface BodyShape {
  [k: string]: unknown;
}

export function body<T extends BodyShape = BodyShape>(req: FastifyRequest): T {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError('BAD_BODY', '请求体必须是 JSON 对象');
  return b as T;
}

export function intParam(req: FastifyRequest, name: string): number {
  const params = req.params as Record<string, string | undefined>;
  const raw = params[name];
  const n = Number(raw);
  if (!raw || (!Number.isSafeInteger(n) || n <= 0)) throw new ApiError('BAD_PARAM', `路径参数 ${name} 必须是数字`);
  return n;
}

export function q(req: FastifyRequest, name: string): string | undefined {
  const query = req.query as Record<string, string | undefined>;
  const v = query[name];
  return v === undefined || v === '' ? undefined : v;
}

export function qInt(req: FastifyRequest, name: string): number | undefined {
  const v = q(req, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new ApiError('BAD_PARAM', `${name} 必须是非负整数`);
  return n;
}

export function qBool(req: FastifyRequest, name: string): boolean | undefined {
  const v = q(req, name);
  if (v === undefined) return undefined;
  return v === '1' || v.toLowerCase() === 'true';
}

export function requireStr(obj: Record<string, unknown>, key: string, label?: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || !v.trim()) throw new ApiError('MISSING_FIELD', `${label ?? key} 不能为空`);
  return v.trim();
}

export function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  return String(v);
}

export function optNum(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ApiError('BAD_FIELD', `${key} 必须是数字`);
  return n;
}

export function optBool(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
}

export function strArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') return v.split(/[,，\s]+/).filter(Boolean);
  return undefined;
}
