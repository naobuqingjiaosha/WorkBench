/**
 * 档案代入体系（D 地基）
 *
 * 解决的问题：同一个项目的信息在各份文书里重复手填。
 * 实测 48 份模板、632 个不同变量名、1089 处引用，其中 113 个变量名（占 18%）
 * 承担了 45% 的引用 —— 这些就是「档案字段」该消灭的重复劳动。
 *
 * 设计要点：
 *   1. 字段集不预设完。只种「系统必备字段」（跨所有工作类型都成立的），
 *      其余由运行中的 AI 读模板后提议、用户确认，逐步长出来。
 *   2. field_key 是契约，一旦有模板变量映射过来就不得改名/删除/改含义。
 *      AI 可以新增字段、提别名，但不能动已有 key 的含义 —— 否则「不编造」无从保证。
 *   3. 档案值存 workbench.profile（JSON 桶），不新增列。
 *
 * 取值优先级（全部是死规则，瞬时、离线、可复现）：
 *   ① 系统变量  _今天 / _年份 / _本月 / _工作台编号 / _当前阶段 …
 *   ② 档案字段  {变量名} → 别名表 → 档案值（本模块）
 *   ③ 已有上下文（工作台 8 个原生字段，兼容旧行为）
 *   ④ 未命中 → 交给用户或 AI 填
 */
import { all, get, run, tx } from '../db/index.ts';
import { clearDeleted, liveFilter, markDeleted, tableHasDeletedAt } from '../core/trash.ts';
import { buildNativeContext, nativeAliasesFor } from './service.ts';

/* ====================== 软删除（回收站）守卫 ====================== */

/**
 * 读 `archive_field` / `archive_alias` / `workbench` 的**在用行**时一律带 `deleted_at IS NULL`。
 *
 * 为什么复用 `liveFilter` 而不是手写条件：老库还没跑迁移 015（没有 `deleted_at` 列）时，
 * 硬写 `deleted_at IS NULL` 会报 `no such column` —— 那是**整个接口 500**，
 * 比"暂时少了软删除过滤"严重得多。`liveFilter('archive_alias')` 在那种库上生成 `1=1`。
 * 下面 SQL 里的 `deleted_at IS NULL` 注释是给人（和守卫检查脚本）看的，
 * **真实条件由 liveFilter 生成**（与 core/coverage.ts 同一约定）。
 *
 * 还有一个坑：`idx_archive_alias_uniq` / `idx_archive_field_key` 两个唯一索引**不认 `deleted_at`**。
 * 所以"在用行里没找到"之后必须再看一眼回收站：有同名/同 key 的那条就把它复活，
 * 否则 INSERT 会撞唯一约束（表现为"加一个刚删过的变量名，报数据库错误"）。
 */
function reviveBuriedRow(
  table: 'archive_alias' | 'archive_field',
  where: string,
  params: (string | number | null)[],
): number | null {
  if (!tableHasDeletedAt(table)) return null; // 老库没有软删除列，也就不存在"回收站里的行"
  // 这一处**故意反着查**：要读的正是回收站里那批（不是 deleted_at IS NULL 那批）
  const buried = get<{ id: number }>(`SELECT id FROM ${table} WHERE ${where} AND deleted_at IS NOT NULL`, params);
  if (!buried) return null;
  clearDeleted(table, buried.id);
  /**
   * `archive_field` 的删除态是 **`deleted_at` + `archived_at` 两列一起**表达的（见 `archiveField()`），
   * 而 `clearDeleted()` 只清 `deleted_at`。所以复活字段时必须自己把 `archived_at` 也清掉：
   * 只清一列的话，这条刚"复活"的字段仍然被按 `archived_at IS NULL` 过滤的老读路径
   * （本文件的 `listArchiveFields` / `getArchiveField`，以及 `core/coverage.ts`）挡在外面 ——
   * 表现为"加一个刚删过的字段，接口报成功、列表里却还是没有它"。
   * `archive_alias` 没有 `archived_at` 列（004 建表时就没有），所以只有字段表需要这一步。
   */
  if (table === 'archive_field') run('UPDATE archive_field SET archived_at = NULL WHERE id = ?', [buried.id]);
  return buried.id;
}

/* ============================== 类型 ============================== */

export type FieldType = 'text' | 'longtext' | 'date' | 'money' | 'number' | 'percent' | 'enum';

export interface ArchiveField {
  id: number;
  work_type_id: number | null;
  field_key: string;
  label: string;
  type: FieldType;
  required: number;
  example: string | null;
  hint: string | null;
  seed: number;
  origin: string;
  aliases_label: string | null;
  sort_order: number;
  archived_at: string | null;
}

export interface ArchiveAlias {
  id: number;
  work_type_id: number | null;
  var_name: string;
  field_key: string;
  confidence: string;
  note: string | null;
}

/* ============================== 系统必备字段 ============================== */
/**
 * 只种「跨所有工作类型都成立」的字段。
 * 依据：这类变量在 48 份模板里高频且语义稳定（如 {项目名称} 出现在 36 份）。
 * 类型专有的字段（监理机构只工程类要、服务方只服务类要）不预设，交给 AI 提议。
 */
