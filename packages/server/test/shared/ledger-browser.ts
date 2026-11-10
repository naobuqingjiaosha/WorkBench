import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import {bootstrap} from '../../src/core/bootstrap.ts';
import {get,closeDatabase} from '../../src/db/index.ts';
import {ledgerScopeFixture,ledgerBooks} from './ledger-fixture.ts';
import {withBrowserPage} from './browser-fixture.ts';

bootstrap();
const {work,period}=ledgerScopeFixture(),files=await ledgerBooks();
await withBrowserPage(async(page,base)=>{
  const route='/api/periods/'+period.id+'/ledger';
  const view=async()=>(await (await fetch(base+route)).json()).data;
  const button=(name:string)=>page.getByRole('button',{name,exact:true});
  await page.goto(base+'/#/workbench?id='+work.id+'&periodId='+period.id);
  await page.getByLabel(/导入年度 Excel/).setInputFiles({name:'年度台账.xlsx',mimeType:'application/octet-stream',buffer:files.ledger});
  await page.getByRole('button',{name:/合成交付核对/}).click();
  await page.getByText(/模板与位置/).click();
  for(const [kind,label] of [['work','工作记录表'],['supervision','监督情况表']] as const){
    await page.getByLabel(new RegExp(label+'模板')).setInputFiles({name:kind+'.xlsx',mimeType:'application/octet-stream',buffer:files[kind]});
    await page.getByText(label+'模板 · 已提供',{exact:true}).waitFor();
  }
  await button('保存并生成两表').click();
  await page.getByRole('dialog',{name:'文件生成结果'}).getByText('已生成',{exact:true}).nth(1).waitFor();
  await button('返回办理').click();
  let state=await view();
  assert.equal(state.documents.length,2);
  assert.equal(get('SELECT COUNT(*) n FROM inspection_record')!.n,0);
  const workDoc=state.documents.find((d:{kind:string})=>d.kind==='work');
  const supervision=state.documents.find((d:{kind:string})=>d.kind==='supervision');
  const wb=new ExcelJS.Workbook();await wb.xlsx.readFile(workDoc.path);
  assert.equal(wb.worksheets[0]!.getCell('B4').text,'合成交付核对');
  const sup=new ExcelJS.Workbook();await sup.xlsx.readFile(supervision.path);
  assert.equal(sup.worksheets[0]!.getCell('C6').text,'已核对合成材料甲');
  assert.equal(sup.worksheets[0]!.getCell('D6').text,'发现合成差异');
  // Two independent editors now disagree about the same field.
  await page.getByLabel(/^发现问题/).fill('工作台人工记录乙');
  await button('保存草稿').click();
  await page.getByText('草稿已保存；未登记实际检查',{exact:true}).waitFor();
  wb.worksheets[0]!.getCell('B5').value='文件人工记录丙';
  await wb.xlsx.writeFile(workDoc.path);
  await button('查看文件变化').click();
  const dialog=page.getByRole('dialog',{name:'文件变化与同步核对'});
  await dialog.getByText('冲突待选择',{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('combobox').inputValue(),'');
  assert.equal(await button('确认同步').isDisabled(),true);
  await dialog.getByRole('combobox').selectOption(workDoc.id);
  await button('确认同步').click();
  await dialog.getByText('本次同步完成',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'取消'}).click();
  assert.equal(await page.getByLabel(/^发现问题/).inputValue(),'文件人工记录丙');
  state=await view();assert.equal(state.entries[0].status,'draft');
  await sup.xlsx.readFile(supervision.path);
  assert.equal(sup.worksheets[0]!.getCell('D6').text,'文件人工记录丙');
  const ledger=new ExcelJS.Workbook();await ledger.xlsx.readFile(state.ledger.path);
  assert.equal(ledger.getWorksheet('合成项目')!.getCell('F5').text,'文件人工记录丙');
  await button('确认实际检查').click();
  await button('确认并登记实际检查').click();
  await page.getByText('实际检查已确认',{exact:true}).first().waitFor();
  assert.equal((await view()).entries[0].status,'confirmed');
  const record=get('SELECT * FROM inspection_record WHERE period_id=?',[period.id])!;
  assert.equal(record.result,'文件人工记录丙');
  assert.equal(record.subject,'合成交付核对');assert.equal(record.inspection_date,'2028-02-12');
  if(process.env.LEDGER_SAMPLE_DIR){
    mkdirSync(process.env.LEDGER_SAMPLE_DIR,{recursive:true});
    const inputs=join(process.env.LEDGER_SAMPLE_DIR,'试用输入');mkdirSync(inputs,{recursive:true});
    for(const [name,bytes] of Object.entries({'合成年度台账.xlsx':files.ledger,'工作记录表模板.xlsx':files.work,'监督情况表模板.xlsx':files.supervision})){
      writeFileSync(join(inputs,name),bytes,{flag:'wx'});
    }
    for(const [file,name] of [[state.ledger.path,'年度台账'],[workDoc.path,'工作记录表'],[supervision.path,'监督情况表']]){
      writeFileSync(join(process.env.LEDGER_SAMPLE_DIR,name+'-合成样例.xlsx'),readFileSync(file),{flag:'wx'});
    }
  }
  console.log('Chromium 实际完成年度 XLSX 导入、两张模板映射、外部编辑冲突、逐项选择并写回、人工确认登记。同一记录对应两张 XLSX 和实际检查。');
});
closeDatabase();
