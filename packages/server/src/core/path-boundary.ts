// Side-effect-free primitives shared by startup isolation and business paths.
import { lstatSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
export function inside(root: string, file: string): boolean {
  const r = relative(resolve(root), resolve(file));
  return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r));
}
export function assertNoPathLinks(path: string): void {
  for (let current = resolve(path);;) {
    try { if (lstatSync(current).isSymbolicLink()) throw Error('路径包含符号链接或目录链接，拒绝越界访问：' + current); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
