import {syncEvidence} from './checklist.ts';
/**
 * 回收站与软删除
 *
 // 这一处**故意不加** `deleted_at IS NULL` 守卫（回收站要读的就是已软删除的行）
 * 以前"删除"是真删：`DELETE FROM artifact`、「删工作台」把库记录和磁盘文件夹一起清掉，
 * 删错了没有任何退路。现在改成 **软删除 + 回收站 + 恢复**：
 *
 *   · 删除   → 只写 `deleted_at`，记录和磁盘文件都留着（`withFile=1` 时才顺手删磁盘文件）；
 *   · 列表/详情/统计/搜索/清单/助手/导出 → 一律默认排除 `deleted_at IS NOT NULL`；
 *   · 回收站 → 能看见、能恢复、能**彻底删除**（彻底删才真的动磁盘）。
 *
 * 这个模块有两条对外契约，别在别处再写一遍：
 *   1. **读过滤**：`NOT_DELETED` / `notDeleted(alias)` / `tableHasDeletedAt(table)`。
 *      其他模块凡是要从这五张表里读"在用的数据"（工作台 workbench、文件 artifact、
 *      阶段 position_instance、档案字段 archive_field、变量别名 archive_alias），
 *      都要带上 `deleted_at IS NULL` —— 具体写法见下面的 notDeleted()。
 *   2. **恢复的诚实边界**：见 `restoreFromTrash` 的实现注释 —— 恢复不了就明确拒绝，
 *      恢复得不完整就给 warnings（例如"文件已不在磁盘上，只恢复了记录"），绝不假装成功。
 *
 * 【本文件是全项目唯一"故意反着来"的地方】回收站要看的恰好是 `deleted_at IS NOT NULL`
 * 那批，彻底删除也要连同它们一起清。所以本模块里的查询**不加** `deleted_at IS NULL`，
 * 只加 `deleted_at IS NOT NULL`（或在真删时有意匹配全部）—— 每处都写了原因，不是漏了。
 *
 * 为什么用裸 SQL 而不用 `domain/service.ts` 的函数：`store.ts` / `service.ts` 都要
 * import 本模块的过滤片段，本模块反过来 import 它们就成环了。所以这里只有 DB 原语，
 * 需要刷新进度时动态 import（`checklist.ts` 不依赖本模块，静态 import 也是安全的）。
 */
import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { all, get, run, tx } from '../db/index.ts';
import { DATA_ROOT } from './config.ts';
import {
  assertDeletableFile, artifactFileAbs, canUse, grantOf, isInsideRoot, parseRootId,
  SafetyRefusal, samePathKey,
} from './paths.ts';
import { segCJK } from './search.ts';

/* ============================== 读过滤 ============================== */

/**
 * SQL 片段：只取未软删除的行。
 *
 * `alias` 是表别名或表名本身：
 *   `NOT_DELETED`（= `deleted_at IS NULL`）用于单表查询；
 *   `notDeleted('a')` → `a.deleted_at IS NULL` 用于带别名的查询。
 */
export const NOT_DELETED = 'deleted_at IS NULL';

/** 带别名的"未删除"条件；alias 为空时等价于 NOT_DELETED */
export function notDeleted(alias?: string | null): string {
  return `${alias ? `${alias}.` : ''}deleted_at IS NULL`;
}

/**
 * 表上到底有没有 `deleted_at` 列（迁移 015 之后才有）。
 *
 * 老库（还没跑 015）上直接写 `deleted_at IS NULL` 会报 `no such column`，
 * 那是**整个接口 500**，比"暂时少了软删除过滤"严重得多。所以过滤片段按需生成，
 * 结果缓存在模块变量里；迁移跑完（重启）后自动生效。
 * 与 `service.ts` 里 `period_dir` / `external_root` 的老库防呆是同一套做法。
 */
const deletedAtCache = new Map<string, boolean>();

export function tableHasDeletedAt(table: string): boolean {
  const cached = deletedAtCache.get(table);
  if (cached !== undefined) return cached;
  let has = false;
  try {
    // pragma_table_info 的入参不能用占位符（SQLite 语法限制），表名由本模块的常量表给出
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`非法的表名：${table}`);
    has = Boolean(
      get<{ name: string }>(`SELECT name FROM pragma_table_info('${table}') WHERE name = 'deleted_at'`),
    );
  } catch {
    has = false;
  }
  deletedAtCache.set(table, has);
  return has;
}

/** 测试/排障用：丢掉列探测缓存（迁移之后强制重认） */
export function resetDeletedAtCache(): void {
  deletedAtCache.clear();
}

/**
 * 带表别名的"只取未软删除的行"条件 —— **所有带 JOIN / 子查询的读路径都用它**。
 * 表上有 deleted_at 时返回 `'a.deleted_at IS NULL'`，否则返回 `'1=1'`（老库降级）。
 */
export function liveFilter(table: string, alias?: string | null): string {
  return tableHasDeletedAt(table) ? notDeleted(alias) : '1=1';
}

/** Normal file views also respect a deleted parent; trash recovery uses raw rows. */
export function visibleArtifactFilter(alias = 'artifact'): string {
  return `${liveFilter('artifact',alias)} AND (${alias}.workbench_id IS NULL OR EXISTS
    (SELECT 1 FROM workbench parent_work WHERE parent_work.id=${alias}.workbench_id AND ${liveFilter('workbench','parent_work')}))`;
}

/* ============================== 类型 ============================== */

/** 回收站里的对象类型。`position` = 阶段实例，`field` / `alias` = 档案字段与变量别名 */
export type TrashKind = 'workbench' | 'artifact' | 'position' | 'field' | 'alias';

export const TRASH_KINDS: TrashKind[] = ['workbench', 'artifact', 'position', 'field', 'alias'];

const KIND_TABLE: Record<TrashKind, string> = {
  workbench: 'workbench',
  artifact: 'artifact',
  position: 'position_instance',
  field: 'archive_field',
  alias: 'archive_alias',
};

export interface TrashEntry {
  kind: TrashKind;
  id: number;
  title: string;
  deletedAt: string;
  /** 给界面看的补充信息（文件位置 / 所属工作台 / 字段映射…） */
  extra?: string;
}

export function isTrashKind(v: unknown): v is TrashKind {
  return typeof v === 'string' && (TRASH_KINDS as string[]).includes(v);
}

/* ============================== 软删除入口 ============================== */

/**
 * 给若干行打上软删除标记。已删除的行不动（保留最早的删除时间，回收站排序才稳定）。
 * @returns 实际标记的行数
 */
export function markDeleted(table: string, where: string, params: (string | number | null)[], at?: string): number {
  if (!tableHasDeletedAt(table)) {
    // 老库还没有这一列：不静默吞掉，也不假装成功 —— 调用方要知道没生效
    throw new Error(`数据库还没有软删除功能（缺迁移 015），无法把 ${table} 的记录移入回收站，请先重启以完成数据库升级`);
  }
  const r = run(
    `UPDATE ${table} SET deleted_at = COALESCE(deleted_at, ?) WHERE ${where} AND deleted_at IS NULL`,
    [at ?? nowIso(), ...params],
  );
  return Number(r.changes);
}

/** 取消软删除标记（恢复） */
export function clearDeleted(table: string, id: number): number {
  const r = run(`UPDATE ${table} SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`, [id]);
  return Number(r.changes);
}

