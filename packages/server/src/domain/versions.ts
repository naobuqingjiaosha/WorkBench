import {syncEvidence} from '../core/checklist.ts';
import { requirePeriod } from './periods.ts';
import {assertDocumentIdle,withDocumentWrite} from './document-write.ts';
/**
 * 生成文书的版本链与「最终版」标记（B1-4，迁移 017）
 *
 * 解决的是这件事：同一份文书改三遍，磁盘上是 `XXX_v1.docx` / `XXX_v2.docx` / `XXX_v3.docx`
 * 三个**并列的独立文档**，"这是同一份的三个版本"这个概念在库里不存在，于是"哪份是最终版"
 * 只能靠文件名猜（`artifact.version` 列从 001 起就有，但一直没有写入路径）。
 *
 * 三条口径（写死在这里，别在别处再判一次）：
 *   1. **一条链 = 一个 `version_group`（uuid）**。链的归属键是
 *      `工作台 + 模板 + 清单项 + 阶段 + 期次`（五元组）：
 *      · 前三个是 docs/11 B1-4 写死的三元组；
 *      · 第 4 个（`position_code`）是本实现**有意加的** —— 同一份模板在两个阶段各出一份，
 *        在用户眼里是两份不同的文书，按 docs/11 风险③「宁可多一条链也不错串」的口径，
 *        宁可把键收紧（多一条链），也不要把两个阶段的文书串成一份的三个版本。
 *      · 第 5 个（`period_key`，迁移 022 的列）是**缺陷修复补上的**：月报这类
 *        "同模板按月上交"的文书，缺了期次就是同一条链 —— 9 月一标定稿，
 *        10 月连"更新这一版"都进不来。期次取该阶段的 `period_dir` 规则 × 工作台当前期次
 *        （`resolvePeriodKey()`，与落盘目录 `positionPeriodDirAbs` 同一套口径，**只读**）。
 *      · 键里出现 NULL 时用 `IS ?` 比较（SQLite 的 `=` 对 NULL 恒不成立）；
 *        `workbench_id` 为 NULL（没有工作台的生成件）时不归链（新建组），
 *        因为"同一份工作台的同一份文书"这个前提不成立。
 *
 * 历史缺少期次的版本保持原归属；新期次只匹配相同键，不自动认领无期次老链。
 *
 * 【revision 按链各自计数】：链 = 一份"某一期的那份文书"，所以 revision 是**每期各自**
 * 从 1 开始（`nextRevision(group)` 只看本 group，含已软删的版本号，永不复用）。
 * 月报的 9 月链是 v1/v2…，10 月链同样从 v1 开始 —— 跨期不是同一份文书的第 N 版。
 * 用户要"这是这个模板的第几期第几版"时看的是（期次, revision）这个二元组。
 *   2. **旧版本文件一律搬到 `<正式文件所在目录>/.versions/<group>/v<N>.<ext>`**
 *      （docs/11 原文就是 `_生成文书/.versions/<group>/v<N>.docx`），新版本占据正式文件名。
 *      正式文件名里的 `_v<N>` 跟着 revision 走（命名规范见 `core/paths.ts` 的
 *      `{时间戳}_{模板名}_v{N}.{ext}`），时间戳那段沿用这条链的，**只有 `_vN` 会变** ——
 *      一份文书从头到尾只有一个"正式文件"，版本号一眼能看出来。
 *      `.versions` 以点开头，`docs/10` §12.5 已经把点开头的目录划给平台自己（不参与命名整理、
 *      也不会被「扫描文件夹」纳管）。
 *   3. **移动只针对平台自己生成、且库里有 `artifact` 记录的正式文件**；用户自己拷进绑定目录的
 *      文件一个都不改名、不移动（契约 §11 / §12.4）。移动后**同步改库里的 `file_rel`**，
 *      所以旧版本仍然可下载、可回滚，不是"只剩一条记录"。
 *
 * 老库降级：迁移 017 没跑（缺列）时 `ensureDocVersionSchema()` 返回 false，
 * 调用方退回改造前的行为，读接口给一句明确的话，而不是 500（与本项目其它"老库防呆"同口径）。
 */
import { assertFinalArtifact } from './finalization.ts';
import {documentSourceSignature} from './document-source.ts';
import {reviewMemoryFacts} from './memory-facts.ts';
import { inheritBusinessEvidence } from './business-evidence.ts';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { all, get, run, tx } from '../db/index.ts';
import { artifactAbsPath, sha256, type Artifact, type SaveArtifactResult } from '../core/store.ts';
import { liveFilter } from '../core/trash.ts';
import { assertUsable, ensureDir, generatedFileName, relativeToRoot, safeName } from '../core/paths.ts';
import { normalizePeriodSpec, periodDirName } from '../core/period-dir.ts';
import { getWorkbench, workbenchDuePeriod } from './service.ts';

/* ============================== 迁移 017 / 022 的列 ============================== */

/**
 * 迁移 `017_doc_version.sql` / `022_doc_version_final_unique.sql` 里的每一条 `ADD COLUMN`，
 * 在这里逐条列出来做探测。
 * **两份清单必须逐字一致**：迁移文件是常规路径，这里是"手工补跑 / 副本缺记录"的兜底路径，
 * 谁少了谁就会在运行时炸 `no such column`。
 */
const COLUMN_PLAN: { table: string; column: string; ddl: string }[] = [
  { table: 'artifact', column: 'version_group', ddl: 'ALTER TABLE artifact ADD COLUMN version_group TEXT' },
  { table: 'artifact', column: 'revision', ddl: 'ALTER TABLE artifact ADD COLUMN revision INTEGER NOT NULL DEFAULT 1' },
  { table: 'artifact', column: 'supersedes_id', ddl: 'ALTER TABLE artifact ADD COLUMN supersedes_id INTEGER' },
  { table: 'artifact', column: 'is_final', ddl: 'ALTER TABLE artifact ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0' },
  { table: 'artifact', column: 'final_at', ddl: 'ALTER TABLE artifact ADD COLUMN final_at TEXT' },
  { table: 'artifact', column: 'period_key', ddl: 'ALTER TABLE artifact ADD COLUMN period_key TEXT' },
  { table: 'generation_log', column: 'version_group', ddl: 'ALTER TABLE generation_log ADD COLUMN version_group TEXT' },
  { table: 'generation_log', column: 'revision', ddl: 'ALTER TABLE generation_log ADD COLUMN revision INTEGER' },
  { table: 'generation_log', column: 'prev_artifact_id', ddl: 'ALTER TABLE generation_log ADD COLUMN prev_artifact_id INTEGER' },
];

/**
 * 把同链多个定稿归并成一个，返回值是**被清掉的行数**（0 = 本来就没问题）。
 *
 * 判据与 `findFinalInChain()` 逐字一致：「活着的行里 revision 最大、同 revision 取 id 最大」。
 * 为什么不挑"最早定稿的那个"：读路径显示的就是这条，清完之后唯一索引里的那一行必须
 * 跟界面显示的定稿是同一条，否则用户会看到"锁在 v3、库里定稿是 v2"。
 * 软删行不参与（部分唯一索引 `WHERE deleted_at IS NULL` 也不把它算进去）。
 * **幂等**：没有任何"不是 keeper 的活定稿"时就是 0 行。
 */
export function normalizeChainFinals(): number {
  const r = run(
    `UPDATE artifact
        SET is_final = 0, final_at = NULL
      WHERE is_final = 1 AND deleted_at IS NULL AND version_group IS NOT NULL
        AND id <> (
          SELECT k.id FROM artifact k
           WHERE k.version_group = artifact.version_group
             AND k.is_final = 1 AND k.deleted_at IS NULL
           ORDER BY k.revision DESC, k.id DESC LIMIT 1
        )`,
  );
  return r.changes;
}

