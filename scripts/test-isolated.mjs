import {tmpdir} from 'node:os';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {isolationEnv} from './isolation-env.mjs';
import {assertNoPathLinks} from '../packages/server/src/core/path-boundary.ts';
import {mkdtempSync,mkdirSync,rmSync,existsSync,cpSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
const ROOT=resolve(import.meta.dirname,'..');
const tmp=mkdtempSync(join(tmpdir(),'workbench-isolated-'));writeFileSync(join(tmp,'.workbench-test-root'),'isolated test');
const net=createServer();await new Promise(r=>net.listen(0,'127.0.0.1',r));const port=net.address().port;await new Promise(r=>net.close(r));
const env=isolationEnv(tmp,{NODE_OPTIONS:(process.env.NODE_OPTIONS||'')+' --import='+JSON.stringify(pathToFileURL(join(ROOT,'scripts/test-preflight.mjs')).href),WORKBENCH_SESSION_TOKEN:randomBytes(32).toString('hex'),PORT:String(port),HOST:'127.0.0.1',BASE:'http://127.0.0.1:'+port});
// Optional OCR resources belong to local test fixtures, never to the daily runtime.
const lang=join(ROOT,'packages/server/test/fixtures/tessdata');
if(existsSync(lang)){assertNoPathLinks(lang);cpSync(lang,env.WORKBENCH_TESSDATA_DIR,{recursive:true});}
let server;let logs='';
try {
 if(process.argv[2]==='--unit'){
  const name=process.argv[3];if(!/^[a-z0-9-]+$/.test(name)||!existsSync(join(ROOT,'packages/server/test',name+'.ts')))throw Error('未知测试');
  const child=spawn(process.execPath,['--import','./scripts/test-preflight.mjs','packages/server/test/'+name+'.ts'],{cwd:ROOT,env,stdio:'inherit',windowsHide:true});
  const code=await new Promise(r=>child.on('exit',r));if(code!==0)throw Error(name+' 未通过');
 } else {
 server=spawn(process.execPath,['--import','./scripts/test-preflight.mjs','packages/server/src/index.ts'],{cwd:ROOT,env,stdio:['ignore','pipe','pipe'],windowsHide:true});server.stdout.on('data',d=>logs+=d);server.stderr.on('data',d=>logs+=d);
 let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('测试服务启动失败：'+logs);try{ready=(await fetch(env.BASE+'/api/health')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,100));}if(!ready)throw Error('测试服务启动超时：'+logs);
 const names=process.argv.slice(2); const selected=names.length?names:['e2e','kb-e2e','agent-e2e'];
 for(const name of selected){if(!['e2e','kb-e2e','agent-e2e','vision-e2e','ocr-e2e'].includes(name))throw Error('未知测试套件');
 const child=spawn(process.execPath,['packages/server/test/'+name+'.ts'],{cwd:ROOT,env,stdio:'inherit',windowsHide:true});const code=await new Promise(r=>child.on('exit',r));if(code!==0)throw Error(name+' 未通过');}
}
}finally {
 if(server && server.exitCode===null){server.kill();await new Promise(r=>{server.once('exit',r);setTimeout(r,5000);});}
 const rel=relative(tmpdir(),tmp);if(rel.startsWith('..')||!rel||!rel.startsWith('workbench-isolated-'))throw Error('测试目录越界');assertNoPathLinks(tmp);rmSync(tmp,{recursive:true,force:true});
}
