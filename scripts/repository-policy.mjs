/** Shareable source boundary. Private files remain on disk; this is not a history scrubber. */
export const rootFiles = new Set([
  '.gitignore', '.gitattributes', '.npmrc', 'package.json', 'package-lock.json', 'tsconfig.json',
  'workbench.config.example.json', '启动工作台.cmd', 'README.md', 'AGENTS.md',
  'GPT_CONTEXT.md', 'CONTEXT.md', 'PRODUCT_REQUIREMENTS.md', 'SYSTEM_ARCHITECTURE.md', 'DEVELOPMENT_PROGRESS.md',
]);
export const sharedScripts = new Set([
  'start.mjs', 'start-release.mjs', 'start-source.mjs', 'source-build.mjs', 'source-npm.mjs', 'source-upgrade.mjs', 'backup.mjs', 'snapshot.mjs', 'pack.mjs', 'isolation-env.mjs',
  'test-isolated.mjs', 'test-preflight.mjs', 'dev-monthly.mjs', 'dev-server.mjs',
  'docs-maintenance.mjs', 'repository-policy.mjs', 'check-repository.mjs', 'install-git-hooks.mjs',
]);
export function isShareableFile(input) {
  const p = input.replaceAll('\\', '/');
  if (p.startsWith('/') || p.split('/').some(s => s === '..' || s === '.' || !s)) return false;
  if (p === 'packages/server/src/core/convert-legacy-excel.ps1') return true;
  if (rootFiles.has(p)) return true;
  if (/^\.githooks\/(?:pre-commit|pre-push)$/.test(p)) return true;
  if (/^scripts\/[^/]+$/.test(p)) return sharedScripts.has(p.slice('scripts/'.length));
  if (/^packages\/(?:server|web)\/package\.json$/.test(p)) return true;
  if (/^packages\/web\/(?:index\.html|tsconfig\.json|vite\.config\.ts)$/.test(p)) return true;
  if (/^packages\/(?:server|web)\/src\//.test(p)) {
    if (/(?:^|\/)(?:test|tests|__tests__|fixtures|data|config\.local)(?:\/|$)/.test(p)) return false;
    if (/\.(?:test|spec)\.[^/]+$/.test(p)) return false;
    if (/^packages\/server\/src\/cli\/(?:make-samples|seed-monthly-review)\.ts$/.test(p)) return false;
    return /\.(?:ts|tsx|js|jsx|mjs|css|html|sql|svg)$/.test(p);
  }
  return p === 'docs/README.md' || p === 'docs/knowledge-index.json'
    || /^docs\/(?:guides|management)\/[^/]+\.md$/.test(p)
    || /^docs\/reference\/(?:DATA_AND_API\.md|source-inventory\.json)$/.test(p);
}

/** High-confidence content checks; values are never included in diagnostics. */
export function contentIssues(content) {
  const text = content.toString('utf8');
  const issues = [];
  if (content.includes(0)) issues.push('binary-content');
  const rules = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['credential-token', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{16,})\b/],
    ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
    ['personal-home-path', /[A-Za-z]:[\\/]+Users[\\/]+(?!<|\$|Public(?:[\\/]|$)|Default(?:[\\/]|$))[^\s\\/<>"']+/i],
  ];
  for (const [kind, regex] of rules) if (regex.test(text)) issues.push(kind);
  const literal = /(?:api[_-]?key|password|passwd|client[_-]?secret|access[_-]?token|_authToken)\s*["']?\s*[:=]\s*["']([^"'\r\n]{8,})["']/gi;
  for (const match of text.matchAll(literal)) {
    if (!/^(?:<[^>]+>|\$\{[^}]+\})$/.test(match[1]) && !/^(?:process\.env\.|your[_ -])/i.test(match[1])) issues.push('credential-literal');
  }
  if (/^\s*(?:\/\/[^\s]+:)?_authToken\s*=\s*(?!\$\{)[^\s]+/m.test(text)) issues.push('npm-auth-token');
  return issues;
}
