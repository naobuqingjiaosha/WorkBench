/**
 * 模板变量映射覆盖率
 *
 * 回答一个问题：**模板里的 {变量}，有多少已经能自动带出、不必每次手填或让模型写。**
 *
 * ## 「已映射」的精确定义（唯一口径，必须与运行时一致）
 *
 * 一个变量算「已映射」，当且仅当它在**档案字段全部填好**的前提下，
 * 走一遍现有的解析链 `domain/archive.ts#resolveVariable` 能拿到非空值。
 * 我们不另写一套近似判断 —— 看板与实际出文书的行为必须同源，否则看板会骗人。
 *
 * 探针上下文（probe）怎么造：
 *   · `archive`：该模板工作类型**可以填的**档案字段（全局字段 + 本类型字段，未归档）
 *                 全部塞上哨兵值。含义是「假设用户把项目信息都填了」。
 *   · `native` ：只放系统注入的键（`_今天 / _本月 / _年份 / _工作台编号 …`）。
 *                 刻意**不放**工作台自带的用户字段（负责人 / 建设单位 / 合同编号 …）——
 *                 那是兼容旧数据的兜底同义词（service.ts 的 VAR_ALIASES），
 *                 一个变量「因为跟工作台的负责人同名才取到值」不算映射覆盖率。
 *
 * 于是结果只有下面几种，与 resolveVariable 的 `from` 一一对应：
 *   system / archive / native(经 `_系统键` 同义词) → 有值 → **已映射**
 *   mapped-empty  → 名字有映射（或映射到了别的工作类型的字段/已归档字段），但取不到值 → **未映射**
 *   unmapped      → 查不到任何映射 → **未映射**
 * 判定式就一句：`resolveVariable(...).value.trim() !== ''`。
 *
 * ## 两种口径（都返回，界面必须都显示）
 *   · 加权口径（按变量出现次数）：一个变量在 5 份模板里出现就算 5 次。
 *     反映「出文书时到底有多少处还得人管」。**这是头号数字。**
 *   · 去重口径（按变量名）：同一个变量名跨模板只算 1 个。
 *     反映「还有多少个不同的名字等着补别名」。数值明显低于加权口径。
 *   两者差别很大（实测约 36% vs 约 15%），只报一个必然误导。
 *
 * ## 注意：这是「映射覆盖率」，不是「这个项目现在自动填了多少」
 *  覆盖率只随别名表和模板变量清单变化，与某个工作台的项目信息填没填无关。
 *  「某个工作台实际能自动带出多少」是另一件事（档案完整度 / 实测代入率），
 *  在模板解析预览（/api/archive/resolve）里看。
 */
import { existsSync } from 'node:fs';
import { all } from '../db/index.ts';
import { liveFilter } from './trash.ts';
import { resolveVariable, type ResolvedVar } from '../domain/archive.ts';
import { readTemplateVars, templateAbsPath, varsAbsPath, type Template } from '../domain/service.ts';

/* ============================== 类型 ============================== */

export interface CoverageRow {
  workTypeId: number | null;
  workTypeName: string;
  templateId: number;
  templateName: string;
  totalVars: number;
  mappedVars: number;
  unmapped: string[];
}

export interface CoverageDistinct {
  totalVars: number;
  mappedVars: number;
  percent: number;
  /** 在所有出现过的模板里都能取到值的名字数（比 mappedVars 严） */
  mappedEverywhere: number;
  /** 映射状态在不同工作类型之间不一致的变量名（少数派：工作类型专有别名的产物） */
  mixed: string[];
}

/**
 * 分母里的「噪声」：模板里并非项目信息的占位符。
 *
 * 最典型的是表格行序号占位（`{1}`…`{20}`）和编号式明细（`设备1名称`、`交付物2数量`）。
 * 它们被当成变量扫进来，会**虚高分母**、拉低覆盖率。这里把两种口径都算出来：
 * 含噪声 / 剔除纯数字 / 剔除所有带数字的名字，界面和报告都要如实说明用的是哪个。
 */
