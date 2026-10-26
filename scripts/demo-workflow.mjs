import { spawn,spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve,relative,isAbsolute } from 'node:path';

// Demonstrations always create a new isolated fixture; never use the configured business database.
const root=resolve(import.meta.dirname,'..');
const generated=spawnSync(process.execPath,['packages/server/test/workflow.ts'],{cwd:root,encoding:'utf8',env:{...process.env,WORKBENCH_TEST_MODE:'1'}});
process.stdout.write(generated.stdout??'');process.stderr.write(generated.stderr??'');
if(generated.status!==0)process.exit(generated.status??1);
const folder=generated.stdout.match(/样例与验证记录：([^\r\n]+)/)?.[1]?.trim();
if(!folder)throw new Error('没有找到样例目录');
const rel=relative(resolve(root,'.tmp'),resolve(folder));
if(isAbsolute(rel)||rel.startsWith('..'))throw new Error('样例目录必须在本项目 .tmp 中');
if(process.argv.includes('--generate-only'))process.exit(0);
if(!existsSync(resolve(root,'packages/web/dist/index.html'))){console.error('请先运行 npm run build，再运行 npm run demo:workflow');process.exit(1);}
const port='18878';
console.log(`匿名演示：http://127.0.0.1:${port}；按 Ctrl+C 停止。真实数据库不受影响。`);
const server=spawn(process.execPath,['packages/server/src/index.ts'],{cwd:root,stdio:'inherit',env:{...process.env,WORKBENCH_TEST_MODE:'1',WORKBENCH_DB:resolve(folder,'workbench.db'),WORKBENCH_DATA_DIR:resolve(folder,'files'),WORKBENCH_BACKUP_DIR:resolve(folder,'backups'),HOST:'127.0.0.1',PORT:port}});
process.on('SIGINT',()=>server.kill('SIGINT'));
process.on('SIGTERM',()=>server.kill('SIGTERM'));
server.on('exit',code=>process.exit(code??0));