const SEED_FIELDS: {
  field_key: string;
  label: string;
  type: FieldType;
  labelAliases: string[];
  varAliases: string[];
  example?: string;
  hint?: string;
}[] = [
  {
    field_key: 'project_name', label: '项目名称', type: 'text',
    labelAliases: ['项目名称', '工程名称', '工作台名称'],
    varAliases: ['项目名称', '工程名称', '工作台名称'],
    example: '数据中心机房建设项目', hint: '项目全称，出现在文书标题与正文',
  },
  {
    field_key: 'project_short', label: '项目简称', type: 'text',
    labelAliases: ['项目简称', '工程简称'],
    varAliases: ['项目简称', '工程简称'],
    example: '机房项目', hint: '用于标题和表格窄栏',
  },
  {
    field_key: 'project_no', label: '项目编号', type: 'text',
    labelAliases: ['项目编号', '工作台编号'],
    varAliases: ['项目编号', '工作台编号'],
  },
  {
    field_key: 'contract_name', label: '合同名称', type: 'text',
    labelAliases: ['合同名称'],
    varAliases: ['合同名称'],
    example: '设备采购合同',
  },
  {
    field_key: 'contract_no', label: '合同编号', type: 'text',
    labelAliases: ['合同编号', '合同登记编号'],
    varAliases: ['合同编号', '合同登记编号'],
  },
  {
    field_key: 'party_a_name', label: '甲方（建设/采购/委托/发包单位）', type: 'text',
    labelAliases: ['建设单位', '发包人', '采购单位', '委托方', '甲方名称', '招标人'],
    varAliases: ['甲方名称', '建设单位', '采购单位', '委托方', '发包人', '甲方单位', '招标人', '单位名称'],
    example: '山西万家寨数字科技有限公司',
    hint: '本单位或委托方。填这一个，界面上的「发包人」「采购单位」「委托方」等称谓都通',
  },
  {
    field_key: 'party_b_name', label: '乙方（承包/供应/服务单位）', type: 'text',
    labelAliases: ['承包单位', '供应单位', '服务方', '乙方名称', '承包方'],
    varAliases: ['乙方名称', '承包单位', '供应单位', '服务方', '承建单位', '承包人', '承包方'],
    hint: '对方单位。填这一个，界面上的「承包单位」「供应单位」「服务方」等称谓都通',
  },
  {
    field_key: 'party_b_short', label: '乙方简称', type: 'text',
    labelAliases: ['承包单位简称', '乙方简称'],
    varAliases: ['承包单位简称', '乙方简称', '供应单位简称'],
  },
  {
    field_key: 'sign_date', label: '签订日期', type: 'date',
    labelAliases: ['签订日期', '签署日期', '签订时间'],
    varAliases: ['签订日期', '签署日期', '签订时间'],
    hint: '中文写法，如 2026年9月16日',
  },
  {
    field_key: 'start_date', label: '开工日期', type: 'date',
    labelAliases: ['开工日期', '开工时间'],
    varAliases: ['开工日期', '开工时间'],
  },
  {
    field_key: 'sign_place', label: '签订地点', type: 'text',
    labelAliases: ['签订地点', '签字地点', '签订地址'],
    varAliases: ['签订地点', '签字地点', '签订地址'],
    example: '山西省太原市',
  },
  {
    field_key: 'contract_amount', label: '合同金额（小写）', type: 'money',
    labelAliases: ['合同金额', '合同交易额', '价款'],
    varAliases: ['合同金额小写', '合同交易额', '技术交易额', '价款小写'],
    example: '1250000.00', hint: '含税总价，与合同正文一致',
  },
  {
    field_key: 'project_manager', label: '项目经理 / 项目负责人', type: 'text',
    labelAliases: ['项目经理', '项目负责人'],
    varAliases: ['项目经理', '项目负责人'],
  },
  {
    field_key: 'handler', label: '经办人 / 承办人', type: 'text',
    labelAliases: ['经办人', '承办人', '编制人', '填报人'],
    varAliases: ['经办人', '承办人'],
    hint: '文书落款处的经办人；未填时回退到工作台负责人',
  },
  {
    field_key: 'dept', label: '承办部门', type: 'text',
    labelAliases: ['承办部门', '汇报部门', '所属部门'],
    varAliases: ['承办部门', '汇报部门', '所属部门'],
  },
  {
    field_key: 'party_a_contact', label: '甲方联系人', type: 'text',
    labelAliases: ['甲方联系人', '甲方项目联系人'],
    varAliases: ['甲方联系人', '甲方项目联系人'],
  },
  {
    field_key: 'party_a_phone', label: '甲方联系电话', type: 'text',
    labelAliases: ['甲方联系电话', '甲方电话'],
    varAliases: ['甲方联系电话', '甲方电话'],
  },
  {
    field_key: 'party_a_addr', label: '甲方地址', type: 'text',
    labelAliases: ['甲方地址', '甲方住所'],
    varAliases: ['甲方地址', '甲方住所'],
  },
  {
    field_key: 'party_b_contact', label: '乙方联系人', type: 'text',
    labelAliases: ['乙方联系人', '乙方项目联系人'],
    varAliases: ['乙方联系人', '乙方项目联系人'],
  },
  {
    field_key: 'party_b_phone', label: '乙方联系电话', type: 'text',
    labelAliases: ['乙方联系电话', '乙方电话'],
    varAliases: ['乙方联系电话', '乙方电话'],
  },
  {
    field_key: 'party_b_addr', label: '乙方地址', type: 'text',
    labelAliases: ['乙方地址', '乙方住所'],
    varAliases: ['乙方地址', '乙方住所'],
  },
  {
    field_key: 'party_a_bank', label: '甲方开户银行', type: 'text',
    labelAliases: ['甲方开户银行', '甲方开户行'],
    varAliases: ['甲方开户银行', '甲方开户行'],
  },
  {
    field_key: 'party_a_account', label: '甲方账号', type: 'text',
    labelAliases: ['甲方账号', '甲方银行账号'],
    varAliases: ['甲方账号', '甲方银行账号'],
  },
  {
    field_key: 'party_b_bank', label: '乙方开户银行', type: 'text',
    labelAliases: ['乙方开户银行', '乙方开户行'],
    varAliases: ['乙方开户银行', '乙方开户行'],
  },
  {
    field_key: 'party_b_account', label: '乙方账号', type: 'text',
    labelAliases: ['乙方账号', '乙方银行账号'],
    varAliases: ['乙方账号', '乙方银行账号'],
  },
  {
    field_key: 'party_a_credit_code', label: '甲方统一社会信用代码', type: 'text',
    labelAliases: ['甲方统一社会信用代码'],
    varAliases: ['甲方统一社会信用代码'],
  },
  {
    field_key: 'party_b_credit_code', label: '乙方统一社会信用代码', type: 'text',
    labelAliases: ['乙方统一社会信用代码'],
    varAliases: ['乙方统一社会信用代码'],
  },
];

/**
 * 系统变量的别名映射。
 *
 * 这些变量的值是系统自动算出来的（今天、本月、年份…），不来自档案也不来自用户。
 * 放进别名表的好处：解析链不用为它们写特例，而且用户能在界面上看到
 * 「{年份} 是系统自动填的，不用管」。
 *
 * field_key 直接指向 buildNativeContext 注入的键（以 _ 开头）。
 */