export interface CoverageNoise {
  /** 纯数字变量名（{1}…{20} 这类序号占位） */
  pureNumber: { distinct: number; occurrences: number; mappedDistinct: number; mappedOccurrences: number };
  /** 名字里带阿拉伯数字的变量（含「设备1名称」这类编号式明细），纯数字的也算在内 */
  withDigits: { distinct: number; occurrences: number; mappedDistinct: number; mappedOccurrences: number };
  /** 剔除纯数字占位后的加权覆盖率 */
  percentWithoutPureNumber: number;
  /** 剔除纯数字占位后的去重覆盖率 */
  distinctPercentWithoutPureNumber: number;
  /** 剔除所有带数字名字后的加权覆盖率（更激进的口径，供参考） */
  percentWithoutDigits: number;
  /** 剔除所有带数字名字后的去重覆盖率 */
  distinctPercentWithoutDigits: number;
}

export interface CoverageUnmappedVar {
  name: string;
  /** 出现次数（跨模板加权） */
  count: number;
  /** 出现在哪些模板（最多列 8 个，完整份数看 templateCount） */
  templates: { id: number; name: string }[];
  templateCount: number;
  workTypeIds: number[];
  /** unmapped = 完全没有映射；dangling = 有映射但取不到值（映射到别的工作类型的字段/已归档字段） */
  reason: 'unmapped' | 'dangling';
  /** reason=dangling 时，映射指向的目标 */
  danglingFieldKeys: string[];
}

export interface CoverageSummary {
  /* ---- 加权口径（按出现次数，头号数字） ---- */
  totalVars: number;
  mappedVars: number;
  percent: number;
  templates: number;
  fullyMapped: number;
  worst: CoverageRow[];
  byWorkType: {
    workTypeId: number | null;
    name: string;
    totalVars: number;
    mappedVars: number;
    percent: number;
    /* 下面是补充信息，便于界面把两种口径一起显示 */
    templates: number;
    distinctTotalVars: number;
    distinctMappedVars: number;
    distinctPercent: number;
  }[];
  /* ---- 去重口径（按变量名） ---- */
  distinct: CoverageDistinct;
  /** 去重口径的百分比，单独平铺一个字段，前端表格直接用 */
  distinctPercent: number;
  distinctTotalVars: number;
  distinctMappedVars: number;
  /* ---- 行动清单 ---- */
  unmappedTop: CoverageUnmappedVar[];
  unmappedSummary: { distinctUnmapped: number; unmappedOccurrences: number; danglingDistinct: number };
  /** 已映射的构成，用于说明「这些其实是系统自动填的」 */
  mappedBreakdown: { viaSystem: number; viaArchive: number; viaSystemSynonym: number; viaDirectKey: number };
  /** 分母噪声（序号占位 / 编号式明细），含噪声与剔除后的数字都给 */
  noise: CoverageNoise;
  /**
   * 没进分母的模板 —— 必须说出来，否则「48 份模板」和实际数量对不上时没人知道为什么。
   *   unreadable：变量清单读不到（模板本体或 .vars.json 已不在数据目录里，如归档后被移走）
   *   empty     ：扫出来 0 个 {变量}（这类模板本身就没有占位符，不是错误）
   */
  skipped: { unreadable: { id: number; name: string; reason: string }[]; empty: { id: number; name: string }[] };
  /** 参与统计的模板口径 */
  scope: { includeArchived: boolean; workTypeId: number | null };
  generatedAt: string;
}

export interface CoverageOptions {
  includeArchived?: boolean;
  /** 只看某个工作类型（同时含通用模板，与 listTemplates 的口径一致） */
  workTypeId?: number | null;
  /** worst 取几个模板，默认 10 */
  worstLimit?: number;
  /** unmappedTop 取几个变量，默认 20 */
  topN?: number;
}

/* ============================== 探针 ============================== */

/**
 * 系统注入键。
 *
 * 前 4 个由 buildNativeContext 无条件注入；后 4 个在「有工作台 / 有阶段实例」时注入，
 * 但它们的值同样不是用户逐份文书手填的（工作台编号、工作台名称、当前阶段），
 * 所以放进探针里算「能自动带出」。
 */
