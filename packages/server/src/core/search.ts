/**
 * 全文检索（SQLite FTS5 + 中文逐字切分）
 * 策略说明见 migrations/002_fts.sql
 */
import { all, run } from '../db/index.ts';
import { visibleArtifactFilter } from './trash.ts';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

/** 把 CJK 字符逐字隔开，与写入索引时保持一致 */
export function segCJK(s: string): string {
  return s.replace(CJK, (c) => ` ${c} `).replace(/\s+/g, ' ').trim();
}

/** 去掉会让 FTS5 语法出错的字符（用户输入里的引号、星号、括号等） */
function sanitizeTerm(t: string): string {
  return t.replace(/["'*(){}[\]^~:\\/]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 组装 FTS5 MATCH 表达式
 * mode=or ：命中任意词即可（默认，适合"找含有这些字的东西"）
 * mode=and：必须包含全部词（适合精确筛选）
 */
export function buildMatch(query: string, mode: 'or' | 'and' = 'or'): string {
  const terms = sanitizeTerm(query)
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => segCJK(t))
    .filter(Boolean)
    .map((t) => `"${t}"`);
  if (!terms.length) return '';
  return terms.join(mode === 'and' ? ' AND ' : ' OR ');
}

export interface ArtifactSearchHit {
  id: number;
  workbench_id: number | null;
  position_code: string | null;
  kind: string;
  title: string;
  file_rel: string;
  file_name: string;
  file_ext: string | null;
  checklist_item_id: number | null;
  doc_date: string | null;
  captured_at: string | null;
  size_bytes: number | null;
  created_at: string;
  score: number;
  workbench_name?: string | null;
  workbench_code?: string | null;
}

export interface SearchOptions {
  workbenchId?: number | null;
  kind?: string | null;
  mode?: 'or' | 'and';
  limit?: number;
  offset?: number;
}

export function searchArtifacts(query: string, opts: SearchOptions = {}): { total: number; items: ArtifactSearchHit[] } {
  const match = buildMatch(query, opts.mode ?? 'or');
  if (!match) return { total: 0, items: [] };

  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const where: string[] = ['artifact_fts MATCH ?', visibleArtifactFilter('a')];
  const params: (string | number)[] = [match];
  if (opts.workbenchId) {
    where.push('d.wb_id = ?');
    params.push(opts.workbenchId);
  }
  if (opts.kind) {
    where.push('d.kind = ?');
    params.push(opts.kind);
  }
  const whereSql = where.join(' AND ');

  const total = all<{ n: number }>(
    `SELECT COUNT(*) AS n FROM artifact_fts f JOIN artifact_search d ON d.id = f.rowid JOIN artifact a ON a.id=d.id WHERE ${whereSql}`,
    params,
  )[0]?.n ?? 0;

  const items = all<ArtifactSearchHit>(
    `SELECT a.id, a.workbench_id, a.position_code, a.kind, a.title, a.file_rel, a.file_name,
            a.file_ext, a.checklist_item_id, a.doc_date, a.captured_at, a.size_bytes, a.created_at,
            bm25(artifact_fts, 10.0, 3.0) AS score,
            w.name AS workbench_name, w.code AS workbench_code
       FROM artifact_fts f
       JOIN artifact_search d ON d.id = f.rowid
       JOIN artifact a       ON a.id = d.id
       LEFT JOIN workbench w ON w.id = a.workbench_id
      WHERE ${whereSql}
      ORDER BY score ASC, a.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return { total, items };
}

/**
 * 重建整份索引（表结构变更或索引错乱时用）。
 *
 * 注意这里只清幽灵行 + 让 FTS 从 artifact_search 重读；
 * 「把每份文件的文字重新抽一遍」在 store.ts 的 indexArtifact 里，
 * 由 `/api/files/reindex` 依次调用 —— 之前这里留了一个同名空函数（只 SELECT 不写），
 * 谁调用都会以为索引重建了，其实什么都没做，已删掉。
 *
 * 什么算幽灵行：**索引表里有、但它指向的文件记录已经不该被检索到**。判据有两条，缺一条就会漏：
 *   1. `artifact` 里根本没有这个 id（记录被真删了）；
 *   2. `artifact.deleted_at IS NOT NULL`（记录进了回收站）—— 软删除那条路本来会主动摘掉索引行，
 *      但脚本 / 手工 SQL / 旧版本代码删的记录不走那条路，留下的索引行会被这里当成"还在"而保留，
 *      结果是**搜得到已删除的文件**（点开就是 404）。所以回收站里的记录同样按幽灵行清掉。
 * 本函数与 `api/routes-files.ts` 的 `/api/files/reindex` 必须用同一判据，别各写一份。
 */
export function purgeOrphanIndexRows(): number {
  const removed = run(
    'DELETE FROM artifact_search WHERE id NOT IN (SELECT id FROM artifact WHERE deleted_at IS NULL)',
  ).changes;
  run("INSERT INTO artifact_fts(artifact_fts) VALUES('rebuild')");
  return Number(removed);
}
