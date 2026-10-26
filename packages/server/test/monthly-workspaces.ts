import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import ExcelJS from 'exceljs';
import type {RunInput} from '../src/domain/timesheets.ts';
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=process.env.WORKBENCH_ISOLATION_ROOT!;
(await import('../src/core/bootstrap.ts')).bootstrap();
const db=await import('../src/db/index.ts'),service=await import('../src/domain/service.ts'),periods=await import('../src/domain/periods.ts');
const ts=await import('../src/domain/timesheets.ts'),tw=await import('../src/domain/timesheet-workspace.ts'),ledger=await import('../src/domain/annual-ledger.ts');
const outcomes:string[]=[];async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();outcomes.push(name);console.log('✓ '+name);}
function work(code:string,name:string){const t=service.listWorkTypes().find(t=>t.code===code)!;const w=service.createWorkbench({name,workTypeId:t.id,templateIds:[]});periods.savePeriodRule(w.id,{frequency:'monthly',first_period:'2026-01',requirements:[]});periods.syncPeriods(w.id,'2026-10-21');return w;}
const hoursWork=work('department-hours','工时隔离验证'),checksWork=work('integrity-monthly-inspection','月检隔离验证');
const month=(wid:number,m='2026-09')=>periods.listPeriods(wid).find(p=>p.report_period===m)!;
const real=process.env.WORKBENCH_REAL_MONTHLY_SOURCES==='1';
const sourceRoot=resolve('.tmp/monthly-upgrade/sources'),outDir=real?resolve('outputs/monthly-upgrade-verification'):join(root,'evidence');mkdirSync(outDir,{recursive:true});
async function source(name:string,book:ExcelJS.Workbook){return ts.storeTimesheetSource(name,Buffer.from(await book.xlsx.writeBuffer()));}
function template(){const b=new ExcelJS.Workbook(),cover=b.addWorksheet('封面');cover.getCell('C8').value=2026;cover.getCell('E8').value=8;const s=b.addWorksheet('工时明细表（填写）');for(let d=1;d<=31;d++){s.getCell(3,8+d).value=d;s.getCell(4,8+d).value='星期一';}['甲','乙'].forEach((p,i)=>{s.getCell(5+i,3).value=p;s.getCell(5+i,4).value='服务工时';s.getCell(5+i,5).value='项目一';s.getCell(5+i,40).value={formula:`SUM(I${5+i}:AM${5+i})`,result:0};});s.getCell(7,3).value='合计';s.getCell(7,40).value={formula:'SUM(AN5:AN6)',result:0};b.addWorksheet('人员工时汇总及校验（仅查看）');return b;}
async function simpleInput(m:string){const t=await source('template.xlsx',template()),rd=new ExcelJS.Workbook(),r=rd.addWorksheet('研发'),att=new ExcelJS.Workbook(),a=att.addWorksheet('考勤');for(const s of [r,a]){s.getRow(1).values=['人员',...Array.from({length:ts.monthDays(m)},(_,i)=>i+1)];for(let n=0;n<2;n++){s.getCell(2+n,1).value=['甲','乙'][n]!;for(let d=1;d<=ts.monthDays(m);d++)s.getCell(2+n,d+1).value=s===r?(d===1?2:0):'工作';}}const rs=await source('rd.xlsx',rd),as=await source('att.xlsx',att);return {month:m,templateId:t.id,rdId:rs.id,attendanceId:as.id,rdMapping:{sheet:'研发',startRow:2,personColumn:1,dateHeaderRow:1,dateStartColumn:2},attendanceMapping:{sheet:'考勤',startRow:2,personColumn:1,dateHeaderRow:1,dateStartColumn:2},requiredPeople:['甲','乙'],projects:['项目一','项目二'],assignments:{甲:['项目一'],乙:['项目一']},rdComplete:true};}
let runId=0,input:RunInput;
await test('28/29/30/31天日期星期、尾部清空及完整汇总',async()=>{for(const m of ['2026-02','2028-02','2026-09','2026-10']){const i=await simpleInput(m),r=await ts.createTimesheetRun(i);assert.equal(r.issues.length,0);const b=new ExcelJS.Workbook();await b.xlsx.load(await ts.exportTimesheet(r.id) as never);const s=b.getWorksheet('工时明细表（填写）')!;assert.equal(s.getCell(3,8+ts.monthDays(m)).value instanceof Date,true);for(let d=1;d<=31;d++){const v=s.getCell(3,8+d).value;if(d<=ts.monthDays(m)){assert.equal((v as Date).toISOString().slice(0,7),m);assert.equal(s.getCell(4,8+d).text,'星期'+'日一二三四五六'[new Date(`${m}-${String(d).padStart(2,'0')}T00:00:00Z`).getUTCDay()]);}else assert.equal(v,null);}assert.equal(r.personTotals['甲'],ts.monthDays(m)*8-2);input=i;runId=r.id;}});
await test('局部手改与项目分配保留，人员和新项目行可增加',async()=>{const r=await tw.applyTimesheetEdit(runId,{overrides:[{person:'甲',date:input.month+'-02',status:'work',hours:5,project:'项目二',source:'用户确认本日调整'}]});const next=await tw.applyTimesheetEdit(r.id,{allocations:[{person:'乙',date:input.month+'-03',shares:{项目一:2,项目二:6},reason:'用户重新分配项目'}]});assert.equal(next.personTotals['甲'],input.month==='2026-10'?243:0);assert.equal(next.days.find(d=>d.person==='甲'&&d.date.endsWith('-02'))?.department,5);await assert.rejects(()=>tw.applyTimesheetEdit(next.id,{allocations:[{person:'乙',date:input.month+'-03',shares:{项目一:9},reason:'错误修改'}]}),/总工时/);const b=new ExcelJS.Workbook();await b.xlsx.load(await ts.exportTimesheet(next.id) as never);assert.ok(ts.departmentLayout(b,input.month).rows.some(r=>r.person==='甲'&&r.project==='项目二'));});
await test('满工时与扣薪例外独立于星期，研发优先',async()=>{const i=await simpleInput('2026-09');const r=await ts.createTimesheetRun({...i,payroll:{fullPay:true,workdays:[1,2,20],deductions:{'甲|2026-09-02':3}}});assert.equal(r.personTotals['甲'],19);assert.equal(r.personTotals['乙'],22);assert.equal(r.days.find(d=>d.person==='甲'&&d.date==='2026-09-20')?.department,8);});
await test('文件真实格式检查，未知来源不能伪装为空表成功',async()=>{await assert.rejects(()=>ts.storeTimesheetSource('bad.xlsx',Buffer.from('not a workbook')));const wb=template();wb.getWorksheet('封面')!.getCell('E8').value=9;const sourceFile=await source('weekday.xlsx',wb);const profile=await tw.inspectTimesheetSource(sourceFile.id,'2026-09','rd');assert.ok(profile.messages.some(m=>m.startsWith('1日')));});
await test('满工时防止无依据减时，扣薪重新计算不残留旧覆盖',async()=>{
 const i={...await simpleInput('2026-09'),payroll:{fullPay:true,workdays:[1,2,3],deductions:{'甲|2026-09-02':3}}};
 const r=await ts.createTimesheetRun(i),next=await tw.applyTimesheetEdit(r.id,{deductions:{'甲|2026-09-02':1},reason:'用户明确本日只扣1小时'});
 assert.equal(next.days.find(d=>d.person==='甲'&&d.date==='2026-09-02')?.department,7);
 const bad=await tw.applyTimesheetEdit(next.id,{overrides:[{person:'乙',date:'2026-09-03',status:'work',hours:5,source:'无扣薪调整'}]});
 assert.ok(bad.issues.some(i=>i.code==='PAID_DAY_TOTAL'));assert.equal(bad.canFinalize,false);
});
let ledgerBytes:Buffer,workForm:Buffer,superForm:Buffer;
if(real){
 const dir=join(sourceRoot,'工时表需求调研交接','01_案例_2026年09月'),find=(prefix:string)=>join(dir,readdirSync(dir).find(n=>n.startsWith(prefix))!);
 await test('真实9月研发、员工和外包输入副本生成财务Excel',async()=>{
  const t=await ts.storeTimesheetSource('9月部门参考.xlsx',readFileSync(find('05_'))),r=await ts.storeTimesheetSource('9月研发.xlsx',readFileSync(find('01_'))),a=await ts.storeTimesheetSource('员工.xlsx',readFileSync(resolve('.tmp/monthly-upgrade/real-inputs/员工-normalized.xlsx'))),x=await ts.storeTimesheetSource('外包.xlsx',readFileSync(resolve('.tmp/monthly-upgrade/real-inputs/外包-normalized.xlsx')));
  const templateProfile=await tw.inspectTimesheetSource(t.id,'2026-09','template'),rd=await tw.inspectTimesheetSource(r.id,'2026-09','rd'),att=await tw.inspectTimesheetSource(a.id,'2026-09','attendance'),ext=await tw.inspectTimesheetSource(x.id,'2026-09','attendance');
  input={workbenchId:hoursWork.id,periodId:month(hoursWork.id).id,month:'2026-09',templateId:t.id,rdId:r.id,attendanceId:a.id,rdMapping:rd.mapping!,attendanceMapping:att.mapping!,attendanceSources:[{id:x.id,mapping:ext.mapping!}],requiredPeople:templateProfile.people,projects:templateProfile.projects!,assignments:templateProfile.assignments!,rdComplete:true,payroll:{fullPay:true,workdays:rd.workdays!,deductions:{}}};
  const result=await ts.createTimesheetRun(input);assert.equal(result.personTotals['康涛涛'],undefined);assert.equal(Object.keys(result.personTotals).length,13);assert.equal(result.days.reduce((s,d)=>s+d.rd,0),845);assert.equal(Object.values(result.personTotals).reduce((s,h)=>s+h,0),1443);assert.ok(result.issues.every(i=>i.code==='PROJECT_REMARK'));writeFileSync(join(outDir,'project-questions.json'),JSON.stringify(result.issues,null,2));runId=result.id;
  writeFileSync(join(outDir,'9月工时-真实输入验证.xlsx'),await ts.exportTimesheet(runId));
  const added=await tw.applyTimesheetEdit(runId,{peopleToAdd:['康涛涛'],assignments:{康涛涛:[input.projects[0]!]}});assert.equal(Object.keys(added.personTotals).length,14);assert.ok(added.days.some(d=>d.person==='康涛涛'));assert.equal(tw.timesheetPreferences(hoursWork.id).value.people.includes('康涛涛'),true);
 });
 const base=join(sourceRoot,'清廉工程需求调研交接','01_月度-监督检查与表册报送');ledgerBytes=readFileSync(join(base,'年度台账','2026年廉政监督员日常监督工作台账.xlsx'));workForm=readFileSync(join(base,'空白模板','附件1：清廉工程监督检查工作记录表.xlsx'));superForm=readFileSync(join(base,'空白模板','附件3：“清廉工程”廉政监督情况表（数科公司）.xlsx'));
}else{
 const b=new ExcelJS.Workbook(),s=b.addWorksheet('项目甲');s.getRow(2).values=['序号','时间','监督事项','监督方式','具体内容','发现问题','整改情况','备注'];s.getRow(3).values=[1,'2026.8.20','历史事项','资料检查','历史内容','历史问题','',''];ledgerBytes=Buffer.from(await b.xlsx.writeBuffer());
 const w=new ExcelJS.Workbook(),ws=w.addWorksheet('Sheet1');ws.getCell('A4').value='检查内容';ws.getCell('A5').value='检查结果';workForm=Buffer.from(await w.xlsx.writeBuffer());const f=new ExcelJS.Workbook();f.addWorksheet('Sheet1').getCell('C5').value='廉政监督情况记录';superForm=Buffer.from(await f.xlsx.writeBuffer());
}
const pid=month(checksWork.id).id;let firstId='',secondId='',docId='';
await test('导入原年度台账保留项目与历史，支持一项目一月多条及两条小微权力',async()=>{
 const v=await ledger.importAnnualLedger(pid,'年度台账.xlsx',ledgerBytes);assert.ok(v.entries.length>0);await ledger.setLedgerTemplate(pid,'work','work.xlsx',workForm);await ledger.setLedgerTemplate(pid,'supervision','supervision.xlsx',superForm);
 const project=v.projects[0]!;for(let n=0;n<2;n++){const e=await ledger.addLedgerEntry(pid,{project,inspection_date:'2026-09-21',subject:'隔离验收事项'+n,content:'根据本次提供资料核对实际内容'+n,findings:'待核对具体问题',small_power:'yes',supervisor:'测试监督员',supervised_unit:'测试单位'});if(n===0)firstId=e.id;else secondId=e.id;}
 const updated=await ledger.ledgerView(pid);assert.equal(updated.smallPower,2);assert.equal(updated.entries.filter(e=>e.fields.inspection_date==='2026-09-21').length,2);assert.equal((await ledger.syncAnnualLedger(pid)).synced,true);
});
await test('两个实际表格使用正确业务映射与稳定关联，未知事实不补成无问题',async()=>{const generated=await ledger.generateLedgerForms(pid,firstId);assert.equal(generated.documents.length,2);for(const d of generated.documents){const b=new ExcelJS.Workbook();await b.xlsx.load(readFileSync(d.path) as never);assert.ok(b.getWorksheet('_workbench_link'));const s=b.worksheets[0]!;if(d.kind==='work')assert.equal(s.getCell('B4').text,'隔离验收事项0');else{assert.equal(s.getCell('C6').text,'根据本次提供资料核对实际内容0');docId=d.id;}writeFileSync(join(outDir,d.kind+'.xlsx'),readFileSync(d.path));}});
await test('外部修改只更新正确记录，联动另一表，格式签字不成为业务字段',async()=>{const d=ledger.ledgerDocument(pid,docId),b=new ExcelJS.Workbook();await b.xlsx.load(readFileSync(d.path) as never);b.worksheets[0]!.getCell('C6').value='外部修改：仅更新第一条';b.worksheets[0]!.getCell('C6').font={bold:true};writeFileSync(d.path,Buffer.from(await b.xlsx.writeBuffer()));const sync=await ledger.syncAnnualLedger(pid);assert.equal(sync.synced,true,JSON.stringify(sync));const view=await ledger.ledgerView(pid);assert.equal(view.entries.find(e=>e.id===firstId)!.fields.content,'外部修改：仅更新第一条');assert.equal(view.entries.find(e=>e.id===secondId)!.fields.content,'根据本次提供资料核对实际内容1');assert.equal((await ledger.inspectLedgerChanges(pid)).changes.length,0);});
await test('同字段冲突展示差异，陈旧选择被拒绝，历史版本保留',async()=>{const view=await ledger.ledgerView(pid),e=view.entries.find(e=>e.id===firstId)!;await ledger.patchLedgerEntry(pid,e.id,e.revision,{content:'页面修改'});const d=ledger.ledgerDocument(pid,docId),b=new ExcelJS.Workbook();await b.xlsx.load(readFileSync(d.path) as never);b.worksheets[0]!.getCell('C6').value='文件另一份修改';writeFileSync(d.path,Buffer.from(await b.xlsx.writeBuffer()));const conflict=await ledger.syncAnnualLedger(pid);assert.equal(conflict.synced,false);assert.ok(conflict.conflicts.length);await assert.rejects(()=>ledger.syncAnnualLedger(pid,{},'stale'),/再次|又有变化/);const resolved=await ledger.syncAnnualLedger(pid,{[`${e.id}.content`]:docId},conflict.token);assert.equal(resolved.synced,true);ledger.freezeLedgerDocument(pid,docId,'signed');const frozen=ledger.ledgerDocument(pid,docId),bytes=readFileSync(frozen.path);const fresh=(await ledger.ledgerView(pid)).entries.find(e=>e.id===firstId)!;await ledger.patchLedgerEntry(pid,e.id,fresh.revision,{content:'后续修改'});await ledger.generateLedgerForms(pid,e.id);assert.deepEqual(readFileSync(frozen.path),bytes);assert.ok(db.all('SELECT * FROM ledger_entry_version').length>0);});
await test('无日期草稿归属本月；季度年度引用台账并排除待确认事实',async()=>{
 const v=await ledger.ledgerView(pid),draft=await ledger.addLedgerEntry(pid,{project:v.projects[0],subject:'无日期草稿',small_power:'yes'});
 assert.equal(draft.fields.inspection_date,'');assert.equal(draft.month,'2026-09');
 let e=v.entries.find(e=>e.id===secondId)!;await ledger.patchLedgerEntry(pid,e.id,e.revision,{},true);await ledger.syncAnnualLedger(pid);
 const evidence=await import('../src/domain/business-evidence.ts'),scope={workbenchId:checksWork.id,start:'2026-07-01',end:'2026-10-01'};
 const pack=await evidence.collectBusinessEvidence(scope);assert.equal(pack.metrics.inspections,1);assert.ok(pack.sources.some(s=>s.table==='ledger_entry'));
 e=(await ledger.ledgerView(pid)).entries.find(e=>e.id===secondId)!;await ledger.patchLedgerEntry(pid,e.id,e.revision,{content:'尚未重新确认的更新'});
 assert.ok(evidence.evidenceChanges(pack).length);assert.equal((await evidence.collectBusinessEvidence(scope)).metrics.inspections,0);
});
await test('模拟模型建议经真实接口应用，数据与导出更新，错误响应保留原稿',async()=>{
 const providers=await import('../src/ai/providers.ts'),original=globalThis.fetch;
 const provider=providers.upsertProvider({code:'monthly-mock',name:'隔离模拟',base_url:'http://127.0.0.1:19192/v1',enabled:1});providers.upsertProfile({purpose:'writing',name:'隔离模拟',provider_id:provider,model:'monthly-mock'});
 let content=JSON.stringify({overrides:[{person:'甲',date:'2026-10-02',status:'work',hours:4,project:'项目二',source:'用户明确修改'}],reason:'模拟模型响应'});
 let lastPrompt='';
 globalThis.fetch=async(_url,init)=>{lastPrompt=JSON.parse(String(init?.body)).messages.at(-1).content;return new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}),{status:200});};
 const app=(await import('fastify')).default();(await import('../src/api/routes-timesheets.ts')).registerTimesheetRoutes(app);(await import('../src/api/routes-ledger.ts')).registerLedgerRoutes(app);
 try{
  const r=await ts.createTimesheetRun(await simpleInput('2026-10'));
  const response=await app.inject({method:'POST',url:`/api/timesheets/${r.id}/suggest`,payload:{instruction:'甲2日部门4小时，项目二'}});assert.equal(response.statusCode,200,response.body);
  const patch=response.json().data.patch,applied=await app.inject({method:'POST',url:`/api/timesheets/${r.id}/edit`,payload:patch});assert.equal(applied.statusCode,200,applied.body);
  const result=applied.json().data;assert.equal(result.days.find((d:any)=>d.person==='甲'&&d.date==='2026-10-02').department,4);
  const file=await app.inject({method:'GET',url:`/api/timesheets/${result.id}/export`});assert.equal(file.statusCode,200);const b=new ExcelJS.Workbook();await b.xlsx.load(file.rawPayload as never);assert.ok(b.worksheets.length);
  await ledger.syncAnnualLedger(pid);const e=(await ledger.ledgerView(pid)).entries.find(e=>e.id===secondId)!;
  content=JSON.stringify({fields:{content:'依据用户资料补齐的模拟表述'},reason:'模拟模型，仅验证接口'});
  const suggestion=await ledger.suggestLedgerEntry(pid,e.id,e.revision,'补齐表述');assert.equal(suggestion.fields.content,'依据用户资料补齐的模拟表述');
  await ledger.suggestLedgerEntry(pid,e.id,e.revision,'只改内容',{fields:{content:'尚未保存的输入'},allowedFields:['content'],includeHistory:false});
  assert.equal(JSON.parse(lastPrompt).current.content,'尚未保存的输入');assert.deepEqual(JSON.parse(lastPrompt).history,[]);
  await assert.rejects(()=>ledger.suggestLedgerEntry(pid,e.id,e.revision,'限定备注',{allowedFields:['remarks']}),/字段|范围/);
  assert.equal((await ledger.ledgerView(pid)).entries.find(x=>x.id===e.id)!.fields.content,e.fields.content);
  await ledger.patchLedgerEntry(pid,e.id,e.revision,suggestion.fields);await ledger.syncAnnualLedger(pid);
  content='bad json';await assert.rejects(()=>tw.suggestTimesheetEdit(result.id,'修改'),/有效修改/);
 }finally{globalThis.fetch=original;await app.close();}
});
await test('生成拒绝陈旧修订；部分失败保留成功文件，仅重试指定失败项',async()=>{
 const e=(await ledger.ledgerView(pid)).entries.find(e=>e.id===secondId)!;
 await assert.rejects(()=>ledger.generateLedgerForms(pid,e.id,{revision:e.revision-1}),/草稿已变化/);
 const row=db.get<{metadata:string}>('SELECT metadata FROM annual_ledger LIMIT 1')!,templatePath=JSON.parse(row.metadata).templates.supervision;
 const original=readFileSync(templatePath);let successPath='';
 try{writeFileSync(templatePath,'invalid workbook');const r=await ledger.generateLedgerForms(pid,e.id,{revision:e.revision});assert.deepEqual(r.results.map(r=>r.status),['success','failed']);successPath=r.results[0]!.document!.path;assert.ok(readFileSync(successPath).length);}finally{writeFileSync(templatePath,original);}
 const before=readFileSync(successPath),r=await ledger.generateLedgerForms(pid,e.id,{revision:e.revision,kinds:['supervision']});assert.equal(r.results.length,1);assert.equal(r.results[0]!.status,'success');assert.equal(r.documents[0]!.kind,'supervision');assert.deepEqual(readFileSync(successPath),before);
 const file=r.documents[0]!,book=new ExcelJS.Workbook();await book.xlsx.load(readFileSync(file.path) as never);book.worksheets[0]!.getCell('C6').value='未采用的外部修改';writeFileSync(file.path,Buffer.from(await book.xlsx.writeBuffer()));
 const scan=await ledger.inspectLedgerChanges(pid);await ledger.syncAnnualLedger(pid,{[`${e.id}.content`]:'database'},scan.token);
 const restored=new ExcelJS.Workbook();await restored.xlsx.load(readFileSync(file.path) as never);assert.equal(restored.worksheets[0]!.getCell('C6').text,e.fields.content);
});
await test('模拟文件写入失败返回逐对象结果，重新读取后完成剩余写入',async()=>{
 const view=await ledger.ledgerView(pid),e=view.entries.find(e=>e.id===secondId)!,target=view.documents.find(d=>d.entry_id===secondId&&d.kind==='supervision'&&d.state==='editable')!;
 await ledger.patchLedgerEntry(pid,e.id,e.revision,{content:'验证逐对象同步结果'});
 const rename=fs.renameSync;fs.renameSync=(from,to)=>{if(String(to)===target.path)throw Error('模拟文件占用');return rename(from,to);};syncBuiltinESMExports();
 try{const result=await ledger.syncAnnualLedger(pid);assert.equal(result.synced,false);assert.ok(result.operationId);assert.equal(result.results?.find(r=>r.id===target.id)?.status,'failed');assert.equal(result.results?.find(r=>r.id==='ledger')?.status,'updated');assert.match(result.error??'',/模拟文件占用/);}finally{fs.renameSync=rename;syncBuiltinESMExports();}
 const scan=await ledger.inspectLedgerChanges(pid),result=await ledger.syncAnnualLedger(pid,{},scan.token);assert.equal(result.synced,true);assert.ok(result.results?.every(r=>['updated','unchanged'].includes(r.status)));
});
await test('丢失关联的旧文件拒绝猜测写回，外键完整',async()=>{const view=await ledger.ledgerView(pid),d=view.documents.find(d=>d.state==='editable'&&d.kind==='supervision')!,b=new ExcelJS.Workbook();await b.xlsx.load(readFileSync(d.path) as never);b.removeWorksheet('_workbench_link');writeFileSync(d.path,Buffer.from(await b.xlsx.writeBuffer()));const scan=await ledger.syncAnnualLedger(pid);assert.equal(scan.synced,false);assert.ok(scan.issues.some(s=>s.includes('关联')));assert.equal(db.all('PRAGMA foreign_key_check').length,0);});
writeFileSync(join(outDir,'verification.json'),JSON.stringify({date:'2026-10-21',realInputs:real,tests:outcomes},null,2));console.log(`${outcomes.length} checks passed; ${real?'real input':'anonymous'} outputs: ${outDir}`);
