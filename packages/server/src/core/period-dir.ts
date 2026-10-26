/**
 * 期次目录命名 —— 「阶段内部按期次分目录」的唯一实现（契约 §5）
 *
 * 周期工作（monthly / quarterly / yearly）在做欠办那一期时，
 * 文件要落到阶段目录下的期次子目录里：
 *
 *   工作\2.安全\1.安全生产例会\2026年10月\现场照片.png
 *
 * 约定：
 *   · 默认命名由 recurrence 决定（月 / 季 / 年），与「当前欠办那一期」的日期对应；
 *   · period_dir 也可以是一段自定义格式串，支持 {yyyy}/{yy}/{m}/{mm}/{q}/{d}；
 *   · 格式串里可以用 `\` 分层（**A 型：年份一层、月份一层**，见 §12 与下方 A_TYPE 一节），
 *     例如 `{yyyy}\{mm}月` → `2026\10月`；`/` 一律归一成 `\`；
 *   · 返回 null 表示「不按期次分目录」—— 由调用方决定传不传 period_dir。
 *
 * 日期一律用**本地日期**：`schedule_due_date` 存的是 `YYYY-MM-DD` 这一天粒度，
 * 本地自然日才是用户心里的那一天。用 `toISOString().slice(0,10)` 会在东八区
 * 把 10 月 1 日算成 9 月 30 日，期次目录就会差一个月。
 *
 * ── 一个坑（本机 Node 24.21.0 实测，绕开了但值得记一笔）──────────────────
 * 这台机器上的字符串拼装在特定形状下会**确定性丢一个字符**：
 *
 *   ['2026','10','1'].join('')   === '2026101'     // 期望 '20261001'
 *   '2026' + '10' + '01'         === '20261001'    // 正确
 *
 * 规律：拼出来的长度是 8、且最后一段只有 1 个字符时会丢；每段都 ≥2 个字符、
 * 或逐段 `+=` 累加（见 joinParts）都正常。`node:vm` 全新上下文里同样复现，
 * 与任何 JS 层 patch 无关。
 *
 * 所以这里：默认命名里每个数字都按定宽生成（年月日各段 ≥2 位），
 * 自定义格式串则**先按两位生成、再按下标去补位 0**，最后逐段 `+=` 拼 ——
 * 全程不出现「1 字符尾段 + 长度 8」的形状。
 * ─────────────────────────────────────────────────────────────────────
 */

/** 'month' | 'quarter' | 'year' 或自定义格式串（如 '{yyyy}{mm}'） */
export type PeriodKind = 'month' | 'quarter' | 'year' | string;

const DEFAULT_NAMES = new Set(['month', 'monthly', '月', '月份', 'month_dir']);
const QUARTER_NAMES = new Set(['quarter', 'quarterly', '季', '季度', 'quarter_dir']);
const YEAR_NAMES = new Set(['year', 'yearly', '年', '年度', 'year_dir']);

/** 认不出来的日期返回今天（本地自然日） */
function parseLocalDate(dueDate: string | null | undefined): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((dueDate ?? '').trim());
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** 数字 → 定宽字符串（宽度必给，见文件头的坑） */
function num(n: number, width: number): string {
  const v = Math.abs(Math.floor(Number.isFinite(n) ? n : 0));
  return String(v).padStart(width, '0');
}

/** 默认命名：monthly → 2026年10月 / quarterly → 2026年第4季度 / yearly → 2026年 */
function defaultName(recurrence: string, d: Date): string {
  const r = (recurrence ?? '').trim().toLowerCase();
  const y = num(d.getFullYear(), 4);
  if (QUARTER_NAMES.has(r)) return `${y}年第${Math.floor(d.getMonth() / 3) + 1}季度`;
  if (YEAR_NAMES.has(r)) return `${y}年`;
  // monthly 以及一切没认出来的周期：按月份分，最贴近「一期一个月」的直觉
  return `${y}年${d.getMonth() + 1}月`;
}

/** 一个占位符 → 文本；认不出来的占位符原样保留 */
function tokenValue(token: string, d: Date): string {
  switch (token.toLowerCase()) {
    case 'yyyy':
      return num(d.getFullYear(), 4);
    case 'yy':
      return num(d.getFullYear() % 100, 2);
    case 'mm':
      return num(d.getMonth() + 1, 2);
    // 单位数 token 也先补成两位，applyFormat 收尾时按下标去掉补出来的 0
    case 'm':
      return num(d.getMonth() + 1, 2);
    case 'q':
      return num(Math.floor(d.getMonth() / 3) + 1, 2);
    case 'd':
      return num(d.getDate(), 2);
    default:
      return `{${token}}`;
  }
}

