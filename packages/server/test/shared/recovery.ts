import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runMigrations } from '../../src/db/migrate.ts';
import { pendingMigrations, backupAndRehearse } from '../../../../scripts/source-upgrade.mjs';

const root = process.cwd(), dbFile = process.env.WORKBENCH_DB!, files = process.env.WORKBENCH_DATA_DIR!;
mkdirSync(dirname(dbFile), {recursive:true});
mkdirSync(files);
const inputPath = 'synthetic-source.txt';
writeFileSync(join(files,inputPath), '合成验收材料');
const db = new DatabaseSync(dbFile);
db.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migration(version TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)");
const migrations = join(root, 'packages/server/src/db/migrations');
for (const name of readdirSync(migrations).sort().filter(n => n.endsWith('.sql') && n < '041')) {
  db.exec(readFileSync(join(migrations,name),'utf8'));
  db.prepare('INSERT INTO schema_migration(version) VALUES(?)').run(name.slice(0,-4));
}
db.exec("INSERT INTO work_type(id,code,name) VALUES(1,'SYN','合成类型')");
db.exec("INSERT INTO workbench(id,code,name,work_type_id,folder_path) VALUES(1,'SYN001','合成历史',1,'synthetic')");
db.prepare("INSERT INTO artifact(workbench_id,title,file_rel,file_name) VALUES(1,'样例',?,?)").run(inputPath,inputPath);
// This old layout stored an absolute managed path plus an external template.
const managed=join(files,'ledger-copy.xlsx'), external=join(process.env.WORKBENCH_ISOLATION_ROOT!,'external','reference.xlsx');
writeFileSync(managed,'synthetic path fixture');
db.prepare('INSERT INTO annual_ledger(id,workbench_id,year,path,digest,metadata) VALUES(1,1,?,?,?,?)')
  .run('2024',managed,'synthetic',JSON.stringify({sheets:{},templates:{work:managed,supervision:external}}));
db.close();
const plan = pendingMigrations(dbFile, root);
assert.ok(plan.pending.includes('041_workflow_config'));
const backup = await backupAndRehearse({dbFile, backupRoot:process.env.WORKBENCH_BACKUP_DIR}, {root,id:'synthetic-upgrade'}, plan);
assert.ok(backup);
assert.deepEqual(pendingMigrations(dbFile,root),plan);
const snapshot = join(process.env.WORKBENCH_ISOLATION_ROOT!, 'snapshot');
const restored = join(process.env.WORKBENCH_ISOLATION_ROOT!, 'restored');
const script = 'scripts/snapshot.mjs';
function tool(...args:string[]) { execFileSync(process.execPath,[script,...args],{stdio:'pipe'}); }
tool('create','--db',dbFile,'--files',files,'--out',snapshot);
const upgraded = new DatabaseSync(dbFile);
try {
  upgraded.exec('PRAGMA foreign_keys=ON');
  assert.deepEqual(runMigrations(upgraded),plan.pending);
  assert.equal(upgraded.prepare('SELECT count(*) AS n FROM artifact WHERE workbench_id=1').get()!.n,1);
  assert.equal(upgraded.prepare('SELECT start_date FROM workbench WHERE id=1').get()!.start_date,null);
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(),[]);
} finally { upgraded.close(); }
tool('restore','--snapshot',snapshot,'--to',restored);
const restoredFile = join(restored,'runtime/workbench.db');
assert.deepEqual(pendingMigrations(restoredFile,root), plan);
const copy = new DatabaseSync(restoredFile,{readOnly:true});
try {
  const item=copy.prepare('SELECT a.file_rel, w.code FROM artifact a JOIN workbench w ON w.id=a.workbench_id').get()!;
  assert.equal(item.code,'SYN001');
  const ledger=copy.prepare('SELECT path,metadata FROM annual_ledger WHERE id=1').get()!;
  const newLedger=join(restored,'files','ledger-copy.xlsx');
  assert.equal(ledger.path,newLedger);
  assert.equal(JSON.parse(String(ledger.metadata)).templates.work,newLedger);
  assert.equal(JSON.parse(String(ledger.metadata)).templates.supervision,external);
  assert.equal(readFileSync(join(restored,'files',String(item.file_rel)),'utf8'),'合成验收材料');
} finally { copy.close(); }
assert.notEqual(spawnSync(process.execPath,[script,'restore','--snapshot',snapshot,'--to',restored]).status,0);
writeFileSync(join(snapshot,'files',inputPath),'篡改的样例');
assert.notEqual(spawnSync(process.execPath,[script,'verify','--snapshot',snapshot]).status,0);
console.log('旧库先演练后升级，配套文件恢复至新目录，重复覆盖与损坏均拒绝');
