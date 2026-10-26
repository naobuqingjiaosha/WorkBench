#!/usr/bin/env node
/**
 * check-folder-names.mjs —— 目录命名**只读**体检（契约 §12「命名规范（定稿）」）
 *
 * 用法：
 *   node scripts/check-folder-names.mjs [根目录] [--out <报告路径>] [--stdout] [--json] [--limit N]
 *
 *   根目录      默认 C:\Users\Fangnan\Desktop\工作test
 *   --out       报告落盘路径；默认 <项目根>/docs/命名整理报告-工作test.md
 *   --stdout    只打印，不写任何文件（最严格的只读模式）
 *   --json      以 JSON 打印统计与清单（脚本化消费用）
 *   --limit N   stdout 摘要取前 N 条（默认 30）
 *
 * ───────────────────────── 只读保证（硬约束）─────────────────────────
 * 1. 本脚本**没有**任何改名/移动/删除/建目录调用：不 import rename / renameSync /
 *    cp / copyFile / rm / rmdir / unlink / mkdir / truncate / utimes / chmod / appendFile。
 *    全脚本唯一的写调用是 `writeFileSync`，只用于写**报告**，且：
 *      · 发生在扫描与快照比对**全部结束之后**；
 *      · 写之前 `assertOutsideScanRoot()` 校验报告路径**不在被扫描的目录之内**，
 *        命中就直接抛错退出（绝不在被体检的目录里留东西）。
 * 2. 扫描阶段只用 readdirSync / lstatSync / statSync / existsSync —— 纯元数据读取，
 *    不打开文件内容（iCloud / OneDrive 占位文件因此不会被触发下载）。
 * 3. 扫描前后各做一次**全树快照**（所有条目的相对路径哈希 + 所有目录的 mtimeMs 哈希 +
 *    根目录 mtimeMs + 目录数/文件数），三项全部一致才判定"零改动"；
 *    有任何不一致都会在报告里显著标红（但不尝试"修回来"——本脚本不做任何写操作）。
 * 4. 本脚本**不产出**任何文件的建议新名，只产出**文件夹**的建议新名（契约 §12.4）。
 * ────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');
const DEFAULT_SCAN_ROOT = 'C:\\Users\\Fangnan\\Desktop\\工作test';
const DEFAULT_OUT = resolve(PROJECT_ROOT, 'docs', '命名整理报告-工作test.md');

/* ============================== 契约 §12 的规则 ============================== */

/** 平台自己的目录：下划线开头 / 点开头 —— 一律忽略（§12.5） */
const IGNORED_PREFIX = /^[._]/;

/** 禁用字符（§12.1）；`\ /` 在 Windows 目录名里本来就出现不了，一并算上 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/** 编号后「错的」分隔符 → 人话（§12.1 只认半角点） */
const BAD_SEPARATORS = new Map([
  ['-', '连字符'],
  ['_', '下划线'],
  ['、', '顿号'],
  ['．', '全角点'],
  ['。', '句号'],
  ['，', '逗号'],
  [',', '逗号'],
  [')', '右括号'],
  ['）', '右括号'],
  [':', '冒号'],
  ['：', '冒号'],
  [';', '分号'],
  ['；', '分号'],
  ['　', '全角空格'],
  ['\t', '制表符'],
  [' ', '空格'],
]);

/** 数字后面直接跟这些字 → 当"期次类名字"看，不当编号（§12.3） */
const PERIOD_LIKE_TAIL = /^(年|月|季度|季|月份|年度)/;

/** Windows 大小写不敏感 + 忽略末尾的点/空格（§12.1 同级不重名） */
function winKey(name) {
  return name.replace(/[. ]+$/, '').toLowerCase();
}

/** 去掉编号后多余的点/分隔/空白，得到"名称"部分 */
function cleanBody(body) {
  let s = body;
  s = s.replace(/^[\s.\-_、．。，,）):：;；　]+/, '');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  return s;
}

/**
 * 分析一个目录名。
 * @returns {{
 *   raw: string, numbered: boolean, number: string|null, body: string|null,
 *   reasons: string[], suggested: string|null, soft: string[], periodLike: boolean
 * }}
 *   numbered=true  → 「应当编号」这一层（§12.1）：reasons 非空就是**不合规**
 *   numbered=false → 「没编号」：一律不动（§12.2），只进 soft / 备注
 */