const SYSTEM_PROBE: Record<string, string> = {
  _今天: '2000-01-01',
  _今天中文: '2000年1月1日',
  _本月: '2000年1月',
  _年份: '2000',
  _工作台编号: '覆盖率探针',
  _工作台名称: '覆盖率探针',
  _当前阶段: '覆盖率探针',
  _当前阶段序号: '1',
};

/** 探针里塞进档案字段的哨兵值：只要非空就行，resolveVariable 只判「有没有值」 */
const PROBE_VALUE = '﹡';

/**
 * 造一个工作类型的探针上下文。
 *
 * 字段范围 = 该类型**界面上能填的**字段（archive_field 里 work_type_id 为 NULL 或等于它，且未归档）。
 * 这点很重要：别名指向别的工作类型的字段时（如 wt=4 的 {安全员} → safety_officer 是工程类字段），
 * 信息类项目的「项目信息」页根本不显示这个字段，用户永远填不上 —— 那就该算未映射，
 * 而不是拿一个永远为空的映射去充覆盖率。
 */
function buildProbe(workTypeId: number | null): {
  workTypeId: number | null;
  archive: Record<string, string>;
  native: Record<string, string>;
} {
  const fields = all<{ field_key: string }>(
    `SELECT field_key FROM archive_field
      WHERE archived_at IS NULL AND ${liveFilter('archive_field')} /* deleted_at IS NULL；老库没这列时降级成 1=1 */
        AND (work_type_id IS NULL OR work_type_id = ?)`,
    [workTypeId ?? -1],
  );
  const archive: Record<string, string> = {};
  for (const f of fields) archive[f.field_key] = PROBE_VALUE;
  return { workTypeId, archive, native: SYSTEM_PROBE };
}

/** 与运行时同一个判断：拿得到非空值 = 已映射 */
export function isMappedByResolve(r: ResolvedVar): boolean {
  return r.value.trim() !== '';
}

/* ============================== 模板变量清单 ============================== */

interface InventoryEntry {
  id: number;
  name: string;
  workTypeId: number | null;
  workTypeName: string;
  vars: string[];
  /** 变量清单读不到时的原因（模板本体或 .vars.json 已不在数据目录里） */
  readError?: string;
}

/**
 * 模板变量清单缓存。
 *
 * 键是模板行的签名（id + vars_rel + variable_count + updated_at + archived_at）——
 * 变量清单只在重新扫描模板时变，而 rescanTemplate → writeTemplateVars 一定会
 * 更新 template.updated_at，所以签名变了就重建，不会读到陈旧数据。
 * **别名表不进缓存**：用户点「确认写入」后界面立刻重载就得看到新数字。
 */
const inventoryCache = new Map<string, InventoryEntry[]>();

function inventorySignature(rows: Template[]): string {
  return rows.map((t) => `${t.id}:${t.vars_rel ?? ''}:${t.variable_count}:${t.updated_at}:${t.archived_at ?? ''}`).join('|');
}

function loadInventory(rows: Template[], workTypeName: (id: number | null) => string): InventoryEntry[] {
  const key = inventorySignature(rows);
  const hit = inventoryCache.get(key);
  if (hit) return hit;
  const out: InventoryEntry[] = rows.map((t) => {
    // 复用运行时同一个读取口：优先 .vars.json，没有就回退扫描模板本体
    let names: string[] = [];
    let readError: string | undefined;
    const varsFile = varsAbsPath(t);
    const varsFileExists = Boolean(varsFile && existsSync(varsFile));
    const tplFileExists = existsSync(templateAbsPath(t));
    try {
      names = readTemplateVars(t, true)
        .variables.map((v) => v.name)
        .filter((n) => typeof n === 'string' && n.trim() !== '');
    } catch (e) {
      readError = e instanceof Error ? e.message : String(e);
    }
    /**
     * readTemplateVars 对「文件不在」是**静默返回空**的（它按设计不抛）。
     * 于是归档后被移走文件的模板会从统计里悄悄消失 —— 这里自己确认一下文件在不在，
     * 好让界面上说得出「另有 N 份模板没算进来，因为文件不在了」。
     */
    if (!readError && !names.length && !varsFileExists && !tplFileExists) {
      readError = `模板文件与变量清单都不在数据目录里（${t.file_rel}）`;
    }
    return {
      id: t.id,
      name: t.name,
      workTypeId: t.work_type_id,
      workTypeName: workTypeName(t.work_type_id),
      vars: [...new Set(names)],
      ...(readError ? { readError } : {}),
    };
  });
  // 只留最近几份签名，避免长期驻留
  if (inventoryCache.size > 4) inventoryCache.clear();
  inventoryCache.set(key, out);
  return out;
}

