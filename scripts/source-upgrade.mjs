/** Database preparation runs under the ordinary server lock, before the new server starts. */
import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,readdirSync,readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {assertNoPathLinks} from '../packages/server/src/core/path-boundary.ts';
export function pendingMigrations(dbFile,buildRoot) {
 const available=readdirSync(join(buildRoot,'packages/server/src/db/migrations')).filter(f=>f.endsWith('.sql')).sort().map(f=>f.slice(0,-4));
 if(!existsSync(dbFile))return {fresh:true,pending:available};
 const db=new DatabaseSync(dbFile,{readOnly:true});
 try {
  const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'").get();
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  if(!table&&tables.length)throw Error('已有数据库缺少迁移记录，拒绝猜测其版本；原库未改动');
  const applied=table?db.prepare('SELECT version FROM schema_migration').all().map(r=>r.version):[];
  const unknown=applied.filter(v=>!available.includes(v));
  if(unknown.length)throw Error('数据库包含当前源码不认识的迁移，拒绝降级启动：'+unknown.join(', '));
  return {fresh:!tables.length,pending:available.filter(v=>!applied.includes(v))};
 }finally{db.close();}
}
export async function backupAndRehearse(layout,build,plan) {
 if(!existsSync(layout.dbFile))return null;
 const dir=join(layout.backupRoot,'before-source-update-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid);
 assertNoPathLinks(dir);mkdirSync(dir,{recursive:true});
 const file=join(dir,'workbench.db'),db=new DatabaseSync(layout.dbFile,{readOnly:true});
 try{await backup(db,file);}finally{db.close();}
 const check=new DatabaseSync(file,{readOnly:true});
 try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('升级前数据库备份校验失败，停止更新');}finally{check.close();}
 writeFileSync(join(dir,'README.txt'),'升级前数据库备份。业务文件、配置与外部原件未搬动。不要直接覆盖正在使用的数据库；恢复应先关闭服务并核对配套文件。\n目标源码：'+build.id+'\n待执行迁移：'+plan.pending.join(', ')+'\n');
 console.log('升级前数据库备份：'+file);
 if(plan.pending.length){
  // Test every pending SQL in one transaction on a second copy. Original and backup remain untouched.
  const rehearsal=join(dir,'migration-check.db');const source=new DatabaseSync(file,{readOnly:true});
  try{await backup(source,rehearsal);}finally{source.close();}
  const trial=new DatabaseSync(rehearsal);
  try{
   trial.exec('PRAGMA foreign_keys=ON');trial.exec('BEGIN');
   trial.exec('CREATE TABLE IF NOT EXISTS schema_migration(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
   for(const version of plan.pending){trial.exec(readFileSync(join(build.root,'packages/server/src/db/migrations',version+'.sql'),'utf8'));trial.prepare('INSERT INTO schema_migration(version) VALUES(?)').run(version);}
   if(trial.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('迁移副本完整性检查失败');
   if(trial.prepare('PRAGMA foreign_key_check').all().length)throw Error('迁移副本存在外键错误');
   trial.exec('ROLLBACK');
  }catch(e){try{trial.exec('ROLLBACK');}catch{}throw Error('迁移演练失败，原数据库未执行升级：'+e.message);}
  finally{trial.close();rmSync(rehearsal,{force:true});}
 }
 return file;
}