function nowIso(): string {
  // A parent's cascade shares one timestamp; separate deletion operations must not collide.
  const last = get<{at:string|null}>(`SELECT MAX(deleted_at) AS at FROM (
    SELECT deleted_at FROM workbench UNION ALL SELECT deleted_at FROM artifact
    UNION ALL SELECT deleted_at FROM position_instance)`)?.at;
  return new Date(Math.max(Date.now(), last ? (Date.parse(last) || 0) + 1 : 0)).toISOString();
}

/**
 * 软删除一份工作台及其阶段实例、文件记录、清单勾选记录。
 *
 * **不动磁盘**：磁盘那一半只有「彻底删除」（purgeFromTrash / emptyTrash）才做。
 * 不能顺手删文件的原因很直接 —— 删错了恢复回来的是空壳（文件已没了），
 * 而"能恢复"正是这次改造要的东西。
 *
 * @returns 各项受影响的行数
 */
export function softDeleteWorkbench(id: number): { workbench: number; positions: number; artifacts: number; checklist: number } {
  const at = nowIso();
  return tx(() => {
    const parent = get<{deleted_at:string|null}>('SELECT deleted_at FROM workbench WHERE id=?',[id]);
    if (!parent || parent.deleted_at) return {workbench:0,positions:0,artifacts:0,checklist:0};
    /**
     * 这里的几处统计**故意不加** `deleted_at IS NULL`：这次要做的事恰恰是把
     * "所有还没进回收站的"（`deleted_at IS NULL` 的那些）翻成已删除，
     * 所以先要连它们一起数出来，收尾后再由 `markDeleted` 统一打标记。
     */
    const posStats = all<{ positions: number; checklist: number }>(
      `SELECT COUNT(DISTINCT p.id) AS positions, COUNT(c.id) AS checklist
         FROM position_instance p LEFT JOIN checklist_item c ON c.position_instance_id = p.id
        WHERE p.workbench_id = ? AND deleted_at IS NULL`,
      [id],
    )[0] ?? { positions: 0, checklist: 0 };
    const positions = posStats.positions;
    // 文件记录数同样是"这次要翻成已删除的那批"（deleted_at IS NULL 的那些）
    const artifacts = all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM artifact WHERE workbench_id = ? AND deleted_at IS NULL',
      [id],
    )[0]?.n ?? 0;
    const wb = markDeleted('workbench', 'id = ?', [id], at);
    // 阶段与文件记录跟着进回收站：单独看它们也应当"默认查不到"
    markDeleted('position_instance', 'workbench_id = ?', [id], at);
    markDeleted('artifact', 'workbench_id = ?', [id], at);
    /**
     * **全文索引行必须一起摘掉**（`artifact_search` + 触发器同步的 `artifact_fts`）。
     *
     * 这两张表没有外键，软删除不会连带任何东西。漏掉这一步的后果是**实测出来的**：
     * 删掉整份工作台之后，`GET /api/search?q=平台资料` 仍然命中那条记录
     * （返回的正是已删除的文件），点进去 404 —— 也就是"删了还搜得到"。
     * 口径与 `store.deleteArtifact` 一致：进回收站 = 从检索里消失；
     * 恢复时由 `reindexArtifactSearch()` 重建这些行。
     */
    run('DELETE FROM artifact_search WHERE wb_id = ?', [id]);
    return { workbench: wb, positions, artifacts, checklist: posStats.checklist };
  });
}

/* ============================== 回收站列表 ============================== */

/**
 * 回收站列表（按删除时间倒序）。
 *
 * `kind` 传了但认不出 → 返回空数组（调用方负责先判合法值，路由层会 400）。
 */
export function listTrash(opts: { kind?: string; limit?: number } = {}): TrashEntry[] {
  if (opts.kind !== undefined && !isTrashKind(opts.kind)) return [];
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const kinds: TrashKind[] = isTrashKind(opts.kind) ? [opts.kind] : TRASH_KINDS;
  const out: TrashEntry[] = [];
  for (const kind of kinds) {
    if (!tableHasDeletedAt(KIND_TABLE[kind])) continue;
    out.push(...listKind(kind, limit));
  }
  return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : b.id - a.id)).slice(0, limit);
}

/**
 * 回收站列表的取数。
 *
 * 注意：这里**故意读 `deleted_at IS NOT NULL` 的行**（而不是常见的 `deleted_at IS NULL`）——
 * 回收站的定义就是"已经被软删除的那些"。所以本函数是全项目里少数"不加常规守卫"的读点：
 * 它每次查询都显式带 `deleted_at IS NOT NULL`，一条不漏也一条不多。
 * 下面按 kind 分五种表，`notDeleted()` 在这里不适用（那会得到相反的结果）。
 */
function listKind(kind: TrashKind, limit: number): TrashEntry[] {
  // 下面每个查询都显式带 `deleted_at IS NOT NULL`（回收站 = 已软删除的那批），
  // 与常规读路径的 `deleted_at IS NULL` 恰好相反 —— 这是有意为之，不是漏了守卫。
  if (kind === 'workbench') {
    // 要读的是回收站里那条工作台（deleted_at IS NOT NULL），所以这里**不加** `deleted_at IS NULL`
    return all<{ id: number; code: string; name: string; deleted_at: string; folder_path: string; external_root: string | null }>(
      `SELECT id, code, name, deleted_at, folder_path, external_root FROM workbench
        WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`,
      [limit],
    ).map((r) => ({
      kind,
      id: r.id,
      title: `${r.code} ${r.name}`,
      deletedAt: r.deleted_at,
      extra: (r.external_root ?? '').trim() ? `资料目录：${r.external_root}` : `位置：${r.folder_path}`,
    }));
  }
  if (kind === 'artifact') {
    // 要读的是回收站里那条文件记录（deleted_at IS NOT NULL），所以这里**不加** `deleted_at IS NULL`
    return all<{ id: number; title: string; file_name: string; deleted_at: string; file_rel: string; kind: string; workbench_id: number | null; root_kind: string | null; root_id: string | null; size_bytes: number | null; sha256: string | null }>(
      `SELECT id, title, file_name, deleted_at, file_rel, kind, workbench_id, root_kind, ${fileCols()} FROM artifact
        WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`,
      [limit],
    ).map((r) => {
      // 只为显示"属于哪个工作台"：这里不加 `deleted_at IS NULL`，回收站里父工作台可能也已被删
      const wb = r.workbench_id
        ? get<{ name: string }>('SELECT name FROM workbench WHERE id = ?', [r.workbench_id])?.name
        : undefined;
      const info: ArtifactFileInfo = { id: r.id, workbench_id: r.workbench_id, file_rel: r.file_rel, root_kind: r.root_kind, root_id: r.root_id, size_bytes: r.size_bytes, sha256: r.sha256 };
      const abs = artifactAbsPathFor(info);
      const keep = Boolean(abs && existsSync(abs));
      /**
       * 顺带说清"磁盘那一份为什么可能删不掉"：只读来源（iCloud 原件 / 显式声明的只读来源）
       * 里的文件平台一律不删，界面上不能只写"磁盘文件还在"让人以为是没删干净。
       */
      const readonly = Boolean(abs) && !canUse(abs as string, 'delete');
      return {
        kind,
        id: r.id,
        title: r.title || r.file_name,
        deletedAt: r.deleted_at,
        extra: `${r.kind}｜${r.file_rel}${wb ? `｜${wb}` : ''}｜${keep ? (readonly ? '磁盘文件还在（只读来源，平台不删）' : '磁盘文件还在') : '磁盘文件已不在'}`,
      };
    });
  }
  if (kind === 'position') {
    // 要读的是回收站里那条阶段（deleted_at IS NOT NULL），所以这里**不加** `deleted_at IS NULL`
    return all<{ id: number; name: string; code: string; deleted_at: string; workbench_id: number }>(
      `SELECT id, name, code, deleted_at, workbench_id FROM position_instance WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`,
      [limit],
    ).map((r) => {
      // 同上：只为显示所属工作台名，父记录可能也在回收站里（因此不加 deleted_at IS NULL）
      const wb = get<{ name: string }>(
        'SELECT name FROM workbench WHERE id = ?',
        [r.workbench_id],
      );
      return {
        kind,
        id: r.id,
        title: `${r.code} ${r.name}`,
        deletedAt: r.deleted_at,
        extra: `阶段${wb ? `｜${wb.name}` : ''}`,
      };
    });
  }
  if (kind === 'field') {
    // 回收站里的那条字段（deleted_at IS NOT NULL）；不加 `deleted_at IS NULL`
    return all<{ id: number; field_key: string; label: string; deleted_at: string; seed: number }>(
      `SELECT id, field_key, label, deleted_at, seed FROM archive_field WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`,
      [limit],
    ).map((r) => ({
      kind,
      id: r.id,
      title: `${r.label}（${r.field_key}）`,
      deletedAt: r.deleted_at,
      extra: r.seed ? '项目信息字段｜系统必备字段' : '项目信息字段',
    }));
  }
  // 要读的是回收站里那条别名（deleted_at IS NOT NULL），因此这条查询也不加 `deleted_at IS NULL`
  return all<{ id: number; var_name: string; field_key: string; deleted_at: string; work_type_id: number | null }>(
    `SELECT id, var_name, field_key, deleted_at, work_type_id FROM archive_alias WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?`,
    [limit],
  ).map((r) => ({
    kind: 'alias',
    id: r.id,
    title: `模板变量「${r.var_name}」`,
    deletedAt: r.deleted_at,
    extra: `指向 ${r.field_key}${r.work_type_id ? `｜工作类型 #${r.work_type_id}` : '｜全局'}`,
  }));
}