/**
 * 按片段拼字符串。
 *
 * **逐片段用 `+=`，不用 `Array.prototype.join`** —— 见文件头那个坑：
 * 拼装时只要出现「最后一段只有 1 个字符」的形状，join / 模板字符串就可能少一个字符。
 * 逐段累加（每段都 ≥2 字符时更稳）是实测唯一可靠的方式。
 */
function joinParts(parts: string[]): string {
  let out = '';
  for (let i = 0; i < parts.length; i += 1) out += parts[i] as string;
  return out;
}

/**
 * 格式串替换：`{yyyy}`/`{yy}`/`{m}`/`{mm}`/`{q}`/`{d}`，其余字符原样保留。
 *
 * 「其余字符原样保留」正是 A 型两级写法的实现基础：`{yyyy}\{mm}月` 里的 `\` 不是
 * 占位符，会被原样带出来，于是输出就是 `2026\10月` 这条**两级相对路径**。
 * 收尾的归一化（`/`→`\`、去空层级）在 `normalizePeriodPath` 里做，不在这。
 *
 * 两处细节：手写扫描（不用 `String.prototype.replace`），
 * 以及 `{m}`/`{q}`/`{d}` 这三个单位数 token 先按两位生成、再按下标去掉补出来的 0 ——
 * 下标是准的，不受字符串内容干扰，所以 `{mm}` 的 `01` 不会被误改。
 */
function applyFormat(fmt: string, d: Date): string {
  const parts: string[] = [];
  /** 需要去掉补位 0 的片段下标（只有 m / q / d 这三个单位数 token） */
  const trimZero: number[] = [];
  const re = /\{(yyyy|yy|mm|m|q|d)\}/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fmt)) !== null) {
    if (m.index > last) parts.push(fmt.slice(last, m.index));
    const token = (m[1] as string).toLowerCase();
    parts.push(tokenValue(token, d));
    if (token === 'm' || token === 'q' || token === 'd') trimZero.push(parts.length - 1);
    last = m.index + m[0].length;
  }
  if (last < fmt.length) parts.push(fmt.slice(last));
  for (const i of trimZero) {
    const v = parts[i] as string;
    if (v.length === 2 && v[0] === '0') parts[i] = v[1] as string;
  }
  return joinParts(parts);
}

/**
 * 算期次目录名。
 *
 * 返回值可以是**单段**目录名（`2026年10月`），也可以是**多级相对路径**
 * （A 型 `2026\10月`）—— 调用方用 `join(stage, ...name.split('\\'))` 拼，
 * 拼完必须再过一遍 `isInsideRoot`（见 `domain/service.ts` 的 `positionPeriodDirAbs`）。
 *
 * @param recurrence 工作台的周期：monthly / quarterly / yearly（once 不按期次分目录）
 * @param dueDate    当前欠办那一期的日期（YYYY-MM-DD）；空则用今天
 * @param spec       该阶段模板的 period_dir：'month' | 'quarter' | 'year' 或自定义格式串；
 *                   NULL / '' / undefined = 不启用
 * @returns 目录名（可能含 `\` 分层）；null = 不按期次分目录
 */
export function periodDirName(recurrence: string, dueDate: string | null, spec: PeriodKind | null | undefined): string | null {
  const raw = normalizePeriodSpec(spec);
  if (!raw) return null;
  const d = parseLocalDate(dueDate);
  const key = raw.toLowerCase();
  const name = DEFAULT_NAMES.has(key) || QUARTER_NAMES.has(key) || YEAR_NAMES.has(key)
    ? defaultName(recurrence, d)
    : normalizePeriodPath(applyFormat(raw, d));
  return name || null;
}

/**
 * 期次目录名能不能当目录名用（越界/非法字符防呆）。
 * 只认**单段**目录名；A 型的多级写法用 `isSafePeriodPath`。
 */
export function isSafeDirName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  return !/[\\/:*?"<>|\r\n\t]/.test(name);
}

/* ------------------- A 型期次格式（两级 `YYYY\MM月`，契约 §12） ------------------- */

/**
 * A 型默认格式串（用户 2026-10-01 定稿）：
 *
 *     {yyyy}\{mm}月   →   2026\10月      （年份一层、月份一层）
 *
 * 这是「按期次分目录」的默认写法：年份一层、月份一层，月份不带前导零也可以
 * （`{m}` 就是不补零的写法）。界面上把 period_dir 传成 `'default'` / `'默认'` / `'a'`
 * 这些 sentinel 时，按本格式展开。
 */
export const DEFAULT_PERIOD_FORMAT = '{yyyy}\\{mm}月';

