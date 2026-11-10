/**
 * 命名与路径规范 —— 全系统唯一的命名来源，禁止在别处手写文件名。
 * 规范见 docs/01-系统设计.md 第 3 节。
 */
import { assertTestWrite } from './test-isolation.ts';
import { assertNoPathLinks } from './path-boundary.ts';
export { assertNoPathLinks } from './path-boundary.ts';
import { createHash } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { DATA_ROOT, INSTALL_ROOT, LOG_DIR, RUNTIME_ROOT, WEB_DIST, RUNTIME_LAYOUT } from './config.ts';

/** 统一存正斜杠，跨平台、跨同步盘都一致 */
export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function stamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function isoNow(d: Date = new Date()): string {
  return d.toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
}

export function dateOnly(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 文件名安全化：去掉 Windows 非法字符，压缩空白。
 * 保留中文、字母、数字、下划线、连字符、括号、点。
 */
export function safeName(input: string, fallback = '未命名'): string {
  const cleaned = (input ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  const result=cleaned || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result) ? '_'+result : result;
}

export function ensureDir(dir: string): string {
  assertTestWrite(dir);
  assertNoPathLinks(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** code 用：把中文转拼音成本高，这里只做安全化 + 空格转连字符 */
export function slug(input: string): string {
  return safeName(input)
    .replace(/\s+/g, '-')
    .replace(/[^0-9A-Za-z\u4e00-\u9fff-]/g, '')
    .toLowerCase()
    .slice(0, 60);
}

/**
 * 防目录穿越：把相对路径解析到根目录内，越界抛错。
 */
export function resolveInside(root: string, rel: string): string {
  const abs = resolve(root, isAbsolute(rel) ? relative(root, rel) : rel);
  const r = resolve(root);
  if (abs !== r && !abs.startsWith(r + sep)) {
    throw new Error(`路径越界，拒绝访问：${rel}`);
  }
  assertNoPathLinks(abs);
  return abs;
}

/** lstat checks directory entries without reading cloud placeholder contents.
 * Reject links/junctions including ancestors and dangling links before IO.
 * Missing leaf directories are allowed so a new output can be created safely.
 */

export function relFrom(root: string, abs: string): string {
  return toPosix(relative(resolve(root), resolve(abs)));
}

/* ------------------------- 允许根白名单（目录绑定） ------------------------- */

/**
 * 目录绑定后的路径白名单 —— **带用途（授权）的根列表**。
 *
 * 绑定前每个读写点都写死 `resolveInside(DATA_ROOT, rel)`：文件只能落在数据目录里。
 * 绑定后工作台要在用户自己的文件夹里工作，于是把「唯一根」放宽成「允许根白名单」：
 *
 *     DATA_ROOT + 所有已绑定工作台的 external_root
 *
 * 【本次改造】以前这一个列表同时当**读、写、移动、删除**的闸门，于是
 * 「用户的只读来源（iCloud 原件、改绑之后的历史目录）」和「平台自己的可写产物区」
 * 拿到的是同一份授权：只要能读到，就能就地生成、改名、删除。现在每个根带一个 `purpose`，
 * 四种动作**分别**判（见下面的 RootPurpose / canUse / assertUsable）。
 *
 * 这一层只负责**路径与用途**，不负责「谁绑了谁」——绑定变更由调用方
 * （启动时 / 绑定接口）调 `setRootGrants()` 刷新，避免这里反向依赖数据库。
 *
 * 三个刻意的设计：
 *   1. `isInsideRoot` 用 `relative()` 判断，不用 `abs.startsWith(root)`。
 *      字符串前缀会把 `D:\data2` 当成 `D:\data` 内部（越界放行），是真实的越权路径；
 *      `relative()` 是纯字符串运算，跨盘时 Windows 会返回绝对路径，正好判为「不在内部」。
 *   2. 全程用 `resolve()` 规范化，**不做 `realpathSync`**：iCloud / OneDrive 的占位文件
 *      读一下就可能触发下载，而且绑定目录可能暂时不可达（拔掉的移动盘），
 *      不能因为「现在摸不到」就把路径判成非法。
 *   3. 平台自己的目录（安装目录 / 运行目录 / 数据目录 / 备份目录）单独成一类
 *      「受保护根」：绑定它们**或它们的祖先**都被拒绝（见 `isPlatformProtected`）。
 */

/**
 * 根的**用途**（谁可以在这里做什么）。
 *
 *   platform  平台数据目录（DATA_ROOT）——平台自己的家当，读 / 写 / 移动 / 删除全开
 *   writable  当前绑定的资料目录（**可写产物区**）——平台可以就地生成、纳管、删除它登记过的文件
 *   readonly  **只读来源**——只能读。历史绑定目录（改绑之后老记录仍指向那里）、
 *             用户在 `binding.readonly_roots` 里显式声明的来源、以及进程写不进去的目录
 *             （iCloud 占位 / 只读盘 / 只读共享）都归到这一类。
 *             **里面的文件一律不许 unlink / rename / 写入**（平台产物只落在可写区）。
 */
export type RootPurpose = 'platform' | 'writable' | 'readonly';

/** 一次授权动作。读、写、移动、删除分别判 —— 不要用一句话概括成「允许访问」 */
export type RootAction = 'read' | 'write' | 'move' | 'delete';

export interface RootGrant {
  root: string;
  purpose: RootPurpose;
}

const ACTION_LABEL: Record<RootAction, string> = {
  read: '读取',
  write: '写入',
  move: '移动/改名',
  delete: '删除',
};

/**
 * **安全阀拒绝**（不是故障）：只读来源不许写/改名/删、指纹不符、被别的存活记录引用、
 * 想删绑定根本身……这些都是"平台按规则拒绝了这次动作"，要说清楚原因，但**不是 500**。
 *
 * 单独一个类是为了让调用方能把它与真实 IO 错误（EPERM/EBUSY/文件被占用）分开：
 *   · 删除路径上遇到它 → 跳过磁盘那一份、照常移动记录，并把原因回报给用户；
 *   · 写路径上遇到它 → 400 + 中文原文，界面直接显示"这是只读来源"，不是"服务出错了"。
 */
export class SafetyRefusal extends Error {
  statusCode = 400;
}

/** 外部根的稳定身份前缀：`ext:<规范化路径>`。见 `rootIdFor()` */
const EXT_ROOT_ID_PREFIX = 'ext:';

/** 数据根的稳定身份。存量记录（root_kind='data'）迁移成它，读路径按它取 DATA_ROOT */
export const DATA_ROOT_ID = 'data';

/** 当前绑定的外部根（可写产物区） */
let boundGrants: RootGrant[] = [];
/** 显式声明的只读来源（`binding.readonly_roots`） */
let readonlyRoots: string[] = [];
/** 额外的平台受保护根（备份目录这类要算出来才知道的地方） */
let extraProtectedRoots: string[] = [];

/** 允许根列表（含 DATA_ROOT 与只读来源），按规范化路径去重后返回副本 */
export function getBoundRoots(): string[] {
  return grantList().map((g) => g.root);
}

/**
 * 刷新外部绑定根（绝对路径，已规范化）。只写库的调用方用它 —— 这些根一律「可写产物区」。
 * 传进来的路径里若混入 DATA_ROOT，会被去重掉；非绝对路径 / 盘根一律忽略。
 */
export function setBoundRoots(roots: string[]): void {
  setRootGrants((roots ?? []).map((root) => ({ root, purpose: 'writable' as const })));
}

/** 显式声明只读来源（绝对路径；非绝对路径 / 盘根忽略） */
export function setReadonlyRoots(roots: string[]): void {
  readonlyRoots = (roots ?? []).map(normalizeRoot).filter((r): r is string => r !== null);
}

/**
 * 一次性刷新根的用途表。
 * `purpose='readonly'` 的项进只读来源，其余进可写绑定列表（顺序 = 优先级，同名根先到先得）。
 */
export function setRootGrants(grants: RootGrant[]): void {
  const writable: RootGrant[] = [];
  const readonly: string[] = [];
  for (const g of grants ?? []) {
    const root = normalizeRoot(g?.root ?? '');
    if (!root) continue;
    if (g.purpose === 'readonly') readonly.push(root);
    else writable.push({ root, purpose: g.purpose === 'platform' ? 'writable' : g.purpose });
  }
  boundGrants = writable;
  readonlyRoots = readonly;
}

/**
 * 平台自己的根：**绑定它们、或绑定它们的祖先**都必须被拒绝。
 *
 * 以前的判断只看「选中的目录是不是在 DATA_ROOT 内部」，于是绑定 DATA_ROOT 的**祖先**
 * （例如整个 `D:\project\工作台`）会被放行 —— 平台自己的库、备份、运行目录随后就成了
 * 某个工作台的「用户文件」，可以被彻底删除真删。所以这里两个方向都查。
 */
export function platformProtectedRoots(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | null | undefined): void => {
    const n = normalizeRoot(p ?? '');
    if (!n) return;
    const key = rootKey(n);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  push(INSTALL_ROOT);
  push(RUNTIME_LAYOUT.codeRoot);
  push(DATA_ROOT);
  push(RUNTIME_ROOT);
  push(LOG_DIR);
  push(WEB_DIST);
  for (const r of extraProtectedRoots) push(r);
  return out;
}

/** 额外的平台受保护根（备份目录由 domain/service.ts 算出来注入） */
export function setExtraProtectedRoots(roots: string[]): void {
  extraProtectedRoots = (roots ?? []).map(normalizeRoot).filter((r): r is string => r !== null);
}

/**
 * `abs` 是不是平台自己的地方：**在受保护根内部，或是受保护根的祖先**。
 * 双向包含是这次修复的关键（单向只挡住了「绑定数据目录内部」）。
 */
export function isPlatformProtected(abs: string): boolean {
  const a = normalizeRoot(abs);
  if (!a) return false;
  for (const root of platformProtectedRoots()) {
    if (isInsideRoot(root, a)) return true; // 平台目录内部
    if (isInsideRoot(a, root)) return true; // 平台目录的祖先（整块盘 / 项目根）
  }
  return false;
}

/** 命中哪条平台受保护根（给错误信息用）；不在任何受保护根里返回 null */
export function platformProtectedRootOf(abs: string): string | null {
  const a = normalizeRoot(abs);
  if (!a) return null;
  for (const root of platformProtectedRoots()) {
    if (isInsideRoot(root, a)) return root;
    if (isInsideRoot(a, root)) return root;
  }
  return null;
}

/** 备份目录这类受保护根的直接判定（供绑定校验给一句明确的话） */
export function assertNotPlatformProtected(abs: string, what = '目录'): void {
  const hit = platformProtectedRootOf(abs);
  if (!hit) return;
  throw new Error(`这是平台自己的${isInsideRoot(hit, abs) ? '目录' : '上级目录'}（${hit}），不能把${what}绑成工作台资料目录：${abs}`);
}

/**
 * 目录现在可写吗（`accessSync(W_OK)`）。
 * 只读介质 / iCloud 占位 / 没权限的共享在这里就是 false —— 那种目录只能当**只读来源**：
 * 平台不往里写产物，也不删里面的原件（否则报错会晚到"写文件那一刻"，用户对不上原因）。
 * 目录不存在时返回 false（那时它既不可读也不可写）。
 */
export function isDirWritable(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 允许根 + 用途（Deepest 优先由 `grantOf` 负责，这里只给去重后的表） */
export function listRootGrants(): RootGrant[] {
  return grantList().map((g) => ({ ...g }));
}

/** 每个根最多作用一次：DATA_ROOT 是 platform；显式只读声明优先于绑定 */
function grantList(): RootGrant[] {
  const out: RootGrant[] = [];
  const seen = new Set<string>();
  const push = (root: string, purpose: RootPurpose): void => {
    const key = rootKey(root);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ root, purpose });
  };
  const data = normalizeRoot(DATA_ROOT);
  if (data) push(data, 'platform');
  for (const r of readonlyRoots) {
    const n = normalizeRoot(r);
    if (!n) continue;
    // 声明在平台数据目录内部的"只读根"没有意义（那整块是平台自己的可写区），忽略
    if (data && isInsideRoot(data, n)) continue;
    push(n, 'readonly');
  }
  for (const g of boundGrants) {
    const n = normalizeRoot(g.root);
    if (!n) continue;
    push(n, g.purpose);
  }
  return out;
}

/**
 * `abs` 是否在 `root` 内部。
 * 跨盘（Windows 的 `relative()` 会返回绝对路径）、末尾分隔符、`..`、大小写差异都已处理。
 */
export function isInsideRoot(root: string, abs: string): boolean {
  const r = normalizeRoot(root);
  const a = normalizeRoot(abs);
  if (!r || !a) return false;
  const rel = relative(r, a);
  if (rel === '') return true; // 就是根本身
  if (rel.startsWith(`..${sep}`) || rel === '..') return false;
  if (isAbsolute(rel)) return false; // 跨盘
  return true;
}

/** `abs` 命中哪个允许根；都不命中返回 null。根之间有嵌套时取更深的那个。 */
export function rootOf(abs: string): { root: string; kind: 'data' | 'external' } | null {
  const hit = grantOf(abs);
  return hit ? { root: hit.root, kind: hit.purpose === 'platform' ? 'data' : 'external' } : null;
}

/** 同上，但带**用途**（授权判定的入口）。根之间有嵌套时取更深的那个。 */
export function grantOf(abs: string): RootGrant | null {
  const a = normalizeRoot(abs);
  if (!a) return null;
  const roots = grantList()
    .map((g) => ({ g, key: rootKey(g.root) }))
    .sort((x, y) => y.key.length - x.key.length);
  for (const { g } of roots) {
    if (isInsideRoot(g.root, a)) return g;
  }
  return null;
}

/** `abs` 落在一个什么用途的根里；都不命中返回 null */
export function purposeOf(abs: string): RootPurpose | null {
  return grantOf(abs)?.purpose ?? null;
}

/**
 * 授权判定：`abs` 允许做 `action` 吗。
 * 读：任何允许根都可以（只读来源存在的意义就是能读）；
 * 写 / 移动 / 删除：只读来源一律不行。
 */
export function canUse(abs: string, action: RootAction): boolean {
  try {assertNoPathLinks(abs);} catch {return false;}
  const hit = grantOf(abs);
  if (!hit) return false;
  if (action === 'read') return true;
  return hit.purpose !== 'readonly';
}

/**
 * `canUse` 的抛错版本。**这是"读 / 写 / 移动 / 删除"各自的唯一闸门**，
 * 写路径先在库里拦一次，别等 `unlinkSync` / `renameSync` 报 EPERM 才说原因。
 */
export function assertUsable(abs: string, action: RootAction, what = '文件'): void {
  assertNoPathLinks(abs);
  const hit = grantOf(abs);
  if (!hit) throw new Error(`路径越界，拒绝访问：${abs}`);
  if (action !== 'read') assertTestWrite(abs);
  if (action !== 'read' && hit.purpose === 'readonly') {
    throw new SafetyRefusal(
      `「${hit.root}」是只读来源（原件目录），平台只读取，不会${ACTION_LABEL[action]}里面的${what}：${abs}`,
    );
  }
}

/** `abs` 是不是"只读来源"里的东西（排障 / 回收站列表展示用） */
export function isReadonlySourcePath(abs: string): boolean {
  return purposeOf(abs) === 'readonly';
}

/* ------------------------- 文件的来源身份（root_id） ------------------------- */

/**
 * 一条 artifact 记录的**来源身份**：它登记时落在哪个根。
 *
 * 为什么不能只靠"当前工作台的 external_root + file_rel"现拼：
 * 改绑资料目录之后，同一个相对路径在新目录里会被解释成**另一个文件**
 * （用户放在新目录里、平台从没登记过的原件），删除时就会误删它。
 * 所以登记那一刻把根的稳定身份记下来，之后**改绑不再重新解释已有记录**：
 *   · `data`             → DATA_ROOT
 *   · `ext:<规范化路径>`  → 那一个具体的绑定目录（历史来源也算，按只读来源读）
 */
export function rootIdFor(abs: string): string | null {
  const hit = grantOf(abs);
  if (!hit) return null;
  return hit.purpose === 'platform' ? DATA_ROOT_ID : `${EXT_ROOT_ID_PREFIX}${rootKey(hit.root)}`;
}

/** 外部绑定根的稳定身份（不经文件路径，直接由根算） */
export function externalRootId(root: string): string | null {
  const n = normalizeRoot(root);
  return n ? `${EXT_ROOT_ID_PREFIX}${rootKey(n)}` : null;
}

/** 解析来源身份。认不出 / 为空返回 null（老记录 → 调用方按 `root_kind` 现算） */
export function parseRootId(id: string | null | undefined): { kind: 'data' } | { kind: 'external'; root: string } | null {
  const raw = (id ?? '').trim();
  if (!raw) return null;
  if (raw === DATA_ROOT_ID) return { kind: 'data' };
  if (raw.startsWith(EXT_ROOT_ID_PREFIX)) {
    const root = normalizeRoot(raw.slice(EXT_ROOT_ID_PREFIX.length));
    return root ? { kind: 'external', root } : null;
  }
  return null;
}

/** 来源身份是不是"平台数据目录"（老记录 root_kind='data' 的等价物） */
export function isDataRootId(id: string | null | undefined): boolean {
  return (id ?? '').trim() === DATA_ROOT_ID;
}

/**
 * 一条文件记录在磁盘上的绝对路径 —— **来源身份优先**。
 *
 *   · 有 root_id        → 按登记时的那个根算（改绑也不重新解释）
 *   · 没有 root_id 的老记录 → 按 `root_kind` + 当前绑定目录算（与改造前逐字一致）
 *
 * 纯定位，不判授权：读用 `assertUsable(abs,'read')`、删用 `assertDeletableFile(abs, fp)`。
 * `externalRoot` 由调用方现查数据库给进来（这一层不连数据库）。
 */
export interface ArtifactLocationHint {
  file_rel: string;
  root_kind?: string | null;
  root_id?: string | null;
  /** 老记录（没有 root_id）时按当前绑定解释：调用方查工作台的 external_root 传进来 */
  externalRoot?: string | null;
}

export function artifactFileAbs(hint: ArtifactLocationHint): string {
  const rel = toPosix(String(hint.file_rel ?? '').replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!rel) throw new Error('文件记录缺少相对路径，无法定位');
  const id = parseRootId(hint.root_id);
  if (id?.kind === 'data') return resolveInAnyRoot(join(DATA_ROOT, rel));
  if (id?.kind === 'external') {
    const abs = join(id.root, rel);
    if (!isInsideRoot(id.root, abs)) throw new Error(`路径越界，拒绝访问：${rel}`);
    assertNoPathLinks(abs);return abs;
  }
  if ((hint.root_kind ?? 'data') !== 'external') return resolveInAnyRoot(join(DATA_ROOT, rel));
  const root = normalizeRoot((hint.externalRoot ?? '').trim());
  if (!root) throw new Error(`这份文件登记在外部资料目录，但工作台没有绑定目录，无法定位：${rel}`);
  const abs = join(root, rel);
  if (!isInsideRoot(root, abs)) throw new Error(`路径越界，拒绝访问：${rel}`);
  assertNoPathLinks(abs);return abs;
}

/** `abs` 所属的根种类；不在任何允许根内就抛错（拒绝越界路径） */
export function rootKindOf(abs: string): 'data' | 'external' {
  const hit = rootOf(abs);
  if (!hit) throw new Error(`路径越界，拒绝访问：${abs}`);
  return hit.kind;
}

/**
 * 把绝对（或相对 DATA_ROOT 的）路径解析成绝对路径，**必须命中某个允许根**。
 * 相对路径按 DATA_ROOT 解析（兼容只在 dataRoot 下有意义的调用方）。
 *
 * 注意：这是**读**定位器（也是"是不是允许根里的路径"的通用判定）。
 * 要写 / 改名 / 删除时用 `resolveWritableInRoot()`，它会连用途一起判。
 */
export function resolveInAnyRoot(absOrRel: string): string {
  const abs = normalizeRoot(isAbsolute(absOrRel ?? '') ? absOrRel : join(DATA_ROOT, absOrRel ?? ''));
  if (!abs) throw new Error(`路径越界，拒绝访问：${absOrRel}`);
  if (!rootOf(abs)) throw new Error(`路径越界，拒绝访问：${absOrRel}`);
  assertNoPathLinks(abs);
  return abs;
}

/** 同上，但要求这个路径**可以写**（只读来源会被拒）—— 平台产物的落点必须过这一关 */
export function resolveWritableInRoot(absOrRel: string): string {
  const abs = resolveInAnyRoot(absOrRel);
  assertUsable(abs, 'write');
  return abs;
}

/** `abs` 相对其所属根的 posix 相对路径（写入 `artifact.file_rel` 的那个值） */
export function relativeToRoot(abs: string): string {
  const hit = rootOf(abs);
  const a = normalizeRoot(abs);
  if (!hit || !a) throw new Error(`路径越界，拒绝访问：${abs}`);
  return toPosix(relative(hit.root, a));
}

/** 工作台的文件根：绑定了 external_root 就用它，否则用 dataRoot 下的工作台目录 */
export function workbenchRootAbs(wb: { folder_path: string; external_root?: string | null }): string {
  const ext = wb.external_root;
  if (typeof ext === 'string' && ext.trim()) {
    const abs = normalizeRoot(ext);
    if (!abs) throw new Error(`绑定的资料目录无效（需要绝对路径）：${ext}`);
    return abs;
  }
  return normalizeRoot(join(DATA_ROOT, wb.folder_path)) as string;
}

/* ------------------------------ 内部工具 ------------------------------ */

/**
 * 规范化一个根路径：去末尾分隔符与 `.`、统一分隔符。
 * 非法（空 / 非绝对路径 / 盘根）返回 null —— 契约 §3 要求绑定时拒绝非绝对路径，
 * 所以这里**先判 isAbsolute 再 resolve**：`resolve()` 会把相对路径悄悄拼到当前
 * 工作目录上，那样「相对路径」会被静默接受成一个谁都没想到的绝对路径。
 *
 * 刻意**不改盘符大小写**：规范化结果会被展示与落盘，用户给的 `D:\资料` 就该还是
 * `D:\资料`。大小写差异在比较时才处理（`rootKey` / `relative()` 本身就不敏感）。
 */
function normalizeRoot(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || !isAbsolute(raw)) return null;
  const abs = resolve(raw);
  if (dirname(abs) === abs) return null; // 盘根（`D:\`）不是能绑的目录
  return abs;
}

/** 比较用键： Windows 盘符大小写不敏感，去掉末尾分隔符避免 `D:\a` 与 `D:\a\` 算两个根 */
function rootKey(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.replace(/[\\/]+$/, '').toLowerCase() : abs.replace(/\/+$/, '');
}

/**
 * 删除前的**内容指纹**核对：登记的 `size_bytes` + `sha256` 必须与磁盘上的文件一致。
 *
 * 为什么必须核对：`file_rel` 是相对路径，历史上（以及"老记录没有来源身份"时）
 * 它会被按**当前**绑定目录解释。改了绑定之后，同一个相对路径可能指向新目录里
 * 一份用户自己放着、平台从没登记过的原件 —— 只按路径 unlink 就把它删了。
 * 指纹一致才允许删（内容一字不差，删掉它也确实是"平台登记过的那一份"）。
 *
 * 没有指纹的老记录（`sha256` 为空串 / NULL）**不拦**：那是改造前的历史数据，
 * 拦下来会让"彻底删除"对存量文件整片失效。返回 false 表示指纹不符，调用方负责拒绝。
 */
export function fingerprintMatches(
  abs: string,
  fp: { size_bytes?: number | null; sha256?: string | null },
): boolean {
  const wantHash = (fp.sha256 ?? '').trim().toLowerCase();
  if (!wantHash) return true; // 老记录没有指纹：按路径删除（与改造前一致）
  let st;
  try {
    st = statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const wantSize = fp.size_bytes;
  if (typeof wantSize === 'number' && Number.isFinite(wantSize) && wantSize >= 0 && st.size !== wantSize) return false;
  try {
    const buf = readFileSync(abs);
    return createHash('sha256').update(buf).digest('hex') === wantHash;
  } catch {
    return false;
  }
}

/**
 * 删除一个**平台登记过的文件**之前的完整授权（`store.deleteArtifact` 与
 * `core/trash.ts` 的彻底删除共用同一套判据，两边不可能各写一套）：
 *   1. 路径必须命中允许根（`assertUsable` 同时挡住只读来源）；
 *   2. 绑定根 / 工作台根本身不是文件，绝不删；
 *   3. 有登记指纹时必须与磁盘内容一致（大小 + sha256）。
 * 不通过就抛中文错误 —— 调用方把它当成「跳过这一份并说明原因」，不是 500。
 */
export function assertDeletableFile(
  abs: string,
  fp: { size_bytes?: number | null; sha256?: string | null } = {},
  what = '文件',
): void {
  assertUsable(abs, 'delete', what);
  for (const root of getBoundRoots()) {
    if (samePathKey(root, abs)) throw new SafetyRefusal(`拒绝删除绑定目录本身：${abs}`);
  }
  if (!fingerprintMatches(abs, fp)) {
    throw new SafetyRefusal(`磁盘上的内容与登记信息不一致（大小/哈希对不上），拒绝删除这一份：${abs}`);
  }
}

/** 路径比较键（Windows 不区分大小写，忽略末尾分隔符） */
export function samePathKey(a: string, b: string): boolean {
  const clean = (p: string) => p.replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? clean(a).toLowerCase() === clean(b).toLowerCase()
    : clean(a) === clean(b);
}

/**
 * 生成不重复的文件名。同名时自动加 _v2 / _v3 …
 * 返回最终文件名（不含目录）。
 */
export function uniqueFileName(dir: string, fileName: string): string {
  const ext = extname(fileName);
  const stem = basename(fileName, ext);
  let candidate = fileName;
  let n = 1;
  while (existsSync(join(dir, candidate))) {
    n += 1;
    candidate = `${stem}_v${n}${ext}`;
  }
  return candidate;
}

/* ----------------------------- 业务命名规则 ----------------------------- */

/** 工作台文件夹：{编号}-{名称} */
export function workbenchFolderName(code: string, name: string): string {
  const id=createHash('sha256').update(code).digest('hex').slice(0,16);
  return `${id}-${safeName(`${code}-${name}`, '工作台').slice(0,95)}`;
}

/** 生成文书：{日期}_{模板名}_{时间戳}.{ext} —— 时间戳保证同日多版不覆盖 */
export function generatedFileName(templateName: string, ext: string, d: Date = new Date(), version = 1): string {
  const base = `${stamp(d)}_${safeName(templateName)}`;
  return `${safeName(base)}_v${version}.${ext.replace(/^\./, '')}`;
}

/** 影像证据：{日期}_{阶段}_{序号}_{说明}.{ext} */
export function evidenceFileName(phase: string, index: number, note: string, ext: string, d: Date = new Date()): string {
  const idx = String(index).padStart(3, '0');
  const parts = [stamp(d), safeName(phase, '阶段'), idx, safeName(note, '照片')];
  return `${parts.join('_')}.${ext.replace(/^\./, '')}`;
}

/** 原始资料归档：{日期}_{类别}_{说明}.{ext} */
export function sourceFileName(category: string, note: string, ext: string, d: Date = new Date()): string {
  return `${stamp(d)}_${safeName(category, '资料')}_${safeName(note, '文件')}.${ext.replace(/^\./, '')}`;
}