/**
 * 定稿唯一性的部分唯一索引（迁移 022）。
 *
 * 为什么要有"代码兜底里的硬约束"：markFinal 的"先清后置"只保护走它自己的那条路，
 * 并发、脚本、中断后的半截态都能绕过。索引一建，数据库层面就只可能有一个定稿。
 * 建之前**必须先归并存量**（否则库里已有的同链多定稿会让 CREATE INDEX 直接失败）。
 */
function ensureFinalUniqueIndex(): boolean {
  try {
    normalizeChainFinals();
    run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifact_final_unique ON artifact(version_group)
        WHERE is_final = 1 AND deleted_at IS NULL`,
    );
    return true;
  } catch (e) {
    // 建不出来（只读库 / 约束冲突）时**不抛给用户**：行为退回"代码保证唯一"，
    // 并在启动日志里说清是哪一步没做成，而不是假装有约束。
    console.warn(`[文书版本] 定稿唯一索引不可用，本次按"代码保证同链唯一"处理：${(e as Error).message}`);
    return false;
  }
}

let schemaReady: boolean | null = null;
let finalIndexReady: boolean | null = null;

/**
 * 版本链的列能不能用。**幂等**：逐列 `pragma_table_info` 探测，缺哪列补哪列
 * （SQLite 没有 `ADD COLUMN IF NOT EXISTS`，所以只能这样写）；结果缓存，迁移后重启自动生效。
 * 表名与列名都来自上面的常量清单，没有任何地方能把它拼成别的表。
 */
export function ensureDocVersionSchema(): boolean {
  if (schemaReady !== null) return schemaReady;
  try {
    for (const p of COLUMN_PLAN) {
      const has = Boolean(get<{ name: string }>(`SELECT name FROM pragma_table_info('${p.table}') WHERE name = ?`, [p.column]));
      if (!has) run(p.ddl);
    }
    run('CREATE INDEX IF NOT EXISTS idx_artifact_version_group ON artifact(version_group, revision)');
    run(
      `CREATE INDEX IF NOT EXISTS idx_artifact_chain_identity
         ON artifact(workbench_id, template_id, checklist_item_id, position_code, period_key)`,
    );
    schemaReady = true;
  } catch (e) {
    // 补列失败（只读库、权限…）：不抛给用户，退回改造前行为，并在启动日志里说清楚
    console.warn(`[文书版本] 版本链的列不可用，本次按改造前行为处理（不影响出文书）：${(e as Error).message}`);
    schemaReady = false;
  }
  if (schemaReady) finalIndexReady = ensureFinalUniqueIndex();
  return schemaReady;
}

/** 测试/排障用：丢掉列探测缓存（迁移之后强制重认） */
export function resetDocVersionSchema(): void {
  schemaReady = null;
  finalIndexReady = null;
}

/** 定稿唯一索引在不在（排障/自检用；重试 markFinal 时要靠它分辨"是并发撞索引"还是别的错） */
export function finalUniqueIndexReady(): boolean {
  return finalIndexReady === true;
}

/** 给接口用的一句话：缺迁移时读接口要说的不是 500，而是"先重启一次" */
export const NO_SCHEMA_MESSAGE = '当前数据库还没有文书版本链（缺迁移 017），请重启一次工作台完成升级后再用。';

/**
 * 「用户操作不合法」的版本链错误（定稿不能覆盖、没有这一版、这份文书还没有链…）。
 *
 * 单独一类是为了**状态码正确**：这类错误必须是 400 + 后端原文（界面直接显示那句话），
 * 而不是 500「服务出错了」。路由层见到它就转 400，其余异常照旧按内部错误处理 ——
 * 把"出文书渲染失败"和"这份文书已定稿"混成一个状态码，用户根本不知道该做什么。
 */
export class VersionRuleError extends Error {}

/* ============================== 类型 ============================== */

export type SaveMode = 'new' | 'update' | 'final';

/**
 * `artifact` 行 + 迁移 022 的 `period_key`。
 *
 * `Artifact`（`core/store.ts`，本次改动范围之外）**没有**这一列 —— 那个接口的约定是
 * "只声明所有库都有的列"，迁移补的列由各领域模块自己认。这里用交叉类型声明，
 * 读的时候一律 `?? null`（老库没跑 022 时这个字段是 undefined），
 * 定位列的存在性由 `ensureDocVersionSchema()` 的逐列探测保证。
 */
export type VersionedArtifact = Artifact & { period_key?: string | null };

export interface VersionTarget {
  workbenchId?: number | null;
  templateId: number;
  checklistItemId?: number | null;
  positionCode?: string | null;
  /**
   * 这一期是哪一期（迁移 022 的 `artifact.period_key`）。
   *
   * `undefined`（调用方没给）= 用当前口径现算（`resolvePeriodKey()`，需要 workbenchId）；
   * `null` = 明确"这份文书不按期次分"，只认缺期次的（老）行；
   * 字符串 = 就用这一期（自检/回放这类要指定期次的调用方）。
   */
  periodKey?: string | null;
}

export interface VersionItem {
  id: number;
  revision: number;
  is_final: number;
  final_at: string | null;
  supersedes_id: number | null;
  file_name: string;
  file_rel: string;
  abs_path: string;
  exists: boolean;
  size_bytes: number | null;
  sha256: string | null;
  title: string;
  created_at: string;
  /** 这条是不是请求里给的那一版（界面标「当前」） */
  current: boolean;
  /** 链里 revision 最大的那一版（"正式文件"占的就是它的文件名） */
  head: boolean;
  /** 这一版是怎么出的（ai / manual / hybrid），来自 generation_log */
  mode: string | null;
  /** 迁移前的老生成件：没有版本链，界面显示「v1（未分链）」 */
  unchained: boolean;
}

/* ============================== 期次（链身份的第 5 个键） ============================== */

let periodColumnReady: boolean | null = null;

/** `position_instance` 有没有 `period_dir`（迁移 011）；老库缺列时"期次解析不出来" */
function positionPeriodColumnReady(): boolean {
  if (periodColumnReady === null) {
    try {
      periodColumnReady = Boolean(
        get<{ name: string }>("SELECT name FROM pragma_table_info('position_instance') WHERE name = 'period_dir'"),
      );
    } catch {
      periodColumnReady = false;
    }
  }
  return periodColumnReady;
}

/** 这个阶段的期次规则（与 service.ts 的 positionPeriodSpec 同一套；**只读**，不在此处改它） */
function stagePeriodSpec(templateId: number | null, positionCode: string | null, workbenchId: number): string | null {
  if (!positionPeriodColumnReady()) return null;
  const row=get<{period_dir:string|null}>('SELECT period_dir FROM position_instance WHERE workbench_id=? AND (position_template_id=? OR code=?) AND deleted_at IS NULL',[workbenchId,templateId,positionCode]);
  return normalizePeriodSpec(row?.period_dir ?? null) || null;
}

/**
 * 这次保存的**期次键**（写进 `artifact.period_key`，也是链身份的第 5 段）。
 *
 * 来源（**只读** `service.ts`，不复制它的落盘判断）：
 *   · 规则 = 该阶段模板的 `period_dir`（按 `checklist_item_id` → `position_instance.position_template_id`
 *     → 再按「工作台 + 阶段 code」反查，与 `service.ts:positionPeriodSpec` 同一套）；
 *   · 日期 = 工作台当前期次（`workbenchDuePeriod()`：欠办那一期 → 上次完成的那期 → 实际结束日 → 今天）；
 *   · 名字 = `periodDirName(recurrence, 期次日期, 规则)` —— 与落盘目录 `positionPeriodDirAbs()`
 *     逐字同一个函数、同一组入参，所以"库里的期次"与"磁盘上的期次目录"不会各说一套。
 *
 * @returns 期次名（如 `2026\10月`）；`null` = 不启用期次 → 链身份里这一格为空。
 */
export function resolvePeriodKey(t: {
  workbenchId?: number | null;
  checklistItemId?: number | null;
  positionCode?: string | null;
}): string | null {
  const wbId = t.workbenchId ?? null;
  if (!wbId) return null;
  const wb = getWorkbench(wbId);
  if (!wb) return null;
  const posTemplateId = t.checklistItemId
    ? (get<{ position_template_id: number | null }>(
        'SELECT position_template_id FROM position_instance WHERE workbench_id = ? AND id IN (SELECT position_instance_id FROM checklist_item WHERE id = ?)',
        [wbId, t.checklistItemId],
      )?.position_template_id ?? null)
    : get<{ position_template_id: number | null }>(
        `SELECT position_template_id FROM position_instance
          WHERE workbench_id = ? AND code IS ? AND deleted_at IS NULL LIMIT 1`,
        [wbId, t.positionCode ?? null],
      )?.position_template_id ?? null;
  const spec = stagePeriodSpec(posTemplateId, t.positionCode ?? null, wbId);
  if (!spec) return null;
  return periodDirName(wb.recurrence, workbenchDuePeriod(wb), spec) ?? null;
}

/* ============================== 组与头 ============================== */

/**
 * 这条链的"最新一版"（在用的、未进回收站的）：
 * 同一 `工作台+模板+清单项+阶段+期次` 里 `created_at` 最新的那条生成件。
 *
 * 为什么取"最新"而不是"revision 最大"：同一个键下可能并存**多条链**
 * （用户选过「新建（另一份不同用途）」），这时最新建的那条才是用户当下在改的；
 * 按 revision 取会在两条链之间来回跳。
 *
 * 缺期次历史数据只匹配 NULL 键；明确期次只匹配同期次。
 * 已经归了期的行绝不被跨期认领（否则就回到"9 月定稿挡 10 月"的老毛病）。
 */
export function findChainHead(t: VersionTarget): VersionedArtifact | null {
  if (!ensureDocVersionSchema()) return null;
  if (t.workbenchId === null || t.workbenchId === undefined) return null;
  const periodKey = t.periodKey === undefined ? resolvePeriodKey(t) : t.periodKey;
  const args = [
    t.workbenchId,
    t.templateId,
    t.checklistItemId ?? null,
    t.positionCode ?? null,
    periodKey,
  ];
  const base = `SELECT * FROM artifact
        WHERE kind = 'generated' AND workbench_id = ? AND template_id = ?
          AND checklist_item_id IS ? AND position_code IS ?
          AND ${liveFilter('artifact')}`;
  const exact =
    get<VersionedArtifact>(`${base} AND period_key IS ? ORDER BY created_at DESC, id DESC LIMIT 1`, args) ?? null;
  return exact;

}

/** 这条链的期次（NULL = 不启用期次的老链） */
export function periodKeyOfGroup(group: string): string | null {
  return (
    get<{ period_key: string | null }>(
      'SELECT period_key FROM artifact WHERE version_group = ? AND period_key IS NOT NULL ORDER BY id ASC LIMIT 1',
      [group],
    )?.period_key ?? null
  );
}

/** 一条链里在用的版本（进了回收站的那条不出现在列表里 —— docs/11 B1-4 验收⑤ 的口径） */
export function listLiveVersions(group: string): VersionedArtifact[] {
  return all<VersionedArtifact>(
    `SELECT * FROM artifact WHERE version_group = ? AND kind = 'generated' AND ${liveFilter('artifact')}
      ORDER BY revision ASC, id ASC`,
    [group],
  );
}

/**
 * 这条链上的定稿（最多一个，见 markFinal）。返回它，没有则 null。
 *
 * 【判据是"链上有定稿"，不是"链头是定稿"】：用户完全可能先把 v2 标成定稿、
 * 之后 v3 又出了（v3 出的时候 v2 还没定稿）。如果只看链头，就会出现
 * "v2 是最终版，正式文件却是 v4"这种自相矛盾的状态 —— 定稿标记必须挡住
 * **整条链**的下一次覆盖，而不是只挡住链头那一次。
 */
export function findFinalInChain(group: string): VersionedArtifact | null {
  return (
    get<VersionedArtifact>(
      `SELECT * FROM artifact WHERE version_group = ? AND is_final = 1 AND kind = 'generated' AND ${liveFilter('artifact')}
        ORDER BY revision DESC LIMIT 1`,
      [group],
    ) ?? null
  );
}

/** 链里有没有定稿（没有链的老文书只看它自己） */
export function finalBlockerOf(head: VersionedArtifact): VersionedArtifact | null {
  if (!head.version_group) return Number(head.is_final ?? 0) === 1 ? head : null;
  return findFinalInChain(head.version_group);
}

/** 链里的下一个版本号：**含已软删的版本**一起取最大值 —— 版本号永不复用 */
export function nextRevision(group: string): number {
  const row = get<{ n: number | null }>('SELECT MAX(revision) AS n FROM artifact WHERE version_group = ?', [group]);
  return Number(row?.n ?? 0) + 1;
}

/**
 * 「这个工作台 + 这个模板（+ 阶段/清单项）现在有没有版本链」—— 给生成对话框用的摘要。
 *
 * 界面必须在**点保存之前**就能说清"这一下会变成第几版""能不能覆盖"，
 * 否则用户是在一个看不见后果的按钮上做决定（B1-4 要治的就是"分不清哪份是最终版"）。
 */
export interface ChainSummary {
  exists: boolean;
  group: string | null;
  headId: number | null;
  headRevision: number | null;
  headFileName: string | null;
  liveCount: number;
  nextRevision: number;
  /** 已有定稿时不能覆盖（'update' / 'final' 都会被后端拦下） */
  blocked: boolean;
  finalRevision: number | null;
  message: string;
  /** 老库缺迁移 017：界面按改造前的话术显示，不假装有版本链 */
  schemaReady: boolean;
}

export function chainSummary(t: VersionTarget, selectedHead?:VersionedArtifact|null): ChainSummary {
  if (!ensureDocVersionSchema()) {
    return {
      exists: false,
      group: null,
      headId: null,
      headRevision: null,
      headFileName: null,
      liveCount: 0,
      nextRevision: 1,
      blocked: false,
      finalRevision: null,
      message: '当前数据库还没有版本链（缺迁移 017），保存行为与改造前一致：每次出一份新文件。',
      schemaReady: false,
    };
  }
  const periodKey = t.periodKey === undefined ? resolvePeriodKey(t) : t.periodKey;
  const head = selectedHead===undefined?findChainHead({ ...t, periodKey }):selectedHead;
  if (!head) {
    return {
      exists: false,
      group: null,
      headId: null,
      headRevision: null,
      headFileName: null,
      liveCount: 0,
      nextRevision: 1,
      blocked: false,
      finalRevision: null,
      message: periodKey
        ? `这一期（${periodKey}）还没有出过这份文书，这次是第 1 版。`
        : '这份文书还没有版本链，这次是第 1 版。',
      schemaReady: true,
    };
  }
  const group = head.version_group ?? null;
  const rows = group ? listLiveVersions(group) : [head];
  const blocker = finalBlockerOf(head);
  const next = group ? nextRevision(group) : Number(head.revision ?? 1) + 1;
  /**
   * 链的期次：头的 period_key 为空时看这一组里的期次（老链归期后头可能还没回填）。
   * 用它把"这一版属于哪一期"说清楚 —— 跨期各自独立的前提是用户看得见这一版是哪一期的。
   */
  const chainPeriod = periodKeyOfGroup(group ?? '') ?? head.period_key ?? null;
  const periodNote = chainPeriod
    ? `这一版属于期次 ${chainPeriod}${chainPeriod === periodKey ? '' : `（当前期次是 ${periodKey ?? '不分期次'}，本期还没出过）`}。`
    : periodKey
      ? `这条链是分链之前建的（没有期次），这次更新会把它收进期次 ${periodKey}。`
      : '';
  return {
    exists: true,
    group,
    headId: head.id,
    headRevision: Number(head.revision ?? 1),
    headFileName: head.file_name,
    liveCount: rows.length,
    nextRevision: next,
    blocked: Boolean(blocker),
    finalRevision: blocker ? Number(blocker.revision ?? 1) : null,
    message: blocker
      ? `v${Number(blocker.revision ?? 1)} 已经是最终版，不能再覆盖：请先取消定稿，或者选「新建」另出一份。${periodNote}`
      : `现有 ${rows.length} 版，这次「更新这一版」会成为 v${next}（v${Number(head.revision ?? 1)} 会移到 .versions 归档目录）。${periodNote}`,
    schemaReady: true,
  };
}

/* ============================== 命名与落盘 ============================== */

/** 正式文件名里 `_v<N>` 之前的那一段（时间戳_模板名 / 用户自定义名） */
export function versionBaseOf(fileName: string): string {
  const stem = basename(fileName, extname(fileName));
  return stem.replace(/_v\d+$/, '');
}

/** 去掉调用方可能一起写进来的扩展名（`自定义名称.docx` 与 `自定义名称` 等价） */
function stripExt(name: string, ext: string): string {
  return name.toLowerCase().endsWith(`.${ext}`) ? name.slice(0, -(ext.length + 1)) : name;
}

/** `.versions/<group>` 的绝对路径（挂在"正式文件所在目录"下面） */
export function versionsDirAbs(officialDirAbs: string, group: string): string {
  return join(officialDirAbs, '.versions', group);
}

/**
 * 决定这一次保存的版本归属与正式文件名。
 *
 * `requestedName`：调用方显式给的文件名（可以带扩展名）。
 * `head`：四元组下最新的一版（可能为 null = 这条链的第一版）。
 *
 * 命名（契约：`core/paths.ts` 的 `{时间戳}_{模板名}_v{N}.{ext}`）：
 *   · `new`    —— 与改造前逐字一致：调用方给了名字就用它，否则 `generatedFileName(...)`（自带 `_v1`）；
 *   · `update` / `final` —— 正式文件名 = **上一版文件名去掉 `_vN`** 再加 `_v{N}`：
 *     时间戳与模板名沿用这条链的，只有版本号会变（一份文书从头到尾只有一个"正式文件"，名字稳定）；
 *     没有上一版时直接用 `generatedFileName(..., revision)`（它自己带 `_v{N}.{ext}`，不能再拼一次）。
 */
export function planVersionSave(args: {
  mode: SaveMode;
  head: VersionedArtifact | null;
  templateName: string;
  ext: string;
  requestedName?: string | null;
  now?: Date;
  /** 这一期是哪一期；写入 `artifact.period_key`（缺省 null = 不启用期次） */
  periodKey?: string | null;
  /**
   * `head` 是不是"缺期次的老链"（`findChainHead` 的退化匹配命中的）。
   * 用它决定这次要不要**惰性归期**（把老链收进当前期次），以及要不要如实提醒用户。
   */
  headFromLegacy?: boolean;
}): {
  group: string;
  revision: number;
  supersedesId: number | null;
  isFinal: boolean;
  officialName: string;
  periodKey: string | null;
  /** 这次要把这个 id 的行惰性归到 `periodKey` 期次（0/undefined = 不用归期） */
  adoptPeriodId: number | null;
  warnings: string[];
} {
  const { mode, head, templateName, ext } = args;
  const warnings: string[] = [];
  const requested = (args.requestedName ?? '').trim();
  const periodKey = args.periodKey ?? null;
  const headFromLegacy = Boolean(args.headFromLegacy) && Boolean(head) && !head?.period_key;
  if (headFromLegacy) {
    warnings.push(
      periodKey
        ? `这一版的原链是分链之前建的（没有期次），这次更新会把它归到 ${periodKey} 这一期。`
        : '这一版的原链是分链之前建的（没有期次），这次仍然按"同一份文书"接着更新。',
    );
  }

  if (mode === 'new') {
    // 新建：另一份不同用途的文书 —— 新开一条链，命名与改造前逐字一致
    const base = requested || generatedFileName(templateName, ext, args.now ?? new Date(), 1);
    return {
      group: randomUUID(),
      revision: 1,
      supersedesId: null,
      isFinal: false,
      officialName: base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`,
      periodKey,
      adoptPeriodId: null,
      warnings,
    };
  }

  // update / final：接着上一版走
  const revision = head?.version_group ? nextRevision(head.version_group) : head ? Number(head.revision ?? 1) + 1 : 1;
  let officialName: string;
  if (requested) {
    officialName = `${safeName(stripExt(requested, ext))}_v${revision}.${ext}`;
  } else if (head) {
    officialName = `${safeName(versionBaseOf(head.file_name))}_v${revision}.${ext}`;
  } else {
    officialName = generatedFileName(templateName, ext, args.now ?? new Date(), revision);
  }
  if (!head && requested) warnings.push(`这是「${officialName}」的第一版，之后选「更新这一版」会以它为基础递增版本号。`);
  return {
    group: head?.version_group ?? randomUUID(),
    revision,
    supersedesId: head?.id ?? null,
    isFinal: mode === 'final',
    officialName,
    periodKey,
    adoptPeriodId: headFromLegacy && periodKey ? head?.id ?? null : null,
    warnings,
  };
}

