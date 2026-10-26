import { snapshotTemplateRevision } from './template-history.ts';
import { workTypeNavigation, type NavigationGroup } from './work-type-navigation.ts';
import {invalidateLegacyDocumentSources} from './document-source.ts';
import { ApiError } from '../api/reply.ts';
import { assertPeriodReady, savePeriodRule, syncPeriods, todayShanghai } from './periods.ts';
import { assertFinalArtifact } from './finalization.ts';
/**
 * 领域服务：工作类型 / 工作台 / 阶段 / 清单 / 模板 / 生成
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path';
import { checklistSatisfied, syncEvidence,evidenceCount } from '../core/checklist.ts';
import { all, get, run, tx } from '../db/index.ts';
import { DATA_ROOT, DIRS, backupDirectoryConfig, getSetting } from '../core/config.ts';
import {
  assertNotPlatformProtected, dateOnly, ensureDir, externalRootId, getBoundRoots, isDirWritable, isInsideRoot,
  isPlatformProtected, listRootGrants, resolveInside, safeName, setExtraProtectedRoots, setRootGrants, toPosix,
  uniqueFileName, workbenchFolderName, workbenchRootAbs,
} from '../core/paths.ts';
import { periodDirName, isSafePeriodPath, normalizePeriodSpec, periodSpecProblem, type PeriodKind } from '../core/period-dir.ts';
import { computeSchedule, nextOccurrenceOnOrAfter, type ScheduleSpec, type ScheduleState } from './schedule.ts';
import { canRender, checkTemplateHealth, detectFormat, scanDocx, scanTemplate, type ScanResult, type TemplateHealth } from '../core/template.ts';
import { artifactAbsPath, artifactBodyText, ensureArtifactIdentitySchema, saveArtifact, type Artifact } from '../core/store.ts';
import { liveFilter, softDeleteWorkbench } from '../core/trash.ts';

/* ============================== 工作类型 ============================== */