const SEED_SYSTEM_ALIASES: { var_name: string; field_key: string; note: string }[] = [
  { var_name: '年份', field_key: '_年份', note: '系统自动：当前年份 4 位数' },

  { var_name: '申报年份', field_key: '_年份', note: '系统自动：当前年份' },
  { var_name: '月份', field_key: '_本月', note: '系统自动：本月，如 2026年9月' },
  { var_name: '月份中文', field_key: '_本月', note: '系统自动：本月' },
  { var_name: '检查月份', field_key: '_本月', note: '系统自动：本月' },
  { var_name: '所属月份', field_key: '_本月', note: '系统自动：本月' },
  { var_name: '日期', field_key: '_今天中文', note: '系统自动：今天（中文写法）' },
  { var_name: '填表日期', field_key: '_今天中文', note: '系统自动：今天' },
  { var_name: '编制日期', field_key: '_今天中文', note: '系统自动：今天' },
  { var_name: '报告日期', field_key: '_今天中文', note: '系统自动：今天' },
  { var_name: '汇报日期', field_key: '_今天中文', note: '系统自动：今天' },
  { var_name: '当前阶段', field_key: '_当前阶段', note: '系统自动：当前所处阶段名称' },
  { var_name: '阶段名称', field_key: '_当前阶段', note: '系统自动：当前阶段名称' },
];

/**
 * 需要从种子映射里撤掉的变量名。
 *
 * 早期版本把语义不同的东西合成了一个字段（如「甲方联系人 / 电话」一个字段
 * 同时接 {甲方联系人} 和 {甲方联系电话}），结果是抽到一个合并值填进两个框，
 * 或者把电话的值填进联系人的框。这里撤掉那些错误映射，让它们改归各自独立的字段。
 *
 * 只撤 confidence='seed' 的 —— 用户手工改过的不动。
 */
const RETIRED_SEED_VARS = [
  '编制人', '填报人', '检查人', '审核人', '签订年份',
  '甲方联系电话', '甲方联系人', '甲方项目联系人',
  '乙方联系电话', '乙方联系人',
  '甲方账号', '乙方账号',
];

/**
 * 早期版本的字段名（那时一个字段囊括了多个语义）。
 * 种子逻辑发现字段名还是这个值时，说明用户没改过，可以安全地改成新的；
 * 如果已经被改成别的，说明用户自己调过，不动。
 */
const LEGACY_LABELS: Record<string, string> = {
  party_a_contact: '甲方联系人 / 电话',
  party_a_bank: '甲方开户银行 / 账号',
  party_b_contact: '乙方联系人 / 电话',
  party_b_bank: '乙方开户银行 / 账号',
};

/** 幂等种入系统必备字段（不覆盖用户改过的内容） */
export function seedArchiveFields(): { fields: number; aliases: number } {
  let fields = 0;
  let aliases = 0;
  tx(() => {
    // 撤掉历史上归错的种子映射（回收站里的那条不动：它在回收站里就不该再影响解析）
    for (const v of RETIRED_SEED_VARS) {
      run(
        `DELETE FROM archive_alias WHERE work_type_id IS NULL AND var_name = ? AND confidence = 'seed'
           AND field_key != ? AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */`,
        [v, SEED_FIELDS.find(f => f.varAliases.includes(v))?.field_key ?? ''],
      );
    }
    // 修正早期「一个字段囊括多个语义」时的旧字段名（仅当用户没改过）
    for (const [key, legacyLabel] of Object.entries(LEGACY_LABELS)) {
      const cur = get<{ id: number; label: string; seed: number }>(
        `SELECT id, label, seed FROM archive_field WHERE work_type_id IS NULL AND field_key = ? AND archived_at IS NULL
           AND ${liveFilter('archive_field')} /* deleted_at IS NULL */`,
        [key],
      );
      if (!cur || !cur.seed || cur.label !== legacyLabel) continue;
      const want = SEED_FIELDS.find((s) => s.field_key === key);
      if (want) {
        run(`UPDATE archive_field SET label = ?, aliases_label = ? WHERE id = ?`, [
          want.label,
          JSON.stringify(want.labelAliases),
          cur.id,
        ]);
      }
    }
    for (const f of SEED_FIELDS) {
      const existed = get<{ id: number }>(
        `SELECT id FROM archive_field WHERE work_type_id IS NULL AND field_key = ?
           AND ${liveFilter('archive_field')} /* deleted_at IS NULL */`,
        [f.field_key],
      );
      // 回收站里可能有同 key 的字段（唯一索引不认 deleted_at）：复活它，而不是插一条会撞唯一约束的新行
      const fieldId = existed?.id ?? reviveBuriedRow('archive_field', 'work_type_id IS NULL AND field_key = ?', [f.field_key]);
      if (!fieldId) {
        run(
          `INSERT INTO archive_field (work_type_id, field_key, label, type, required, example, hint, seed, origin, aliases_label, sort_order)
           VALUES (NULL, ?, ?, ?, 0, ?, ?, 1, 'seed', ?, ?)`,
          [f.field_key, f.label, f.type, f.example ?? null, f.hint ?? null, JSON.stringify(f.labelAliases), fields * 10 + 10],
        );
        fields += 1;
      }
      for (const v of f.varAliases) {
        const has = get<{ id: number }>(
          `SELECT id FROM archive_alias WHERE work_type_id IS NULL AND var_name = ?
             AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */`,
          [v],
        );
        const aliasId = has?.id ?? reviveBuriedRow('archive_alias', 'work_type_id IS NULL AND var_name = ?', [v]);
        if (!aliasId) {
          run(
            `INSERT INTO archive_alias (work_type_id, var_name, field_key, confidence, note)
             VALUES (NULL, ?, ?, 'seed', '系统必备字段自带映射')`,
            [v, f.field_key],
          );
          aliases += 1;
        }
      }
    }
    // 系统变量别名（不属于任何档案字段，直接指向系统注入的键）
    for (const s of SEED_SYSTEM_ALIASES) {
      const has = get<{ id: number }>(
        `SELECT id FROM archive_alias WHERE work_type_id IS NULL AND var_name = ?
           AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */`,
        [s.var_name],
      );
      const aliasId = has?.id ?? reviveBuriedRow('archive_alias', 'work_type_id IS NULL AND var_name = ?', [s.var_name]);
      if (!aliasId) {
        run(
          `INSERT INTO archive_alias (work_type_id, var_name, field_key, confidence, note)
           VALUES (NULL, ?, ?, 'seed', ?)`,
          [s.var_name, s.field_key, s.note],
        );
        aliases += 1;
      }
    }
  });
  return { fields, aliases };
}