function analyzeName(raw) {
  const out = {
    raw,
    numbered: false,
    number: null,
    body: null,
    reasons: [],
    suggested: null,
    soft: [],
    periodLike: false,
  };

  const leadTrail = [];
  if (/^\s/.test(raw) || /\s$/.test(raw)) leadTrail.push('首尾有空格');
  if (/^\.+/.test(raw) || /\.+$/.test(raw)) leadTrail.push('首尾有点');
  const hasIllegal = ILLEGAL_CHARS.test(raw);

  const m = /^(\d+)([\s\S]*)$/.exec(raw);
  if (!m) {
    // 不是以数字开头 → 没编号
    out.soft.push(...leadTrail);
    if (hasIllegal) out.soft.push('含禁用字符（未编号，按要求不动）');
    return out;
  }

  const number = m[1];
  const rest = m[2];

  if (rest === '') {
    // 纯数字目录名：没法判断是"编号"还是"年份"
    out.soft.push('纯数字目录名，无法判断是否"应当编号"（需人工确认）');
    if (hasIllegal) out.soft.push('含禁用字符（按要求不动）');
    return out;
  }

  // 期次类：`2025年` / `1月` / `3季度` —— 按 §12.2 当"没编号"，不动
  if (PERIOD_LIKE_TAIL.test(rest)) {
    out.periodLike = true;
    out.soft.push('看起来是期次目录（未编号，按要求不动）');
    out.soft.push(...leadTrail);
    if (hasIllegal) out.soft.push('含禁用字符（未编号，按要求不动）');
    return out;
  }

  out.numbered = true;
  out.number = number;
  const reasons = out.reasons;

  if (rest[0] === '.') {
    const bodyRaw = rest.slice(1);
    const cleaned = cleanBody(bodyRaw);
    if (!cleaned) reasons.push('②只有编号没有名称');
    if (cleaned !== bodyRaw) reasons.push('②编号点后多出点或空格（格式怪异）');
    out.body = cleaned;
  } else if (BAD_SEPARATORS.has(rest[0])) {
    const sepName = BAD_SEPARATORS.get(rest[0]);
    const cleaned = cleanBody(rest.slice(1));
    if (rest[0] === '-' || rest[0] === '_') {
      reasons.push(`①用「${sepName}」作编号分隔（定稿只认半角点）`);
    } else {
      reasons.push(`②编号后的分隔符是「${sepName}」（定稿只认半角点）`);
    }
    if (!cleaned) reasons.push('②只有编号没有名称');
    out.body = cleaned;
  } else {
    reasons.push('②编号后缺分隔点（应为「数字.名称」）');
    out.body = cleanBody(rest);
  }

  if (leadTrail.length) reasons.push(...leadTrail.map((r) => `②${r}`));
  if (hasIllegal) reasons.push('④含禁用字符 \\ / : * ? " < > |');

  const body = out.body ?? '';
  if (body) {
    if (/[.\-_]/.test(body)) out.soft.push('名称内含 . - _（定稿要求名称内不再用作分隔，需人工确认）');
  }
  if (reasons.length && body) out.suggested = `${number}.${body}`;
  return out;
}

/* ============================== 只读扫描 ============================== */

/** 全树快照：条目相对路径哈希 + 目录 mtimeMs 哈希（只读，不写） */
function snapshotTree(root) {
  const listingHash = createHash('sha256');
  const dirHash = createHash('sha256');
  const dirs = [];
  let fileCount = 0;

  const walk = (abs, rel) => {
    let ents;
    try {
      ents = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (!isDir) fileCount += 1;
      listingHash.update(`${isDir ? 'D' : 'F'} ${childRel}\n`);
      if (isDir) {
        let mtimeMs = -1;
        try {
          mtimeMs = lstatSync(join(abs, e.name)).mtimeMs;
        } catch {
          /* 读不到就记 -1，不影响"变没变"的判断 */
        }
        dirs.push({ rel: childRel, mtimeMs });
        walk(join(abs, e.name), childRel);
      }
    }
  };
  walk(root, '');

  dirs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const d of dirs) dirHash.update(`${d.rel}\t${d.mtimeMs}\n`);

  let rootMtimeMs = -1;
  try {
    rootMtimeMs = statSync(root).mtimeMs;
  } catch {
    /* 读不到根就记 -1 */
  }

  return {
    listingHash: listingHash.digest('hex'),
    dirHash: dirHash.digest('hex'),
    dirCount: dirs.length,
    fileCount,
    rootMtimeMs,
  };
}