/* ============================== 恢复 ============================== */

/**
 * 恢复文件记录时把它的**全文索引行**重建出来。
 *
 * 软删除时我们主动删掉了 `artifact_search`（触发器会同步 `artifact_fts`），
 * 所以恢复必须补回来 —— 否则"恢复了文件，却搜不到它"，而且是静默的：
 * 界面上文件列表里明明有，检索里就是没有。判据与 `store.indexArtifact()` 保持一致。
 *
 * 用 `segCJK`（`core/search.ts` 里的中文逐字切分）拼索引文本，判据与
 * `store.indexArtifact()` 完全一致 —— 两处口径不一样的话，恢复出来的文件
 * 检索行为会和刚上传时不同。
 */
function reindexArtifactSearch(artifactId: number): void {
  const a = get<{
    id: number;
    workbench_id: number | null;
    kind: string;
    title: string;
    file_name: string;
    summary: string | null;
    extracted_text: string | null;
    ocr_text: string | null;
    tags: string | null;
  }>(
    `SELECT id, workbench_id, kind, title, file_name, summary, extracted_text, ocr_text, tags
       FROM artifact WHERE id = ? AND ${visibleArtifactFilter()}`,
    [artifactId],
  );
  if (!a) return;
  const body = [a.title, a.summary ?? '', a.extracted_text ?? '', a.ocr_text ?? '', a.tags ?? ''].join('\n');
  const name = [a.file_name, a.title].join(' ');
  run(
    `INSERT INTO artifact_search (id, wb_id, kind, seg_text, seg_name) VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET wb_id = excluded.wb_id, kind = excluded.kind,
       seg_text = excluded.seg_text, seg_name = excluded.seg_name`,
    [a.id, a.workbench_id, a.kind, segCJK(body), segCJK(name)],
  );
}

export interface RestoreResult {
  restored: true;
  kind: string;
  id: number;
  warnings: string[];
}

interface ArtifactFileInfo {
  id: number;
  workbench_id: number | null;
  file_rel: string;
  root_kind: string | null;
  /**
   * 登记时的**来源身份**（'data' / 'ext:<路径>'；老记录为 NULL）。
   * 有了它，"这条记录在磁盘上是哪一份文件"就不再随工作台改绑而改变 ——
   * 见 `core/paths.ts` 的 `artifactFileAbs()`。回收站/彻底删除都必须按它定位，
   * 否则删旧记录时会把新目录里同名、但平台从没登记过的原件一起 unlink 掉。
   */
  root_id?: string | null;
  /** 登记时的内容指纹（大小 + sha256）：删除前必须核对，见 `assertDeletableFile` */
  size_bytes?: number | null;
  sha256?: string | null;
}

/**
 * 从回收站恢复一条记录。
 *
 * 【什么情况明确拒绝（抛错，不动库）】
 *   · 记录不存在，或它本来就不在回收站里（`deleted_at IS NULL`）→ 说清楚，而不是"恢复成功"；
 *   · 父记录已经不在：文件的所属工作台、阶段的所属工作台 —— 阶段的工作台被彻底删掉之后，
 *     恢复出来的阶段没有任何归属，界面上永远看不到它。这种情况拒绝并告诉用户先恢复工作台；
 *   · 名字/编号冲突：工作台的 `code` 是唯一列，恢复时若已有同名同编号的**在用**记录，
 *     恢复必然撞唯一约束，所以先判一次并给出可读原因；
 *   · 系统必备档案字段（seed=1）：与删除时的限制对称，不允许恢复（它本来也不该被删）。
 *
 * 【什么情况给出 warnings（恢复了，但不完整）】
 *   · artifact 的磁盘文件已经不在（被 purge 删过 / 被手工删掉）→「文件已不在磁盘上，只恢复了记录」；
 *   · 恢复 artifact 时它的所属工作台仍在回收站里 → 提醒先恢复工作台，否则界面上还是看不到；
 *   · 恢复 workbench 时它的资料目录已不存在 → 提醒目录丢了（文件仍按原相对路径记录）。
 *
 * 【为什么是同步的】恢复文件时要把它被摘掉的**全文索引行**重建回来
 * （`reindexArtifactSearch`）。中文切词函数 `segCJK` 就在 `core/search.ts` 里，
 * 而 `search.ts` 只依赖 db —— **静态 import 它不会成环**，所以这里不需要 async。
 * （曾经写成 async 只为了动态 import 取 `segCJK`，结果是整棵树的调用方都要跟着改，
 *  还因为漏掉一处在非 async 函数里 `await` 导致服务起不来。别为了"避免一个不存在的环"
 *  引入跨文件的 async 传染。）
 */
