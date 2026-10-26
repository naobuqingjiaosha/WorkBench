import {mkdirSync,existsSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve('.tmp/monthly-development');mkdirSync(root,{recursive:true});
const stage=resolve('outputs/monthly-development-web');
const env=isolationEnv(root,{PORT:process.env.MONTHLY_DEV_PORT||'18889',HOST:'127.0.0.1'});
async function child(args){const p=spawn(process.execPath,args,{env,stdio:'inherit',windowsHide:true});const code=await new Promise(r=>p.on('exit',r));if(code!==0)process.exit(Number(code)||1);}
if(process.argv.includes('--build'))await child(['node_modules/vite/bin/vite.js','build','packages/web','--outDir',stage]);
if(!existsSync(stage))throw Error('请先运行 npm run dev:monthly -- --build');
cpSync(stage,env.WORKBENCH_WEB_DIST,{recursive:true});
if(process.argv.includes('--seed-handoff'))await child(['--import','./scripts/test-preflight.mjs','packages/server/src/cli/seed-monthly-review.ts']);
console.log('隔离开发版 http://127.0.0.1:'+env.PORT+'；数据 '+root+'；不修改日常发布指针');
await child(['--import','./scripts/test-preflight.mjs','packages/server/src/index.ts']);
