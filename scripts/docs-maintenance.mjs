/** Static project knowledge tooling. Never imports application code or opens business data. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { isShareableFile } from './repository-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2];
if (!['generate', 'check'].includes(mode)) {
  console.error('Usage: node scripts/docs-maintenance.mjs generate|check');
  process.exit(2);
}
const posix = p => p.replaceAll('\\', '/');
const abs = p => path.join(root, p);
const read = p => fs.readFileSync(abs(p), 'utf8');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(abs(p))).digest('hex');
const sorted = a => a.sort((x, y) => x < y ? -1 : x > y ? 1 : 0);
function walk(dir) {
  if (!fs.existsSync(abs(dir))) return [];
  return sorted(fs.readdirSync(abs(dir), { withFileTypes: true }).flatMap(e => {
    const p = posix(path.join(dir, e.name));
    if (e.isSymbolicLink()) return [];
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  }));
}
const roots = ['AGENTS.md', 'README.md', 'GPT_CONTEXT.md', 'CONTEXT.md', 'PRODUCT_REQUIREMENTS.md', 'SYSTEM_ARCHITECTURE.md', 'DEVELOPMENT_PROGRESS.md'];
const readingOrder = ['AGENTS.md', 'GPT_CONTEXT.md', 'DEVELOPMENT_PROGRESS.md', 'CONTEXT.md', 'PRODUCT_REQUIREMENTS.md', 'SYSTEM_ARCHITECTURE.md', 'docs/README.md'];
const purposes = {
  'AGENTS.md': '仓库执行约定、数据保护与维护责任',
  'README.md': '项目介绍、用途、能力概览和文档入口；不维护操作或进度',
  'GPT_CONTEXT.md': 'AI最小接续上下文及按需阅读路线',
  'CONTEXT.md': '唯一业务术语词典，不承担运行状态',
  'PRODUCT_REQUIREMENTS.md': '当前需求、业务规则、场景及代码验证追溯',
  'SYSTEM_ARCHITECTURE.md': '当前结构、关键链路、运行与候选边界',
  'DEVELOPMENT_PROGRESS.md': '当前发布、能力分层和验收边界',
  'docs/README.md': '自动生成的完整文档目录与分类',
  'docs/management/PROJECT_CHARTER.md': '目标、范围、交付、责任、资源和阶段出口',
  'docs/management/PROJECT_PLAN.md': '唯一GOV执行队列、依赖、状态与下一步',
  'docs/management/RISKS_AND_DECISIONS.md': '风险、问题、业务未定项与已有决策',
  'docs/management/QUALITY_AND_ACCEPTANCE.md': '质量方法、验收计划和证据要求',
  'docs/management/DOCUMENT_CONTROL.md': '知识权威规则、索引契约和维护方法',
  'docs/management/CHANGELOG.md': '既有任务历史记录；不代表当前状态，不再追加新任务',
  'docs/management/WORK_LOG.md': '每次工作的目标、修改、验证、文档复核及交付记录',
  'docs/guides/INSTALLATION.md': '首次安装、本机配置、构建和日常启动步骤',
  'docs/guides/USER_GUIDE.md': '当前源码的页面操作、异常处理与目标设备版本核对',
  'docs/guides/DATA_BOUNDARIES.md': '源码、测试、本机配置与业务资料的运行和上传边界',
  'docs/guides/DEVELOPMENT.md': '开发环境、隔离验证、构建和交付',
  'docs/guides/DEVICE_HANDOFF.md': '每次任务收尾、换机移交范围、新机验证与现有打包限制',
  'docs/guides/MONTHLY_DEVELOPMENT.md': 'GOV-12月度工时与年度台账日常操作、隔离验收证据和已发布能力边界',
  'docs/guides/UI_DESIGN_IMPLEMENTATION.md': 'GOV-13 十三页设计实施、隔离验收、实页截图与历史验证范围',
  'docs/guides/OPERATIONS.md': '运行、备份、恢复、发布与排障',
  'docs/reference/DATA_AND_API.md': '关键数据字典、API约定及源码定位',
  'docs/reference/DOCUMENTATION_REVIEW.md': '本次文档整理范围与检查证据',
};
function classify(p) {
  if (purposes[p]) return { role: /(?:README|GPT_CONTEXT|AGENTS)\.md$/.test(p) ? 'entry' : 'current', status: 'current-baseline', purpose: purposes[p] };
  if (p.startsWith('docs/archive/')) return { role: 'historical', status: 'superseded-snapshot', purpose: '整理前原文沿革；不作为当前要求、状态或授权' };
  if (p.startsWith('docs/prototypes/')) return { role: 'prototype', status: 'prototype-evidence', purpose: '历史原型自检；不是日常实现，冲突要求以当前需求为准' };
  if (p.startsWith('docs/collab/')) return { role: 'collaboration', status: 'review-reference', purpose: '协作审查证据；任务状态统一见PROJECT_PLAN，不自动授权消息或改动' };
  if (/^docs\/34-/.test(p)) return { role: 'reference', status: 'current-supporting-rules', purpose: '开发与验收细则；月检按41变更及当前质量计划执行' };
  if (/^docs\/03-/.test(p)) return { role: 'reference', status: 'reference-check-scope', purpose: '模板制作参考；须核对当前引擎及真实产物，不表示所有模板已验收' };
  if (/^docs\/41-/.test(p)) return { role: 'reference', status: 'accepted-change-spec', purpose: 'AI材料生成与取消报送的具体需求变更；状态另见43与当前进度' };
  return { role: 'historical', status: 'historical-evidence', purpose: '原日期的需求、设计、研究或验证记录；当前要求/状态见根文档，原文当前不代表今天' };
}
function docPaths() { return sorted([...roots, ...walk('docs').filter(p => p.endsWith('.md') && isShareableFile(p))]); }
function title(p) { return read(p).match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(p); }
function localLinks(p) {
  const body = read(p).replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
  const links = [];
  for (const m of body.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^)\n]+)\)/g)) {
    let target = m[1].trim().replace(/^<|>$/g, '').replace(/\s+"[^"]*"$/, '');
    if (/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(target)) continue;
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    try { target = decodeURIComponent(target); } catch { /* preserve malformed URI as a missing link */ }
    const resolved = path.resolve(path.dirname(abs(p)), target);
    const relative = posix(path.relative(root, resolved));
    const outside = relative === '..' || relative.startsWith('../') || path.isAbsolute(relative);
    const availability = outside || !isShareableFile(relative) ? 'local-evidence' : 'repository';
    const willGenerate = mode === 'generate' && ['docs/README.md', 'docs/knowledge-index.json', 'docs/reference/source-inventory.json'].includes(relative);
    links.push({ target: m[1], path: relative, availability, exists: availability === 'local-evidence' ? null : fs.existsSync(resolved) || willGenerate });
  }
  return links;
}
function catalog(paths) {
  const groups = [
    ['当前入口、管理、指南与技术说明', paths.filter(p => purposes[p])],
    ['仍适用的专项参考（使用前核对范围）', paths.filter(p => !purposes[p] && classify(p).role === 'reference')],
    ['历史报告与原始资料', paths.filter(p => classify(p).status === 'historical-evidence')],
    ['原型和协作审查', paths.filter(p => ['prototype', 'collaboration'].includes(classify(p).role))],
    ['历史文档快照', paths.filter(p => p.startsWith('docs/archive/'))],
  ];
  let out = '# 项目知识与文档总览\n\n文档ID：KB-INDEX。索引体系初始基线：2026-10-21，不表示本轮生成或运行验证日期。由 scripts/docs-maintenance.mjs 自动生成，请修改对应主文档后重新生成。\n\n';
  out += '第一次接手：先读[AI入口](../GPT_CONTEXT.md)、[当前进度](../DEVELOPMENT_PROGRESS.md)和[业务术语](../CONTEXT.md)，再按任务查需求、架构、计划或手册。原始报告中的“当前”仅代表其原日期。\n\n';
  out += '机器入口：[文档索引](knowledge-index.json)、[静态源码/API/迁移索引](reference/source-inventory.json)。索引不是执行授权，源码存在不等于已经发布。\n\n';
  for (const [name, items] of groups) {
    if (!items.length) continue;
    out += `## ${name}\n\n| 文档 | 用途与边界 |\n|---|---|\n`;
    for (const p of items) {
      const name = p === 'docs/README.md' ? '项目知识与文档总览' : title(p);
      const link = posix(path.relative('docs', p));
      out += `| [${name.replaceAll('|', '／')}](${link}) | ${classify(p).purpose} |\n`;
    }
    out += '\n';
  }
  out += '## 维护与移交\n\n运行 `node scripts/docs-maintenance.mjs generate` 刷新目录和索引，再运行 `node scripts/docs-maintenance.mjs check`。脚本不启动应用、不读取业务行、不修改日常数据。详细约定见[文档治理](management/DOCUMENT_CONTROL.md)。\n\n';
  out += 'data、outputs和旧临时目录通常不随Git分发；本机证据缺失必须如实说明，不能当作代码或验收已通过。合成回归随源码共享；历史私有用例、报告与运行快照仅保留本机，相关链接在新设备可能不可用。\n';
  return out;
}
function sourceInventory() {
  const files = sorted([...new Set([
    ...walk('packages/server/src'), ...walk('packages/server/test/shared'), ...walk('packages/web/src'),
    ...walk('scripts').filter(p => /\.(?:mjs|js|ts|ps1)$/.test(p)),
    'package.json', 'package-lock.json', 'tsconfig.json', 'packages/server/package.json',
    'packages/web/package.json', 'packages/web/tsconfig.json', 'packages/web/vite.config.ts',
  ])].filter(isShareableFile));
  const routes = [], registrations = [], unresolvedRouteDeclarations = [], migrations = [];
  for (const p of files.filter(p => p.startsWith('packages/server/src/') && p.endsWith('.ts'))) {
    const source = ts.createSourceFile(p, read(p), ts.ScriptTarget.Latest, true);
    function visit(n) {
      if (ts.isCallExpression(n)) {
        const e = n.expression;
        const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
        if (ts.isPropertyAccessExpression(e) && e.expression.getText(source) === 'app' && ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'route'].includes(e.name.text)) {
          const a = n.arguments[0];
          if (a && ts.isStringLiteralLike(a)) routes.push({ method: e.name.text.toUpperCase(), path: a.text, file: p, line });
          else unresolvedRouteDeclarations.push({ file: p, line, method: e.name.text });
        }
        if (ts.isIdentifier(e) && /^register.*(?:Routes|Guard)$/.test(e.text)) registrations.push({ function: e.text, file: p, line });
      }
      ts.forEachChild(n, visit);
    }
    visit(source);
  }
  for (const p of files.filter(p => p.startsWith('packages/server/src/db/migrations/') && p.endsWith('.sql'))) {
    const sql = read(p).replace(/--[^\r\n]*/g, '');
    migrations.push({ version: path.basename(p, '.sql'), file: p, sha256: sha(p),
      createdTables: [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?(\w+)/gi)].map(m => m[1]),
      alterations: [...sql.matchAll(/ALTER\s+TABLE\s+[\s\S]*?;/gi)].map(m => m[0].replace(/\s+/g, ' ').trim()) });
  }
  const pkg = JSON.parse(read('package.json'));
  let head = null;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(); } catch { /* transferable without Git */ }
  return { schemaVersion: 1, baselineDate: '2026-10-21', scope: 'Static working-tree index; not runtime registration, deployed version, full API schema or live database schema',
    method: 'TypeScript AST literal app routes plus registration calls; SQL CREATE and ALTER declarations; no application imports',
    limitations: ['Dynamic or non-app receiver routes may be omitted; unresolved declarations are listed', 'SQL declarations require subsequent migrations for final schema', 'Working tree may contain uncommitted and unreleased candidates'],
    committedBase: head, engines: pkg.engines, npmScripts: pkg.scripts,
    files: files.map(p => ({ path: p, sha256: sha(p) })),
    pages: files.filter(p => /^packages\/web\/src\/pages\/[^/]+\.tsx$/.test(p)), routes, registrations, unresolvedRouteDeclarations, migrations };
}
const json = o => JSON.stringify(o, null, 2) + '\n';
let paths = docPaths();
if (!paths.includes('docs/README.md')) paths = sorted([...paths, 'docs/README.md']);
const expectedCatalog = catalog(paths);
const source = sourceInventory();
if (mode === 'generate') {
  fs.writeFileSync(abs('docs/README.md'), expectedCatalog);
  fs.writeFileSync(abs('docs/reference/source-inventory.json'), json(source));
}
const documents = paths.map(p => {
  const links = fs.existsSync(abs(p)) ? localLinks(p) : [];
  return { id: p.replace(/\.md$/, ''), path: p, title: fs.existsSync(abs(p)) ? title(p) : 'Missing', ...classify(p),
    sha256: fs.existsSync(abs(p)) ? sha(p) : null, linksTo: sorted([...new Set(links.filter(l => paths.includes(l.path)).map(l => l.path))]), localLinks: links };
});
const index = { schemaVersion: 1, baselineDate: '2026-10-21', pathBase: 'repository-root', encoding: 'UTF-8',
  authority: { requirements: 'Current user requirements and accepted scoped changes; see PRODUCT_REQUIREMENTS', implementation: 'Relevant working-tree or selected release source, explicitly identified', runtime: 'source-current.json, SOURCE_BUILD.json, live loadedBuild and actual migration set', validation: 'Version-bound evidence and actual test scope, not existence of code' },
  readingOrder, documents,
  relatedArtifacts: ['docs/reference/source-inventory.json'],
  excludedContent: ['business database rows', 'credentials', 'business files', 'node_modules', 'private external originals', 'local tests and fixtures', 'historical reports and runtime snapshots'] };