/**
 * 恢复的最后一步：**把允许根重新算一遍**。
 *
 * 删除工作台时 `deleteWorkbench()` 会把它的 external_root 从允许根里摘掉，恢复时如果
 * 不刷回来，用户会撞上一串对不上的毛病：上传/纳管报「路径越界」、预览找不到文件、
 * **彻底删除时磁盘文件一个都删不掉**（允许根里没这个目录）——而且没有任何入口能修，
 * 只能重启服务。所以恢复这一处与恢复路由各刷一次（两处都刷是有意的：模块被别处调用、
 * 或者恢复的是"记录级"对象时，路由那次就是兜底）。
 *
 * 动态 import 是为了不引入 `trash.ts ↔ domain/service.ts` 的循环依赖（与彻底删除同一做法）；
 * 刷新失败不影响恢复本身（库里已经对了，下次启动会重算）。
 */
function refreshBoundRootsQuietly(): void {
  try {
    void import('../domain/service.ts')
      .then((m) => m.reloadBoundRoots())
      .catch(() => undefined);
  } catch {
    /* 下一次启动会重算 */
  }
}

export function restoreFromTrash(kind: string, id: number): RestoreResult {
  // Restoration and derived counts are one database operation. These paths only
  // inspect files; indexes and nested restore writes share this savepoint.
  const result = tx(() => {
    const restored = restoreFromTrashInner(kind, id);
    const workbenchId = kind === 'workbench' ? id : kind === 'artifact' || kind === 'position'
      ? get<{workbench_id:number}>(`SELECT workbench_id FROM ${kind === 'artifact' ? 'artifact' : 'position_instance'} WHERE id=?`, [id])?.workbench_id : undefined;
    if (workbenchId) syncEvidence(workbenchId);
    return restored;
  });
  // 恢复完立刻刷新允许根：删工作台时摘掉的根，这里要装回来（见上面的说明）
  refreshBoundRootsQuietly();
  return result;
}

function restoreFromTrashInner(kind: string, id: number): RestoreResult {
  if (!isTrashKind(kind)) throw new Error(`不认识的回收站类型：${kind}（可用：${TRASH_KINDS.join(' / ')}）`);
  const table = KIND_TABLE[kind];
  if (!tableHasDeletedAt(table)) {
    throw new Error(`数据库还没有回收站功能（缺迁移 015），无法恢复，请先重启以完成数据库升级`);
  }

  switch (kind) {
    case 'workbench': {
      // 这里**故意不带** `deleted_at IS NULL`：要找的正是回收站里那条（`deleted_at IS NOT NULL`）
      const wb = get<{ id: number; code: string; name: string; deleted_at: string | null; external_root: string | null; folder_path: string }>(
        'SELECT id, code, name, deleted_at, external_root, folder_path FROM workbench WHERE id = ?',
        [id],
      );
      if (!wb) throw new Error(`工作台不存在：#${id}`);
      if (!wb.deleted_at) throw new Error(`工作台「${wb.name}」不在回收站里（它不是被删除的）`);

      // 冲突判定要连回收站里的同编号记录一起看：只看 `deleted_at IS NULL` 会漏掉"两条都在回收站"的情况
      const clash = get<{ id: number; name: string; deleted_at: string | null }>(
        'SELECT id, name, deleted_at FROM workbench WHERE code = ? AND id <> ?',
        [wb.code, id],
      );
      if (clash && !clash.deleted_at) {
        throw new Error(`不能恢复：编号 ${wb.code} 已被另一个工作台占用（#${clash.id} ${clash.name}），请先改名或把它也删掉`);
      }

      const warnings: string[] = [];
      const restored = tx(() => {
        const n = run('UPDATE workbench SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL', [id]).changes;
        run('UPDATE position_instance SET deleted_at = NULL WHERE workbench_id = ? AND deleted_at = ?', [id,wb.deleted_at]);
        run('UPDATE artifact SET deleted_at = NULL WHERE workbench_id = ? AND deleted_at = ?', [id,wb.deleted_at]);
        return Number(n);
      });
      if (!restored) throw new Error(`工作台「${wb.name}」恢复失败：它可能刚被其它操作处理过`);

      /**
       * 把这份工作台名下文件的**全文索引**重建回来（软删除时被摘掉了）。
       * 不重建的话："文件列表里有、检索里没有"，而且完全没有提示。
       */
      const restoredArtifacts = all<{ id: number }>(
        'SELECT id FROM artifact WHERE workbench_id = ? AND deleted_at IS NULL',
        [id],
      );
      for (const row of restoredArtifacts) reindexArtifactSearch(row.id);

      const external = (wb.external_root ?? '').trim();
      const dirAbs = external || join(DATA_ROOT, wb.folder_path);
      if (!existsSync(dirAbs)) warnings.push(`资料目录已不存在（${dirAbs}），记录已恢复，但文件需要你手工放回或重新绑定目录`);
      // 统计"有多少份文件其实不在磁盘上"：恢复后要如实告诉用户，这里也不加 `deleted_at IS NULL`
      const files = all<ArtifactFileInfo>(`SELECT id, workbench_id, file_rel, root_kind, ${fileCols()} FROM artifact WHERE workbench_id = ?`, [id]);
      const gone = files.filter((f) => !artifactFileExists(f)).length;
      if (gone) warnings.push(`有 ${gone} 份文件的磁盘文件不在了（只恢复了记录）`);
      return { restored: true as const, kind, id, warnings };
    }

    case 'artifact': {
      // 要读的就是回收站里那条（deleted_at IS NOT NULL）；因此这条查询不加 `deleted_at IS NULL`
      const a = get<ArtifactFileInfo & { title: string; deleted_at: string | null }>(
        `SELECT id, workbench_id, file_rel, root_kind, ${fileCols()}, title, deleted_at FROM artifact WHERE id = ?`,
        [id],
      );
      if (!a) throw new Error(`文件记录不存在：#${id}`);
      if (!a.deleted_at) throw new Error(`文件「${a.title}」不在回收站里（它不是被删除的）`);

      const warnings: string[] = [];
      if (a.workbench_id) {
        // 父工作台是否还在回收站里 —— 因此不能加 `deleted_at IS NULL`，否则永远查不到
        const wb = get<{ name: string; deleted_at: string | null }>(
          'SELECT name, deleted_at FROM workbench WHERE id = ?',
          [a.workbench_id],
        );
        if (!wb) {
          throw new Error(`不能恢复：这份文件所属的工作台（#${a.workbench_id}）已被彻底删除，恢复出来也没有归属。请先恢复工作台`);
        }
        if (wb.deleted_at) {
          warnings.push(`所属工作台「${wb.name}」还在回收站里，请一并恢复，否则界面上看不到这份文件`);
        }
      }
      clearDeleted('artifact', id);
      // 索引行也补回来（软删除时摘掉了），否则"记录了但搜不到"
      reindexArtifactSearch(id);
      if (!artifactFileExists(a)) {
        warnings.push('磁盘文件已不在（可能被彻底删除或手工删掉），只恢复了记录；记录里的位置仍指向原路径，重新放回同名文件即可继续下载');
      }
      return { restored: true as const, kind, id, warnings };
    }

    case 'position': {
      const p = get<{ id: number; name: string; workbench_id: number; deleted_at: string | null }>(
        // 这一处**故意不加** `deleted_at IS NULL` 守卫（回收站要读的就是已软删除的行）
        'SELECT id, name, workbench_id, deleted_at FROM position_instance WHERE id = ?',
        [id],
      );
      if (!p) throw new Error(`阶段不存在：#${id}`);
      if (!p.deleted_at) throw new Error(`阶段「${p.name}」不在回收站里（它不是被删除的）`);
      // 父工作台可能也还在回收站里，所以这里同样不能加 `deleted_at IS NULL`
      const wb = get<{ name: string; deleted_at: string | null }>(
        'SELECT name, deleted_at FROM workbench WHERE id = ?',
        [p.workbench_id],
      );
      if (!wb) {
        throw new Error(`不能恢复：阶段「${p.name}」所属的工作台（#${p.workbench_id}）已被彻底删除。请先恢复工作台`);
      }
      const warnings: string[] = [];
      if (wb.deleted_at) warnings.push(`所属工作台「${wb.name}」还在回收站里，请一并恢复`);
      clearDeleted('position_instance', id);
      return { restored: true as const, kind, id, warnings };
    }

    case 'field': {
      // 字段的删除态由 `deleted_at`（迁移 015）与 `archived_at`（004 就有）共同表达，
      // 这里要读回收站里那条，因此查 `deleted_at IS NOT NULL` 而不是 `deleted_at IS NULL`
      const f = get<{ id: number; field_key: string; label: string; deleted_at: string | null; seed: number }>(
        'SELECT id, field_key, label, deleted_at, seed FROM archive_field WHERE id = ?',
        [id],
      );
      if (!f) throw new Error(`字段不存在：#${id}`);
      if (!f.deleted_at) throw new Error(`字段「${f.label}」不在回收站里（它不是被删除的）`);
      if (f.seed) throw new Error(`「${f.label}」是系统必备字段，不通过回收站恢复（它不该被删除，请在启动后由系统自检补回）`);
      /**
       * 字段的 `deleted_at` 与 `archived_at` 是**一起写的**（删除时两列同时置时间），
       * 恢复时也要一起清 —— 只清一列的话，按 `archived_at` 过滤的老路径仍然看不到它。
       */
      tx(() => {
        run('UPDATE archive_field SET deleted_at = NULL, archived_at = NULL WHERE id = ?', [id]);
      });
      return { restored: true as const, kind, id, warnings: [] };
    }

    default: {
      // 同上：要读的是回收站里那条别名（deleted_at IS NOT NULL），不加 `deleted_at IS NULL`
      const al = get<{ id: number; var_name: string; deleted_at: string | null }>(
        'SELECT id, var_name, deleted_at FROM archive_alias WHERE id = ?',
        [id],
      );
      if (!al) throw new Error(`别名不存在：#${id}`);
      if (!al.deleted_at) throw new Error(`别名「${al.var_name}」不在回收站里（它不是被删除的）`);
      // 冲突判定要连回收站里的同名别名一起看：不能只查 `deleted_at IS NULL` 的那批
      const clash = get<{ id: number; deleted_at: string | null }>(
        'SELECT id, deleted_at FROM archive_alias WHERE var_name = ? AND id <> ?',
        [al.var_name, id],
      );
      if (clash && !clash.deleted_at) {
        throw new Error(`不能恢复：变量「${al.var_name}」已经有另一条在用别名（#${clash.id}），先删掉它或改个变量名`);
      }
      clearDeleted('archive_alias', id);
      return { restored: true as const, kind, id, warnings: [] };
    }
  }
}

