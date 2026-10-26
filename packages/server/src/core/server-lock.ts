import {readFileSync,writeFileSync,unlinkSync,mkdirSync,rmdirSync,lstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {DB_FILE} from './config.ts';

/** Unknown is never stale: EPERM, unreadable/partial locks and reused live PIDs block startup. */
export function probeLockOwner(raw:string,probe:(pid:number)=>void=pid=>{process.kill(pid,0);}):'alive'|'dead'|'unknown' {
 const pid=Number(raw.trim());
 if(!/^\d+$/.test(raw.trim())||!Number.isSafeInteger(pid)||pid<=0)return 'unknown';
 try{probe(pid);return 'alive';}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'?'dead':'unknown';}
}
export function acquireServerLock():void {
 const path=join(dirname(DB_FILE),'server.lock'),guard=path+'.acquiring';
 mkdirSync(dirname(path),{recursive:true});
 // Serialize inspect/remove/create. A crashed acquisition needs manual inspection, never a timeout guess.
 try{mkdirSync(guard);}catch{throw new Error(`另一启动正在取得锁，或上次启动异常中断。请核实进程与目录后再处理：${guard}；不会自动清除未知锁。`);}
 try{
  let raw:string|undefined;
  try{if(!lstatSync(path).isFile())throw new Error('锁不是普通文件');raw=readFileSync(path,'utf8');}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new Error(`无法安全读取启动锁：${path}；请人工核实，拒绝启动。`);}
  if(raw!==undefined){
   const state=probeLockOwner(raw);
   if(state!=='dead')throw new Error(`同一数据库的锁仍有效或无法确认（${state}，进程 ${raw.trim()}）。拒绝重复启动，请核实原进程：${path}`);
   unlinkSync(path);
  }
  writeFileSync(path,String(process.pid),{flag:'wx'});
 }finally{rmdirSync(guard);}
 process.once('exit',()=>{try{if(readFileSync(path,'utf8')===String(process.pid))unlinkSync(path);}catch{}});
}