function sameSnapshot(a, b) {
  return (
    a.listingHash === b.listingHash &&
    a.dirHash === b.dirHash &&
    a.rootMtimeMs === b.rootMtimeMs &&
    a.dirCount === b.dirCount &&
    a.fileCount === b.fileCount
  );
}

function listDirs(abs) {
  let ents = [];
  try {
    ents = readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return { dirs: [], error: e && e.message ? String(e.message) : String(e) };
  }
  const dirs = ents
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { dirs, error: null };
}

/**
 * 扫描第 1 层 + 第 2 层（§12.7）。
 * 返回 { level1, level2, l1Rows, inventory, ignored, unreadable, violations, unnumbered, manual, dupGroups }
 */
function scan(root) {
  const level1 = [];
  const level2 = [];
  const inventory = [];
  const ignored = [];
  const unreadable = [];
  const violations = [];
  const unnumbered = [];
  const manual = [];
  const dupGroups = [];

  const { dirs: rootDirs, error: rootErr } = listDirs(root);
  if (rootErr) throw new Error(`读不了根目录：${root} —— ${rootErr}`);

  /** 处理一个"同级层"：算重名 + 逐条分析 + 冲突检测 */
  const handleLevel = (label, parentRel, names) => {
    // ③ 同级重名（Windows 口径：大小写不敏感、忽略末尾点/空格）
    const byKey = new Map();
    for (const n of names) {
      const k = winKey(n);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(n);
    }
    const dupKeys = new Map();
    for (const [k, arr] of byKey) if (arr.length > 1) dupKeys.set(k, arr);
    for (const [, arr] of dupKeys) {
      dupGroups.push({ level: label, parent: parentRel, names: arr });
    }

    const rows = names.map((n) => {
      const a = analyzeName(n);
      const dup = dupKeys.get(winKey(n));
      if (dup) a.reasons.push(`③同级重名（与 ${dup.filter((x) => x !== n).join('、')} 同名）`);
      if (a.reasons.length && a.numbered && a.body) a.suggested = `${a.number}.${a.body}`;
      if (!a.numbered && dup) a.soft.push('同级重名（未编号，按要求不动）');

      // 冲突检测：改后是否与同级**已有**目录同名
      let conflict = false;
      let conflictWith = [];
      if (a.suggested) {
        const target = winKey(a.suggested);
        conflictWith = names.filter((other) => other !== n && winKey(other) === target);
        conflict = conflictWith.length > 0;
      }
      return { level: label, parent: parentRel, name: n, ...a, conflict, conflictWith, dup: Boolean(dup) };
    });

    // 两个不同的目录建议成同一个新名 —— 也算冲突
    const sugMap = new Map();
    for (const r of rows) {
      if (!r.suggested) continue;
      const k = winKey(r.suggested);
      if (!sugMap.has(k)) sugMap.set(k, []);
      sugMap.get(k).push(r.name);
    }
    for (const r of rows) {
      if (!r.suggested) continue;
      const peers = (sugMap.get(winKey(r.suggested)) || []).filter((x) => x !== r.name);
      if (peers.length) {
        r.conflict = true;
        r.conflictWith = [...new Set([...r.conflictWith, ...peers])];
      }
    }

    for (const r of rows) {
      if (r.numbered && r.reasons.length) {
        violations.push(r);
        inventory.push({ level: r.level, parent: r.parent, name: r.name, verdict: '不合规（见第三节）' });
      } else if (!r.numbered) {
        unnumbered.push(r);
        inventory.push({
          level: r.level,
          parent: r.parent,
          name: r.name,
          verdict: r.soft.length ? `未编号，不动（提示：${r.soft.join('；')}）` : '未编号，不动',
        });
        // 未编号但"有话说"（期次形态、纯数字名、含禁用字符…）：按要求不动，
        // 但进「需人工确认」—— 需不需要动是用户的决定，不是脚本的。
        if (r.soft.length) manual.push(r);
      } else {
        inventory.push({ level: r.level, parent: r.parent, name: r.name, verdict: '合规' });
        if (r.soft.length) manual.push(r);
      }
    }
    return rows;
  };

  // 第 1 层
  const l1Names = [];
  for (const n of rootDirs) {
    if (IGNORED_PREFIX.test(n)) {
      ignored.push({ level: '第1层', parent: '(根)', name: n });
      continue;
    }
    l1Names.push(n);
    level1.push(n);
  }
  const l1Rows = handleLevel('第1层', '(根)', l1Names);

  // 第 2 层（根的直接子目录的直接子目录）
  for (const n of l1Names) {
    const { dirs: subs, error } = listDirs(join(root, n));
    if (error) {
      unreadable.push({ level: '第2层', parent: n, name: n, error });
      continue;
    }
    const names = [];
    for (const s of subs) {
      if (IGNORED_PREFIX.test(s)) {
        ignored.push({ level: '第2层', parent: n, name: s });
        continue;
      }
      names.push(s);
      level2.push({ parent: n, name: s });
    }
    handleLevel('第2层', n, names);
  }

  return { level1, level2, l1Rows, inventory, ignored, unreadable, violations, unnumbered, manual, dupGroups };
}