/* ============================== 核心分析 ============================== */

interface Occurrence {
  name: string;
  templateId: number;
  templateName: string;
  workTypeId: number | null;
  workTypeName: string;
  resolved: ResolvedVar;
}

interface Analysis {
  entries: InventoryEntry[];
  occurrences: Occurrence[];
  perTemplate: { entry: InventoryEntry; resolved: ResolvedVar[] }[];
  skipped: CoverageSummary['skipped'];
}

function analyze(opts: CoverageOptions): Analysis {
  const includeArchived = opts.includeArchived === true;
  const filterWt = opts.workTypeId ?? null;

  const rows = all<Template>(
    `SELECT * FROM template
      WHERE ${includeArchived ? '1=1' : 'archived_at IS NULL'}
      ORDER BY work_type_id, id`,
  );
  const wtNames = new Map<number, string>(all<{ id: number; name: string }>('SELECT id, name FROM work_type').map((w) => [w.id, w.name]));
  const nameOf = (id: number | null): string => (id === null ? '通用 / 未分类' : (wtNames.get(id) ?? `工作类型#${id}`));

  // 选模板：指定工作类型时把「通用模板」也算进来（与 listTemplates 的 where 一致）
  const selected = filterWt === null ? rows : rows.filter((t) => t.work_type_id === filterWt || t.work_type_id === null);
  const inventory = loadInventory(selected, nameOf);
  const entries = inventory.filter((e) => e.vars.length > 0);
  const skipped = {
    unreadable: inventory
      .filter((e) => e.readError)
      .map((e) => ({ id: e.id, name: e.name, reason: e.readError as string })),
    empty: inventory.filter((e) => !e.readError && e.vars.length === 0).map((e) => ({ id: e.id, name: e.name })),
  };

  const probes = new Map<string, ReturnType<typeof buildProbe>>();
  const probeFor = (wt: number | null) => {
    const k = String(wt);
    let p = probes.get(k);
    if (!p) {
      p = buildProbe(wt);
      probes.set(k, p);
    }
    return p;
  };

  const occurrences: Occurrence[] = [];
  const perTemplate: { entry: InventoryEntry; resolved: ResolvedVar[] }[] = [];
  for (const e of entries) {
    const probe = probeFor(e.workTypeId);
    const resolved = e.vars.map((n) => resolveVariable(n, probe));
    perTemplate.push({ entry: e, resolved });
    resolved.forEach((r, i) => {
      occurrences.push({
        name: e.vars[i] as string,
        templateId: e.id,
        templateName: e.name,
        workTypeId: e.workTypeId,
        workTypeName: e.workTypeName,
        resolved: r,
      });
    });
  }
  return { entries, occurrences, perTemplate, skipped };
}

function pct(mapped: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((mapped / total) * 1000) / 10;
}

/* ============================== 未映射清单 ============================== */

export interface UnmappedListResult {
  items: CoverageUnmappedVar[];
  /** 去重后一共多少个未映射变量名 */
  total: number;
  /** 加权：一共多少处未映射 */
  occurrences: number;
  /** 其中「有映射但取不到值」的名字数 */
  dangling: number;
  scope: { includeArchived: boolean; workTypeId: number | null };
}

/**
 * 未映射变量清单 —— 给人 / AI 去补别名的行动清单。
 * 默认按出现次数降序（出现得越多，补一条省得越多）。
 */