/* ============================== 彻底删除 ============================== */

export interface PurgeResult {
  purged: true;
  filesRemoved: number;
  /**
   * 按安全阀**跳过**的磁盘文件与原因（只读来源 / 内容与登记不符 / 还被在用记录引用）。
   * 有值时界面必须把原因说出来 —— "说了彻底删除却一个文件没删掉"最让人摸不着头脑。
   */
  skipped?: string[];
}

/**
 * 磁盘文件是否还在（按记录**自己的来源身份**现算，与 store.artifactAbsPath 同口径）。
 * 不 import store.ts 是为了避免循环依赖，定位那一层共用 `core/paths.ts` 的 `artifactFileAbs()`：
 *   · 有 `root_id` → 按登记时那个根；改绑资料目录不会让这条记录指到别的目录的同名文件上；
 *   · 老记录（NULL）→ 按 root_kind + 工作台当前绑定（与改造前一致）。
 * 定位不到（工作台没了 / 已解绑 / 越界）返回 null，调用方按"磁盘文件已不在"处理。
 */
function artifactAbsPathFor(info: ArtifactFileInfo): string | null {
  const rel = (info.file_rel ?? '').replace(/\\/g, '/');
  if (!rel) return null;
  let externalRoot: string | null = null;
  if (!parseRootId(info.root_id) && (info.root_kind ?? 'data') === 'external') {
    if (!info.workbench_id) return null;
    // 有意不守卫：要读的正是回收站里那份工作台的绑定根，所以这里不加 `deleted_at IS NULL`
    const wb = get<{ external_root: string | null }>(
      'SELECT external_root FROM workbench WHERE id = ?',
      [info.workbench_id],
    );
    externalRoot = (wb?.external_root ?? '').trim() || null;
    if (!externalRoot) return null;
  }
  try {
    return artifactFileAbs({ file_rel: rel, root_kind: info.root_kind, root_id: info.root_id, externalRoot });
  } catch {
    return null;
  }
}

/**
 * `artifact.root_id` 这一列在不在（本次授权改造新增，见 `core/store.ts` 的
 * `ensureArtifactIdentitySchema`）。老库 / 补列失败时降级成 `NULL AS root_id`：
 * 读回收站、恢复、彻底删除都照常可用，只是这条记录按老口径（当前绑定）定位。
 */
let artifactRootIdColumn: boolean | null = null;

function artifactHasRootId(): boolean {
  if (artifactRootIdColumn !== null) return artifactRootIdColumn;
  try {
    artifactRootIdColumn = Boolean(
      get<{ name: string }>("SELECT name FROM pragma_table_info('artifact') WHERE name = 'root_id'"),
    );
  } catch {
    artifactRootIdColumn = false;
  }
  return artifactRootIdColumn;
}

/** artifact 记录里"定位 + 指纹"需要的列（root_id 缺列时给 NULL，别让整条 SQL 报 no such column） */
function fileCols(): string {
  return artifactHasRootId() ? 'root_id, size_bytes, sha256' : 'NULL AS root_id, size_bytes, sha256';
}

/**
 * 这份文件是不是**还被别的存活（未软删除）artifact 记录指着的**。
 *
 * 为什么必须有这一道：工作台进回收站后**仍然占着它的资料目录**（占用判定不再过滤软删除，
 * 见 `domain/service.ts`），所以正常路径下不会出现"两个工作台共用一个目录"。
 * 但存量数据里可能已经存在这种状态（旧版本正是在这里放行的），此时"彻底删除回收站里的旧工作台"
 * 会把**新工作台正在用的文件**一起 unlink 掉 —— 直接删掉用户的在册数据。
 * 所以按绝对路径核对：还有别人指着它，就不删磁盘。
 *
 * 判据只看路径归属（谁的根 + 相对路径），不看内容：内容相同的两份不同文件不该互相拦。
 * @returns 指出引用它的记录描述；没有则返回 null
 */