/* ============================== 报告 ============================== */

function mdCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function isInside(rootAbs, targetAbs) {
  const rel = relative(rootAbs, targetAbs);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function assertOutsideScanRoot(scanRoot, outPath) {
  if (isInside(scanRoot, outPath)) {
    throw new Error(`拒绝写入：报告路径在被扫描的目录之内（${outPath}）—— 本脚本只读，不在被体检的目录里留任何东西`);
  }
}

function buildSummaryRows(res) {
  const rows = [];
  for (const v of res.violations) {
    rows.push({
      kind: '不合规',
      level: v.level,
      path: v.parent === '(根)' ? v.name : `${v.parent}\\${v.name}`,
      current: v.name,
      suggested: v.suggested ?? '（无，需人工确认）',
      conflict: v.conflict ? `是（与 ${v.conflictWith.join('、')} 同名）` : '否',
      reason: v.reasons.join('；'),
    });
  }
  for (const u of res.manual) {
    if (rows.some((r) => r.path === (u.parent === '(根)' ? u.name : `${u.parent}\\${u.name}`))) continue;
    rows.push({
      kind: '需确认',
      level: u.level,
      path: u.parent === '(根)' ? u.name : `${u.parent}\\${u.name}`,
      current: u.name,
      suggested: u.suggested ?? '（不动）',
      conflict: u.conflict ? `是（与 ${u.conflictWith.join('、')} 同名）` : '否',
      reason: (u.numbered ? u.reasons.join('；') : '未编号，按要求不动') + (u.soft.length ? `｜提示：${u.soft.join('；')}` : ''),
    });
  }
  for (const g of res.dupGroups) {
    rows.push({
      kind: '重名',
      level: g.level,
      path: g.parent === '(根)' ? g.names.join('、') : `${g.parent}\\ 下：${g.names.join('、')}`,
      current: g.names.join('、'),
      suggested: '（需人工确认）',
      conflict: '—',
      reason: '③同级重名（Windows 大小写不敏感）',
    });
  }
  return rows;
}

function buildReport(res, ctx) {
  const { scanRoot, before, after, readonlyOk, generatedAt } = ctx;
  const L = [];
  const push = (s = '') => L.push(s);

  const l1Total = res.level1.length;
  const l2Total = res.level2.length;
  const total = l1Total + l2Total;
  const numberedTotal = total - res.unnumbered.length;
  const compliantTotal = numberedTotal - res.violations.length;

  push('# 命名整理报告 —— 工作test（只读扫描）');
  push();
  push(`> 生成时间：${generatedAt}`);
  push('> 依据：`docs/10-目录绑定方案.md` **§12 命名规范（定稿）**');
  push('> 生成脚本：`scripts/check-folder-names.mjs`（只读）');
  push();
  push('**本报告没有重命名、移动、删除任何一个目录或文件。** 详见最后一节「只读保证」。');
  push();

  push('## 一、扫描范围');
  push();
  push(`- 扫描根目录：\`${scanRoot}\``);
  push('- 扫描层级：**第 1 层**（根的直接子目录）+ **第 2 层**（第 1 层的直接子目录）');
  push('- 忽略：`.` 开头目录、`_` 开头目录（契约 §12.5 —— 平台自己的目录）');
  push('- 只读：仅 `readdir` / `stat` 元数据，不读文件内容、不写被扫描目录');
  push('- 平台不触碰 iCloud 原目录；本次只扫这份 `工作test`（契约 §12.6）');
  push();

  push('## 二、统计');
  push();
  push('| 指标 | 数量 |');
  push('|---|---|');
  push(`| 扫描目录总数（第1层+第2层） | ${total} |`);
  push(`| 　其中 第 1 层 | ${l1Total} |`);
  push(`| 　其中 第 2 层 | ${l2Total} |`);
  push(`| 应当编号（以「数字」开头） | ${numberedTotal} |`);
  push(`| 　已合规 | ${compliantTotal} |`);
  push(`| **不合规（需改名）** | **${res.violations.length}** |`);
  push(`| 未编号（按要求不动） | ${res.unnumbered.length} |`);
  push(`| 同级重名组 | ${res.dupGroups.length} |`);
  push(`| 需人工确认 | ${res.manual.length} |`);
  push(`| 已忽略目录（点开头 / 下划线开头） | ${res.ignored.length} |`);
  push(`| 读不到的目录 | ${res.unreadable.length} |`);
  push();
  push('说明：**未编号的目录不作为待办项**。契约 §12.2 要求「没编号的目录一律不动」，');
  push('平台不给它们补编号，只把它们列出来供人工判断。');
  push();

  push('## 三、不合规清单（逐条）');
  push();
  if (!res.violations.length) {
    push('无。应当编号的层级里没有发现不合规的目录。');
  } else {
    push('| # | 层级 | 所在目录 | 当前名 | 建议新名 | 冲突 | 原因 |');
    push('|---|---|---|---|---|---|---|');
    res.violations.forEach((v, i) => {
      push(
        `| ${i + 1} | ${mdCell(v.level)} | ${mdCell(v.parent)} | \`${mdCell(v.name)}\` | \`${mdCell(v.suggested ?? '—')}\` | ${
          v.conflict ? `**是**（与 \`${mdCell(v.conflictWith.join('、'))}\` 同名）` : '否'
        } | ${mdCell(v.reasons.join('；'))} |`,
      );
    });
  }
  push();
  push('判定口径（契约 §12.7）：① 用 `-`/`_` 作编号分隔；② 编号后缺分隔点或格式怪异；③ 同级重名；④ 含禁用字符。');
  push();

  push('## 四、同级重名');
  push();
  if (!res.dupGroups.length) {
    push('无。');
  } else {
    push('| # | 层级 | 所在目录 | 重名成员 |');
    push('|---|---|---|---|');
    res.dupGroups.forEach((g, i) => {
      push(`| ${i + 1} | ${mdCell(g.level)} | ${mdCell(g.parent)} | ${g.names.map((n) => `\`${mdCell(n)}\``).join('、')} |`);
    });
    push();
    push('Windows 大小写不敏感：`A` 与 `a`、`x` 与 `x.`（末尾点）都算重名。');
  }
  push();

  push('## 五、未编号目录（按要求不动）');
  push();
  if (!res.unnumbered.length) {
    push('无。');
  } else {
    push('| # | 层级 | 所在目录 | 当前名 | 处理 |');
    push('|---|---|---|---|---|');
    res.unnumbered.forEach((u, i) => {
      const note = u.soft.length ? `未编号，按要求不动（提示：${mdCell(u.soft.join('；'))}）` : '未编号，按要求不动';
      push(`| ${i + 1} | ${mdCell(u.level)} | ${mdCell(u.parent)} | \`${mdCell(u.name)}\` | ${note} |`);
    });
  }
  push();

  const periodLike = res.unnumbered.filter((u) => u.periodLike);
  push('## 六、期次目录观察');
  push();
  push('契约 §12.3 定稿：期次用 **A 型两级** `YYYY\\MM月`（默认格式串 `{yyyy}\\{mm}月` → `2026\\10月`）。');
  push();
  if (!periodLike.length) {
    push('本次扫描没有发现期次形态的目录。');
  } else {
    push('发现的期次形态目录（**按要求不动**，仅提示）：');
    push();
    push('| # | 所在目录 | 当前名 | 说明 |');
    push('|---|---|---|---|');
    periodLike.forEach((u, i) => {
      push(`| ${i + 1} | ${mdCell(u.parent)} | \`${mdCell(u.name)}\` | 单层写法；A 型为 \`YYYY\\MM月\` 两级 |`);
    });
    push();
    const flatParents = [...new Set(periodLike.map((u) => u.parent))];
    for (const p of flatParents) {
      const names = periodLike.filter((u) => u.parent === p).map((u) => u.name);
      const hasYear = names.some((n) => /年$/.test(n));
      const hasMonth = names.some((n) => /月$/.test(n));
      if (hasYear && hasMonth) {
        push(`- \`${p}\` 下 \`${names.join('、')}\` **平铺在同一层**：年份与月份是兄弟目录，`);
        push(`  A 型要求 \`${p}\\<年>\\<月>月\` 两级；是否整理**由用户决定**，本报告不给出改名动作。`);
      }
    }
  }
  push();

  push('## 七、需人工确认');
  push();
  if (!res.manual.length) {
    push('无。');
  } else {
    push('| # | 层级 | 所在目录 | 当前名 | 建议新名 | 需确认什么 |');
    push('|---|---|---|---|---|---|');
    res.manual.forEach((u, i) => {
      const why = [
        u.numbered && u.reasons.length ? `不合规：${u.reasons.join('；')}` : null,
        !u.numbered ? '未编号（按要求不动）' : null,
        u.soft.length ? u.soft.join('；') : null,
      ]
        .filter(Boolean)
        .join('｜');
      push(`| ${i + 1} | ${mdCell(u.level)} | ${mdCell(u.parent)} | \`${mdCell(u.name)}\` | \`${mdCell(u.suggested ?? '（不动）')}\` | ${mdCell(why)} |`);
    });
  }
  push();
  if (res.unreadable.length) {
    push('### 读不到的目录');
    push();
    for (const u of res.unreadable) push(`- \`${u.parent}\`（${u.name}）：${mdCell(u.error)}`);
    push();
  }

  push('## 八、只读保证');
  push();
  push('| 快照项 | 扫描前 | 扫描后 | 一致 |');
  push('|---|---|---|---|');
  push(`| 全树条目清单哈希（目录+文件相对路径） | \`${before.listingHash.slice(0, 16)}…\` | \`${after.listingHash.slice(0, 16)}…\` | ${before.listingHash === after.listingHash ? '✅' : '❌'} |`);
  push(`| 目录 mtime 哈希（含根目录） | \`${before.dirHash.slice(0, 16)}…\` | \`${after.dirHash.slice(0, 16)}…\` | ${before.dirHash === after.dirHash ? '✅' : '❌'} |`);
  push(`| 根目录 mtimeMs | ${before.rootMtimeMs} | ${after.rootMtimeMs} | ${before.rootMtimeMs === after.rootMtimeMs ? '✅' : '❌'} |`);
  push(`| 目录数 | ${before.dirCount} | ${after.dirCount} | ${before.dirCount === after.dirCount ? '✅' : '❌'} |`);
  push(`| 文件数 | ${before.fileCount} | ${after.fileCount} | ${before.fileCount === after.fileCount ? '✅' : '❌'} |`);
  push();
  push(`**结论：${readonlyOk ? '扫描前后快照完全一致 —— 零改动，没有重命名任何目录。' : '⚠️ 快照不一致！扫描期间被扫描目录发生了变化（可能来自其它进程），请人工核对。'}**`);
  push();
  push('保证手段：');
  push();
  push('1. 脚本内**没有**任何 `rename` / `move` / `cp` / `rm` / `mkdir` / `utimes` / `chmod` 调用；');
  push('2. 扫描阶段只用 `readdir` / `stat` / `lstat` 元数据读取，不打开文件内容；');
  push('3. 唯一的写调用 `writeFileSync` 只用于写**本报告**，且写之前校验报告路径**不在被扫描的目录之内**；');
  push('4. 报告写在平台自己的 `docs/` 下，不落在 `工作test` 里；');
  push('5. 扫描前后各做一次全树快照（见上表）并比对。');
  push();
  push('---');
  push();
  push('### 附：本次扫描的完整目录清单（第 1 层 / 第 2 层）');
  push();
  push('| 层级 | 所在目录 | 目录名 | 判定 |');
  push('|---|---|---|---|');
  for (const r of res.inventory) {
    push(`| ${mdCell(r.level)} | ${mdCell(r.parent)} | \`${mdCell(r.name)}\` | ${mdCell(r.verdict)} |`);
  }
  push();

  return L.join('\n');
}

