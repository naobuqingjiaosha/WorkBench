import { assertTestWrite } from './test-isolation.ts';
/**
 * 数据库自动备份与一键恢复
 *
 * 背景（用户的核心风险）：**数据库只有本地一份**。用户文件在 iCloud 有备份，
 * 但 `data/runtime/workbench.db` 没有 —— 硬盘坏了，工作台、字段、别名、清单、
 * 记录就全没了。这个模块就是给这一个文件做"每天一份、可校验、可回退"的守护。
 *
 * 四条设计底线：
 *
 * 1. **快照必须是 SQLite 自己给的**（`node:sqlite` 的 `backup()`，与 scripts/pack.mjs 同一套做法）。
 *    正在写的库直接 `copyFile` 复制出来的是"半截页"，看着有文件、打开却可能坏。
 *    `backup()` 走 SQLite 在线备份 API，得到的是**某个时刻的一致快照**；
 *    实测它是同步跑完的（备份期间事件循环不让出），所以本进程内的并发写在备份时
 *    根本插不进去，快照天然自洽。
 *
 * 2. **校验不过的备份标记为坏并留证**。不做"校验失败就删掉重来"——
 *    坏文件本身就是线索（是磁盘坏了？还是库本来就坏了？），静默删除等于毁掉证据。
 *    坏备份还会被排除在自动清理之外，只有用户手动删才会消失。
 *
 * 3. **恢复绝不"就地改库"**：先校验备份 → 先给当前库做一份新备份 → 停写 →
 *    关库 → 整个文件复制成临时文件 → `rename` 原子替换 → 重开库 → 再校验。
 *    任何一步被杀掉，`workbench.db` 要么是旧的、要么是新的，**不会**是半截的。
 *    任何情况下**不碰 `data/files` 下的用户文件**（本模块只认数据库文件）。
 *
 * 4. **备份清单不存进数据库**。清单存数据库里的话，一旦恢复旧库，
 *    新备份的记录就跟着丢了 —— 那正是最需要它们的时候。
 *    所以清单从目录里的文件名 + 同名 `.json` 边车文件（sidecar）读出来。
 *
 * 备份文件命名：`workbench-<daily|weekly|manual>-YYYYMMDD-HHmmss.db`，
 * 同名边车 `*.db.json` 记录类型、时间、大小、校验结论。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { DB_FILE, DATA_ROOT, backupDirectoryConfig, readRuntimeConfig, getSetting } from './config.ts';
import { closeDatabase, getDb, initDatabase } from '../db/index.ts';
import { notDeleted } from './trash.ts';
import { ensureDir, dateOnly, isoNow, stamp, toPosix } from './paths.ts';

/* ================================ 常量 ================================ */

export type BackupKind = 'daily' | 'weekly' | 'manual';

export const KIND_LABEL: Record<BackupKind, string> = { daily: '日备', weekly: '周备', manual: '手动' };

/** 备份文件名的严格形状：既是列表筛选条件，也是接口入参的校验依据（防目录穿越） */
const NAME_RE = /^workbench-(daily|weekly|manual)-(\d{8})-(\d{6})(?:-(\d+))?\.db$/;
const SIDECAR_SUFFIX = '.json';

/** 定时器间隔：5 分钟看一次"今天该不该备" */
const TICK_MS = 5 * 60 * 1000;
/** 启动后多久先判断一次（错过时间点也能补上） */
const FIRST_TICK_MS = 15 * 1000;
/** 同一天日备最多自动尝试几次（防止校验一直不通过时每 5 分钟刷一份坏文件） */
const MAX_DAILY_ATTEMPTS = 3;
/** 恢复时等待正在跑的写请求结束的上限 */
const DRAIN_MS = 3000;

const DEFAULT_CFG = { auto: true, hour: 3, dir: 'data/backups', keepDaily: 7, keepWeekly: 4, weeklyDay: 1 } as const;

/**
 * app_setting 里同一个备份项的**两种键名都要认**，第一种优先：
 *
 *   · `backup.auto` —— 设置页那张卡片写进去的（带命名空间，也是 `DEFAULT_SETTINGS` 里登记的形状）；
 *   · `auto`        —— 早期版本读的裸键（历史上手工写库、或旧版本留下的行）。
 *
 * 这组键是"界面声称能设、实际不生效"那个缺陷的修复点：改动前 `pick()` 只读裸键，
 * 而界面一直写 `backup.*`，于是**用户在界面上关掉自动备份其实没关**（库开着、界面显示已关闭、
 * 定时器照样每天备份），只有 `workbench.config.json` 与环境变量两条路真的通。
 *
 * 为什么是"两种都认"而不是"把界面改成写裸键"：旧库（含现网）里已经存着 `backup.*` 的行，
 * 改界面键名会把它们悄悄作废 —— 用户以前在界面上设的值会突然回到配置文件档，
 * 而"设置被谁动了"恰恰是最难排查的一类问题。读侧兼容两边，写侧不动，历史数据继续有效。
 */
const SETTING_KEYS: Record<keyof typeof DEFAULT_CFG, readonly string[]> = {
  auto: ['backup.auto', 'auto'],
  hour: ['backup.hour', 'hour'],
  dir: ['backup.dir', 'dir'],
  keepDaily: ['backup.keepDaily', 'keepDaily'],
  keepWeekly: ['backup.keepWeekly', 'keepWeekly'],
  weeklyDay: ['backup.weeklyDay', 'weeklyDay'],
};

/* ============================== 配置读取 ============================== */

export interface BackupConfig {
  /** 自动备份开关 */
  auto: boolean;
  /** 每天几点之后允许跑（0-23，本地时间） */
  hour: number;
  /** 备份目录（绝对路径） */
  dir: string;
  /** 配置里写的原始目录值（给界面显示） */
  dirRaw: string;
  keepDaily: number;
  keepWeekly: number;
  /** 周备的"周界"：星期几算新的一周（0=周日，默认 1=周一） */
  weeklyDay: number;
  /** 每个字段最终是谁说了算，排查配置问题时一眼看清 */
  origin: { auto: string; hour: string; dir: string; keepDaily: string; keepWeekly: string; weeklyDay: string };
}

/** Re-read only this environment's configuration; malformed config fails closed. */
function readFileConfig() { return readRuntimeConfig(); }

function num(v: unknown, def: number, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
}

/**
 * 生效配置 = 环境变量 > 界面里存的 app_setting > workbench.config.json > 内置默认。
 *
 * 界面上的开关/时间走 app_setting（复用已有的 `PUT /api/settings`，不新增配置写入路径）；
 * workbench.config.json 是对外公开的"默认档"，改了不用重启。
 * app_setting 要在数据库开着的时候读 —— 恢复过程中数据库是关着的，这里必须能兜住。
 */
