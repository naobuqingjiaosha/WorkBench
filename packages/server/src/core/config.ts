import { assertTestIsolation, isIsolated } from './test-isolation.ts';
/**
 * 全局配置中心
 * - 确定安装目录、数据目录、数据库位置
 * - 读写 app_setting 键值配置
 * - 目录初始化（首次启动即建好全部规范目录）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, get, run } from '../db/index.ts';
import { ensureDir, toPosix } from './paths.ts';

/* ------------------------------- 安装路径 ------------------------------- */

const here = dirname(fileURLToPath(import.meta.url)); // packages/server/src/core
export const INSTALL_ROOT = resolve(here, '..', '..', '..', '..'); // 工作台根目录

function readRootConfig(): { dataRoot?: string; port?: number; host?: string } {
  const file = join(INSTALL_ROOT, 'workbench.config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as { dataRoot?: string; port?: number; host?: string };
  } catch {
    return {};
  }
}

assertTestIsolation();
const fileCfg = readRootConfig();

/** 数据根目录：默认在安装目录下，可改到 OneDrive 等同步盘 */
export const DATA_ROOT = resolve(
  process.env.WORKBENCH_DATA_DIR ||
    (fileCfg.dataRoot ? resolve(INSTALL_ROOT, fileCfg.dataRoot) : undefined) ||
    join(INSTALL_ROOT, 'data', 'files'),
);

export const RUNTIME_ROOT = resolve(process.env.WORKBENCH_RUNTIME_DIR ||
  (process.env.WORKBENCH_DB ? dirname(resolve(process.env.WORKBENCH_DB)) : join(INSTALL_ROOT, 'data', 'runtime')));
export const DB_FILE = resolve(process.env.WORKBENCH_DB || join(RUNTIME_ROOT, 'workbench.db'));
export const LOG_DIR = resolve(RUNTIME_ROOT, 'logs');
export const WEB_DIST = resolve(process.env.WORKBENCH_WEB_DIST || resolve(INSTALL_ROOT, 'packages', 'web', 'dist'));

export const SERVER_PORT = Number(process.env.PORT || fileCfg.port || 8787);
export const SERVER_HOST = process.env.HOST || fileCfg.host || '127.0.0.1';

/* ------------------------------- 目录规范 ------------------------------- */

export const DIRS = {
  templates: '_模板库',
  standards: '_规范库',
  index: '_索引',
  inbox: '_待归档',
  workbench: '工作台',
  generated: '_生成文书',
  evidence: '_影像证据',
  source: '_原始资料',
} as const;

/** 数据目录下的固定子目录（首次启动创建） */
export function dataSub(...parts: string[]): string {
  return join(DATA_ROOT, ...parts);
}

export function ensureBaseDirs(): void {
  [
    DATA_ROOT,
    dataSub(DIRS.templates),
    dataSub(DIRS.standards),
    dataSub(DIRS.index),
    dataSub(DIRS.inbox),
    dataSub(DIRS.workbench),
    RUNTIME_ROOT,
    LOG_DIR,
  ].forEach((d) => ensureDir(d));
}

/* ------------------------------ app_setting ------------------------------ */

type SettingType = 'string' | 'number' | 'boolean' | 'json';

interface SettingRow {
  key: string;
  value: string | null;
  value_type: SettingType;
  scope: string;
  label: string | null;
  description: string | null;
}

export function getSettingRaw(key: string): SettingRow | undefined {
  return get<SettingRow>('SELECT key, value, value_type, scope, label, description FROM app_setting WHERE key = ?', [key]);
}

export function getSetting<T = string>(key: string, fallback: T): T {
  const row = getSettingRaw(key);
  if (!row || row.value === null) return fallback;
  return decodeSetting(row.value, row.value_type) as T;
}

export function setSetting(key: string, value: unknown, opts: { type?: SettingType; scope?: string; label?: string; description?: string } = {}): void {
  const type: SettingType = opts.type ?? inferType(value);
  const encoded = encodeSetting(value, type);
  const existing = getSettingRaw(key);
  if (existing) {
    run(
      `UPDATE app_setting SET value = ?, value_type = ?, label = COALESCE(?, label),
         description = COALESCE(?, description),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE key = ?`,
      [encoded, type, opts.label ?? null, opts.description ?? null, key],
    );
  } else {
    run(
      `INSERT INTO app_setting (key, value, value_type, scope, label, description) VALUES (?,?,?,?,?,?)`,
      [key, encoded, type, opts.scope ?? 'app', opts.label ?? null, opts.description ?? null],
    );
  }
}

export function listSettings(scope?: string): SettingRow[] {
  // label/description 也要带出来：界面要靠它显示"这一项是干什么的、改了有什么后果"
  // （设置页的说明文字就取这两列）。以前不返回，界面只能靠 DEFAULT_SETTINGS 兜。
  return scope
    ? all<SettingRow>('SELECT key, value, value_type, scope, label, description FROM app_setting WHERE scope = ? ORDER BY key', [scope])
    : all<SettingRow>('SELECT key, value, value_type, scope, label, description FROM app_setting ORDER BY key');
}