/** 上一次归档动作：搬完文件之后如果库那一步失败，`rollbackArchive()` 用它把文件放回去 */
export interface ArchiveMove {
  /** 老版本被搬到哪里（null = 这次没有搬动任何文件） */
  archivedAbs: string | null;
  /** 老版本原来在哪（搬回去就回到这里） */
  restoreAbs: string | null;
  /** 归档动作要给用户看的提醒 */
  warnings: string[];
  /** 更正归档副本（见 hasSameContentInArchive） */
  corrected: boolean;
}

/** 两份文件内容一致吗（不是"文件存在"——内容不同绝不能当同一版） */
function sameFileContent(a: string, b: string): boolean {
  try {
    if (!existsSync(a) || !existsSync(b)) return false;
    const ha = sha256(readFileSync(a));
    const hb = sha256(readFileSync(b));
    return Boolean(ha) && ha === hb;
  } catch {
    return false;
  }
}

/**
 * 把"上一版"的正式文件搬进 `.versions/<group>/v<N>.<ext>`。
 *
 * 【与改造前不同的一点，是本缺陷修复的核心】这个函数**不再改库**：它只动磁盘，
 * 库里的 `file_rel` 由调用方在与"挂新版本"同一笔事务里更新（`adoptIntoGroup` +
 * `attachVersion` + `writeGenerationLog` 包在 `commitVersionSave()` 里一起提交）。
 * 改造前是"搬文件 → 立刻改库 → 再渲染"，中间任何一步失败都会留下
 * "旧版本已经搬走、新版本还没生成"的不可回滚中间态；现在是"先渲染成功、再提交版本变更"。
 *
 * 三种情况：
 *   · 老正式件还在原位 → 正常搬（rename，跨卷才 copy+删源）。
 *   · 老正式件不在原位、归档目录里那份**内容一致** → 判定为"上一次搬完但库没落地"，
 *     不删任何东西（旧代码在这里 unlink 了老路径 —— 重试时那条记录会指向不存在的文件）。
 *   · 老正式件不在原位、归档里那份**内容不一致** → 明确拒绝，绝不覆盖历史版本。
 */
