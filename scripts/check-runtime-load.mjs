// 运行时加载检查（安全版）：**不执行模块**，只做语法与禁用构造扫描。
//
// 为什么需要它：Node 的类型剥离（strip-only）只接受"可擦除"的 TS 语法。
// tsc 通过 ≠ 运行时能加载 —— 参数属性、enum、namespace、装饰器等会直接抛
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，而任何 import 该模块的路径（含服务启动）都会一起挂。
// 真实事故：core/template.ts 曾出现 `constructor(private readonly zip: PizZip)`，
// tsc 全绿但 test:unit / test:regression / 服务启动 全部起不来。
//
// 教训（本文件的由来）：上一版用 `await import(file)` 检查，结果**执行了模块副作用**——
// 把 CLI 跑了一遍、并额外启动了一个服务进程。所以这里只允许：
//   ① `node --check <file>`（只做语法检查，不执行）
//   ② 正则扫描已知的 strip-only 禁用构造
//
// 用法：node scripts/check-runtime-load.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const SRC = join(ROOT, 'packages', 'server', 'src');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** strip-only 模式不支持的构造（按危险程度） */
const FORBIDDEN = [
  { name: '参数属性', re: /\bconstructor\s*\([^)]*\b(private|public|protected|readonly)\s+\w/ },
  { name: 'enum', re: /^\s*(export\s+)?(const\s+)?enum\s+\w/m },
  { name: 'namespace', re: /^\s*(export\s+)?(declare\s+)?(module|namespace)\s+\w/m },
  { name: '装饰器', re: /^\s*@[A-Za-z_$][\w$.]*\s*\(/m },
  { name: 'declare class/field with initializer', re: /^\s*declare\s+(class|const)\s/m },
];

const files = walk(SRC).filter((f) => !f.endsWith('.d.ts'));
const problems = [];

for (const f of files) {
  const src = readFileSync(f, 'utf8');

  // ① 语法检查（不执行）
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || '').split('\n').find((l) => /Error|error/.test(l)) ?? '语法检查失败';
    problems.push({ file: relative(ROOT, f), kind: '语法/加载', msg: msg.trim() });
    continue;
  }

  // ② 禁用构造扫描
  for (const rule of FORBIDDEN) {
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (rule.re.test(line)) {
        problems.push({ file: relative(ROOT, f), kind: rule.name, msg: `第 ${i + 1} 行：${line.trim().slice(0, 100)}` });
      }
    });
  }
}

console.log('=== 运行时加载检查（只读语法，不执行模块）===');
console.log(`检查文件 ${files.length} 个`);
if (problems.length === 0) {
  console.log('结果：未发现 strip-only 不支持的构造 ✅');
} else {
  console.log(`结果：${problems.length} 处问题 ❌`);
  for (const p of problems) console.log(`  [${p.kind}] ${p.file}\n      ${p.msg}`);
}
process.exitCode = problems.length === 0 ? 0 : 1;
