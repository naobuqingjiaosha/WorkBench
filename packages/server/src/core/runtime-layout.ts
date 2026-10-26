/** Runtime paths are injected at the process boundary; importing this module never opens a DB or creates files. */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { inside, assertNoPathLinks } from './path-boundary.ts';

export type RuntimeProfile = 'daily' | 'development' | 'test';
export interface LocalConfig {
  dataRoot?: string;
  runtimeRoot?: string;
  port?: number;
  host?: string;
  backup?: { dir?: string; auto?: boolean; hour?: number; keepDaily?: number; keepWeekly?: number; weeklyDay?: number };
}
export interface RuntimeLayout {
  codeRoot: string;
  profile: RuntimeProfile;
  legacy: boolean;
  home: string;
  configFile: string | null;
  configBase: string;
  config: LocalConfig;
  dataRoot: string;
  runtimeRoot: string;
  dbFile: string;
  backupRoot: string;
  defaultBackupRoot: string;
  tessdataRoot: string;
  webDist: string;
  releaseRoot: string;
  port: number;
  host: string;
}

export function defaultHome(codeRoot: string, profile: 'daily' | 'development', env: NodeJS.ProcessEnv = process.env): string {
  const base = env.LOCALAPPDATA || env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const app = join(base, 'WorkBench');
  return profile === 'daily' ? join(app, 'daily') : join(app, 'development', createHash('sha256').update(resolve(codeRoot)).digest('hex').slice(0, 12));
}

function absoluteEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value) return undefined;
  if (!isAbsolute(value)) throw Error(key + ' 必须是绝对路径');
  return resolve(value);
}

/** A missing explicit config or invalid JSON is an error, never a fallback to another environment. */
export function readLocalConfig(file: string | null, required = false): LocalConfig {
  if (!file) return {};
  assertNoPathLinks(file);
  if (!existsSync(file)) {
    if (required) throw Error('指定的本机配置不存在');
    return {};
  }
  let cfg: LocalConfig;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw Error('本机配置不是有效 JSON，拒绝回退到默认环境'); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw Error('本机配置必须是对象');
  for (const key of ['dataRoot', 'runtimeRoot', 'host'] as const) {
    if (cfg[key] !== undefined && (typeof cfg[key] !== 'string' || !cfg[key]?.trim())) throw Error('本机配置字段无效：' + key);
  }
  if (cfg.backup !== undefined && (!cfg.backup || typeof cfg.backup !== 'object' || Array.isArray(cfg.backup))) throw Error('backup 必须是对象');
  if (cfg.backup?.dir !== undefined && (typeof cfg.backup.dir !== 'string' || !cfg.backup.dir.trim())) throw Error('backup.dir 必须是非空路径');
  if (cfg.port !== undefined && (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)) throw Error('配置端口无效');
  return cfg;
}

export function assertRuntimeWrite(layout: RuntimeLayout, path: string): void {
  assertNoPathLinks(path);
  if (!layout.legacy && layout.profile !== 'test' && (inside(layout.codeRoot, path) || inside(path, layout.codeRoot))) throw Error('运行数据和配置不能放入源码目录或其父目录');
  if (layout.profile !== 'daily' && !inside(layout.home, path)) throw Error('开发和测试资源不能越出各自环境根目录');
}