export function loadBackupConfig(): BackupConfig {
  const file = (readFileConfig().backup ?? {}) as Record<string, unknown>;
  const setting = (key: string): unknown => {
    try {
      return getSetting<unknown>(key, undefined);
    } catch {
      return undefined; // 库没开（例如恢复过程中）时用文件配置
    }
  };
  /**
   * app_setting 档取值：先 `backup.<键>`（界面在写的那个），再裸键 `<键>`。
   * 两个都没有、或存的是 NULL（`DEFAULT_SETTINGS` 里这几项就是 NULL，只登记不预置值）→ 返回 undefined，
   * 交给下一档 workbench.config.json —— 这一条保证了"配置文件档没被空值压住"。
   */
  const settingValue = (key: keyof typeof DEFAULT_CFG): unknown => {
    for (const k of SETTING_KEYS[key]) {
      const s = setting(k);
      if (s !== undefined && s !== null) return s;
    }
    return undefined;
  };
  const pick = (key: keyof typeof DEFAULT_CFG, envName: string): { value: unknown; origin: string } => {
    const env = process.env[envName];
    if (env !== undefined && env !== '') return { value: env, origin: `环境变量 ${envName}` };
    const s = settingValue(key);
    if (s !== undefined && s !== null) return { value: s, origin: '界面设置' };
    if (file[key] !== undefined && file[key] !== null) return { value: file[key], origin: 'workbench.config.json' };
    return { value: undefined, origin: '默认值' };
  };

  const auto = pick('auto', 'WORKBENCH_BACKUP_AUTO');
  const hour = pick('hour', 'WORKBENCH_BACKUP_HOUR');
  const dir = backupDirectoryConfig({ backup: file });
  const keepDaily = pick('keepDaily', 'WORKBENCH_BACKUP_KEEP_DAILY');
  const keepWeekly = pick('keepWeekly', 'WORKBENCH_BACKUP_KEEP_WEEKLY');
  const weeklyDay = pick('weeklyDay', 'WORKBENCH_BACKUP_WEEKLY_DAY');


  return {
    auto: bool(auto.value) ?? DEFAULT_CFG.auto,
    hour: num(hour.value, DEFAULT_CFG.hour, 0, 23) ?? DEFAULT_CFG.hour,
    // 相对路径按当前环境配置基准目录解析（与 config.ts 里 dataRoot 同一口径），绝对路径原样用
    dir: dir.dir,
    dirRaw: dir.dirRaw,
    keepDaily: num(keepDaily.value, DEFAULT_CFG.keepDaily, 1, 365) ?? DEFAULT_CFG.keepDaily,
    keepWeekly: num(keepWeekly.value, DEFAULT_CFG.keepWeekly, 0, 365) ?? DEFAULT_CFG.keepWeekly,
    weeklyDay: num(weeklyDay.value, DEFAULT_CFG.weeklyDay, 0, 6) ?? DEFAULT_CFG.weeklyDay,
    origin: {
      auto: auto.origin,
      hour: hour.origin,
      dir: dir.origin,
      keepDaily: keepDaily.origin,
      keepWeekly: keepWeekly.origin,
      weeklyDay: weeklyDay.origin,
    },
  };
}

/**
 * 备份目录**不许落在 data/files 里面**。
 * 那里是用户文件根：放进去会被当成用户资料扫进索引，`pack.mjs` 的完整备份也会把它一起打包
 * （备份里再套备份），而且恢复/清理时会和用户文件混在一起 —— 三个麻烦，一个检查挡住。
 * 另外这里只允许写用户明确指定的那一个目录，其它地方一律不碰。
 */
function assertDirOk(dir: string): void {
  const files = resolve(DATA_ROOT);
  const d = resolve(dir);
  const rel = relative(files, d);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new BackupFailure('BAD_BACKUP_DIR', `备份目录不能放在用户文件目录里：${d}\n请改 workbench.config.json 的 backup.dir（默认 data/backups）。`);
  }
}

/* ============================== 数据结构 ============================== */

export interface BackupVerify {
  ok: boolean;
  /** quick_check 的原始返回（正常就是 'ok'） */
  quickCheck: string;
  /** foreign_key_check 的违规行数 */
  foreignKeyCheck: number;
  /** 外键违规样例（最多 3 条），坏在哪里能直接看到 */
  foreignKeySamples?: string[];
  /** 快照里工作台的数量；读不出来为 null */
  workbenchCount: number | null;
  checkedAt: string;
  durationMs: number;
  errors: string[];
}

interface BackupSidecar {
  name: string;
  kind: BackupKind;
  createdAt: string;
  sizeBytes: number;
  note: string | null;
  scope: 'db';
  verify: BackupVerify;
}

export interface BackupInfo {
  name: string;
  kind: BackupKind;
  kindLabel: string;
  createdAt: string;
  sizeBytes: number;
  note: string | null;
  /** true 校验通过 / false 坏（留证，不自动删）/ null 还没校验过 */
  ok: boolean | null;
  verify: BackupVerify | null;
  /** 坏备份的便捷标记 */
  bad: boolean;
  /** 边车文件丢了？列表里要能看出来 */
  sidecarMissing: boolean;
}

/** core 层不依赖 api/reply.ts：错误码由路由翻译成 ApiError，分层不倒过来 */
export class BackupFailure extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ============================== 列表 / 校验 ============================== */

export function backupDir(): string {
  const dir = loadBackupConfig().dir;
  assertTestWrite(dir);
  return dir;
}

/** 从文件名解析出本地时间；解析不出来退回文件 mtime */
function createdAtOf(name: string, absFile: string): string {
  const m = NAME_RE.exec(name);
  const day = m?.[2];
  const time = m?.[3];
  if (day && time) {
    const dt = new Date(
      Number(day.slice(0, 4)),
      Number(day.slice(4, 6)) - 1,
      Number(day.slice(6, 8)),
      Number(time.slice(0, 2)),
      Number(time.slice(2, 4)),
      Number(time.slice(4, 6)),
    );
    if (!Number.isNaN(dt.getTime())) return dt.toISOString();
  }
  try {
    return statSync(absFile).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function readSidecar(absFile: string): BackupSidecar | null {
  const file = absFile + SIDECAR_SUFFIX;
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as BackupSidecar;
    if (!raw || typeof raw !== 'object' || !raw.verify) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeSidecar(absFile: string, data: BackupSidecar): void {
  // 先写临时文件再改名：同步盘/断电时不会留下半截 JSON
  const tmp = absFile + SIDECAR_SUFFIX + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, absFile + SIDECAR_SUFFIX);
}

/** 清掉某个库文件旁的 -wal/-shm（换库/删备份时都要清，别让旧 WAL 盖到新文件上） */
function removeSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm']) {
    try {
      rmSync(file + suffix, { force: true });
    } catch {
      /* 清不掉不影响主流程 */
    }
  }
}

/**
 * 把快照收成"一个文件拿走就能用"。
 *
 * SQLite 的备份目标会**继承源库的 WAL 模式**，于是快照旁边会多出 `-wal`/`-shm`：
 * 光把 `.db` 复制走（上传网盘、拷到别的盘、以后恢复时整文件替换）就可能丢掉还压在 WAL
 * 里没落盘的那部分页 —— 备份看着在、内容不全，是最坏的一种坏。
 * 所以备份完成后立刻把快照切回单文件模式（SQLite 会顺带 checkpoint 并删掉 -wal/-shm）。
 */
function finalizeSnapshot(file: string): void {
  const t = new DatabaseSync(file);
  try {
    t.exec('PRAGMA journal_mode = DELETE');
  } catch (e) {
    console.warn(`[备份] 快照收尾（切单文件模式）失败，已按 WAL 模式保留：${msg(e)}`);
  } finally {
    try {
      t.close();
    } catch {
      /* ignore */
    }
  }
  removeSidecars(file);
}