/* ============================== 字段与别名读写 ============================== */

export function listArchiveFields(workTypeId?: number | null): ArchiveField[] {
  // 通用字段 + 该类型专有字段（回收站里的那条不再参与）
  return all<ArchiveField>(
    `SELECT * FROM archive_field
      WHERE archived_at IS NULL
        AND ${liveFilter('archive_field')} /* deleted_at IS NULL */
        AND (work_type_id IS NULL OR work_type_id = ?)
      ORDER BY sort_order, id`,
    [workTypeId ?? -1],
  );
}

export function getArchiveField(fieldKey: string, workTypeId?: number | null): ArchiveField | undefined {
  return get<ArchiveField>(
    `SELECT * FROM archive_field
      WHERE field_key = ? AND archived_at IS NULL
        AND ${liveFilter('archive_field')} /* deleted_at IS NULL */
        AND (work_type_id IS NULL OR work_type_id = ?)
      ORDER BY work_type_id IS NULL DESC
      LIMIT 1`,
    [fieldKey, workTypeId ?? -1],
  );
}

export function upsertArchiveField(input: {
  id?: number;
  workTypeId?: number | null;
  fieldKey: string;
  label?: string;
  type?: FieldType;
  required?: boolean;
  example?: string;
  hint?: string;
  origin?: string;
  aliasesLabel?: string[];
  sortOrder?: number;
}): number {
  if (input.id) {
    run(
      `UPDATE archive_field SET label = COALESCE(?, label), type = COALESCE(?, type),
         required = COALESCE(?, required), example = COALESCE(?, example), hint = COALESCE(?, hint),
         aliases_label = COALESCE(?, aliases_label), sort_order = COALESCE(?, sort_order),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      [
        input.label ?? null, input.type ?? null,
        input.required === undefined ? null : input.required ? 1 : 0,
        input.example ?? null, input.hint ?? null,
        input.aliasesLabel ? JSON.stringify(input.aliasesLabel) : null,
        input.sortOrder ?? null, input.id,
      ],
    );
    return input.id;
  }
  const existed = get<{ id: number }>(
    `SELECT id FROM archive_field WHERE COALESCE(work_type_id,0) = COALESCE(?,0) AND field_key = ?
       AND ${liveFilter('archive_field')} /* deleted_at IS NULL */`,
    [input.workTypeId ?? null, input.fieldKey],
  );
  if (existed) return upsertArchiveField({ ...input, id: existed.id });
  // 回收站里可能有同 key 的字段（唯一索引不认 deleted_at）：复活它，避免 INSERT 撞唯一约束
  const buried = reviveBuriedRow(
    'archive_field',
    'COALESCE(work_type_id,0) = COALESCE(?,0) AND field_key = ?',
    [input.workTypeId ?? null, input.fieldKey],
  );
  if (buried) return upsertArchiveField({ ...input, id: buried });
  const r = run(
    `INSERT INTO archive_field (work_type_id, field_key, label, type, required, example, hint, seed, origin, aliases_label, sort_order)
     VALUES (?,?,?,?,?,?,?,0,?,?,?)`,
    [
      input.workTypeId ?? null, input.fieldKey, input.label ?? input.fieldKey,
      input.type ?? 'text', input.required ? 1 : 0, input.example ?? null, input.hint ?? null,
      input.origin ?? 'user', input.aliasesLabel ? JSON.stringify(input.aliasesLabel) : null,
      input.sortOrder ?? 100,
    ],
  );
  return r.lastInsertRowid;
}

/**
 * 删除一个档案字段 = **移入回收站**。系统必备字段不允许删，避免把地基拆了。回收站里的那条不在这里动。
 *
 * 【为什么 `deleted_at` 与 `archived_at` 必须**两列一起写**】
 *   · `archive_field` 建表（`004_archive.sql`）时只有 `archived_at`，它当时承担的就是"这条字段
 *     不用了"的**删除**语义 —— 全项目没有任何"归档但仍可用"的读法：所有读路径都是
 *     `archived_at IS NULL`（`listArchiveFields` / `getArchiveField` / `core/coverage.ts` /
 *     `domain/agent.ts` / `routes-archive.ts`），唯一的写入点就是本函数，所以对**字段表**而言
 *     `archived_at` 是删除标记、不是"归档"。（`workbench` / `template` 的 `archived_at` 才是
 *     "收起来但仍可查"的归档，两者不可套用。）
 *   · 迁移 `015_trash.sql` 给这张表补了通用的 `deleted_at`，注释里写明"删除时会**两列一起写**，
 *     于是旧代码按 `archived_at` 过滤照样看得懂，回收站也能列出/恢复它"；
 *     `core/trash.ts` 恢复字段时也是两列一起清。只写 `archived_at`（本函数改前的行为）的后果是：
 *     字段从界面上消失了，却**既不进回收站、也恢复不了** ——
 *     回收站列表只认 `deleted_at IS NOT NULL`，`restoreFromTrash('field',…)` 与
 *     `purgeFromTrash('field',…)` 都要求 `deleted_at` 非空，于是"删掉的字段只能靠手工改库找回来"。
 *
 * 缺迁移 015 的老库上 `markDeleted()` 会明确抛错（沿用 `domain/agent.ts` 的同一约定），
 * 而不是留下一条既看不见、又恢复不了的半截记录。
 */
export function archiveField(id: number): { archived: boolean; refused?: string } {
  const f = get<ArchiveField>(
    `SELECT * FROM archive_field WHERE id = ? AND ${liveFilter('archive_field')} /* deleted_at IS NULL */`,
    [id],
  );
  if (!f) return { archived: false, refused: '字段不存在（或已在回收站里）' };
  if (f.seed) return { archived: false, refused: '系统必备字段不可删除，可以改名或改类型' };
  tx(() => {
    // 「进回收站」在本仓库只有这一个出口：它写 `deleted_at`，缺迁移 015 时会抛错而不是静默硬删
    markDeleted('archive_field', 'id = ?', [id]);
    // 旧读路径按 `archived_at` 过滤，这一列必须跟着写（口径见上面的说明与迁移 015 的注释）
    run(`UPDATE archive_field SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [id]);
  });
  return { archived: true };
}

