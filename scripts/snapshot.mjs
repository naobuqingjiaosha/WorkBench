/** Offline paired backup. Restore ONLY into a new empty directory, never over live data.
 * node scripts/snapshot.mjs create --db <db> --files <dataRoot> --out <new-directory>
 * node scripts/snapshot.mjs verify --snapshot <directory>
 * node scripts/snapshot.mjs restore --snapshot <directory> --to <new-directory>
 */
import {DatabaseSync,backup} from 'node:sqlite';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,copyFileSync,lstatSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute,win32,posix} from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2),mode=args[0];
const arg=k=>{const i=args.indexOf(k);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw Error('缺少参数 '+k);return resolve(args[i+1]);};
const hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex');
function noLinks(path){let p=resolve(path);for(;;){try{if(lstatSync(p).isSymbolicLink())throw Error('快照不跟随目录或文件链接：'+p);}catch(e){if(e.code!=='ENOENT')throw e;}const parent=dirname(p);if(parent===p)break;p=parent;}}
function inside(root,rel){const path=resolve(root,rel),r=relative(root,path);if(isAbsolute(r)||r==='..'||r.startsWith('..\\')||r.startsWith('../'))throw Error('快照路径越界');return path;}
function entries(root){const out=[];function visit(path){for(const item of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(path,item.name);if(lstatSync(p).isSymbolicLink())throw Error('快照不跟随目录或文件链接：'+p);if(item.isDirectory())visit(p);else if(item.isFile())out.push({path:relative(root,p).replaceAll('\\','/'),size:lstatSync(p).size,sha256:hash(p)});}}visit(root);return out;}
function emptyDestination(path){noLinks(path);if(existsSync(path))throw Error('目标必须是尚不存在的新目录，拒绝覆盖：'+path);mkdirSync(path,{recursive:true});}
function dbCheck(file){const db=new DatabaseSync(file,{readOnly:true});try{const quick=db.prepare('PRAGMA quick_check').get().quick_check,foreign=db.prepare('PRAGMA foreign_key_check').all();if(quick!=='ok'||foreign.length)throw Error('数据库完整性校验失败');return {quick,foreignKeys:foreign.length,migration:db.prepare('SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1').get()?.version};}finally{db.close();}}
function verify(folder){noLinks(folder);noLinks(join(folder,'manifest.json'));noLinks(join(folder,'workbench.db'));noLinks(join(folder,'files'));const m=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));if(m.format!==1||!Array.isArray(m.files)||new Set(m.files.map(f=>f.path)).size!==m.files.length)throw Error('未知快照格式或重复文件');if(hash(join(folder,'workbench.db'))!==m.database.sha256)throw Error('数据库摘要不匹配');for(const f of m.files){const path=inside(join(folder,'files'),f.path);noLinks(path);if(lstatSync(path).size!==f.size||hash(path)!==f.sha256)throw Error('文件摘要不匹配：'+f.path);}const actual=entries(join(folder,'files'));if(actual.length!==m.files.length)throw Error('快照文件集合已变化');return {manifest:m,integrity:dbCheck(join(folder,'workbench.db'))};}
// Only the recovered DB is edited. External originals keep their original binding.
function relocateManagedReferences(file, manifest, filesRoot) {
 const db = new DatabaseSync(file);
 try {
  const hasColumn = (table, column) => db.prepare('PRAGMA table_info('+table+')').all().some(c=>c.name===column);
  const pathStyle = manifest.sourcePathStyle === 'win32' ? win32 : posix;
  const original = manifest.sourceFilesRoot;
  let relocated = 0, external = 0, unknown = 0;
  const move = value => {
   if (!value || typeof value !== 'string') return value;
   if (!original) { unknown++; return value; }
   if (!pathStyle.isAbsolute(original)) throw Error('快照的原始文件根不是绝对路径');
   if (!pathStyle.isAbsolute(value)) return value;
   const suffix = pathStyle.relative(original,value);
   if (suffix === '..' || suffix.startsWith('..'+pathStyle.sep) || pathStyle.isAbsolute(suffix)) { external++; return value; }
   relocated++;
   return inside(filesRoot, suffix.split(pathStyle.sep).join('/'));
  };
  db.exec('PRAGMA foreign_keys=ON; BEGIN');
  for (const [table,column] of [['annual_ledger','path'],['ledger_document','path'],['workbench','custom_output_dir']]) {
   if (!hasColumn(table,column)) continue;
   const update = db.prepare('UPDATE '+table+' SET '+column+'=? WHERE id=?');
   for (const row of db.prepare('SELECT id,'+column+' AS path FROM '+table+' WHERE '+column+' IS NOT NULL').all()) {
    const next = move(row.path);
    if (row.path !== next) update.run(next,row.id);
   }
  }
  if (hasColumn('annual_ledger','metadata')) {
   for (const row of db.prepare('SELECT id,metadata FROM annual_ledger').all()) {
    const meta = JSON.parse(row.metadata);
    let changed = false;
    for (const kind of ['work','supervision']) {
     const old = meta.templates?.[kind], next = move(old);
     if (old !== next) { meta.templates[kind]=next; changed=true; }
    }
    if (changed) db.prepare('UPDATE annual_ledger SET metadata=? WHERE id=?').run(JSON.stringify(meta),row.id);
   }
  }
  db.exec('COMMIT');
  return {relocated,external,unknown};
 } finally { db.close(); }
}
try{
 if(mode==='create'){
  const dbFile=arg('--db'),files=arg('--files'),out=arg('--out');
  if(!existsSync(dbFile)||!existsSync(files))throw Error('源数据库或文件根不存在');
  const overlap=relative(files,out);if(!overlap.startsWith('..')&&!isAbsolute(overlap))throw Error('快照不能存入被备份的文件根');
  process.env.WORKBENCH_DB=dbFile;process.env.WORKBENCH_DATA_DIR=files;
  const {assertNoPathLinks}=await import('../packages/server/src/core/paths.ts');assertNoPathLinks(dbFile);assertNoPathLinks(files);assertNoPathLinks(out);
  const {acquireServerLock}=await import('../packages/server/src/core/server-lock.ts');acquireServerLock();
  emptyDestination(out);
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try{
   const version=db.prepare('PRAGMA data_version').get().data_version,before=entries(files);
   await backup(db,join(out,'workbench.db'));
   for(const f of before){const dest=inside(join(out,'files'),f.path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(inside(files,f.path),dest);}
   mkdirSync(join(out,'files'),{recursive:true});
   if(JSON.stringify(before)!==JSON.stringify(entries(files))||db.prepare('PRAGMA data_version').get().data_version!==version)throw Error('备份过程中来源被修改，快照未完成，请停止编辑后重试');
   const manifest={format:1,sourceFilesRoot:files,sourcePathStyle:process.platform==='win32'?'win32':'posix',createdAt:new Date().toISOString(),database:{sha256:hash(join(out,'workbench.db'))},files:before,externalOriginals:'外部绑定/参考原件只读且不在此快照内；保持原路径或另行备份'};
   writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));
   const checked=verify(out);console.log(JSON.stringify({ok:true,snapshot:out,files:before.length,integrity:checked.integrity}));
  }finally{db.close();}
 }else if(mode==='verify'){
  const result=verify(arg('--snapshot'));console.log(JSON.stringify({ok:true,files:result.manifest.files.length,integrity:result.integrity}));
 }else if(mode==='restore'){
  const source=arg('--snapshot'),target=arg('--to'),checked=verify(source);
  emptyDestination(target);mkdirSync(join(target,'runtime'));mkdirSync(join(target,'files'));
  copyFileSync(join(source,'workbench.db'),join(target,'runtime','workbench.db'));
  for(const f of checked.manifest.files){const dest=inside(join(target,'files'),f.path);mkdirSync(dirname(dest),{recursive:true});copyFileSync(inside(join(source,'files'),f.path),dest);if(hash(dest)!==f.sha256)throw Error('恢复文件校验失败：'+f.path);}
  if(hash(join(target,'runtime','workbench.db'))!==checked.manifest.database.sha256)throw Error('恢复数据库摘要不匹配');
  const paths=relocateManagedReferences(join(target,'runtime','workbench.db'),checked.manifest,join(target,'files'));
  if(paths.unknown)console.warn('历史快照没有原文件根，需人工核对台账、模板或自定义输出路径后再使用恢复库。');
  const environment={WORKBENCH_HOME:target,WORKBENCH_DB:join(target,'runtime','workbench.db'),WORKBENCH_DATA_DIR:join(target,'files'),WORKBENCH_RUNTIME_DIR:join(target,'runtime')};
  writeFileSync(join(target,'restore-environment.json'),JSON.stringify(environment,null,2));
  console.log(JSON.stringify({ok:true,target,paths,files:checked.manifest.files.length,integrity:dbCheck(environment.WORKBENCH_DB),environment}));
 }else throw Error('用法：create --db --files --out | verify --snapshot | restore --snapshot --to；目标必须为新目录');
}catch(e){console.error((e instanceof Error?e.message:String(e)));process.exitCode=1;}