/**
 * 数"在用的工作台"（**业务口径**：回收站里的不算），用于备份报告与恢复前后核对。
 *
 * 口径说明（软删除接缝，另一路在做回收站）：
 *   · 这里统计的是**业务语义的数量**，要排除 `deleted_at IS NOT NULL` 的行 ——
 *     否则界面上"工作台 3 个"、备份报告里写"工作台 4 个"，用户会以为备份坏了；
 *   · **物理备份本身不筛**：快照是整个库的字节级副本，回收站里的行老老实实躺在里面，
 *     用户从回收站恢复时它得在。要筛的是"读出来给人看的数"，不是"备下去的内容"。
 *
 * 为什么列的有无要按**这条连接**判、而不是直接用 trash.liveFilter()：
 * liveFilter 是按当前库（模块级 get()）探测列的，而本函数拿到的是备份文件的连接 ——
 * 备份的 schema 可能比当前库老（迁移 015 之前没有 deleted_at）。拿当前库的结论去查老快照
 * 会报 `no such column: deleted_at`，而"少一列"绝不该把一份好备份判成坏、更不该让
 * 老备份无法恢复。所以这里判一次列、选一条 SQL：有列就用共享片段 notDeleted()，没有就不过滤。
 */
function countLiveWorkbenches(db: DatabaseSync): number | null {
  try {
    const hasDeletedAt = Boolean(
      db.prepare(`SELECT 1 AS x FROM pragma_table_info('workbench') WHERE name = 'deleted_at'`).get(),
    );
    const sql = hasDeletedAt
      ? `SELECT COUNT(*) AS n FROM workbench WHERE ${notDeleted()}`
      : // 老库降级：这一列还不存在，也就没有"回收站里的行"要排除
        `SELECT COUNT(*) AS n FROM workbench`;
    const row = db.prepare(sql).get() as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return null;
  }
}

/**
 * 严格校验一个 SQLite 库文件：`quick_check` + `foreign_key_check`，顺便数一下工作台。
 * 刻意**不做** `integrity_check`：quick_check 是它的快速版本，日常每次备份都跑，
 * 要全量深检由用户点「校验」或测试脚本自己跑（见验收脚本里的 integrity_check）。
 */
export function verifyDbFile(absFile: string): BackupVerify {
  const t0 = Date.now();
  const errors: string[] = [];
  let quickCheck = '';
  let fkRows: unknown[] = [];
  let workbenchCount: number | null = null;
  let db: DatabaseSync | null = null;

  try {
    db = new DatabaseSync(absFile, { readOnly: true });
  } catch (e) {
    errors.push(`打不开这个文件（可能不是 SQLite 库或已损坏）：${msg(e)}`);
  }
  if (db) {
    try {
      const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
      quickCheck = String(row?.quick_check ?? '');
      if (quickCheck !== 'ok') errors.push(`quick_check 未通过：${quickCheck || '（空结果）'}`);
    } catch (e) {
      errors.push(`quick_check 执行失败：${msg(e)}`);
    }
    try {
      fkRows = db.prepare('PRAGMA foreign_key_check').all() as unknown[];
      if (fkRows.length) errors.push(`foreign_key_check 发现 ${fkRows.length} 处外键违规`);
    } catch (e) {
      errors.push(`foreign_key_check 执行失败：${msg(e)}`);
    }
    try {
      workbenchCount = countLiveWorkbenches(db);
      if (workbenchCount === null) errors.push('读不到工作台数量（表结构可能不对）');
    } catch (e) {
      errors.push(`读不到工作台数量（表结构可能不对）：${msg(e)}`);
    }
    try {
      db.close();
    } catch {
      /* 关不掉不影响结论 */
    }
  }
  return {
    ok: errors.length === 0,
    quickCheck,
    foreignKeyCheck: fkRows.length,
    foreignKeySamples: fkRows.slice(0, 3).map((r) => JSON.stringify(r)),
    workbenchCount,
    checkedAt: isoNow(),
    durationMs: Date.now() - t0,
    errors,
  };
}

/** 列目录里的备份（新的在前）。清单来自文件系统，恢复旧库也不会丢。 */
export function listBackups(dirOverride?: string): BackupInfo[] {
  const cfg = loadBackupConfig();
  const dir = dirOverride ?? cfg.dir;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // 目录还不存在 = 一份都还没有
  }
  const items: BackupInfo[] = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const abs = join(dir, name);
    let sizeBytes = 0;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      sizeBytes = st.size;
    } catch {
      continue;
    }
    const kind = m[1] as BackupKind;
    const side = readSidecar(abs);
    const verify = side?.verify ?? null;
    items.push({
      name,
      kind,
      kindLabel: KIND_LABEL[kind],
      createdAt: side?.createdAt ?? createdAtOf(name, abs),
      sizeBytes,
      note: side?.note ?? null,
      ok: verify ? verify.ok : null,
      verify,
      bad: verify ? !verify.ok : false,
      sidecarMissing: side === null,
    });
  }
  // 按时间倒序；同一时刻用手动 > 日备 > 周备排（用户主动做的放前面更好找）
  const rank: Record<BackupKind, number> = { manual: 0, daily: 1, weekly: 2 };
  return items.sort((a, b) => {
    const d = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (d !== 0) return d;
    const r = rank[a.kind] - rank[b.kind];
    return r !== 0 ? r : a.name.localeCompare(b.name);
  });
}

