/**
 * 全局搜索接口（跨「工作台 / 文件 / 模板 / 制度 / 阶段」五域）。
 *
 *   GET /api/search-all?q=<词>&kinds=workbench,artifact&limit=8   分组返回
 *   GET /api/search-all/suggest?q=<词>                            轻量联想（最多 8 条标题）
 *
 * 为什么路径是 `/api/search-all` 而不是 `/api/search`：
 *   `/api/search` **已经被 `api/routes-files.ts` 占用**（文件库的单域全文检索，
 *   pages/Files.tsx 与 pages/Knowledge.tsx 都在用它，返回形状是 `{total, items, keyword}`）。
 *   Fastify 对同一 method + path 注册两次会在**启动时**直接抛 `FST_ERR_DUPLICATED_ROUTE`，
 *   服务根本起不来；就算能起，也会让那两个页面拿到 `groups` 而不是 `items`，
 *   文件列表静默变空。所以这里用独立路径，`/api/search` 保持原样不动。
 *
 * 参数校验（都按"宁可返回空结果，也不要 500"处理）：
 *   q      —— 超过 200 字截断（不是报错），空/纯标点返回空分组
 *   kinds  —— 逗号或空格分隔，认不出的值忽略；全都不认识 = 查全部
 *   limit  —— 每域条数，1-50，缺省 8
 */
import type { FastifyInstance } from 'fastify';
import { searchAll, suggestAll, SEARCH_KINDS, MAX_QUERY_LEN, MAX_LIMIT_PER_KIND } from '../core/search-all.ts';
import { fail, ok, q, qInt } from './reply.ts';

export function registerSearchRoutes(app: FastifyInstance): void {
  app.get('/api/search-all', async (req, reply) => {
    try {
      const raw = q(req, 'q') ?? '';
      const kinds = (q(req, 'kinds') ?? '')
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const limit = qInt(req, 'limit');
      const r = searchAll(raw, {
        kinds: kinds.length ? kinds : undefined,
        limitPerKind: limit === undefined ? undefined : Math.min(limit, MAX_LIMIT_PER_KIND),
      });
      return ok(reply, {
        ...r,
        // 让前端能自己校验/提示，而不必把常量写死在前端
        kinds: SEARCH_KINDS,
        maxQueryLen: MAX_QUERY_LEN,
        truncated: raw.trim().length > MAX_QUERY_LEN,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get('/api/search-all/suggest', async (req, reply) => {
    try {
      const raw = q(req, 'q') ?? '';
      const items = suggestAll(raw, 8);
      return ok(reply, { query: raw.slice(0, MAX_QUERY_LEN), items });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
