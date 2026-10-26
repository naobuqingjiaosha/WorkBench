import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {mkdirSync, writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const require=createRequire(process.env.WORKBENCH_PLAYWRIGHT_PACKAGE??resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'));
const {chromium}=require('playwright');
const base='http://127.0.0.1:'+(process.env.WORKBENCH_UI_PORT??'18894');
const health=await(await fetch(base+'/api/health')).json();
assert.ok(health.data.dbFile.startsWith(resolve('.tmp/ui-design-preview')));
const out=resolve('outputs/ui-implementation-20261024/home-compact');mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1366,height:650}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
const reply=(route,data)=>route.fulfill({json:{ok:true,data}});
const names=['月度监督检查','部门月度工时','泵站 PLC 升级改造','流域信息化平台建设','OA 信创平台迁移','会议纪要整理','其他在办工作','已结束工作'];
const works=names.map((name,i)=>({id:i+1,name,status:i===7?'done':'active',updated_at:'2026-10-24 09:00',work_type_name:i<2?'行政管理':'信息化项目',work_type_mode:i>1&&i<5?'process':'document',period_due:i===0?'2026-10-20':null,plan_end_date:i===3?'2026-10-26':null}));
const inbox={periods:[{id:11,workbench_id:1,name:names[0],report_period:'2026年10月',due_date:'2026-10-20',overdue:true,missing:['4 项内容待确认'],nextAction:'核对草稿',canComplete:false}],other:[{kind:'material',title:'设备调试',reason:'缺少 1 份调试报告',href:'/workbench?id=3',workbenchId:3,workbenchName:names[2]}],todos:[],timesheets:[{id:21,month:'2026年10月',exceptions:3,workbench_id:2,period_id:null}],otherTruncated:false};
const files=[{id:1001,title:'月度监督检查表_2026-10.docx',file_name:'月度监督检查表_2026-10.docx',created_at:'2026-10-21 17:20',is_final:0},{id:1002,title:'部门工时表_2026-09.xlsx',file_name:'部门工时表_2026-09.xlsx',created_at:'2026-10-18 10:32',is_final:1}];
let state='populated';
try {
  await page.goto(base+'/#/dashboard');await page.locator('.home-action-row').first().waitFor();
  await page.screenshot({path:resolve(out,'actual-data-1366.png'),fullPage:true});
  await page.route('**/api/workbenches?*',route=>reply(route,{items:state==='empty'?[]:works}));
  await page.route('**/api/periods/sync',route=>reply(route,{}));
  await page.route('**/api/workflow/inbox',route=>state==='error'?route.fulfill({status:503,json:{ok:false,error:{code:'LAYOUT_TEST',message:'待办读取测试失败'}}}):reply(route,state==='empty'?{periods:[],other:[],todos:[],timesheets:[]}:inbox));
  await page.route('**/api/artifacts?*',route=>reply(route,{items:state==='empty'?[]:files}));
  await page.reload();await page.locator('.home-file-row').first().waitFor();
  await check('1366 首页保留五个模块、7:5列宽与页头同排',async()=>{
    const box=s=>page.locator(s).boundingBox();
    const left=await box('.home-inbox'),right=await box('.home-overview'),cont=await box('.home-continue'),cal=await box('.home-calendar'),file=await box('.home-files'),title=await box('.home-header h2'),search=await box('.home-search');
    assert.ok(Math.abs(left.y-right.y)<2);assert.ok(Math.abs(left.width/right.width-1.4)<0.02);
    assert.equal(Math.round((await box('.sidebar')).width),184);assert.equal(Math.round(left.x),204);
    assert.ok(cont.y>left.y+left.height&&cal.y>right.y+right.height&&file.y>cal.y+cal.height);
    assert.ok(search.y<title.y+title.height+15);assert.equal(await page.locator('.topbar').isVisible(),false);
    assert.equal(await page.locator('.home-inbox .home-action-row').count(),3);assert.equal(await page.locator('.home-continue .home-action-row').count(),3);
    assert.doesNotMatch(await page.locator('.home-continue').innerText(),/月度监督检查|部门月度工时|泵站 PLC/);
    assert.match(await page.locator('.summary-grid').innerText(),/在办\s*7\s*待核对\s*2\s*已结束\s*1/);
    assert.equal(await page.locator('.calendar-grid .selected').evaluate(el=>Math.abs(el.clientWidth-el.clientHeight)<2),true);
    await page.screenshot({path:resolve(out,'reference-fixture-1366.png'),fullPage:true});
  });
  await check('紧凑首页在100%缩放下完整容纳五个模块',async()=>{
    const v=await page.locator('.content').evaluate(e=>({h:e.clientHeight,sh:e.scrollHeight,scale:visualViewport.scale}));
    assert.equal(v.scale,1);assert.ok(v.sh<=v.h+2);
    const measured={};
    for(const selector of ['.home-inbox','.home-continue','.home-overview','.home-calendar','.home-files','.home-record-link']){
      const box=await page.locator(selector).boundingBox();measured[selector]=box;
      assert.ok(box.y>=0&&box.y+box.height<=650,selector);
    }
    writeFileSync(resolve(out,'compact-bounds.json'),JSON.stringify(measured,null,2));
    await page.screenshot({path:resolve(out,'populated-1366.png')});
  });
  await check('搜索、提醒定位、月份切换及待办翻页',async()=>{
    await page.getByRole('button',{name:'搜索工作、成果、模板',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('dialog').locator('input').first().fill('测试');await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'查看待处理事项'}).click();assert.equal(await page.locator('#home-inbox').evaluate(el=>el===document.activeElement),true);
    const before=await page.locator('.home-calendar h3').innerText();await page.getByRole('button',{name:'下个月',exact:true}).click();assert.notEqual(await page.locator('.home-calendar h3').innerText(),before);await page.getByRole('button',{name:'今天',exact:true}).click();
    inbox.todos.push({id:91,title:'第四项待办',due_date:null,note:'验证翻页'});await page.locator('.home-sort summary').click();await page.getByRole('button',{name:'刷新待办',exact:true}).click();await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByText('共 4 项 · 2 / 2',{exact:true}).waitFor();assert.equal(await page.locator('.home-inbox .home-action-row').count(),1);
    inbox.todos=[];await page.reload();await page.locator('.home-file-row').first().waitFor();
  });
  await check('1920保持组件尺寸，768折为单列且无横向溢出',async()=>{
    for(const width of [1920,768]){await page.setViewportSize({width,height:1080});assert.equal(await page.locator('.content').evaluate(el=>el.scrollWidth<=el.clientWidth+2),true);if(width===768){const a=await page.locator('.home-overview').boundingBox(),b=await page.locator('.home-continue').boundingBox();assert.ok(a.y>=b.y+b.height);assert.equal(await page.getByRole('button',{name:'切换导航'}).isVisible(),true);}await page.screenshot({path:resolve(out,`reference-fixture-${width}.png`),fullPage:true});}
  });
  await check('空态与失败态仍保持设计的五个模块',async()=>{
    await page.setViewportSize({width:1366,height:650});
    for(const value of ['empty','error']){state=value;await page.reload();await page.waitForTimeout(400);assert.equal(await page.locator('.dashboard-grid .card').count(),5);if(value==='error'){await page.getByText('待办读取测试失败',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('.home-inbox').innerText(),/当前没有/);}await page.screenshot({path:resolve(out,value+'.png'),fullPage:true});}
  });
  assert.deepEqual(errors,[]);
} finally {writeFileSync(resolve(out,'results.json'),JSON.stringify({fixture:'仅浏览器接口拦截；没有写入业务数据',checks,errors},null,2));await browser.close();}
