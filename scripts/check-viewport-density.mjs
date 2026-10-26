import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const require=createRequire(process.env.WORKBENCH_PLAYWRIGHT_PACKAGE??resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'));
const {chromium}=require('playwright');
const base='http://127.0.0.1:'+(process.env.WORKBENCH_UI_PORT??'18894');
const root=resolve('.tmp/ui-design-preview');
const health=await(await fetch(base+'/api/health')).json();
assert.ok(health.data.dbFile.startsWith(root),'Only the isolated UI preview may be tested');
const f=JSON.parse(readFileSync(resolve(root,'fixture.json'),'utf8'));
const out=resolve('outputs/ui-implementation-20261024/compact-100');mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1366,height:650},deviceScaleFactor:1});
const checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
const visit=async route=>{await page.goto(base+'/#/'+route);await page.waitForTimeout(300);};
const fits=async locator=>{
  const b=await locator.boundingBox();assert.ok(b,'Element is visible');
  const v=page.viewportSize();assert.ok(b.y>=-1&&b.y+b.height<=v.height+1&&b.x>=-1&&b.x+b.width<=v.width+1,JSON.stringify({box:b,viewport:v}));
};
const frame=async()=>{
  const v=await page.locator('.content').evaluate(e=>({h:e.clientHeight,sh:e.scrollHeight,w:e.clientWidth,sw:e.scrollWidth,scale:visualViewport.scale,zoom:getComputedStyle(document.body).zoom}));
  assert.equal(v.scale,1);assert.ok(v.zoom==='1'||v.zoom==='normal');
  assert.ok(v.sh<=v.h+2&&v.sw<=v.w+2,JSON.stringify(v));
  await fits(page.locator('.nav').getByRole('button',{name:'系统配置',exact:true}));
};
const scrollToEnd=async locator=>{
  const data=await locator.evaluate(e=>{e.scrollTop=e.scrollHeight;return {h:e.clientHeight,sh:e.scrollHeight,top:e.scrollTop};});
  assert.ok(data.sh<=data.h+1||data.top>0,JSON.stringify(data));
};
try {
  for(const viewport of [{width:1280,height:600},{width:1366,height:650},{width:1440,height:800},{width:1920,height:900}]){
    await page.setViewportSize(viewport);
    await check(`${viewport.width}×${viewport.height}：八个页面100%缩放，框架不溢出`,async()=>{
      for(const route of ['dashboard','workbench','files','process','knowledge','agent','trash','settings']){
        await visit(route);await frame();
        if(route==='dashboard')await fits(page.locator('.home-record-link'));
        if(route==='agent')await fits(page.locator('.chat-composer'));
        if(route==='files')assert.ok(await page.locator('.file-results > .card-body').evaluate(e=>e.scrollWidth<=e.clientWidth+2),'File actions fit without horizontal scrolling');
        if(viewport.width===1366)await page.screenshot({path:resolve(out,route+'.png')});
      }
    });
  }
  await page.setViewportSize({width:1366,height:650});
  await check('台账长表单、固定保存栏及AI弹窗',async()=>{
    await visit(`workbench?id=${f.checks}&periodId=${f.pid}`);
    await page.getByRole('button',{name:/资料准备核对/}).click();await frame();await fits(page.locator('.action-dock'));
    await scrollToEnd(page.locator('.period-panel > .card-body'));await fits(page.locator('.action-dock'));
    await page.screenshot({path:resolve(out,'ledger.png')});
    await page.getByRole('button',{name:'AI 辅助修改',exact:true}).click();await fits(page.getByRole('dialog'));
    await fits(page.getByRole('dialog').getByRole('button',{name:'生成修改建议',exact:true}));
    await page.screenshot({path:resolve(out,'ai-dialog.png')});await page.keyboard.press('Escape');
  });
  await check('工时三种视图保存及导出可见，内容可以滚动到底',async()=>{
    await visit(`workbench?task=timesheets&id=${f.hours}&periodId=${f.hpid}&runId=${f.run}`);
    await page.locator('.timesheet-workspace').waitFor();await frame();await fits(page.locator('.action-dock'));
    await scrollToEnd(page.locator('.timesheet-input-scroll'));await fits(page.locator('.action-dock'));
    await page.screenshot({path:resolve(out,'timesheet-people.png')});
    for(const tab of ['逐日分配','核对结果']){
      await page.getByRole('button',{name:tab,exact:true}).click();await frame();
      await fits(page.locator('.action-dock'));await fits(page.locator('.timesheet-result-actions'));
      await scrollToEnd(page.locator('.timesheet-results-scroll'));
      await page.screenshot({path:resolve(out,tab==='逐日分配'?'timesheet-daily.png':'timesheet-review.png')});
    }
  });
  await check('项目阶段与长流程列表采用区域滚动，上传弹窗完整可见',async()=>{
    await visit('workbench?id=3');await frame();await scrollToEnd(page.locator('.card:has(.stage-layout) > .card-body'));
    await page.screenshot({path:resolve(out,'project.png')});
    await visit('process');await scrollToEnd(page.locator('.page-process > .col > .page-split > .col'));
    await frame();await page.screenshot({path:resolve(out,'process-scrolled.png')});
    await visit('files');await page.getByRole('button',{name:'上传文件',exact:true}).first().click();await fits(page.getByRole('dialog'));
    await fits(page.getByRole('dialog').getByRole('button',{name:'上传文件',exact:true}));
    await page.screenshot({path:resolve(out,'upload-dialog.png')});
    await page.keyboard.press('Escape');
    await visit('settings');
    for(const label of ['模型与资料','目录与备份','应用与导出']){
      await page.locator('.section-nav').getByRole('button',{name:label,exact:true}).click();await frame();
      await scrollToEnd(page.locator('.page-settings > .page-split > .section-content'));
    }
    await visit('agent');
    for(const label of ['工作记录','补充备忘','待确认建议','操作记录']){
      await page.getByRole('button',{name:label,exact:true}).first().click();await frame();
    }
  });
  assert.deepEqual(errors,[]);
} finally {
  writeFileSync(resolve(out,'results.json'),JSON.stringify({viewports:'CSS pixels; deviceScaleFactor 1; visualViewport.scale 1',checks,errors},null,2));
  await browser.close();
}
