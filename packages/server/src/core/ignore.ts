/**
 * 忽略名单 —— 扫描用户目录时，哪些名字不进去看（契约 §1 决定 6、§7.6）。
 *
 * 两处用途：
 *   1. 统计知识库来源目录（`api/routes-kb.ts` 的 `/api/kb/sources/:id/scan`）时跳过
 *      AI 工具产物、临时目录、回收站；
 *   2. 以后「登记/纳管用户目录里的文件」共用同一份规则 —— 各写一套的话，
 *      「统计出来的文件数」和「扫出来的文件」永远对不上。
 *
 * 三条约定：
 *   - **点开头的名字一律忽略**（`.workbuddy`、`.git`、`.DS_Store`…）。这条是硬的：
 *     名单里加什么都不影响它，用户也无法通过配置把它关掉 —— 排除其它 AI 工具产物
 *     是决定 6 的明确要求，不能被一次误配置废掉。
 *   - 内置名单见 `BUILTIN_IGNORE`；用户可以在 `app_setting` 的 `scan.ignore` 里用
 *     逗号分隔**追加**更多名字（大小写不敏感，逐段匹配）。
 *   - 这里**只读** `scan.ignore` 这一项设置，**不注册设置项** —— 配置项注册在
 *     `core/config.ts` 的 `DEFAULT_SETTINGS`（由别人负责）；读不到就直接用内置默认。
 */
import { getSetting } from './config.ts';

/** 内置忽略名（小写比较）。点开头的名字不在这里 —— 那是硬规则，见 `isIgnoredName`。 */
export const BUILTIN_IGNORE: readonly string[] = [
  'tmp',
  'output',
  'node_modules',
  '$recycle.bin',
  'system volume information',
  // 系统/Office 垃圾文件：不是内容，留着只会让统计数字虚高
  'thumbs.db',
  'desktop.ini',
];

/** 用户在 `app_setting` 里追加的名单（逗号分隔；也容忍分号、顿号、换行） */
const SETTING_KEY = 'scan.ignore';

/**
 * 缓存：`isIgnoredName` 会被逐条目调用（两万个文件就是两万次），
 * 每次都去查一次 app_setting 太亏；但也不能整个进程只读一次 ——
 * 用户改了设置总得生效。折中：最多每 2 秒回查一次数据库。
 */
const CACHE_TTL_MS = 2000;
let cache: { at: number; names: Set<string> } | null = null;

/** 读取并拆开用户配置的追加名单；读不到（表还没建好、没这项设置）就返回空 */
function extraNames(): string[] {
  let raw: unknown;
  try {
    raw = getSetting<unknown>(SETTING_KEY, '');
  } catch {
    return [];
  }
  if (raw === null || raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw.map((x) => String(x)) : String(raw).split(/[,;，、\r\n]+/);
  return parts.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 当前生效的名字集合（内置 + 用户追加），带 2 秒缓存 */
function nameSet(): Set<string> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.names;
  const names = new Set<string>(BUILTIN_IGNORE);
  for (const n of extraNames()) names.add(n);
  cache = { at: now, names };
  return names;
}

/** 当前生效的忽略名单（内置 + 用户追加，去重后的副本） */
export function ignoreList(): string[] {
  return [...nameSet()];
}

/**
 * 只要名字命中就忽略。
 *
 * 注意：点开头的名字（`.workbuddy` 等）**不在** `ignoreList()` 里，
 * 因为那条规则是「前缀」而不是某个具体名字，且不可被配置关闭。
 */
export function isIgnoredName(name: string): boolean {
  const n = String(name ?? '').trim();
  if (!n) return false;
  if (n.startsWith('.')) return true;
  return nameSet().has(n.toLowerCase());
}

/**
 * 相对路径逐段判断，任一段命中即忽略。
 * 同时兼容 `\` 与 `/`（用户的目录里两种分隔符都会出现）。
 */
export function isIgnoredRelPath(rel: string): boolean {
  const raw = String(rel ?? '').replace(/\\/g, '/');
  if (!raw) return false;
  return raw.split('/').some((seg) => seg !== '' && seg !== '.' && isIgnoredName(seg));
}
