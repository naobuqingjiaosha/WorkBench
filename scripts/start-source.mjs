import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync,readFileSync,writeFileSync,mkdirSync,rmdirSync,openSync,closeSync,renameSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {loadRuntimeLayout} from '../packages/server/src/core/runtime-layout.ts';
import {assertNoPathLinks} from '../packages/server/src/core/path-boundary.ts';
import {assertTestIsolation} from '../packages/server/src/core/test-isolation.ts';
import {prepareBuild,sourceIdentity,verifyReadyBuild} from './source-build.mjs';
import {pendingMigrations,backupAndRehearse} from './source-upgrade.mjs';

assertTestIsolation();
const ROOT=resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
const desktop=args.includes('--desktop');
const background=desktop || args.includes('--background');
process.env.WORKBENCH_LAYOUT_ROOT=ROOT;
if(args.includes('--auto'))console.log('--auto 现沿用单实例启动；端口冲突会停止，不另开版本。');
const arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const layout=loadRuntimeLayout(ROOT),port=Number(arg('--port')||layout.port),host=arg('--host')||layout.host;
if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口无效');
const address=['0.0.0.0','::'].includes(host)?'127.0.0.1':host;
const url=`http://${address.includes(':')?'['+address+']':address}:${port}`;
const cache=layout.profile==='test'?join(layout.home,'source-builds'):join(ROOT,'.local','source-builds');
const pointer=join(layout.runtimeRoot,'source-current.json');
assertNoPathLinks(cache);assertNoPathLinks(pointer);
mkdirSync(layout.runtimeRoot,{recursive:true});
const lock=join(layout.runtimeRoot,'source-update.lock');assertNoPathLinks(lock);
try{mkdirSync(lock);}catch{throw Error('已有启动/更新正在准备，或上次准备意外中断：'+lock+'。不会并发更新；请等待，异常残留需核对后处理。');}
writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid,source:ROOT,startedAt:new Date().toISOString()}));
async function confirm(message){
 console.log(message);
 if(args.includes('--confirm-update'))return;
 if(!process.stdin.isTTY)throw Error('需要在交互启动窗口确认；无人值守命令须明确提供 --confirm-update');
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{if((await rl.question('确认继续？输入 Y 后回车，其余输入取消：')).trim().toLowerCase()!=='y')throw Error('已取消，未启动更新');}finally{rl.close();}
}
async function health(){try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(1500)});const b=await r.json();return r.ok&&b.ok&&b.data?.status==='ok'?b.data:null;}catch{return null;}}
function samePath(a,b){return typeof a==='string'&&(process.platform==='win32'?resolve(a).toLowerCase()===resolve(b).toLowerCase():resolve(a)===resolve(b));}
const belongs=h=>h&&samePath(h.dbFile,layout.dbFile)&&samePath(h.dataRoot,layout.dataRoot)&&h.runtimeProfile===layout.profile;
async function openPage(){if(!args.includes('--open'))return;const p=process.platform==='win32'?spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{stdio:'ignore',windowsHide:true}):spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});p.on('error',()=>console.log('请手动打开 '+url));p.unref();}
async function freePort(){return new Promise(r=>{const s=createServer();s.once('error',()=>r(false));s.listen(port,host,()=>s.close(()=>r(true)));});}
async function stopInstance(running){
  const current=await health();if(!belongs(current)||current.loadedBuild?.startedAt!==running.loadedBuild.startedAt)throw Error('运行实例已变化，请重新双击核对');
  const session=await(await fetch(url+'/api/session')).json();
  const stop=await fetch(url+'/api/system/shutdown',{method:'POST',headers:{'Content-Type':'application/json','x-workbench-token':session.data?.token||''},body:JSON.stringify({confirmed:true,startedAt:running.loadedBuild.startedAt})});
  if(!stop.ok){const detail=await stop.json().catch(()=>null);throw Error('工作台拒绝停止：'+(detail?.error?.message||'请查看该服务后重试'));}
  const oldLock=join(dirname(layout.dbFile),'server.lock');
  const released=()=>{try{return readFileSync(oldLock,'utf8').trim()!==String(running.loadedBuild.pid);}catch(e){if(e.code==='ENOENT')return true;throw e;}};
  const deadline=Date.now()+60000;
  while(Date.now()<deadline&&(!released()||await health()))await new Promise(r=>setTimeout(r,300));
  if(!released()||await health())throw Error('工作台尚未停止，请稍后核对启动日志。');
}
async function showWorkbench(running){
 await openPage();
 if(!desktop)return;
 finishLock();
 console.log('关闭此窗口可让工作台继续在后台运行。');
 const input=createInterface({input:process.stdin,output:process.stdout});
 try{
  for(;;){
   const answer=await input.question('要停止工作台，请先保存页面内容，再输入 S 并回车：');
   if(answer.trim().toUpperCase()==='S')break;
  }
 }finally{input.close();}
 await stopInstance(running);
 console.log('工作台已停止。');
}
let child,fd,releaseLock;
try{
 console.log('正在打开工作台…');
 let saved=null;try{saved=JSON.parse(readFileSync(pointer,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('上次启动记录无法读取，请核对 '+pointer);}
 // A record never gets to select an arbitrary path for execution.
 const savedRoot=saved?.id&&/^[a-f0-9]{64}$/.test(saved.id)&&saved.sourceRoot===ROOT?join(cache,saved.id):null;
 const identity=args.includes('--last-good') ? null : sourceIdentity(ROOT);
 if(savedRoot && identity?.id===saved.id){
  const running=await health();
  if(belongs(running) && running.loadedBuild?.sourceBuildId===identity.id){
   console.log('工作台已运行：'+url);
   await showWorkbench(running);
   returnFromStart();
  }
 }
 let build;
 try{
  if(args.includes('--last-good')){if(!savedRoot)throw Error('本目录没有可核验的上次可用副本');const m=await verifyReadyBuild(savedRoot,saved.id,ROOT);build={root:savedRoot,...m};console.log('明确选择上次可用版本：'+m.id.slice(0,12));}
  else build=await prepareBuild(ROOT,cache,savedRoot,identity);
 }catch(e){console.error('准备失败；未停止原服务，也未更新数据库。');console.error('修好问题后重新双击。需要恢复时，可明确运行 node scripts/start.mjs --last-good --open；历史发布包仍可用 --release 入口核对启动。');throw e;}
 const expectedPlan=pendingMigrations(layout.dbFile,build.root);
 if(!expectedPlan.fresh&&expectedPlan.pending.length)await confirm('数据库需要升级，待执行迁移：\n'+expectedPlan.pending.join('\n')+'\n将先备份数据库并在副本演练；失败不自动恢复或覆盖业务数据。');
 let running=await health();
 if(running){
  if(!belongs(running))throw Error('该端口属于不同环境，拒绝停止或改用其他端口；请核对配置。');
  if(running.loadedBuild?.sourceBuildId===build.id){console.log('当前源码已在运行：'+url);await showWorkbench(running);returnFromStart();}
  if(!running.loadedBuild?.sourceBuildId)throw Error('检测到旧启动方式的后台服务，不能安全自动接管。首次切换请先保存浏览器输入并停止旧服务（不清楚其启动窗口时，可重启电脑），再双击本入口；无需盘点或删除历史版本。');
  await confirm('已准备最新版本。更新需要重启工作台，请先在所有浏览器页面保存输入；正在处理的请求将等待结束。');
  await stopInstance(running);
 }
 if(!await freePort())throw Error('端口被占用，拒绝另开一个版本。请先核对占用服务。');
 // Use the same database lock as the server. Unknown/stale ownership rules stay unchanged.
 const {acquireServerLock}=await import('../packages/server/src/core/server-lock.ts');releaseLock=acquireServerLock();
 const plan=pendingMigrations(layout.dbFile,build.root);
 if(JSON.stringify(plan)!==JSON.stringify(expectedPlan))throw Error('确认期间数据库迁移状态已变化，拒绝继续；请重新启动核对。');
 const backup=(saved?.id!==build.id||plan.pending.length)&&existsSync(layout.dbFile)?await backupAndRehearse(layout,build,plan):null;
 if(backup)console.log('如启动失败，请保留此备份，先核对日志；不会自动倒回数据库或运行旧程序。');
 const logs=join(layout.runtimeRoot,'logs');mkdirSync(logs,{recursive:true});const logPath=join(logs,'source-'+Date.now()+'.log');fd=openSync(logPath,'a');
 const env={...process.env,WORKBENCH_LAYOUT_ROOT:ROOT,WORKBENCH_WEB_DIST:join(build.root,'web'),PORT:String(port),HOST:host,...(desktop || args.includes('--start-only')?{WORKBENCH_START_ONLY:'1'}:{})};
 // Validate the same original layout with only the prepared static path changed.
 loadRuntimeLayout(ROOT,env);
 releaseLock();releaseLock=null;
 child=spawn(process.execPath,[join(build.root,'packages/server/src/index.ts')],{cwd:build.root,env,detached:background,windowsHide:true,stdio:['ignore',fd,fd]});closeSync(fd);fd=undefined;
 let spawnError;child.on('error',e=>{spawnError=e;});
 if(background)child.unref();
 console.log('启动日志：'+logPath);
 const deadline=Date.now()+60000;let ready;
 while(Date.now()<deadline&&child.exitCode===null&&!spawnError){const h=await health();if(belongs(h)&&h.loadedBuild?.pid===child.pid&&h.loadedBuild?.sourceBuildId===build.id){ready=h;break;}await new Promise(r=>setTimeout(r,300));}
 if(!ready)throw Error('新版本未就绪。未覆盖上次成功记录；服务可能仍在初始化，请先核对日志 '+logPath+'，不要反复启动或自动回退数据库。');
 const temp=pointer+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify({format:1,id:build.id,sourceRoot:ROOT,previousId:saved?.id??null,startedAt:new Date().toISOString()}));renameSync(temp,pointer);
 console.log('当前版本 '+build.id.slice(0,12)+' 已就绪：'+url);await showWorkbench(ready);
 if(!background){
  console.log('停止服务请按 Ctrl+C。');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
  // Release the update lock before waiting for the foreground service lifetime.
  finishLock();await new Promise(r=>{child.once('exit',r);if(child.exitCode!==null)r();});process.exitCode=child.exitCode||0;
 }
} catch(e){if(e?.code!=='ALREADY_RUNNING')throw e;}
finally{if(fd!==undefined)closeSync(fd);releaseLock?.();finishLock();}
function returnFromStart(){const e=Error('already running');e.code='ALREADY_RUNNING';throw e;}
function finishLock(){try{const owner=JSON.parse(readFileSync(join(lock,'owner.json'),'utf8'));if(owner.pid===process.pid){unlinkSync(join(lock,'owner.json'));rmdirSync(lock);}}catch{}}
