/** Inspect staged blobs, a commit, outgoing commits, or shareable working files. Never reads private data. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isShareableFile, contentIssues } from './repository-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const git = (a, encoding = 'utf8') => execFileSync('git', a, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
function entries(ref) {
  const raw = ref ? git(['ls-tree', '-r', '-z', ref]) : git(['ls-files', '--stage', '-z']);
  return raw.split('\0').filter(Boolean).map(line => {
    const i = line.indexOf('\t'), meta = line.slice(0, i).split(' ');
    return { file: line.slice(i + 1), mode: meta[0], oid: ref ? meta[2] : meta[1], stage: ref ? '0' : meta[2] };
  });
}
let examined = 0;
const problems = [], seen = new Set();
function inspect(file, mode, key, read) {
  if (!isShareableFile(file)) { problems.push({ file, reason: 'local-only-or-unapproved-path' }); return; }
  if (mode !== '100644' && mode !== '100755') { problems.push({ file, reason: 'symlink-submodule-or-conflict' }); return; }
  const id = file + ':' + key;
  if (seen.has(id)) return;
  seen.add(id); examined++;
  for (const reason of contentIssues(read())) problems.push({ file, reason });
}
function checkRef(ref) {
  for (const item of entries(ref)) {
    if (item.stage !== '0') { problems.push({ file: item.file, reason: 'unmerged-index' }); continue; }
    inspect(item.file, item.mode, item.oid, () => git(['cat-file', 'blob', item.oid], null));
  }
}
try {
  if (args[0] === '--worktree') {
    const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    for (const file of new Set(files)) {
      if (!fs.existsSync(path.join(root, file))) continue;
      const stat = fs.lstatSync(path.join(root, file));
      inspect(file, stat.isSymbolicLink() ? '120000' : '100644', 'worktree', () => fs.readFileSync(path.join(root, file)));
    }
  } else if (args[0] === '--pre-push') {
    // Git passes: local-ref local-sha remote-ref remote-sha. Scan every newly sent commit.
    for (const line of fs.readFileSync(0, 'utf8').trim().split('\n').filter(Boolean)) {
      const [, local, , remote] = line.trim().split(/\s+/);
      if (!/^[a-f0-9]{40,64}$/.test(local || '') || !/^[a-f0-9]{40,64}$/.test(remote || '')) throw Error('Invalid pre-push input');
      if (/^0+$/.test(local)) continue;
      const range = /^0+$/.test(remote) ? local : remote + '..' + local;
      for (const ref of git(['rev-list', range]).trim().split('\n').filter(Boolean)) checkRef(ref);
    }
  } else if (args[0] === '--ref' && /^[a-zA-Z0-9_./-]+$/.test(args[1] || '') && !args[1].startsWith('-')) {
    checkRef(args[1]);
  } else if (args.length === 0 || (args.length === 1 && args[0] === '--staged')) {
    checkRef(null);
  } else throw Error('Usage: check-repository.mjs [--staged|--worktree|--ref REF|--pre-push]');
  console.log(JSON.stringify({ ok: problems.length === 0, examined, problems }, null, 2));
  if (problems.length) process.exitCode = 1;
} catch (error) {
  console.error('Repository boundary check failed: ' + error.message);
  process.exitCode = 1;
}
