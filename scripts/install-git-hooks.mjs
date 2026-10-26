import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
if (!fs.existsSync(path.join(root, '.git'))) {
  console.log('No Git metadata; hook setup skipped.');
} else {
  const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const current = run(['config', '--get', 'core.hooksPath']);
  if (current.status !== 0 && current.status !== 1) throw Error('Cannot read Git hooks configuration');
  if (current.stdout.trim() && current.stdout.trim() !== '.githooks') throw Error('Existing hooksPath preserved; integrate repository checks manually.');
  const result = run(['config', '--local', 'core.hooksPath', '.githooks']);
  if (result.status !== 0) throw Error('Cannot install repository hooks');
  for (const name of ['pre-commit', 'pre-push']) fs.chmodSync(path.join(root, '.githooks', name), 0o755);
  console.log('Repository pre-commit and pre-push checks enabled.');
}