function otherLiveRefOf(info: ArtifactFileInfo): string | null {
  const target = artifactAbsPathFor(info);
  if (!target) return null;
  // 同一相对路径的记录才可能撞上（先用 file_rel 收窄，再逐条按各自的根定位核对）
  const rows = all<ArtifactFileInfo & { deleted_at: string | null }>(
    `SELECT id, workbench_id, file_rel, root_kind, ${fileCols()}, deleted_at
       FROM artifact WHERE file_rel = ? AND id <> ?`,
    [info.file_rel, info.id],
  );
  for (const r of rows) {
    // 回收站里的记录不算"在用"（它自己都等着被清）；只有存活记录才拦
    if (r.deleted_at) continue;
    const abs = artifactAbsPathFor(r);
    if (abs && samePathKey(abs, target)) {
      return r.workbench_id ? `artifact #${r.id}（工作台 #${r.workbench_id}）` : `artifact #${r.id}`;
    }
  }
  return null;
}

/** `otherLiveRefOf` 的抛错版本：被别的存活记录指着就拒绝删磁盘 */
export function assertNoOtherLiveArtifactRefers(info: ArtifactFileInfo): void {
  const by = otherLiveRefOf(info);
  if (by) {
    throw new SafetyRefusal(`这份文件还被在用的记录引用着（${by}），拒绝连同磁盘文件一起删除`);
  }
}

function artifactFileExists(info: ArtifactFileInfo): boolean {
  try {
    const abs = artifactAbsPathFor(info);
    return Boolean(abs && existsSync(abs));
  } catch {
    return false;
  }
}

/**
 * 删文件后收走空目录：**最多收到允许根本身之下**，绝不删根本身（契约 §7.3）
 */
