/** Immutable, reproducible runtime copy. No private files or Git state are copied. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync,readdirSync,readFileSync,mkdirSync,writeFileSync,copyFileSync,cpSync,renameSync,rmSync,lstatSync,unlinkSync,symlinkSync} from 'node:fs';
import {join,relative,dirname} from 'node:path';
import {isShareableFile} from './repository-policy.mjs';
import {assertNoPathLinks} from '../packages/server/src/core/path-boundary.ts';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function sourceFiles(root) {
 const files=[];
 const visit=dir=>{for(const entry of readdirSync(join(root,dir),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(dir,entry.name),key=path.replaceAll('\\','/');
  if(entry.isDirectory()){if(!/(^|\/)(node_modules|dist|test|tests|fixtures|outputs|data|\.git|\.local)(\/|$)/.test(key))visit(path);}
  else if(isShareableFile(key) && !/\.md$/.test(key) && !key.startsWith('docs/')){assertNoPathLinks(join(root,path));files.push(key);}
 }};
 // Enumerate only source roots; never walk data, backups, outputs or local configuration.
 for(const dir of ['packages','scripts'])visit(dir);
 for(const name of ['package.json','package-lock.json','tsconfig.json']){assertNoPathLinks(join(root,name));files.push(name);}
 return files.sort();
}
export function sourceIdentity(root) {
 const files=sourceFiles(root),h=createHash('sha256');
 h.update(process.versions.modules+'\0'+process.platform+'\0'+process.arch+'\0');
 for(const file of files){h.update(file+'\0');h.update(readFileSync(join(root,file)));h.update('\0');}
 return {id:h.digest('hex'),files,dependencyKey:hash(readFileSync(join(root,'package-lock.json'))+'\0'+process.versions.modules+'\0'+process.platform+'\0'+process.arch)};
}
export async function command(command,args,options={}) {
 const child=spawn(command,args,{stdio:'inherit',windowsHide:true,...options});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code));});
 if(code!==0)throw Error(`${command} 执行失败（${code}）。原可用版本和数据未被此构建替换。`);
}
export async function npmCommand(args,options) {
 // npm.cmd cannot be spawned directly on Windows; invoking npm's JS CLI avoids shell quoting.
 const candidates=[process.env.npm_execpath,join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')].filter(Boolean);
 // execPath is a filename; resolve its sibling via path normalization.
 const cli=candidates.find(p=>existsSync(p));
 if(cli)return command(process.execPath,[cli,...args],options);
 if(process.platform==='win32')throw Error('未找到 npm。请安装包含 npm 的 Node.js 24，再重新启动。');
 return command('npm',args,options);
}
export function readBuild(root) {
 try {assertNoPathLinks(join(root,'SOURCE_BUILD.json'));const m=JSON.parse(readFileSync(join(root,'SOURCE_BUILD.json'),'utf8'));return m.format===1&&/^[a-f0-9]{64}$/.test(m.id)?m:null;}catch{return null;}
}
export function verifyBuild(root,expected) {
 assertNoPathLinks(root);const m=readBuild(root);
 if(!m||expected&&m.id!==expected)throw Error('本地运行副本标识不匹配，拒绝启动');
 const identity=sourceIdentity(root);
 if(identity.id!==m.id||identity.dependencyKey!==m.dependencyKey)throw Error('本地运行副本源码或运行环境已变化，拒绝启动');
 if(!existsSync(join(root,'node_modules','fastify','package.json')))throw Error('运行副本依赖不完整');
 const digest=treeHash(join(root,'web'));if(digest!==m.frontendSha256)throw Error('运行副本界面不完整或已变化');
 return m;
}
export function treeHash(root) {
 const h=createHash('sha256');
 const walk=dir=>{for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,e.name);assertNoPathLinks(p);if(e.isDirectory())walk(p);else {h.update(relative(root,p).replaceAll('\\','/'));h.update(readFileSync(p));}}};walk(root);return h.digest('hex');
}
export async function prepareBuild(root,cache,previous) {
 assertNoPathLinks(cache);mkdirSync(cache,{recursive:true});
 const identity=sourceIdentity(root),target=join(cache,identity.id);
 if(existsSync(target)){verifyBuild(target,identity.id);return {root:target,...identity};}
 const stage=join(cache,identity.id+'.building-'+process.pid);mkdirSync(stage);
 try {
  for(const file of identity.files){const out=join(stage,file);mkdirSync(join(out,'..'),{recursive:true});copyFileSync(join(root,file),out);}
  if(sourceIdentity(stage).id!==identity.id)throw Error('准备期间源码发生变化，请等待 pull 完成后重新启动');
  const old=previous&&readBuild(previous);
  if(old?.dependencyKey===identity.dependencyKey&&existsSync(join(previous,'node_modules'))){
   console.log('复用上次已安装的相同锁文件依赖…');
   try{cpSync(join(previous,'node_modules'),join(stage,'node_modules'),{recursive:true,verbatimSymlinks:true});}
   catch{rmSync(join(stage,'node_modules'),{recursive:true,force:true});console.log('依赖副本不可用，重新按锁文件安装…');await npmCommand(['ci','--no-audit','--no-fund'],{cwd:stage});}
  }else{console.log('首次启动或依赖已更新，正在按锁文件安装…');await npmCommand(['ci','--no-audit','--no-fund'],{cwd:stage});}
  console.log('正在构建当前源码的界面…');
  await command(process.execPath,[join(stage,'node_modules','vite','bin','vite.js'),'build','--outDir',join(stage,'web')],{cwd:join(stage,'packages','web')});
  if(!existsSync(join(stage,'web','index.html')))throw Error('构建没有生成首页');
  if(sourceIdentity(root).id!==identity.id)throw Error('构建期间源码发生变化，请重新启动');
  // npm uses absolute junction targets on Windows. Point workspace links at the final location.
  for(const name of ['server','web']){
   const link=join(stage,'node_modules','@workbench',name);mkdirSync(dirname(link),{recursive:true});
   try{if(!lstatSync(link).isSymbolicLink())throw Error('workspace依赖路径不是链接，拒绝替换');unlinkSync(link);}catch(e){if(e.code!=='ENOENT')throw e;}
   symlinkSync(process.platform==='win32'?join(target,'packages',name):relative(dirname(link),join(stage,'packages',name)),link,process.platform==='win32'?'junction':'dir');
  }
  writeFileSync(join(stage,'SOURCE_BUILD.json'),JSON.stringify({format:1,id:identity.id,dependencyKey:identity.dependencyKey,frontendSha256:treeHash(join(stage,'web')),createdAt:new Date().toISOString()}));
  renameSync(stage,target);verifyBuild(target,identity.id);return {root:target,...identity};
 } catch(e) {rmSync(stage,{recursive:true,force:true});throw e;}
}