export function archiveHeadForVersion(head: VersionedArtifact, officialDirAbs: string, group: string): ArchiveMove {
  const warnings: string[] = [];
  const move: ArchiveMove = { archivedAbs: null, restoreAbs: null, warnings, corrected: false };
  let abs: string;
  try {
    abs = artifactAbsPath(head);
  } catch (e) {
    // 工作台被删 / 已解绑：定位不到就不动它（那条记录本来就已经"暂时打不开"）
    warnings.push(`上一版「${head.file_name}」的位置现在定位不到（${(e as Error).message}），没有搬动它。`);
    return move;
  }
  const ext = extname(head.file_name) || extname(abs) || '.docx';
  const dir = versionsDirAbs(officialDirAbs, group);
  const target = join(dir, `v${Number(head.revision ?? 1)}${ext}`);
  ensureDir(dir);

  if (!existsSync(abs)) {
    if (!existsSync(target)) {
      warnings.push(`上一版的文件已经不在磁盘上（${head.file_rel}），没有可搬动的旧文件。`);
      return move;
    }
    if (!sameFileContent(abs, target)) {
      throw new VersionRuleError(
        `上一版的文件不在原位置（${head.file_rel}），归档目录里的 ${target} 又跟记录的内容对不上。` +
          '为避免覆盖历史版本，本次没有生成新版本，请先手工确认这两份文件。',
      );
    }
    // 内容一致 → 上一次"搬完文件、库没落地"的续跑：什么都不删，只把库指过去
    warnings.push(`上一版（v${Number(head.revision ?? 1)}）已经在归档目录里（${target}），沿用这一份。`);
    move.archivedAbs = target;
    move.restoreAbs = abs;
    move.corrected = true;
    return move;
  }

  if (existsSync(target)) {
    if (sameFileContent(abs, target)) {
      /**
       * 同一版本被搬过两次（上一次复制成功、删源失败，或归档目录是手工复制出来的）：
       * **不 unlink 老路径** —— 删除是不可逆的，而"多一份同内容文件"是可解释、可清理的。
       * 库会指向归档目录里的那一份，老路径上留着的这一份由用户自己处置（提醒里说明）。
       */
      warnings.push(
        `归档目录里已经有一份内容相同的 v${Number(head.revision ?? 1)}（${target}），` +
          `没有删除原位置的同名文件（${abs}），确认无误后可以自己删掉它。`,
      );
      move.archivedAbs = target;
      move.restoreAbs = abs;
      move.corrected = true;
      return move;
    }
    throw new VersionRuleError(
      `归档目录里已经有一份同名的旧版本（${target}），内容与当前不一致。` +
        '为避免覆盖历史版本，本次没有生成新版本，请先手工确认这两份文件。',
    );
  }

  /**
   * 【只读来源的闸门】在 rename / unlink **之前**问一次授权：只读来源（原件目录）里的文件
   * 平台只读取，绝不允许改名 / 移动 / 删除。`assertUsable` 是这条规则的**唯一闸门**
   * （`core/paths.ts`），这里不自己复判 purpose，免得两套口径。
   * 抛的是 `SafetyRefusal`（不是 VersionRuleError）：路由层照既有口径回 400 + 原文。
   */
  assertUsable(abs, 'move');
  try {
    renameSync(abs, target);
  } catch (e) {
    /**
     * 只有**跨卷**（EXDEV）才退回"复制 + 删源"：绑定目录换了盘、或用户把工作台挪到另一块盘时
     * 会碰上。其余错误（被 Word 占着的 EBUSY/EPERM）**绝不**用复制兜底 ——
     * 复制会成功、而删源会失败，磁盘上就出现两份同内容文件，谁也说不清哪份是正式件。
     */
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    copyFileSync(abs, target);
    assertUsable(abs, 'delete'); // 跨卷兜底要删源，再确认一次
    unlinkSync(abs);
  }
  move.archivedAbs = target;
  move.restoreAbs = abs;
  warnings.push(`上一版（v${Number(head.revision ?? 1)}）已移到归档目录：${target}`);
  return move;
}

