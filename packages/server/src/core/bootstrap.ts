import {initializeWorkflowBaselines} from '../domain/workflow-config.ts';
/**
 * 启动引导：初始化数据库 → 建目录 → 写默认配置 → 灌预置数据
 */
import {repairStoredState} from './startup-repair.ts';
import {processQueue} from './ocr-queue.ts';
import {ocrEnabled} from './ocr.ts';
import { initDatabase, getDb } from '../db/index.ts';
import { DB_FILE, applyDefaultSettings, ensureBaseDirs, writeRootConfigIfMissing } from '../core/config.ts';
import { seedProviders } from '../ai/providers.ts';
import { seedWorkTypesAndPositions } from '../domain/seed.ts';
import { seedArchiveFields } from '../domain/archive.ts';
import { reloadBoundRoots } from '../domain/service.ts';
import { readRestoreJournal, startBackupScheduler } from './backup.ts';

let booted = false;

export function bootstrap(): { dbFile: string; migrated: number } {
  if (booted) return { dbFile: DB_FILE, migrated: 0 };
  writeRootConfigIfMissing();
  ensureBaseDirs();
  const db = initDatabase(DB_FILE);
  applyDefaultSettings();
  seedProviders();
  seedWorkTypesAndPositions();
  initializeWorkflowBaselines();
  seedArchiveFields();
  repairStoredState();
  /**
   * 注入「允许根」白名单：`[DATA_ROOT, ...所有已绑定工作台的 external_root]`。
   * 必须在这里（库已初始化、种子已灌）而不是更早 —— reloadBoundRoots 要查 workbench 表。
   *
   * **不阻断启动**：绑定目录可能暂时不存在（移动硬盘没插、iCloud 占位、网络盘没连上），
   * 那是"这个工作台暂时用不了"，不是"平台起不来"。这里只警告一行，让它照常起来，
   * 用户在界面上还能看到是哪个目录丢了（工作台详情里有 folder_exists）。
   */
  try {
    const roots = reloadBoundRoots();
    if (roots.length > 1) console.log(`[目录绑定] 已注入 ${roots.length - 1} 个外部资料目录`);
  } catch (e) {
    console.warn(`[目录绑定] 绑定目录注入失败（不影响启动）：${e instanceof Error ? e.message : String(e)}`);
  }
  if(ocrEnabled() && process.env.WORKBENCH_TEST_MODE!=='1') setTimeout(()=>void processQueue(),100);
  /**
   * 数据库定时自动备份（core/backup.ts）。
   *
   * 放在启动最后、**不阻断启动**：备份目录不可写（盘没插、权限不对）是
   * "备份今天没做成"，不是"工作台起不来"。定时器自己每轮都会重新读配置，
   * 用户在界面上改开关/时间立即生效，不用重启。
   *
   * 另外看一眼恢复日志：若上一轮恢复被强杀（进程没了、日志还在），
   * 这里说一句话，让用户知道当前库是"换到一半"的那个状态。
   */
  const journal = readRestoreJournal();
  if (journal) {
    console.warn(`[备份] 上一次恢复没有正常结束（${journal.at}，从 ${journal.from} 恢复，阶段 ${journal.phase}）。`);
    console.warn(`[备份] 当前数据库：${journal.dbFile}；恢复前的自动备份：${journal.preRestore ?? '（无）'}。若数据不对，可在「设置 → 备份」里手动恢复。`);
  }
  try {
    startBackupScheduler();
  } catch (e) {
    console.warn(`[备份] 自动备份启动失败（不影响使用，可在设置页手动备份）：${e instanceof Error ? e.message : String(e)}`);
  }
  booted = true;
  void getDb();
  return { dbFile: DB_FILE, migrated: 0 };
}