export function listArchiveAliases(workTypeId?: number | null): ArchiveAlias[] {
  return all<ArchiveAlias>(
    `SELECT * FROM archive_alias
      WHERE (work_type_id IS NULL OR work_type_id = ?)
        AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */
      ORDER BY var_name`,
    [workTypeId ?? -1],
  );
}

export function upsertArchiveAlias(input: {
  id?: number;
  workTypeId?: number | null;
  varName: string;
  fieldKey: string;
  confidence?: string;
  note?: string;
}): number {
  if (input.id) {
    run(
      `UPDATE archive_alias SET var_name = ?, field_key = ?, confidence = COALESCE(?, confidence),
         note = COALESCE(?, note), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      [input.varName, input.fieldKey, input.confidence ?? null, input.note ?? null, input.id],
    );
    return input.id;
  }
  const existed = get<{ id: number }>(
    `SELECT id FROM archive_alias WHERE COALESCE(work_type_id,0) = COALESCE(?,0) AND var_name = ?
       AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */`,
    [input.workTypeId ?? null, input.varName],
  );
  if (existed) return upsertArchiveAlias({ ...input, id: existed.id });
  // 回收站里可能有同名别名（唯一索引不认 deleted_at）：复活它，避免 INSERT 撞唯一约束
  const buried = reviveBuriedRow(
    'archive_alias',
    'COALESCE(work_type_id,0) = COALESCE(?,0) AND var_name = ?',
    [input.workTypeId ?? null, input.varName],
  );
  if (buried) return upsertArchiveAlias({ ...input, id: buried });
  const r = run(
    `INSERT INTO archive_alias (work_type_id, var_name, field_key, confidence, note) VALUES (?,?,?,?,?)`,
    [input.workTypeId ?? null, input.varName, input.fieldKey, input.confidence ?? 'manual', input.note ?? null],
  );
  return r.lastInsertRowid;
}

/** 删除一条别名。**只删在用（未进回收站）的那条**：回收站里的记录不该被这里顺手清掉 */
export function deleteArchiveAlias(id: number): void {
  run(`DELETE FROM archive_alias WHERE id = ? AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */`, [id]);
}

/* ============================== 档案值 ============================== */

/**
 * 读工作台档案值（workbench.profile 的 JSON 桶）。
 *
 * **只收标量**：这个桶里除档案值之外，还放着系统的保留键（如 `templateIds` 是数组）。
 * 以前这里把所有值都 `String()` 化，而 writeArchiveValues 又把整份 map 写回去 ——
 * 结果就是用户在「项目信息」里随手保存一个字段，`templateIds: [103]` 被压成 `"103"`，
 * 出文书页的模板绑定**静默失效**、悄悄回退成"这个类型的全部模板"。
 * 数组/对象不是档案值，这里直接跳过，交给各自的专用读写函数处理。
 */
export function readArchiveValues(workbenchId: number): Record<string, string> {
  // 回收站里的工作台不再贡献档案值（否则"删掉的工作台"还会往文书里塞旧数据）
  if (!workbenchIsLive(workbenchId)) return {};
  const raw = readRawProfile(workbenchId);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    if (String(v).trim() === '') continue;
    if(k==='templateIds')continue;
    out[k] = String(v);
  }
  const canonical = get<Record<string, unknown>>(
    `SELECT contract_no,contract_amount,start_date FROM workbench WHERE id = ?
       AND ${liveFilter('workbench')} /* deleted_at IS NULL */`,
    [workbenchId],
  );
  if(canonical)for(const [k,v] of Object.entries(canonical))if(v!==null && v!==undefined)out[k]=String(v);
  return out;
}

/** 工作台是否还在用（不在回收站里）。老库没有软删除列时一律当作在用 */
function workbenchIsLive(workbenchId: number): boolean {
  return Boolean(
    get<{ id: number }>(
      `SELECT id FROM workbench WHERE id = ? AND ${liveFilter('workbench')} /* deleted_at IS NULL */`,
      [workbenchId],
    ),
  );
}

/**
 * 原始 profile 桶（不过滤、不转字符串），保留键专用。
 *
 * 这一处**故意不按** `deleted_at IS NULL` 过滤：本函数是「读-改-写」的低层原语，
 * `writeArchiveValues` 靠它拿到整份 profile 再合并。一旦在这里过滤掉，
 * 回收站里的工作台被写一次就会把整桶档案值覆盖没（读回 `{}` → 只写回 patch 那几个键）。
 * 「在用的工作台才给值」这条规则由 `readArchiveValues` 负责。
 */
export function readRawProfile(workbenchId: number): Record<string, unknown> {
  const row = get<{ profile: string | null }>(
    // 这一处**故意不按** `deleted_at IS NULL` 过滤（读-改-写原语，理由见上面的函数注释）；
    // 「在用的工作台才给值」由 readArchiveValues 负责
    'SELECT profile FROM workbench WHERE id = ?',
    [workbenchId],
  );
  if (!row?.profile) return {};
  try {
    const parsed = JSON.parse(row.profile) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 写档案值：在**原始 profile 上做合并**，只动 patch 里提到的键。
 * 不能在 readArchiveValues 的结果上合并 —— 那会把保留键（数组）丢掉或压成字符串。
 *
 * 回收站里的工作台**明确拒绝写入**（而不是写进去再看不见）：回收站的语义是"冻结"，
 * 顺手改它会让"恢复回来还是原样"这条承诺失效。
 */
export function writeArchiveValues(workbenchId: number, patch: Record<string, unknown>): Record<string, string> {
  return tx(()=>{
  if (!workbenchIsLive(workbenchId)) throw new Error('这个工作台已在回收站里，不能修改项目信息；请先从回收站恢复它');
  const raw = readRawProfile(workbenchId);
  const permitted = new Set(all<{ field_key: string }>(
    `SELECT field_key FROM archive_field WHERE ${liveFilter('archive_field')} /* deleted_at IS NULL */`,
  ).map(f=>f.field_key));
  for (const [k, v] of Object.entries(patch)) {
    if (!permitted.has(k) || k === 'templateIds') throw new Error(`不能写入未定义或系统保留字段：${k}`);
    if (v !== null && v !== undefined && typeof v === 'object') throw new Error(`档案字段必须是标量：${k}`);
    if(['contract_no','contract_amount','start_date'].includes(k)) {
      let value:string|number|null=v==null || String(v).trim()==='' ? null : String(v).trim();
      if(k==='contract_amount' && value!==null){value=Number(String(value).replace(/[,，]/g,''));if(!Number.isFinite(value)||value<0)throw new Error('合同金额必须是非负数字');}
      if(k==='start_date' && value!==null){const m=String(value).match(/^(\d{4})(?:-|年)(\d{1,2})(?:-|月)(\d{1,2})日?$/);if(!m)throw new Error('开工日期请填写 YYYY-MM-DD 或中文年月日');value=m[1]+'-'+m[2]!.padStart(2,'0')+'-'+m[3]!.padStart(2,'0');if(new Date(value+'T00:00:00').getDate()!==Number(m[3]))throw new Error('日期不存在');}
      run('UPDATE workbench SET '+k+'=? WHERE id=?',[value,workbenchId]);delete raw[k];continue;
    }
    if (v === null || v === undefined || String(v).trim() === '') delete raw[k];
    else raw[k] = String(v);
  }
  run(
    `UPDATE workbench SET profile = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [Object.keys(raw).length ? JSON.stringify(raw) : null, workbenchId],
  );
  return readArchiveValues(workbenchId);
  });
}