export function listUnmapped(
  opts: CoverageOptions & { sort?: 'count' | 'name'; limit?: number } = {},
): UnmappedListResult {
  const { occurrences } = analyze(opts);
  const byName = new Map<string, CoverageUnmappedVar>();
  for (const o of occurrences) {
    if (isMappedByResolve(o.resolved)) continue;
    const reason: 'unmapped' | 'dangling' = o.resolved.from === 'mapped-empty' ? 'dangling' : 'unmapped';
    let item = byName.get(o.name);
    if (!item) {
      item = {
        name: o.name,
        count: 0,
        templates: [],
        templateCount: 0,
        workTypeIds: [],
        reason,
        danglingFieldKeys: [],
      };
      byName.set(o.name, item);
    }
    item.count += 1;
    item.templateCount += 1;
    if (item.templates.length < 8) item.templates.push({ id: o.templateId, name: o.templateName });
    if (o.workTypeId !== null && !item.workTypeIds.includes(o.workTypeId)) item.workTypeIds.push(o.workTypeId);
    // dangling 比 unmapped 更需要说明：它看着「配过了」，其实取不到值
    if (reason === 'dangling') {
      item.reason = 'dangling';
      const fk = o.resolved.fieldKey;
      if (fk && !item.danglingFieldKeys.includes(fk)) item.danglingFieldKeys.push(fk);
    }
  }
  let items = [...byName.values()];
  items.sort((a, b) =>
    (opts.sort ?? 'count') === 'name'
      ? a.name.localeCompare(b.name, 'zh-Hans-CN')
      : b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'),
  );
  const total = items.length;
  const occ = items.reduce((s, x) => s + x.count, 0);
  const dangling = items.filter((x) => x.reason === 'dangling').length;
  if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit);
  return {
    items,
    total,
    occurrences: occ,
    dangling,
    scope: { includeArchived: opts.includeArchived === true, workTypeId: opts.workTypeId ?? null },
  };
}

/* ============================== 汇总 ============================== */