export interface WorkType {
  navigation_group?: NavigationGroup | null;
  id: number;
  code: string;
  name: string;
  category: string;
  domain: 'admin' | 'project';
  executor: 'general' | 'timesheet';
  period_defaults: string | null;
  rule_version: number;
  description: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
  /**
   * 驱动方式：
   *   process  流程驱动 —— 有阶段序列，逐阶段推进（项目三类）
   *   document 文书驱动 —— 没有阶段，按模板直接出文书（行政管理）
   */
  mode: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function listWorkTypes(includeArchived = false) {
  // 软删除过滤：下一条查询里的 workbench_count 只数 deleted_at IS NULL（在用的工作台），
  // 回收站里的那份虽然 archived_at 可能为空，但不该算进"这个类型还有几个工作台"。
  // 过滤片段由 liveFilter('workbench','w') 拼进 SQL —— 注意不要往 SQL 串里写 `//` 注释。
  const workbenchCountFilter = liveFilter('workbench', 'w');
  return all<WorkType & { position_count: number; template_count: number; workbench_count: number }>(
    `SELECT t.*,
       (SELECT COUNT(*) FROM position_template p WHERE p.work_type_id = t.id AND p.archived_at IS NULL) AS position_count,
       (SELECT COUNT(*) FROM template tp WHERE tp.work_type_id = t.id AND tp.archived_at IS NULL) AS template_count,
       (SELECT COUNT(*) FROM workbench w WHERE w.work_type_id = t.id AND w.archived_at IS NULL AND ${workbenchCountFilter}) AS workbench_count
     FROM work_type t
     ${includeArchived ? '' : 'WHERE t.archived_at IS NULL'}
     ORDER BY t.sort_order, t.id`,
  ).map(t => ({ ...t, ...workTypeNavigation(t) }));
}

export function getWorkType(id: number): WorkType | undefined {
  return get<WorkType>('SELECT * FROM work_type WHERE id = ?', [id]);
}

export function upsertWorkType(input: Partial<WorkType> & { code: string; name: string }): number {
  const existing = get<WorkType>('SELECT * FROM work_type WHERE code = ?', [input.code]);
  if (input.id && (!existing || existing.id !== input.id)) throw new ApiError('IMMUTABLE_CODE', '工作类型编码不可修改', 409);
  const domain = input.domain ?? existing?.domain ?? (['project','项目实施','工程类','信息化类','服务类'].includes(input.category ?? '') ? 'project' : 'admin');
  const mode = input.mode ?? existing?.mode ?? 'document';
  const navigation = input.navigation_group === undefined ? existing?.navigation_group ?? null : input.navigation_group;
  if (navigation && (domain === 'admin' ? navigation !== 'administration' : !['information','engineering'].includes(navigation))) throw new ApiError('BAD_CATEGORY','导航分类与业务领域不一致');
  if (!['admin','project'].includes(domain) || !['process','document'].includes(mode) || !['general','timesheet'].includes(input.executor ?? existing?.executor ?? 'general')) throw new ApiError('BAD_TYPE','业务领域、执行方式或专用能力无效');
  if (existing && (mode !== existing.mode || (input.executor!==undefined&&input.executor!==existing.executor)) && get('SELECT id FROM workbench WHERE work_type_id=?',[existing.id])) throw new ApiError('TYPE_IN_USE','已使用类型不能改变执行方式，请新建类型',409);
  const defaults = input.period_defaults === undefined ? existing?.period_defaults ?? null : input.period_defaults;
  if((input.executor??existing?.executor)==='timesheet' && (mode!=='document'||!defaults||JSON.parse(defaults).frequency!=='monthly'))throw new ApiError('BAD_EXECUTOR','部门工时需使用月度周期的文书 / 事务类型');
  if (defaults) {
    let rule: Record<string, unknown>; try {rule=JSON.parse(defaults);} catch {throw new ApiError('BAD_RULE','周期默认配置必须是 JSON');}
    if (mode==='process') throw new ApiError('STAGE_PERIOD_CONFLICT','阶段式工作暂不支持每期独立阶段，请将周期报送建为单独类型');
    if (!['monthly','quarterly','yearly'].includes(String(rule.frequency))) throw new ApiError('BAD_RULE','周期默认频率无效');
    const max=rule.frequency==='monthly'?1:rule.frequency==='quarterly'?3:12;
    for(const [key,fallback,min,limit] of [['due_day',31,1,31],['due_month_offset',0,0,max],['remind_days',3,0,365]] as const) {const n=Number(rule[key]??fallback);if(!Number.isInteger(n)||n<min||n>limit)throw new ApiError('BAD_RULE','周期截止或提醒配置超出范围');}
    if(rule.requirements!==undefined && (!Array.isArray(rule.requirements)||rule.requirements.length>100||rule.requirements.some(x=>typeof x!=='string'||x.length>300))) throw new ApiError('BAD_RULE','材料要求格式无效');
    if(rule.steps!==undefined&&(!Array.isArray(rule.steps)||rule.steps.length>50||rule.steps.some(x=>typeof x!=='string'||!x.trim()||x.length>300)))throw new ApiError('BAD_RULE','办理步骤应为最多50项的非空文本');
  }
  if (existing) {
    run('UPDATE work_type SET navigation_group=? WHERE id=?',[navigation,existing.id]);
    run('UPDATE work_type SET domain=?,executor=?,period_defaults=?,rule_version=rule_version+1 WHERE id=?',[domain,input.executor??existing.executor,defaults,existing.id]);
    run(
      `UPDATE work_type SET name = ?, category = COALESCE(?, category), description = COALESCE(?, description),
         icon = COALESCE(?, icon), color = COALESCE(?, color), sort_order = COALESCE(?, sort_order),
         mode = COALESCE(?, mode),
         archived_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [input.name, input.category ?? null, input.description ?? null, input.icon ?? null, input.color ?? null, input.sort_order ?? null,
       input.mode ?? null, input.archived_at ?? existing.archived_at ?? null, existing.id],
    );
    return existing.id;
  }
  // 已被用户归档的类型，不要因为启动自检而重新种回来
  if (input.archived_at) return 0;
  const r = run(
    `INSERT INTO work_type (code, name, category, description, icon, color, sort_order, mode) VALUES (?,?,?,?,?,?,?,?)`,
    [input.code, input.name, input.category ?? 'admin', input.description ?? null, input.icon ?? null, input.color ?? null, input.sort_order ?? 100,
     mode],
  );
  run('UPDATE work_type SET domain=?,executor=?,period_defaults=? WHERE id=?',[domain,input.executor??'general',defaults,r.lastInsertRowid]);
  if (navigation) run('UPDATE work_type SET navigation_group=? WHERE id=?',[navigation,r.lastInsertRowid]);
  return r.lastInsertRowid;
}

/* ============================== 阶段与规范 ============================== */

/**
 * `position_template.period_dir` 这一列在不在。
 *
 * 它由迁移 011 添加，而迁移是"谁先跑到谁生效"：老库升级、或者有人只跑了 010 没跑 011 时，
 * 这一列可能还不存在。查它、写它都会报 `no such column`。
 * 与「函数返回 undefined 就当作没配置」相比，这里显式认一次列是否存在，
 * 好处是**老库上保存阶段依然成功**（只是期次配置暂时写不进去），而不是整笔更新报 500。
 * 认过的结果缓存在模块变量里；写入失败时清掉缓存，下次重认 —— 万一 011 是后加的也能自愈。
 */
let positionPeriodColumn: boolean | null = null;

function positionPeriodColumnReady(): boolean {
  if (positionPeriodColumn !== null) return positionPeriodColumn;
  positionPeriodColumn = Boolean(get<{ name: string }>("SELECT name FROM pragma_table_info('position_template') WHERE name = 'period_dir'"));
  return positionPeriodColumn;
}

function markPositionPeriodColumnMissing(): void {
  positionPeriodColumn = false;
}

export interface PositionTemplate {
  id: number;
  work_type_id: number;
  code: string;
  name: string;
  seq: number;
  folder_name: string | null;
  description: string | null;
  duration_hint: string | null;
  sort_order: number;
  archived_at: string | null;
  /**
   * 期次目录规则（契约 §5 / §12，迁移 011）：
   *   NULL/'' = 不按期次分目录；'month' | 'quarter' | 'year' 或自定义格式串。
   *   A 型（默认）用 `\` 分层：`{yyyy}\{mm}月` → `2026\10月`（年份一层、月份一层）。
   * 老库（还没跑 011）里这一列不存在，查出来是 undefined —— 与 NULL 同义，不启用。
   */
  period_dir?: string | null;
}

export interface MaterialCheck {
  id: number;
  position_template_id: number;
  name: string;
  category: string;
  template_id: number | null;
  required: number;
  retention: string | null;
  hint: string | null;
  sort_order: number;
}

export interface EvidenceRule {
  id: number;
  position_template_id: number;
  title: string;
  min_count: number;
  max_count: number | null;
  shooting_points: string | null;
  angles: string | null;
  required: number;
  hint: string | null;
  sort_order: number;
}

export interface PositionWithRules extends PositionTemplate {
  materials: MaterialCheck[];
  evidences: EvidenceRule[];
}

export function listPositions(workTypeId: number): PositionWithRules[] {
  const positions = all<PositionTemplate>(
    'SELECT * FROM position_template WHERE work_type_id = ? AND archived_at IS NULL ORDER BY seq, sort_order, id',
    [workTypeId],
  );
  return positions.map((p) => ({
    ...p,
    materials: all<MaterialCheck>('SELECT * FROM material_check WHERE position_template_id = ? AND archived_at IS NULL ORDER BY sort_order, id', [p.id]),
    evidences: all<EvidenceRule>('SELECT * FROM evidence_rule WHERE position_template_id = ? AND archived_at IS NULL ORDER BY sort_order, id', [p.id]),
  }));
}

export function getPosition(id: number): PositionWithRules | undefined {
  const p = get<PositionTemplate>('SELECT * FROM position_template WHERE id = ?', [id]);
  if (!p) return undefined;
  return {
    ...p,
    materials: all<MaterialCheck>('SELECT * FROM material_check WHERE position_template_id = ? AND archived_at IS NULL ORDER BY sort_order, id', [p.id]),
    evidences: all<EvidenceRule>('SELECT * FROM evidence_rule WHERE position_template_id = ? AND archived_at IS NULL ORDER BY sort_order, id', [p.id]),
  };
}

/**
 * 用户填错了（期次格式之类）——**不是服务故障**。
 *
 * 带 `statusCode`/`code` 两个字段，`api/reply.ts` 的 `fail()` 认它们，会直接回
 * `400 + { code, message }`（见那里的 native 分支），路由不必逐个包 try/catch 转 400。
 * 领域层不 import api 层（那是反向依赖），所以只带这两个字段、不带 ApiError 类型。
 * 已经被 `domain400()` 包过的路径（`PUT /api/positions/:id`）行为不变：还是 400 + 同一句话。
 */
class InvalidInputError extends Error {
  readonly code = 'BAD_PERIOD_DIR';
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/**
 * 期次目录配置（`period_dir`）入库前的**唯一**处理：校验 → 归一化。
 * 两条保存路径共用它，行为必须一致：
 *   ① 流程规范页保存阶段模板 → `upsertPosition()`（POST/PUT `/api/position-templates`）
 *   ② 工作台详情里给某个阶段设期次 → `setPositionPeriodDir()`（PUT `/api/positions/:id`）
 *
 * 契约 §12.3：`/` 归一成 `\`、sentinel（default/默认/a…）→ 默认 A 型 `{yyyy}\{mm}月`、去掉空层级；
 * 拒绝 `..`、绝对路径（盘符 / UNC）、`: * ? " < > |` 与控制字符。
 * 最后再拿**渲染结果**过一遍 `isSafePeriodPath` 兜底 —— 格式串本身干净，不代表渲染出来一定安全。
 *
 * @returns 入库用的格式串；'' 表示「不启用期次分目录」（调用方存 null）
 */
function periodSpecForSave(periodDir: string | null | undefined): string {
  const problem = periodSpecProblem(periodDir);
  if (problem) {
    throw new InvalidInputError(
      `${problem}。期次目录只能用文字与 {yyyy}/{yy}/{m}/{mm}/{q}/{d} 占位符，可用 \\ 分层（如 {yyyy}\\{mm}月 → 2026\\10月），不能有 ..、绝对路径或 : * ? " < > |`,
    );
  }
  const spec = normalizePeriodSpec(periodDir);
  if (spec) {
    const sample = periodDirName('monthly', dateOnly(new Date()), spec);
    if (!sample || !isSafePeriodPath(sample)) {
      throw new InvalidInputError(`期次目录格式渲染后不合法（不能有 \\ 之外的路径字符，也不能有 .. 跳转）：${spec}`);
    }
  }
  return spec;
}

export function upsertPosition(input: Partial<PositionTemplate> & { work_type_id: number; code: string; name: string }): number {
  /**
   * period_dir 入库前**必须先过校验 + 归一化**，与 `setPositionPeriodDir` 用同一个函数
   * （`periodSpecForSave`），两条保存路径的行为因此逐字一致。
   *
   * 为什么要在这里补：期次格式有两个入口 —— 流程规范页保存阶段模板（走本函数）、
   * 工作台详情里改某个阶段的期次（走 `setPositionPeriodDir`）。后者一直有校验，前者没有，
   * 于是用户在规范页能存进 `..\..\x` / `C:\abs` / `a*b` 这种坏格式，
   * 一直到真正落盘时 `positionPeriodDirAbs` 才抛「期次目录越界，拒绝使用」——
   * 错误发生在几次操作之后，用户根本对不上是自己填错了格式。
   */
  const periodDir = input.period_dir === undefined ? undefined : periodSpecForSave(input.period_dir) || null;
  const byId = input.id ? get<PositionTemplate>('SELECT * FROM position_template WHERE id=?',[input.id]) : undefined;
  if (input.id && (!byId || byId.work_type_id!==input.work_type_id || byId.code!==input.code)) throw new ApiError('IMMUTABLE_CODE','阶段所属类型和编码不可修改，请编辑原阶段名称和顺序',409);
  const existing = byId ?? get<PositionTemplate>('SELECT * FROM position_template WHERE work_type_id = ? AND code = ?', [input.work_type_id, input.code]);
  if (existing) {
    /**
     * period_dir 走 NULL 语义：null/'' = 不按期次分目录，undefined = 不动。
     * 这一列由迁移 011 添加；老库（还没跑 011）上写它会报 no such column，
     * 这里退化成更新其余列 —— 阶段本身照样保存成功，不因为一个可选配置整笔失败。
     */
    const periodPatch = periodDir === undefined || !positionPeriodColumnReady() ? {} : { period_dir: periodDir };
    const periodAssign = 'period_dir' in periodPatch ? ', period_dir = ?' : '';
    try {
      run(
        `UPDATE position_template SET name = ?, seq = COALESCE(?, seq), folder_name = COALESCE(?, folder_name),
           description = COALESCE(?, description), duration_hint = COALESCE(?, duration_hint),
           sort_order = COALESCE(?, sort_order), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')${periodAssign} WHERE id = ?`,
        [
          input.name, input.seq ?? null, input.folder_name ?? null, input.description ?? null, input.duration_hint ?? null,
          input.sort_order ?? null, ...('period_dir' in periodPatch ? [periodPatch.period_dir as string | null] : []), existing.id,
        ],
      );
    } catch (e) {
      if (!('period_dir' in periodPatch)) throw e;
      markPositionPeriodColumnMissing();
      run(
        `UPDATE position_template SET name = ?, seq = COALESCE(?, seq), folder_name = COALESCE(?, folder_name),
           description = COALESCE(?, description), duration_hint = COALESCE(?, duration_hint),
           sort_order = COALESCE(?, sort_order), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [input.name, input.seq ?? null, input.folder_name ?? null, input.description ?? null, input.duration_hint ?? null, input.sort_order ?? null, existing.id],
      );
    }
    return existing.id;
  }
  const insertPeriod = periodDir === undefined || !positionPeriodColumnReady();
  const r = run(
    `INSERT INTO position_template (work_type_id, code, name, seq, folder_name, description, duration_hint, sort_order${insertPeriod ? '' : ', period_dir'})
     VALUES (?,?,?,?,?,?,?,?${insertPeriod ? '' : ',?'})`,
    [
      input.work_type_id,
      input.code,
      input.name,
      input.seq ?? 1,
      input.folder_name ?? input.name,
      input.description ?? null,
      input.duration_hint ?? null,
      input.sort_order ?? (input.seq ?? 1) * 10,
      ...(insertPeriod ? [] : [periodDir]),
    ],
  );
  return r.lastInsertRowid;
}

export function upsertMaterial(input: Partial<MaterialCheck> & { position_template_id: number; name: string }): number {
  if (input.id) {
    run(
      `UPDATE material_check SET name = ?, category = COALESCE(?, category), template_id = ?, required = COALESCE(?, required),
         retention = COALESCE(?, retention), hint = COALESCE(?, hint), sort_order = COALESCE(?, sort_order) WHERE id = ?`,
      [input.name, input.category ?? null, input.template_id ?? null, input.required ?? null, input.retention ?? null, input.hint ?? null, input.sort_order ?? null, input.id],
    );
    return input.id;
  }
  const r = run(
    `INSERT INTO material_check (position_template_id, name, category, template_id, required, retention, hint, sort_order)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      input.position_template_id,
      input.name,
      input.category ?? 'material',
      input.template_id ?? null,
      input.required ?? 1,
      input.retention ?? null,
      input.hint ?? null,
      input.sort_order ?? 100,
    ],
  );
  return r.lastInsertRowid;
}

export function upsertEvidence(input: Partial<EvidenceRule> & { position_template_id: number; title: string }): number {
  if (input.id) {
    run(
      `UPDATE evidence_rule SET title = ?, min_count = COALESCE(?, min_count), max_count = ?, shooting_points = COALESCE(?, shooting_points),
         angles = COALESCE(?, angles), required = COALESCE(?, required), hint = COALESCE(?, hint), sort_order = COALESCE(?, sort_order) WHERE id = ?`,
      [
        input.title,
        input.min_count ?? null,
        input.max_count ?? null,
        input.shooting_points ?? null,
        input.angles ?? null,
        input.required ?? null,
        input.hint ?? null,
        input.sort_order ?? null,
        input.id,
      ],
    );
    return input.id;
  }
  const r = run(
    `INSERT INTO evidence_rule (position_template_id, title, min_count, max_count, shooting_points, angles, required, hint, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      input.position_template_id,
      input.title,
      input.min_count ?? 1,
      input.max_count ?? null,
      input.shooting_points ?? null,
      input.angles ?? null,
      input.required ?? 1,
      input.hint ?? null,
      input.sort_order ?? 100,
    ],
  );
  return r.lastInsertRowid;
}

export function deleteRule(kind: 'material' | 'evidence', id: number): void {
  if (kind === 'material') run('DELETE FROM material_check WHERE id = ?', [id]);
  else run('DELETE FROM evidence_rule WHERE id = ?', [id]);
}

/* ========================= 目录绑定（契约 §3/§4/§7） ========================= */

/**
 * 平台自己的根目录名：这些是工作台的家当，绝不允许当成某个工作台的资料目录绑进来。
 * 用 basename 判断而不是写死绝对路径 —— 数据目录可以改到 OneDrive/坚果云，
 * 但 `_模板库` 这类名字是 DIRS 里的常量，改不了。
 * `_归档模板` 不在 DIRS 里（那是归档功能自己的目录名），按契约 §3 的清单一并挡掉。
 */
const PLATFORM_ROOT_NAMES: ReadonlySet<string> = new Set([...Object.values(DIRS), '_归档模板']);

/** Windows 下路径比较不区分大小写，去重和唯一性判断都得按这个口径 */
function pathKey(p: string): string {
  const cleaned = resolvePath(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

/** abs 是不是等于 dir，或在 dir 内部（用 relative 判断，不用字符串前缀） */
function sameOrInside(dir: string, abs: string): boolean {
  return isInsideRoot(dir, abs);
}

/** 盘根 / 网络共享根：`D:\`、`\\server\share` —— 绑上去等于把整块盘交给平台 */
function isDriveRoot(abs: string): boolean {
  const cleaned = resolvePath(abs);
  if (/^[A-Za-z]:[\\/]*$/.test(cleaned)) return true;
  const noTail = cleaned.replace(/[\\/]+$/, '');
  if (/^\\\\[^\\/]+[\\/][^\\/]+$/.test(noTail)) return true;
  return false;
}

/** 从数据库里的 external_root 取"已绑定的根"，坏值不当成占用 */
function boundRootEntries(opts: { includeDeleted?: boolean } = {}): { id: number; root: string | null }[] {
  try {
    /**
     * 【占用判定必须连回收站一起看】默认（`includeDeleted: false`）只认在用的工作台 ——
     * 那是"谁有资格贡献一个**可写**允许根"的口径：回收站里的工作台不算在用，它的目录
     * 不该继续挂着"平台可写"的资格。
     *
     * 但**占位判定**（"这个目录是不是已经被别人绑了"）必须用
     * `includeDeleted: true`：回收站里的工作台**仍然占着那个目录**（它的文件记录还在、
     * 还能恢复、彻底删除时还要去那个目录删文件）。以前两件事共用一个过滤，
     * 于是回收站里的工作台不占位 —— 同一个目录能被绑给新工作台，
     * 随后"彻底删除旧工作台"会把新工作台正在用的文件一起 unlink 掉。
     */
    const guard = opts.includeDeleted ? '1=1' : liveFilter('workbench');
    return all<{ id: number; root: string | null }>(
      `SELECT id, external_root AS root FROM workbench WHERE external_root IS NOT NULL AND ${guard}`,
    );
  } catch {
    /**
     * 老库还没跑迁移 010，`external_root` 列不存在。
     * 这时谈不上"已绑定"，返回空 —— 启动不能因为少一列就崩。
     */
    return [];
  }
}

/** 这一行的 external_root 列是否存在（与 period_dir 同理，老库要能跑） */
let workbenchExternalRootColumn: boolean | null = null;
function externalRootColumnReady(): boolean {
  if (workbenchExternalRootColumn !== null) return workbenchExternalRootColumn;
  workbenchExternalRootColumn = Boolean(get<{ name: string }>("SELECT name FROM pragma_table_info('workbench') WHERE name = 'external_root'"));
  return workbenchExternalRootColumn;
}

/* ---------------------- 只读来源 / 平台受保护目录 ---------------------- */

/**
 * 用户显式声明的**只读来源**（`app_setting` 的 `binding.readonly_roots`）。
 *
 * 这是 `core/paths.ts` 那套"根用途"模型的用户入口：iCloud「原件」目录、只读共享、
 * 别人给的资料盘都可以在这里声明。声明进来的目录**只能读** ——
 * 平台不往里写产物、不改名、不删除里面的文件（里面的都是用户的原件）。
 * 用逗号/分号/换行分隔，也接受 JSON 数组；相对路径与盘根一律忽略。
 */
const READONLY_ROOTS_KEY = 'binding.readonly_roots';

function readOnlySourceDeclarations(): string[] {
  let raw: unknown;
  try {
    raw = getSetting<unknown>(READONLY_ROOTS_KEY, '');
  } catch {
    return [];
  }
  if (raw === null || raw === undefined) return [];
  const parts = Array.isArray(raw)
    ? raw.map((x) => String(x))
    : String(raw).split(/[,;，、\r\n]+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Use the same resolved backup path as the backup service to protect its files. */
function backupDirAbs(): string { return backupDirectoryConfig().dir; }

/**
 * 记录里出现过的**历史来源根**（`artifact.root_id = ext:<路径>`）。
 *
 * 改绑资料目录之后，老记录仍按登记时那个目录定位（`root_id` 保证"不重新解释"），
 * 所以那个目录必须留在允许根里 —— 否则老记录会集体变成"路径越界"、下载预览全废。
 * 它们进允许根的方式是"**平台登记过文件的目录**"（可写产物区那一类）：
 * 删除仍然要过允许根 + 只读来源 + 存量指纹 + "是否被别的在用记录引用"四道检查，
 * 所以"留在允许根里"不等于"可以随便删"。
 */
function historicalRootIds(): string[] {
  try {
    if (!ensureArtifactIdentitySchema()) return [];
    const rows = all<{ root_id: string | null }>(
      "SELECT DISTINCT root_id FROM artifact WHERE root_id IS NOT NULL AND root_id LIKE 'ext:%'",
    );
    const out: string[] = [];
    for (const r of rows) {
      const raw = (r.root_id ?? '').slice('ext:'.length).trim();
      if (raw) out.push(raw);
    }
    return out;
  } catch {
    // 老库（还没有 root_id 列）谈不上历史根：返回空，一切按改造前行为
    return [];
  }
}

/**
 * 刷新「允许根」白名单 —— **带用途**（`core/paths.ts` 的 RootPurpose）。
 *
 *   platform  DATA_ROOT（平台数据目录）
 *   writable  当前绑定的资料目录 + 记录里出现过的历史来源根（可写产物区）
 *   readonly  显式声明的只读来源 + 进程写不进去的目录 + **平台受保护目录**
 *
 * core/paths.ts 只认白名单里的绝对路径，所以**任何改变绑定的地方都必须调它**：
 * 绑定、解绑、删除工作台、恢复工作台、以及启动。不调的话，新绑定的目录会被当成越界 ——
 * 用户刚绑好却传不上文件，是最难查的那类问题。
 *
 * 三处刻意的判断：
 *   ① **平台受保护目录一律降级成只读来源**：绑定它的祖先/它本身已经在 `normalizeBindableRoot`
 *      被拒，但**存量数据**里可能已经绑进去了（旧版本放行的）。让它们继续以"只读"留在白名单里，
 *      老记录还能读，但平台的库/备份/运行目录再也删不动、写不动 —— 不会为了兼容把安全丢掉。
 *   ② 写不进去的目录也降级成只读来源（iCloud 占位 / 只读盘）：与其等写文件那一刻报 EPERM，
 *      不如当场说清楚"这是只读来源"。
 *   ③ 备份目录（可能是自定义路径）作为额外的平台受保护根注入 paths.ts。
 */
export function reloadBoundRoots(): string[] {
  // 备份目录先注入：`isPlatformProtected()` 要用它（绑定校验、历史根降级都靠它）
  const backup = backupDirAbs();
  try {
    setExtraProtectedRoots(backup ? [backup] : []);
  } catch {
    /* 注入失败只是少一层保护，不影响启动 */
  }
  // 来源身份列顺手补上（老库）：补列失败不影响绑定刷新
  ensureArtifactIdentitySchema();

  const declared = new Set<string>();
  for (const raw of readOnlySourceDeclarations()) {
    const abs = isAbsolute(raw) ? resolvePath(raw) : null;
    if (abs) declared.add(pathKey(abs));
  }

  const grants: { root: string; purpose: 'writable' | 'readonly' }[] = [];
  const seen = new Set<string>([pathKey(DATA_ROOT)]);

  const add = (rawRoot: string, purpose: 'writable' | 'readonly'): void => {
    const root = (rawRoot ?? '').trim();
    if (!root) return;
    const key = pathKey(root);
    if (seen.has(key)) return;
    seen.add(key);
    /**
     * 显式只读声明、**平台自己的目录**（含它的祖先/后代 —— 存量数据里可能有旧版本放行的绑定）、
     * **存在但写不进去**的目录 → 只读来源；其余为可写产物区。
     *
     * 注意「不存在」这一档**不当成只读**：拔掉的移动盘 / 没连上的网络盘是
     * "这个工作台暂时用不了"，不是"这是只读来源"。把它们降级成只读会让盘插回来之后
     * 依然写不进去（要等下一次重算允许根才发现），那是把临时不可达误判成永久只读。
     */
    const writableHere = !existsSync(root) || isDirWritable(root);
    const effective =
      purpose === 'readonly' || declared.has(key) || isPlatformProtected(root) || !writableHere
        ? 'readonly'
        : 'writable';
    grants.push({ root, purpose: effective });
  };

  for (const row of boundRootEntries()) add(row.root ?? '', 'writable');
  for (const root of historicalRootIds()) add(root, 'writable');
  for (const raw of readOnlySourceDeclarations()) add(raw, 'readonly');

  setRootGrants(grants);
  return [DATA_ROOT, ...grants.map((g) => g.root)];
}

/** 现在生效的允许根（排障用：让人一眼看到到底注入了哪些根、各自的用途） */
export function listBoundRoots(): string[] {
  try {
    const roots = getBoundRoots();
    if (Array.isArray(roots) && roots.length) return roots;
  } catch {
    /* paths.ts 还没初始化过，退回自己算一遍 */
  }
  const roots = [DATA_ROOT];
  const seen = new Set<string>([pathKey(DATA_ROOT)]);
  for (const row of boundRootEntries()) {
    const root = (row.root ?? '').trim();
    if (!root || seen.has(pathKey(root))) continue;
    seen.add(pathKey(root));
    roots.push(root);
  }
  return roots;
}

/** 允许根 + 用途（界面/排障要能说清"这个目录为什么不能写/不能删"） */
export function listBoundRootGrants(): { root: string; purpose: string }[] {
  try {
    return listRootGrants().map((g) => ({ root: g.root, purpose: g.purpose }));
  } catch {
    return listBoundRoots().map((root) => ({ root, purpose: root === DATA_ROOT ? 'platform' : 'writable' }));
  }
}

/**
 * 绑定前的全部校验。任何一条不过都抛**明确的中文错误**，让界面能原样显示给用户。
 * 顺序有意为之：先"是不是合法路径"，再"在不在"，再"能不能当绑定根"，最后"有没有被占用"。
 */
function normalizeBindableRoot(rawPath: string): string {
  if (!externalRootColumnReady()) {
    throw new Error('当前数据库还没有目录绑定功能（缺迁移 010），请先重启以完成数据库升级');
  }

  const input = (rawPath ?? '').trim();
  if (!input) throw new Error('请提供要绑定的文件夹路径');

  const looksAbsolute = /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\') || input.startsWith('/');
  if (!looksAbsolute) throw new Error(`路径必须是绝对路径（如 D:\\工作\\2.安全）：${input}`);

  if (!existsSync(input)) throw new Error(`目录不存在：${input}`);

  /**
   * realpathSync 有两个作用：
   *   1. 把盘符大小写、短名（8.3）、`..` 全部规范化，入库的是唯一形态；
   *   2. 顺手确认这个目录**真的能访问** —— iCloud/OneDrive 的占位目录、
   *      拔掉的移动硬盘、没权限的共享，都在这一步暴露出来，而不是等到写文件时才炸。
   */
  let abs: string;
  try {
    abs = realpathSync(input);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    throw new Error(code === 'ENOENT' ? `目录不存在：${input}` : `目录无法访问：${input}（${code || '未知错误'}）`);
  }

  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`目录无法访问：${abs}`);
  }
  if (!st.isDirectory()) throw new Error(`绑定的必须是文件夹，不是文件：${abs}`);

  if (abs === resolvePath(DATA_ROOT)) throw new Error(`不能绑定数据根目录本身：${DATA_ROOT}`);
  if (sameOrInside(DATA_ROOT, abs)) throw new Error(`该目录在平台数据目录内部，不需要绑定：${abs}`);

  /**
   * 【双向包含检查】**所选目录包含平台数据目录、或它就在平台数据目录/安装目录/
   * 运行目录/备份目录之内 —— 都拒绝**。
   *
   * 以前只挡了「在 DATA_ROOT 内部」，于是绑定 DATA_ROOT 的**祖先**（例如整个项目根
   * `D:\project\工作台`、或者数据目录的上一级）会被放行：平台自己的数据库、备份、
   * 运行目录随后就成了这个工作台的"用户文件"，被纳管之后还能被彻底删除真删。
   * 判断交给 `core/paths.ts` 的 `isPlatformProtected()`（两个方向都查，
   * 且与"允许根/用途"用同一份平台目录清单，不会两边各写一套）。
   */
  const backup = backupDirAbs();
  try {
    setExtraProtectedRoots(backup ? [backup] : []);
  } catch {
    /* 注入失败只是少一层保护 */
  }
  assertNotPlatformProtected(abs, '这个目录');

  if (isDriveRoot(abs)) throw new Error(`不能绑定盘根目录（如 D:\\），请选一个具体的工作文件夹：${abs}`);

  if (PLATFORM_ROOT_NAMES.has(basename(abs))) {
    throw new Error(`这是平台自己的目录，不能作为工作台资料目录绑定：${basename(abs)}`);
  }

  return abs;
}

/**
 * 绑定一个外部资料目录。
 *
 * 只写数据库 + 刷新允许根，**不移动、不复制任何文件**（契约 §7.5：扫描与纳管一律原地登记）。
 * 用户在连接前后自己整理好的目录结构原样保留。
 */
export function bindExternalRoot(id: number, rawPath: string): { externalRoot: string } {
  const wb = getWorkbench(id);
  if (!wb) throw new Error('工作台不存在');
  if (wb.archived_at) throw new Error('已归档的工作台不能绑定目录，请先恢复');
  const abs = normalizeBindableRoot(rawPath);

  /**
   * **占位判定连回收站一起看**（`includeDeleted: true`）：回收站里的工作台仍然占着
   * 它的目录 —— 记录还在、能恢复、彻底删除时还要去那里删文件。以前这里过滤了软删除，
   * 于是同一个目录能被绑给新工作台，接着"彻底删除旧工作台"就把新工作台正在用的
   * 文件 unlink 掉了（`purgeFromTrash` 里另有一道"是否被别的存活记录引用"的复核）。
   */
  const occupied = boundRootEntries({ includeDeleted: true }).find(
    (row) => row.id !== id && row.root && pathKey(row.root) === pathKey(abs),
  );
  if (occupied) {
    // 只为报错信息里显示"这个目录已经绑给谁了"：那个工作台可能在回收站里，
    // 所以这里**有意不加** `deleted_at IS NULL`（否则只能报一个光秃秃的 #id）
    const owner = get<{ code: string; name: string; deleted_at: string | null }>(
      'SELECT code, name, deleted_at FROM workbench WHERE id = ?',
      [occupied.id],
    );
    const where = owner?.deleted_at ? '在回收站里' : '';
    throw new Error(
      `该目录已绑定给另一个工作台${where}：${owner ? `${owner.code} ${owner.name}` : `#${occupied.id}`}` +
        (owner?.deleted_at ? '（它还在回收站里但**仍然占着这个目录**：先恢复它或把它彻底删除，再绑定）' : ''),
    );
  }

  const same = (wb.external_root ?? '').trim();
  if (same && pathKey(same) === pathKey(abs)) return { externalRoot: abs };

  /**
   * 【改绑不得重新解释已有记录】换目录之前，把这份工作台名下**还没有来源身份**的外部记录
   * 钉到**旧根**上（`root_id = ext:<旧根>`）。
   *
   * 为什么必须在这一刻钉：`file_rel` 是相对路径，老记录只写了"相对某个外部根"。
   * 换绑之后如果仍按"当前 external_root"解释，同一个相对路径就变成新目录里的另一个文件 ——
   * 删除旧记录时会删掉用户放在新目录、平台从没登记过的原件。
   * 钉住之后这些记录继续指向旧目录（旧目录作为"历史来源根"留在允许根里，仍可下载/预览）。
   */
  const pinned = same ? pinExternalRecordsToRoot(id, same) : 0;

  run("UPDATE workbench SET external_root = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [abs, id]);
  /**
   * 绑定完必须刷新允许根，否则紧接着的上传/建目录会被路径白名单拒掉。
   * 刷新失败不回滚绑定：库已经写对了，下次启动会自动补上；
   * 反过来把绑定撤掉，用户看到的是"点了没反应"。
   */
  try {
    reloadBoundRoots();
  } catch {
    /* 允许根刷新失败不阻断绑定，下次启动会重来 */
  }
  syncPositionFolders(id);
  if (pinned) console.log(`[目录绑定] 工作台 #${id} 改绑目录，已把 ${pinned} 条老记录钉在旧目录 ${same} 上（不会被重新解释）`);
  return { externalRoot: abs };
}

/**
 * 把这份工作台名下**没有来源身份**的外部记录钉到指定根上。幂等：已经有 root_id 的不动。
 * 列不存在（老库 / 补列失败）时直接返回 0，绝不因此让绑定失败。
 */
function pinExternalRecordsToRoot(workbenchId: number, root: string): number {
  const rootId = externalRootId(root);
  if (!rootId) return 0;
  try {
    if (!ensureArtifactIdentitySchema()) return 0;
    const r = run(
      "UPDATE artifact SET root_id = ? WHERE workbench_id = ? AND root_id IS NULL AND COALESCE(root_kind,'data') = 'external'",
      [rootId, workbenchId],
    );
    return Number(r.changes);
  } catch (e) {
    console.warn(`[目录绑定] 老记录来源身份回填失败（不影响绑定，删除时仍有指纹复核）：${(e as Error).message}`);
    return 0;
  }
}

/**
 * 解绑：**只把 external_root 置成 NULL**，绝不碰磁盘上的任何文件（契约 §7.2）。
 * 解绑之后这个工作台回到"数据目录里自己那份文件夹"的老语义。
 */
export function unbindExternalRoot(id: number): void {
  const wb = getWorkbench(id);
  if (!wb) throw new Error('工作台不存在');
  run("UPDATE workbench SET external_root = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?", [id]);
  try {
    reloadBoundRoots();
  } catch {
    /* 同上：不阻断解绑 */
  }
}

/** 绑定信息：目录在不在、里面有多少文件 —— 界面「资料目录」行要用 */
export interface BoundFolderInfo {
  externalRoot: string | null;
  exists: boolean;
  isDir: boolean;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
}

export function getBoundFolderInfo(id: number): BoundFolderInfo {
  const wb = getWorkbench(id);
  if (!wb) throw new Error('工作台不存在');
  const root = (wb.external_root ?? '').trim() || null;
  const info: BoundFolderInfo = { externalRoot: root, exists: false, isDir: false, fileCount: 0, dirCount: 0, totalBytes: 0 };
  if (!root) return info;

  if (!existsSync(root)) {
    /**
     * 契约 §7.4：绑定目录消失/改名要**明确报错**，不能含糊成"文件数 0"。
     * 但这里同时也要把状态带回界面（exists:false），所以不抛异常 ——
     * 抛在这里会让「工作台详情」整页打不开，用户反而看不到是哪个目录丢了。
     */
    return info;
  }
  let st;
  try {
    st = statSync(root);
  } catch {
    return info;
  }
  info.exists = true;
  info.isDir = st.isDirectory();
  if (!info.isDir) return info;

  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      let s;
      try {
        s = statSync(abs);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        info.dirCount += 1;
        walk(abs, depth + 1);
      } else {
        info.fileCount += 1;
        info.totalBytes += s.size;
      }
    }
  };
  walk(root, 0);
  return info;
}

/**
 * 阶段目录名。
 *
 * 【未绑定的工作台必须与改造前逐字一致】旧代码是
 *   `p.folder_name || safeName('NN_阶段名')`，而 `upsertPosition` 建阶段时把 folder_name
 *   默认写成**阶段名本身**（folder_name 非空），于是老库里跑出来的目录一直是 `01_安全生产例会`。
 * 也就是说「folder_name 等于阶段名」= 用户没自己起过名，要继续走 `NN_阶段名`；
 * 只有用户真的改成了一个不同的名字（例如绑定根里已有的 `1.安全生产例会`），才原样采用。
 *
 * 绑定的工作台反过来：用户在界面里从绑定根挑到的就是最终目录名（契约 §4：
 * 复用用户已有的子文件夹，别自作主张加序号），所以此时 folder_name 一律原样用。
 */
function stageDirName(p: { seq: number; name: string; folder_name: string | null }, bound: boolean): string {
  const configured = (p.folder_name ?? '').trim();
  const preferred = configured || p.name;
  if (bound) return safeName(preferred, '阶段');
  if (configured && configured !== p.name) return safeName(configured, '阶段');
  return safeName(`${String(p.seq).padStart(2, '0')}_${p.name}`);
}

export interface PositionInstance {
  id: number;
  workbench_id: number;
  position_template_id: number | null;
  code: string;
  name: string;
  seq: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  owner: string | null;
  note: string | null;
  folder_rel: string | null;
  sort_order: number;
}

/**
 * 这份工作台**当前期次**的日期（YYYY-MM-DD）：
 *   `schedule_due_date`（当前欠办那一期）→ `last_done_period`（上次完成的那期）
 *   → `actual_end_date`（实际结束日）→ 今天。
 *
 * 【为什么单次工作（`recurrence='once'`）也要给日期】
 * 以前这里第一句是 `if (wb.recurrence === 'once') return null;` —— 把"要不要周期提醒"和
 * "文件按年月分层归档"当成了同一件事。用户要的是后者：期次目录是**按年月分层归档**，
 * 跟这份工作是不是周期工作无关。所以只要阶段配了 `period_dir` 就分层，`once` 的当前期次
 * 通常就是今天（例如落成 `2026\10月`）。
 * 判据链顺序由用户定稿：先看有没有持久化的到期日，再看上次完成的那期，再看实际结束日，
 * 最后才落到今天 —— 保证「同一份工作台在同一期内落点稳定」。
 */
export function workbenchDuePeriod(wb: Workbench, now: Date = new Date()): string | null {
  const persisted = dueDay(wb.schedule_due_date);
  if (persisted) return persisted;
  const lastPeriod = dueDay(wb.last_done_period);
  if (lastPeriod) return lastPeriod;
  const ended = dueDay(wb.actual_end_date);
  if (ended) return ended;
  return dateOnly(now);
}

/** 该阶段配置的期次规则：NULL/'' = 不启用；列不存在（老库）同样当作不启用 */
function positionPeriodSpec(templateId: number | null, positionCode: string | null, workbenchId: number): string | null {
  return get<{period_dir:string|null}>('SELECT period_dir FROM position_instance WHERE workbench_id=? AND (position_template_id=? OR code=?) AND deleted_at IS NULL',[workbenchId,templateId,positionCode])?.period_dir || null;
}

/**
 * 阶段实例 → 该阶段的目录设置（用户选的目录名 + 期次规则）。
 *
 * 创建时复制默认，读取及调整只针对本实例；模板变化不迁移已有文件。
 */
function positionDirMeta(p: PositionInstance): { folderName: string | null; periodSpec: string | null } {
  const row=get<{folder_name:string|null;period_dir:string|null}>('SELECT folder_name,period_dir FROM position_instance WHERE id=?',[p.id]);
  return {folderName:row?.folder_name??null,periodSpec:row?.period_dir??null};
}

/**
 * 一个阶段目录的**绝对路径**（不含期次）。
 * 未绑定的工作台 = `DATA_ROOT/<folder_path>/<阶段目录名>`，与改造前逐字一致；
 * 绑定的工作台 = `<external_root>/<阶段目录名>`。
 */
export function positionDirAbs(wb: Workbench, p: { seq: number; name: string; folder_name: string | null }): string {
  return join(workbenchRootAbs(wb), stageDirName(p, Boolean((wb.external_root ?? '').trim())));
}

/**
 * 把期次目录名接到阶段目录后面。期次名可能是**多级**的（A 型 `2026\10月`），
 * 所以逐段 `join`（不用 `join(stage, name)` 一把拼）：`\` 在非 Windows 平台上
 * 不是分隔符，逐段拼才能保证「一段 = 一层目录」的语义跨平台一致。
 * `..` / 空层级 / 非法字符由 `isSafePeriodPath` 提前挡掉，这里只负责拼接。
 */
function joinPeriodPath(stage: string, name: string): string {
  let abs = stage;
  for (const seg of name.split('\\')) {
    const t = seg.trim();
    if (t) abs = join(abs, t);
  }
  return abs;
}

/**
 * 阶段目录 + 期次目录的绝对路径（落盘用）。
 * **期次层只看该阶段有没有配 `period_dir`**（契约 §5 的用户修订）：
 *   · `period_dir` 非空 → 按「当前期次」分层，`recurrence` 是 once / monthly / quarterly / yearly 都一样；
 *   · `period_dir` 为空 → 就是阶段目录本身（未绑定工作台、以及没开期次的阶段行为完全不变）。
 *
 * 【以前的错设计】这里第一句是 `if (wb.recurrence === 'once') return stage;`。
 * 建台不传 `recurrence` 时库里落的是 `'once'`，于是哪怕用户在界面上把阶段设成 `{yyyy}\{mm}月`，
 * 期次层也永远不生效（2026-10-01 端到端验收问题①）。「要不要周期提醒」和
 * 「文件按年月分层归档」是两件事，不能互相短路。
 *
 * **期次目录可以是多级的（A 型 `2026\10月`）**，拼完必须再确认落在**工作台根**
 * （绑定根 / DATA_ROOT 下的工作台目录）之内：格式串是用户可编辑的，`..\..`、
 * 绝对路径、UNC 都能把文件写到根外面去。名字层面的非法字符在 `isSafePeriodPath` 卡，
 * 路径层面的越界在这里用 `isInsideRoot` 卡（`relative()` 判，不用字符串前缀）。
 */
export function positionPeriodDirAbs(
  wb: Workbench,
  p: { seq: number; name: string; folder_name: string | null; period_dir?: string | null; period_template_id?: number | null; period_code?: string | null },
  now: Date = new Date(),
): string {
  const stage = positionDirAbs(wb, p);
  const spec = (p.period_dir ?? '').trim() || positionPeriodSpec(p.period_template_id ?? null, p.period_code ?? null, wb.id) || null;
  if (!spec) return stage;
  const name = periodDirName(wb.recurrence, workbenchDuePeriod(wb, now), spec as PeriodKind | null);
  if (!name || !isSafePeriodPath(name)) return stage;
  const abs = joinPeriodPath(stage, name);
  const rootAbs = workbenchRootAbs(wb);
  if (!isInsideRoot(rootAbs, abs)) {
    throw new Error(`期次目录越界，拒绝使用：${name} 解析后是 ${abs}，不在工作台根 ${rootAbs} 之内`);
  }
  return abs;
}

/**
 * 按「工作台 + 阶段 code」求落盘目录（含期次）—— 出文书、影像入库这类
 * 只知道阶段代码、不知道目录名的调用方用它，免得自己重新拼一遍路径。
 * 阶段查不到时返回 null，调用方自己决定回退到哪（绝不瞎猜一个目录写文件）。
 */
export function positionPeriodDirAbsByCode(workbenchId: number, positionCode: string | null | undefined, now: Date = new Date()): string | null {
  const wb = getWorkbench(workbenchId);
  if (!wb) return null;
  const code = (positionCode ?? '').trim();
  if (!code) return null;
  const pos = getPositionInstance(workbenchId, code);
  if (!pos) return null;
  const meta = positionDirMeta(pos);
  return positionPeriodDirAbs(wb, { seq: pos.seq, name: pos.name, folder_name: meta.folderName, period_dir: meta.periodSpec, period_template_id: pos.position_template_id, period_code: pos.code }, now);
}

/**
 * 按工作台 + 阶段 code 找那份阶段实例（出文书、扫目录要用绝对目录）。
 *
 * **软删除过滤**：回收站里的阶段不算"这个工作台的阶段"。严格说不加过滤也能走通
 * （因为它的工作台同样在回收站里，`getWorkbench` 拿不到），但那样一旦有人先恢复了
 * 工作台、还没恢复阶段，出文书就会往一个"界面上看不见的阶段目录"里写文件。
 * 这里只认 `deleted_at IS NULL` 的那一份，拿不到就让调用方自己决定回退到哪。
 */
export function getPositionInstance(workbenchId: number, code: string): PositionInstance | undefined {
  return get<PositionInstance>(
    `SELECT * FROM position_instance
      WHERE workbench_id = ? AND code = ? AND deleted_at IS NULL`,
    [workbenchId, code],
  );
}

/* ============================== 输出位置（契约 §4） ============================== */

/**
 * 输出位置模式（迁移 013）：
 *   inline（默认；NULL 视作它）—— **就地生成**，文件落在"它本该在的地方"
 *   subdir                    —— 阶段目录下用平台的 `_生成文书/_影像证据/_原始资料` 分开
 *   custom                    —— 全部落进一个自定义绝对路径（契约标注：仅测试用）
 */
export type OutputMode = 'inline' | 'subdir' | 'custom';

/** inline 模式下影像证据落在阶段目录里的哪个子目录（契约 §4：用户的目录里本来就有「照片」） */
export const EVIDENCE_PHOTO_DIR = '照片';

/**
 * 认不出的值一律当 inline。
 * 老库（还没跑迁移 013）查出来是 undefined，与 NULL 同义；脏数据也不该让"文件去哪了"变成未知。
 */
export function normalizeOutputMode(value: string | null | undefined): OutputMode {
  const v = (value ?? '').toString().trim().toLowerCase();
  return v === 'subdir' || v === 'custom' ? v : 'inline';
}

/** `workbench.output_mode` 这一列在不在（迁移 013；与 external_root / period_dir 同样的老库防呆） */
let workbenchOutputColumn: boolean | null = null;

function outputModeColumnReady(): boolean {
  if (workbenchOutputColumn !== null) return workbenchOutputColumn;
  workbenchOutputColumn = Boolean(
    get<{ name: string }>("SELECT name FROM pragma_table_info('workbench') WHERE name = 'output_mode'"),
  );
  return workbenchOutputColumn;
}

/** 工作台的输出位置模式；NULL / 空串 / 脏值 → inline */
export function workbenchOutputMode(wb: Pick<Workbench, 'output_mode'>): OutputMode {
  return normalizeOutputMode(wb.output_mode);
}

/** 是否绑定了外部资料目录（未绑定 = 平台数据目录里的老布局） */
export function isWorkbenchBound(wb: Pick<Workbench, 'external_root'>): boolean {
  return Boolean((wb.external_root ?? '').trim());
}

/**
 * custom 模式的自定义输出目录（绝对路径）；没配置返回 null。
 *
 * **必须落在工作台自己的根之内**（绑定后 = external_root，未绑定 = DATA_ROOT/<folder_path>）。
 * 理由不是洁癖：`artifact.file_rel` 是相对**该工作台的根**存的（绝对路径不落库），
 * 下载 / 预览 / OCR 全靠 `artifactAbsPath` 用「工作台根 + file_rel」现算。
 * 输出目录跑到根外面，入库那一刻看着没问题，之后这份文件就再也定位不到了
 * （点击下载会说"文件已不在磁盘上"）。所以这里当场拒掉，而不是等用户来问文件去哪了。
 */
export function customOutputDirAbs(wb: Workbench): string | null {
  const raw = (wb.custom_output_dir ?? '').toString().trim();
  if (!raw) return null;
  if (!isAbsolute(raw)) throw new Error(`自定义输出目录必须是绝对路径（如 D:\\工作\\输出）：${raw}`);
  const abs = resolvePath(raw);
  const root = workbenchRootAbs(wb);
  if (!isInsideRoot(root, abs)) {
    throw new Error(`自定义输出目录必须在这个工作台的资料目录之内：${abs} 不在 ${root} 之内`);
  }
  return abs;
}

/** 落盘产物的三类（契约 §4 的三行）：生成文书 / 影像证据 / 原始资料（扫描件算原始资料） */
export type OutputKind = 'generated' | 'evidence' | 'source';

export interface OutputDirOptions {
  /** 阶段代码（position_instance.code）；给了才算得出「阶段目录」，不给则退回工作台根 */
  positionCode?: string | null;
  /** 没有阶段代码时给个兜底名字（影像走未绑定的老布局时用得上） */
  stageLabel?: string | null;
}

/**
 * 「这份工作台的这类产物该落在哪个目录」—— 落点的**唯一实现**（契约 §4）。
 *
 *   inline → `<阶段目录>\<期次>\`，影像多一层 `照片\`
 *   subdir → `<阶段目录>\<期次>\_生成文书\` / `_影像证据\` / `_原始资料\`
 *   custom → `custom_output_dir`
 *
 * 期次那一层由现成的 `positionPeriodDirAbsByCode()` 决定（阶段没配 period_dir 就不加这一层）；
 * 阶段目录名一律走 `positionDirAbs` / `stageDirName`，**不在这里手拼目录名**
 * （契约 §10.1：猜错目录名会让文件落到别处，是最难排查的一类问题）。
 *
 * 【未绑定的工作台保持改造前的落点，逐字不变】（契约 §9 S1 "不绑定的工作台行为与现在完全一致"）：
 *   文书 → `<根>\_生成文书\<阶段目录名>\<期次层级>\`（没配期次时就是 `<根>\_生成文书\<阶段目录名>\`）
 *   影像 → `<根>\_影像证据\<阶段名>\`
 *   资料 → `<根>\_原始资料\`
 * 也就是 inline / subdir 只对**绑定型**工作台生效 —— 只有那时"文件本该在的地方"才是用户自己的目录。
 * 例外是 custom：它是用户显式指定的绝对路径（且必须在本工作台根之内），绑定与否都照办。
 *
 * 【期次层级必须整段保留】**以前这里取的是 `basename(阶段/期次路径)`** ——
 * 期次目录是两级的（`{yyyy}\{mm}月` → `2026\10月`）时**年度那一层被丢掉了**，
 * 于是未绑定工作台落到 `_生成文书\10月\`，而绑定型工作台落在 `<阶段目录>\2026\10月\`：
 * 同一份规范、同一个期次，两边的层级口径不一致（用户按年翻档案时找不到东西）。
 * 现在按"相对工作台根的整段路径"拼，与 `positionPeriodDirAbs` / 详情页的
 * `folder_rel_current` 用同一口径（都出自 `positionPeriodDirAbsByCode`），
 * 期次有几层就保留几层。**已落盘的老文件不动**：它们的位置记在各条 `artifact.file_rel` 里。
 */
export function workbenchOutputDirAbs(wb: Workbench, kind: OutputKind, opts: OutputDirOptions = {}): string {
  const root = workbenchRootAbs(wb);
  const mode = workbenchOutputMode(wb);
  const positionCode = (opts.positionCode ?? '').trim() || null;

  if (mode === 'custom') {
    const custom = customOutputDirAbs(wb);
    if (!custom) throw new Error('这个工作台设成了自定义输出位置（custom），但没有配置自定义目录（custom_output_dir）');
    return custom;
  }

  if (!isWorkbenchBound(wb)) {
    if (kind === 'generated') {
      const stageOrPeriod = positionPeriodDirAbsByCode(wb.id, positionCode);
      if (!stageOrPeriod) return join(root, DIRS.generated);
      /**
       * 取"相对工作台根的整段路径"（`<阶段目录名>` 或 `<阶段目录名>\<期次各层>`），
       * **不是 basename**：期次是 `2026\10月` 这种两级名字时，basename 会丢掉年度层级。
       * 逐段校验一次（`..` / 越界不进库），再接到平台自己的 `_生成文书` 下面。
       */
      const rel = relative(root, stageOrPeriod);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return join(root, DIRS.generated);
      return join(root, DIRS.generated, ...rel.split(/[\\/]+/).filter(Boolean));
    }
    if (kind === 'evidence') return join(root, DIRS.evidence, safeName(opts.stageLabel || positionCode || '未分阶段'));
    return join(root, DIRS.source);
  }

  const stageAbs = positionPeriodDirAbsByCode(wb.id, positionCode) ?? root;
  if (mode === 'subdir') {
    const sub = kind === 'generated' ? DIRS.generated : kind === 'evidence' ? DIRS.evidence : DIRS.source;
    return join(stageAbs, sub);
  }
  return kind === 'evidence' ? join(stageAbs, EVIDENCE_PHOTO_DIR) : stageAbs;
}

/**
 * 设置工作台的输出位置模式（迁移 013）。
 *
 * 只改工作台这一行，**不搬动任何已有文件**：已落盘的文件位置由各自的 `artifact.file_rel` 记着，
 * 换模式不会让旧文件凭空消失（它们仍在原处，仍能下载/预览/检索）。新文件按新模式落。
 */
export function setWorkbenchOutputMode(
  id: number,
  mode: string,
  customDir?: string | null,
): { outputMode: OutputMode; customOutputDir: string | null } {
  const wb = getWorkbench(id);
  if (!wb) throw new Error('工作台不存在');
  if (!outputModeColumnReady()) throw new Error('当前数据库还没有输出位置设置（缺迁移 013），请先重启以完成数据库升级');

  const wanted = (mode ?? '').toString().trim().toLowerCase();
  if (wanted !== 'inline' && wanted !== 'subdir' && wanted !== 'custom') {
    throw new Error(`输出位置模式只能是 inline（就地）/ subdir（平台子目录）/ custom（自定义目录）：${mode}`);
  }

  let custom = (wb.custom_output_dir ?? '').toString().trim() || null;
  if (customDir !== undefined) custom = (customDir ?? '').toString().trim() || null;
  if (wanted === 'custom') {
    if (!custom) throw new Error('选「自定义输出位置」时必须给一个绝对路径（customDir）');
    custom = customOutputDirAbs({ ...wb, custom_output_dir: custom });
  }

  run(
    "UPDATE workbench SET output_mode = ?, custom_output_dir = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    [wanted, custom, id],
  );
  return { outputMode: wanted, customOutputDir: custom };
}

/**
 * 阶段目录名改过之后，把这份工作台受影响的阶段实例的 folder_rel 对齐过来。
 * 对外暴露是因为改的入口在「流程规范」页（改模板），而生效对象是所有用到该模板的工作台；
 * 只对某个工作台调用，避免"改一次模板全库重算"。
 */
export function relocatePositionFolders(workbenchId: number): void {
  syncPositionFolders(workbenchId);
}

/**
 * 建台/绑定时把阶段实例的 folder_rel 对齐到当前根。
 * 只动 `folder_rel` 这一列（它是**展示与标识用**的相对路径），不建目录、不搬文件。
 */
function syncPositionFolders(workbenchId: number): void {
  const wb = getWorkbench(workbenchId);
  if (!wb) return;
  const rows = all<PositionInstance & { folder_name: string | null }>(
    `SELECT p.* FROM position_instance p
      WHERE p.workbench_id = ? AND ${liveFilter('position_instance', 'p')}`,
    [workbenchId],
  );
  for (const p of rows) {
    const rel = toPosix(relative(workbenchRootAbs(wb), positionDirAbs(wb, { seq: p.seq, name: p.name, folder_name: p.folder_name })));
    if (rel && rel !== p.folder_rel) run('UPDATE position_instance SET folder_rel = ? WHERE id = ?', [rel, p.id]);
  }
}

/* ============================== 工作台 ============================== */

export interface Workbench {
  business_content: string;
  reference_root: string|null;
  historical: number;
  id: number;
  code: string;
  name: string;
  work_type_id: number;
  status: string;
  priority: string;
  owner: string | null;
  counterpart: string | null;
  contract_no: string | null;
  contract_amount: number | null;
  start_date: string | null;
  plan_end_date: string | null;
  actual_end_date: string | null;
  folder_path: string;
  summary: string | null;
  tags: string | null;
  profile: string | null;
  progress: number;
  /** 周期性工作：once 单次 | monthly 每月 | quarterly 每季度 | yearly 每年 */
  recurrence: string;
  /** 每月/每季度的日号（1–28） */
  recur_day: number | null;
  /** yearly 的月份 */
  recur_month: number | null;
  /** 上次完成时间 */
  last_done_at: string | null;
  /** 提前几天提醒 */
  remind_days: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  schedule_due_date: string | null;
  last_done_period: string | null;
  archive_status: string | null;
  template_ids:string|null;
  /**
   * 绑定的外部资料目录绝对路径；NULL = 仍用 dataRoot 下的 folder_path（迁移 010）。
   * 老库（还没跑 010）查出来是 undefined，与 NULL 同义。
   */
  external_root?: string | null;
  /**
   * 输出位置模式（迁移 013，契约 §4）：NULL / '' / 脏值一律当 'inline'（就地生成）。
   * 落点由 `workbenchOutputDirAbs()` 统一算，别在别处再拼一遍路径。
   */
  output_mode?: string | null;
  /**
   * 'custom' 模式用的自定义输出目录（绝对路径，迁移 013）；其它模式忽略它。
   * 必须落在本工作台的根之内，见 `customOutputDirAbs()`。
   */
  custom_output_dir?: string | null;
  /**
   * 软删除时间（迁移 015）：非空 = 这份工作在回收站里，所有默认查询都排除它。
   * 与 `archived_at`（归档，仍在库里可查）是两回事，见 `deleteWorkbench()` 的说明。
   */
  deleted_at?: string | null;
}

/**
 * 生成工作台编号，如 2026-P-001（项目）/ 2026-A-001（行政管理）。
 *
 * 按 domain 业务领域分配 A/P 前缀，与是否有阶段无关。
 */
export function nextWorkbenchCode(workType: WorkType): string {
  const year = new Date().getFullYear();
  const prefix = workType.domain === 'project' ? 'P' : 'A';
  const like = `${year}-${prefix}-%`;
  /**
   * **有意不加** `deleted_at IS NULL`：`workbench.code` 是唯一列，回收站里的工作台照样占着
   * 它的编号。给下一个新工作台发号时必须把它们也算进来，否则会撞唯一约束、
   * 报一句看不懂的数据库错误（而不是"编号已存在"）。也就是要连 `deleted_at IS NOT NULL` 的算进去。
   */
  const row = get<{ code: string }>('SELECT code FROM workbench WHERE code LIKE ? ORDER BY code DESC LIMIT 1', [like]);
  const last = row?.code ? Number(row.code.split('-').pop()) : 0;
  return `${year}-${prefix}-${String((Number.isFinite(last) ? last : 0) + 1).padStart(3, '0')}`;
}

export interface CreateWorkbenchInput {
  navigationGroup?: string;
  domain?: string;
  name: string;
  workTypeId: number;
  historical?: boolean;
  actualEndDate?: string;
  firstPeriod?: string;
  periodRule?: Record<string,unknown>;
  code?: string;
  owner?: string;
  counterpart?: string;
  contractNo?: string;
  contractAmount?: number;
  startDate?: string;
  planEndDate?: string;
  summary?: string;
  tags?: string[];
  profile?: Record<string, unknown>;
  /** 是否按阶段模板建目录与清单，默认 true */
  instantiatePositions?: boolean;
  /** 周期性工作设置（仅行政管理工作用） */
  recurrence?: string;
  recurDay?: number | null;
  recurMonth?: number | null;
  remindDays?: number | null;
  /**
   * 这份工作要用哪些模板。
   *
   * 为什么要显式绑定：一个工作类型下的模板可能很多（如行政管理下既有清廉工程的表、
   * 也可能有别的），全列出来会让人分不清哪份该用哪个。建工作时选定，
   * 之后「出文书」页只显示这几份，界面清爽且不会拿错模板。
   * 不选则回退到该工作类型的全部模板。
   */
  templateIds?: number[];
}

const RECURRENCES = new Set(['once', 'monthly', 'quarterly', 'yearly']);

export function createWorkbench(input: CreateWorkbenchInput): Workbench {
 return tx(()=>{
  const wt = getWorkType(input.workTypeId);
  if (!wt || wt.archived_at) throw new ApiError('BAD_TYPE','工作类型不存在或已停用，请重新选择');
  if (input.domain !== undefined && input.domain !== wt.domain) throw new ApiError('BAD_CATEGORY','所选类型不属于当前工作入口');
  if (input.navigationGroup !== undefined && input.navigationGroup !== workTypeNavigation(wt).navigation_group) throw new ApiError('BAD_CATEGORY','所选类型不属于当前项目分类，请重新选择');
  // 通用零散事务改为工作记录，仅限制新建；不改历史工作与专项流程。
  if(wt.domain==='admin'&&wt.mode==='document'&&['temporary-task','integrity-temporary','admin'].includes(wt.code)&&!wt.period_defaults&&!input.periodRule&&(!input.recurrence||input.recurrence==='once'))throw new ApiError('USE_WORK_RECORD','普通单次工作已改为工作记录，请直接记下工作情况；旧工作仍可查看');
  // 在建目录前校验，拒绝隐藏的旧模板且不留下空目录。
  if (input.templateIds?.some(id => !Number.isSafeInteger(id) || !getTemplate(id) || getTemplate(id)!.archived_at || !templateSupportsWorkType(getTemplate(id)!, wt.id))) throw new ApiError('BAD_TEMPLATES','模板不存在、已停用或不属于当前工作类型');
  if(input.historical&&wt.domain!=='project')throw new ApiError('BAD_HISTORY','历史结束补录仅适用于项目实施');
  if(input.historical && input.actualEndDate && (!Number.isFinite(Date.parse(input.actualEndDate+'T00:00:00Z')) || new Date(input.actualEndDate+'T00:00:00Z').toISOString().slice(0,10)!==input.actualEndDate)) throw new ApiError('BAD_DATE','实际结束日期无效；暂不确定可留空待核对');
  if(wt.mode==='process' && input.recurrence && input.recurrence!=='once') throw new ApiError('STAGE_PERIOD_CONFLICT','阶段式工作暂不支持独立期次，请单独建立周期报送工作');
  const code = input.code?.trim() || nextWorkbenchCode(wt);
  const folderName = workbenchFolderName(code, input.name);
  const folderRel = toPosix(join(DIRS.workbench, folderName));
  const recurrence = RECURRENCES.has(String(input.recurrence)) ? String(input.recurrence) : 'once';
  const profile = { ...(input.profile ?? {}) };
  delete profile.templateIds;

  const id = tx(() => {
    const r = run(
      `INSERT INTO workbench (code, name, work_type_id, status, priority, owner, counterpart, contract_no, contract_amount,
         start_date, plan_end_date, folder_path, summary, tags, profile,
         recurrence, recur_day, recur_month, remind_days)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        code,
        input.name,
        input.workTypeId,
        'active',
        'normal',
        input.owner ?? null,
        input.counterpart ?? null,
        input.contractNo ?? null,
        input.contractAmount ?? null,
        input.startDate ?? (input.historical?null:dateOnly()),
        input.planEndDate ?? null,
        folderRel,
        input.summary ?? null,
        input.tags?.length ? JSON.stringify(input.tags) : null,
        Object.keys(profile).length ? JSON.stringify(profile) : null,
        recurrence,
        input.recurDay ?? null,
        input.recurMonth ?? null,
        input.remindDays ?? 3,
      ],
    );
    return r.lastInsertRowid;
  });

  if(input.templateIds) setBoundTemplateIds(id,input.templateIds,[]);
  /**
   * 首次到期日必须**不早于今天**。
   *
   * computeSchedule 在没有完成记录时取的是「今天所在周期的锚点日」，它可能已经过去：
   * 行政工作默认每月 5 号，于是每月 6 号之后建出来的工作一建好就显示「已逾期 N 天」；
   * 年度工作（1 月 10 号）在 9 月建更是显示逾期 258 天。而排期一旦有持久化到期日，
   * 就只有明确完成才会推进（见 schedule.ts 的设计说明），这个状态不会自愈，
   * 所以写入前就纠正成「下一个未过的锚点日」。
   *
   * 只改新建这条路径：存量数据的回填在 core/startup-repair.ts，
   * 是否让老数据立刻显示本月欠办是产品决定，不在这里动。
   */
  const dueSpec:ScheduleSpec={recurrence:recurrence as ScheduleSpec['recurrence'],recur_day:input.recurDay,recur_month:input.recurMonth};
  const now=new Date();
  const sched=computeSchedule(dueSpec,now);
  const initialDue=sched.recurring && sched.overdueDays>0 ? dateOnly(nextOccurrenceOnOrAfter(dueSpec,now)) : sched.nextDue;
  if(initialDue) run('UPDATE workbench SET schedule_due_date=? WHERE id=?',[initialDue,id]);
  /**
   * 建目录一律基于 workbenchRootAbs：
   *   未绑定的工作台 = DATA_ROOT/<folder_path>（与改造前逐字一致）
   *   已绑定的工作台 = external_root（新建出来时还没绑定，绑定后由 bindExternalRoot 接管）
   * 一条路径两种情形，避免"建台去了数据目录、上传去了外部目录"这种半截状态。
   */
  const rootAbs = workbenchRootAbs({ folder_path: folderRel, external_root: null });
  ensureDir(rootAbs);
  ensureDir(join(rootAbs, DIRS.generated));
  ensureDir(join(rootAbs, DIRS.source));

  run('UPDATE workbench SET rules_snapshot=?,historical=? WHERE id=?',[JSON.stringify({type:wt,positions:listPositions(wt.id)}),input.historical?1:0,id]);
  if (input.instantiatePositions !== false && wt.mode === 'process') instantiatePositions(id);
  if(input.periodRule || wt.period_defaults) {
    const defaults=input.periodRule??JSON.parse(wt.period_defaults!), today=todayShanghai();
    const first=input.firstPeriod ?? (defaults.frequency==='monthly'?today.slice(0,7):defaults.frequency==='quarterly'?today.slice(0,4)+'-Q'+Math.ceil(Number(today.slice(5,7))/3):today.slice(0,4));
    savePeriodRule(id,{...defaults,first_period:first}); syncPeriods(id);
  }
  if(input.historical) run("UPDATE workbench SET status='done',actual_end_date=? WHERE id=?",[input.actualEndDate||null,id]);
  return getWorkbench(id) as Workbench;
 });
}

/**
 * 按 id 取工作台。
 *
 * 【这里**有意不加** `deleted_at IS NULL`】—— 它返回的是"这一行本身"，不是"给用户看的列表"：
 *   · 界面上的列表/首页/助手列工作，都走 `listWorkbenches()`，那里已经排除了回收站里的；
 *   · 但回收站要恢复它、`restoreFromTrash` 要读它的 code/external_root、彻底删除要读它的
 *     folder_path —— 这些都必须拿到已软删除的那一行；
 *   · 加过滤的话，`PUT /api/workbenches/:id` 这类接口对回收站里的工作台会退化成
 *     "工作台不存在"（404），用户想从回收站里救回来就没了入口。
 * 需要"只要在用的"时，用 `listWorkbenches()` 或 `getWorkbenchLive()`。
 */
export function getWorkbench(id: number): Workbench | undefined {
  // 有意不加 `deleted_at IS NULL`：回收站里的工作台（deleted_at IS NOT NULL）也要能按 id 取到
  return get<Workbench>('SELECT * FROM workbench WHERE id = ?', [id]);
}

/** 只要**在用的**那份工作台（回收站里的视为不存在）；给"必须排除已删除"的调用方用 */
export function getWorkbenchLive(id: number): Workbench | undefined {
  return get<Workbench>(
    `SELECT * FROM workbench WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

/** profile 里保留给「这份工作绑定的模板」的键 */
export const PROFILE_TEMPLATE_IDS = 'templateIds';

/** 读这份工作绑定的模板 id（没绑过返回空数组） */
export function getBoundTemplateIds(workbenchId:number):number[] {
 const wb=getWorkbench(workbenchId);if(!wb?.template_ids)return [];
 try{const ids=JSON.parse(wb.template_ids);return Array.isArray(ids)?ids.filter((id:unknown)=>Number.isSafeInteger(id)&&Number(id)>0):[];}catch{throw new Error('模板绑定损坏，请重新选择模板');}
}

/** 更新这份工作绑定的模板（空数组 = 取消绑定，回退到该类型的全部模板） */
export function setBoundTemplateIds(workbenchId:number,ids:number[],requiredIds:number[]=ids):number[] {
 if(!getWorkbench(workbenchId))throw new Error('工作台不存在');
 const clean=[...new Set(ids)];
 if(requiredIds.some(id=>!clean.includes(id)))throw new ApiError('BAD_TEMPLATES','必备模板必须在选定模板范围内');
 const wb=getWorkbench(workbenchId)!;
 if(clean.some(id=>!Number.isSafeInteger(id)||id<=0||!getTemplate(id)||getTemplate(id)?.archived_at||!templateSupportsWorkType(getTemplate(id)!,wb.work_type_id)))throw new ApiError('BAD_TEMPLATES','绑定模板不存在、已归档或不属于当前工作类型');
 run("UPDATE workbench SET template_ids=?,template_requirements=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",[JSON.stringify(clean),JSON.stringify(requiredIds),workbenchId]);return clean;
}

/**
 * 这份工作「出文书」时该显示哪些模板。
 *
 * 绑过就只显示绑定的（避免一个工作类型下模板很多时拿错），
 * 没绑过就回退到该工作类型的全部模板 —— 老数据不因此变成空列表。
 */
export function listTemplatesForWorkbench(workbenchId: number): (Template & { work_type_name: string | null; bound: boolean; required:boolean })[] {
  const wb = getWorkbench(workbenchId);
  if (!wb) return [];
  const bound = getBoundTemplateIds(workbenchId);
  const all = listTemplates({ workTypeId: wb.work_type_id });
  const configured=get<{template_requirements:string|null}>('SELECT template_requirements FROM workbench WHERE id=?',[workbenchId])?.template_requirements;
  const required=new Set<number>(configured?JSON.parse(configured):bound);
  if (!bound.length && wb.template_ids == null) return all.map((t) => ({ ...t, bound: false, required:false }));
  const set = new Set(bound);
  const picked = all.filter((t) => set.has(t.id));
  return picked.map((t) => ({ ...t, bound: true, required:required.has(t.id) }));
}

/* ============================== 阶段↔文书模板（B2-7，迁移 018） ============================== */

/**
 * 阶段绑定的文书模板（一行绑定 + 它指向的模板信息）。
 *
 * 优先级定死（docs/11 B2-7）：**阶段绑定 > 工作台绑定 > 工作类型全部**。
 * 这一层是最高优先级，所以「出文书」入口默认只列这里绑过的。
 */
export interface PositionDocBinding {
  /** 绑定的模板 id（阶段侧记的就是它） */
  templateId: number;
  /** 模板编码；模板已被删除（记录都没了）时为 '' */
  code: string;
  /** 模板名称；模板已归档/删除时给「（已归档）」等可读后缀，便于界面直接显示 */
  name: string;
  /** 模板文件格式（docx/xlsx…）；模板没了时是 '' */
  file_format: string;
  /**
   * 模板健康状态（迁移 014）：
   *   null = 还没校验过（历史数据，**不拦截**，与出文书的口径一致）
   *   1    = 校验通过
   *   0    = 坏模板（Word/Excel 打不开），**不能再绑**，已在绑上的要显示出来
   */
  health_ok: number | null;
  health_note: string | null;
  /** 本阶段是否必须出具 */
  required: number;
  /** 同阶段内的排序 */
  seq: number;
  note: string | null;
  /**
   * 这一行引用不到可用的模板了（记录被真删 / 模板被归档）。
   * 界面上要**明说**「引用的模板已删除，请重新选择」，不静默消失
   * （docs/11 B2-7 风险②：不静默消失）。
   */
  missing: boolean;
  /** missing 的人话原因；不 missing 时为 null */
  missingReason: string | null;
}

/** 「出文书」候选模板：就是 listTemplates 的结果带上健康状态与所属工作类型名 */
export interface PositionDocCandidate extends Template {
  work_type_name: string | null;
  /** null 未校验 / 1 好 / 0 坏（与 template.health_ok 同口径） */
  health_ok: number | null;
  health_note: string | null;
  /** 这个模板能不能被绑（坏模板 = false，界面上要置灰） */
  bindable: boolean;
  /** 不能绑的原因；能绑时为 null */
  unbindableReason: string | null;
}

/**
 * 阶段上有没有这张表（迁移 018 之后才有）。
 *
 * 与 `positionPeriodColumnReady()` / `core/trash.ts` 的列探测同一套做法：
 * 老库（还没跑 018）上直接查 `position_template_doc` 会报 `no such table`，
 * 那是**整个接口 500**，比"暂时没有阶段绑定"严重得多 —— 所以要能降级成"没绑过"。
 * 缓存结果；迁移跑完（重启进程）后自动生效。
 */
let positionDocTable: boolean | null = null;

function positionDocTableReady(): boolean {
  if (positionDocTable !== null) return positionDocTable;
  try {
    positionDocTable = Boolean(
      get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'position_template_doc'"),
    );
  } catch {
    positionDocTable = false;
  }
  return positionDocTable;
}

/** 坏模板 = `health_ok === 0`；null（没校验过）与 1 都算能绑（与出文书不拦截的口径一致） */
function templateBindBlockReason(t: { health_ok?: number | null; health_note?: string | null; archived_at?: string | null } | undefined): string | null {
  if (!t) return '模板不存在（可能已被删除）';
  if (t.archived_at) return '模板已归档，不能在阶段上绑定';
  if (t.health_ok === 0) return t.health_note?.trim() || '这份模板打不开（文件结构已损坏），请重新上传后再绑定';
  return null;
}

/**
 * 读某份模板的健康字段。
 *
 * `listTemplates()` 用 `SELECT t.*` 已经把 health_* 带出来了，但 `getTemplate()` 是
 * `SELECT *`（也一样带）—— 两处都能读到。单独抽出来是为了**统一兜底**：
 * 老库（还没跑 014）里这两列不存在，读出来是 undefined，与 null（没校验过）同义。
 */
function healthOf(t: Template | undefined): { health_ok: number | null; health_note: string | null } {
  const ok = (t as { health_ok?: number | null } | undefined)?.health_ok;
  return {
    health_ok: ok === undefined || ok === null ? null : Number(ok),
    health_note: (t as { health_note?: string | null } | undefined)?.health_note ?? null,
  };
}

/**
 * 某个阶段的**全部绑定行**（含引用不到的），按 seq 排。
 *
 * 读过滤：本表有 `deleted_at`（迁移 018 自带），用 `liveFilter` 拼 `deleted_at IS NULL`；
 * 老库没有这张表时返回空数组（降级成"没绑过"，不是 500）。
 *
 * 注意：这里**不禁用**归档模板 —— 已经被归档的模板若还绑在阶段上，必须能被读出来
 * 并标成 `missing`，否则界面上会「静默消失」（docs/11 B2-7 风险②）。
 * 为此查询**不 JOIN 出模板名**（JOIN 加 archived 过滤会丢行），改成逐行按 id 取。
 */
export function listPositionDocBindings(positionTemplateId: number): PositionDocBinding[] {
  if (!positionDocTableReady()) return [];
  const live = liveFilter('position_template_doc', 'd');
  const rows = all<{ id: number; template_id: number; required: number; seq: number; note: string | null }>(
    `SELECT d.id, d.template_id, d.required, d.seq, d.note
       FROM position_template_doc d
      WHERE d.position_template_id = ? AND ${live}
      ORDER BY d.seq, d.id`,
    [positionTemplateId],
  );
  return rows.map((r) => {
    // 逐行取模板（不加 archived_at 过滤：归档的也要看得见，好让界面提示"请重新选择"）
    const t = get<Template>('SELECT * FROM template WHERE id = ?', [r.template_id]);
    const h = healthOf(t);
    let missing = false;
    let missingReason: string | null = null;
    if (!t) {
      missing = true;
      missingReason = '引用的模板已从模板库里删掉，请重新选择本阶段要用的文书模板';
    } else if (t.archived_at) {
      missing = true;
      missingReason = '引用的模板已归档，请重新选择本阶段要用的文书模板';
    }
    return {
      templateId: r.template_id,
      code: t?.code ?? '',
      name: t ? (missing ? `${t.name}（${t.archived_at ? '已归档' : '已删除'}）` : t.name) : `模板 #${r.template_id}（已删除）`,
      file_format: t?.file_format ?? '',
      health_ok: h.health_ok,
      health_note: h.health_note,
      required: r.required ? 1 : 0,
      seq: r.seq,
      note: r.note,
      missing,
      missingReason,
    };
  });
}

/** 某个阶段绑定了几个模板（`required` 的那几个单独数出来给界面用） */
export function positionDocSummary(positionTemplateId: number): { bound: number; required: number; missing: number } {
  const rows = listPositionDocBindings(positionTemplateId);
  return {
    bound: rows.length,
    required: rows.filter((r) => r.required && !r.missing).length,
    missing: rows.filter((r) => r.missing).length,
  };
}

/**
 * 「流程规范」页给某个阶段选模板时要的两份数据：
 *   · `bound`    —— 已绑的（含引用不到的，带 missing 标记）
 *   · `candidates` —— 候选（按该阶段所属**工作类型**过滤，与出文书的候选集同口径：
 *                    `template.work_type_id = 该类型 OR IS NULL`）
 *
 * 候选集必须与 `listTemplatesForWorkbench()` 的回退集**逐条一致** —— 这条有验收标准
 * （docs/11 B2-7 ⑤：存量零影响，出文书候选数相等）。
 */
export function listPositionDocTemplates(positionTemplateId: number): {
  position: PositionTemplate | undefined;
  bound: PositionDocBinding[];
  candidates: PositionDocCandidate[];
} {
  const position = get<PositionTemplate>('SELECT * FROM position_template WHERE id = ?', [positionTemplateId]);
  if (!position) return { position: undefined, bound: [], candidates: [] };
  const candidates = all<Template & { work_type_name: string | null }>(
    `SELECT t.*, w.name AS work_type_name FROM template t LEFT JOIN work_type w ON w.id = t.work_type_id
      WHERE t.archived_at IS NULL AND (t.work_type_id = ? OR (t.work_type_id IS NULL AND t.shared=1))
      ORDER BY t.category, t.name`,
    [position.work_type_id],
  ).map((t) => {
    const h = healthOf(t);
    const reason = templateBindBlockReason(t);
    return { ...t, ...h, bindable: reason === null, unbindableReason: reason };
  });
  return { position, bound: listPositionDocBindings(positionTemplateId), candidates };
}

/**
 * 保存某个阶段的文书模板绑定（**整表替换**：传进来的就是要的最终状态）。
 *
 * 校验（每一条都会给出人话原因，不静默丢弃）：
 *   ① 阶段必须存在；
 *   ② 每个 templateId 必须是正整数且不重复（去重后按 `seq` 稳定排序）；
 *   ③ 模板必须存在、**未归档**、且不是坏模板（`health_ok === 0` 不能绑 —— 验收标准 ③）；
 *   ④ 模板必须属于该阶段的工作类型（或 `work_type_id IS NULL` 的通用模板）——
 *      否则会把别阶段的文书挂到这个阶段上，正是这项功能要防的事。
 *
 * `items` 为空数组 = 绑定清零，展示回到「该类型全部模板」（验收标准 ④，不报错）。
 *
 * 【为什么解绑是真删而不是软删】绑定是配置，不是用户资产：
 *   · 用户改主意来回勾选很常见，留一堆软删行会让 `UNIQUE(position_template_id, template_id)`
 *     在"取消再重新勾"时撞约束，需要额外写一次"复活"逻辑，多一类半截状态；
 *   · 真删没有数据风险 —— 丢掉的是"这个阶段原来挂过哪个模板"这条配置，
 *     模板文件、模板记录、已出的文书（artifact）一个都不动。
 * 本表的 `deleted_at` 于是只在读路径上当守卫用（防御性），写入路径不产生已删行。
 */
export function setPositionDocTemplates(
  positionTemplateId: number,
  items: { templateId: number; required?: number | boolean | null; seq?: number | null; note?: string | null }[],
): PositionDocBinding[] {
  const position = get<PositionTemplate>('SELECT * FROM position_template WHERE id = ?', [positionTemplateId]);
  if (!position) throw new Error('阶段不存在（可能已被归档或删除）');
  if (!positionDocTableReady()) {
    throw new Error('数据库还没有「阶段↔模板绑定」功能（缺迁移 018），无法保存，请先重启以完成数据库升级');
  }
  if (!Array.isArray(items)) throw new Error('items 必须是数组（空数组 = 清空本阶段的模板绑定）');

  // ② 去重 + 校验 id 形状（保留第一次出现的那个的顺序，便于"以请求顺序为默认 seq"）
  const seen = new Set<number>();
  const clean: { templateId: number; required: number; seq: number; note: string | null }[] = [];
  for (const raw of items) {
    const id = Number(raw?.templateId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`模板 id 不合法：${String(raw?.templateId)}`);
    if (seen.has(id)) continue;
    seen.add(id);
    // seq 不传时按"请求里的先后顺序"给一个稳定的默认值（*10，与其它规则表同习惯）
    const seq = Number.isFinite(Number(raw?.seq)) && Number(raw?.seq) > 0 ? Number(raw?.seq) : (clean.length + 1) * 10;
    clean.push({
      templateId: id,
      required: raw?.required === true || Number(raw?.required) === 1 ? 1 : 0,
      seq,
      note: raw?.note == null || String(raw.note).trim() === '' ? null : String(raw.note).trim(),
    });
  }

  // ③④ 逐个校验（全部先校验完再写库：不允许"写了一半才报错"）
  const scoped = (t: Template): boolean => templateSupportsWorkType(t,position.work_type_id);
  for (const it of clean) {
    const t = get<Template>('SELECT * FROM template WHERE id = ?', [it.templateId]);
    const reason = templateBindBlockReason(t);
    if (reason) throw new Error(`模板 #${it.templateId} 不能绑定：${reason}`);
    if (!scoped(t!)) throw new Error(`模板「${t!.name}」属于别的工作类型，不能绑到「${position.name}」这个阶段上`);
  }

  clean.sort((a, b) => a.seq - b.seq || a.templateId - b.templateId);
  tx(() => {
    // 整表替换：先清掉本阶段现有的绑定行，再按新列表写回
    run('DELETE FROM position_template_doc WHERE position_template_id = ?', [positionTemplateId]);
    for (const it of clean) {
      run(
        `INSERT INTO position_template_doc (position_template_id, template_id, required, seq, note) VALUES (?,?,?,?,?)`,
        [positionTemplateId, it.templateId, it.required, it.seq, it.note],
      );
    }
  });
  // 读回放在事务外（状态已经落定，读回来的就是最终形态；tx 里读也行，只是没必要）
  return listPositionDocBindings(positionTemplateId);
}

/**
 * 「这份工作台每个阶段该出哪些文书、已出几份」—— 工作台详情用。
 *
 * 优先级（docs/11 B2-7，**定死**）：**阶段绑定 > 工作台绑定 > 工作类型全部**。
 * `source` 字段就是为了让界面能把这件事说清楚，而不是让用户猜"为什么列出来的是这些"。
 *
 * 「已出」的判据：`artifact` 里 `workbench_id` 相同、`kind='generated'`、
 * `position_code` 等于该阶段编码、`template_id` 等于绑定模板 —— 也就是**这一份文书真的出过**。
 * 不这么判的话，"别阶段出过同一份模板"会被算成本阶段已出，`缺文书` 提示就不准了。
 * （`artifact` 有 `deleted_at`，读路径一律带 `liveFilter('artifact')`：
 *   进回收站的文书不该再算"已出"。）
 */
export function listWorkbenchPositionDocs(workbenchId: number): {
  workbench: { id: number; templateIds: number[]; templateBound: boolean };
  /** 阶段实例 id → 该阶段的文书统计（只读的索引，界面拿它显示"应出 N 份 / 已出 M 份"） */
  items: WorkbenchPositionDoc[];
} {
  const wb = getWorkbench(workbenchId);
  if (!wb) return { workbench: { id: workbenchId, templateIds: [], templateBound: false }, items: [] };
  const wbBoundIds = getBoundTemplateIds(workbenchId);
  const wbBoundSet = new Set(wbBoundIds);
  // 工作类型全部模板（第三层回退）；listTemplates 已排除归档
  const typeTemplates = listTemplates({ workTypeId: wb.work_type_id });
  const templateById = new Map<number, Template>(typeTemplates.map((t) => [t.id, t]));

  const positions = all<PositionInstance>(
    `SELECT * FROM position_instance WHERE workbench_id = ? AND ${liveFilter('position_instance')} ORDER BY seq, sort_order, id`,
    [workbenchId],
  );

  const out: WorkbenchPositionDoc[] = [];
  for (const p of positions) {
    const ptId = p.position_template_id ?? null;
    // 必备要求不能因模板归档而消失；失效绑定仍保留为待处理缺项。
    const snapshot = (p as PositionInstance & {doc_requirements?: string}).doc_requirements;
    const bound: {templateId:number;name:string;required:number;seq:number}[] = snapshot == null
      ? (ptId ? listPositionDocBindings(ptId) : []) : JSON.parse(snapshot);

    let source: WorkbenchPositionDoc['source'];
    let docs: { templateId: number; name: string; required: number; seq: number }[];
    if (bound.length) {
      source = 'position';
      docs = bound.map((b) => ({ templateId: b.templateId, name: b.name, required: b.required, seq: b.seq }));
    } else if (wbBoundIds.length) {
      source = 'workbench';
      docs = wbBoundIds
        .map((id) => templateById.get(id))
        .filter((t): t is Template => Boolean(t))
        .map((t) => ({ templateId: t.id, name: t.name, required: 0, seq: 100 }));
    } else {
      source = 'work_type';
      // 一份都没绑 → 与该工作类型的全部模板一致（**存量回退行为，必须与改造前一致**）
      docs = typeTemplates.map((t) => ({ templateId: t.id, name: t.name, required: 0, seq: 100 }));
    }

    // 「已出」：这一阶段编码 + 这一份模板，真的出过（kind='generated'）
    const generated = all<{ template_id: number | null }>(
      `SELECT template_id FROM artifact
        WHERE workbench_id = ? AND position_code = ? AND kind = 'generated' AND ${liveFilter('artifact')}`,
      [workbenchId, p.code],
    );
    const doneSet = new Set(generated.map((g) => g.template_id).filter((x): x is number => typeof x === 'number' && x > 0));

    const finalSet = new Set(all<Artifact>(`SELECT * FROM artifact WHERE workbench_id=? AND position_code=? AND kind='generated' AND is_final=1 AND ${liveFilter('artifact')}`, [workbenchId,p.code]).filter(a=>{try{assertFinalArtifact(a);return true;}catch{return false;}}).map(a=>a.template_id));
    const items = docs.map((d) => ({
      templateId: d.templateId,
      name: d.name + (()=>{const t=get<{archived_at:string|null}>('SELECT archived_at FROM template WHERE id=?',[d.templateId]);return !t ? '（模板已删除）' : t.archived_at ? '（模板已归档）' : '';})(),
      required: d.required,
      seq: d.seq,
      /** 这一份出过没有 —— 出过 **任意一份** 就算（同一模板出第二份不改变"出过"） */
      generated: doneSet.has(d.templateId),
      finalized: finalSet.has(d.templateId),
    }));
    const requiredTotal = items.filter((i) => i.required).length;
    const requiredDone = items.filter((i) => i.required && i.finalized).length;
    out.push({
      positionId: p.id,
      positionCode: p.code,
      positionTemplateId: ptId,
      source,
      // 「应出」= 绑定/回退给出的份数；required 的那几份单独数
      total: items.length,
      done: items.filter((i) => i.generated).length,
      requiredTotal,
      requiredDone,
      /** 有必须出具却没出的 —— 界面就靠这个显示「缺文书」 */
      shortfall: p.status==='skipped'&&p.note?.trim()?0:Math.max(0, requiredTotal - requiredDone),
      // 回退到工作类型全部时，这不代表"用户绑过"，界面据此说清原因（不发假提醒）
      boundAtPosition: bound.length > 0,
      boundAtWorkbench: wbBoundSet.size > 0,
      items,
    });
  }
  return { workbench: { id: wb.id, templateIds: wbBoundIds, templateBound: wbBoundSet.size > 0 }, items: out };
}

/** 工作台详情里每个阶段的文书统计（`listWorkbenchPositionDocs` 的行） */
export interface WorkbenchPositionDoc {
  positionId: number;
  positionCode: string;
  /** 这个阶段实例是从哪份阶段模板实例化来的；NULL = 阶段模板已被删（无法绑定） */
  positionTemplateId: number | null;
  /** 候选从哪一层来：阶段绑定 / 工作台绑定 / 工作类型全部 */
  source: 'position' | 'workbench' | 'work_type';
  /** 应出几份 */
  total: number;
  /** 已出几份（按 artifact 实际记录算） */
  done: number;
  /** 其中标了「必须出具」的有几份 */
  requiredTotal: number;
  requiredDone: number;
  /** 必须出具却没出的份数（>0 界面显示「缺文书」） */
  shortfall: number;
  boundAtPosition: boolean;
  boundAtWorkbench: boolean;
  items: { templateId: number; name: string; required: number; seq: number; generated: boolean; finalized: boolean }[];
}

export function listWorkbenches(filter: { workTypeId?: number; status?: string; keyword?: string; limit?: number; offset?: number; archived?: boolean; now?: Date } = {}): (Workbench & {
  work_type_name: string;
  work_type_mode: string;
  position_done: number;
  position_total: number;
  artifact_count: number;
  /** 周期性工作的排期状态；单次工作为 recurring:false */
  schedule: ScheduleState;
})[] {
  const where: string[] = [
    filter.archived ? 'w.archived_at IS NOT NULL' : 'w.archived_at IS NULL',
    liveFilter('workbench', 'w'),
  ];
  const params: (string | number)[] = [];
  if (filter.workTypeId) {
    where.push('w.work_type_id = ?');
    params.push(filter.workTypeId);
  }
  if (filter.status) {
    where.push('w.status = ?');
    params.push(filter.status);
  }
  if (filter.keyword) {
    where.push('(w.name LIKE ? OR w.code LIKE ? OR w.counterpart LIKE ?)');
    params.push(`%${filter.keyword}%`, `%${filter.keyword}%`, `%${filter.keyword}%`);
  }
  const rows = all<Workbench & { work_type_name: string; work_type_mode: string; position_done: number; position_total: number; artifact_count: number }>(
    `SELECT w.*, t.name AS work_type_name, t.mode AS work_type_mode, t.domain AS work_type_domain,
       (SELECT frequency FROM work_period_rule WHERE workbench_id=w.id) AS period_frequency,
       (SELECT COUNT(*) FROM work_period WHERE workbench_id=w.id) AS period_total,
       (SELECT COUNT(*) FROM work_period WHERE workbench_id=w.id AND status='done') AS period_done,
       (SELECT MIN(due_date) FROM work_period WHERE workbench_id=w.id AND status='open') AS period_due,

       (SELECT COUNT(*) FROM position_instance p WHERE p.workbench_id = w.id AND p.status IN ('done','skipped') AND ${liveFilter('position_instance', 'p')}) AS position_done,
       (SELECT COUNT(*) FROM position_instance p WHERE p.workbench_id = w.id AND ${liveFilter('position_instance', 'p')}) AS position_total,
       (SELECT COUNT(*) FROM artifact a WHERE a.workbench_id = w.id AND ${liveFilter('artifact', 'a')}) AS artifact_count
     FROM workbench w JOIN work_type t ON t.id = w.work_type_id
     WHERE ${where.join(' AND ')}
     ORDER BY w.updated_at DESC, w.id DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(500,Math.max(1,filter.limit ?? 200)),Math.max(0,filter.offset ?? 0)],
  );
  const now = filter.now ?? new Date();
  return rows.map((r) => ({
    ...r,
    schedule: computeSchedule(
      {
        recurrence: (r.recurrence as ScheduleSpec['recurrence']) ?? 'once',
        recur_day: r.recur_day,
        recur_month: r.recur_month,
        remind_days: r.remind_days,
        last_done_at: r.last_done_at, schedule_due_date: r.schedule_due_date, last_done_period: r.last_done_period,
      },
      now,
    ),
  }));
}

/**
 * 列出当前需要处理的工作：周期到了的（含逾期），以及正在进行的项目。
 * 首页「所有工作的进度」用这个，比拉全量列表再筛更直接。
 */
export function listDueWork(now: Date = new Date()): {
  overdue: ReturnType<typeof listWorkbenches>;
  dueSoon: ReturnType<typeof listWorkbenches>;
  active: ReturnType<typeof listWorkbenches>;
} {
  const allRows:ReturnType<typeof listWorkbenches>=[];
  for(let offset=0;;offset+=500){const batch=listWorkbenches({limit:500,offset,now});allRows.push(...batch);if(batch.length<500)break;}
  const allItems = allRows.filter((w) => w.status === 'active' || w.status === 'paused');
  const overdue: ReturnType<typeof listWorkbenches> = [];
  const dueSoon: ReturnType<typeof listWorkbenches> = [];
  const active: ReturnType<typeof listWorkbenches> = [];
  for (const w of allItems) {
    if (w.schedule.recurring) {
      if (w.schedule.overdueDays > 0) overdue.push(w);
      else if (w.schedule.shouldRemind) dueSoon.push(w);
    } else {
      active.push(w);
    }
  }
  const byUrgency = (a: { schedule: { daysUntil: number | null } }, b: { schedule: { daysUntil: number | null } }) =>
    (a.schedule.daysUntil ?? 0) - (b.schedule.daysUntil ?? 0);
  overdue.sort(byUrgency);
  dueSoon.sort(byUrgency);
  return { overdue, dueSoon, active };
}

export function updateWorkbench(id: number, patch: Partial<Workbench>): void {
  if(patch.status==='done' && getWorkbench(id)?.status!=='done')assertWorkReady(id);
  /**
   * 「要归档」有两种写法：前端编辑弹窗把 status 选成 'archived'，或者直接给 `archived_at`。
   * 两种都统一收敛到 archiveWorkbench()，中间不写 status/archived_at，
   * 免得 archived_at 与 status 各写各的、互相漂移（见下面两个函数上的不变量说明）。
   */
  if (patch.status === 'archived' || (patch.archived_at !== undefined && patch.archived_at !== null)) {
    tx(() => {
      updateWorkbench(id, { ...patch, status: undefined, archived_at: undefined });
      archiveWorkbench(id);
    });
    return;
  }
  const current=getWorkbench(id);
  if(current?.archived_at && patch.status && patch.status !== 'archived') { unarchiveWorkbench(id); }
  if(patch.status && !['active','paused','done','archived'].includes(patch.status)) throw new Error('工作状态无效');
  const allowed = ['name', 'status', 'priority', 'owner', 'counterpart', 'contract_no', 'contract_amount', 'start_date', 'plan_end_date', 'actual_end_date', 'summary', 'business_content', 'tags', 'profile', 'progress'];
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    /**
     * 没传的字段不要动。
     *
     * 原本这里直接往下走，而 `Object.entries({owner:'x', counterpart: undefined})` 是**包含**
     * counterpart 的 —— 于是「只改负责人」的请求会顺手把对方单位、合同编号、备注、起止日期
     * 全部清成 NULL。现在约定：undefined = 别动，null = 显式清空。
     */
    if (v === undefined) continue;
    fields.push(`${k} = ?`);
    params.push((v ?? null) as string | number | null);
  }
  if (!fields.length) return;
  if(['name','owner','counterpart','contract_no','contract_amount','start_date','plan_end_date','actual_end_date','summary','business_content','profile'].some(k=>patch[k as keyof Workbench]!==undefined&&patch[k as keyof Workbench]!==current?.[k as keyof Workbench]))invalidateLegacyDocumentSources(id);
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  run(`UPDATE workbench SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
  recalcProgress(id);
}

/** 归档期间合法的「归档前状态」—— 'archived' 本身不算，它只是归档态 */
const ACTIVE_WORKBENCH_STATUSES = ['active', 'paused', 'done'] as const;

function isActiveWorkbenchStatus(v: string | null | undefined): v is (typeof ACTIVE_WORKBENCH_STATUSES)[number] {
  return v !== null && v !== undefined && (ACTIVE_WORKBENCH_STATUSES as readonly string[]).includes(v);
}

/**
 * 归档一份工作。
 *
 * 【不变量】归档状态由三列共同表达，必须始终一致：
 *   archived_at IS NULL       ⇔  status ∈ {active, paused, done}，archive_status 无意义（NULL）
 *   archived_at IS NOT NULL   ⇒  status = 'archived' 且 archive_status = 归档前的合法状态
 * 反过来讲：archived_at 为空时 status 绝不能是 'archived'，
 * 否则列表按 archived_at 把它返回、前端却按 status 把它从「进行中」里滤掉。
 *
 * archive_status 只在当前 status 是合法「非归档」状态时才记。
 * 若 status 已经是 'archived'（前端编辑弹窗的"状态"下拉里就有『已归档』这一项，
 * 或者一行数据早先就被写坏过），这里把它清成 NULL ——
 * 绝不能把 'archived' 当成"归档前的状态"存下来：那样取消归档时会原样还原成 'archived'，
 * 而 archived_at 已被清空，于是出现 archived_at IS NULL 但 status='archived' 的行 ——
 * 列表按 archived_at 把它返回、前端却按 status 把它从「进行中」滤掉，
 * 用户点了「取消归档」，工作台却从此不见了（旧逻辑实测可复现，且是死循环：再点也还原成 'archived'）。
 */
export function archiveWorkbench(id: number): void {
  const wb=getWorkbench(id);
  if(wb?.status==='done')assertWorkReady(id);
  const r = run(
    `UPDATE workbench SET
       archive_status = CASE
         WHEN archived_at IS NOT NULL THEN archive_status
         WHEN status IN ('active','paused','done') THEN status
         ELSE NULL
       END,
       archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       status = 'archived'
     WHERE id = ?`,
    [id],
  );
  /**
   * 影响行数为 0 = 这个工作台不存在。
   * 以前这里是无条件 UPDATE，对不存在的工作台也能"成功"返回 200 + archived:true，
   * 调用方（含 AI 助手）会以为归档好了，实际什么都没发生。同模块的取消归档一直有存在性检查。
   */
  if (Number(r.changes) === 0) throw new Error('工作台不存在');
}

/**
 * 取消归档。
 *
 * 归档时 status 被改成了 'archived'，所以不能一律还原成 'active'：
 * 一份已经做完（done）的工作归档后再取消，应该回到「已结束」；
 * 暂停（paused）中的也应该回到「暂停」。
 * 还原值优先级：
 *   1. archive_status —— 归档前记下的状态，必须是合法的非归档状态；
 *      若它为空、或者是 'archived'（历史脏数据），视为不可用；
 *   2. 按 actual_end_date 回退：有实际完成日期 → done，没有 → active。
 * 无论走哪条路，写回的都只可能是 active|paused|done，并顺手把 archive_status 清成 NULL ——
 * 它只在"已归档"期间有意义，留着陈旧值下次会被误当成归档前状态。
 * 这一条同时也是脏数据的自愈路径：archived_at 为空却还挂着 status='archived' 的行，
 * 在这里被改回合法状态。
 */
export function unarchiveWorkbench(id: number): void {
  // **有意不加** `deleted_at IS NULL`：取消归档要能作用在"归档过、后来又被软删除"的那一行上；
  // 界面上走的是归档列表（`listWorkbenches({archived:true})`），那里已经排除了回收站里的。
  const wb = get<{ actual_end_date: string | null; archive_status: string | null }>('SELECT actual_end_date, archive_status FROM workbench WHERE id = ?', [id]);
  if (!wb) throw new Error('工作台不存在');
  const restored = isActiveWorkbenchStatus(wb.archive_status) ? wb.archive_status : wb.actual_end_date ? 'done' : 'active';
  run(
    `UPDATE workbench SET archived_at = NULL, status = ?, archive_status = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [restored, id],
  );
}

/**
 * 「本期已经完成」—— 这是**用户操作不合法**，不是服务故障。
 *
 * 领域层没有 import 接口层的 ApiError：`domain/` 下所有文件都不依赖 `api/`，
 * 为一条错误反过来引一次会让分层倒挂。而 api/reply.ts 的 fail() 本来就有一条
 * 原生错误分支（认 error.code + 4xx 的 error.statusCode），带上这两个字段，
 * 接口返回的就是 409 PERIOD_DONE + 中文原因，而不是 500 INTERNAL。
 * 万一那条分支将来被去掉，最坏也只是退回 500 —— 消息照样能到用户眼前，
 * 因为 packages/web/src/api.ts 是把服务端的 error 对象原样抛给界面的。
 */
class PeriodDoneError extends Error {
  readonly code = 'PERIOD_DONE';
  readonly statusCode = 409;
  constructor(message: string) {
    super(message);
    this.name = 'PeriodDoneError';
  }
}

/** 取日期串的 YYYY-MM-DD 部分；空值/认不出来返回 null（排期列本该就是这一天粒度，这里兜个底） */
function dueDay(v:string|null|undefined):string|null{
  const m=/^(\d{4}-\d{2}-\d{2})/.exec(v??'');
  return m?.[1] ?? null;
}

/**
 * 完成一份工作。
 *
 * 两种工作的「完成」含义不同：
 *   单次工作   做完就结束 —— 状态置 done、记完成日期。之后不再出现在待办里。
 *   周期性工作 完成的是**这一期** —— 除了记完成时间，还要写 last_done_at，
 *              排期逻辑靠它把下一期推到下个月/下个季度，工作本身继续留着。
 */
function assertStageReady(positionId:number):void{
 const pos=get<PositionInstance>('SELECT * FROM position_instance WHERE id=?',[positionId]);
 if(pos){const docs=listWorkbenchPositionDocs(pos.workbench_id).items.find(d=>d.positionId===positionId)?.items??[];
  for(const doc of docs.filter(d=>d.required)){const files=all<Artifact>("SELECT * FROM artifact WHERE workbench_id=? AND position_code=? AND template_id=? AND kind='generated' AND is_final=1 AND deleted_at IS NULL",[pos.workbench_id,pos.code,doc.templateId]);if(!files.some(a=>{try{assertFinalArtifact(a);return true;}catch{return false;}}))throw new Error(`必备文书“${doc.name}”尚未定稿或文件丢失`);}
 }
 const items=all<{id:number;kind:string;required:number;review_status:string;review_note:string;min_count:number}>('SELECT * FROM checklist_item WHERE position_instance_id=? AND required=1',[positionId]);
 for(const item of items){
  if(pos && checklistSatisfied(item,pos.workbench_id))continue;
  throw new ApiError('MATERIAL_MISSING','此阶段仍有必备材料未核对、数量不足或文件丢失，请重新核对或注明不适用原因',409);
 }
}
function assertWorkReady(id:number):void{
 if(get('SELECT workbench_id FROM work_period_rule WHERE workbench_id=?',[id])){
  if(getWorkbench(id)?.status!=='done')throw new Error('此工作已启用独立期次，请进入所选期次确认已上报');
  for(const p of all<{id:number;status:string}>('SELECT id,status FROM work_period WHERE workbench_id=?',[id])){
   if(p.status!=='done')throw new ApiError('PERIODS_OPEN','仍有未完成期次',409);
   assertPeriodReady(p.id);
  }
 }
 for(const p of all<PositionInstance>('SELECT * FROM position_instance WHERE workbench_id=? AND deleted_at IS NULL',[id])) {
  if(p.status==='skipped' && p.note?.trim())continue;
  if(p.status!=='done'&&!getWorkbench(id)?.historical)throw new ApiError('STAGES_OPEN','仍有未结束阶段，请先完成或注明不适用原因',409);
  assertStageReady(p.id);
 }
 for(const t of (get('SELECT workbench_id FROM work_period_rule WHERE workbench_id=?',[id])?[]:listTemplatesForWorkbench(id).filter(t=>t.required))){
  const files=all<Artifact>('SELECT * FROM artifact WHERE workbench_id=? AND template_id=? AND position_code IS NULL AND is_final=1 AND deleted_at IS NULL',[id,t.id]);
  if(!files.some(a=>{try{assertFinalArtifact(a);return true;}catch{return false;}}))throw new ApiError('FINAL_MISSING',`必备文书“${t.name}”尚未定稿或文件丢失`,409);
 }
 if(get("SELECT id FROM quick_todo WHERE workbench_id=? AND status='open'",[id]))throw new ApiError('TASKS_OPEN','仍有未办结的交付或协调事项',409);
}
export function completeWorkbench(id: number): { status: string; last_done_at: string | null; nextDue: string | null } {
  const wb=getWorkbench(id); if(!wb) throw new Error('工作台不存在');
  if(wb.recurrence==='once'&&wb.status==='done')return {status:'done',last_done_at:wb.last_done_at,nextDue:null};
  assertWorkReady(id);
  if(wb.archived_at) throw new Error('请先恢复归档工作台');
  const now=new Date(), iso=now.toISOString();
  const recurring=wb.recurrence!=='once';
  const spec={recurrence:wb.recurrence as ScheduleSpec['recurrence'],recur_day:wb.recur_day,recur_month:wb.recur_month,last_done_at:wb.last_done_at,schedule_due_date:wb.schedule_due_date,last_done_period:wb.last_done_period};
  /** 进来先算一次排期：既拿到"这一次要完成哪一期"，也拿到"今天这一期是否已经完成过" */
  const state=computeSchedule(spec,now);
  const due=state.nextDue;
  /** 409 文案里的"下一期"：优先用持久化的到期日，没有才退回算出来的 nextDue */
  const nextLabel=dueDay(wb.schedule_due_date)??due;
  /**
   * 一期只能完成一次 —— 两条判据，缺一不可。
   *
   * 判据 A（同一天只完成一期）：last_done_at 的自然日就是今天 → 拒绝。
   *
   *   原来这里无条件把"当前到期日"记成已完成再推一期：周期性工作第一次点完
   *   last_done_period=本期、schedule_due_date=下一期，**再点一下就把还没到的下一期
   *   记成完成了**，再推一期 —— 中间那一期从此不在待办里，首页也不再提醒。
   *
   *   只用"最近完成的那一期 ≥ 今天这一期"（doneThroughCurrentPeriod）挡不住，因为它在
   *   **补做欠办期**时必然不成立：补做的那一期永远落后于今天。实测复现（monthly、
   *   recur_day=20、库中 schedule_due_date=2026-09-20 已欠办、last_done_period=NULL、
   *   今天 2026-10-01）：第 1 次完成把 last_done_period 记成欠办的 09-20 那一期，
   *   而今天这一期是 10-20，diffDays(09-20, 10-20) = -30 < 0 → 判"本期未完成"照样放行，
   *   同一天第 2 次点击又把 10-20 那一期吃掉、推成 11-20，要到第 3 次才拦得住。
   *
   *   换成按"完成动作发生在哪个自然日"判断，就与"做的是哪一期"无关：稳定态（第一次
   *   点完 last_done_at = 今天）和欠办态（补做欠办期同样把 last_done_at 写成今天）
   *   被同一条判据挡住；而"跨天补做旧周期"不受影响 —— 那是每天点一次、一次推进一期，
   *   欠办提醒照旧保留。取"今天"用 dateOnly()（本地自然日，与写进 actual_end_date 的
   *   口径一致）；last_done_at 存的是 ISO(UTC) 串，先 new Date() 再 dateOnly() 归到
   *   本地日再比，绝不截 ISO 串前 10 位 —— 东八区下午完成会被截成前一天。
   *
   * 判据 B（保留原有那条）：完成记录已经覆盖今天这一期（doneThroughCurrentPeriod）时
   *   同样拒绝。它管的是"跨天"的超前场景（新建时首次到期日被纠正到下一期、或旧版本
   *   已经连点两下把未来的期记成完成）——此时判据 A 当天并不成立，光靠 A 挡不住
   *   第二天再把下一期提前吃掉。两条判据分别覆盖"同一天"和"跨天"，故都在。
   */
  const lastDoneAt=wb.last_done_at?new Date(wb.last_done_at):null;
  const doneToday=Boolean(lastDoneAt&&!Number.isNaN(lastDoneAt.getTime())&&dateOnly(lastDoneAt)===dateOnly(now));
  if(recurring && (doneToday || state.doneThroughCurrentPeriod))
    throw new PeriodDoneError(nextLabel?`本期已完成（下一期 ${nextLabel}）`:'本期已完成');
  const next=recurring && due ? computeSchedule({...spec,schedule_due_date:null,last_done_period:due},new Date(due+'T00:00:00')).nextDue : null;
  /**
   * 单调性兜底：写 schedule_due_date 之前断言新值**严格大于**旧值（旧值为空就跳过）。
   *
   * 上面那条反重复是"讲道理"，这一条是"不讲道理也不许倒退"：到期日只能往后走，
   * 否则任何将来的新路径只要算错一步，就会把某一期悄悄吃掉。不满足就整笔不写、直接抛错 ——
   * 下面只有这一条 UPDATE，抛在这里等于什么都没改。
   */
  if(recurring){
    const oldDue=dueDay(wb.schedule_due_date), newDue=dueDay(next);
    if(!newDue) throw new Error(`排期算不出下一期到期日（当前 ${oldDue??'无'}），本次完成已取消`);
    if(oldDue && newDue<=oldDue) throw new Error(`排期不会回退：算出的下一期 ${newDue} 不晚于当前到期日 ${oldDue}，本次完成已取消`);
  }
  run("UPDATE workbench SET status=?, actual_end_date=?,last_done_at=?,last_done_period=?,schedule_due_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",[recurring?'active':'done',recurring?null:dateOnly(now),iso,recurring?due:null,next,id]);
  recalcProgress(id);
  return {status:recurring?'active':'done',last_done_at:iso,nextDue:next};
}

/**
 * 把一份工作**移到回收站**（软删除）—— 它自己、它的阶段实例、文件记录一起。
 *
 * 「删除」「归档」「彻底删除」现在是三件事，别再混：
 *   归档        = archived_at + status='archived'，数据都留着、只是收起来（列表里能按归档筛出来）
 *   删除（本函数）= 进回收站。库记录全留着（`deleted_at` 打标记），**磁盘一个字节都不动**，
 *                  在「回收站」页里能恢复、也能彻底删除
 *   彻底删除     = `core/trash.ts` 的 `purgeFromTrash()`：真删库记录 + 真删平台登记的磁盘文件
 *                  （安全阀：只删平台登记且落在允许根内的文件；绑定根/工作台根本身绝不删）
 *
 * 为什么磁盘默认不动：硬盘上那份是这个功能存在的意义。删错了要能**原样**回来，
 * 而恢复一个"记录回来了、文件没了"的空壳等于没恢复。
 *
 * 安全阀照旧（放行之前先挡）：
 *   · 未绑定的工作台，其目录必须落在 `DATA_ROOT\工作台` 之下，且不能是那个根本身；
 *   · 目录被别的工作台共用时拒绝（免得一个操作影响两份工作）。
 */
export function deleteWorkbench(id: number): {
  deleted: {
    artifacts: number;
    positions: number;
    files: number;
    dirRemoved: boolean;
    /**
     * 软删除**不回收任何目录**（磁盘完全不动），恒为 0。
     * 保留这个字段是为了让界面/调用方的既有结构不用改；真回收发生在彻底删除时。
     */
    dirsRecycled: number;
  };
  /** 软删除不定位磁盘，恒为 0（保留字段含义：彻底删除时"定位不到而未动磁盘"的附件数） */
  filesUnlocatable: number;
  /** 给用户看的一句话（没有要解释的返回 null） */
  message: string | null;
  /** 这次移动影响到的记录数（进回收站的规模） */
  trashed: { workbench: number; positions: number; artifacts: number; checklist: number };
} {
  const wb = getWorkbench(id);
  if (!wb) throw new Error('工作台不存在');
  if (wb.deleted_at) throw new Error(`工作台「${wb.name}」已经在回收站里了（可以在回收站里恢复或彻底删除）`);

  const artifactCount = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM artifact WHERE workbench_id = ? AND ${liveFilter('artifact')}`,
    [id],
  )?.n ?? 0;
  const positionCount = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM position_instance WHERE workbench_id = ? AND ${liveFilter('position_instance')}`,
    [id],
  )?.n ?? 0;

  const bound = Boolean((wb.external_root ?? '').trim());
  const dirAbs=bound
    ? workbenchRootAbs(wb)
    : resolveInside(join(DATA_ROOT,DIRS.workbench),wb.folder_path.replace(/^工作台[\\/]/,''));
  if(!bound&&dirAbs===join(DATA_ROOT,DIRS.workbench)) throw new Error('拒绝删除数据根目录');
  const shared=get<{n:number}>(`SELECT COUNT(*) n FROM workbench WHERE folder_path=? AND id<>? AND ${liveFilter('workbench')}`,[wb.folder_path,id])?.n ?? 0;
  if(shared&&!bound) throw new Error('目录由其它工作台共用，拒绝删除');

  const trashed = softDeleteWorkbench(id);

  /**
   * 回收站里的工作台**不再贡献** `external_root` 允许根（那个目录不该继续挂着"平台可写"的资格），
   * 所以白名单要立刻重算。恢复时 `restoreFromTrash` 会再刷一次。
   */
  try{reloadBoundRoots();}catch{/* 下次启动会重算 */}

  console.log(`[回收站] 工作台 #${id}「${wb.name}」已移入回收站（阶段 ${trashed.positions}、文件 ${trashed.artifacts}、清单 ${trashed.checklist}；磁盘未动）`);
  return {
    deleted: { artifacts: artifactCount, positions: positionCount, files: 0, dirRemoved: false, dirsRecycled: 0 },
    filesUnlocatable: 0,
    message: `已移到回收站（阶段 ${positionCount} 个、文件记录 ${artifactCount} 条），磁盘上的文件一个都没动，可在「回收站」页恢复`,
    trashed,
  };
}

/* ------------------------------ 阶段实例 ------------------------------ */

/** 按工作类型的阶段模板，为一个工作台生成阶段与清单（**只写库，不建任何目录**） */
export function instantiatePositions(workbenchId: number): number {
  const wb = getWorkbench(workbenchId);
  if (!wb) throw new Error('工作台不存在');
  const positions = listPositions(wb.work_type_id);
  const rootAbs = workbenchRootAbs(wb);
  let created = 0;
  tx(() => {
    positions.forEach((p, idx) => {
      // 已存在的阶段实例（**含回收站里的那些**：deleted_at IS NULL 与否都要认，否则会给同一 code 再插一条）
      const existing = get<PositionInstance>('SELECT * FROM position_instance WHERE workbench_id = ? AND code = ?', [workbenchId, p.code]);
      /**
       * 阶段目录的绝对路径统一由 positionDirAbs 算：未绑定 = DATA_ROOT/<folder_path>/<阶段目录名>，
       * 绑定 = <external_root>/<阶段目录名>。folder_rel 是**相对当前根**的标识路径，界面用它显示。
       * 目录名优先用模板里配置的 folder_name（用户从绑定根里挑的已有子目录），空则回退 NN_阶段名。
       */
      const stageAbs = positionDirAbs(wb, p);
      const folderRel = toPosix(relative(rootAbs, stageAbs));
      if (!existing) {
        const r = run(
          `INSERT INTO position_instance (workbench_id, position_template_id, code, name, seq, status, folder_rel, sort_order)
           VALUES (?,?,?,?,?,?,?,?)`,
          [workbenchId, p.id, p.code, p.name, p.seq, idx === 0 ? 'doing' : 'pending', folderRel, p.sort_order ?? p.seq * 10],
        );
        created += 1;
        run('UPDATE position_instance SET folder_name=?,period_dir=?,doc_requirements=? WHERE id=?', [p.folder_name,p.period_dir??null,JSON.stringify(listPositionDocBindings(p.id).map(({templateId,name,required,seq})=>({templateId,name,required,seq}))), r.lastInsertRowid]);
        seedChecklist(r.lastInsertRowid, p);
      }
    });
  });
  return created;
}

function seedChecklist(positionInstanceId: number, p: PositionWithRules): void {
  p.materials.forEach((m, i) => {
    run(
      `INSERT INTO checklist_item (position_instance_id, kind, source_id, title, detail, required, min_count, sort_order)
       VALUES (?,?,?,?,?,?,1,?)`,
      [positionInstanceId, 'material', m.id, m.name, m.retention ?? m.hint ?? null, m.required, (i + 1) * 10],
    );
  });
  p.evidences.forEach((e, i) => {
    const detail = [e.shooting_points ? `要点：${e.shooting_points}` : '', e.angles ? `角度：${e.angles}` : '', e.hint ?? '']
      .filter(Boolean)
      .join('；');
    run(
      `INSERT INTO checklist_item (position_instance_id, kind, source_id, title, detail, required, min_count, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`,
      [positionInstanceId, 'evidence', e.id, e.title, detail || null, e.required, e.min_count, (i + 1) * 10],
    );
  });
}

export interface ChecklistItem {
  review_status:string;
  review_note:string;
  id: number;
  position_instance_id: number;
  kind: 'material' | 'evidence';
  source_id: number | null;
  title: string;
  detail: string | null;
  required: number;
  min_count: number;
  status: string;
  done_count: number;
  done_at: string | null;
  done_by: string | null;
  note: string | null;
  sort_order: number;
}

export interface WorkbenchDetail {
  workbench: Workbench & {
    /** 排期状态（后端算出来的，不落库）。详情页要显示「下次应做 / 还有几天」，必须带上 */
    schedule: ScheduleState;
    work_type_mode: string;
    work_type_name: string;
    /** 资料目录（绑定后的外部绝对路径，未绑定为 null） */
    external_root: string | null;
    /** 这份工作台文件实际所在的位置：绑定 → external_root，未绑定 → DATA_ROOT/<folder_path> */
    root_abs: string;
    /** 绑定目录是否还在（契约 §7.4：目录丢了要能一眼看出来） */
    folder_exists: boolean;
    /** 当前欠办那一期的日期（YYYY-MM-DD）；单次工作为 null */
    due_period: string | null;
  };
  workType: WorkType | undefined;
  /**
   * 阶段列表。除数据库字段外，额外带出**实际目录**与**当前期次目录名**——
   * 界面要直接显示，否则用户不知道文件到底落在哪（契约 §5 最后一条）。
   */
  positions: (PositionInstance & {
    checklist: (ChecklistItem & { artifact_count: number })[];
    /**
     * 阶段配置的期次规则：NULL = 不按期次分目录。
     * 格式串可以是 A 型两级（`{yyyy}\{mm}月` → `2026\10月`）。
     */
    period_dir: string | null;
    /** 当前期次目录名（如 2026年10月 / 2026\10月）；不启用期次时为 null */
    period_dir_name: string | null;
    /** 阶段目录（含期次）的绝对路径 */
    folder_abs: string;
    /** 阶段目录的绝对路径（不含期次） */
    stage_abs: string;
    /** 相对当前根的标识路径（含期次），与库里的 folder_rel 同口径 */
    folder_rel_current: string;
    /**
     * 本阶段该出哪些文书、已出几份（B2-7）。`null` = 这份工作台还没实例化阶段，
     * 或统计算不出来（老库缺迁移 018）—— 界面上按"没有这一项"处理，不发假提醒。
     */
    docSummary: WorkbenchPositionDoc | null;
  })[];
  stats: { positionTotal: number; positionDone: number; materialTotal: number; materialDone: number; evidenceTotal: number; evidenceDone: number; artifactCount: number };
  /**
   * 整份工作台的文书汇总（B2-7）：`应出 N 份 / 已出 M 份 / 缺 K 份`。
   *
   * **只统计 `source === 'position'`（真的绑过的）阶段** —— 回退到"工作类型全部模板"
   * 的阶段不算进来，否则 19 个阶段 × 48 份会显示「应出 912 份」这种没人信的数字。
   * 一份都没绑过时整个字段不出现（`undefined`），界面据此不显示这一项。
   */
  docStats?: { total: number; done: number; requiredTotal: number; requiredDone: number; shortfall: number };
}

export function getWorkbenchDetail(id: number): WorkbenchDetail | undefined {
  const wb = getWorkbench(id);
  if (!wb) return undefined;
  wb.progress=recalcProgress(id);
  const wt = getWorkType(wb.work_type_id);
  const positions = all<PositionInstance>(
    `SELECT * FROM position_instance WHERE workbench_id = ? AND ${liveFilter('position_instance')} ORDER BY seq, sort_order, id`,
    [id],
  );
  const rootAbs = workbenchRootAbs(wb);
  const duePeriod = workbenchDuePeriod(wb);
  /**
   * 每个阶段「应出几份文书 / 已出几份」（B2-7）。
   *
   * 一次算好整份工作台的（而不是每个阶段查一次）：判定"已出"要按
   * `position_code + template_id` 去 artifact 里对，逐阶段查会是 N 次查询。
   * 算不出来（老库还没跑 018 之类）**绝不影响工作台详情本身** —— 这页是最常用的页，
   * 不能因为一个附加字段把它整页打成 500。
   */
  let docByPosition = new Map<number, WorkbenchPositionDoc>();
  try {
    docByPosition = new Map(listWorkbenchPositionDocs(id).items.map((d) => [d.positionId, d]));
  } catch (e) {
    console.warn(`阶段文书统计算不出来（不影响工作台详情）：${(e as Error).message}`);
  }
  const withChecklist = positions.map((p) => {
    const meta = positionDirMeta(p);
    const stageAbs = positionDirAbs(wb, { seq: p.seq, name: p.name, folder_name: meta.folderName });
    const spec = positionPeriodSpec(p.position_template_id, p.code, id) ?? meta.periodSpec;
    /**
     * 期次层只看 `period_dir`（与 `positionPeriodDirAbs` 同一判据）：没配就是 null，
     * 配了就按「当前期次」渲染。**不再对 recurrence='once' 短路** —— 否则详情页显示的
     * `folder_abs` 与落盘路径会不一致，用户看到的路径是假的（2026-10-01 验收问题①）。
     * `spec` 为 null 时 `periodDirName` 自己返回 null。
     */
    const periodName = periodDirName(wb.recurrence, duePeriod, spec as PeriodKind | null);
    const period = periodName && isSafePeriodPath(periodName) ? periodName : null;
    const folderAbs = period ? joinPeriodPath(stageAbs, period) : stageAbs;
    return {
      ...p,
      period_dir: spec,
      period_dir_name: period,
      stage_abs: stageAbs,
      folder_abs: folderAbs,
      folder_rel_current: toPosix(relative(rootAbs, folderAbs)),
      /** 本阶段该出哪些文书、已出几份、有没有「必须出具」还没出的（B2-7） */
      docSummary: docByPosition.get(p.id) ?? null,
      checklist: all<ChecklistItem & { artifact_count: number }>(
        `SELECT c.*, (SELECT COUNT(*) FROM artifact a WHERE a.checklist_item_id = c.id AND ${liveFilter('artifact', 'a')}) AS artifact_count
           FROM checklist_item c WHERE c.position_instance_id = ? ORDER BY c.kind DESC, c.sort_order, c.id`,
        [p.id],
      ),
    };
  });
  const flat = withChecklist.flatMap((p) => p.checklist);
  const material = flat.filter((c) => c.kind === 'material');
  const evidence = flat.filter((c) => c.kind === 'evidence');
  const isDone = (c: ChecklistItem) => checklistSatisfied(c as ChecklistItem & {review_status:string;review_note:string},id);
  const externalRoot = (wb.external_root ?? '').trim() || null;
  return {
    workbench: {
      ...wb,
      work_type_name: wt?.name ?? '',
      work_type_mode: wt?.mode ?? 'process',
      external_root: externalRoot,
      output_mode: workbenchOutputMode(wb),
      custom_output_dir: (wb.custom_output_dir ?? '').toString().trim() || null,
      root_abs: rootAbs,
      folder_exists: existsSync(rootAbs),
      due_period: duePeriod,
      schedule: computeSchedule(
        {
          recurrence: (wb.recurrence as ScheduleSpec['recurrence']) ?? 'once',
          recur_day: wb.recur_day,
          recur_month: wb.recur_month,
          remind_days: wb.remind_days,
          last_done_at: wb.last_done_at, schedule_due_date: wb.schedule_due_date, last_done_period: wb.last_done_period,
        },
        new Date(),
      ),
    },
    workType: wt,
    positions: withChecklist,
    stats: {
      positionTotal: positions.length,
      positionDone: positions.filter((p) => p.status === 'done' || p.status === 'skipped').length,
      materialTotal: material.length,
      materialDone: material.filter(isDone).length,
      evidenceTotal: evidence.length,
      evidenceDone: evidence.filter(isDone).length,
      artifactCount: get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM artifact WHERE workbench_id = ? AND ${liveFilter('artifact')}`,
        [id],
      )?.n ?? 0,
    },
    /**
     * 文书汇总（B2-7）。`total`/`done` 是**逐阶段相加**：同一个模板挂在两个阶段上会各算一次，
     * 因为它确实是两份该出的文书（不是同一份的重复计数）。
     *
     * 【为什么只统计 `source === 'position'` 的阶段】
     * 没绑过的阶段会回退到"该工作类型的全部模板"（48 份），把那些也算进"应出文书"，
     * 一份 19 个阶段的工作台就会显示「应出 912 份」——这个数字既不是需求也不是进度，
     * 只会让人不再相信这个提示。所以汇总口径定死为：**只统计用户真的绑过的那一层**。
     * 没绑过就不显示（界面上是"没有这一项"，不是"0/912"）。
     * 逐阶段的完整口径仍然在 `position-docs` 接口的 `items` 里（带 `source`），需要时有。
     */
    docStats: (() => {
      const rows = [...docByPosition.values()].filter((d) => d.source === 'position');
      if (!rows.length) return undefined;
      return {
        total: rows.reduce((s, d) => s + d.total, 0),
        done: rows.reduce((s, d) => s + d.done, 0),
        requiredTotal: rows.reduce((s, d) => s + d.requiredTotal, 0),
        requiredDone: rows.reduce((s, d) => s + d.requiredDone, 0),
        shortfall: rows.reduce((s, d) => s + d.shortfall, 0),
      };
    })(),
  };
}

export function setPositionStatus(positionInstanceId: number, status: string, patch: { note?: string; owner?: string } = {}): void {
  const now = new Date().toISOString();
  // 软删除过滤（deleted_at IS NULL）：回收站里的阶段不能再改状态。
  // 不加的话，"删掉阶段后界面还留着旧标签页"点一下就能把已删除的阶段改成进行中。
  const pos = get<PositionInstance>(
    'SELECT * FROM position_instance WHERE id = ? AND deleted_at IS NULL',
    [positionInstanceId],
  );
  if (!pos) return;
  if(!['pending','doing','blocked','done','skipped'].includes(status))throw new ApiError('BAD_STATUS','阶段状态无效');
  if(status==='skipped' && !(patch.note??pos.note??'').trim())throw new ApiError('REASON_REQUIRED','不适用阶段必须记录原因');
  if(status==='done')assertStageReady(positionInstanceId);
  const started = pos.started_at ?? (status === 'doing' || status === 'done' ? now : null);
  const finished = status === 'done' ? now : status === 'doing' || status === 'pending' ? null : pos.finished_at;
  run(
    `UPDATE position_instance SET status = ?, started_at = ?, finished_at = ?,
       note = COALESCE(?, note), owner = COALESCE(?, owner),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [status, started, finished, patch.note ?? null, patch.owner ?? null, positionInstanceId],
  );
  recalcProgress(pos.workbench_id);
}

/** 给当前阶段实例设置目录分期规则，只影响本工作后续输出，已有文件不搬动。 */
export function setPositionPeriodDir(positionInstanceId: number, periodDir: string | null): void {
  // 软删除过滤（deleted_at IS NULL）：回收站里的阶段不能再改期次规则
  const pos = get<PositionInstance>(
    'SELECT * FROM position_instance WHERE id = ? AND deleted_at IS NULL',
    [positionInstanceId],
  );
  if (!pos) throw new Error('阶段不存在（也可能已被删除、正在回收站里）');
  if (!pos.position_template_id) throw new Error('这个阶段没有对应的流程规范，改不了期次设置');
  /**
   * 契约 §12：期次用 **A 型两级** `{yyyy}\{mm}月` → `2026\10月`。
   * 校验 + 归一化统一走 `periodSpecForSave()` —— 与流程规范页保存阶段模板
   * （`upsertPosition`）共用同一个函数，两条入口的行为必须逐字一致：
   * `/` → `\`、sentinel → 默认 A 型、去空层级；`..`、盘符 / UNC 绝对路径、
   * `: * ? " < > |` 一律拒，最后再用渲染结果兜一次底。
   */
  const spec = periodSpecForSave(periodDir);
  /**
   * 只改 period_dir 这一列，别把模板的其它字段顺带覆盖一遍：
   * 阶段实例的 name 是"建台那天的名字"，模板后来可能在规范页被改过，
   * 拿实例的 name 回写等于把用户的修改冲掉。
   */
  run('UPDATE position_instance SET period_dir=? WHERE id=?',[spec||null,positionInstanceId]);
  syncPositionFolders(pos.workbench_id);
}

/** 调整当前阶段实例的目录名，不改变工作类型默认或其他实例，不搬动已有文件。 */
export function setPositionFolderName(
  positionInstanceId: number,
  folderName: string | null,
): { folderName: string | null; affectedWorkbenches: number } {
  // 软删除过滤（deleted_at IS NULL）：回收站里的阶段不能改目录名
  const pos = get<PositionInstance>(
    'SELECT * FROM position_instance WHERE id = ? AND deleted_at IS NULL',
    [positionInstanceId],
  );
  if (!pos) throw new Error('阶段不存在（也可能已被删除、正在回收站里）');
  if (!pos.position_template_id) {
    throw new Error('这个阶段没有对应的流程规范（阶段模板），目录名改不了：请先在工作类型的「流程规范」页给它建一条规范，再回来选目录名');
  }
  const name = (folderName ?? '').toString().trim();
  /**
   * 只收**单层目录名**：分层、盘符、UNC、非法字符一律拒（契约 §12.1 的命名约束）。
   * 这里不做静默清洗 —— 用户打了 `a\b` 却被悄悄改成 `ab`，他会以为目录就叫 `a\b`。
   */
  if (name) {
    if (/[\\/:*?"<>|\r\n\t]/.test(name)) throw new Error(`目录名不能包含 \\ / : * ? " < > | 这些字符：${name}`);
    if (name === '.' || name === '..') throw new Error(`目录名不能是 . 或 ..：${name}`);
    if (name !== name.replace(/^[.\s]+|[.\s]+$/g, '')) throw new Error(`目录名首尾不能有空格或点：${name}`);
  }
  run('UPDATE position_instance SET folder_name=? WHERE id=?',[name||null,positionInstanceId]);
  syncPositionFolders(pos.workbench_id);
  return { folderName: name || null, affectedWorkbenches: 1 };
}

export function updateChecklistItem(
  id: number,
  patch: { status?: string; done_count?: number; note?: string; done_by?: string },
): void {
  const item = get<ChecklistItem>('SELECT * FROM checklist_item WHERE id = ?', [id]);
  if (!item) return;
  let status = patch.status ?? item.status;
  let doneCount = item.kind==='evidence' ? evidenceCount(id) : patch.done_count ?? item.done_count;
  if (item.kind==='evidence' && status!=='na') status=doneCount>=item.min_count?'done':doneCount>0?'doing':'todo';
  if (item.kind === 'evidence' && patch.done_count !== undefined) {
    status = doneCount >= item.min_count ? 'done' : doneCount > 0 ? 'doing' : 'todo';
  }
  if (item.kind === 'material' && patch.status === 'done') doneCount = Math.max(doneCount, 1);
  const doneAt = status === 'done' ? new Date().toISOString() : null;
  run(
    `UPDATE checklist_item SET status = ?, done_count = ?, done_at = COALESCE(?, done_at),
       done_by = COALESCE(?, done_by), note = COALESCE(?, note),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [status, doneCount, doneAt, patch.done_by ?? null, patch.note ?? null, id],
  );
  // 只为把进度算到所属工作台上：阶段即使已进回收站（deleted_at IS NOT NULL）也要先拿到 workbench_id，
  // 所以这条**有意不加** `deleted_at IS NULL` 守卫
  const pos = get<PositionInstance>('SELECT workbench_id FROM position_instance WHERE id = ?', [item.position_instance_id]);
  if (pos) recalcProgress(pos.workbench_id);
}

export function recalcProgress(workbenchId:number):number { return syncEvidence(workbenchId); }

/* ============================== 模板库 ============================== */

export interface Template {
  shared: number;
  id: number;
  code: string;
  name: string;
  category: string;
  work_type_id: number | null;
  position_code: string | null;
  file_rel: string;
  file_format: string;
  vars_rel: string | null;
  variable_count: number;
  doc_no: string | null;
  description: string | null;
  usage_note: string | null;
  archived_at: string | null;
  /**
   * 健康状态（迁移 014）：NULL=还没校验过，1=好，0=坏（打不开 / XML 不合法）。
   * 坏模板照样入库、照样在界面上看得到，只是出文书前会被 `domain/generate.ts` 拦下。
   */
  health_ok: number | null;
  health_note: string | null;
  health_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateVarSpec {
  name: string;
  label?: string;
  type?: 'text' | 'longtext' | 'date' | 'number' | 'table' | 'select';
  required?: boolean;
  example?: string;
  options?: string[];
  hint?: string;
}

export interface TemplateVarsFile {
  template?: string;
  workType?: string;
  positionCode?: string;
  description?: string;
  variables: TemplateVarSpec[];
  updatedAt?: string;
}

export function templateDir(): string {
  return join(DATA_ROOT, DIRS.templates);
}

/**
 * 首次回填：迁移 014 之后，所有历史模板的 health_* 都是 NULL。
 *
 * 不趁早校验一次的话，"坏模板不再产出坏文件"就取决于用户有没有点过
 * 「检查模板是否可用」——那不算真的拦住了。所以第一次有人列出模板时
 * （模板库页面、工作台绑定模板、生成选择器、AI 助手工具都走 listTemplates）
 * 顺手补跑一遍并写回，之后靠 refreshTemplateHealth 增量维护。
 * 每个进程只尝试一次；失败绝不影响列表本身。
 */
let healthBackfilled = false;
function backfillTemplateHealthOnce(): void {
  if (healthBackfilled) return;
  healthBackfilled = true;
  try {
    const pending = get<{ n: number }>('SELECT COUNT(*) AS n FROM template WHERE health_ok IS NULL AND archived_at IS NULL')?.n ?? 0;
    if (pending > 0) recheckAllTemplates();
  } catch (e) {
    console.warn(`模板健康状态首次回填失败（不影响使用）：${(e as Error).message}`);
  }
}

export function listTemplates(filter: { category?: string; workTypeId?: number; keyword?: string; archived?:boolean } = {}): (Template & { work_type_name: string | null })[] {
  backfillTemplateHealthOnce();
  const where: string[] = [filter.archived ? 't.archived_at IS NOT NULL' : 't.archived_at IS NULL'];
  const params: (string | number)[] = [];
  if (filter.category) {
    where.push('t.category = ?');
    params.push(filter.category);
  }
  if (filter.workTypeId) {
    where.push('(t.work_type_id = ? OR (t.work_type_id IS NULL AND t.shared=1) OR EXISTS (SELECT 1 FROM position_template_doc b JOIN position_template p ON p.id=b.position_template_id WHERE b.template_id=t.id AND b.deleted_at IS NULL AND p.archived_at IS NULL AND p.work_type_id=?))');
    params.push(filter.workTypeId,filter.workTypeId);
  }
  if (filter.keyword) {
    where.push('(t.name LIKE ? OR t.code LIKE ? OR t.description LIKE ?)');
    params.push(`%${filter.keyword}%`, `%${filter.keyword}%`, `%${filter.keyword}%`);
  }
  return all(
    `SELECT t.*, w.name AS work_type_name FROM template t LEFT JOIN work_type w ON w.id = t.work_type_id
      WHERE ${where.join(' AND ')} ORDER BY t.category, t.name`,
    params,
  );
}

export function getTemplate(id: number): Template | undefined {
  return get<Template>('SELECT * FROM template WHERE id = ?', [id]);
}
export function templateGenerationScope(t:Pick<Template,'usage_note'>):'period'|'record'|undefined{return t.usage_note?.startsWith('scope:period;')?'period':t.usage_note?.startsWith('scope:record;')?'record':undefined;}
/** Existing explicit stage bindings also express bounded business reuse. */
export function templateSupportsWorkType(t:Template,workTypeId:number):boolean{
 return t.work_type_id===workTypeId||(t.work_type_id===null&&!!t.shared)||!!get('SELECT b.id FROM position_template_doc b JOIN position_template p ON p.id=b.position_template_id WHERE b.template_id=? AND p.work_type_id=? AND b.deleted_at IS NULL AND p.archived_at IS NULL',[t.id,workTypeId]);
}

export function templateAbsPath(t: Template): string {
  return resolveInside(DATA_ROOT, t.file_rel);
}

export function varsAbsPath(t: Template): string | null {
  return t.vars_rel ? resolveInside(DATA_ROOT, t.vars_rel) : null;
}

/**
 * 校验一个模板文件并把结果写回 `template.health_ok / health_note / health_checked_at`。
 *
 * 三件事必须成立，否则这个功能反而会害人：
 *   ① 校验本身**不抛异常**（checkTemplateHealth 内部全兜住了，这里再兜一层）；
 *   ② 写库失败**不影响上传/扫描**（坏模板也要能入库、能在界面上看到、能重传）；
 *   ③ 返回值就是这次的真实结论，调用方可以直接用。
 */
export function refreshTemplateHealth(t: Template): TemplateHealth {
  let h: TemplateHealth;
  try {
    h = checkTemplateHealth(templateAbsPath(t));
  } catch (e) {
    h = { ok: false, reason: `校验时出错：${(e as Error).message}`, checkedAt: new Date().toISOString() };
  }
  try {
    run('UPDATE template SET health_ok = ?, health_note = ?, health_checked_at = ? WHERE id = ?', [
      h.ok ? 1 : 0,
      h.reason,
      h.checkedAt,
      t.id,
    ]);
  } catch (e) {
    console.warn(`模板 #${t.id} 健康状态写库失败（不影响使用）：${(e as Error).message}`);
  }
  return h;
}

export interface TemplateHealthStats {
  /** 这次一共校验了几个模板 */
  checked: number;
  /** 其中判为坏的个数 */
  bad: number;
  items: { id: number; name: string; ok: boolean; note: string | null }[];
}

/**
 * 逐个重跑所有**在用**模板的健康校验并写回，返回统计。
 * 接口 `POST /api/templates/health-check` 与界面上的「检查模板是否可用」按钮用它。
 * 归档模板默认跳过（它们不出文书），需要时传 true。
 */
export function recheckAllTemplates(includeArchived = false): TemplateHealthStats {
  const rows = all<Template>(
    `SELECT * FROM template ${includeArchived ? '' : 'WHERE archived_at IS NULL'} ORDER BY id`,
  );
  const items: TemplateHealthStats['items'] = [];
  tx(() => {
    for (const t of rows) {
      const h = refreshTemplateHealth(t);
      items.push({ id: t.id, name: t.name, ok: h.ok, note: h.reason });
    }
  });
  return { checked: items.length, bad: items.filter((i) => !i.ok).length, items };
}

/** 读变量说明文件，没有就返回空壳 */
export function readTemplateVars(t: Template, autoScan = true): TemplateVarsFile {
  const vp = varsAbsPath(t);
  if (vp && existsSync(vp)) {
    try {
      const parsed = JSON.parse(readFileSync(vp, 'utf8')) as TemplateVarsFile;
      if (Array.isArray(parsed.variables)) return { ...parsed, variables: parsed.variables.filter((v) => v && v.name) };
    } catch {
      /* 文件坏了就退回扫描结果 */
    }
  }
  if (!autoScan) return { variables: [] };
  const abs = templateAbsPath(t);
  if (!existsSync(abs)) return { variables: [] };
  const fmt = detectFormat(abs);
  const names = fmt === 'docx' ? placeholderNamesFromDocx(abs) : [];
  return { variables: names.map((n) => ({ name: n, label: n, type: 'text' as const, required: true })) };
}

function placeholderNamesFromDocx(abs: string): string[] {
  try {
    return scanDocx(abs).variables.map((v) => v.name);
  } catch {
    return [];
  }
}

export function writeTemplateVars(t: Template, vars: TemplateVarsFile): string {
  snapshotTemplateRevision(getTemplate(t.id)??t);
  const rel = toPosix(join(DIRS.templates, `${safeName(t.code)}.vars.json`));
  const abs = join(DATA_ROOT, rel);
  ensureDir(join(DATA_ROOT, DIRS.templates));
  writeFileSync(abs, JSON.stringify({ ...vars, template: t.name, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
  run(
    `UPDATE template SET vars_rel = ?, variable_count = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [rel, vars.variables.length, t.id],
  );
  return rel;
}

/** 扫描模板并落盘变量说明（上传后自动调用） */
export async function rescanTemplate(id: number): Promise<{ vars: TemplateVarsFile; scan: ScanResult; health: TemplateHealth }> {
  const t = getTemplate(id);
  if (!t) throw new Error('模板不存在');
  const abs = templateAbsPath(t);
  const scan = await scanTemplate(abs);
  const current = readTemplateVars(t, false);
  const existingMap = new Map(current.variables.map((v) => [v.name, v]));
  const variables: TemplateVarSpec[] = scan.variables
    .filter((v) => !v.prefix)
    .map((v) => {
      const prev = existingMap.get(v.name);
      return {
        name: v.name,
        label: prev?.label ?? v.name,
        type: prev?.type ?? 'text',
        required: prev?.required ?? true,
        example: prev?.example ?? v.fallback ?? undefined,
        options: prev?.options,
        hint: prev?.hint,
      };
    });
  const vars: TemplateVarsFile = {
    template: t.name,
    description: current.description,
    positionCode: t.position_code ?? undefined,
    variables,
  };
  writeTemplateVars(t, vars);
  /**
   * 顺手重新校验健康状态：扫描是"要拿这个模板干活了"的信号，
   * 用户也可能刚把修好的文件覆盖上来再点扫描。坏模板不阻断扫描 —— 变量照样扫出来。
   */
  const health = refreshTemplateHealth(t);
  return { vars, scan, health };
}

export function registerTemplate(input: {
  absSourcePath: string;
  /** 原始文件名：上传流落到临时文件后名字会变成 UUID，必须把原名传进来 */
  originalFileName?: string;
  name?: string;
  code?: string;
  category?: string;
  workTypeId?: number | null;
  positionCode?: string | null;
  description?: string;
  docNo?: string | null;
}): Template {
  const src = input.absSourcePath;
  const fileName = input.originalFileName?.trim() || basename(src);
  const ext = extname(fileName).toLowerCase();
  const name = input.name?.trim() || basename(fileName, ext);
  const dir = templateDir();
  ensureDir(dir);
  const stored = uniqueFileName(dir, safeName(fileName, `模板${ext}`));
  writeFileSync(join(dir, stored), readFileSync(src));
  const rel = toPosix(join(DIRS.templates, stored));
  const code = uniqueTemplateCode(input.code?.trim() || slugCode(name));
  const r = run(
    `INSERT INTO template (code, name, category, work_type_id, position_code, file_rel, file_format, doc_no, description)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [code, name, input.category ?? 'general', input.workTypeId ?? null, input.positionCode ?? null, rel, detectFormat(fileName), input.docNo ?? null, input.description ?? null],
  );
  /**
   * 入库即校验：**坏模板照样入库**（界面上要看得见、要能重传），
   * 只是打上 health_ok=0，`domain/generate.ts` 在出文书前据此拦下来。
   * 这里也绝不因为校验失败而回滚上传。
   */
  refreshTemplateHealth(getTemplate(r.lastInsertRowid) as Template);
  return getTemplate(r.lastInsertRowid) as Template;
}

/**
 * 从模板名生成 code。
 *
 * 中文名经 ASCII 过滤后可能整个变成空串（如「廉政承诺书」→ ""），
 * 此时若只靠时间戳兜底，同一秒内上传多份中文名模板就会生成相同的 code，
 * 触发 template.code 的唯一约束。所以这里追加一个基于名字的散列，
 * 保证「同名必同码、不同名必不同码」，与上传时刻无关。
 */
function slugCode(name: string): string {
  const ascii = name.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${ascii || 'tpl'}-${shortHash(name)}`;
}

/**
 * 保证 code 在整张表里唯一（包括已归档的行）。
 *
 * 「删掉一份模板、过阵子再传一次」是很正常的操作，而删除只是归档：
 * 若直接沿用同样的 code，第二次上传会撞唯一约束、报一个看不懂的数据库错误。
 * 这里退化成加序号，用户看不到也不影响使用。
 */
function uniqueTemplateCode(base: string): string {
  let code = base;
  for (let i = 2; i <= 200; i += 1) {
    if (!get<{ id: number }>('SELECT id FROM template WHERE code = ?', [code])) return code;
    code = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** 名字 → 6 位 36 进制散列（FNV-1a），用于区分剔除 ASCII 后同形的中文名 */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(0, 7);
}

/* ============================== 生成上下文 ============================== */

/**
 * 变量名 → 工作台档案字段的同义词映射。
 * 模板里叫「检查人」，工作台里存的是「负责人」，靠这张表把两者接上，
 * 这样打开填写界面时该填的已经填好了。
 */
const VAR_ALIASES: Record<string, string[]> = {
  检查人: ['负责人', '经办人', '编制人'],
  检查人员: ['负责人', '经办人'],
  负责人: ['负责人'],
  项目负责人: ['负责人'],
  检查日期: ['_今天中文'],
  填表日期: ['_今天中文'],
  编制日期: ['_今天中文'],
  报告日期: ['_今天中文'],
  日期: ['_今天中文'],
  检查月份: ['_本月'],
  所属月份: ['_本月'],
  月份: ['_本月'],
  项目名称: ['_工作台名称'],
  工作台名称: ['_工作台名称'],
  项目编号: ['_工作台编号'],
  编号: ['_工作台编号'],
  建设单位: ['建设单位'],
  甲方单位: ['建设单位'],
  委托单位: ['建设单位'],
  合同编号: ['合同编号'],
  开工日期: ['开工日期'],
  单位名称: ['建设单位'],
  当前阶段: ['_当前阶段'],
  阶段名称: ['_当前阶段'],
};

/**
 * 变量名 → 工作台原生字段的同义词。
 *
 * 给 domain/archive.ts 的 resolveVariable 用：档案别名表命中一个**空**字段时，
 * 要能退回到工作台自带字段（模板里的「检查人」= 工作台的「负责人」）。
 * 没有这张表，「档案里有这一项但还没填」会把明明已经填好的负责人挡住，
 * 用户就得每次手打一遍。
 */
export function nativeAliasesFor(name: string): string[] {
  return VAR_ALIASES[name] ?? [];
}

/** 优先精确匹配变量名，其次走同义词，最后大小写无关匹配 */export function resolvePreset(name: string, context: Record<string, unknown>): string | undefined {
  const pick = (key: string): string | undefined => {
    const v = context[key];
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    return String(v);
  };
  const direct = pick(name);
  if (direct) return direct;
  for (const alias of VAR_ALIASES[name] ?? []) {
    const v = pick(alias);
    if (v) return v;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(context)) {
    if (/^_/.test(k)) continue;
    if (k.toLowerCase() === lower && String(v).trim() !== '') return String(v);
  }
  return undefined;
}

/**
 * 工作台「原生上下文」：日期类系统变量 + 工作台表自带的字段 + 档案 JSON 桶。
 *
 * 注意这里是**原始值池**，不含别名解析。要让模板里的 {甲方名称} 命中
 * 「建设单位」这类同义关系，走 domain/archive.ts 的 resolveVariable ——
 * 那边是数据驱动的别名表，不再用下面这张硬编码的 VAR_ALIASES。
 */
export function buildNativeContext(workbenchId: number | null | undefined, positionCode?: string | null): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  const now = new Date();
  ctx['_今天'] = dateOnly(now);
  ctx['_今天中文'] = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`;
  ctx['_本月'] = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  ctx['_年份'] = String(now.getFullYear());
  if (!workbenchId) return ctx;
  const wb = getWorkbench(workbenchId);
  if (!wb) return ctx;
  const wt = getWorkType(wb.work_type_id);
  ctx['工作台编号'] = wb.code;
  ctx['_工作台编号'] = wb.code;
  ctx['项目名称'] = wb.name;
  ctx['工作名称'] = wb.name;
  ctx['业务内容'] = wb.business_content ?? '';
  ctx['本期内容'] = wb.business_content ?? '';
  ctx['内容'] = wb.business_content ?? '';
  ctx['_工作台名称'] = wb.name;
  ctx['工作类型'] = wt?.name ?? '';
  ctx['负责人'] = wb.owner ?? '';
  ctx['建设单位'] = wb.counterpart ?? '';
  ctx['合同编号'] = wb.contract_no ?? '';
  ctx['开工日期'] = wb.start_date ?? '';
  if(wt?.code==='integrity-talk'){
    const artifacts=all<Artifact>("SELECT a.* FROM artifact a JOIN template t ON t.id=a.template_id WHERE a.workbench_id=? AND a.deleted_at IS NULL AND a.is_final=1 AND t.name LIKE '%谈心谈话记录表%' ORDER BY a.id",[wb.id]);
    const rows:Record<string,unknown>[]=[];
    for(const a of artifacts){
      try{
        assertFinalArtifact(a);
        const log=get<{variables:string}>('SELECT variables FROM generation_log WHERE artifact_id=? ORDER BY id DESC LIMIT 1',[a.id]);
        if(!log)continue;const v=JSON.parse(log.variables) as Record<string,unknown>;
        rows.push({'序号':rows.length+1,'年份':String(v['谈话时间']??'').match(/20\d{2}/)?.[0]??'未填写','谈话时间':v['谈话时间']??'未填写','谈话地点':v['谈话地点']??'未填写','主谈人':v['主谈人']??'未填写','谈话对象':v['谈话对象']??'未填写','谈话对象职务':v['谈话对象职务']??'未填写','记录人':v['记录人']??'未填写','项目名称':v['项目名称']??v['谈话事由']??'未填写','涉及廉政风险环节':'未填写','主要廉洁风险点提示':'未填写','廉洁要求摘要':v['谈话内容']??'未填写','归档状态':'已定稿','归档文件':a.file_name});
      }catch{/* 无有效文件或生成字段的旧件须人工补录，不从正文猜测。 */}
    }
    ctx['谈话记录']=JSON.stringify(rows);
  }
  if (wb.profile) {
    try {
      const values=JSON.parse(wb.profile) as Record<string,unknown>;
      for(const [k,v] of Object.entries(values))if(!['templateIds','contract_no','contract_amount','start_date'].includes(k)&&!k.startsWith('_'))ctx[k]=v;
      ctx.contract_no=wb.contract_no ?? values.contract_no ?? '';ctx.contract_amount=wb.contract_amount ?? values.contract_amount ?? '';ctx.start_date=wb.start_date ?? values.start_date ?? '';
    } catch {
      /* 忽略坏档案 */
    }
  }
  if (positionCode) {
    // 有意不守卫：这里只取"当前阶段的中文名/序号"给变量上下文用；阶段可能已进回收站
    // （deleted_at IS NOT NULL），但生成时拿它的名字不会造成任何越权或数据错误
    const pa = get<{ name: string; seq: number }>(
      'SELECT name, seq FROM position_instance WHERE workbench_id = ? AND code = ?',
      [workbenchId, positionCode],
    );
    if (pa) {
      ctx['_当前阶段'] = pa.name;
      ctx['_当前阶段序号'] = String(pa.seq);
    }
  }
  return ctx;
}

/** 收集工作台里已归档的资料文本，作为生成时的参考资料 */
export function collectReferenceText(workbenchId: number, limit = 6, maxCharsEach = 4000): string {
  const rows = all<Artifact>(
    `SELECT * FROM artifact WHERE workbench_id = ? AND (extracted_text IS NOT NULL OR ocr_text IS NOT NULL)
      AND ${liveFilter('artifact')}
      ORDER BY created_at DESC LIMIT ?`,
    [workbenchId, limit],
  );
  return rows
    .map((a) => `【资料：${a.title}】\n${artifactBodyText(a).slice(0, maxCharsEach)}`)
    .join('\n\n');
}

/** 列出工作台目录下的文件（含手工放进去的） */
export function scanWorkbenchFolder(workbenchId: number): { path: string; isDir: boolean; size: number; mtime: string }[] {
  const wb = getWorkbench(workbenchId);
  if (!wb) return [];
  const root = join(DATA_ROOT, wb.folder_path);
  if (!existsSync(root)) return [];
  const out: { path: string; isDir: boolean; size: number; mtime: string }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const rel = toPosix(abs.slice(root.length + 1));
      out.push({ path: rel, isDir: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() });
      if (st.isDirectory() && out.length < 500) walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/* ============================== 今日待办聚合（清单 B4-14） ============================== */

/**
 * 版本链的**读**一律走 `domain/versions.ts`，这里不重写版本 SQL。
 *
 * 【为什么 import 写在这里、而不是文件开头的 import 块】
 * 本轮改动被限定为"只在 service.ts 末尾追加新函数、别动既有段落"
 * （开头那一段刚落地了阶段↔模板绑定等改动）。ESM 的 import 声明
 * 只要求位于模块顶层，可以出现在任意位置且会被提升，所以放在末尾是合法的；
 * `versions.ts` 不反向 import 本文件，不存在循环依赖。
 */
import { ensureDocVersionSchema, listLiveVersions } from './versions.ts';

/** 待办类型：前两个来自工作台级周期排期，后三个来自阶段清单与文书版本链 */
export type TodayTodoKind = 'overdue' | 'dueToday' | 'docDraft' | 'material' | 'evidence';

/**
 * 紧急度顺序 —— 生成的 `items` 就按这个数组分档拼起来：
 * **逾期 > 今天到期 > 未定稿 > 缺材料 > 缺影像**。
 * 档内再按各自的键排（逾期天数降序 / 到期日升序 / 等得最久的在前 / 缺得最多的在前）。
 */
export const TODAY_TODO_KINDS: TodayTodoKind[] = ['overdue', 'dueToday', 'docDraft', 'material', 'evidence'];

export interface TodayTodo {
  kind: TodayTodoKind;
  /** 要办的那件事（工作台名 / 「阶段｜清单项」/ 文书文件名） */
  title: string;
  /** 人话的"为什么它在这里"：「已逾期 11 天（每月 5 号，本期应于 2026-09-20 前完成）」 */
  reason: string;
  workbenchId: number;
  workbenchCode: string;
  workbenchName: string;
  /** 属于哪个阶段（工作台级待办为 null） */
  positionInstanceId: number | null;
  positionCode: string | null;
  positionName: string | null;
  positionSeq: number | null;
  /** 缺材料/缺影像：是哪一条清单项；以及它是该阶段清单里的第几项（与详情页同序） */
  checklistItemId: number | null;
  itemNo: number | null;
  /** 待定稿：这一链上最新那一版的 artifact.id（点进去/复核用） */
  artifactId: number | null;
  /** 到期日（YYYY-MM-DD）；非排期类待办为 null */
  dueAt: string | null;
  overdueDays: number;
  /** 还缺多少：材料恒为 1，影像是"还差几张"；其它为 null */
  missingCount: number | null;
  /** 待定稿的排序键：最新那版的生成时间 */
  createdAt: string | null;
  /** 点进去的落点（前端路由串，形如 `/workbench?id=39`） */
  href: string;
  /** 档位（= TODAY_TODO_KINDS 的下标），便于核对排序口径 */
  rank: number;
}

export interface TodayTodos {
  items: TodayTodo[];
  counts: Record<TodayTodoKind | 'total', number>;
  generatedAt: string;
  /** 本次聚合实际执行的 SQL 条数（自证"不随工作台/阶段数量增长"） */
  queries: number;
  /** items 是否被 limit 截断（counts 仍是完整计数） */
  truncated: boolean;
}

/**
 * 「今天该干什么」一次算出来（清单 B4-14）。首页「今日待办」卡片用这一个函数。
 *
 * 【口径写死在这里，界面不改口径】
 *   1. `overdue` / `dueToday` —— **工作台级的周期排期**：`recurrence <> 'once'` 的工作台，
 *      用 `computeSchedule()`（与 `/api/workbenches/due` **同一个函数**，不另写一套排期）
 *      算出 `daysUntil <= 0` 的那些，即"已过期或今天到期且这一期还没完成"。
 *      ⚠ 与代码不符之处：docs/11 B4-14 写的是"欠办的周期工作"（对得上），但任务描述里写的是
 *      `position_instance.schedule_due_date` —— **库里没有这一列**：`schedule_due_date` /
 *      `last_done_period` 由迁移 009 加在 `workbench` 上，`position_instance` 只有
 *      status / started_at / finished_at，没有任何到期日。所以这一档按工作台级周期落地。
 *   2. `material` —— `checklist_item.kind='material' AND required=1 AND status NOT IN ('done','na')`，
 *      且**阶段已开始**（`started_at` 非空或 `status='doing'`）。还没开始的阶段本来就不到准备的时候，
 *      把它那几十条清单算成"今天该干"只会把这一屏淹掉。
 *   3. `evidence` —— `kind='evidence' AND required=1 AND status<>'na' AND done_count < min_count`。
 *      `done_count` 由 `core/checklist.ts` 的 `syncEvidence()` 维护，等于**实际有效影像张数**
 *      （文件在磁盘上、未软删、`mime` 是图片），所以这就是"evidence_rule 要求张数 > 实际影像数"。
 *      模板层的 `evidence_rule` 在建台时已被 `seedChecklist()` 实例化成 `checklist_item`，
 *      因此这里只查清单、不再按阶段回查规则表（也就不用逐阶段查库）。
 *   4. `docDraft` —— 版本链上**有在用的版本、但没有最终版**。链的读取一律走
 *      `domain/versions.ts` 的 `listLiveVersions()`（`kind='generated'`、软删除过滤、
 *      revision 排序都在那边），这里只自己枚举"有哪些链"。
 *      迁移 017 之前生成、**没有链**（`version_group IS NULL`）的旧文书不算待定稿 ——
 *      否则整库历史生成件会一次全变成待办，那正是"待办越积越多没人看"。
 *
 * 【三条排除（缺一条都会算出假待办）】
 *   · **软删除**：所有表都走 `core/trash.ts` 的 `liveFilter()`（老库缺 `deleted_at` 列时自动降级成 `1=1`，
 *     不会因为一条 `deleted_at IS NULL` 把整个接口打成 500）；
 *   · **已归档工作台**：`archived_at IS NOT NULL`（外加 `status <> 'archived'` 兜脏数据）一律不算 ——
 *     归档了还算"今天该做"是错的；
 *   · 已完成/跳过的工作台与阶段：周期档只取 `status IN ('active','paused')`。
 *
 * 【性能】SQL 条数 = 3 + 待定稿候选链数：**不随工作台数、阶段数、清单项数增长**。
 * 三种待办各一条聚合查询（① 周期性工作台 ② 清单 join 阶段 join 工作台 ③ 版本链分组），
 * 只有"这条链到底有没有最终版"必须回到 `versions.ts` 的读函数（一条链一次 ——
 * 这是"别自己写版本 SQL"的代价，链数量级远小于工作台×阶段）。
 *
 * @param opts.owner 只看某个负责人的（本机单用户、不传 = 全部）；`opts.now` 供测试注入"今天"。
 */
export function listTodayTodos(opts: { owner?: string | null; now?: Date; limit?: number } = {}): TodayTodos {
  const now = opts.now ?? new Date();
  const owner = (opts.owner ?? '').trim() || null;
  const limit = Math.min(Math.max(opts.limit ?? 300, 1), 1000);
  const ownerParam: (string | number)[] = owner ? [owner] : [];
  const ownerSql = owner ? 'AND w.owner = ?' : '';
  /** 自证性能用：本函数自己发的 SQL 条数（不含 `liveFilter` 的 pragma 列探测，那结果有进程内缓存） */
  let queries = 0;

  const groups = new Map<TodayTodoKind, TodayTodo[]>();
  const push = (item: TodayTodo): void => {
    const list = groups.get(item.kind) ?? [];
    list.push(item);
    groups.set(item.kind, list);
  };

  /* ---------- ① 到期的周期工作（一次取全部，排期在内存里算） ---------- */
  queries += 1;
  const recurring = all<Workbench>(
    `SELECT w.* FROM workbench w
      WHERE ${liveFilter('workbench', 'w')}
        AND w.archived_at IS NULL
        AND w.status IN ('active','paused')
        AND w.recurrence <> 'once'
        ${ownerSql}`,
    ownerParam,
  );
  for (const wb of recurring) {
    const s = computeSchedule(
      {
        recurrence: (wb.recurrence as ScheduleSpec['recurrence']) ?? 'once',
        recur_day: wb.recur_day,
        recur_month: wb.recur_month,
        remind_days: wb.remind_days,
        last_done_at: wb.last_done_at,
        schedule_due_date: wb.schedule_due_date,
        last_done_period: wb.last_done_period,
      },
      now,
    );
    // 只收"已过期或今天到期"：还没进提醒窗口的不算今天该干（提前量提醒由 /api/workbenches/due 管）
    if (!s.recurring || s.daysUntil === null || s.daysUntil > 0) continue;
    const overdue = s.overdueDays > 0;
    const kind: TodayTodoKind = overdue ? 'overdue' : 'dueToday';
    push({
      kind,
      title: wb.name,
      reason: overdue
        ? `已逾期 ${s.overdueDays} 天（${s.label}，本期应于 ${s.nextDue} 前完成）`
        : `今天到期（${s.label}，本期应于 ${s.nextDue} 完成）`,
      workbenchId: wb.id,
      workbenchCode: wb.code,
      workbenchName: wb.name,
      positionInstanceId: null,
      positionCode: null,
      positionName: null,
      positionSeq: null,
      checklistItemId: null,
      itemNo: null,
      artifactId: null,
      dueAt: s.nextDue,
      overdueDays: s.overdueDays,
      missingCount: null,
      createdAt: null,
      href: `/workbench?id=${wb.id}`,
      rank: TODAY_TODO_KINDS.indexOf(kind),
    });
  }

  /* ---------- ② 缺材料 / 缺影像（清单 → 阶段 → 工作台，一条查询） ---------- */
  /**
   * `item_no` 用窗口函数在**全量清单**上先编号，再在外层挑未完成的那几条：
   * 窗口函数在 WHERE 之后才算，直接写在过滤后的查询里会变成"未完成项里的第几项"，
   * 界面上显示「清单第 1 项」就对不上详情页了。排序口径与 `getWorkbenchDetail()` 逐字一致
   * （`kind DESC, sort_order, id`）。
   */
  queries += 1;
  const checklistRows = all<{
    wb_id: number;
    wb_code: string;
    wb_name: string;
    pos_id: number;
    pos_code: string;
    pos_name: string;
    pos_seq: number;
    item_id: number;
    item_kind: string;
    item_title: string;
    min_count: number;
    done_count: number;
    item_no: number;
  }>(
    `SELECT w.id AS wb_id, w.code AS wb_code, w.name AS wb_name,
            p.id AS pos_id, p.code AS pos_code, p.name AS pos_name, p.seq AS pos_seq,
            c.id AS item_id, c.kind AS item_kind, c.title AS item_title,
            c.min_count AS min_count, c.done_count AS done_count, c.item_no AS item_no
       FROM (SELECT c0.*, ROW_NUMBER() OVER (PARTITION BY c0.position_instance_id
                                             ORDER BY c0.kind DESC, c0.sort_order, c0.id) AS item_no
               FROM checklist_item c0) c
       JOIN position_instance p ON p.id = c.position_instance_id
       JOIN workbench w ON w.id = p.workbench_id
      WHERE ${liveFilter('position_instance', 'p')}
        AND ${liveFilter('workbench', 'w')}
        AND w.archived_at IS NULL
        AND w.status <> 'archived'
        AND (p.started_at IS NOT NULL OR p.status = 'doing')
        AND c.required = 1
        AND NOT (p.status='skipped' AND LENGTH(TRIM(COALESCE(p.note,'')))>0)
        ${ownerSql}
      ORDER BY w.id, p.seq, c.kind DESC, c.sort_order, c.id`,
    ownerParam,
  );
  for (const r of checklistRows) {
    const item=get<ChecklistItem & {review_status:string;review_note:string}>('SELECT * FROM checklist_item WHERE id=?',[r.item_id]);
    if(item&&checklistSatisfied(item,r.wb_id))continue;
    const isEvidence = r.item_kind === 'evidence';
    const minCount = Number(r.min_count ?? 1);
    const doneCount = Number(r.done_count ?? 0);
    const missing = isEvidence ? Math.max(1, minCount - doneCount) : 1;
    const kind: TodayTodoKind = isEvidence ? 'evidence' : 'material';
    push({
      kind,
      title: `${r.pos_name}｜${r.item_title}`,
      reason: isEvidence
        ? doneCount>=minCount?'影像已提供，待人工核对':`还缺 ${missing} 张照片（已 ${doneCount}/${minCount} 张）`
        : `还缺材料：清单第 ${Number(r.item_no)} 项未备齐`,
      workbenchId: r.wb_id,
      workbenchCode: r.wb_code,
      workbenchName: r.wb_name,
      positionInstanceId: r.pos_id,
      positionCode: r.pos_code,
      positionName: r.pos_name,
      positionSeq: Number(r.pos_seq ?? 0),
      checklistItemId: r.item_id,
      itemNo: Number(r.item_no),
      artifactId: null,
      dueAt: null,
      overdueDays: 0,
      missingCount: missing,
      createdAt: null,
      href: `/workbench?id=${r.wb_id}`,
      rank: TODAY_TODO_KINDS.indexOf(kind),
    });
  }

  /* ---------- ③ 有版本但未定稿（枚举链 → versions.ts 读链） ---------- */
  /**
   * 只枚举"有哪些链"（分组），链内语义（哪些版本还在用、有没有最终版）全部交给
   * `versions.ts`。`liveFilter` 对 artifact / workbench 都带上，归档工作台的链不进枚举。
   *
   * 【老库防呆】迁移 017 的列不在（库还没升级完）时**整档跳过**：`ensureDocVersionSchema()`
   * 是 versions.ts 给的老库探测/补列入口，返回 false 就当作"这个库还没有版本链"，
   * 另外三类待办照常返回 —— 而不是让 `version_group` 的 `no such column` 把整个接口打成 500。
   */
  const versionSchemaReady = ensureDocVersionSchema();
  if (versionSchemaReady) queries += 1;
  const chainRows = versionSchemaReady
    ? all<{
        g: string;
        wb_id: number;
        wb_code: string;
        wb_name: string;
        position_code: string | null;
        pos_id: number | null;
        pos_name: string | null;
        pos_seq: number | null;
      }>(
        `SELECT a.version_group AS g,
                MIN(w.id) AS wb_id, MIN(w.code) AS wb_code, MIN(w.name) AS wb_name,
                MIN(a.position_code) AS position_code,
                MIN(p.id) AS pos_id, MIN(p.name) AS pos_name, MIN(p.seq) AS pos_seq
           FROM artifact a
           JOIN workbench w ON w.id = a.workbench_id
           LEFT JOIN position_instance p
                  ON p.workbench_id = a.workbench_id AND p.code = a.position_code
                 AND ${liveFilter('position_instance', 'p')}
          WHERE a.kind = 'generated'
            AND a.version_group IS NOT NULL
            AND ${liveFilter('artifact', 'a')}
            AND ${liveFilter('workbench', 'w')}
            AND w.archived_at IS NULL
            AND w.status <> 'archived'
            ${ownerSql}
          GROUP BY a.version_group
          ORDER BY MIN(a.id)`,
        ownerParam,
      )
    : [];
  for (const row of chainRows) {
    queries += 1; // listLiveVersions() 每次一条（版本链读取不在本文件重写）
    const versions = listLiveVersions(row.g);
    if (!versions.length) continue; // 整条链都进了回收站：没有可定稿的东西
    if (versions.some((v) => Number(v.is_final ?? 0) === 1)) continue; // 已经定稿
    const head = versions[versions.length - 1];
    if (!head) continue; // 上面已判空，这里只为让类型收窄（noUncheckedIndexedAccess）
    const revision = Number(head.revision ?? 1);
    push({
      kind: 'docDraft',
      title: head.title || head.file_name,
      reason: `有 ${versions.length} 版但还没标「最终版」（最新 v${revision}，${head.file_name}）`,
      workbenchId: row.wb_id,
      workbenchCode: row.wb_code,
      workbenchName: row.wb_name,
      positionInstanceId: row.pos_id,
      positionCode: row.position_code,
      positionName: row.pos_name,
      positionSeq: row.pos_seq === null ? null : Number(row.pos_seq),
      checklistItemId: null,
      itemNo: null,
      artifactId: head.id,
      dueAt: null,
      overdueDays: 0,
      missingCount: null,
      createdAt: head.created_at ?? null,
      href: `/workbench?id=${row.wb_id}`,
      rank: TODAY_TODO_KINDS.indexOf('docDraft'),
    });
  }

  /* ---------- 分档 + 档内排序 ---------- */
  const sorters: Record<TodayTodoKind, (a: TodayTodo, b: TodayTodo) => number> = {
    // 逾期久的最急
    overdue: (a, b) =>
      b.overdueDays - a.overdueDays ||
      String(a.dueAt).localeCompare(String(b.dueAt)) ||
      a.workbenchId - b.workbenchId,
    // 今天一起到期：按工作台编号稳定排
    dueToday: (a, b) => String(a.dueAt).localeCompare(String(b.dueAt)) || a.workbenchCode.localeCompare(b.workbenchCode),
    // 等得最久的（生成时间最早）排前面
    docDraft: (a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)) ||
      a.workbenchCode.localeCompare(b.workbenchCode) ||
      (a.artifactId ?? 0) - (b.artifactId ?? 0),
    // 缺材料：按工作台 + 阶段顺序走（与详情页的阅读顺序一致）
    material: (a, b) =>
      a.workbenchCode.localeCompare(b.workbenchCode) ||
      (a.positionSeq ?? 0) - (b.positionSeq ?? 0) ||
      (a.itemNo ?? 0) - (b.itemNo ?? 0),
    // 缺影像：缺得最多的在前（docs/11 B4-14 的排序口径）
    evidence: (a, b) =>
      (b.missingCount ?? 0) - (a.missingCount ?? 0) ||
      a.workbenchCode.localeCompare(b.workbenchCode) ||
      (a.positionSeq ?? 0) - (b.positionSeq ?? 0),
  };
  const items = TODAY_TODO_KINDS.flatMap((k) => (groups.get(k) ?? []).slice().sort(sorters[k]));
  const counts: Record<TodayTodoKind | 'total', number> = {
    overdue: 0, dueToday: 0, docDraft: 0, material: 0, evidence: 0, total: items.length,
  };
  for (const it of items) counts[it.kind] += 1;
  return {
    items: items.slice(0, limit),
    counts,
    generatedAt: now.toISOString(),
    queries,
    truncated: items.length > limit,
  };
}

export { canRender, saveArtifact };
export type { Artifact };

/** 配置改动只能经预览并确认后应用到指定阶段；其他实例继续使用快照。 */
export function refreshPositionDocRequirements(positionId:number, expected?:unknown) {
    const p=get<PositionInstance & {doc_requirements:string}>('SELECT * FROM position_instance WHERE id=? AND deleted_at IS NULL',[positionId]);
    if(!p) throw Object.assign(new Error('阶段不存在'),{code:'NOT_FOUND',statusCode:404});
    const difference={before:JSON.parse(p.doc_requirements ?? '[]'),after:p.position_template_id ? listPositionDocBindings(p.position_template_id).map(({templateId,name,required,seq})=>({templateId,name,required,seq})) : []};
    if(expected !== undefined) {
        if(p.status==='done') throw new PeriodDoneError('请先重新打开阶段');
        if(JSON.stringify(expected)!==JSON.stringify(difference)) throw Object.assign(new Error('配置已经变化，请重新预览'),{code:'STALE',statusCode:409});
        tx(()=>{
            run('UPDATE position_instance SET doc_requirements=? WHERE id=?',[JSON.stringify(difference.after),positionId]);
            run("INSERT INTO workflow_event(action,detail) VALUES('project-doc-requirements',?)",[JSON.stringify({positionId,...difference})]);
        });
    }
    return difference;
}
