// 检查软删除守卫：列出所有"读受软删除影响的表、但附近没有 deleted_at IS NULL"的读点
//
// ⚠️ **这个脚本只是"定位工具"，不是验收标准。** 它用文本匹配判断，已经失真三次：
//    ① 用 `await import(file)` 做检查 → 执行了模块副作用（跑起了真服务）；
//    ② 只认字面量 `deleted_at IS NULL` → 认不出 `liveFilter(...)` 这类函数调用形态；
//    ③ 把说明性注释里的同名字样当成守卫（3 处真缺口被注释盖住）；
//       改良后（排除纯注释行）又反过来把"用单独一行注释标注的守卫"误报成缺口（154 → 107）。
//    同一份代码，改一行就得出 154 / 107 两个结论 —— 说明**它不是指标，只是搜索**。
//
//    因此：**涉及"某类代码有没有处理某件事"，请用行为验证**（跑一次真实请求看结果），
//    不要用文本统计。这个脚本只用来**找候选位置**，找到了必须逐个读代码确认。
//
// 用法：node scripts/check-trash-guards.mjs [--list]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'packages', 'server', 'src');
const TABLES = ['workbench', 'artifact', 'position_instance', 'archive_field', 'archive_alias'];
const DEPTH = 2; // 读点前后各看 2 行，判断是否带守卫
const showList = process.argv.includes('--list');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const tableRe = new RegExp(`\\bFROM\\s+(${TABLES.join('|')})\\b`, 'i');
/**
 * 什么算“这条读点已处理软删除”：
 *  - 字面量 `deleted_at IS NULL`
 *  - 共享片段函数：`liveFilter(...)` / `notDeleted(...)` / `NOT_DELETED`（推荐写法，会随老库自动降级）
 *  - 回收站的**有意读取**：`deleted_at IS NOT NULL`（语义与守卫相反，但对回收站视图是正确的）
 * 说明：本脚本**只做文本判断**，所以用共享片段函数的读点必须在附近留可识别的调用痕迹；
 * 但**绝不要为此往 SQL 模板串里插 `//` 注释** —— 那是真实事故：注释进了模板串，
 * SQL 变成 `near "/": syntax error`，导致整条 `listWorkTypes()` 抛错、新建工作台没有阶段。
 */
const guardRe = /deleted_at\s+IS\s+NULL|liveFilter\s*\(|notDeleted\s*\(|NOT_DELETED|deleted_at\s+IS\s+NOT\s+NULL/i;
const files = walk(SRC);

let totalReads = 0;
let guarded = 0;
const unguarded = [];
const perFile = [];

for (const f of files) {
  const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  let r = 0;
  let g = 0;
  lines.forEach((line, i) => {
    if (!tableRe.test(line)) return;
    r++;
    totalReads++;
    const from = Math.max(0, i - DEPTH);
    const to = Math.min(lines.length - 1, i + DEPTH);
    /**
     * 只在**非纯注释行**里找守卫标记。
     *
     * 为什么：曾经出现 3 处假阳性 —— 代码里写着「【有意不守卫】这里不加 `deleted_at IS NULL`」这类
     * 说明性注释，脚本按文本窗口一匹配就当成"已加守卫"，于是**注释把缺口盖住了**。
     * 这是本脚本第三次因为"用文本匹配当验收标准"而失真（前两次：诱导人写坏代码、只认字面量不认函数）。
     * 规则：跳过整行都是注释的行（`//` 开头、`/*` 开头、`*` 续行）。注意**不要**跳过 SQL 里的
     * 行内注释（例如「FROM artifact」那行后面跟一段 SQL 注释），那种行本身是代码，仍然算数。
     */
    const window = lines
      .slice(from, to + 1)
      .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
      .join('\n');
    if (guardRe.test(window)) {
      g++;
      guarded++;
    } else {
      unguarded.push({ file: relative(ROOT, f), line: i + 1, text: line.trim().slice(0, 120) });
    }
  });
  if (r > 0) perFile.push({ file: relative(SRC, f), reads: r, guarded: g, unguarded: r - g });
}

perFile.sort((a, b) => b.unguarded - a.unguarded || b.reads - a.reads);

console.log('=== 软删除守卫检查 ===');
console.log(`扫描文件 ${files.length} 个`);
console.log(`读点合计 ${totalReads} 处   已加守卫 ${guarded} 处   未加守卫 ${totalReads - guarded} 处`);
console.log(`覆盖率 ${totalReads ? Math.round((guarded / totalReads) * 100) : 0}%\n`);

console.log('=== 按文件（未加守卫多的在前）===');
for (const f of perFile.slice(0, 15)) {
  console.log(`  未加 ${String(f.unguarded).padStart(3)} / 共 ${String(f.reads).padStart(3)}   ${f.file}`);
}

if (showList) {
  console.log('\n=== 未加守卫的读点明细 ===');
  for (const u of unguarded) console.log(`  ${u.file}:${u.line}  ${u.text}`);
} else {
  console.log(`\n（加 --list 可列出全部 ${unguarded.length} 条明细）`);
}

// 退出码：全部加了守卫才算通过，便于 CI/批处理判断
process.exitCode = totalReads - guarded === 0 ? 0 : 1;
