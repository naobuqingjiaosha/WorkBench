import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(process.env.WORKBENCH_PLAYWRIGHT_PACKAGE??resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'));
const {chromium}=require('playwright');const base='http://127.0.0.1:'+(process.env.WORKBENCH_UI_PORT??'18894'),root=resolve('.tmp/ui-design-preview');
const health=await (await fetch(base+'/api/health')).json();assert.ok(health.data.dbFile.startsWith(root));
const fixture=JSON.parse(readFileSync(resolve(root,'fixture.json'),'utf8'));
const output='outputs/ui-implementation-20261024/screenshots',checks=[],errors=[];
mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
const ledgerPath=`/api/periods/${fixture.pid}/ledger`,url=base+`/#/workbench?id=${fixture.checks}&periodId=${fixture.pid}`;
const getLedger=async()=> (await(await fetch(base+ledgerPath)).json()).data;
const openEntry=async()=>{await page.goto(url);await page.getByRole('button',{name:/资料准备核对/}).click();};
try{
 await check('八个主页面加载、桌面布局与导航',async()=>{
  for(const route of ['dashboard','workbench','files','process','knowledge','agent','trash','settings']){
   await page.goto(base+'/#/'+route);await page.waitForTimeout(300);await page.locator('.content').waitFor();assert.equal(await page.locator('.content').evaluate(el=>el.scrollWidth<=el.clientWidth+3),true,route);await page.screenshot({path:output+'/'+route+'.png'});
  }
 });
 await check('未保存离开：继续编辑与放弃保持正确边界',async()=>{
  await openEntry();const content=page.locator('.record-form').getByLabel('具体内容'),original=await content.inputValue();await content.fill(original+' 未保存测试');
  await page.locator('.nav').getByRole('button',{name:'文件库',exact:true}).click();let dialog=page.getByRole('dialog',{name:'还有未保存的修改'});await dialog.waitFor();await page.screenshot({path:output+'/unsaved.png'});
  await dialog.getByRole('button',{name:'继续编辑',exact:true}).click();assert.equal(await content.inputValue(),original+' 未保存测试');
  await page.locator('.nav').getByRole('button',{name:'文件库',exact:true}).click();await dialog.getByRole('button',{name:'不保存离开',exact:true}).click();await page.waitForURL('**/#/files');
  assert.equal((await getLedger()).entries.find(e=>e.id===fixture.entryId).fields.content,original);
 });
 await check('保存失败：停留原页保留输入；重试成功后才离开',async()=>{
  await openEntry();const field=page.locator('.record-form').getByLabel('备注');const savedNote='隔离浏览器保存测试 '+Date.now();await field.fill(savedNote);
  const endpoint=base+ledgerPath+`/entries/${fixture.entryId}`;await page.route(endpoint,route=>route.request().method()==='PUT'?route.fulfill({status:503,json:{ok:false,error:{code:'TEST_FAILURE',message:'隔离验证：保存失败'}}}):route.continue());
  await page.locator('.nav').getByRole('button',{name:'文件库',exact:true}).click();const dialog=page.getByRole('dialog',{name:'还有未保存的修改'});await dialog.getByRole('button',{name:'保存并离开',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.match(await field.inputValue(),/隔离浏览器/);assert.match(page.url(),/workbench/);await page.screenshot({path:output+'/save-failure.png'});
  await page.unroute(endpoint);await dialog.getByRole('button',{name:'保存并离开',exact:true}).click();await page.waitForURL('**/#/files');assert.equal((await getLedger()).entries.find(e=>e.id===fixture.entryId).fields.remarks,savedNote);
 });
 await check('AI 字段对照：读取未保存快照、只采用选中项、不隐式保存，可撤销',async()=>{
  await openEntry();const field=page.locator('.record-form').getByLabel('具体内容'),original=await field.inputValue(),snapshot=original+' 本次输入';await field.fill(snapshot);
  const endpoint=base+ledgerPath+`/entries/${fixture.entryId}/suggest`;let request;
  await page.route(endpoint,async route=>{request=route.request().postDataJSON();await route.fulfill({json:{ok:true,data:{revision:request.revision,fields:{content:'模拟建议：核对签字资料',method:'模拟建议：抽样核查'},reason:'浏览器模拟建议，未调用真实模型'}}});});
  await page.getByRole('button',{name:'AI 辅助修改',exact:true}).click();const dialog=page.getByRole('dialog',{name:'AI 辅助修改',exact:true});await dialog.getByLabel('说明需要修改什么').fill('只完善表述');await dialog.getByRole('button',{name:'生成修改建议',exact:true}).click();await dialog.getByText('浏览器模拟建议，未调用真实模型').waitFor();assert.equal(request.fields.content,snapshot);assert.equal(request.includeHistory,false);
  await dialog.getByRole('checkbox',{name:'监督方式',exact:true}).uncheck();await page.screenshot({path:output+'/ai-diff.png'});await dialog.getByRole('button',{name:'采用 1 项到编辑区',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(await field.inputValue(),'模拟建议：核对签字资料');assert.equal((await getLedger()).entries.find(e=>e.id===fixture.entryId).fields.content,original);
  await page.getByRole('button',{name:'撤销本次采用',exact:true}).click();assert.equal(await field.inputValue(),snapshot);await field.fill(original);await page.unroute(endpoint);
 });
 await check('文件映射预览、版本和下载入口',async()=>{
  await page.getByRole('button',{name:'预览与版本',exact:true}).first().click();const dialog=page.getByRole('dialog');await dialog.getByText('不是 Excel 排版、公式重算或打印预览。',{exact:false}).waitFor();await dialog.getByRole('heading',{name:'文件版本',exact:true}).waitFor();await page.screenshot({path:output+'/file-preview.png'});await dialog.getByRole('button',{name:'关闭',exact:true}).last().click();
 });
 await check('同步差异刷新：无默认冲突选择、拒绝陈旧扫描并保留选择',async()=>{
  const state=await getLedger(),e=state.entries.find(e=>e.id===fixture.entryId),change={entryId:e.id,field:'content',source:'doc-test',label:'监督情况表',value:'文件侧建议内容',current:e.fields.content,base:'原基线'};
  await page.route(base+ledgerPath+'/changes',route=>route.fulfill({json:{ok:true,data:{changes:[change],conflicts:[change],issues:[],token:'fake-ui-token'}}}));
  await page.getByRole('button',{name:'查看文件变化',exact:true}).click();const dialog=page.getByRole('dialog',{name:'文件变化与同步核对'});await dialog.getByText('共同基线').waitFor();assert.equal(await dialog.getByRole('button',{name:'确认同步',exact:true}).isDisabled(),true);await dialog.getByRole('combobox').selectOption('database');await page.screenshot({path:output+'/sync-conflict.png'});
  await dialog.getByRole('button',{name:'确认同步',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.match(await dialog.getByRole('alert').innerText(),/变化|重新/);assert.equal(await dialog.getByRole('combobox').inputValue(),'database');await dialog.getByRole('button',{name:'取消',exact:true}).click();await page.unroute(base+ledgerPath+'/changes');
 });
 await check('文件上传失败保留选择，重试并预览真实文本',async()=>{
  await page.locator('.nav').getByRole('button',{name:'文件库',exact:true}).click();await page.getByRole('button',{name:'上传文件',exact:true}).first().click();const dialog=page.getByRole('dialog',{name:'上传业务文件'});await dialog.getByLabel('所属工作').selectOption(String(fixture.checks));await dialog.locator('input[type=file]').setInputFiles({name:'隔离界面验证.txt',mimeType:'text/plain',buffer:Buffer.from('这是匿名界面验证资料，不含业务数据。')});
  const endpoint=base+'/api/artifacts/upload';await page.route(endpoint,route=>route.fulfill({status:503,json:{ok:false,error:{code:'TEST_FAILURE',message:'隔离验证：上传失败'}}}));await dialog.getByRole('button',{name:'上传文件',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(await dialog.locator('input[type=file]').evaluate(el=>el.files[0].name),'隔离界面验证.txt');await page.unroute(endpoint);await dialog.getByRole('button',{name:'上传文件',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByText('隔离界面验证.txt',{exact:true}).first().waitFor();
 });
 await check('同步完成按对象显示结果，未涉及工作记录表保持未改动',async()=>{
  await openEntry();await page.getByRole('button',{name:'查看文件变化',exact:true}).click();const dialog=page.getByRole('dialog',{name:'文件变化与同步核对'});await dialog.getByRole('button',{name:'确认同步',exact:true}).click();await dialog.getByText('本次同步完成',{exact:true}).waitFor();const work=dialog.locator('.file-result').filter({hasText:'工作记录表'}).first();assert.match(await work.innerText(),/未改动/);await page.screenshot({path:output+'/sync-results.png'});await dialog.getByRole('button',{name:'取消',exact:true}).click();
 });
 await check('项目阶段导航与工时逐日筛选',async()=>{
  await page.goto(base+'/#/workbench?id=3');await page.getByRole('heading',{name:'项目阶段办理',exact:true}).waitFor();const stages=page.getByRole('navigation',{name:'项目阶段'}).getByRole('button');if(await stages.count()>1)await stages.nth(1).click();assert.equal(await page.locator('.stage-layout .timeline .step').count(),1);await page.screenshot({path:output+'/project-stage.png'});
  await page.goto(base+`/#/workbench?task=timesheets&id=${fixture.hours}&periodId=${fixture.hpid}&runId=${fixture.run}`);await page.getByRole('button',{name:'逐日分配',exact:true}).click();await page.locator('.daily-split').getByRole('button',{name:'示例人员甲',exact:true}).click();assert.doesNotMatch(await page.locator('.daily-split tbody').innerText(),/示例人员乙/);await page.screenshot({path:output+'/timesheet-focused.png'});
 });
 await check('窄屏页面无整体横向溢出，导航可展开',async()=>{
  await page.goto(base+'/#/dashboard');await page.setViewportSize({width:768,height:1000});await page.getByRole('button',{name:'切换导航'}).click();assert.equal(await page.locator('.sidebar').isVisible(),true);await page.locator('.nav').getByRole('button',{name:'我的工作台',exact:true}).click();await page.waitForURL('**/#/workbench');assert.equal(await page.locator('.content').evaluate(el=>el.scrollWidth<=el.clientWidth+2),true);await page.screenshot({path:output+'/narrow.png'});
 });
 assert.deepEqual(errors,[]);
}catch(e){await page.screenshot({path:output+'/interaction-failure.png'});console.log('FAILED PAGE',page.url(),(await page.locator('body').innerText()).slice(-5000));throw e;}finally{writeFileSync('outputs/ui-implementation-20261024/browser-interactions.json',JSON.stringify({checks,errors},null,2));await browser.close();}


