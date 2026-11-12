import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {withBrowserPage} from './browser-fixture.ts';
import ExcelJS from 'exceljs';
import {bootstrap} from '../../src/core/bootstrap.ts';
import {closeDatabase,get} from '../../src/db/index.ts';
import {createWorkbench} from '../../src/domain/service.ts';
import {syncPeriods} from '../../src/domain/periods.ts';
import {syntheticTimesheets} from './timesheet-fixture.ts';

// Optional real browser run: provide a Playwright installation and its matching Chromium.
// The isolated runner supplies a fresh database, files, port, session token and web root.
const temp=process.env.WORKBENCH_ISOLATION_ROOT!;
const fixture=await syntheticTimesheets(),[person]=fixture.people;
bootstrap();
const type=get<{id:number; published_config_id:number}>("SELECT * FROM work_type WHERE executor='timesheet' AND published_config_id IS NOT NULL")!;
const work=createWorkbench({name:'浏览器合成工时',workTypeId:type.id,publishedConfigId:type.published_config_id,firstPeriod:fixture.month});
const period=syncPeriods(work.id,'2028-02-29').find(p=>p.report_period===fixture.month)!;
closeDatabase();
await withBrowserPage(async(page,base)=>{
  const button=(name:string)=>page.getByRole('button',{name,exact:true});
  const input=page.locator('input[type=file]');
  const workbookFile=(name:string,buffer:Buffer)=>({name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer});
  const scope=base+`/#/workbench?task=timesheets&id=${work.id}&periodId=${period.id}`;
  await page.goto(scope);
  assert.equal(await page.getByLabel('数据月份').inputValue(),fixture.month);
  assert.equal(await page.getByLabel('数据月份').isDisabled(),true);
  await page.getByText('月份随所属期次，请先返回所属工作再选择月份。').waitFor();
  await page.getByLabel('研发中心工时表',{exact:true}).setInputFiles(workbookFile('合成研发.xlsx',fixture.rd));
  await page.getByText('合成研发.xlsx 已识别',{exact:false}).waitFor();
  await page.getByLabel('统一模板 / 上期部门工时表',{exact:true}).setInputFiles(workbookFile('合成模板.xlsx',fixture.template));
  await page.getByText('合成模板.xlsx 已识别',{exact:false}).waitFor();
  // Force the recovery path. The copy is retained and a manually verified mapping adopts it.
  const unusual=new ExcelJS.Workbook();await unusual.xlsx.load(fixture.attendance as never);
  unusual.worksheets[0]!.getCell('A1').value='当期参与者';
  const attendanceBytes=Buffer.from(await unusual.xlsx.writeBuffer());
  await page.getByLabel('考勤资料',{exact:true}).setInputFiles(workbookFile('合成考勤.xlsx',attendanceBytes));
  const pending=page.getByRole('region',{name:'待核对考勤'});
  await pending.getByRole('alert').waitFor();
  assert.equal(await button('采用此考勤').isDisabled(),true);
  for(const [field,value] of [['工作表名称','合成考勤'],['数据起始行','2'],['姓名列号','1'],['日期标题行（横表）','1'],['首日列号（横表）','2']])
    await pending.getByLabel(field,{exact:true}).fill(value);
  await button('验证手动映射').click();
  await pending.getByText(/映射验证通过/).waitFor();
  await button('保存输入草稿').click();await page.getByText(/本机输入草稿已保存/).waitFor();
  await page.reload();await pending.waitFor();
  assert.equal(await button('采用此考勤').isDisabled(),true);
  await button('验证手动映射').click();
  await button('采用此考勤').click();
  await pending.waitFor({state:'hidden'});
  await page.getByLabel(/本月明确参与名单/).fill(person);
  await input.nth(3).setInputFiles(workbookFile('合成月报.xlsx',fixture.report));
  const reportReview=page.getByRole('region',{name:'待核对项目月报'});
  await reportReview.getByLabel(/已核对此资料用于/).check();
  await button('选中全部候选（仍需逐项确认名称）').click();
  for(let i=0;i<2;i++){
    await reportReview.getByRole('button',{name:/以月报名称填写/}).nth(i).click();
    await reportReview.getByLabel(/已核对本行所选正式名称/).nth(i).check();
  }
  await button('采用已确认项目').click();await reportReview.waitFor({state:'hidden'});
  assert.equal(await page.getByLabel(/本月部门项目/).inputValue(),fixture.projects.join('\n'));
  await page.getByLabel(/实际应计薪日期（日号/).fill('2, 29');
  await page.getByLabel(/已按本月资料核对以上日期/).check();
  await page.getByLabel(/已确认研发资料完整/).check();
  await page.getByText('人员参与项目、扣薪例外与数据映射',{exact:true}).click();
  await page.getByLabel(person+' 参与项目（普通坐班自动均分）').selectOption(fixture.projects);
  await page.getByLabel(/扣薪例外（姓名/).fill(person+'|2028-02-29=2');
  await button('生成并核对工时表').click();
  await page.getByText(/部门合计 13.00 小时；研发合计 1 小时/).waitFor();
  await button('逐日分配').click();
  const adjust=(date:string)=>page.getByRole('row').filter({hasText:date}).first().getByRole('button',{name:'调整'});
  await adjust('2028-02-29').click();
  const drawer=page.getByRole('dialog',{name:/逐日调整/});
  assert.match(await drawer.getAttribute('aria-label'),/2028-02-29/);
  const reason=drawer.getByLabel('修改依据',{exact:true});
  assert.ok(await reason.evaluate((el:HTMLElement)=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}));
  await reason.fill('尚未保存的依据');
  await page.keyboard.press('Escape');
  await button('继续编辑').click();
  assert.equal(await reason.inputValue(),'尚未保存的依据');
  await button('取消此日编辑').click();
  await button('不保存离开').click();
  await drawer.waitFor({state:'hidden'});
  assert.ok(await adjust('2028-02-29').evaluate((el:HTMLElement)=>el===document.activeElement));
  await adjust('2028-02-02').click();
  assert.equal(await reason.inputValue(),'');
  await reason.fill('合成逐日核对');
  await page.getByLabel(/仅调整项目份额/).fill(fixture.projects.map((p,i)=>p+'='+[1,2,4][i]).join('\n'));
  await button('保持总工时，更新分配').click();
  await page.getByText(/修改已写入新记录/).waitFor();
  await button('核对结果').click();
  await page.getByText(fixture.projects[2]+'：10.00 小时',{exact:true}).waitFor();
  const getting=page.waitForEvent('download');
  await button('导出核对稿').click();
  const dl=await getting;const destination=join(temp,'合成工时.xlsx');await dl.saveAs(destination);
  const actual=new ExcelJS.Workbook();await actual.xlsx.readFile(destination);
  assert.equal(actual.getWorksheet('人员工时汇总')!.getCell('E3').result,14);
  const evidence=actual.worksheets.at(-1)!;
  assert.ok(evidence.getColumn(2).values.includes('合成考勤.xlsx'));
  assert.ok(evidence.getColumn(2).values.includes('合成月报.xlsx'));
  await page.getByLabel('已核对 Excel 与原始资料').check();
  const finalizing=page.waitForResponse((r:import('playwright-core').Response)=>r.url().endsWith('/finalize')&&r.request().method()==='POST');
  await button('保存核对后的定稿').click();
  const finalized=await finalizing;assert.equal(finalized.status(),200,await finalized.text());
  await page.getByRole('heading',{name:/已保存的工时版本/}).click();
  await page.getByRole('button',{name:/已定稿 · 版本/}).waitFor();
  const runs=await fetch(base+'/api/timesheets?periodId='+period.id).then(r=>r.json());
  const latest=runs.data.items[0];
  assert.equal(latest.status,'final');assert.ok(latest.artifact_id);
  await page.reload();
  await page.getByText(/部门合计 13.00 小时；研发合计 1 小时/).waitFor();
  await button('下载已定稿文件').waitFor();
  if(process.env.TIMESHEET_SAMPLE_DIR){
    // Explicitly requested deliverables only. Every workbook came from syntheticTimesheets().
    const sample=resolve(process.env.TIMESHEET_SAMPLE_DIR);mkdirSync(sample,{recursive:true});
    const inputs=join(sample,'试用输入');mkdirSync(inputs,{recursive:true});
    for(const [name,bytes] of Object.entries({'合成研发.xlsx':fixture.rd,'合成模板.xlsx':fixture.template,'合成考勤.xlsx':attendanceBytes,'合成月报.xlsx':fixture.report})){
      writeFileSync(join(inputs,name),bytes,{flag:'wx'});
    }
    const finalFile=await fetch(base+'/api/timesheets/'+latest.id+'/export');
    assert.ok(finalFile.ok);
    writeFileSync(join(sample,'合成工时定稿.xlsx'),Buffer.from(await finalFile.arrayBuffer()));
    await button('核对结果').click();
    await page.screenshot({path:join(sample,'工时核对界面.png')});
  }
  // Replace the uploaded template after reopening the final. A new draft must
  // explain an unsafe original total, without changing the earlier final.
  const custom=new ExcelJS.Workbook();await custom.xlsx.load(fixture.template as never);
  const sheet=custom.getWorksheet('工时明细表（填写）')!;
  sheet.getCell('C9').value='模板保留总计';
  sheet.getCell('AM9').value={formula:'SUM(INDIRECT("AM5:AM8"))',result:396};
  await button('人员与项目').click();
  await page.getByLabel('统一模板 / 上期部门工时表',{exact:true}).setInputFiles(workbookFile('需核对公式.xlsx',Buffer.from(await custom.xlsx.writeBuffer())));
  await page.getByText('需核对公式.xlsx 已识别',{exact:false}).waitFor();
  await button('重新计算并保存').click();
  await page.getByText(/模板公式.*工时明细表（填写）!AN11.*INDIRECT/).waitFor();
  await page.getByLabel('已核对 Excel 与原始资料').check();
  assert.equal(await button('保存核对后的定稿').isDisabled(),true);
  const versions=await fetch(base+'/api/timesheets?periodId='+period.id).then(r=>r.json());
  assert.equal(versions.data.items[0].status,'draft');
  const old=versions.data.items.find((r:{id:number})=>r.id===latest.id);
  assert.equal(old.status,'final');assert.equal(old.artifact_id,latest.artifact_id);
  await button('← 返回所属工作').click();
  const embedded=page.locator('.timesheet-inline');
  await embedded.getByRole('button',{name:'人员与项目',exact:true}).click();
  await embedded.getByText('月份随所属期次，换月请使用上方期次选择。').waitFor();
  await embedded.getByRole('button',{name:'逐日分配',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  await adjust('2028-02-02').click();
  assert.ok(await drawer.evaluate((el:HTMLElement)=>{
    const r=el.getBoundingClientRect();
    return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1&&el.contains(document.activeElement);
  }));
  await page.keyboard.press('Escape');
  await drawer.waitFor({state:'hidden'});
  console.log('真实 Chromium 完成：导入、异常恢复、手改、下载、定稿和重开。换入不安全公式后显示定位、禁用定稿，原定稿仍关联原成果。');
});