function pruneEmptyDirsUpTo(abs: string): void {
  const stop = grantOf(abs)?.root;
  if (!stop) return;
  let dir = dirname(abs);
  while (dir !== stop && isInsideRoot(stop, dir)) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/**
 * 删掉一条 artifact 记录的磁盘文件（如果还在）—— 与 `store.deleteArtifact({withFile:true})`
 * **共用同一套安全阀**（`core/paths.ts` 的 `assertDeletableFile`）：
 *   ① 必须命中允许根（不在白名单里的绝对路径一律不碰）；
 *   ② **只读来源里的文件绝不删**（iCloud 原件 / 显式声明的只读来源）；
 *   ③ 绑定根 / 工作台根本身绝不删；
 *   ④ 有登记指纹时，磁盘内容（大小 + sha256）必须与登记时一致 ——
 *      改绑目录后同一个相对路径可能指向用户自己放着、平台从没登记过的原件；
 *   ⑤ 还被别的**存活**记录指着的文件不删（`assertNoOtherLiveArtifactRefers`）。
 *
 * 返回 `{ removed, skipped }`：跳过不是错误 —— 记录照样清掉，但原因必须回报给用户
 * （"彻底删除时磁盘文件一个都没删掉，用户还不知道为什么"是这次要修的毛病之一）。
 */
function removeArtifactFile(info: ArtifactFileInfo): { removed: number; skipped: string | null } {
  const abs = artifactAbsPathFor(info);
  if (!abs) return { removed: 0, skipped: null };
  if (!existsSync(abs)) return { removed: 0, skipped: null };
  assertDeletableFile(abs, info, '文件');
  assertNoOtherLiveArtifactRefers(info);
  unlinkSync(abs);
  pruneEmptyDirsUpTo(abs);
  return { removed: 1, skipped: null };
}

/**
 * 「彻底删除」这一步真正清库行的**唯一出口**。
 *
 * 为什么单独抽成一个函数、而不是把 `DELETE FROM <受软删除影响的表>` 散在各分支里：
 *   1. 这是全项目里**唯一一处故意不加 `deleted_at IS NULL` 过滤**的删除 —— 彻底删除的语义
 *      就是"连同回收站里的行一起清干净"，只删 `deleted_at IS NULL` 的那些会留下孤儿行。
 *      集中在这里，`deleted_at` 与它相反的口径（`deleted_at IS NOT NULL` / 无过滤）一眼可查，
 *      不会有人看到一个没有守卫的 `FROM workbench` 以为是漏了；
 *   2. 彻底删除必须**先软删除过**（各分支已各自校验过 `deleted_at` 非空），
 *      所以这里不存在"绕过确认直接真删"的路径。
 *
 * 表名走白名单常量，不接受调用方传任意表名。
 */
const PURGEABLE_TABLES = new Set(['workbench', 'artifact', 'position_instance', 'archive_field', 'archive_alias']);

function purgeRows(table: string, where: string, params: (string | number)[]): number {
  if (!PURGEABLE_TABLES.has(table)) throw new Error(`拒绝清理非白名单表：${table}`);
  if(table==='position_instance' && get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='quick_todo'"))
    run(`UPDATE quick_todo SET position_id=NULL WHERE position_id IN (SELECT id FROM position_instance WHERE ${where})`,params);
  if (table === 'artifact') {
    if (get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='timesheet_run'")) {
      run(`UPDATE timesheet_run SET artifact_id=NULL,status='draft' WHERE artifact_id IN (SELECT id FROM artifact WHERE ${where})`,params);
      run(`UPDATE period_material SET artifact_id=NULL,status='missing' WHERE artifact_id IN (SELECT id FROM artifact WHERE ${where})`,params);
    }
    // 事实核对快照属于文件本身；迁移 025 的外键没有配置级联删除。
    // 单文件与整工作台清理共用此入口，且必须在调用方事务内一起完成。
    if (get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_fact_review'")) {
      run(`DELETE FROM artifact_fact_review WHERE artifact_id IN (SELECT id FROM artifact WHERE ${where})`, params);
    }
  }
  // 这里**故意不加** `deleted_at IS NULL`：彻底删除要连回收站里的行一起清掉
  return Number(run(`DELETE FROM ${table} WHERE ${where}`, params).changes);
}

/**
 * 从回收站**彻底删除**一条记录 —— 这才是真的删：库记录 + 磁盘文件一起去。
 *
 * 删除范围（与软删除刻意不同）：
 *   · workbench → 该工作台的阶段实例、清单项、文件记录（含磁盘文件）、生成日志、档案提议，
 *     最后是工作台行本身。磁盘上只删**平台登记过的文件**，用户自己放进去的其它文件一个不碰；
 *     绑定型工作台**绝不 `rmSync` 绑定根**，只回收平台建的 `_` 前缀空目录。
 *   · artifact  → 一条记录 + 它的磁盘文件。
 *   · position  → 阶段实例 + 它下面的清单项（文件记录不动：文件挂在清单上是弱引用，
 *     直接删掉用户的文件太狠，界面上那些文件会变成"未关联"）。
 *   · field/alias → 一条定义行。
 *
 * 前置要求：**记录必须已经在回收站里**。没软删过就直接彻底删，等于绕过所有确认，
 * 这里明确拒绝；请先「移到回收站」。
 */
export function purgeFromTrash(kind: string, id: number, opts: { withFile?: boolean } = {}): PurgeResult {
  if (!isTrashKind(kind)) throw new Error(`不认识的回收站类型：${kind}（可用：${TRASH_KINDS.join(' / ')}）`);
  const table = KIND_TABLE[kind];
  if (!tableHasDeletedAt(table)) {
    throw new Error(`数据库还没有回收站功能（缺迁移 015），无法彻底删除，请先重启以完成数据库升级`);
  }
  // 默认**带文件**：彻底删除的语义就是"连磁盘一起清掉"；显式 withFile:false 时只删记录
  const withFile = opts.withFile !== false;

  if (kind === 'workbench') {
    // 要读的就是回收站里那条工作台（deleted_at IS NOT NULL），不是常规的 `deleted_at IS NULL`
    const wb = get<{ id: number; name: string; code: string; deleted_at: string | null; external_root: string | null; folder_path: string }>(
      'SELECT id, name, code, deleted_at, external_root, folder_path FROM workbench WHERE id = ?',
      [id],
    );
    if (!wb) return { purged: true, filesRemoved: 0 };
    if (!wb.deleted_at) throw new Error(`工作台「${wb.name}」还没有移到回收站，不能直接彻底删除。请先删除它（移到回收站），再在回收站里彻底删除`);
    const bound = Boolean((wb.external_root ?? '').trim());
    // 这份工作台名下的全部文件记录（含已软删除的，正是要一起清掉的那批）
    // 有意不守卫：这里要读的就是回收站里（deleted_at IS NOT NULL）的记录，好连磁盘文件一起删
    const files = all<ArtifactFileInfo & { file_rel: string }>(
      `SELECT id, workbench_id, file_rel, root_kind, ${fileCols()} FROM artifact WHERE workbench_id = ?`,
      [id],
    );
    let filesRemoved = 0;
    const unlocatable: string[] = [];
    const skipped: string[] = [];
    if (withFile) {
      for (const f of files) {
        try {
          const r = removeArtifactFile(f);
          filesRemoved += r.removed;
          if (r.skipped) skipped.push(`${f.file_rel}（${r.skipped}）`);
        } catch (e) {
          // 单个文件删不掉（被占用 / 权限 / 越界）：记录照样清掉，但要说清楚是哪一份
          unlocatable.push(`${f.file_rel}（${(e as Error).message}）`);
        }
      }
      if (bound) recyclePlatformDirs(id);
    }
    /**
     * 真删这一段**故意不带** `deleted_at IS NULL`：彻底删除要清掉这份工作台名下的**全部**行，
     * 包括已经在回收站里的子记录 —— 只删 `deleted_at IS NULL` 的那些会留下孤儿行（外键会报错或留脏数据）。
     */
    tx(() => {
      run('DELETE FROM artifact_search WHERE wb_id = ?', [id]);
      // Remove owned execution records before their parent/stage/file rows.
      // Shared XLSX input copies remain available to other calculation records.
      if(get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_period'")){
        run('DELETE FROM quick_todo WHERE workbench_id=?',[id]);
        run('DELETE FROM timesheet_run WHERE workbench_id=?',[id]);
        run('DELETE FROM workflow_event WHERE period_id IN (SELECT id FROM work_period WHERE workbench_id=?)',[id]);
        run('DELETE FROM period_material WHERE period_id IN (SELECT id FROM work_period WHERE workbench_id=?)',[id]);
        run('UPDATE artifact SET work_period_id=NULL WHERE work_period_id IN (SELECT id FROM work_period WHERE workbench_id=?)',[id]);
        run('UPDATE agent_memory SET period_id=NULL WHERE period_id IN (SELECT id FROM work_period WHERE workbench_id=?)',[id]);
        // Remove inspection references before periods; draft/history rows cascade with their period.
        run('UPDATE artifact SET inspection_id=NULL WHERE inspection_id IN (SELECT i.id FROM inspection_record i JOIN work_period p ON p.id=i.period_id WHERE p.workbench_id=?)',[id]);
        run('DELETE FROM inspection_record WHERE period_id IN (SELECT id FROM work_period WHERE workbench_id=?)',[id]);
        run('DELETE FROM work_period WHERE workbench_id=?',[id]);
        run('DELETE FROM work_period_rule WHERE workbench_id=?',[id]);
      }
      // 阶段与清单（含已软删除的 deleted_at IS NOT NULL 行）全部删掉
      run('DELETE FROM checklist_item WHERE position_instance_id IN (SELECT id FROM position_instance WHERE workbench_id = ?)', [id]);
      // 阶段实例：不按 deleted_at IS NULL 过滤，彻底删除就是清干净
      purgeRows('position_instance', 'workbench_id = ?', [id]);
      // 文件记录：同样连回收站里的一起清（磁盘文件已在上面按登记记录删过）
      purgeRows('artifact', 'workbench_id = ?', [id]);
      run('DELETE FROM generation_log WHERE workbench_id = ?', [id]);
      run('DELETE FROM archive_proposal WHERE workbench_id = ?', [id]);
      run('DELETE FROM agent_memory WHERE workbench_id = ?', [id]);
      // 工作台行：最后删（它一删，子行靠外键级联也没了）
      purgeRows('workbench', 'id = ?', [id]);
    });
    if (unlocatable.length) {
      console.warn(`[回收站] 工作台 #${id} 彻底删除时 ${unlocatable.length} 份文件未能从磁盘删除：${unlocatable.join('；')}`);
    }
    /**
     * 被安全阀跳过的（只读来源 / 指纹不符 / 还被在用记录引用）**必须回报给调用方**：
     * "彻底删除说删了几个磁盘文件"与实际不符时，用户至少能看到为什么没删。
     */
    if (skipped.length) {
      console.warn(`[回收站] 工作台 #${id} 彻底删除时按规则跳过了 ${skipped.length} 份磁盘文件：${skipped.join('；')}`);
    }
    // 工作台没了，它贡献的允许根也要撤掉
    if (bound) {
      try {
        void import('../domain/service.ts').then((m) => m.reloadBoundRoots()).catch(() => undefined);
      } catch {
        /* 下次启动会重算 */
      }
    }
    return { purged: true, filesRemoved, skipped: skipped.length ? skipped : undefined };
  }

  if (kind === 'artifact') {
    // 要读的是回收站里那条文件记录（deleted_at IS NOT NULL），因此不加常规守卫
    const a = get<ArtifactFileInfo>(
      // 这一处**故意不加** `deleted_at IS NULL` 守卫（回收站要读的就是已软删除的行）
      `SELECT id, workbench_id, file_rel, root_kind, ${fileCols()} FROM artifact WHERE id = ?`,
      [id],
    );
    if (!a) return { purged: true, filesRemoved: 0 };
    // 必须有 deleted_at 才能彻底删除：没软删过就直接真删，等于绕过"先移到回收站"这道确认
    const deleted = get<{ deleted_at: string | null }>(
      // 这一处**故意不加** `deleted_at IS NULL` 守卫（回收站要读的就是已软删除的行）
      'SELECT deleted_at FROM artifact WHERE id = ?',
      [id],
    );
    if (!deleted?.deleted_at) throw new Error('这份文件还没有移到回收站，不能直接彻底删除。请先删除它（移到回收站），再在回收站里彻底删除');
    let filesRemoved = 0;
    const skipped: string[] = [];
    if (withFile) {
      const r = removeArtifactFile(a);
      filesRemoved += r.removed;
      if (r.skipped) skipped.push(`${a.file_rel}（${r.skipped}）`);
    }
    tx(() => {
      run('DELETE FROM artifact_search WHERE id = ?', [id]);
      // 彻底删除：不按 deleted_at IS NULL 过滤，这条记录本身就在回收站里
      purgeRows('artifact', 'id = ?', [id]);
    });
    if (skipped.length) console.warn(`[回收站] 文件 #${id} 彻底删除时按规则跳过了磁盘文件：${skipped.join('；')}`);
    return { purged: true, filesRemoved, skipped: skipped.length ? skipped : undefined };
  }

  if (kind === 'position') {
    // 回收站里的那条阶段（deleted_at IS NOT NULL）
    const p = get<{ id: number; name: string; deleted_at: string | null }>(
      // 这一处**故意不加** `deleted_at IS NULL` 守卫（回收站要读的就是已软删除的行）
      'SELECT id, name, deleted_at FROM position_instance WHERE id = ?',
      [id],
    );
    if (!p) return { purged: true, filesRemoved: 0 };
    if (!p.deleted_at) throw new Error(`阶段「${p.name}」还没有移到回收站，不能直接彻底删除。请先删除它（移到回收站）`);
    tx(() => {
      run('DELETE FROM checklist_item WHERE position_instance_id = ?', [id]);
      // 彻底删除：这条阶段就在回收站里，故不按 deleted_at IS NULL 过滤
      purgeRows('position_instance', 'id = ?', [id]);
    });
    return { purged: true, filesRemoved: 0 };
  }

  if (kind === 'field') {
    // 回收站里的那条字段（deleted_at IS NOT NULL）
    const f = get<{ id: number; label: string; field_key: string; seed: number; deleted_at: string | null }>(
      // 这一处**故意不加** `deleted_at IS NULL` 守卫（回收站要读的就是已软删除的行）
      'SELECT id, label, field_key, seed, deleted_at FROM archive_field WHERE id = ?',
      [id],
    );
    if (!f) return { purged: true, filesRemoved: 0 };
    if (!f.deleted_at) throw new Error(`字段「${f.label}」还没有移到回收站，不能直接彻底删除`);
    if (f.seed) throw new Error(`「${f.label}」是系统必备字段，不允许彻底删除（系统重启会重新种回，等于没删）`);
    tx(() => {
      // 字段没了，指向它的别名映射也留不住（否则出文书时会指向一个不存在的字段）
      run('DELETE FROM archive_alias WHERE field_key = ?', [f.field_key]);
      // 彻底删除：这条字段就在回收站里，故不按 deleted_at IS NULL 过滤
      purgeRows('archive_field', 'id = ?', [id]);
    });
    return { purged: true, filesRemoved: 0 };
  }

  // 回收站里的那条别名（deleted_at IS NOT NULL）
  const al = get<{ var_name: string; deleted_at: string | null }>(
    // 这一处**故意不加** `deleted_at IS NULL` 守卫（回收站要读的就是已软删除的行）
    'SELECT var_name, deleted_at FROM archive_alias WHERE id = ?',
    [id],
  );
  if (!al) return { purged: true, filesRemoved: 0 };
  if (!al.deleted_at) throw new Error(`别名「${al.var_name}」还没有移到回收站，不能直接彻底删除`);
  // 彻底删除：这条别名就在回收站里，故不按 deleted_at IS NULL 过滤
  purgeRows('archive_alias', 'id = ?', [id]);
  return { purged: true, filesRemoved: 0 };
}

/**
 * 彻底删掉一个绑定型工作台之前，回收**平台自己建的**空目录。
 *
 * 与 `domain/service.ts` 里那份保守判定同源，但这里不去 import 它（避免循环依赖）：
 * 只在**非空不删、不在绑定根内不删、绑定根本身不删、只删 `_` 前缀或 `NN_` 形状的目录**
 * 四条同时成立时动手。用户自己的目录与非空文件夹一个都不碰。
 */
function recyclePlatformDirs(workbenchId: number): void {
  // 连回收站里的阶段一起看（deleted_at IS NOT NULL 的那些也要回收目录），故不加 `deleted_at IS NULL`
  const rows = all<{ id: number; workbench_id: number; seq: number; name: string; folder_rel: string | null; code: string }>(
    'SELECT id, workbench_id, seq, name, folder_rel, code FROM position_instance WHERE workbench_id = ?',
    [workbenchId],
  );
  // 绑定根：目录回收到此为止，绝不删根（契约 §7.1/§7.3）
  // 这里也不加 `deleted_at IS NULL`：这份工作台本身就在回收站里，要读的正是它的 external_root
  const wb = get<{ external_root: string | null }>(
    'SELECT external_root FROM workbench WHERE id = ?',
    [workbenchId],
  );
  const root = (wb?.external_root ?? '').trim();
  if (!root) return;
  const candidates: string[] = [];
  for (const p of rows) {
    const rel = (p.folder_rel ?? '').trim();
    if (!rel) continue;
    const abs = join(root, rel);
    if (!isInsideRoot(root, abs)) continue;
    if (/^\d+_/.test(abs.split(/[\\/]/).pop() ?? '')) candidates.push(abs);
    for (const sub of ['_生成文书', '_影像证据', '_原始资料']) candidates.push(join(abs, sub));
  }
  const uniq = [...new Set(candidates)].sort((a, b) => b.split(/[\\/]/).length - a.split(/[\\/]/).length);
  for (const dir of uniq) {
    try {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      if (readdirSync(dir).length > 0) continue;
      if (!isInsideRoot(root, dir) || samePathKey(root, dir)) continue;
      rmdirSync(dir);
    } catch {
      /* 不空 / 占用 / 无权限：跳过（宁可不删） */
    }
  }
}

/* ============================== 清空回收站 ============================== */

export interface EmptyTrashResult {
  purged: number;
  filesRemoved: number;
  /** 按安全阀跳过的磁盘文件（只读来源 / 内容与登记不符 / 还被在用记录引用） */
  skipped?: string[];
}

/**
 * 清空回收站。
 *
 * @param olderThanDays 只清掉"删除时间早于 N 天"的记录（定期清理用）；不传 = 全清。
 * 按记录逐条走 `purgeFromTrash` —— 那里有全部安全阀，清空不能成为绕过安全阀的后门。
 */
export function emptyTrash(olderThanDays?: number): EmptyTrashResult {
  const cutoff = olderThanDays === undefined ? null : new Date(Date.now() - olderThanDays * 86400000).toISOString();
  let purged = 0;
  let filesRemoved = 0;
  const skipped: string[] = [];
  const entries = listTrash({ limit: 2000 });
  for (const e of entries) {
    if (cutoff && e.deletedAt >= cutoff) continue;
    try {
      const r = purgeFromTrash(e.kind, e.id, { withFile: true });
      purged += 1;
      filesRemoved += r.filesRemoved;
      if (r.skipped?.length) skipped.push(...r.skipped);
    } catch (err) {
      console.warn(`[回收站] 清空时跳过 ${e.kind} #${e.id}：${(err as Error).message}`);
    }
  }
  return { purged, filesRemoved, skipped: skipped.length ? skipped : undefined };
}

/** 回收站规模（界面上的角标/概览用） */
export function trashCount(): number {
  let n = 0;
  for (const kind of TRASH_KINDS) {
    if (!tableHasDeletedAt(KIND_TABLE[kind])) continue;
    n += get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${KIND_TABLE[kind]} WHERE deleted_at IS NOT NULL`)?.n ?? 0;
  }
  return n;
}