/** 把一个名字解析成备份目录内的绝对路径；不合法/越界一律拒绝 */
export function resolveBackupPath(name: string, dirOverride?: string): string {
  const dir = dirOverride ?? loadBackupConfig().dir;
  const raw = String(name ?? '').trim();
  if (!raw || basename(raw) !== raw || raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    throw new BackupFailure('BAD_NAME', `备份文件名不合法：${name}`);
  }
  if (!NAME_RE.test(raw)) throw new BackupFailure('BAD_NAME', `不是本程序生成的备份文件名：${raw}`, 404);
  const abs = resolve(dir, raw);
  const rel = relative(resolve(dir), abs);
  if (rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new BackupFailure('BAD_NAME', `路径越界，拒绝访问：${raw}`);
  if (!existsSync(abs)) throw new BackupFailure('NOT_FOUND', `备份不存在（可能已被删除）：${raw}`, 404);
  return abs;
}

/** 校验一份备份并把结论写回边车（坏结论同样落盘，这就是"留证"） */
export function verifyBackupByName(name: string, dirOverride?: string): BackupInfo {
  const dir = dirOverride ?? loadBackupConfig().dir;
  const abs = resolveBackupPath(name, dir);
  const name2 = basename(abs);
  const side = readSidecar(abs);
  const verify = verifyDbFile(abs);
  const info: BackupInfo = {
    name: name2,
    kind: (NAME_RE.exec(name2)?.[1] ?? 'manual') as BackupKind,
    kindLabel: KIND_LABEL[(NAME_RE.exec(name2)?.[1] ?? 'manual') as BackupKind],
    createdAt: side?.createdAt ?? createdAtOf(name2, abs),
    sizeBytes: statSync(abs).size,
    note: side?.note ?? null,
    ok: verify.ok,
    verify,
    bad: !verify.ok,
    sidecarMissing: false,
  };
  writeSidecar(abs, {
    name: info.name,
    kind: info.kind,
    createdAt: info.createdAt,
    sizeBytes: info.sizeBytes,
    note: info.note,
    scope: 'db',
    verify,
  });
  if (!verify.ok) {
    console.warn(`[备份] ${info.name} 校验不通过（文件已保留，未删除）：${verify.errors.join('；')}`);
  }
  return info;
}

export function verifyAllBackups(dirOverride?: string): BackupInfo[] {
  const dir = dirOverride ?? loadBackupConfig().dir;
  return listBackups(dir).map((b) => verifyBackupByName(b.name, dir));
}

/* ================================ 备份 ================================ */

export interface CreateOptions {
  kind?: BackupKind;
  note?: string;
  /** 指定"现在"，方便测试与定时器统一时间口径 */
  now?: Date;
  dir?: string;
  /** 跳过保留策略清理（恢复前的自动备份、批量造数据时用） */
  skipPrune?: boolean;
  /** 外部已有的连接（命令行工具在服务没跑时自带一个只读连接） */
  source?: DatabaseSync;
}

export interface BackupInfoWithCreated extends BackupInfo {
  /** 文件是否真的落盘（false 表示只有失败原因） */
  createdFile: boolean;
  /** 这一轮顺带按保留策略清掉的旧备份 */
  pruned?: string[];
}

function uniqueName(dir: string, kind: BackupKind, d: Date): string {
  // stamp() 是 14 位数字（YYYYMMDDHHmmss），这里插一个连字符成 YYYYMMDD-HHmmss ——
  // 与 NAME_RE 必须严格一致，否则自己生成的备份会被自己的列表/校验/恢复挡在门外。
  const s = stamp(d);
  const stem = `workbench-${kind}-${s.slice(0, 8)}-${s.slice(8)}`;
  let name = `${stem}.db`;
  let n = 1;
  while (existsSync(join(dir, name)) || existsSync(join(dir, name + SIDECAR_SUFFIX))) {
    n += 1;
    name = `${stem}-${n}.db`;
  }
  return name;
}


/**
 * 立即做一份一致性快照。
 *
 * 顺序上有个刻意的安排：**先备到临时文件、校验通过、再改名发布**。
 * 这样备份目录里永远不会出现"半个文件"被列表看到；
 * 校验不过时临时文件照样改名发布（保留证据），只是边车里记成坏。
 */
export async function createBackup(opts: CreateOptions = {}): Promise<BackupInfoWithCreated> {
  const cfg = loadBackupConfig();
  const dir = opts.dir ?? cfg.dir;
  const kind: BackupKind = opts.kind ?? 'manual';
  const now = opts.now ?? new Date();

  try {
    assertDirOk(dir);
  } catch (e) {
    // 目录本身配置错了，直接抛给调用方（接口会变成 400 + 人话）
    if (e instanceof BackupFailure) throw e;
    throw new BackupFailure('BAD_BACKUP_DIR', msg(e));
  }
  ensureDir(dir);
  // Old partial-looking files have no reliable ownership metadata. Only this invocation's
  // unique temporary path is cleaned below; never infer ownership from a filename/age.

  // 优先用进程内那条活连接（能拿到最新的、含 WAL 的一致视图）；
  // 命令行/服务没跑时就临时开一条 —— 备份完必须自己关掉，不能留下连接。
  let conn: DatabaseSync;
  let ownConn = false;
  if (opts.source) {
    conn = opts.source;
  } else {
    try {
      conn = getDb();
    } catch {
      // 只有真要自己去开库时才要求默认库文件存在（命令行带 --db 指定别的库时不该被它挡住）
      if (!existsSync(DB_FILE)) throw new BackupFailure('NO_DB', `没有找到数据库文件，无法备份：${DB_FILE}`, 500);
      conn = new DatabaseSync(DB_FILE);
      ownConn = true;
    }
  }

  const name = uniqueName(dir, kind, now);
  const finalAbs = join(dir, name);
  const tmpAbs = `${finalAbs}.partial-${process.pid}-${randomUUID()}`;
  let verify: BackupVerify;
  try {
    await backup(conn, tmpAbs); // SQLite 在线备份 API：一致性快照
    finalizeSnapshot(tmpAbs); // 收成单文件（去掉 WAL 边车），否则复制走的 .db 可能不完整
    verify = verifyDbFile(tmpAbs);
    renameSync(tmpAbs, finalAbs); // 同目录改名，NTFS 上原子；失败也不会毁掉已有备份
    removeSidecars(tmpAbs); // 改名后旧名字旁的 -wal/-shm
    removeSidecars(finalAbs);
  } catch (e) {
    removeSidecars(tmpAbs);
    try {
      rmSync(tmpAbs, { force: true });
    } catch {
      /* ignore */
    }
    throw new BackupFailure('BACKUP_FAILED', `备份失败：${msg(e)}`, 500);
  } finally {
    if (ownConn) {
      try {
        conn.close();
      } catch {
        /* ignore */
      }
    }
  }

  const sizeBytes = statSync(finalAbs).size;
  writeSidecar(finalAbs, {
    name,
    kind,
    createdAt: now.toISOString(),
    sizeBytes,
    note: opts.note ?? null,
    scope: 'db',
    verify,
  });

  if (!verify.ok) {
    console.warn(`[备份] ${name} 已生成但校验不通过，文件保留作为证据：${verify.errors.join('；')}`);
  } else {
    console.log(`[备份] ${KIND_LABEL[kind]}完成：${name}（${(sizeBytes / 1024).toFixed(0)} KB，工作台 ${verify.workbenchCount} 个）`);
  }

  let pruned: string[] = [];
  if (verify.ok && !opts.skipPrune) {
    pruned = pruneBackups(cfg, { newBackupOk: true }).deleted;
  }

  const info: BackupInfoWithCreated = {
    name,
    kind,
    kindLabel: KIND_LABEL[kind],
    createdAt: now.toISOString(),
    sizeBytes,
    note: opts.note ?? null,
    ok: verify.ok,
    verify,
    bad: !verify.ok,
    sidecarMissing: false,
    createdFile: true,
  };
  if (pruned.length) info.pruned = pruned;
  return info;
}

/* ============================ 保留策略（清理） ============================ */

export interface PruneResult {
  deleted: string[];
  kept: { daily: number; weekly: number; manual: number };
  /** 没删的原因（"新备份不可用，本次跳过清理"之类） */
  skippedReason: string | null;
}

/**
 * 保留策略：按天留 N 份、按周留 M 份，**周备优先保留**，超出部分按时间从最旧的开始删。
 *
 * 四条规矩，每条都是为了别把用户最后一条退路删掉：
 *   1. **清理只在"新备份已校验通过"之后发生**。新备份是坏的还去删旧的，等于把仅有的
 *      好备份删掉换个坏的回来。`newBackupOk=false` 时整轮跳过。
 *   2. **坏备份不参与清理**（`ok !== true` 的一律留着）：那是证据，只有用户手动删才消失。
 *   3. **手动备份永不被自动清理**：用户自己点的"立即备份"是他明确要留的东西。
 *   4. 任何情况下**至少留一份**备份。
 */
export function pruneBackups(cfg: BackupConfig, opts: { newBackupOk: boolean; dir?: string }): PruneResult {
  const dir = opts.dir ?? cfg.dir;
  const all = listBackups(dir);
  const kept = {
    daily: all.filter((b) => b.kind === 'daily').length,
    weekly: all.filter((b) => b.kind === 'weekly').length,
    manual: all.filter((b) => b.kind === 'manual').length,
  };
  if (!opts.newBackupOk) {
    return { deleted: [], kept, skippedReason: '刚做的备份没通过校验，本次不清理任何旧备份' };
  }
  // 只有"确认可用"的备份才是可删候选；坏的和没校验过的一律留着
  const usable = all.filter((b) => b.ok === true);
  if (!usable.length) {
    return { deleted: [], kept, skippedReason: '目录里没有可用备份（都还没校验过或是坏的），无需清理' };
  }
  const candidates: BackupInfo[] = [];
  for (const kind of ['daily', 'weekly'] as const) {
    const keep = kind === 'daily' ? cfg.keepDaily : cfg.keepWeekly;
    const rows = usable.filter((b) => b.kind === kind); // listBackups 已按时间倒序
    candidates.push(...rows.slice(Math.max(0, keep)));
  }
  // 安全阀：不许把最后一份可用备份删掉（只留残余空间，多出来的继续留着）
  const room = Math.max(0, usable.length - 1);
  const victims = candidates.slice(0, room);
  const deleted: string[] = [];
  const skippedReason = candidates.length > victims.length ? '清理后就不剩可用备份了，多出来的旧备份已保留' : null;
  for (const b of victims) {
    const abs = join(dir, b.name);
    try {
      removeSidecars(abs);
      unlinkSync(abs);
      try {
        unlinkSync(abs + SIDECAR_SUFFIX);
      } catch {
        /* 边车没了不影响 */
      }
      deleted.push(b.name);
      console.log(`[备份] 按保留策略清理旧备份：${b.name}（${b.kindLabel}）`);
    } catch (e) {
      console.warn(`[备份] 清理失败，保留 ${b.name}：${msg(e)}`);
    }
  }
  if (deleted.length) {
    kept.daily = listBackups(dir).filter((b) => b.kind === 'daily').length;
    kept.weekly = listBackups(dir).filter((b) => b.kind === 'weekly').length;
    kept.manual = listBackups(dir).filter((b) => b.kind === 'manual').length;
  }
  return { deleted, kept, skippedReason };
}

/** 手动删除一份备份（文件名 + 边车一起删）。前端负责二次确认。 */
export function deleteBackup(name: string): { deleted: string } {
  if (maintenance) throw new BackupFailure('RESTORE_RUNNING', '正在恢复数据，暂时不能删除备份', 409);
  const abs = resolveBackupPath(name);
  removeSidecars(abs);
  unlinkSync(abs);
  try {
    unlinkSync(abs + SIDECAR_SUFFIX);
  } catch {
    /* ignore */
  }
  console.log(`[备份] 已删除备份：${basename(abs)}`);
  return { deleted: basename(abs) };
}

/* ================================ 恢复 ================================ */

/**
 * 恢复期间的写闸门。
 *
 * `maintenance=true` 时，routes-core 里的 onRequest 钩子会给所有非 GET 的 /api 请求
 * 回 503；已经在跑的写请求则记在 inFlight 里，恢复前等它们跑完（最多 DRAIN_MS）。
 * 这样"停写"是真的停写，而不是"希望没有人在写"。
 */
let maintenance = false;
let restoring = false;
const inFlight = new Set<string>();

export function isRestoring(): boolean {
  return maintenance;
}

export function trackWriteStart(id: string): void {
  inFlight.add(id);
}

export function trackWriteEnd(id: string): void {
  inFlight.delete(id);
}

/** 等正在跑的写请求结束（排除发起恢复的那条请求自己） */
async function drainWrites(selfId: string | undefined, waitMs: number): Promise<{ waitedMs: number; others: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const others = [...inFlight].filter((id) => id !== selfId);
    if (others.length === 0) return { waitedMs: Date.now() - t0, others: 0 };
    await new Promise((r) => setTimeout(r, 50));
  }
  const others = [...inFlight].filter((id) => id !== selfId).length;
  /**
   * 只如实报告"还剩几个没结束"，**不在这里决定怎么办** ——
   * 调用方（`restoreBackup`）拿到 `others > 0` 会**中止恢复**，见那里的注释。
   */
  if (others) console.warn(`[恢复] 等 ${waitMs}ms 仍有 ${others} 个写请求没结束 → 中止本次恢复（不换库）`);
  return { waitedMs: Date.now() - t0, others };
}

