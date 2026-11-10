import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNoPathLinks } from '../packages/server/src/core/path-boundary.ts';
import { isolationEnv } from './isolation-env.mjs';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const shared = args[0] === '--shared';
const unit = args[0] === '--unit';
const names = shared || unit ? args.slice(1) : args.length ? args : ['e2e', 'kb-e2e', 'agent-e2e'];
if (!names.length) throw Error('请指定测试名称');
for (const name of names) {
  if (!/^[a-z0-9-]+$/.test(name)) throw Error('测试名称无效');
  const file = join(root, 'packages/server/test', shared ? 'shared' : '', name + '.ts');
  if (!existsSync(file)) throw Error((shared ? '共享测试缺失，请检查交付文件' : '此本机专项未安装') + '：' + name);
  assertNoPathLinks(file);
  await runCase(file);
}

async function runCase(file) {
  const temp = mkdtempSync(join(realpathSync(tmpdir()), 'workbench-isolated-'));
  let server;
  let stopped;
  try {
    writeFileSync(join(temp, '.workbench-test-root'), 'isolated test');
    const net = createServer();
    await new Promise((ok, fail) => net.once('error', fail).listen(0, '127.0.0.1', ok));
    const port = net.address().port;
    await new Promise(ok => net.close(ok));
    const preflight = pathToFileURL(join(root, 'scripts/test-preflight.mjs')).href;
    const env = isolationEnv(temp, { NODE_OPTIONS: '--import=' + JSON.stringify(preflight),
      WORKBENCH_SESSION_TOKEN: randomBytes(32).toString('hex'), PORT: String(port),
      HOST: '127.0.0.1', BASE: 'http://127.0.0.1:' + port });
    const lang = join(root, 'packages/server/test/fixtures/tessdata');
    if (!shared && existsSync(lang)) {
      assertNoPathLinks(lang);
      cpSync(lang, env.WORKBENCH_TESSDATA_DIR, { recursive: true });
    }
    if (!unit && !shared) {
      server = spawn(process.execPath, ['packages/server/src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      stopped = new Promise((ok, fail) => { server.once('error', fail); server.once('exit', ok); });
      let logs = '';
      for (const stream of [server.stdout, server.stderr]) stream.on('data', d => { logs = (logs + d).slice(-8000); });
      let ready = false;
      for (let i = 0; i < 100 && server.exitCode === null; i++) {
        const h = await fetch(env.BASE + '/api/health', {signal: AbortSignal.timeout(700)}).then(r => r.json()).catch(() => null);
        if (h?.data?.runtimeProfile === 'test' && h.data.dbFile === env.WORKBENCH_DB) { ready = true; break; }
        await new Promise(ok => setTimeout(ok, 100));
      }
      if (!ready) throw Error('隔离服务未就绪：' + logs);
    }
    const child = spawn(process.execPath, [file], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('exit', ok); });
    if (code !== 0) throw Error('测试未通过：' + file);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill();
      const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
      try { await stopped; } finally { clearTimeout(timeout); }
    }
    assertNoPathLinks(temp);
    rmSync(temp, { recursive: true, force: true });
  }
}
