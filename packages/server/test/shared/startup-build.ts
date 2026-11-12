import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFileSync,cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {sourceFiles,treeHash,sourceIdentity,validateInstalledVersions} from '../../../../scripts/source-build.mjs';

const root=process.cwd(),home=process.env.WORKBENCH_ISOLATION_ROOT!;
validateInstalledVersions(root);
// Keep synthetic code beside (not inside) the data root, as production's
// isolation contract rejects data roots containing an installation directory.
const checkout=mkdtempSync(join(dirname(home),'workbench-startup-code-合成 空间-'));
for(const file of sourceFiles(root)){const dest=join(checkout,file);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(root,file),dest);}
cpSync(join(root,'node_modules'),join(checkout,'node_modules'),{recursive:true,verbatimSymlinks:true});
const fault=pathToFileURL(join(root,'packages/server/test/shared/startup-transport.ts')).href;
const trace=join(home,'transport-trace');writeFileSync(trace,'');
const env={...process.env,STARTUP_TRANSPORT_FAULT:'files',STARTUP_TRANSPORT_TRACE:trace,
 NODE_OPTIONS:(process.env.NODE_OPTIONS||'')+' --import='+JSON.stringify(fault)};
function launch(extra={}){
 const child=spawn(process.execPath,['scripts/start.mjs','--start-only'],{cwd:checkout,env:{...env,...extra},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const exit=new Promise<number|null>((ok,fail)=>{child.once('error',fail);child.once('exit',ok);});
 return {child,exit,output:()=>output};
}
const base=process.env.BASE!,pointer=join(process.env.WORKBENCH_RUNTIME_DIR!,'source-current.json');
const health=async()=>fetch(base+'/api/health',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).then(r=>r.data).catch(()=>null);
const first=launch();
let pid:number|undefined;
async function stopped(run:ReturnType<typeof launch>){
 const timer=setTimeout(()=>run.child.kill('SIGKILL'),120000);
 try{return await run.exit;}finally{clearTimeout(timer);}
}
try{
 let current;
 for(let i=0;i<1200&&first.child.exitCode===null;i++){
  if(existsSync(pointer)&&(current=await health())?.loadedBuild?.sourceBuildId)break;
  await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(current?.loadedBuild?.sourceBuildId,first.output().slice(-12000));pid=current.loadedBuild.pid;
 assert.equal(current.runtimeProfile,'test');assert.equal(current.dbFile,process.env.WORKBENCH_DB);
 assert.equal(current.loadedBuild.sourceBuildId,sourceIdentity(checkout).id);
 const record=readFileSync(pointer),saved=JSON.parse(record.toString());
 const good=join(home,'source-builds',saved.id),webHash=treeHash(join(good,'web')),manifest=readFileSync(join(good,'SOURCE_BUILD.json'));
 const files=process.env.WORKBENCH_DATA_DIR!,backups=process.env.WORKBENCH_BACKUP_DIR!;
 mkdirSync(backups,{recursive:true});writeFileSync(join(backups,'synthetic-backup'),'retained backup');
 writeFileSync(join(files,'synthetic-original'),'retained file');
 const fileHash=treeHash(files),backupHash=treeHash(backups);
 const dbHash=()=>['','-wal','-shm'].filter(s=>existsSync(process.env.WORKBENCH_DB!+s)&&s!=='-shm').map(s=>createHash('sha256').update(readFileSync(process.env.WORKBENCH_DB!+s)).digest('hex'));
 const database=dbHash();
 const unchanged=async()=>{
  const now=await health();assert.equal(now?.loadedBuild.pid,pid);assert.equal(now?.loadedBuild.sourceBuildId,saved.id);
  assert.deepEqual(readFileSync(pointer),record);assert.deepEqual(readFileSync(join(good,'SOURCE_BUILD.json')),manifest);
  assert.equal(treeHash(join(good,'web')),webHash);assert.deepEqual(dbHash(),database);assert.equal(treeHash(files),fileHash);assert.equal(treeHash(backups),backupHash);
  assert.ok(!existsSync(join(process.env.WORKBENCH_RUNTIME_DIR!,'source-update.lock')));
  assert.ok(!readdirSync(join(home,'source-builds')).some(n=>n.includes('.building-')));
 };
 // A second start reuses the same process, never chooses a second port/instance.
 const same=launch({STARTUP_TRANSPORT_FAULT:'all'});assert.equal(await stopped(same),0,same.output());await unchanged();
 const config=join(checkout,'packages/web/vite.config.ts'),valid=readFileSync(config);
 writeFileSync(config,Buffer.concat([valid,Buffer.from('\nexport const broken = ;\n')]));
 const broken=launch();assert.equal(await stopped(broken),1);assert.match(broken.output(),/Unexpected|Expected/);assert.match(broken.output(),/未停止原服务/);assert.ok(!broken.output().includes('缓存不足'));await unchanged();
 // Restore valid config, change a source comment, then fail native transform in
 // the dependency probe. This must not become a cache miss or npm reinstall.
 writeFileSync(config,Buffer.concat([valid,Buffer.from('\n// synthetic new build\n')]));
 const denied=launch({STARTUP_TRANSPORT_FAULT:'all'});assert.equal(await stopped(denied),1);assert.match(denied.output(),/remove synthetic esbuild-temp: Access is denied/);assert.ok(!/缓存不足|离线安装/.test(denied.output()));await unchanged();
 assert.ok(!readFileSync(trace,'utf8').includes('input-file'),'daily build must use pipe even under temp-delete fault');
 // Cached artifact tampering must fail before launch, with a useful diagnostic.
 const adapter=pathToFileURL(join(checkout,'scripts/esbuild-transport.mjs')).href;
 const esbuild=join(checkout,'node_modules/esbuild/lib/main.js'),old=readFileSync(esbuild);writeFileSync(esbuild,Buffer.concat([old,Buffer.from('\n// synthetic mismatch\n')]));
 const {spawnSync}=await import('node:child_process');
 const mismatch=spawnSync(process.execPath,['--import',adapter,'-e',''],{cwd:checkout,env,encoding:'utf8'});assert.notEqual(mismatch.status,0);assert.match(mismatch.stderr,/适配与锁定源码不匹配/);writeFileSync(esbuild,old);
 console.log('启动构建：隔离真实Vite/后端就绪、同版本复用、构建语法失败/原生转译拒绝均保留原进程/库/文件/备份/成功指针；未重装、未隐式回退；适配摘要漂移拒绝');
}finally{
 if(pid){
  const session=await fetch(base+'/api/session').then(r=>r.json()).catch(()=>null);
  const current=await health();
  if(current?.loadedBuild?.pid===pid)await fetch(base+'/api/system/shutdown',{method:'POST',headers:{'Content-Type':'application/json','x-workbench-token':session?.data?.token||''},body:JSON.stringify({confirmed:true,startedAt:current.loadedBuild.startedAt})}).catch(()=>null);
 }
 if(first.child.exitCode===null){const timer=setTimeout(()=>first.child.kill('SIGTERM'),5000);try{await stopped(first);}finally{clearTimeout(timer);}}
 try{assert.equal(await health(),null,'isolated server must stop before runner cleanup');}
 finally{rmSync(checkout,{recursive:true,force:true});}
}