/* --------------------- 用户删掉的预置工作类型（黑名单） --------------------- */

/**
 * work_type / position_template 等预置数据是每次启动无条件「缺什么补什么」的，
 * 于是用户删掉预置项后一重启就被种回来 —— 等于删不掉。
 * 这里把用户明确删掉的预置工作类型编码记下来，seed 时跳过，
 * 让「删除」这个操作真的生效。同名类型若被重新创建，会自动移出黑名单。
 */
const DELETED_WORK_TYPES_KEY = 'work_types.deleted';

export function listDeletedWorkTypeCodes(): string[] {
  const v = getSetting<unknown>(DELETED_WORK_TYPES_KEY, []);
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

export function markWorkTypeDeleted(code: string): void {
  const cur = listDeletedWorkTypeCodes();
  if (cur.includes(code)) return;
  setSetting(DELETED_WORK_TYPES_KEY, [...cur, code], {
    type: 'json',
    label: '已删除的预置工作类型',
    description: '用户明确删掉的预置工作类型编码，启动自检不会再种回来',
  });
}

export function unmarkWorkTypeDeleted(code: string): void {
  const cur = listDeletedWorkTypeCodes();
  if (!cur.includes(code)) return;
  setSetting(DELETED_WORK_TYPES_KEY, cur.filter((c) => c !== code), { type: 'json' });
}

function inferType(v: unknown): SettingType {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'object' && v !== null) return 'json';
  return 'string';
}

function encodeSetting(v: unknown, type: SettingType): string | null {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'json':
      return JSON.stringify(v);
    case 'boolean':
      return v ? '1' : '0';
    case 'number':
      return String(Number(v));
    default:
      return String(v);
  }
}

function decodeSetting(raw: string, type: SettingType): unknown {
  switch (type) {
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    case 'boolean':
      return raw === '1' || raw.toLowerCase() === 'true';
    case 'number':
      return Number(raw);
    default:
      return raw;
  }
}

/* ------------------------------- 默认配置 ------------------------------- */

