/** Immutable, reproducible runtime copy. No private files or Git state are copied. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync,readdirSync,readFileSync,mkdirSync,writeFileSync,copyFileSync,cpSync,renameSync,rmSync,lstatSync,unlinkSync,symlinkSync,realpathSync} from 'node:fs';
import {join,relative,dirname,isAbsolute,delimiter} from 'node:path';
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
 const {capture=false,...spawnOptions}=options;
 const child=spawn(command,args,{stdio:capture?['ignore','pipe','pipe']:'inherit',windowsHide:true,...spawnOptions});
 let output='';if(capture){child.stdout.on('data',d=>output+=d);child.stderr.resume();}
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve(signal?1:code));});
 if(code!==0)throw Error(`${command} 执行失败（${code}）。原可用版本和数据未被此构建替换。`);
 return output.trim();
}
function npmCli() {
 // npm.cmd cannot be spawned directly on Windows; invoking npm's JS CLI avoids shell quoting.
 const candidates=[process.env.npm_execpath,join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js')].filter(Boolean);
 // execPath is a filename; resolve its sibling via path normalization.
 if(process.platform!=='win32')for(const dir of (process.env.PATH||'').split(delimiter).filter(Boolean))candidates.push(join(dir,'npm'));
 const cli=candidates.find(p=>isAbsolute(p)&&existsSync(p));
 if(!cli)throw Error('未找到 npm。请安装包含 npm 11 的 Node.js 24，再重新启动。');
 return realpathSync(cli);
}
function npmInBuild(checkout,target,args,options={}) {
 const npmrc=join(checkout,'.npmrc');if(existsSync(npmrc))assertNoPathLinks(npmrc);
 return command(process.execPath,[join(import.meta.dirname,'source-npm.mjs'),npmCli(),target,...args],{...options,cwd:checkout});
}
/** An npm installation record is evidence of versions, not a cryptographic file receipt. */
export function validateInstalledVersions(root) {
 const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
 const installed=JSON.parse(readFileSync(join(root,'node_modules','.package-lock.json'),'utf8'));
 if(lock.lockfileVersion<2||installed.lockfileVersion<2||!lock.packages||!installed.packages)throw Error('缺少可核对的npm依赖记录');
 for(const folder of ['','packages/server','packages/web']){
  const pkg=JSON.parse(readFileSync(join(root,folder,'package.json'),'utf8')),record=lock.packages[folder];
  if(!record)throw Error('锁文件缺少workspace');
  for(const field of ['dependencies','devDependencies','optionalDependencies']){
   const normalized=x=>JSON.stringify(Object.entries(x||{}).sort(([a],[b])=>a.localeCompare(b)));
   if(normalized(pkg[field])!==normalized(record[field]))throw Error('package.json与锁文件不一致');
  }
 }
 for(const [path,record] of Object.entries(lock.packages)){
  if(!path.includes('node_modules/'))continue;
  if(path.startsWith('/')||path.split('/').some(p=>!p||p==='..'||p==='.')||path.includes('\\'))throw Error('依赖记录路径无效');
  const actual=installed.packages[path];
  if(!actual){if(record.optional)continue;throw Error('缺少锁定依赖：'+path);}
  if(record.link){if(!actual.link||record.resolved!==actual.resolved)throw Error('workspace链接记录不匹配');continue;}
  for(const field of ['version','resolved','integrity'])if(record[field]!==actual[field])throw Error('已安装依赖与锁文件不匹配：'+path);
  const pkg=JSON.parse(readFileSync(join(root,path,'package.json'),'utf8'));
  if(pkg.version!==record.version)throw Error('已安装依赖版本不匹配：'+path);
 }
 for(const path of Object.keys(installed.packages))if(!lock.packages[path])throw Error('依赖记录包含当前锁文件之外的包');
}
function linkWorkspaces(root,finalRoot=root) {
 for(const name of ['server','web']){
  const link=join(root,'node_modules','@workbench',name);assertNoPathLinks(dirname(link));mkdirSync(dirname(link),{recursive:true});
  try{if(!lstatSync(link).isSymbolicLink())throw Error('workspace依赖路径不是链接，拒绝替换');unlinkSync(link);}catch(e){if(e.code!=='ENOENT')throw e;}
  symlinkSync(process.platform==='win32'?join(finalRoot,'packages',name):relative(dirname(link),join(root,'packages',name)),link,process.platform==='win32'?'junction':'dir');
 }
}
async function validateDependencies(root,checkout) {
 assertNoPathLinks(join(root,'node_modules'));
 validateInstalledVersions(root);
 await npmInBuild(checkout,root,['ls','--all','--offline','--json'],{capture:true});
 const dependencies=Object.keys(JSON.parse(readFileSync(join(root,'packages/server/package.json'),'utf8')).dependencies);
 const modules=dependencies.map(n=>n==='pdfjs-dist'?'pdfjs-dist/legacy/build/pdf.mjs':n);
 const probe=`for(const name of ${JSON.stringify(modules)})await import(name);const esbuild=await import('esbuild');esbuild.transformSync('const ok: boolean=true',{loader:'ts'});`;
 await command(process.execPath,['--input-type=module','-e',probe],{cwd:root,capture:true});
}
async function prepareDependencies(root,stage,previous,identity) {
 // npm reads the original configuration in memory; even an interrupted build has no npmrc copy.
  const candidates=[];
  if(previous&&readBuild(previous)?.dependencyKey===identity.dependencyKey)candidates.push(previous);
  if(existsSync(join(root,'node_modules')))candidates.push(root);
  for(const candidate of candidates){
   try{
    assertNoPathLinks(join(candidate,'node_modules'));
    validateInstalledVersions(candidate);
    // Compare with THIS build's lock after copying; no assumption that checkout modules match a changed lock.
    cpSync(join(candidate,'node_modules'),join(stage,'node_modules'),{recursive:true,verbatimSymlinks:true});
    linkWorkspaces(stage);await validateDependencies(stage,root);
    console.log('已核对并复制本机依赖，无需联网重新安装。');return;
   }catch{
    rmSync(join(stage,'node_modules'),{recursive:true,force:true});
    console.log('本机依赖副本不完整或与当前锁文件不符，继续按锁文件准备。');
   }
  }
  const args=['ci','--no-audit','--no-fund'];
  console.log('正在尝试本机npm缓存的离线安装…');
  try{await npmInBuild(root,stage,[...args,'--offline'],{capture:true});}
  catch{
   console.log('缓存不足，尝试按当前锁文件获取缺少的依赖…');
   try{await npmInBuild(root,stage,[...args,'--prefer-offline']);}
   catch{throw Error('当前锁文件的依赖未准备完整。请检查npm缓存、网络/注册表和磁盘空间，修复后重新启动；未停止原服务，不会静默运行旧源码。');}
  }
  linkWorkspaces(stage);await validateDependencies(stage,root);
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
export async function verifyReadyBuild(root,expected,checkout) {
 const metadata=verifyBuild(root,expected);
 try {await validateDependencies(root,checkout);}
 catch {throw Error('本地运行副本依赖不完整或不可用，未停止原服务：'+root+'。请按安装指南核对并重新准备；保留数据和成功记录，不会静默运行旧源码。');}
 return metadata;
}
export function treeHash(root) {
 const h=createHash('sha256');
 const walk=dir=>{for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,e.name);assertNoPathLinks(p);if(e.isDirectory())walk(p);else {h.update(relative(root,p).replaceAll('\\','/'));h.update(readFileSync(p));}}};walk(root);return h.digest('hex');
}
export async function prepareBuild(root,cache,previous) {
 assertNoPathLinks(cache);mkdirSync(cache,{recursive:true});
 const identity=sourceIdentity(root),target=join(cache,identity.id);
 if(existsSync(target)){await verifyReadyBuild(target,identity.id,root);return {root:target,...identity};}
 const stage=join(cache,identity.id+'.building-'+process.pid);mkdirSync(stage);
 try {
  for(const file of identity.files){const out=join(stage,file);mkdirSync(join(out,'..'),{recursive:true});copyFileSync(join(root,file),out);}
  if(sourceIdentity(stage).id!==identity.id)throw Error('准备期间源码发生变化，请等待 pull 完成后重新启动');
  await prepareDependencies(root,stage,previous,identity);
  console.log('正在构建当前源码的界面…');
  await command(process.execPath,[join(stage,'node_modules','vite','bin','vite.js'),'build','--outDir',join(stage,'web')],{cwd:join(stage,'packages','web')});
  if(!existsSync(join(stage,'web','index.html')))throw Error('构建没有生成首页');
  if(sourceIdentity(root).id!==identity.id)throw Error('构建期间源码发生变化，请重新启动');
  // Rebind Windows absolute junctions after all checks, before the directory rename.
  linkWorkspaces(stage,target);
  writeFileSync(join(stage,'SOURCE_BUILD.json'),JSON.stringify({format:1,id:identity.id,dependencyKey:identity.dependencyKey,frontendSha256:treeHash(join(stage,'web')),createdAt:new Date().toISOString()}));
  renameSync(stage,target);verifyBuild(target,identity.id);return {root:target,...identity};
 } catch(e) {rmSync(stage,{recursive:true,force:true});throw e;}
}