/* ============================== 入口 ============================== */

function parseArgs(argv) {
  const args = { root: null, out: DEFAULT_OUT, write: true, json: false, limit: 30 };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') {
      args.out = resolve(argv[++i] ?? '');
    } else if (a.startsWith('--out=')) {
      args.out = resolve(a.slice('--out='.length));
    } else if (a === '--stdout') {
      args.write = false;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--limit') {
      args.limit = Number(argv[++i] ?? 30) || 30;
    } else if (a.startsWith('--')) {
      throw new Error(`未知参数：${a}`);
    } else {
      rest.push(a);
    }
  }
  args.root = resolve(rest[0] ?? DEFAULT_SCAN_ROOT);
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const scanRoot = args.root;

  if (!existsSync(scanRoot)) throw new Error(`扫描根目录不存在：${scanRoot}`);

  // ── 只读：扫描前快照
  const before = snapshotTree(scanRoot);

  // ── 只读：扫描（这一步与下一步都不写任何东西）
  const res = scan(scanRoot);

  // ── 只读：扫描后快照
  const after = snapshotTree(scanRoot);
  const readonlyOk = sameSnapshot(before, after);

  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const rows = buildSummaryRows(res);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scanRoot,
          generatedAt,
          readonlyOk,
          before,
          after,
          stats: {
            level1: res.level1.length,
            level2: res.level2.length,
            total: res.level1.length + res.level2.length,
            violations: res.violations.length,
            unnumbered: res.unnumbered.length,
            dupGroups: res.dupGroups.length,
            manual: res.manual.length,
            ignored: res.ignored.length,
            unreadable: res.unreadable.length,
          },
          violations: res.violations.map((v) => ({
            level: v.level,
            parent: v.parent,
            current: v.name,
            suggested: v.suggested,
            conflict: v.conflict,
            conflictWith: v.conflictWith,
            reasons: v.reasons,
          })),
          rows,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const report = buildReport(res, { scanRoot, before, after, readonlyOk, generatedAt });
    if (args.write) {
      assertOutsideScanRoot(scanRoot, args.out);
      const dir = dirname(args.out);
      if (!existsSync(dir)) throw new Error(`报告目录不存在：${dir}`);
      // ↓↓↓ 全脚本唯一的写调用：写报告，且已验证报告不在被扫描目录之内
      writeFileSync(args.out, report, 'utf8');
      process.stdout.write(`报告已写入：${args.out}\n`);
    } else {
      process.stdout.write(`${report}\n`);
    }

    const total = res.level1.length + res.level2.length;
    process.stdout.write('\n');
    process.stdout.write(
      `扫描目录 ${total}（第1层 ${res.level1.length} / 第2层 ${res.level2.length}）｜` +
        `不合规 ${res.violations.length}｜未编号(不动) ${res.unnumbered.length}｜` +
        `同级重名 ${res.dupGroups.length} 组｜需人工确认 ${res.manual.length}｜` +
        `忽略 ${res.ignored.length}｜只读校验 ${readonlyOk ? '通过（零改动）' : '失败'}\n`,
    );

    if (rows.length) {
      process.stdout.write(`\n摘要（前 ${Math.min(args.limit, rows.length)} 条 / 共 ${rows.length} 条可执行项）：\n`);
      process.stdout.write('| # | 类型 | 层级 | 当前名（相对根） | 建议新名 | 冲突 | 原因 |\n');
      process.stdout.write('|---|---|---|---|---|---|---|\n');
      rows.slice(0, args.limit).forEach((r, i) => {
        process.stdout.write(
          `| ${i + 1} | ${r.kind} | ${r.level} | ${r.path} | ${r.suggested} | ${r.conflict} | ${r.reason} |\n`,
        );
      });
    }
    process.stdout.write('\n只读声明：本脚本没有重命名、移动、删除任何目录或文件。\n');
  }
}

main();
