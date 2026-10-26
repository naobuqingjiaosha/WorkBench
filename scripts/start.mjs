/**
 * 启动器：选一个空闲端口启动工作台，避免和遗留进程抢端口。
 *
 *   npm start            使用 workbench.config.json 里的端口（默认 8787）
 *   node scripts/start.mjs --port 8800
 *   node scripts/start.mjs --auto    端口被占用时自动往后找一个
 */
import { loadRuntimeLayout } from '../packages/server/src/core/runtime-layout.ts';
import { assertTestIsolation } from '../packages/server/src/core/test-isolation.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, existsSync, mkdirSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

assertTestIsolation();
const layout = loadRuntimeLayout(ROOT);
const cfg = layout.config;
if (layout.legacy) console.log('沿用已有安装的数据与配置；迁移到独立数据目录需另行执行。');

// A reviewed release can run against the daily data without publishing unrelated
// edits still present in the development checkout. All launch shortcuts use this.
let serverEntry = join(ROOT, 'packages', 'server', 'src', 'index.ts');
let releaseEnv = {};
const releasePointer = join(layout.runtimeRoot, 'current-release.json');
if (layout.profile === 'daily' && existsSync(releasePointer)) {
  const release = JSON.parse(readFileSync(releasePointer, 'utf8'));
  const releaseRoot = resolve(layout.legacy ? ROOT : layout.home, release.path);
  const within = relative(layout.releaseRoot, releaseRoot);
  if (!within || within.startsWith('..') || isAbsolute(within)) throw Error('发布目录超出当前环境 releases');
  serverEntry = join(releaseRoot, 'packages', 'server', 'src', 'index.ts');
  if (!existsSync(serverEntry) || !existsSync(join(releaseRoot, 'RELEASE.json'))) throw Error('发布包不完整，拒绝回退到未发布源码');
  releaseEnv = {
    WORKBENCH_DB: layout.dbFile,
    WORKBENCH_RUNTIME_DIR: layout.runtimeRoot,
    WORKBENCH_DATA_DIR: layout.dataRoot,
    WORKBENCH_WEB_DIST: layout.webDist,
    WORKBENCH_BACKUP_DIR: layout.backupRoot,
    WORKBENCH_TESSDATA_DIR: layout.tessdataRoot,
    ...(layout.legacy ? {} : { WORKBENCH_HOME: layout.home }),
  };
}

const host = argValue('--host') ?? layout.host;
const startPort = Number(argValue('--port') ?? layout.port);
const auto = args.includes('--auto');
const openBrowser = args.includes('--open');

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('需要 Node.js 24 或更高版本。');
  process.exit(1);
}
if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65535) {
  console.error('端口必须是 1 到 65535 之间的整数。');
  process.exit(1);
}

function browserUrl(port) {
  let address = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  if (address.includes(':') && !address.startsWith('[')) address = `[${address}]`;
  return `http://${address}:${port}`;
}

async function openPage(port) {
  const url = browserUrl(port);
  console.log(`正在打开浏览器：${url}`);
  await new Promise((resolve) => {
    const browser = process.platform === 'win32'
      ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
    browser.once('error', (error) => {
      console.warn(`自动打开失败：${error.message}。请在浏览器打开 ${url}`);
      resolve();
    });
    browser.once('exit', (code) => {
      if (code !== 0) console.warn(`请在浏览器打开 ${url}`);
      resolve();
    });
  });
}

if (openBrowser) {
  try {
    const response = await fetch(`${browserUrl(startPort)}/api/health`, { signal: AbortSignal.timeout(3000) });
    const health = await response.json();
    if (response.ok && health.ok === true && health.data?.status === 'ok' && health.data?.dbFile && resolve(health.data.dbFile).toLowerCase() === layout.dbFile.toLowerCase()) {
      console.log(`工作台已在运行，正在打开 ${browserUrl(startPort)}`);
      await openPage(startPort);
      process.exit(0);
    }
  } catch { /* 服务未运行，继续正常启动。 */ }
  if (!existsSync(join(layout.webDist,'index.html'))) {
    console.error('前端界面未构建，请在工作台目录运行 npm run build。');
    process.exit(1);
  }
  if (!existsSync(join(ROOT, 'node_modules', 'fastify', 'package.json'))) {
    console.error('项目依赖不完整，请在工作台目录运行 npm install。');
    process.exit(1);
  }
  console.log(args.includes('--background')?'正在后台启动工作台，关闭启动窗口不会停止服务。':'正在启动工作台，准备好后自动打开页面。停止服务请按 Ctrl+C。');
}

function isFree(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, host);
  });
}