/* ============================== 解析链 ============================== */

export interface ResolvedVar {
  name: string;
  value: string;
  /**
   * 解析状态：
   *   item         循环当前项带了这个字段（`{#循环 集合}` 里 `{字段}` 的第一来源）
   *   system       系统自动（_今天 / _年份 …）
   *   archive      档案字段命中且有值
   *   native       工作台原生字段命中且有值
   *   mapped-empty 已映射到档案字段，但档案里这个字段没填 ← 应提示「去补档案」
   *   unmapped     没有任何映射 ← 只能手工填或让 AI 写
   */
  from: 'item' | 'system' | 'archive' | 'native' | 'mapped-empty' | 'unmapped';
  /** from=archive / mapped-empty 时，命中哪个档案字段 */
  fieldKey?: string;
  /** 命中的路径说明，给人看 */
  via?: string;
}

/**
 * 解析一个变量名 → 值。
 *
 * 优先级（用户显式维护的档案优先于兼容层）：
 *   ⓪ 循环当前项   显式传入的 item（只用于循环体内的字段，见 template.ts 的 ReplaceContext）
 *   ① 系统变量     _今天 / _年份 / _本月 / _工作台编号 …
 *   ② 档案字段     别名表命中 → 档案值（最贴近用户意图）
 *   ③ 工作台原生字段  旧表的 counterpart / contract_no 等，兼容用
 *   ④ 未命中        交给用户或 AI 填
 *
 * `item` 是**显式传入的参数**，不是全局状态：循环体内「当前项」的字段名可能与
 * 档案字段同名（例如项里的「数量」和档案里的「数量」），谁的语义优先必须一眼能从调用处看出来。
 * 不传 item 时行为与改造前逐字相同。
 *
 * 纯函数式，不调模型，结果稳定可复现。
 */
export function resolveVariable(
  name: string,
  ctx: {
    workTypeId?: number | null;
    archive: Record<string, string>;
    native: Record<string, unknown>;
  },
  item?: Record<string, unknown> | null,
): ResolvedVar {
  // ⓪ 循环当前项：项里明确给了这个字段就用它
  if (item && Object.prototype.hasOwnProperty.call(item, name) && isFilled(item[name])) {
    return { name, value: String(item[name]), from: 'item', via: '循环当前项' };
  }
  /**
   * 从工作台字段里取值：先取同名，再取同义词。
   *
   * 模板里的「检查人」和工作台的「负责人」是同一个东西，靠同义词表接上。
   * 这一步不能省 —— 档案别名指向的字段为空时全靠它兜底，
   * 否则「档案里有这一项但还没填」会把已经填好的负责人挡住。
   */
  let nativeKey = '';
  let nativeRaw: unknown;
  if (isFilled(ctx.native?.[name])) {
    nativeKey = name;
    nativeRaw = ctx.native?.[name];
  } else {
    for (const alt of nativeAliasesFor(name)) {
      if (isFilled(ctx.native?.[alt])) {
        nativeKey = alt;
        nativeRaw = ctx.native?.[alt];
        break;
      }
    }
  }
  const nativeVal = nativeRaw;
  const hasNative = nativeKey !== '';
  const nativeVia = nativeKey && nativeKey !== name ? `工作台字段 · ${nativeKey}` : '工作台字段';

  // ① 系统变量：以 _ 开头，或系统注入的固定键
  if (name.startsWith('_') && hasNative) {
    return { name, value: String(nativeVal), from: 'system', via: '系统自动' };
  }

  // ② 档案字段：先查该工作类型专有别名的映射，再查全局。
  //    两条都必须排除回收站里的别名：**软删除的别名不能继续参与解析**，
  //    否则"用户删掉的映射"出文书时还在生效（删了还活着）。
  const alias =
    get<ArchiveAlias>(
      `SELECT * FROM archive_alias
        WHERE var_name = ? AND work_type_id = ?
          AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */
        LIMIT 1`,
      [name, ctx.workTypeId ?? -1],
    ) ??
    get<ArchiveAlias>(
      `SELECT * FROM archive_alias
        WHERE var_name = ? AND work_type_id IS NULL
          AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */
        LIMIT 1`,
      [name],
    );

  if (alias) {
    // field_key 以 _ 开头 = 指向系统注入的变量（_年份 / _今天中文 / _本月 …），
    // 这些值不在档案里，只在原生上下文里
    if (alias.field_key.startsWith('_')) {
      const sys = ctx.native?.[alias.field_key];
      if (sys !== undefined && sys !== null && String(sys).trim() !== '') {
        return { name, value: String(sys), from: 'system', fieldKey: alias.field_key, via: `系统自动 · ${alias.field_key}` };
      }
      return { name, value: '', from: 'unmapped', fieldKey: alias.field_key, via: `系统变量 ${alias.field_key} 取值失败` };
    }
    const v = ctx.archive[alias.field_key];
    if (v !== undefined && v.trim() !== '') {
      return { name, value: v, from: 'archive', fieldKey: alias.field_key, via: `档案 · ${alias.field_key}` };
    }
    // 映射在、档案没填 → 回退到原生字段（兼容旧数据），否则标记为「已映射但档案未填」
    if (hasNative) {
      return { name, value: String(nativeVal), from: 'native', fieldKey: alias.field_key, via: `${nativeVia}（档案未填）` };
    }
    return { name, value: '', from: 'mapped-empty', fieldKey: alias.field_key, via: `档案 · ${alias.field_key}（未填）` };
  }

  // ③ 档案里正好用了同名的键
  const direct = ctx.archive[name];
  if (direct !== undefined && direct.trim() !== '') {
    return { name, value: direct, from: 'archive', fieldKey: name, via: `档案键 ${name}` };
  }

  // ④ 工作台原生字段（旧表列 + 档案 JSON 里的同名键）
  if (hasNative) {
    return { name, value: String(nativeVal), from: 'native', via: nativeVia };
  }

  return { name, value: '', from: 'unmapped' };
}

