/** 程序包默认不带个人资料；完整备份需 --with-runtime-state，且服务必须停止。 */
import {existsSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,cpSync,rmSync,statSync,renameSync} from 'node:fs';
import {dirname,join,resolve,basename,relative,sep} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import * as tar from 'tar';
const ROOT=resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
const arg=n=>{const i=args.indexOf(n);return i<0?undefined:args[i+1];};
const withData=args.includes('--with-runtime-state') || args.includes('--backup');
if(withData && args.includes('--no-runtime-state'))throw Error('备份和程序包参数不能同时使用');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const out=resolve(arg('--out') ?? join(dirname(ROOT),basename(ROOT)+(withData?'-完整备份-':'-程序包-')+stamp+'.tar.gz'));
if(existsSync(out))throw Error('输出文件已存在，请换一个名称，原文件未覆盖');
const cfg=existsSync(join(ROOT,'workbench.config.json'))?JSON.parse(readFileSync(join(ROOT,'workbench.config.json'),'utf8')):{};
const dataRoot=resolve(ROOT,process.env.WORKBENCH_DATA_DIR || cfg.dataRoot || 'data/files');
const dbFile=resolve(process.env.WORKBENCH_DB || join(ROOT,'data/runtime/workbench.db'));
const lock=join(dirname(dbFile),'server.lock');
if(withData && existsSync(lock)){const pid=Number(readFileSync(lock,'utf8'));let live=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')live=false;}if(live)throw Error('请先停止工作台，再创建完整备份。');}
mkdirSync(join(ROOT,'.tmp'),{recursive:true});const tmp=mkdtempSync(join(ROOT,'.tmp','pack-')),name=basename(ROOT),dest=join(tmp,name);mkdirSync(dest);
const filter=src=>!relative(ROOT,src).split(sep).some(n=>['node_modules','.git','.tmp','.npm-cache','server.lock'].includes(n)||/^\.env(?:\.|$)/.test(n)||/\.log$/.test(n));
try {
 for(const n of ['packages','scripts','docs','README.md','package.json','package-lock.json','tsconfig.json','.gitignore','.npmrc']){const src=join(ROOT,n);if(existsSync(src))cpSync(src,join(dest,n),{recursive:true,filter});}
 writeFileSync(join(dest,'workbench.config.json'),JSON.stringify({...cfg,dataRoot:'data/files',host:'127.0.0.1'},null,2));
 if(withData){
  if(!existsSync(dbFile))throw Error('没有业务数据库，不能生成完整备份');
  if(existsSync(dataRoot))cpSync(dataRoot,join(dest,'data/files'),{recursive:true});
  mkdirSync(join(dest,'data/runtime'),{recursive:true});const source=new DatabaseSync(dbFile,{readOnly:true});try{await backup(source,join(dest,'data/runtime/workbench.db'));}finally{source.close();}
  const lang=join(ROOT,'data/runtime/tessdata');if(existsSync(lang))cpSync(lang,join(dest,'data/runtime/tessdata'),{recursive:true});
  const check=new DatabaseSync(join(dest,'data/runtime/workbench.db'),{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok'||check.prepare('PRAGMA foreign_key_check').all().length)throw Error('数据库快照校验失败');}finally{check.close();}
  writeFileSync(join(dest,'BACKUP-NOTICE.txt'),'此完整备份含个人文件、模型凭证和业务记录，请仅存放在自己的可信设备。\n');
 }
 mkdirSync(dirname(out),{recursive:true});const part=out+'.partial-'+process.pid;
 await tar.create({gzip:true,file:part,cwd:tmp,portable:true},[name]);
 const entries=[];await tar.list({file:part,onReadEntry:e=>{entries.push(e.path);e.resume();}});
 if(!entries.includes(name+'/package.json')||(withData&&!entries.includes(name+'/data/runtime/workbench.db')))throw Error('压缩包验证失败');
 if(!withData && entries.some(n=>n.startsWith(name+'/data/')))throw Error('程序包混入个人数据');
 // wx 保留目的文件，防止并行打包或用户创建同名文件时覆盖。
 writeFileSync(out,readFileSync(part),{flag:'wx'});rmSync(part);
 console.log((withData?'完整备份':'程序包')+'已验证：'+out+'（'+(statSync(out).size/1024/1024).toFixed(2)+' MB）');
}finally{const rel=relative(join(ROOT,'.tmp'),tmp);if(rel.startsWith('..')||resolve(tmp)===resolve(ROOT))throw Error('临时目录越界');rmSync(tmp,{recursive:true,force:true});}