let port = startPort;
if (!(await isFree(port))) {
  if (!auto) {
    console.error(`\n端口 ${port} 已被占用。\n`);
    console.error('可能是上一次的工作台还在运行（浏览器里能打开就说明正在跑）。');
    console.error('要么先关掉它，要么换个端口：node scripts/start.mjs --port 8788\n');
    process.exit(1);
  }
  for (let p = startPort + 1; p < startPort + 30; p += 1) {
    if (await isFree(p)) {
      port = p;
      break;
    }
  }
  if (port === startPort) {
    console.error('附近端口都被占用了，请手动指定 --port');
    process.exit(1);
  }
  console.log(`端口 ${startPort} 被占用，改用 ${port}`);
}

const runtimeRoot=layout.runtimeRoot;
const logDir=join(runtimeRoot,'logs');mkdirSync(logDir,{recursive:true});
const logPath=join(logDir,`service-${new Date().toISOString().replace(/[:.]/g,'-')}-${process.pid}.log`);
let logFailed=false;
function log(message){try{appendFileSync(logPath,message);}catch(e){if(!logFailed){logFailed=true;console.error(`无法写入服务日志：${e.message}`);}}}
log(`${new Date().toISOString()} launcher pid=${process.pid} entry=${serverEntry} port=${port}\n`);
console.log(`服务日志：${logPath}`);

if(args.includes('--background')){
  // A separate process group survives closing the shortcut's console on Windows.
  // No automatic restart: failures remain visible and never trigger repeated data repairs.
  const fd=openSync(logPath,'a');
  const workerArgs=args.filter((a,i)=>a!=='--background'&&a!=='--open'&&a!=='--port'&&args[i-1]!=='--port');
  const worker=spawn(process.execPath,[fileURLToPath(import.meta.url),...workerArgs,'--background-worker','--port',String(port)],{
    cwd:ROOT,detached:true,windowsHide:true,stdio:['ignore',fd,fd],env:process.env,
  });
  closeSync(fd);
  let failure=null;worker.once('error',e=>{failure=e;log(`background spawn failed: ${e.message}\n`);});
  worker.unref();
  const deadline=Date.now()+60000;
  while(Date.now()<deadline&&!failure&&worker.exitCode===null){
    try{
      const response=await fetch(`${browserUrl(port)}/api/health`,{signal:AbortSignal.timeout(2000)});
      const health=await response.json();
      if(response.ok&&health.ok===true&&health.data?.status==='ok'&&health.data?.dbFile&&resolve(health.data.dbFile).toLowerCase()===layout.dbFile.toLowerCase()){
        console.log(`工作台已在后台运行：${browserUrl(port)}（启动进程 ${worker.pid}）`);
        if(openBrowser)await openPage(port);
        process.exit(0);
      }
    }catch{}
    await new Promise(r=>setTimeout(r,500));
  }
  console.error(`后台启动未就绪，请查看日志：${logPath}`);process.exit(1);
}

const child = spawn(process.execPath, [serverEntry], {
  cwd: ROOT,
  windowsHide:true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...releaseEnv, PORT: String(port), HOST: host,
    ...(args.includes('--start-only') ? { WORKBENCH_START_ONLY: '1' } : {}),
  },
});
log(`${new Date().toISOString()} server pid=${child.pid}\n`);
for(const [stream,output] of [[child.stdout,process.stdout],[child.stderr,process.stderr]]){
  stream.setEncoding('utf8');stream.on('data',chunk=>{log(chunk);if(!output.destroyed)output.write(chunk);});
}
// A detached caller may close its output pipes. Logging must not terminate the server.
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});

if (openBrowser) {
  // 用实际接口确认服务就绪，避免依赖控制台日志文字或编码。
  void (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(`${browserUrl(port)}/api/health`, { signal: AbortSignal.timeout(2000) });
        const health = await response.json();
        if (response.ok && health.ok === true && health.data?.status === 'ok' && health.data?.dbFile && resolve(health.data.dbFile).toLowerCase() === layout.dbFile.toLowerCase()) {
          await openPage(port);
          return;
        }
      } catch { /* 服务初始化中，稍后重试。 */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (child.exitCode === null && child.signalCode === null) {
      console.warn(`等待服务就绪超时，请检查启动日志。页面地址：${browserUrl(port)}`);
    }
  })();
}

child.on('error', (error) => {
  log(`${new Date().toISOString()} spawn failed: ${error.stack||error.message}\n`);
  console.error(`启动失败：${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {log(`${new Date().toISOString()} server exited code=${code} signal=${signal}\n`);process.exit(code ?? (signal ? 1 : 0));});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {log(`${new Date().toISOString()} launcher received ${sig}\n`);child.kill(sig);});
}
