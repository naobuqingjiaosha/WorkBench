import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

// Exercise the real prepareBuild/command IPC path with a synthetic npm process.
// No registry calls or permission changes are needed for these failure cases.
const root=process.cwd(),home=process.env.WORKBENCH_ISOLATION_ROOT!;
for(const failure of ['EPERM','EACCES','ENOSPC','ENOTCACHED','cleanup']){
 const checkout=join(home,failure),cache=join(home,failure+'-cache'),trace=join(checkout,'attempts');
 for(const file of ['scripts/source-build.mjs','scripts/repository-policy.mjs','packages/server/src/core/path-boundary.ts','package.json','package-lock.json','tsconfig.json','packages/server/package.json','packages/web/package.json']){
  const dest=join(checkout,file);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(root,file),dest);
 }
 writeFileSync(trace,'');
 writeFileSync(join(checkout,'scripts/source-npm.mjs'),`
  import {appendFileSync} from 'node:fs';
  const offline=process.argv.includes('--offline');
  appendFileSync(${JSON.stringify(trace)},offline?'offline\\n':'online\\n');
  const code=offline?${JSON.stringify(failure==='cleanup'?'EACCES':failure)}:'EACCES';
  process.send({type:'npm-failure',code});console.error('synthetic npm '+code);process.exitCode=1;
 `);
 const script=`
  import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
  ${failure==='cleanup'?`const remove=fs.rmSync;fs.rmSync=(p,...args)=>{if(String(p).includes('.building-'))throw Error('synthetic cleanup failure');return remove(p,...args)};syncBuiltinESMExports();`:''}
  const {prepareBuild}=await import(${JSON.stringify(pathToFileURL(join(checkout,'scripts/source-build.mjs')).href)});
  try{await prepareBuild(${JSON.stringify(checkout)},${JSON.stringify(cache)});throw Error('unexpected success');}
  catch(e){console.error('FINAL: '+e.message);process.exitCode=1;}
 `;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:checkout,env:process.env,encoding:'utf8',timeout:30000});
 assert.ifError(result.error);assert.equal(result.status,1);assert.match(result.stderr,/FINAL: .*EACCES|FINAL: .*EPERM|FINAL: .*ENOSPC/);
 assert.equal(readFileSync(trace,'utf8'),failure==='ENOTCACHED'?'offline\nonline\n':'offline\n');
 assert.equal(result.stdout.includes('缓存不足'),failure==='ENOTCACHED');
 if(failure==='cleanup'){assert.match(result.stderr,/synthetic cleanup failure/);assert.match(result.stderr,/FINAL: .*EACCES/);}
}
console.log('npm失败分类：EPERM/EACCES/ENOSPC均单次停止；仅ENOTCACHED获取缺项一次；清理失败不覆盖原始错误');