if (mode === 'generate') {
  fs.writeFileSync(abs('docs/knowledge-index.json'), json(index));
  console.log(JSON.stringify({ mode, documents: documents.length, sourceFiles: source.files.length, routes: source.routes.length, migrations: source.migrations.length }));
} else {
  const errors = [], warnings = [];
  for (const [p, content] of [['docs/README.md', expectedCatalog], ['docs/knowledge-index.json', json(index)], ['docs/reference/source-inventory.json', json(source)]]) {
    let expected = content;
    if (p === 'docs/reference/source-inventory.json' && fs.existsSync(abs(p))) {
      try {
        const recorded = JSON.parse(read(p));
        // Generation context is not freshness: committing the generated index changes HEAD.
        // All file hashes and structural fields still have to match, including in a Git-less ZIP.
        if (recorded.committedBase === null || (typeof recorded.committedBase === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(recorded.committedBase))) {
          expected = json({ ...source, committedBase: recorded.committedBase });
        }
      } catch { /* malformed JSON remains a stale index */ }
    }
    if (!fs.existsSync(abs(p)) || read(p) !== expected) errors.push(`索引/目录已过期：${p}；请重新generate`);
  }
  for (const d of documents) {
    if (!d.sha256) { errors.push(`缺少文档：${d.path}`); continue; }
    if (!/^#\s+.+/m.test(read(d.path))) errors.push(`缺少一级标题：${d.path}`);
    if (d.role === 'current' && d.path !== 'CONTEXT.md' && !read(d.path).includes('文档ID：')) errors.push(`缺少文档元数据：${d.path}`);
    const fences = read(d.path).split(/\r?\n/).filter(l => /^\s*(```|~~~)/.test(l)).length;
    if (fences % 2) errors.push(`代码围栏不配对：${d.path}`);
    for (const l of d.localLinks.filter(l => l.exists === false)) (l.availability === 'repository' ? errors : warnings).push(`${d.path} → ${l.path}`);
  }
  for (const p of readingOrder) if (!paths.includes(p)) errors.push(`阅读入口缺失：${p}`);
  console.log(JSON.stringify({ mode, ok: errors.length === 0, documents: documents.length, localLinks: documents.reduce((n,d) => n+d.localLinks.length,0), sourceFiles: source.files.length, routeDeclarations: source.routes.length, migrations: source.migrations.length, errors, missingLocalEvidence: warnings, limitations: 'Validates file targets and static freshness; not heading anchors, external URLs, runtime routes or application behavior' }, null, 2));
  if (errors.length) process.exitCode = 1;
}