/** 有值才算数：空串、null、undefined 都当没值，避免把空值当成「已填」 */
function isFilled(v: unknown): boolean {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

/**
 * 给循环的**当前项**补字段（档案代入体系对循环的延伸）。
 *
 * 场景：`{#循环 材料清单}{序号}{名称}{单位}{数量}{/循环}` 里的项来自 AI 或手填，
 * 往往只给了「名称/数量」；「单位」这类字段其实档案里就有（或工作台字段里有同义词）。
 * 于是按循环体里用到的字段名逐个解析：项里有就用项里的，没有就走
 * resolveVariable 的档案/工作台链路，仍然没有就留着占位符让人工补。
 *
 * item 依旧是**显式参数**：调用处（domain/generate.ts）自己决定上下文从哪来。
 */
export function resolveLoopItem(
  fieldNames: string[],
  item: unknown,
  ctx: { workTypeId?: number | null; archive: Record<string, string>; native: Record<string, unknown> },
): { item: unknown; filled: { name: string; from: ResolvedVar['from']; via?: string }[] } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { item, filled: [] };
  const base: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  const filled: { name: string; from: ResolvedVar['from']; via?: string }[] = [];
  for (const name of fieldNames) {
    if (isFilled(base[name])) continue;
    const r = resolveVariable(name, ctx, base);
    if (r.value === '') continue;
    base[name] = r.value;
    filled.push({ name, from: r.from, via: r.via });
  }
  return { item: base, filled };
}

/**
 * 批量解析一份模板需要的全部变量。
 * 返回每个变量的取值与来源，供界面展示「哪些自动带出、哪些要手填」。
 */
export function resolveTemplateVars(
  varNames: string[],
  workbenchId: number | null,
  workTypeId: number | null,
  positionCode?: string | null,
  nativeOverrides: Record<string, unknown> = {},
): { resolved: ResolvedVar[]; autoCount: number; todoCount: number } {
  const native = {...buildNativeContext(workbenchId, positionCode),...nativeOverrides};
  const archive = workbenchId ? readArchiveValues(workbenchId) : {};
  const resolved = varNames.map((n) => resolveVariable(n, { workTypeId, archive, native }));
  const autoCount = resolved.filter((r) => r.value !== '').length;
  return { resolved, autoCount, todoCount: resolved.length - autoCount };
}

/**
 * 把档案值按模板变量名铺进上下文。
 *
 * 生成链路调用它，于是模板里的 {甲方名称} 能从档案的 party_a_name 取到值，
 * 而调用方不需要知道别名映射的存在。
 *
 * 只填「还没有值」的键 —— 调用方显式给的值优先，不被档案覆盖。
 */
export function buildArchiveContext(
  varNames: string[],
  workbenchId: number | null,
  workTypeId: number | null,
  positionCode?: string | null,
  existing: Record<string, unknown> = {},
  nativeOverrides: Record<string, unknown> = {},
): { context: Record<string, unknown>; resolved: ResolvedVar[] } {
  const { resolved } = resolveTemplateVars(varNames, workbenchId, workTypeId, positionCode,nativeOverrides);
  const context: Record<string, unknown> = { ...existing };
  for (const r of resolved) {
    if (r.value === '') continue;
    const cur = context[r.name];
    if (cur !== undefined && cur !== null && String(cur).trim() !== '') continue;
    context[r.name] = r.value;
  }
  return { context, resolved };
}

/** 档案完整度：必填字段填了几成，用于界面提示与缺项分析 */
export function archiveCompleteness(
  workbenchId: number,
  workTypeId: number,
): { total: number; filled: number; missingRequired: { field_key: string; label: string }[] } {
  const fields = listArchiveFields(workTypeId);
  const values = readArchiveValues(workbenchId);
  const missingRequired = fields
    .filter((f) => f.required && !values[f.field_key])
    .map((f) => ({ field_key: f.field_key, label: f.label }));
  return {
    total: fields.length,
    filled: fields.filter((f) => values[f.field_key]).length,
    missingRequired,
  };
}

/* ============================== AI 提议（待确认） ============================== */

export interface ProposalInput {
  workbenchId?: number | null;
  workTypeId?: number | null;
  kind: 'field' | 'alias' | 'value';
  payload: unknown;
  source?: string;
  reason?: string;
  batchId?: string;
}