/**
 * `archiveHeadForVersion()` 的补偿：库那一步失败时把文件放回原位。
 *
 * 只在"这次确实搬动了文件、且原位置现在没有东西"时搬回；
 * 更正分支（`corrected`）本来就没删过任何文件，不需要补偿。
 * 返回 null = 已经回到操作前的状态；返回字符串 = 补偿没做成的原因（如实报给调用方）。
 */
export function rollbackArchive(move: ArchiveMove): string | null {
  if (!move.archivedAbs || !move.restoreAbs) return null;
  try {
    if (!existsSync(move.archivedAbs)) return '归档副本已经不在了，无法搬回原位置';
    if (existsSync(move.restoreAbs)) return '原位置已经有一份文件，没有覆盖它';
    ensureDir(dirname(move.restoreAbs));
    // 补偿也是"改名 + 删源"，同样要过只读来源的闸门（这里失败就如实报告，不硬搬）
    assertUsable(move.archivedAbs, 'move');
    assertUsable(move.restoreAbs, 'move');
    try {
      renameSync(move.archivedAbs, move.restoreAbs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      copyFileSync(move.archivedAbs, move.restoreAbs);
      assertUsable(move.archivedAbs, 'delete');
      unlinkSync(move.archivedAbs);
    }
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * 把新建的 artifact 挂到链上。
 *
 * 为什么是"先 saveArtifact 再 UPDATE"而不是直接改 `insertArtifactRecord` 的 INSERT：
 * 那条 INSERT 是**全项目所有落盘动作共用的**（上传/影像/纳管/生成），为版本链去改它，
 * 老库（缺 017）就会在"上传一张照片"上炸 `no such column`。这里只补这一行记录，
 * 影响面最小；`revision` 列的默认值是 1，正好等于第一版。
 * 顺带把 001 起就有、一直没人写的 `artifact.version` 也写成本版号（同一件事同一个值）。
 */
export function attachVersion(
  artifactId: number,
  v: { group: string; revision: number; supersedesId: number | null; isFinal: boolean; periodKey?: string | null },
): void {
  /**
   * 【迁移 022 的硬约束：同链只能有一个定稿】
   * `idx_artifact_final_unique` 是部分唯一索引 `(version_group) WHERE is_final=1 AND deleted_at IS NULL`，
   * 所以置位之前**必须先把同组其它行的 1 清掉**（原来只靠 markFinal 的"先清后置"，
   * 走 attachVersion 这条路的"另存为定稿"不清就直接撞索引 SQLITE_CONSTRAINT_UNIQUE）。
   * "先清后置"不变，只是从 markFinal 一处扩展成两条写入路径都做。
   * 顺带纠正半截态：`is_final=1` 而 `final_at` 为空时补上时间（见 markFinal 的同类修复）。
   */
  if (v.isFinal) {
    run(`UPDATE artifact SET is_final = 0, final_at = NULL WHERE version_group = ? AND id <> ?`, [v.group, artifactId]);
  }
  run(
    `UPDATE artifact SET version_group = ?, revision = ?, supersedes_id = ?, period_key = ?,
       is_final = CASE WHEN ? = 1 THEN 1 ELSE 0 END,
       final_at = CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
       version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
    [
      v.group,
      v.revision,
      v.supersedesId,
      v.periodKey ?? null,
      v.isFinal ? 1 : 0,
      v.isFinal ? 1 : 0,
      v.revision,
      artifactId,
    ],
  );
}

/**
 * 把迁移前的老生成件（`version_group IS NULL`）收进这条链：它就是链上的第 1 版。
 *
 * 不做这一步的后果很具体：旧文件被搬进了 `.versions/<group>/v1.docx`，但库里那条记录
 * 仍然"没有链" —— 版本列表里只剩新出的 v2，用户会以为第一版丢了（文件其实就在归档目录里）。
 *
 * 【同时更新文件位置】老正式件被搬进归档目录之后，`file_rel` / `file_name` 必须跟着改，
 * 否则那条记录指向一个不存在的路径（下载、回滚、指纹核对全废）。改造前是
 * `moveHeadToVersions()` 顺手改库，现在这里跟"归链"一起做，两件事同一笔事务提交。
 */
export function adoptIntoGroup(head: VersionedArtifact, group: string, opts: { movedToAbs?: string | null; periodKey?: string | null } = {}): void {
  /**
   * 期次**惰性回填**：老链的 `period_key` 是 NULL（迁移 022 有意不回填）。这次更新把它
   * 收进当期次时顺便写上，于是它以后只会被同期次的匹配认领，不会再被别的期次抢走。
   * 已经有期次的行**绝不改写**（跨期各自独立的前提）。
   */
  const fillPeriod = Boolean(opts.periodKey) && !head.period_key;
  const moved = opts.movedToAbs ?? null;
  if (head.version_group && !moved && !fillPeriod) return;
  run(
    `UPDATE artifact SET version_group = COALESCE(version_group, ?),
       revision = COALESCE(revision, 1),
       period_key = CASE WHEN period_key IS NULL AND ? = 1 THEN ? ELSE period_key END,
       file_rel = COALESCE(?, file_rel),
       file_name = COALESCE(?, file_name),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
    [
      group,
      fillPeriod ? 1 : 0,
      opts.periodKey ?? null,
      moved ? relativeToRoot(moved) : null,
      moved ? basename(moved) : null,
      head.id,
    ],
  );
}

/**
 * 把一次"更新这一版 / 另存为定稿"的库内变更**一起提交**。
 *
 * 调用时序（缺陷修复①的核心要求：先渲染与校验，成功后再提交版本变更）：
 *   1. 调用方先渲染成功、拿到新版本的字节；
 *   2. 调用方把老正式件搬进归档目录（`archiveHeadForVersion()`，只动磁盘）；
 *   3. `saveArtifact()` 落新文件、登记 artifact；
 *   4. **本函数**在同一笔事务里改库：老版本归链 + 更新文件位置 + 挂新版本 + 写 generation_log。
 * 第 2/3 步失败时文件由调用方补偿（`rollbackArchive()`），库还没动过，所以
 * "记录指向不存在的文件"这个状态从结构上不再可能出现。
 */
export function commitVersionSave(input: {
  head: VersionedArtifact | null;
  move: ArchiveMove;
  plan: {
    group: string;
    revision: number;
    supersedesId: number | null;
    isFinal: boolean;
    periodKey: string | null;
    adoptPeriodId: number | null;
  };
  newArtifactId: number;
  log: { workbenchId: number | null; templateId: number | null; variables: unknown; mode: string };
}): void {
  const { head, move, plan } = input;
  tx(() => {
    if (head) {
      adoptIntoGroup(head, plan.group, {
        movedToAbs: move.archivedAbs,
        periodKey: plan.adoptPeriodId === head.id ? plan.periodKey : null,
      });
    }
    attachVersion(input.newArtifactId, {
      group: plan.group,
      revision: plan.revision,
      supersedesId: plan.supersedesId,
      isFinal: plan.isFinal,
      periodKey: plan.periodKey,
    });
    writeGenerationLog({
      workbenchId: input.log.workbenchId,
      templateId: input.log.templateId,
      artifactId: input.newArtifactId,
      variables: input.log.variables,
      mode: input.log.mode,
      version: { group: plan.group, revision: plan.revision, prevArtifactId: plan.supersedesId },
    });
  });
}

/**
 * 写 `generation_log`。缺迁移 017 时退回原来的七列 —— 这是"每次出文书都走"的路径，
 * 绝不能因为一个附带信息把主流程带崩。
 */
export function writeGenerationLog(input: {
  workbenchId: number | null;
  templateId: number | null;
  artifactId: number;
  variables: unknown;
  mode: string;
  version?: { group: string; revision: number; prevArtifactId: number | null };
}): void {
  // 注意：base 故意**不带右括号**，两种列清单共用它再各自收尾
  const base = `INSERT INTO generation_log (workbench_id, template_id, artifact_id, profile_purpose, variables, mode, status`;
  const args: (string | number | null)[] = [
    input.workbenchId,
    input.templateId,
    input.artifactId,
    'writing',
    JSON.stringify(input.variables ?? {}),
    input.mode,
    'ok',
  ];
  if (input.version && ensureDocVersionSchema()) {
    run(`${base}, version_group, revision, prev_artifact_id) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
      ...args,
      input.version.group,
      input.version.revision,
      input.version.prevArtifactId,
    ]);
    return;
  }
  run(`${base}) VALUES (?,?,?,?,?,?,?)`, args);
}

/* ============================== 读：版本链 ============================== */

export interface VersionChain {
  artifact: Artifact;
  group: string | null;
  unchained: boolean;
  finalId: number | null;
  finalRevision: number | null;
  items: VersionItem[];
  /** 归档目录（`.versions/<group>`），给界面「打开目录」用；算不出来为 null */
  versions_dir: string | null;
  /** 这条链属于哪一期（迁移 022；NULL = 分链之前建的、或该阶段不启用期次） */
  periodKey: string | null;
  /** 一句话口径（界面直接显示，避免"v1/v2 到底谁新"靠猜） */
  note: string;
}

export function listVersionChain(id: number): VersionChain | null {
  const a = get<VersionedArtifact>('SELECT * FROM artifact WHERE id = ?', [id]);
  if (!a) return null;

  const dirOf = (x: Artifact): string | null => {
    try {
      return dirname(artifactAbsPath(x));
    } catch {
      return null;
    }
  };

  // 迁移前的旧生成件：没有链，也要能打开这个页面（显示「v1（未分链）」而不是报错）
  if (!ensureDocVersionSchema() || !a.version_group) {
    const isFinal = Number(a.is_final ?? 0) === 1;
    return {
      artifact: a,
      group: a.version_group ?? null,
      unchained: true,
      finalId: isFinal ? a.id : null,
      finalRevision: isFinal ? Number(a.revision ?? 1) : null,
      items: [toItem(a, a.id, a.id, null, true)],
      versions_dir: null,
      periodKey: null,
      note: '这份文书是分链之前生成的（还没有版本链）。再出一次时选「更新这一版」，它就会成为链上的第 1 版。',
    };
  }

  const group = a.version_group;
  const rows = listLiveVersions(group);
  const headId = rows[rows.length - 1]?.id ?? a.id;
  const modes = logModes(group);
  const items = rows.map((r) => toItem(r, a.id, headId, modes.get(Number(r.revision)) ?? null, false));
  const finalRow = rows.find((r) => Number(r.is_final ?? 0) === 1) ?? null;
  const dir = dirOf(rows[rows.length - 1] ?? a);
  const period = periodKeyOfGroup(group);
  return {
    artifact: a,
    group,
    unchained: false,
    finalId: finalRow?.id ?? null,
    finalRevision: finalRow ? Number(finalRow.revision) : null,
    items,
    versions_dir: dir ? versionsDirAbs(dir, group) : null,
    periodKey: period,
    note: `共 ${items.length} 版${period ? `（期次 ${period}）` : ''}；正式文件永远是版本号最大的那一版，旧版本在 .versions 归档目录里，仍然可以下载和回滚。`,
  };
}

function logModes(group: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (!ensureDocVersionSchema()) return out;
  for (const r of all<{ revision: number | null; mode: string | null }>(
    'SELECT revision, mode FROM generation_log WHERE version_group = ? ORDER BY id ASC',
    [group],
  )) {
    if (r.revision !== null && r.revision !== undefined) out.set(Number(r.revision), r.mode ?? null);
  }
  return out;
}

function toItem(r: VersionedArtifact, currentId: number, headId: number, mode: string | null, unchained: boolean): VersionItem {
  let abs = '';
  let exists = false;
  try {
    abs = artifactAbsPath(r);
    exists = existsSync(abs);
  } catch {
    exists = false;
  }
  return {
    id: r.id,
    revision: Number(r.revision ?? 1),
    is_final: Number(r.is_final ?? 0),
    final_at: r.final_at ?? null,
    supersedes_id: r.supersedes_id ?? null,
    file_name: r.file_name,
    file_rel: r.file_rel,
    abs_path: abs,
    exists,
    size_bytes: r.size_bytes ?? null,
    sha256: r.sha256 ?? null,
    title: r.title,
    created_at: r.created_at,
    current: r.id === currentId,
    head: r.id === headId,
    mode,
    unchained,
  };
}

/* ============================== 定稿标记 ============================== */

export interface MarkFinalResult {
  changed: boolean;
  is_final: number;
  group: string;
  message: string;
}

/**
 * 标 / 取消「最终版」。
 *
 * **同一 group 内最多一个定稿**：置位时先把同组其它行的标记清掉（同一事务；迁移 022 之后
 * 还有部分唯一索引 `idx_artifact_final_unique` 在数据库层面兜底），于是"重复标记"永远
 * 收敛到同一个状态，不会出现两个锁图标。
 *
 * 【幂等早退必须仍然修数据】缺陷修复③：半截态（`is_final=1` 而 `final_at` 为空，
 * 例如上一次写库中途被打断）以前走 `cur === want` 的早退分支，反复调都回
 * `changed:false` 且**永远补不上 `final_at`**。现在标为定稿时如果发现 `final_at` 缺失，
 * 就地补齐并如实回 `changed:true`（"已经在最终版状态、但没有留下定稿时间"这件事是要修的，
 * 不是"什么都不用做"）。真正已经完整的定稿才回 `changed:false`。
 */
export function markFinal(id: number, final: boolean): MarkFinalResult {
  // Keep legacy schema initialization outside the business savepoint/cache.
  if (!ensureDocVersionSchema()) throw new VersionRuleError(NO_SCHEMA_MESSAGE);
  return tx(() => {
    const result = markFinalInner(id, final);
    const workbenchId = get<{workbench_id:number|null}>('SELECT workbench_id FROM artifact WHERE id=?', [id])?.workbench_id;
    if (workbenchId) syncEvidence(workbenchId);
    return result;
  });
}
function markFinalInner(id: number, final: boolean): MarkFinalResult {
  const a = get<VersionedArtifact>(`SELECT * FROM artifact WHERE id = ? AND ${liveFilter('artifact')}`, [id]);
  if (!a) throw new VersionRuleError('文件不存在（也可能已在回收站里）');
  assertDocumentIdle(a.workbench_id,a.template_id);
  if (final) assertFinalArtifact(a,{confirmLegacy:true});
  const want = final ? 1 : 0;
  const cur = Number(a.is_final ?? 0);
  const periodId = (a as VersionedArtifact & {work_period_id?:number}).work_period_id;
  if (periodId && requirePeriod(periodId,a.workbench_id).status === 'done' && cur !== want) throw new VersionRuleError('请先重新打开已完成期次，再修改定稿状态');
  // An explicit human confirmation establishes a new review baseline; startup never does.
  const oldReview=get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[id]);
  const oldSnapshot=oldReview?JSON.parse(oldReview.snapshot):null;
  const legacyReview=final&&a.kind==='generated'&&!oldSnapshot?.sourceSignature;
  const saveLegacyReview=()=>{
    if(!legacyReview)return;
    const log=get<{variables:string}>('SELECT variables FROM generation_log WHERE artifact_id=? ORDER BY id DESC LIMIT 1',[id]);
    const snapshot={...(oldSnapshot??reviewMemoryFacts(a.workbench_id,periodId,JSON.parse(log?.variables??'{}'))),digest:sha256(readFileSync(artifactAbsPath(a))),sourceArtifactIds:[],sourceSignature:documentSourceSignature(a.workbench_id,periodId,a.template_id,[],(a as Artifact&{inspection_id?:number}).inspection_id),legacyConfirmedAt:new Date().toISOString()};
    run('INSERT INTO artifact_fact_review(artifact_id,snapshot) VALUES(?,?) ON CONFLICT(artifact_id) DO UPDATE SET snapshot=excluded.snapshot',[id,JSON.stringify(snapshot)]);
  };
  const rev = Number(a.revision ?? 1);

  // 老数据（没有链）：定稿时给它开一条只有自己的链，之后这条链就正常了
  let group = a.version_group ?? null;
  if (!group) {
    group = randomUUID();
    run('UPDATE artifact SET version_group = ?, revision = COALESCE(revision, 1) WHERE id = ?', [group, id]);
    a.version_group = group;
  }

  if (cur === want) {
    saveLegacyReview();
    // 半截态：状态对了、定稿时间为空 → 补齐（如实回 changed:true），不是"不用重复标记"
    if (want === 1 && !a.final_at) {
      run(
        `UPDATE artifact SET final_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [id],
      );
      return {
        changed: true,
        is_final: 1,
        group,
        message: `这一版（v${rev}）本来就标着最终版，但没有定稿时间（上次写库中断留下的半截状态），已补上定稿时间。`,
      };
    }
    return {
      changed: !!legacyReview,
      is_final: want,
      group,
      message: legacyReview?'已按本次人工核对建立当前来源基线；旧版未保存的参考范围不作追溯推断。':want
        ? `这一版（v${rev}）已经是最终版了，不用重复标记。`
        : `这一版（v${rev}）本来就不是最终版，不需要取消。`,
    };
  }

  const replaced = all<{ id: number; revision: number }>(
    `SELECT id, revision FROM artifact WHERE version_group = ? AND id <> ? AND is_final = 1`,
    [group, id],
  );
  const apply = (): void => {
    tx(() => {
      saveLegacyReview();
      run(`UPDATE artifact SET is_final = 0, final_at = NULL WHERE version_group = ? AND id <> ?`, [group, id]);
      run(
        `UPDATE artifact SET is_final = ?, final_at = CASE WHEN ? = 1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [want, want, id],
      );
      if(final)run('UPDATE artifact SET sha256=? WHERE id=?',[sha256(readFileSync(artifactAbsPath(a))),id]);
    });
  };
  try {
    apply();
  } catch (e) {
    /**
     * 并发下"两个请求同时标不同版本为定稿"时，后到的那个可能先撞上唯一索引
     * （两个请求都通过了前面的检查）。事务已经整笔回滚，重试一次即可：
     * 这次会在事务里先清掉对方刚置上的 1，再置自己 —— 正是"先清后置"。
     * 仍然失败就是真错误（约束冲突之外的库故障），原样抛出，不假装成功。
     */
    if (!/UNIQUE|constraint/i.test((e as Error).message)) throw e;
    apply();
  }

  if (!want) return { changed: true, is_final: 0, group, message: `已取消 v${rev} 的最终版标记，之后可以继续更新。` };
  return {
    changed: true,
    is_final: 1,
    group,
    message: replaced.length
      ? `已把 v${rev} 标为最终版（原来 v${replaced.map((r) => r.revision).join('、v')} 的定稿标记已取消；同一条链只能有一个最终版）。`
      : `已把 v${rev} 标为最终版：这条链不能再被覆盖，要改请先取消定稿。`,
  };
}

/* ============================== 回滚 ============================== */

export interface RollbackResult {
  artifactId: number;
  revision: number;
  fromRevision: number;
  group: string;
  warnings: string[];
}

/**
 * 回滚到链上的某一版：把那一版的文件**复制**回来，成为 revision+1 的新正式文件。
 *
 * 「永不删中间版本」是硬口径（docs/09 §4.8.4）：磁盘便宜、追溯贵，所以 v1/v2/v3 原样留在归档目录，
 * 新版本只是"内容等于 v1 的 v4"。复制走 `saveArtifact({sourcePath})`，sha256 由它真算一遍 ——
 * 于是"v4 与 v1 逐字节一致"这条验收是**可断言**的，不是自己声明的。
 *
 * 链上有定稿时拒绝（与"更新这一版"同一条闸门）：回滚必然要覆盖正式文件，
 * 定稿的文书不能被任何动作静默覆盖。
 */
export async function rollbackToRevision(id: number, revision: number): Promise<RollbackResult> {
  const a=get<Artifact>('SELECT * FROM artifact WHERE id=?',[id]);
  if(!a)throw new VersionRuleError('文件不存在');
  return withDocumentWrite(a.workbench_id,a.template_id,()=>rollbackToRevisionLocked(id,revision));
}
async function rollbackToRevisionLocked(id:number,revision:number):Promise<RollbackResult> {
  if (!ensureDocVersionSchema()) throw new VersionRuleError(NO_SCHEMA_MESSAGE);
  const a = get<VersionedArtifact>(`SELECT * FROM artifact WHERE id = ? AND ${liveFilter('artifact')}`, [id]);
  if (!a) throw new VersionRuleError('文件不存在（也可能已在回收站里）');
  const businessPeriod=(a as VersionedArtifact&{work_period_id?:number}).work_period_id;
  if(businessPeriod&&requirePeriod(businessPeriod,a.workbench_id).status==='done')throw new VersionRuleError('请先重新打开本期，再恢复文书版本');
  if (!a.version_group) throw new VersionRuleError('这份文书没有版本链（是分链之前生成的），没有可回滚的历史版本。');
  const group = a.version_group;

  const target = get<VersionedArtifact>(
    `SELECT * FROM artifact WHERE version_group = ? AND revision = ? AND ${liveFilter('artifact')} ORDER BY id DESC LIMIT 1`,
    [group, revision],
  );
  if (!target) {
    const rows = listLiveVersions(group).map((r) => Number(r.revision));
    throw new VersionRuleError(`这条链里没有 v${revision}（在用的版本：${rows.length ? rows.join('、') : '无'}）`);
  }

  const liveRows = listLiveVersions(group);
  const head = liveRows[liveRows.length - 1] ?? a;
  const blocked = findFinalInChain(group);
  if (blocked) {
    throw new VersionRuleError(`v${Number(blocked.revision)} 是这条链的最终版，不能回滚覆盖：请先取消定稿，或另存为新版本。`);
  }

  const srcAbs = artifactAbsPath(target);
  if (!existsSync(srcAbs)) throw new VersionRuleError(`v${revision} 的文件不在磁盘上（${target.file_rel}），无法回滚。`);
  const sourceBytes=readFileSync(srcAbs);

  const nextRev = nextRevision(group);
  const officialDir = dirname(artifactAbsPath(head));
  const ext = extname(head.file_name) || extname(srcAbs) || '.docx';
  const officialName = `${safeName(versionBaseOf(head.file_name))}_v${nextRev}${ext}`;

  /**
   * 顺序与「更新这一版」逐字一致（缺陷修复①）：先把老正式件搬进归档目录（只动磁盘），
   * 再落新文件，最后**同一笔事务**改库（老版本归链 + 挂新版本 + 写日志）。
   * 中间任何一步失败都补偿回去 —— 绝不留下"记录指向不存在的文件"。
   */
  const move = archiveHeadForVersion(head, officialDir, group);
  const warnings = [...move.warnings];
  const srcLog = get<{variables:string|null}>('SELECT variables FROM generation_log WHERE version_group=? AND revision=? ORDER BY id DESC LIMIT 1',[group,revision]);
  let saved:SaveArtifactResult;
  try {
    const {saveArtifact}=await import('../core/store.ts');
    saved=await saveArtifact({data:sourceBytes,dirAbs:officialDir,fileName:officialName,workbenchId:head.workbench_id,positionCode:head.position_code,kind:'generated',title:head.title,templateId:head.template_id,checklistItemId:head.checklist_item_id,docDate:head.doc_date,index:true,
      onCommit:artifact=>{
        if(businessPeriod&&requirePeriod(businessPeriod,a.workbench_id).status==='done')throw new VersionRuleError('期次已完成，请重新打开后恢复');
        adoptIntoGroup(head,group,{movedToAbs:move.archivedAbs,periodKey:periodKeyOfGroup(group)});
        attachVersion(artifact.id,{group,revision:nextRev,supersedesId:head.id,isFinal:false,periodKey:periodKeyOfGroup(group)});
        run('UPDATE artifact SET work_period_id=(SELECT work_period_id FROM artifact WHERE id=?),inspection_id=(SELECT inspection_id FROM artifact WHERE id=?),inspection_revision=(SELECT inspection_revision FROM artifact WHERE id=?) WHERE id=?',[target.id,target.id,target.id,artifact.id]);
        for(const table of ['artifact_policy_requirement','artifact_fact_review'])run('INSERT INTO '+table+'(artifact_id,snapshot) SELECT ?,snapshot FROM '+table+' WHERE artifact_id=?',[artifact.id,target.id]);
        inheritBusinessEvidence(target.id,artifact.id,srcLog?.variables?safeJson(srcLog.variables):{});
        writeGenerationLog({workbenchId:head.workbench_id,templateId:head.template_id??null,artifactId:artifact.id,variables:srcLog?.variables?safeJson(srcLog.variables):{},mode:'manual',version:{group,revision:nextRev,prevArtifactId:head.id}});
      }});
  } catch(e) {
    const restore=rollbackArchive(move);
    if(!restore)throw e;
    throw new Error(String((e as Error).message)+'；旧文件恢复失败：'+restore);
  }

  warnings.unshift(`已把 v${revision} 的内容复制回来，成为 v${nextRev}（v1 到 v${nextRev - 1} 都留在归档目录里，一个都没删）。`);
  return { artifactId: saved.artifact.id, revision: nextRev, fromRevision: revision, group, warnings };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/* ============================== 版本对比（只比变量） ============================== */

export interface DiffResult {
  group: string;
  from: number;
  to: number;
  changes: { key: string; from: string; to: string }[];
  same: number;
  missing: number[];
  note: string;
}

/**
 * 只做**变量级**对比（docs/09 §4.8.4 的硬口径）：比较的是两次生成的 `generation_log.variables`，
 * 不做 docx 正文 diff —— docx 的差异大量来自 XML 结构噪声（Word 重排 rsid、样式），
 * 会淹没真正的改动，而"哪个字段改了"在 `generation_log` 里本来就有。
 */
export function diffVersions(id: number, from: number, to: number): DiffResult {
  const chain = listVersionChain(id);
  if (!chain) throw new VersionRuleError('文件不存在');
  if (!chain.group || chain.unchained) throw new VersionRuleError('这份文书没有版本链（是分链之前生成的），无法按版本对比。');
  const fromVars = logVariables(chain.group, from);
  const toVars = logVariables(chain.group, to);
  const missing: number[] = [];
  if (fromVars === null) missing.push(from);
  if (toVars === null) missing.push(to);
  const a = fromVars ?? {};
  const b = toVars ?? {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changes: { key: string; from: string; to: string }[] = [];
  let same = 0;
  for (const k of keys) {
    const x = textOf(a[k]);
    const y = textOf(b[k]);
    if (x === y) same += 1;
    else changes.push({ key: k, from: x, to: y });
  }
  return {
    group: chain.group,
    from,
    to,
    changes,
    same,
    missing,
    note: missing.length
      ? `第 ${missing.join('、')} 版没有找到变量记录（可能是分链之前生成的），对不出来的不做猜测。`
      : '只比变量（“哪个字段改了”），不比对 docx 正文 —— 正文差异大量来自格式噪声。',
  };
}

function logVariables(group: string, revision: number): Record<string, unknown> | null {
  if (!ensureDocVersionSchema()) return null;
  const row = get<{ variables: string | null }>(
    'SELECT variables FROM generation_log WHERE version_group = ? AND revision = ? ORDER BY id DESC LIMIT 1',
    [group, revision],
  );
  if (!row) return null;
  try {
    const v = JSON.parse(row.variables ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function textOf(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
