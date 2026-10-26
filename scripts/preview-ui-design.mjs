import {mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {isolationEnv} from './isolation-env.mjs';

// Anonymous UI acceptance environment; never selects or modifies the daily release.
const root=resolve('.tmp/ui-design-preview'),port=Number(process.env.WORKBENCH_UI_PORT??18894);
if(!Number.isInteger(port)||port<1024||port>65535||port===8787)throw Error('隔离预览端口无效');
const probe=createServer();await new Promise((res,rej)=>{probe.once('error',rej);probe.listen(port,'127.0.0.1',res);});await new Promise(res=>probe.close(res));
mkdirSync(root,{recursive:true});const env=isolationEnv(root,{PORT:String(port),HOST:'127.0.0.1'});
const run=async args=>{const child=spawn(process.execPath,args,{env,stdio:'inherit',windowsHide:true});const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);});if(code!==0)throw Error('隔离准备失败：'+args.join(' '));};
await run(['node_modules/vite/bin/vite.js','build','--config','packages/web/vite.config.ts','--outDir',env.WORKBENCH_WEB_DIST,'packages/web']);
// Preserve an explicitly cleared preview across restarts; the server initializes an empty database.
const emptyPreview=existsSync(resolve(root,'.empty-preview'));
if(!emptyPreview)await run(['--import','./scripts/test-preflight.mjs','packages/server/test/ui-design-seed.ts']);
if(!emptyPreview&&!existsSync(resolve(root,'fixture.json')))throw Error('预览目录已包含非预期数据，未启动。请检查该隔离目录。');
const child=spawn(process.execPath,['--import','./scripts/test-preflight.mjs','packages/server/src/index.ts'],{env,stdio:'inherit',windowsHide:true});
process.on('SIGTERM',()=>child.kill());process.on('SIGINT',()=>child.kill());
await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',res);});