export function computeCoverage(opts: CoverageOptions = {}): CoverageSummary {
  const { entries, occurrences, perTemplate, skipped } = analyze(opts);

  /* ---- 加权口径 ---- */
  let totalVars = 0;
  let mappedVars = 0;
  let viaSystem = 0;
  let viaArchive = 0;
  let viaSystemSynonym = 0;
  let viaDirectKey = 0;
  for (const o of occurrences) {
    totalVars += 1;
    if (!isMappedByResolve(o.resolved)) continue;
    mappedVars += 1;
    const from = o.resolved.from;
    if (from === 'system') viaSystem += 1;
    else if (from === 'native') viaSystemSynonym += 1;
    else if (from === 'archive') {
      // ② 别名表命中（via = 「档案 · field_key」）vs ③ 档案里正好有同名的键（via = 「档案键 变量名」）
      if (o.resolved.via?.startsWith('档案键')) viaDirectKey += 1;
      else viaArchive += 1;
    }
  }

  /* ---- 去重口径 ---- */
  const perName = new Map<string, { total: number; mapped: number }>();
  for (const o of occurrences) {
    const cur = perName.get(o.name) ?? { total: 0, mapped: 0 };
    cur.total += 1;
    if (isMappedByResolve(o.resolved)) cur.mapped += 1;
    perName.set(o.name, cur);
  }
  const distinctTotalVars = perName.size;
  const distinctMappedVars = [...perName.values()].filter((v) => v.mapped > 0).length;
  const mappedEverywhere = [...perName.values()].filter((v) => v.mapped === v.total).length;
  const mixed = [...perName.entries()].filter(([, v]) => v.mapped > 0 && v.mapped < v.total).map(([k]) => k);

  /* ---- 噪声：纯数字序号占位 / 编号式明细 ---- */
  const PURE_NUMBER = /^\d+$/;
  const WITH_DIGITS = /\d/;
  const noise: CoverageNoise = {
    pureNumber: { distinct: 0, occurrences: 0, mappedDistinct: 0, mappedOccurrences: 0 },
    withDigits: { distinct: 0, occurrences: 0, mappedDistinct: 0, mappedOccurrences: 0 },
    percentWithoutPureNumber: 0,
    distinctPercentWithoutPureNumber: 0,
    percentWithoutDigits: 0,
    distinctPercentWithoutDigits: 0,
  };
  for (const [name, v] of perName) {
    if (PURE_NUMBER.test(name)) {
      noise.pureNumber.distinct += 1;
      noise.pureNumber.occurrences += v.total;
      if (v.mapped > 0) noise.pureNumber.mappedDistinct += 1;
      noise.pureNumber.mappedOccurrences += v.mapped;
    }
    if (WITH_DIGITS.test(name)) {
      noise.withDigits.distinct += 1;
      noise.withDigits.occurrences += v.total;
      if (v.mapped > 0) noise.withDigits.mappedDistinct += 1;
      noise.withDigits.mappedOccurrences += v.mapped;
    }
  }
  const pn = noise.pureNumber;
  const wd = noise.withDigits;
  noise.percentWithoutPureNumber = pct(mappedVars - pn.mappedOccurrences, totalVars - pn.occurrences);
  noise.distinctPercentWithoutPureNumber = pct(distinctMappedVars - pn.mappedDistinct, distinctTotalVars - pn.distinct);
  noise.percentWithoutDigits = pct(mappedVars - wd.mappedOccurrences, totalVars - wd.occurrences);
  noise.distinctPercentWithoutDigits = pct(distinctMappedVars - wd.mappedDistinct, distinctTotalVars - wd.distinct);

  /* ---- 分子分母，并算出「完全映射」的模板 ---- */
  const rows: CoverageRow[] = perTemplate.map(({ entry, resolved }) => {
    const unmapped = resolved.filter((r) => !isMappedByResolve(r)).map((r) => r.name);
    return {
      workTypeId: entry.workTypeId,
      workTypeName: entry.workTypeName,
      templateId: entry.id,
      templateName: entry.name,
      totalVars: resolved.length,
      mappedVars: resolved.length - unmapped.length,
      unmapped,
    };
  });

  const worst = [...rows]
    .filter((r) => r.totalVars > 0)
    .sort((a, b) => a.mappedVars / a.totalVars - b.mappedVars / b.totalVars || b.totalVars - a.totalVars)
    .slice(0, opts.worstLimit ?? 10);

  /* ---- 按工作类型 ---- */
  const byWt = new Map<string, {
    workTypeId: number | null;
    name: string;
    totalVars: number;
    mappedVars: number;
    templates: number;
    /** 去重口径要跨模板去重，所以先收名字集合，最后取 size */
    names: Set<string>;
    mappedNames: Set<string>;
  }>();
  for (const { entry, resolved } of perTemplate) {
    const key = String(entry.workTypeId);
    let g = byWt.get(key);
    if (!g) {
      g = {
        workTypeId: entry.workTypeId,
        name: entry.workTypeName,
        totalVars: 0,
        mappedVars: 0,
        templates: 0,
        names: new Set<string>(),
        mappedNames: new Set<string>(),
      };
      byWt.set(key, g);
    }
    g.templates += 1;
    g.totalVars += resolved.length;
    g.mappedVars += resolved.filter(isMappedByResolve).length;
    for (const r of resolved) {
      g.names.add(r.name);
      if (isMappedByResolve(r)) g.mappedNames.add(r.name);
    }
  }
  const byWorkType = [...byWt.values()]
    .map((g) => ({
      workTypeId: g.workTypeId,
      name: g.name,
      totalVars: g.totalVars,
      mappedVars: g.mappedVars,
      percent: pct(g.mappedVars, g.totalVars),
      templates: g.templates,
      distinctTotalVars: g.names.size,
      distinctMappedVars: g.mappedNames.size,
      distinctPercent: pct(g.mappedNames.size, g.names.size),
    }))
    .sort((a, b) => a.percent - b.percent);

  const unmappedTop = listUnmapped({ ...opts, limit: opts.topN ?? 20 });

  return {
    totalVars,
    mappedVars,
    percent: pct(mappedVars, totalVars),
    templates: rows.length,
    fullyMapped: rows.filter((r) => r.totalVars > 0 && r.mappedVars === r.totalVars).length,
    worst,
    byWorkType,
    distinct: {
      totalVars: distinctTotalVars,
      mappedVars: distinctMappedVars,
      percent: pct(distinctMappedVars, distinctTotalVars),
      mappedEverywhere,
      mixed,
    },
    distinctPercent: pct(distinctMappedVars, distinctTotalVars),
    distinctTotalVars,
    distinctMappedVars,
    unmappedTop: unmappedTop.items,
    unmappedSummary: {
      distinctUnmapped: unmappedTop.total,
      unmappedOccurrences: unmappedTop.occurrences,
      danglingDistinct: unmappedTop.dangling,
    },
    mappedBreakdown: { viaSystem, viaArchive, viaSystemSynonym, viaDirectKey },
    noise,
    skipped,
    scope: { includeArchived: opts.includeArchived === true, workTypeId: opts.workTypeId ?? null },
    generatedAt: new Date().toISOString(),
  };
}