export function loadRuntimeLayout(codeRoot: string, env: NodeJS.ProcessEnv = process.env): RuntimeLayout {
  codeRoot = resolve(codeRoot);
  const isolated = !!env.WORKBENCH_ISOLATION_ROOT || env.WORKBENCH_TEST_MODE === '1' || env.NODE_ENV === 'test';
  const profile = env.WORKBENCH_PROFILE || (isolated ? 'test' : 'daily');
  if (!['daily', 'development', 'test'].includes(profile)) throw Error('未知 WORKBENCH_PROFILE');
  if (isolated && profile !== 'test') throw Error('测试标记不能与其他运行环境混用');
  const test = profile === 'test';
  const explicitHome = absoluteEnv(env, 'WORKBENCH_HOME');
  const testHome = absoluteEnv(env, 'WORKBENCH_ISOLATION_ROOT');
  if (test && !testHome) throw Error('测试必须通过隔离入口指定临时根目录');
  if (test && explicitHome && explicitHome !== testHome) throw Error('测试 HOME 必须与隔离根相同');
  // Compatibility is limited to an existing installation. A new clone has no private files.
  const legacy = profile === 'daily' && !explicitHome && !env.WORKBENCH_CONFIG_FILE &&
    [join(codeRoot, 'workbench.config.json'), join(codeRoot, 'data/runtime/workbench.db'), join(codeRoot, 'data/runtime/current-release.json')].some(existsSync);
  const home = test ? testHome! : explicitHome || (legacy ? join(codeRoot, 'data') : defaultHome(codeRoot, profile as 'daily' | 'development', env));
  const configBase = legacy ? codeRoot : home;
  const configFile = test ? null : absoluteEnv(env, 'WORKBENCH_CONFIG_FILE') || join(legacy ? codeRoot : home, 'workbench.config.json');
  // Validate the location BEFORE reading any configuration (especially in development).
  const boundary = { codeRoot, profile, legacy, home } as RuntimeLayout;
  assertRuntimeWrite(boundary, home);
  if (profile === 'development') {
    const daily = defaultHome(codeRoot, 'daily', env);
    if (inside(daily, home) || inside(home, daily)) throw Error('开发目录不能与日常目录重叠');
  }
  if (configFile) assertRuntimeWrite(boundary, configFile);
  const config = readLocalConfig(configFile, !!env.WORKBENCH_CONFIG_FILE && !test);
  const runtimeRoot = absoluteEnv(env, 'WORKBENCH_RUNTIME_DIR') || (env.WORKBENCH_DB ? dirname(absoluteEnv(env, 'WORKBENCH_DB')!) : resolve(configBase, config.runtimeRoot || (legacy ? 'data/runtime' : 'runtime')));
  const layout: RuntimeLayout = {
    ...boundary, configFile, configBase, config,
    runtimeRoot,
    dataRoot: absoluteEnv(env, 'WORKBENCH_DATA_DIR') || resolve(configBase, config.dataRoot || (legacy ? 'data/files' : 'files')),
    dbFile: absoluteEnv(env, 'WORKBENCH_DB') || join(runtimeRoot, 'workbench.db'),
    defaultBackupRoot: resolve(configBase, legacy ? 'data/backups' : 'backups'),
    backupRoot: absoluteEnv(env, 'WORKBENCH_BACKUP_DIR') || resolve(configBase, config.backup?.dir || (legacy ? 'data/backups' : 'backups')),
    tessdataRoot: absoluteEnv(env, 'WORKBENCH_TESSDATA_DIR') || join(runtimeRoot, 'tessdata'),
    webDist: absoluteEnv(env, 'WORKBENCH_WEB_DIST') || (test ? join(home, 'web') : join(codeRoot, 'packages/web/dist')),
    releaseRoot: legacy ? join(home, 'releases') : resolve(home, '..', 'releases'),
    port: Number(env.PORT || config.port || (profile === 'daily' ? 8787 : 18889)),
    host: env.HOST || config.host || '127.0.0.1',
  };
  if (!Number.isInteger(layout.port) || layout.port < 1 || layout.port > 65535) throw Error('端口必须在 1 到 65535 之间');
  for (const path of [layout.dataRoot, runtimeRoot, layout.dbFile, layout.backupRoot, layout.tessdataRoot]) assertRuntimeWrite(layout, path);
  if (!inside(runtimeRoot, layout.dbFile)) throw Error('数据库必须位于当前运行目录');
  if (!inside(runtimeRoot, layout.tessdataRoot)) throw Error('OCR资源必须位于当前运行目录');
  const dirs = [layout.dataRoot, runtimeRoot, layout.backupRoot];
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
    if (inside(dirs[i]!, dirs[j]!) || inside(dirs[j]!, dirs[i]!)) throw Error('文件、运行和备份目录不能相互重叠');
  }
  if (configFile && dirs.some(p => inside(p, configFile))) throw Error('本机配置必须独立于业务文件、运行和备份目录');
  assertNoPathLinks(layout.webDist);
  if (dirs.some(p => inside(p, layout.webDist) || inside(layout.webDist, p)) || (configFile && inside(layout.webDist, configFile))) throw Error('前端静态目录不能与私有运行资源重叠');
  return layout;
}
