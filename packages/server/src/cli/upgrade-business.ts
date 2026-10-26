/** Explicit, local metadata upgrade. No business source files are scanned, moved or deleted. */
import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {DB_FILE,RUNTIME_ROOT,BACKUP_ROOT} from '../core/config.ts';
import {isInsideRoot} from '../core/paths.ts';
import {initDatabase,closeDatabase,all,get} from '../db/index.ts';
import {seedWorkTypesAndPositions} from '../domain/seed.ts';

const runtime=RUNTIME_ROOT;
if(!isInsideRoot(runtime,DB_FILE))throw new Error('此升级命令仅用于当前环境的 runtime 数据库；隔离测试请使用测试入口');
const lock=join(dirname(DB_FILE),'server.lock');
if(existsSync(lock)){
 const pid=Number(readFileSync(lock,'utf8').trim());
 if(Number.isInteger(pid)&&pid>0){
  let running=false;try{process.kill(pid,0);running=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
  if(running)throw new Error('工作台服务仍在运行，请关闭后升级，避免新旧代码同时访问数据库');
 }
}
let backupPath:string|null=null;
if(existsSync(DB_FILE)){
 const dir=BACKUP_ROOT;mkdirSync(dir,{recursive:true});
 backupPath=join(dir,`business-before-${new Date().toISOString().replace(/[:.]/g,'-')}.db`);
 const source=new DatabaseSync(DB_FILE,{readOnly:true});
 try{await backup(source,backupPath);}finally{source.close();}
}
try{
 initDatabase(DB_FILE);
 seedWorkTypesAndPositions();
 if(all('PRAGMA foreign_key_check').length)throw new Error('升级后存在外键异常，请保留升级前备份进行核查');
 if(Object.values(get('PRAGMA integrity_check')??{})[0]!=='ok')throw new Error('数据库完整性检查失败');
 console.log(JSON.stringify({database:DB_FILE,backup:backupPath,migrations:all('SELECT version FROM schema_migration ORDER BY version DESC LIMIT 3'),integrity:'ok',foreignKeyErrors:0},null,2));
}finally{closeDatabase();}