/** 清掉变量清单缓存（测试用；正常使用不需要） */
export function clearCoverageCache(): void {
  inventoryCache.clear();
}

/* ============================== 规则建议 ============================== */

export interface AliasSuggestion {
  varName: string;
  fieldKey: string;
  label: string;
  source: 'rule' | 'ai';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  /** AI 覆盖了规则建议时，把规则的那条也留着给人对比 */
  rule?: { fieldKey: string; label: string; confidence: 'high' | 'medium' | 'low'; reason: string } | null;
}

export interface SuggestCandidate {
  fieldKey: string;
  label: string;
  type: string;
  /** 该字段在不同工作类型下的称谓（archive_field.aliases_label 解析后） */
  labelAliases: string[];
  /** 已经映射到这个字段的变量名（可当同义词参考） */
  knownVars: string[];
  workTypeId: number | null;
}

/**
 * 取「可以建议映射到哪些档案字段」的候选集。
 * 只给**该工作类型能填的字段**（全局 + 本类型），因为建议最终要落到一个用户真能填的字段上。
 */
export function loadSuggestCandidates(workTypeId: number | null): SuggestCandidate[] {
  const fields = all<{ field_key: string; label: string; type: string; aliases_label: string | null; work_type_id: number | null }>(
    `SELECT field_key, label, type, aliases_label, work_type_id FROM archive_field
      WHERE archived_at IS NULL AND ${liveFilter('archive_field')} /* deleted_at IS NULL */
        AND (work_type_id IS NULL OR work_type_id = ?)
      ORDER BY sort_order, id`,
    [workTypeId ?? -1],
  );
  const aliasRows = all<{ var_name: string; field_key: string }>(
    `SELECT var_name, field_key FROM archive_alias
      WHERE ${liveFilter('archive_alias')} /* deleted_at IS NULL */
        AND (work_type_id IS NULL OR work_type_id = ?)`,
    [workTypeId ?? -1],
  );
  const known = new Map<string, string[]>();
  for (const a of aliasRows) {
    const list = known.get(a.field_key) ?? [];
    list.push(a.var_name);
    known.set(a.field_key, list);
  }
  return fields.map((f) => {
    let labelAliases: string[] = [];
    if (f.aliases_label) {
      try {
        const parsed = JSON.parse(f.aliases_label) as unknown;
        if (Array.isArray(parsed)) labelAliases = parsed.map((x) => String(x));
      } catch {
        /* 坏 JSON 当没有 */
      }
    }
    // 「建设/采购/委托/发包单位」这种一组称谓再按分隔符拆开，能多救回几个变量名
    const expanded = labelAliases.flatMap((s) => s.split(/[/、,，]/)).map((s) => s.trim()).filter(Boolean);
    return {
      fieldKey: f.field_key,
      label: f.label,
      type: f.type,
      // label 里的「甲方（建设/采购/委托/发包单位）」拆成多个候选称谓
      labelAliases: [...new Set([...labelAliases, ...expanded, ...splitLabel(f.label)])],
      knownVars: known.get(f.field_key) ?? [],
      workTypeId: f.work_type_id,
    };
  });
}

/**
 * 把字段名拆成多个候选称谓："甲方（建设/采购/委托/发包单位）"
 * → ["甲方", "建设/采购/委托/发包单位"]。
 *
 * 用逐字符扫描而不是正则：括号是全角/半角混用的，写成字符组容易被
 * TypeScript 的词法分析器误判（实测 `/[）)]/g` 会让 tsc 直接报 TS1005），
 * 而这段逻辑本来就不需要正则。
 */
const LABEL_OPENERS = '（(';
const LABEL_CLOSERS = '）)';