export function createProposals(items: ProposalInput[]): number {
  let n = 0;
  tx(() => {
    for (const p of items) {
      run(
        `INSERT INTO archive_proposal (workbench_id, work_type_id, kind, payload, source, reason, batch_id)
         VALUES (?,?,?,?,?,?,?)`,
        [
          p.workbenchId ?? null, p.workTypeId ?? null, p.kind,
          JSON.stringify(p.payload), p.source ?? null, p.reason ?? null, p.batchId ?? null,
        ],
      );
      n += 1;
    }
  });
  return n;
}

export function listProposals(opts: { workTypeId?: number | null; status?: string; batchId?: string } = {}) {
  const cond: string[] = [];
  const params: (string | number | null)[] = [];
  if (opts.workTypeId !== undefined && opts.workTypeId !== null) { cond.push('work_type_id = ?'); params.push(opts.workTypeId); }
  if (opts.status) { cond.push('status = ?'); params.push(opts.status); }
  if (opts.batchId) { cond.push('batch_id = ?'); params.push(opts.batchId); }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return all<{
    id: number; workbench_id: number | null; work_type_id: number | null; kind: string;
    payload: string; source: string | null; reason: string | null; status: string;
    batch_id: string | null; created_at: string;
  }>(`SELECT * FROM archive_proposal ${where} ORDER BY id DESC LIMIT 500`, params);
}

/**
 * 采纳一条提议。
 * 铁律：AI 只能通过这里落盘，且只允许「新增」语义 ——
 * 不会改名/删除已有 field_key，也不会覆盖用户手工设过的别名（除非 force）。
 */
export function acceptProposal(id: number, opts: { force?: boolean } = {}): { ok: boolean; message: string; result?: unknown } {
  const p = get<{ id: number; workbench_id: number | null; work_type_id: number | null; kind: string; payload: string; status: string }>(
    'SELECT * FROM archive_proposal WHERE id = ?',
    [id],
  );
  if (!p) return { ok: false, message: '提议不存在' };
  if (p.status !== 'pending') return { ok: false, message: `提议已是 ${p.status} 状态` };

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(p.payload) as Record<string, unknown>;
  } catch {
    return { ok: false, message: '提议内容不是合法 JSON' };
  }

  let result: unknown = null;
  try {
    if (p.kind === 'field') {
      const key = String(payload.field_key ?? '').trim();
      if (!key) throw new Error('缺少 field_key');
      const existed = get<{ id: number }>(
        `SELECT id FROM archive_field WHERE field_key = ? AND ${liveFilter('archive_field')} /* deleted_at IS NULL */`,
        [key],
      );
      if (existed) {
        // 已存在同 key：只补空缺，不改名不动类型
        result = { reused: true, id: existed.id };
      } else {
        result = {
          created: upsertArchiveField({
            workTypeId: p.work_type_id ?? null, fieldKey: key,
            label: payload.label ? String(payload.label) : key,
            type: (payload.type as FieldType) ?? 'text',
            required: payload.required === true,
            example: payload.example ? String(payload.example) : undefined,
            hint: payload.hint ? String(payload.hint) : undefined,
            origin: 'ai',
          }),
        };
      }
    } else if (p.kind === 'alias') {
      const varName = String(payload.var_name ?? '').trim();
      const fieldKey = String(payload.field_key ?? '').trim();
      if (!varName || !fieldKey) throw new Error('缺少 var_name 或 field_key');
      /**
       * 在用的那条 + **回收站里的那条**都要看。
       * 只看在用行的话，回收站里那条同名别名会被 upsertArchiveAlias 复活并覆盖 ——
       * 系统变量映射的保护（下面两条 return）就形同虚设。
       */
      const exists =
        get<{ id: number; confidence: string; field_key: string }>(
          `SELECT id, confidence, field_key FROM archive_alias
            WHERE COALESCE(work_type_id,0) = COALESCE(?,0) AND var_name = ?
              AND ${liveFilter('archive_alias')} /* deleted_at IS NULL */`,
          [p.work_type_id ?? null, varName],
        ) ??
        (tableHasDeletedAt('archive_alias')
          ? get<{ id: number; confidence: string; field_key: string }>(
              // 这一处**故意反着查**：要读的正是回收站里那条（不是 deleted_at IS NULL 那批）
              `SELECT id, confidence, field_key FROM archive_alias
                WHERE COALESCE(work_type_id,0) = COALESCE(?,0) AND var_name = ? AND deleted_at IS NOT NULL`,
              [p.work_type_id ?? null, varName],
            )
          : undefined);
      // 系统变量映射（field_key 以 _ 开头）是确定性的，绝不能被 AI 提议覆盖：
      // 例如 {年份} 已映射到系统注入的 _年份，若被改成某个档案字段，
      // 语义就从「系统算出来的当前年份」变成「档案里填的年份」，行为会静默改变。
      if (exists && exists.field_key.startsWith('_')) {
        return { ok: false, message: `「${varName}」是系统变量（已映射到 ${exists.field_key}），不允许改成档案字段` };
      }
      if (exists && exists.confidence === 'manual' && !opts.force) {
        return { ok: false, message: `「${varName}」已有手工映射，未覆盖（要覆盖请加 force）` };
      }
      result = { id: upsertArchiveAlias({ workTypeId: p.work_type_id ?? null, varName, fieldKey, confidence: 'ai' }) };
    } else if (p.kind === 'value') {
      if (!p.workbench_id) throw new Error('取值提议必须带 workbench_id');
      result = writeArchiveValues(p.workbench_id, payload);
    } else {
      throw new Error(`未知提议类型 ${p.kind}`);
    }
    run(`UPDATE archive_proposal SET status='accepted', resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, [id]);
    return { ok: true, message: '已采纳', result };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export function rejectProposal(id: number): void {
  run(`UPDATE archive_proposal SET status='rejected', resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`, [id]);
}

/** 批量采纳同一批提议，逐条返回结果 */
export function acceptBatch(batchId: string): { accepted: number; failed: { id: number; message: string }[] } {
  const items = listProposals({ status: 'pending', batchId });
  let accepted = 0;
  const failed: { id: number; message: string }[] = [];
  for (const it of items) {
    const r = acceptProposal(it.id);
    if (r.ok) accepted += 1;
    else failed.push({ id: it.id, message: r.message });
  }
  return { accepted, failed };
}
