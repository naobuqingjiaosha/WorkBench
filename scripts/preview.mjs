// Use the ordinary source launcher and build checks with a separate, persistent review database.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { cleanRuntimeEnv } from './isolation-env.mjs';
import { defaultHome } from '../packages/server/src/core/runtime-layout.ts';

const root = resolve(import.meta.dirname, '..');
const home = join(defaultHome(root, 'development'), 'candidate');
const env = {...cleanRuntimeEnv(), WORKBENCH_PROFILE: 'development', WORKBENCH_HOME: home,
  WORKBENCH_BACKUP_AUTO: '0', NODE_ENV: 'development', HOST: '127.0.0.1', PORT: process.env.WORKBENCH_DEV_PORT || '18889'};
console.log('候选预览使用独立资料目录：' + home);
console.log('关闭本窗口前请保存输入。再次预览可继续使用已保存的样例。');
const args = [join(root, 'scripts/start.mjs'), '--start-only'];
if (!process.argv.includes('--no-open')) args.push('--open');
const child = spawn(process.execPath, args, {cwd:root, env, stdio:'inherit', windowsHide:true});
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => child.kill(signal));
const code = await new Promise((ok, fail) => { child.once('exit', (code, signal) => ok(signal ? 1 : code)); child.once('error',fail); });
process.exitCode = code ?? 1;
