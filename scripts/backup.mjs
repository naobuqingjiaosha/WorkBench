/**
 * 数据库备份命令行（服务没跑也能用）
 *
 *   node scripts/backup.mjs                  立即备份一份（手动）
 *   node scripts/backup.mjs --kind daily     指定类型：daily | weekly | manual
 *   node scripts/backup.mjs --list           列出现有备份与校验结论
 *   node scripts/backup.mjs --verify         逐份校验（quick_check + foreign_key_check）
 *   node scripts/backup.mjs --json           输出改成 JSON（给计划任务/脚本用，stdout 只有 JSON）
 *   node scripts/backup.mjs --dir D:/备份    指定备份目录（默认取 workbench.config.json 的 backup.dir）
 *   node scripts/backup.mjs --db <文件>      指定要备份的库（默认 data/runtime/workbench.db）
 *
 * 这里**不重写一份备份逻辑**：一致性快照、校验、保留策略、命名与边车文件全部复用
 * packages/server/src/core/backup.ts（与界面上的「立即备份」是同一条代码路径）。
 * 用 Windows 计划任务在服务没开的时候也能定时备份：
 *   schtasks /create /tn 工作台备份 /sc daily /st 12:30 /tr "node D:\project\工作台\scripts\backup.mjs --kind daily"
 *
 * 备份只含数据库，不含 data/files 里的用户文件；本命令不删除任何用户文件。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createBackup, createBackupOfFile, backupOverview, verifyAllBackups, KIND_LABEL } from '../packages/server/src/core/backup.ts';
import { DB_FILE, INSTALL_ROOT } from '../packages/server/src/core/config.ts';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const arg = (n) => {
  const i = args.indexOf(n);
  return i < 0 ? undefined : args[i + 1];
};

if (has('--help') || has('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 17).join('\n'));
  process.exit(0);
}

const kindArg = arg('--kind');
const kind = kindArg === 'daily' || kindArg === 'weekly' || kindArg === 'manual' ? kindArg : kindArg ? null : 'manual';
if (kind === null) {
  console.error(`--kind 只能是 daily | weekly | manual，收到：${kindArg}`);
  process.exit(2);
}

const dirArg = arg('--dir');
const dir = dirArg ? resolve(INSTALL_ROOT, dirArg) : undefined;
const dbArg = arg('--db') ? resolve(arg('--db')) : undefined;
const dbFile = dbArg ?? DB_FILE;
const asJson = has('--json');

function printItems(items) {
  if (!items.length) {
    console.log('（还没有备份）');
    return;
  }
  for (const b of items) {
    const state = b.ok === true ? '校验通过' : b.ok === false ? `坏：${(b.verify?.errors ?? []).join('；')}` : '未校验';
    console.log(
      `  ${b.name}  ${b.kindLabel}  ${new Date(b.createdAt).toLocaleString('zh-CN')}  ` +
        `${(b.sizeBytes / 1024).toFixed(0)} KB  工作台 ${b.verify?.workbenchCount ?? '?'} 个  ${state}` +
        (b.note ? `  ${b.note}` : ''),
    );
  }
}

/**
 * `--json` 时把 core 层的过程日志挤到 stderr，stdout 只剩一段能被 JSON.parse 的结果。
 * 不这么做的话 `node scripts/backup.mjs --json | 别的程序` 会先读到 "[备份] 日备完成：…"。
 * 自己那份 JSON 用 emit() 直接写 stdout —— console.log 这会儿正被重定向着。
 */
const emit = (text) => process.stdout.write(String(text) + '\n');
async function withQuietCoreStdout(fn) {
  if (!asJson) return fn();
  const log = console.log;
  const warn = console.warn;
  console.log = (...a) => console.error(...a);
  console.warn = (...a) => console.error(...a);
  try {
    // 必须 await：不然 async 函数体还没跑完，finally 就把 console.log 还原了
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

try {
  await withQuietCoreStdout(async () => {
    if (has('--list')) {
      const ov = backupOverview();
      if (asJson) emit(JSON.stringify(ov, null, 2));
      else {
        console.log(`备份目录：${ov.dir}`);
        console.log(`自动备份：${ov.config.auto ? '开' : '关'}（每天 ${ov.config.hour} 点后，保留日备 ${ov.config.keepDaily} / 周备 ${ov.config.keepWeekly}）`);
        printItems(ov.items);
      }
    } else if (has('--verify')) {
      const items = verifyAllBackups(dir);
      if (asJson) emit(JSON.stringify(items, null, 2));
      else {
        console.log(`已校验 ${items.length} 份备份：`);
        printItems(items);
        const bad = items.filter((i) => i.ok === false);
        if (bad.length) console.log(`\n注意：${bad.length} 份备份没通过校验。文件已保留（没有删除），可人工检查或删除。`);
      }
      if (items.some((i) => i.ok === false)) process.exitCode = 1;
    } else {
      if (!existsSync(dbFile)) {
        console.error(`找不到数据库文件：${dbFile}`);
        process.exit(2);
      }
      // 服务在跑也没问题：SQLite 在线备份 API 读的是"某一时刻的一致视图"
      const info = dbArg
        ? await createBackupOfFile({ dbFile, dir: dir ?? backupOverview().dir, kind, note: '命令行备份' })
        : await createBackup({ kind, dir, note: '命令行备份' });
      if (asJson) emit(JSON.stringify(info, null, 2));
      else {
        console.log(`${KIND_LABEL[info.kind]}完成：${join(dir ?? backupOverview().dir, info.name)}`);
        console.log(`  大小：${(info.sizeBytes / 1024).toFixed(0)} KB`);
        console.log(`  quick_check：${info.verify?.quickCheck}；foreign_key_check：${info.verify?.foreignKeyCheck} 处违规`);
        console.log(`  快照里的工作台：${info.verify?.workbenchCount} 个`);
        if (!info.ok) console.log(`  ⚠ 校验没通过（文件已保留，未删除）：${(info.verify?.errors ?? []).join('；')}`);
        if (info.pruned?.length) console.log(`  按保留策略清理了 ${info.pruned.length} 份旧备份`);
      }
      if (!info.ok) process.exitCode = 1;
    }
  });
} catch (e) {
  console.error(`备份操作失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
