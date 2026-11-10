// Run through test-isolated --shared; provide PLAYWRIGHT_MODULE when installed outside this checkout.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const bundle=await build({bundle:true,write:false,minify:true,define:{'process.env.NODE_ENV':'"production"'},
  stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useApi} from './packages/web/src/api.ts';
    function Probe() {
      const [path, setPath]=useState('/a');
      const r = useApi(path);
      return <><button onClick={()=>setPath('/b')}>B</button><button onClick={r.reload}>retry</button>
        <output>{JSON.stringify({loading:r.loading, id:r.data?.id, error:r.error?.code})}</output></>;
    }
    createRoot(document.getElementById('app')).render(<Probe/>);
  `},outfile:join(process.env.WORKBENCH_WEB_DIST!, 'probe.js')});
let fail=true;
const server=createServer((req,res)=>{
  if(req.url==='/probe.js') {res.writeHead(200,{'Content-Type':'text/javascript'});res.end(bundle.outputFiles[0]!.contents);return;}
  if(req.url==='/' ){res.writeHead(200,{'Content-Type':'text/html'});res.end('<div id="app"></div><script src="/probe.js"></script>');return;}
  const id=req.url==='/a'?'A':'B';
  if(id==='B'&&fail){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:'GONE',message:'模拟 B 读取失败'}}));return;}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,data:{id}}));
});
await new Promise<void>((ok, bad)=>server.once('error',bad).listen(Number(process.env.PORT),'127.0.0.1',ok));
try {
  const browser=await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_EXECUTABLE || undefined});
  try {
    const page=await browser.newPage();
    await page.goto(process.env.BASE);
    const output=page.locator('output');
    await page.waitForFunction(()=>document.querySelector('output')?.textContent?.includes('"id":"A"'));
    await page.getByText('B',{exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('output')?.textContent?.includes('GONE'));
    assert.deepEqual(JSON.parse(await output.innerText()),{loading:false,error:'GONE'});
    fail=false;
    await page.getByText('retry').click();
    await page.waitForFunction(()=>document.querySelector('output')?.textContent?.includes('"id":"B"'));
    console.log('浏览器：切换到 B 后的失败未显示 A，重试取得 B');
  } finally {await browser.close();}
} finally {await new Promise<void>(ok=>server.close(()=>ok()));}