/** 恢复日志：进程被杀之后，下次启动能知道"上一次恢复做到哪一步了" */
export interface RestoreJournal {
  phase: 'start' | 'pre-backed-up' | 'swapping' | 'swapped' | 'reopened';
  at: string;
  from: string;
  preRestore: string | null;
  dbFile: string;
  pid: number;
}

export function readRestoreJournal(dirOverride?: string): RestoreJournal | null {
  const file = join(dirOverride ?? loadBackupConfig().dir, 'restore-journal.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RestoreJournal;
  } catch {
    return null;
  }
}

function writeJournal(dir: string, data: RestoreJournal): void {
  try {
    ensureDir(dir);
    writeFileSync(join(dir, 'restore-journal.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[恢复] 恢复日志写不进去（不影响恢复本身）：${msg(e)}`);
  }
}

function clearJournal(dir: string): void {
  try {
    rmSync(join(dir, 'restore-journal.json'), { force: true });
  } catch {
    /* ignore */
  }
}

export interface RestoreReport {
  restored: string;
  restoredFrom: string;
  /** 恢复前自动给当前库做的那份备份 */
  preRestore: { name: string; ok: boolean; errors: string[] } | null;
  /** 恢复前当前库的工作台数量 */
  workbenchCountBefore: number | null;
  workbenchCountAfter: number | null;
  verify: BackupVerify;
  /** 新库打不开/校验失败时，有没有退回到恢复前那份 */
  rolledBack: boolean;
  drained: { waitedMs: number; blockedRequests: number };
  steps: string[];
  warnings: string[];
  finishedAt: string;
}

function countWorkbenches(absFile: string): number | null {
  try {
    const db = new DatabaseSync(absFile, { readOnly: true });
    try {
      return countLiveWorkbenches(db);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** 把 `from` 整个文件原子替换到 dbFile：先复制成同目录临时文件，再 rename */
function swapFile(from: string, dbFile: string): void {
  const tmp = `${dbFile}.restore-partial-${process.pid}`;
  try {
    copyFileSync(from, tmp);
    removeSidecars(dbFile); // 关库后残留的 -wal/-shm 若还在，会让 SQLite 拿旧 WAL 覆盖新库
    renameSync(tmp, dbFile);
    removeSidecars(tmp);
  } catch (e) {
    removeSidecars(tmp);
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * 换库失败时的"失败报告"：原因 + 现在是什么状态 + **可操作的下一步**。
 *
 * 为什么要把"恢复前那份备份的文件名与完整路径"写进消息里：换库失败属于"用户必须做点事"
 * 的一类故障（那一份原库还在，但用户不知道它在哪）。只报 `EPERM: operation not permitted, copyfile …`
 * 这种原始错误码，用户除了重启没有第二条路。这里把退路说死：
 *   ① 原库已重开 → 服务可以继续用；
 *   ② 恢复前自动备份的确切文件名 + 完整路径 → 数据真的不对时拿它恢复；
 *   ③ 数据库文件本身在哪 → 需要手工处理时知道动哪个文件。
 */
function restoreFailureMessage(reason: string, compensated: boolean, preName: string | null, dir: string, dbFile: string): string {
  const preAbs = preName ? join(dir, preName) : null;
  const lines = [
    `恢复失败：替换数据库文件时出错，数据库没有被替换。原因：${reason}`,
    compensated
      ? `已把原库重新打开并通过校验（数据保持恢复前的样子），工作台可以继续使用。`
      : `换库后重新打开原库也失败了（连接处于不完整状态：只读查询可能还能用，写入会报错）。` +
        `请重启工作台；重启仍不行时，按下面第 2 条手工把备份复制回去。`,
    preAbs
      ? `恢复前自动备份：${preName}（完整路径 ${preAbs}）`
      : `恢复前自动备份：没有生成（请检查备份目录是否可写：${dir}）`,
    `当前数据库文件：${dbFile}`,
    `下一步：先确认界面里的数据是否正确；若不正确，在「设置 → 备份」里选${preName ? ` ${preName} ` : '一份可用的备份'}重新恢复，` +
      `或停掉工作台进程后把${preAbs ? ` ${preAbs} ` : '备份文件'}复制回 ${dbFile}。`,
  ];
  return lines.join('\n');
}

/**
 * 一键恢复：把选定备份恢复到当前库。
 *
 * 完整流程（每一步都对应一个"防恢复错了就没退路"的措施）：
 *   ① 校验选中的备份 —— 坏备份一律拒绝恢复（不能让坏库覆盖好库）；
 *   ② **先给当前库做一份新备份**（kind=manual，备注"恢复前自动备份"）——
 *      这是"恢复错了还有退路"的实体；备份做不出来就中止，不碰库；
 *   ③ 开写闸门（非 GET 的 /api 请求回 503），并等正在跑的写请求结束；
 *      **等不到（超过 DRAIN_MS）就中止恢复**，绝不带着在跑的写入换库（见 ③④ 那段的注释）；
 *   ④ 写恢复日志（进程被杀时下次启动能看见）；
 *   ⑤ 关库（会把 WAL checkpoint 回主文件）→ 复制备份→原子改名替换 → 清掉残留 -wal/-shm；
 *      **替换失败也要把原库重新打开**（补偿），否则会出现"服务在跑、库却关着"的状态；
 *   ⑥ 重开库（顺带跑迁移，老备份也能用）→ 再校验（quick_check + foreign_key_check）；
 *      若新库打不开或校验不过，**退回恢复前那份**并如实报告；
 *   ⑦ 关写闸门、清恢复日志，报告工作台数量与校验结果。
 *
 * 两条保证（缺陷修复后的口径）：**任何失败路径都不会留下"库没开"的进程**；
 * `/api/health`、`/api/backups` 这类只读接口在恢复失败后照常可用。
 *
 * 用户文件（data/files）全程只读不动：本函数只碰数据库文件与备份目录。
 */
export async function restoreBackup(name: string, opts: { requestId?: string; dir?: string; drainMs?: number } = {}): Promise<RestoreReport> {
  if (restoring) throw new BackupFailure('RESTORE_BUSY', '已经有一次恢复在进行中，请等它结束', 409);
  const cfg = loadBackupConfig();
  const dir = opts.dir ?? cfg.dir;
  const steps: string[] = [];
  const warnings: string[] = [];
  const selfId = opts.requestId;

  const abs = resolveBackupPath(name, dir); // 不存在/名字不合法在这里就挡掉
  const snapName = basename(abs);

  // ① 恢复源必须是好备份
  const snapVerify = verifyDbFile(abs);
  steps.push(`校验待恢复的备份 ${snapName}：${snapVerify.ok ? '通过' : '不通过'}`);
  if (!snapVerify.ok) {
    throw new BackupFailure('BACKUP_BAD', `这份备份本身没通过校验，不能用来恢复（避免用坏库盖掉好库）：${snapVerify.errors.join('；')}`);
  }
  const countBefore = countWorkbenches(DB_FILE);
  const countInSnapshot = snapVerify.workbenchCount;

  // ② 恢复前先备份当前库 —— 顺序上必须在这里，且失败就中止
  restoring = true;
  let preName: string | null = null;
  let preOk = false;
  let preErrors: string[] = [];
  try {
    const pre = await createBackup({ kind: 'manual', note: `恢复前自动备份（即将恢复到 ${snapName}）`, dir, skipPrune: true });
    preName = pre.name;
    preOk = pre.ok === true;
    preErrors = pre.verify?.errors ?? [];
    steps.push(`恢复前已把当前库备份为 ${pre.name}：${preOk ? '校验通过' : '校验未通过（当前库可能本来就有问题，仍继续恢复）'}`);
    if (!preOk) warnings.push(`当前库的备份 ${pre.name} 没通过校验：${preErrors.join('；')}`);
  } catch (e) {
    restoring = false;
    throw new BackupFailure('PRE_BACKUP_FAILED', `恢复前给当前数据做备份失败，已中止恢复（当前库没有被改动）：${msg(e)}`, 500);
  }

  // ③④ 停写 + 写日志
  maintenance = true;
  let drained = { waitedMs: 0, others: 0 };
  try {
    drained = await drainWrites(selfId, opts.drainMs ?? DRAIN_MS);
    /**
     * 【决定】等不到"没人写"就**中止恢复**，不再"警告一句然后照换"。
     *
     * 老行为是超时后继续换库，那等于在一个正在写库的进程底下把数据库文件换掉：
     * 那条写请求的语句可能落到"已经被替换掉的文件"上（写进一个马上就要被丢掉的文件），
     * 也可能在关库瞬间拿到「数据库尚未初始化」而 500。用户会同时看到
     * "一次来源不明的失败" 和 "恢复后的库里少了刚才那次写入"，两者都很难排查。
     *
     * 恢复本来就该在"没人写"的时候做，所以这里的口径是：**宁可让用户过几秒重试，
     * 也不要在写入中途换库**。等待上限（`DRAIN_MS`，默认 3 秒）不变，只是把
     * "等不到就硬来"改成"等不到就停手"—— 中止时库**一个字节都没被碰过**
     * （关库/换库都还没开始），`maintenance`/`restoring` 与恢复日志都会复位。
     */
    if (drained.others > 0) {
      throw new BackupFailure(
        'RESTORE_BUSY',
        `还有 ${drained.others} 个写请求没有结束（已等待 ${drained.waitedMs}ms），为保证数据完整，本次恢复已中止，数据库没有被改动。` +
          `请等这几秒的写入做完（或停掉正在跑的任务）后重新发起恢复。` +
          (preName ? `（本次已额外生成一份恢复前自动备份 ${preName}，它只是备份，不代表恢复执行过。）` : ''),
        409,
      );
    }
    steps.push(`已停止写入：等待在跑的写请求 ${drained.waitedMs}ms，期间拒绝新的写请求`);
    writeJournal(dir, { phase: 'swapping', at: isoNow(), from: snapName, preRestore: preName, dbFile: DB_FILE, pid: process.pid });
  } catch (e) {
    maintenance = false;
    restoring = false;
    clearJournal(dir);
    throw e;
  }

  let verify: BackupVerify;
  let rolledBack = false;
  /**
   * ⑤⑥ 关库 → 换库 → 重开 → 再校验。
   *
   * 【为什么要"补偿"】`swapFile` 是纯文件操作，在 Windows 上完全可能失败：目标库文件被
   * 别的进程以"不允许改名/删除"的方式占着、或文件本身是只读的（`attrib +R`、同步盘/杀软
   * 加上的属性）时，`renameSync` 会抛 EPERM/EBUSY（实测只读文件必抛 EPERM）。
   * 老代码让这个异常直接穿过 `finally`，而 `finally` 只复位 `maintenance`/`restoring` 与清日志，
   * **没有重开原库** —— 于是进程还在跑、DB 连接却已经是 null：所有数据接口 500
   * 「数据库尚未初始化」，恢复状态却显示已结束，用户只能重启进程。
   *
   * 所以这里保证一条铁律：**只要关过库，无论换库成功还是失败，离开这段时库一定是开着的**
   * （成功 = 新库；失败 = 原库），并且失败时给出"文件在哪、下一步做什么"。
   */
  try {
    // ⑤ 关库 → 原子替换
    closeDatabase();
    try {
      swapFile(abs, DB_FILE);
    } catch (swapErr) {
      /**
       * 换库失败：原库文件**没有被改动**（`swapFile` 只往同目录写临时文件，失败时自己清掉），
       * 所以补偿动作就是"把原库重新打开并再校验一遍"，让服务回到发起恢复之前的状态。
       */
      const reason = msg(swapErr);
      // 下面这条路径是"抛错结束"，steps/warnings 不会被返回，所以信息全部进错误消息
      let compensated = false;
      /** 补偿自身的失败**必须留下明确日志**：此时"库没开"这件事会直接影响所有数据接口 */
      try {
        initDatabase(DB_FILE); // 重开原库（老库缺表/缺列时顺带补迁移）
        verify = verifyDbFile(DB_FILE);
        compensated = verify.ok;
        if (compensated) {
          console.log(`[恢复] 换库失败，已把原库重新打开并通过校验（工作台 ${verify.workbenchCount} 个），服务继续可用`);
        } else {
          console.error(`[恢复] 换库失败后原库重新打开但校验不通过：${verify.errors.join('；')}`);
        }
      } catch (e) {
        compensated = false;
        const compErr = msg(e);
        verify = {
          ok: false,
          quickCheck: '',
          foreignKeyCheck: -1,
          workbenchCount: null,
          checkedAt: isoNow(),
          durationMs: 0,
          errors: [`换库失败后重新打开原库也失败：${compErr}`],
        };
        console.error(`[恢复] 换库失败后重新打开原库也失败：${compErr}（库文件 ${DB_FILE}）`);
      }
      throw new BackupFailure('RESTORE_SWAP_FAILED', restoreFailureMessage(reason, compensated, preName, dir, DB_FILE), 500);
    }
    steps.push(`已用备份替换当前数据库文件（${DB_FILE}）`);

    // ⑥ 重开并校验
    let reopened = false;
    try {
      initDatabase(DB_FILE); // 老备份缺新表/新列时在这里补齐
      verify = verifyDbFile(DB_FILE);
      reopened = verify.ok;
    } catch (e) {
      verify = {
        ok: false,
        quickCheck: '',
        foreignKeyCheck: -1,
        workbenchCount: null,
        checkedAt: isoNow(),
        durationMs: 0,
        errors: [`恢复后打开数据库失败：${msg(e)}`],
      };
    }
    if (!reopened) {
      steps.push(`恢复后的库校验不通过：${verify.errors.join('；')}`);
      if (!preOk || !preName) {
        warnings.push('恢复后的库有问题，而恢复前的自动备份也不可用，无法自动退回，请手工处理备份目录里的文件。');
      } else {
        try {
          closeDatabase();
          swapFile(join(dir, preName), DB_FILE);
          initDatabase(DB_FILE);
          const check = verifyDbFile(DB_FILE);
          rolledBack = true;
          steps.push(`已退回恢复前的那份备份 ${preName}：${check.ok ? '校验通过' : '校验仍不通过'}`);
          warnings.push(`这次恢复没能成功，已自动退回恢复前的数据（${preName}）。`);
          verify = check;
        } catch (e) {
          /**
           * 退回也失败：此时库是关着的、磁盘上是那份"新但没通过校验"的库。
           * 同一条铁律 —— **不能留着"服务在跑、库却关着"**：先把磁盘上这个文件重新打开，
           * 让数据接口至少不是一片 500（它校验没过，但能打开，比完全不可用强），
           * 再把"文件在哪、下一步做什么"写清楚。
           */
          const backErr = msg(e);
          let reopenedAnyway = false;
          try {
            initDatabase(DB_FILE);
            reopenedAnyway = true;
          } catch (e2) {
            console.error(`[恢复] 退回失败后重新打开 ${DB_FILE} 也失败：${msg(e2)}`);
          }
          console.error(`[恢复] 退回恢复前的备份失败：${backErr}；当前 ${DB_FILE} 重新打开${reopenedAnyway ? '成功' : '失败'}`);
          warnings.push(
            `退回恢复前的备份也失败了：${backErr}。` +
              (reopenedAnyway
                ? `已把当前库（这份校验没通过的库）重新打开，界面还能用但不保证数据正确。`
                : `当前库也打不开，数据接口会一直报错。`) +
              `下一步：重启工作台；重启后若数据不对，把 ${join(dir, preName)} 复制回 ${DB_FILE}（先停掉工作台进程，必要时把 ${DB_FILE} 改名留作证据）。`,
          );
        }
      }
    } else {
      steps.push(`恢复后的库校验通过（工作台 ${verify.workbenchCount} 个）`);
    }
  } finally {
    maintenance = false;
    restoring = false;
    clearJournal(dir);
  }

  const countAfter = countWorkbenches(DB_FILE);
  if (countInSnapshot !== null && countAfter !== null && countInSnapshot !== countAfter) {
    warnings.push(`备份里记的是 ${countInSnapshot} 个工作台，恢复后读到 ${countAfter} 个，请核对。`);
  }
  if (countBefore !== null && countAfter !== null && countBefore !== countAfter) {
    steps.push(`工作台数量：恢复前 ${countBefore} 个 → 恢复后 ${countAfter} 个`);
  }
  console.log(`[恢复] ${snapName} → ${DB_FILE}：${verify.ok ? '成功' : '有问题'}${rolledBack ? '（已退回）' : ''}`);

  return {
    restored: snapName,
    restoredFrom: abs,
    preRestore: preName ? { name: preName, ok: preOk, errors: preErrors } : null,
    workbenchCountBefore: countBefore,
    workbenchCountAfter: countAfter,
    verify,
    rolledBack,
    drained: { waitedMs: drained.waitedMs, blockedRequests: drained.others },
    steps,
    warnings,
    finishedAt: isoNow(),
  };
}

/* ============================== 定时自动备份 ============================== */

export interface SchedulePlan {
  daily: boolean;
  weekly: boolean;
  reason: string;
}

/** 本地日期（YYYY-MM-DD），用于"今天备过没有"的判断 */
function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return dateOnly(d);
}

/**
 * 本周的起点：最近一次「weeklyDay 那天的 hour 点」（含边界），本地时间。
 * 周备的语义是"一周至少一份"：到了新的一周、且时间点过了，第一次跑到就补一份周备，
 * 这样机器那天没开机也不会整周缺一份。
 */
function weekStart(now: Date, cfg: BackupConfig): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cfg.hour, 0, 0, 0);
  // getDay()：0=周日；往回退到最近的 weeklyDay
  const back = (d.getDay() - cfg.weeklyDay + 7) % 7;
  d.setDate(d.getDate() - back);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d;
}

/**
 * 纯函数：现在这一刻该不该做日备/周备。
 * 抽出来是为了能直接测（不用等真的到凌晨三点），定时器只负责调用它。
 *
 * 日备的"今天备过了"判定有个例外：**今天备份全是坏的**时会重试，但最多 MAX_DAILY_ATTEMPTS 次。
 * 不重试的话（坏的那份也算"备过了"）今天就没有可用备份；无限重试的话，坏备份不参与自动清理，
 * 每 5 分钟一份会把磁盘塞满。折中是"最多补 3 次"，之后交给用户在界面点「立即备份」。
 */
export function planScheduledBackup(now: Date, items: BackupInfo[], cfg: BackupConfig): SchedulePlan {
  if (now.getHours() < cfg.hour) {
    return { daily: false, weekly: false, reason: `还没到备份时间（${cfg.hour} 点）` };
  }
  const today = dateOnly(now);
  const todays = items.filter((b) => b.kind === 'daily' && localDay(b.createdAt) === today);
  const dailyDone = todays.some((b) => b.ok !== false); // 只知道坏（ok=false）才算"没备成"
  const ws = weekStart(now, cfg).getTime();
  const weeklyDone = items.some((b) => b.kind === 'weekly' && Date.parse(b.createdAt) >= ws);
  const daily = !dailyDone && todays.length < MAX_DAILY_ATTEMPTS;
  const weekly = !weeklyDone;
  const bits: string[] = [];
  if (dailyDone) bits.push('今天的日备已经有了');
  else if (todays.length >= MAX_DAILY_ATTEMPTS) bits.push(`今天已经有 ${todays.length} 份日备但都没通过校验，不再自动重试（请在设置页手动备份）`);
  if (weeklyDone) bits.push('本周的周备已经有了');
  return { daily, weekly, reason: bits.length ? bits.join('；') : '日备与周备都需要补一份' };
}

export interface TickResult {
  auto: boolean;
  plan: SchedulePlan | null;
  created: { name: string; kind: BackupKind; ok: boolean }[];
  pruned: string[];
  skippedReason: string | null;
  at: string;
}

let tickRunning = false;
export function isBackupTickRunning(): boolean { return tickRunning; }

/** 跑一轮"到点了吗"的判断；定时器与命令行/测试都走这里 */
export async function runBackupTick(now: Date = new Date(), dirOverride?: string): Promise<TickResult> {
  const cfg = loadBackupConfig();
  const dir = dirOverride ?? cfg.dir;
  const base: TickResult = { auto: cfg.auto, plan: null, created: [], pruned: [], skippedReason: null, at: isoNow() };
  if (!cfg.auto) return { ...base, skippedReason: '自动备份已关闭' };
  if (tickRunning) return { ...base, skippedReason: '上一轮还在跑' };
  tickRunning = true;
  try {
    const items = listBackups(dir);
    const plan = planScheduledBackup(now, items, cfg);
    base.plan = plan;
    const kinds: BackupKind[] = [];
    if (plan.daily) kinds.push('daily');
    if (plan.weekly) kinds.push('weekly');
    if (!kinds.length) return { ...base, skippedReason: plan.reason };

    let allOk = true;
    for (const kind of kinds) {
      const info = await createBackup({ kind, note: '自动备份', now, dir, skipPrune: true });
      base.created.push({ name: info.name, kind, ok: info.ok === true });
      if (info.ok !== true) allOk = false;
    }
    // 恢复/清理的前提是"新备份确认可用"
    const prune = pruneBackups(cfg, { newBackupOk: allOk, dir });
    base.pruned = prune.deleted;
    base.skippedReason = prune.skippedReason;
    return base;
  } finally {
    tickRunning = false;
  }
}

let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;

/**
 * 启动进程内定时器。
 *
 * **无条件起定时器**：开关由每一轮的 `runBackupTick` 现读 `cfg.auto`（它自己会返回
 * "自动备份已关闭"），所以界面上勾掉/勾上、改配置文件、改环境变量都在下一轮（≤5 分钟）生效，
 * 不用重启。
 *
 * 早先的写法是"启动时读到 auto=false 就干脆不起定时器"，于是**用户在界面上把自动备份重新打开
 * 也不会生效**（要重启才行，而保存时的提示写着"立即按新配置运行"）—— 这与"界面写 backup.* 却
 * 读裸键"是同一类缺陷（界面声称能设、实际不生效），一起修掉。auto 关着时多跑一个每 5 分钟
 * 立即返回的空判断，代价可以忽略。
 *
 * 测试模式（WORKBENCH_TEST_MODE=1）**不启动**：回归测试用的是临时库，
 * 自动备份会往真实项目的 data/backups 里写文件，那是污染。
 * 定时器 `unref()`：它不应该拦住进程退出。
 */
export function startBackupScheduler(): void {
  // 桌面启动器不创建备份定时器；手动备份仍由用户在界面触发。
  if (process.env.WORKBENCH_START_ONLY === '1') return;
  if (timer) return;
  if (process.env.WORKBENCH_TEST_MODE === '1') {
    console.log('[备份] 测试模式：不启动自动备份定时器');
    return;
  }
  const cfg = loadBackupConfig();
  const tick = (): void => {
    void runBackupTick().catch((e: unknown) => console.warn(`[备份] 自动备份出错（不影响服务）：${msg(e)}`));
  };
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  firstTimer = setTimeout(tick, FIRST_TICK_MS);
  firstTimer.unref?.();
  if (cfg.auto) {
    console.log(`[备份] 自动备份已开启：每天 ${cfg.hour} 点后首次运行；保留日备 ${cfg.keepDaily} 份 / 周备 ${cfg.keepWeekly} 份；目录 ${cfg.dir}`);
  } else {
    console.log('[备份] 自动备份当前是关闭的（backup.auto = false）：定时器在跑但不备份，界面/配置文件打开后下一轮即生效');
  }
}

export function stopBackupScheduler(): void {
  if (timer) clearInterval(timer);
  if (firstTimer) clearTimeout(firstTimer);
  timer = null;
  firstTimer = null;
}

/* ============================== 概览（给界面） ============================== */

export interface BackupOverview {
  dir: string;
  dbFile: string;
  scope: 'db';
  restoring: boolean;
  config: {
    auto: boolean;
    hour: number;
    keepDaily: number;
    keepWeekly: number;
    weeklyDay: number;
    dirRaw: string;
    origin: BackupConfig['origin'];
  };
  items: BackupInfo[];
  lastRestoreInterrupted: RestoreJournal | null;
}

export function backupOverview(): BackupOverview {
  const cfg = loadBackupConfig();
  return {
    dir: cfg.dir,
    dbFile: DB_FILE,
    scope: 'db',
    restoring: maintenance,
    config: {
      auto: cfg.auto,
      hour: cfg.hour,
      keepDaily: cfg.keepDaily,
      keepWeekly: cfg.keepWeekly,
      weeklyDay: cfg.weeklyDay,
      dirRaw: cfg.dirRaw,
      origin: cfg.origin,
    },
    items: listBackups(cfg.dir),
    lastRestoreInterrupted: readRestoreJournal(cfg.dir),
  };
}

/** 供命令行/排查用：直接指明一个库文件做一致性快照（不依赖进程内连接） */
export async function createBackupOfFile(opts: { dbFile: string; dir: string; kind?: BackupKind; note?: string; now?: Date }): Promise<BackupInfoWithCreated> {
  const conn = new DatabaseSync(opts.dbFile);
  try {
    return await createBackup({ kind: opts.kind, note: opts.note, dir: opts.dir, now: opts.now, source: conn, skipPrune: true });
  } finally {
    try {
      conn.close();
    } catch {
      /* ignore */
    }
  }
}

/** 备份目录是否已建好（界面第一次打开时给个提示） */
export function backupDirExists(dirOverride?: string): boolean {
  try {
    return statSync(dirOverride ?? loadBackupConfig().dir).isDirectory();
  } catch {
    return false;
  }
}

/** 仅内部使用：确保目录存在（打包/命令行调用前） */
export function ensureBackupDir(dirOverride?: string): string {
  const dir = dirOverride ?? loadBackupConfig().dir;
  assertDirOk(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}
