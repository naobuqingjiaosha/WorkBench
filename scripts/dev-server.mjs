/** Development always selects its own data/configuration before loading the application. */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { loadRuntimeLayout, defaultHome } from '../packages/server/src/core/runtime-layout.ts';
import { cleanRuntimeEnv } from './isolation-env.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const env = {
 ...cleanRuntimeEnv(), NODE_ENV: 'development', WORKBENCH_PROFILE: 'development',
 WORKBENCH_HOME: process.env.WORKBENCH_DEV_HOME || defaultHome(root, 'development'),
 PORT: process.env.WORKBENCH_DEV_PORT || '18889', HOST: '127.0.0.1', WORKBENCH_BACKUP_AUTO: '0',
};
const layout = loadRuntimeLayout(root, env);
if (args.includes('--show-paths')) {
 console.log(JSON.stringify({ profile: layout.profile, home: layout.home, config: layout.configFile, database: layout.dbFile, files: layout.dataRoot, port: layout.port }, null, 2));
} else {
 const cliIndex = args.indexOf('--cli');
 const cli = cliIndex >= 0 ? args[cliIndex + 1] : null;
 if (cliIndex >= 0 && !['init-db', 'seed', 'reset', 'make-samples'].includes(cli)) throw Error('未知开发命令');
 const entry = join(root, 'packages/server/src', cli ? `cli/${cli}.ts` : 'index.ts');
 const childArgs = [...(args.includes('--watch') && !cli ? ['--watch'] : []), entry];
 if (cli) childArgs.push(...args.slice(cliIndex + 2));
 console.log(`开发环境 http://127.0.0.1:${layout.port}；独立数据目录 ${layout.home}`);
 const child = spawn(process.execPath, childArgs, { cwd: root, env, stdio: 'inherit', windowsHide: true });
 child.once('error', error => { console.error(error.message); process.exitCode = 1; });
 child.once('exit', code => { process.exitCode = code ?? 1; });
 for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
