import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {cpSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertTestIsolation} from '../../src/core/test-isolation.ts';

/** Start the packaged frontend and the real server only inside the runner-owned test root. */
export async function withBrowserPage(test: (page: any, base: string) => Promise<void>) {
  assertTestIsolation(true);
  const web=process.env.WORKBENCH_WEB_DIST!, base=process.env.BASE!;
  if (process.env.CANDIDATE_WEB_DIST) {
    const source=resolve(process.env.CANDIDATE_WEB_DIST);
    assert.ok(existsSync(join(source,'index.html')),'候选前端缺少 index.html');
    cpSync(source,web,{recursive:true});
  } else {
    const root=process.cwd();
    execFileSync(process.execPath,[join(root,'node_modules/vite/bin/vite.js'),'build','--outDir',web],{cwd:join(root,'packages/web'),stdio:'pipe'});
  }
  const moduleName=process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright';
  const {chromium}=await import(moduleName);
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE||undefined});
  const server=spawn(process.execPath,['packages/server/src/index.ts'],{stdio:['ignore','pipe','pipe']});
  const stopped=new Promise((ok,fail)=>{server.once('error',fail);server.once('exit',ok);});
  let logs='';
  for(const stream of [server.stdout,server.stderr]) stream.on('data',chunk=>{logs=(logs+chunk).slice(-5000);});
  try {
    let health;
    for(let i=0;i<100&&server.exitCode===null;i++){
      health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(700)}).then(r=>r.json()).catch(()=>null);
      if(health?.data?.runtimeProfile==='test'&&health.data.dbFile===process.env.WORKBENCH_DB) break;
      await new Promise(ok=>setTimeout(ok,100));
    }
    assert.equal(health?.data?.dbFile,process.env.WORKBENCH_DB,logs);
    assert.equal(health.data.runtimeProfile,'test');
    const page=await browser.newPage({viewport:{width:1366,height:850}});
    page.setDefaultTimeout(7500);
    const errors:string[]=[];
    page.on('pageerror',(e:Error)=>errors.push(e.message));
    try {await test(page,base);} catch (e) {
      if(errors.length) console.error('页面异常',errors);
      if(process.env.BROWSER_TEST_DIAGNOSTICS==='1') console.error('合成场景当前页面',page.url(),(await page.locator('body').innerText()).slice(-6500));
      throw e;
    }
    assert.deepEqual(errors,[],'页面发生未捕获异常');
  } finally {
    try {await browser.close();} finally {
      if(server.exitCode===null&&server.signalCode===null) server.kill();
      const timer=setTimeout(()=>server.kill('SIGKILL'),5000);
      try {await stopped;} finally {clearTimeout(timer);}
    }
  }
}