/** 「用默认 A 型格式」的 sentinel 写法（大小写不敏感） */
const A_FORMAT_ALIASES = new Set(['default', '默认', 'a', 'a型', 'a-type', 'period_default']);

/**
 * 把一段期次格式串/路径归一化：`/` → `\`，丢掉空层级，每层去首尾空白。
 * 空串原样返回（= 不启用期次）。
 */
export function normalizePeriodPath(input: string | null | undefined): string {
  const raw = (input ?? '').toString().trim();
  if (!raw) return '';
  const parts: string[] = [];
  for (const seg of raw.replace(/\//g, '\\').split('\\')) {
    const t = seg.trim();
    if (t) parts.push(t);
  }
  // 逐段 `+=`，不用 Array.join（见文件头的坑）
  let out = '';
  for (let i = 0; i < parts.length; i += 1) out += (i === 0 ? '' : '\\') + (parts[i] as string);
  return out;
}

/**
 * 入库前的格式串归一化：sentinel → `DEFAULT_PERIOD_FORMAT`，`/` → `\`，去空层级。
 * 想让「默认格式」是 A 型，就在这一处展开；存进库里的永远是展开后的字面格式串，
 * 界面/日志里看到的就是最终会落到磁盘上的形状。
 */
export function normalizePeriodSpec(spec: string | null | undefined): string {
  const raw = (spec ?? '').toString().trim();
  if (!raw) return '';
  const expanded = A_FORMAT_ALIASES.has(raw.toLowerCase()) ? DEFAULT_PERIOD_FORMAT : raw;
  return normalizePeriodPath(expanded);
}

/**
 * 期次**格式串**（用户可编辑）合法性检查 —— 契约 §12 / §5。
 *
 * 允许：
 *   · `\` 作层级分隔符（A 型两级；`/` 也会被归一成 `\`）；
 *   · 普通文字与 `{yyyy}`/`{yy}`/`{mm}`/`{m}`/`{q}`/`{d}` 占位符。
 * 拒绝：
 *   · `..`（任何形式的上级跳转，出现即拒）；
 *   · 绝对路径：盘符开头（`C:`）或 UNC（`\\server\share`）；
 *   · 其余非法字符 `: * ? " < > |` 与控制字符；
 *   · 层级名是 `.` 或空串（空层级会被归一化掉，不额外报错）。
 *
 * @returns 错误信息；null = 通过
 */
export function periodSpecProblem(spec: string | null | undefined): string | null {
  const raw = (spec ?? '').toString().trim();
  if (!raw) return null; // 空 = 不启用期次
  const asPath = raw.replace(/\//g, '\\');
  if (raw.includes('..')) return '期次目录格式不能含 `..`（上级跳转）';
  if (/^[A-Za-z]:/.test(raw)) return '期次目录格式不能是绝对路径（不能以盘符开头，如 `C:...`）';
  if (asPath.startsWith('\\\\')) return '期次目录格式不能是 UNC 绝对路径（不能以 `\\\\` 开头）';
  if (/[:*?"<>|\r\n\t]/.test(raw)) return '期次目录格式含有非法字符（不能有 : * ? " < > |）';
  for (const seg of asPath.split('\\')) {
    const t = seg.trim();
    if (t === '.') return '期次目录格式的层级名不能是 `.`';
    if (t === '..') return '期次目录格式不能含 `..`（上级跳转）';
  }
  return null;
}

/**
 * 渲染**之后**的期次目录名/相对路径能不能用 —— 可以含 `\` 分层（A 型 `2026\10月`）。
 *
 * 与 `isSafeDirName` 的区别只有一条：`\` 是分层符而不是非法字符。
 * 仍然拒绝 `..`、绝对路径、UNC、其余非法字符，以及空层级 / `.` 层级。
 * 这是落盘前的最后一道「名字」防呆；**路径**是否还在工作台根内由调用方用
 * `isInsideRoot` 判（`domain/service.ts` 的 `positionPeriodDirAbs`）。
 */
export function isSafePeriodPath(name: string): boolean {
  const n = (name ?? '').toString().trim();
  if (!n) return false;
  if (n.includes('..')) return false;
  if (/^[A-Za-z]:/.test(n)) return false;
  const asPath = n.replace(/\//g, '\\');
  if (asPath.startsWith('\\\\')) return false;
  if (/[:*?"<>|\r\n\t]/.test(n)) return false;
  const segs = asPath.split('\\');
  if (!segs.length) return false;
  for (const seg of segs) {
    const t = seg.trim();
    if (!t || t === '.' || t === '..') return false;
  }
  return true;
}

