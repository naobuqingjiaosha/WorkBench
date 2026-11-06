import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
// No imports of config/db/business modules: this must run before their evaluation.
import { existsSync, realpathSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { inside, assertNoPathLinks } from './path-boundary.ts';
const install = resolve(import.meta.dirname, '../../../..');
const keys = ['WORKBENCH_DB', 'WORKBENCH_DATA_DIR', 'WORKBENCH_RUNTIME_DIR', 'WORKBENCH_WEB_DIST', 'WORKBENCH_BACKUP_DIR', 'WORKBENCH_TESSDATA_DIR'] as const;
export function isIsolated(): boolean {
  return !!process.env.WORKBENCH_ISOLATION_ROOT || process.env.WORKBENCH_TEST_MODE === '1' || /[\\/]test[\\/]/.test(process.argv[1] || '') || process.env.NODE_ENV === 'test' || process.env.WORKBENCH_PROFILE === 'test';
}
export function assertTestIsolation(required = false): void {
  if (!required && !isIsolated()) return;
  const root = process.env.WORKBENCH_ISOLATION_ROOT;
  if (!root || !isAbsolute(root)) throw Error('测试隔离配置缺失：请通过 scripts/test-isolated.mjs 启动');
  assertNoPathLinks(root);
  // Confirm a dedicated subtree, never the installation/data roots themselves.
  const base = join(install, '.tmp');
  const tempOwned = resolve(dirname(root)).toLowerCase() === realpathSync(tmpdir()).toLowerCase() && /^workbench-isolated-[a-zA-Z0-9]+$/.test(basename(root)) && existsSync(join(root, '.workbench-test-root'));
  if ((!inside(base, root) || resolve(base).toLowerCase() === resolve(root).toLowerCase()) && !tempOwned) throw Error('测试隔离根必须是确认的独立临时目录');
  const daily = [join(install, 'data'), join(install, 'packages/web/dist')];
  if (daily.some(p => inside(p, root) || inside(root, p))) throw Error('测试隔离目录与日常目录重叠');
  for (const key of keys) {
    const p = process.env[key];
    if (!p || !isAbsolute(p)) throw Error('测试隔离配置缺失或非绝对路径：' + key);
    assertNoPathLinks(p);
    if (!inside(root, p) || daily.some(d => inside(d, p) || inside(p, d))) throw Error('测试资源越出隔离目录：' + key);
  }
  const dirs = [process.env.WORKBENCH_DATA_DIR!, process.env.WORKBENCH_RUNTIME_DIR!, process.env.WORKBENCH_WEB_DIST!, process.env.WORKBENCH_BACKUP_DIR!];
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) if (inside(dirs[i]!, dirs[j]!) || inside(dirs[j]!, dirs[i]!)) throw Error('测试资源目录相互重叠');
  if (!inside(process.env.WORKBENCH_RUNTIME_DIR!, process.env.WORKBENCH_DB!)) throw Error('测试数据库必须位于隔离运行目录');
}
export function assertTestWrite(file: string): void {
  assertTestIsolation();
  if (isIsolated()) {
    assertNoPathLinks(file);
    if (!inside(process.env.WORKBENCH_ISOLATION_ROOT!, file)) throw Error('测试写入越出隔离目录');
  }
}
assertTestIsolation();