function splitLabel(label: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of label) {
    if (LABEL_OPENERS.includes(ch)) {
      parts.push(cur);
      cur = '';
      continue;
    }
    if (LABEL_CLOSERS.includes(ch)) continue;
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** 比对用的规范化：去掉括号里的补充说明、空白与各种分隔装饰，再转小写 */
function normalizeName(s: string): string {
  const drop = ' \t　/、·,，.。:：-_—';
  let out = '';
  let depth = 0;
  for (const ch of s) {
    if (LABEL_OPENERS.includes(ch)) {
      depth += 1;
      continue;
    }
    if (LABEL_CLOSERS.includes(ch)) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0 || drop.includes(ch)) continue;
    out += ch.toLowerCase();
  }
  return out;
}

/** 字符二元组集合，做相似度 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

function overlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let hit = 0;
  for (const x of A) if (B.has(x)) hit += 1;
  return hit / Math.max(A.size, B.size);
}

/**
 * 为**一个**未映射变量名挑一个建议别名（纯规则、不调模型、不落库）。
 *
 * 判据从强到弱：字段标识完全一致 → 与字段名/称谓完全一致 → 互相包含 → 字面相似。
 * 分数低于 45 就返回 null（宁可不建议，也不要乱建议 —— 错映射比没映射更难发现）。
 */
export function ruleSuggestAlias(varName: string, candidates: SuggestCandidate[]): AliasSuggestion | null {
  const n = normalizeName(varName);
  if (!n) return null;

  /** 用对象包一层，避免闭包里赋值让 TS 的控制流收窄把类型判成 never */
  const state: { best: { c: SuggestCandidate; score: number; reason: string } | null } = { best: null };
  const consider = (c: SuggestCandidate, score: number, reason: string) => {
    const cur = state.best;
    if (!cur || score > cur.score) state.best = { c, score, reason };
  };

  for (const c of candidates) {
    const key = c.fieldKey.toLowerCase();
    if (varName.toLowerCase() === key) {
      consider(c, 100, `变量名与字段标识「${c.fieldKey}」完全一致`);
      continue;
    }
    const names = [c.label, ...c.labelAliases, ...c.knownVars];
    for (const raw of names) {
      const cand = normalizeName(raw);
      if (!cand) continue;
      if (cand === n) {
        consider(c, 95, `「${varName}」与「${raw}」写法一致（该字段的称谓/已有映射）`);
        break;
      }
      if (cand.length >= 2 && (cand.includes(n) || n.includes(cand))) {
        // 包含关系：长度越接近越可信（「甲方」vs「甲方联系电话」差别大）
        const ratio = Math.min(cand.length, n.length) / Math.max(cand.length, n.length);
        const how = n.includes(cand) ? `「${varName}」里含「${raw}」` : `「${varName}」是「${raw}」的一部分`;
        consider(c, 55 + Math.round(ratio * 25), `${how}（该字段的称谓/已有映射）`);
      } else {
        const ov = overlap(cand, n);
        if (ov >= 0.5) consider(c, 45 + Math.round(ov * 20), `「${varName}」与「${raw}」字形相似度 ${(ov * 100).toFixed(0)}%`);
      }
    }
    // 英文变量名（如 contract_no）：按词片段匹配拉丁字段标识
    if (/^[a-z][a-z0-9_]*$/i.test(varName)) {
      const parts = varName.toLowerCase().split('_').filter((p) => p.length >= 3);
      const keyParts = key.split('_').filter((p) => p.length >= 3);
      if (parts.length && keyParts.length) {
        const shared = parts.filter((p) => keyParts.includes(p)).length;
        if (shared > 0) consider(c, 50 + shared * 10, `变量名与字段标识共有 ${shared} 个词根`);
      }
    }
  }

  const best = state.best;
  if (!best || best.score < 45) return null;
  const confidence: AliasSuggestion['confidence'] = best.score >= 90 ? 'high' : best.score >= 65 ? 'medium' : 'low';
  return {
    varName,
    fieldKey: best.c.fieldKey,
    label: best.c.label,
    source: 'rule',
    confidence,
    reason: best.reason,
  };
}