export const DEFAULT_SETTINGS: {
  key: string;
  value: unknown;
  type?: SettingType;
  label?: string;
  description?: string;
}[] = [
  { key: 'app.name', value: '工作台', label: '应用名称' },
  { key: 'app.operator', value: '', label: '默认经办人', description: '生成文书时默认的编制人/经办人' },
  { key: 'app.org', value: '', label: '单位名称', description: '出现在公文抬头、盖章处的单位全称' },
  { key: 'app.data_root', value: DATA_ROOT, label: '数据目录', description: '所有文件的存放位置' },
  {
    key: 'ai.writing_style',
    value:
      '公文体，简洁准确，不使用口语和网络用语；不编造任何数字、日期、人名、单位名；' +
      '资料中没有的信息一律写成【待补：XXX】；段落清晰，必要处使用"一、二、三"或"（一）（二）"层级。',
    label: '写作风格约束',
    description: '每次调用写作模型时固定注入的写作规范',
  },
  {
    key: 'artifact.index_extract',
    value: true,
    type: 'boolean',
    label: '自动抽取文本建索引',
    description: '文档入库时抽取纯文本，用于全文检索',
  },
  { key: 'ocr.enabled', value: false, type: 'boolean', label: '启用扫描件 OCR', description: '对图片/扫描 PDF 做文字识别' },
  { key: 'ocr.lang', value: 'chi_sim+eng', label: 'OCR 语言' },
  // ---- B3-8 知识库抽取的三个口径（用户没给口径，所以做成设置项、默认值按 docs/15 §三 的建议）----
  // 三个键都由 core/kb-extract.ts 读取；**改动后必须重新抽取一次才会生效**
  // （界面「重新抽取」按钮 / POST /api/kb/sources/:id/extract），
  // 重跑靠 kb_document 的 (source_id, rel_path) 唯一约束原地更新，不产生重复行。
  {
    key: 'kb.dedup',
    value: 'prefer_docx',
    label: '知识库去重口径',
    description:
      '同一份制度出现多个版本/副本时怎么算一份。可选：' +
      'prefer_docx（默认，优先 docx，同文号只留一份）、' +
      'all（全部入库，同一制度会在检索里出现多次）、' +
      'by_name（只按文件名去重，同文号的不同版本都会入库）、' +
      'by_hash（只按内容哈希去重，正文一字不差才算重复）。' +
      '后果：选 all/by_name 会在检索结果里出现同一份制度的多个版本，容易把旧版当依据；' +
      '选 by_hash 对「内容相同但文件名不同」的副本有效，对改过一字的旧稿无效。' +
      '改完必须重新抽取，靠稳定键原地更新、不会产生重复行。',
  },
  {
    key: 'kb.scope',
    value: 'mark',
    label: '知识库范围口径（法规与参考制度）',
    description:
      '外部法规标准和「参考制度」（非本单位发文）要不要入库。可选：' +
      'mark（默认，入库但按来源分区标记：本单位 unit / 法规标准 regulation / 参考制度 reference）、' +
      'exclude（不入库，检索里只有本单位制度）、' +
      'plain（全部当普通制度，不区分来源）。' +
      '后果：选 mark 时检索结果带分区徽标，可按本单位/法规/参考过滤；' +
      '选 exclude 会让「依据哪条国家标准」查不到；选 plain 无法区分本单位制度与外部文本。' +
      '改完必须重新抽取。',
  },
  {
    key: 'kb.version',
    value: 'final_only',
    label: '知识库版本口径（上会稿与历史版本）',
    description:
      '上会稿、制作中、历史版本要不要抽取。可选：' +
      'final_only（默认，只抽带「0.」定稿前缀的定稿件；一份制度没有任何 0. 文件时回退抽现行版）、' +
      'all（全抽，同一文号的上会稿/历史版本也入库并标 superseded，此时同文号的不同版本各占一行，' +
      '只在「同一版本内」去重）、' +
      'latest_only（只抽每份制度最新的一版，按文件修改时间取最新）。' +
      '后果：选 all 会把旧版当依据（B3-10 双链尤其怕这个）；选 latest_only 依赖修改时间，' +
      '文件时间被同步工具改过时会选错。改完必须重新抽取。',
  },
  // ---- B3-9 出文书前口径校验的严格度（唯一一个"总闸"设置项）----
  // 单条规则的 block/warn/开关在 `compliance_rule` 表里（规则数据化：改了立刻生效），
  // 这里管的是"整条链要不要真的拦"。默认 `block` = docs/11 B3-9 的口径：
  // block 规则不通过 → 拒绝保存（412 COMPLIANCE_BLOCKED）并列出"哪一项、错在哪、期望什么"。
  {
    key: 'compliance.strictness',
    value: 'block',
    label: '口径校验严格度',
    description:
      '出文书前的口径校验怎么处理不通过项。可选：' +
      'block（默认，block 级规则不通过就拒绝保存并列出具体问题，可用「例外说明」逐条放行）、' +
      'warn（全部只提示、不拦，适合刚开始用、还没把制度入全的时候）。' +
      '单条规则的级别（block/warn/info）与开关在「知识库 → 口径校验规则」里逐条改，改完立刻生效。',
  },
  // ---- 备份项（键名与设置页「备份」卡片写入的完全一致：带 `backup.` 前缀）----
  // 这几项**只登记键名/类型/说明，不预置值（value: null）**。原因：
  // `applyDefaultSettings()` 每次启动都会把这里的值种进 app_setting，而 `loadBackupConfig()` 的
  // 取值链是 环境变量 > app_setting(界面设置) > workbench.config.json > 内置默认 —— 一旦预置了
  // 非空值，app_setting 这一档就会**永远压住 workbench.config.json 的 backup 段**，
  // 用户改配置文件（文档里承诺的"默认档，改完不用重启"）就再也不生效了。
  // 留空值时 `pick()` 会自然落到下一档，优先级与文档一致。
  { key: 'backup.auto', value: null, type: 'boolean', label: '自动备份', description: '每天到点后自动做一份数据库备份；留空 = 用 workbench.config.json 的 backup.auto' },
  { key: 'backup.hour', value: null, type: 'number', label: '备份时间（0-23 点）', description: '每天这个整点之后第一次运行时就补一份；留空 = 用 workbench.config.json 的 backup.hour' },
  { key: 'backup.dir', value: null, label: '备份目录', description: '默认 data/backups（相对项目根）；留空 = 用 workbench.config.json 的 backup.dir' },
  { key: 'backup.keepDaily', value: null, type: 'number', label: '保留日备份数', description: '超出按时间删最旧的；留空 = 用 workbench.config.json 的 backup.keepDaily' },
  { key: 'backup.keepWeekly', value: null, type: 'number', label: '保留周备份数', description: '周备优先保留；留空 = 用 workbench.config.json 的 backup.keepWeekly' },
  { key: 'backup.weeklyDay', value: null, type: 'number', label: '周备的周界（0=周日）', description: '星期几算新的一周；留空 = 用 workbench.config.json 的 backup.weeklyDay' },
];

/** 把根目录信息写到 workbench.config.json，方便用户自己改 */
export function writeRootConfigIfMissing(): void {
  if (isIsolated()) return;
  const file = join(INSTALL_ROOT, 'workbench.config.json');
  if (existsSync(file)) return;
  const cfg = {
    _说明: '改完需要重启工作台。dataRoot 填绝对路径，可以指向 OneDrive/坚果云同步目录。',
    dataRoot: toPosix(DATA_ROOT),
    port: SERVER_PORT,
    host: SERVER_HOST,
  };
  writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
}

export function applyDefaultSettings(): void {
  for (const s of DEFAULT_SETTINGS) {
    if (!getSettingRaw(s.key)) {
      setSetting(s.key, s.value, { type: s.type, scope: 'app', label: s.label, description: s.description });
    }
  }
  if (getSettingRaw('app.data_root')?.value !== DATA_ROOT) setSetting('app.data_root', DATA_ROOT, { label: '数据目录', description: '所有文件的存放位置' });
}
