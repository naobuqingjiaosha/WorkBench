import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
mkdirSync(resolve('.tmp'),{recursive:true});
const root = process.env.WORKBENCH_ISOLATION_ROOT!;
process.env.WORKBENCH_TEST_MODE='1';
const {bootstrap}=await import('../src/core/bootstrap.ts');bootstrap();
const db=await import('../src/db/index.ts'),s=await import('../src/domain/service.ts'),p=await import('../src/domain/periods.ts'),ts=await import('../src/domain/timesheets.ts');
const {INTEGRITY_TYPES}=await import('../src/domain/integrity-config.ts');
const {saveArtifact,artifactAbsPath}=await import('../src/core/store.ts');
const {collectWorkContext}=await import('../src/domain/work-context.ts');
const {reviewProjectMaterial}=await import('../src/domain/workflow.ts');
const {dossierReadiness}=await import('../src/domain/dossier.ts');
const {generateVariables,saveGeneratedDocument}=await import('../src/domain/generate.ts');
const app=(await import('fastify')).default();await app.register((await import('@fastify/multipart')).default);
(await import('../src/api/routes-workflow.ts')).registerWorkflowRoutes(app);
(await import('../src/api/routes-timesheets.ts')).registerTimesheetRoutes(app);
const checks:string[]=[];
async function check(name:string,fn:()=>unknown|Promise<unknown>){await fn();checks.push(name);console.log('✓ '+name);}
async function request(method:'POST'|'PUT'|'GET',url:string,payload?:object,status=200){const r=await app.inject({method,url,payload});assert.equal(r.statusCode,status,r.body);return r.json().data;}
const type=(code:string)=>s.listWorkTypes().find(t=>t.code===code)!;
const work=(code:string,firstPeriod='2026-Q3')=>s.createWorkbench({name:`模拟验收 ${type(code).name}`,workTypeId:type(code).id,firstPeriod});
const period=(id:number,key:string)=>p.listPeriods(id).find(x=>x.report_period===key)!;
async function provide(pid:number,title:string,text='匿名模拟材料，不代表真实业务结论'){
 const q=p.requirePeriod(pid),w=s.getWorkbench(q.workbench_id)!;
 const m=await request('POST',`/api/periods/${pid}/materials`,{title},201);
 const a=await saveArtifact({data:text,dirAbs:s.workbenchOutputDirAbs(w,'source'),fileName:`模拟材料-${m.id}.txt`,kind:'source',title,workbenchId:w.id,dedupe:false});
 await request('PUT',`/api/periods/${pid}/materials/${m.id}`,{status:'provided',artifact_id:a.artifact.id});
 return {m,a};
}
try{
 await check('8项固定类型及通用临时事项可创建，材料和办理步骤有默认配置',()=>{assert.equal(INTEGRITY_TYPES.length,8);for(const t of INTEGRITY_TYPES){const w=work(t.code,t.frequency==='monthly'?'2026-07':t.frequency==='yearly'?'2026':'2026-Q3');if(t.frequency){assert.ok(p.listPeriods(w.id).length);assert.ok(JSON.parse(p.listPeriods(w.id)[0]!.steps).length);}else assert.ok(s.getWorkbenchDetail(w.id)!.positions[0]!.checklist.length);}assert.ok(type('integrity-temporary'));});
 const monthly=work('integrity-monthly-inspection','2026-07'),sep=period(monthly.id,'2026-09'),aug=period(monthly.id,'2026-08');
 await check('多份历史附件保留；旧步骤和附件不能替代检查记录及实际报送',async()=>{
  const first=await provide(sep.id,'第1次检查 / 检查记录','九月模拟检查第一份资料'),second=await provide(sep.id,'第1次检查 / 廉政监督表'),third=await provide(sep.id,'第2次检查 / 检查记录');
  assert.notEqual(first.m.id,second.m.id);assert.notEqual(second.m.id,third.m.id);
  assert.throws(()=>p.updatePeriod(sep.id,{status:'done'}),/检查记录/);
  p.updatePeriod(sep.id,{steps:JSON.parse(sep.steps).map((x:object)=>({...x,status:'done'}))});
  assert.throws(()=>p.updatePeriod(sep.id,{status:'done'}),/材料/);
  for(const m of db.all<{id:number;artifact_id:number|null}>('SELECT * FROM period_material WHERE period_id=?',[sep.id]))await request('PUT',`/api/periods/${sep.id}/materials/${m.id}`,m.artifact_id?{status:'verified',artifact_id:m.artifact_id}:{status:'na',note:'仅用于模拟结构验证，真实验收不得据此豁免'});
  assert.throws(()=>p.updatePeriod(sep.id,{status:'done'}),/检查草稿/);assert.equal(p.requirePeriod(aug.id).status,'open');
  renameSync(first.a.absPath,first.a.absPath+'.missing');assert.throws(()=>p.assertPeriodReady(sep.id),/丢失/);renameSync(first.a.absPath+'.missing',first.a.absPath);
  assert.equal(p.requirePeriod(sep.id).status,'open');
 });
 const meetings=['integrity-risk','integrity-study','integrity-project-review'].map(code=>{const w=work(code);return {w,q:period(w.id,'2026-Q3')};});
 await check('三项季度会议同日安排，独立资料、纪要、完成状态和跨工作保护',async()=>{
  for(const {q} of meetings){p.updatePeriod(q.id,{scheduled_date:'2026-09-21'});await provide(q.id,'独立会议记录');}
  const one=meetings[0]!,two=meetings[1]!,a=db.get<{artifact_id:number}>('SELECT artifact_id FROM period_material WHERE period_id=? AND artifact_id IS NOT NULL',[one.q.id])!;
  const m=db.get<{id:number}>('SELECT id FROM period_material WHERE period_id=?',[two.q.id])!;
  await request('PUT',`/api/periods/${two.q.id}/materials/${m.id}`,{status:'verified',artifact_id:a.artifact_id},400);
  p.updatePeriod(one.q.id,{steps:JSON.parse(one.q.steps).map((x:object)=>({...x,status:'done'}))});
  for(const m of db.all<{id:number;artifact_id:number|null}>('SELECT * FROM period_material WHERE period_id=?',[one.q.id]))await request('PUT',`/api/periods/${one.q.id}/materials/${m.id}`,m.artifact_id?{status:'verified',artifact_id:m.artifact_id}:{status:'na',note:'匿名模拟不适用依据'});
  const fixtureZip=new PizZip();fixtureZip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');fixtureZip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');fixtureZip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>模拟会议纪要</w:t></w:r></w:p></w:body></w:document>');const meetingPath=join(root,'模拟会议.docx');writeFileSync(meetingPath,fixtureZip.generate({type:'nodebuffer'}));const mt=s.registerTemplate({name:'模拟会议纪要',absSourcePath:meetingPath,workTypeId:one.w.work_type_id});s.setBoundTemplateIds(one.w.id,[mt.id]);const md=await request('POST',`/api/periods/${one.q.id}/templates`,{});await request('POST',`/api/periods/${one.q.id}/templates`,{apply:true,expected:md});await saveGeneratedDocument({templateId:mt.id,workbenchId:one.w.id,periodId:one.q.id,values:{},saveMode:'final'});
  p.updatePeriod(one.q.id,{status:'done'});assert.equal(p.requirePeriod(two.q.id).status,'open');
 });
 const summary=work('integrity-quarter-summary'),summaryPeriod=period(summary.id,'2026-Q3');
 const selected=[aug.id,sep.id,...meetings.map(x=>x.q.id)];
 await provide(aug.id,'八月模拟记录','八月独立来源事实');
 await check('季度汇总由用户选择多个工作及月季期次，拒绝跨季度、跨分类且不递归串用',async()=>{
  await request('PUT',`/api/periods/${summaryPeriod.id}`,{source_period_ids:selected});
  const october=period(monthly.id,'2026-10');await request('PUT',`/api/periods/${summaryPeriod.id}`,{source_period_ids:[october.id]},400);
  const context=await collectWorkContext(summary.id,summaryPeriod.id);assert.match(context.text,/八月独立来源事实/);assert.match(context.text,/九月模拟检查第一份资料/);assert.doesNotMatch(context.text,/2026-10/);assert.equal(context.sourcePeriodIds.length,selected.length);
  const safety=s.createWorkbench({name:'其他分类',workTypeId:type('safety-report').id,firstPeriod:'2026-09'});assert.throws(()=>p.updatePeriod(summaryPeriod.id,{source_period_ids:[period(safety.id,'2026-09').id]}),/来源|分类/);
 });
 await check('主动AI生成使用实际选定来源并返回来源快照，修改后实际Word定稿可读',async()=>{
  const zip=new PizZip();zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{内容}</w:t></w:r></w:p></w:body></w:document>');
  const path=join(root,'模拟季度模板.docx');writeFileSync(path,zip.generate({type:'nodebuffer'}));const t=s.registerTemplate({absSourcePath:path,name:'模拟季度汇报模板',workTypeId:summary.work_type_id});s.setBoundTemplateIds(summary.id,[t.id]);
  const difference=(await request('POST',`/api/periods/${summaryPeriod.id}/templates`,{}));await request('POST',`/api/periods/${summaryPeriod.id}/templates`,{apply:true,expected:difference});
  const providers=await import('../src/ai/providers.ts');const provider=providers.upsertProvider({code:'phase2-mock',name:'模拟模型',base_url:'http://127.0.0.1:18791/v1',enabled:1});providers.upsertProfile({purpose:'writing',name:'模拟写作',provider_id:provider,model:'mock'});
  const original=globalThis.fetch;let sent='';globalThis.fetch=async(_url,init)=>{sent=String(init?.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({内容:'八月及九月模拟资料汇总',_依据:{内容:'模拟资料编号'}})},finish_reason:'stop'}]}),{headers:{'Content-Type':'application/json'}});};
  try{const draft=await generateVariables({templateId:t.id,workbenchId:summary.id,periodId:summaryPeriod.id,instruction:'按所选来源起草，不编造事实'});assert.ok(draft.ok);assert.match(sent,/八月独立来源事实/);assert.match(sent,/九月模拟检查第一份资料/);assert.equal(draft.evidence?.sourcePeriodIds.length,selected.length);
   const saved=await saveGeneratedDocument({templateId:t.id,workbenchId:summary.id,periodId:summaryPeriod.id,values:{内容:'人工核对后的匿名模拟汇报'},saveMode:'final'});const bytes=readFileSync(artifactAbsPath(saved.artifact));assert.match(new PizZip(bytes).file('word/document.xml')!.asText(),/人工核对/);writeFileSync(join(root,'模拟季度汇报定稿.docx'),bytes);
  }finally{globalThis.fetch=original;}
 });
 for(const code of ['software-project','integration-project'])await check(`${type(code).name}历史补录无需重走阶段，在办交付与缺材料均阻断归档`,async()=>{
  const historical=s.createWorkbench({name:`模拟历史 ${code}`,workTypeId:type(code).id,historical:true,actualEndDate:'2025-12-31'});
  assert.equal(dossierReadiness(historical.id).canArchive,false);
  for(const stage of s.getWorkbenchDetail(historical.id)!.positions)for(const item of stage.checklist){await saveArtifact({data:'模拟历史材料',dirAbs:s.workbenchOutputDirAbs(historical,'source'),fileName:`${item.id}.txt`,kind:'source',title:item.title,workbenchId:historical.id,positionCode:stage.code,checklistItemId:item.id});reviewProjectMaterial(item.id,{status:'verified'});}
  assert.ok(s.getWorkbenchDetail(historical.id)!.positions.every(x=>x.status!=='done'));assert.equal(dossierReadiness(historical.id).canArchive,true);assert.equal(s.recalcProgress(historical.id),100);s.archiveWorkbench(historical.id);
  const current=s.createWorkbench({name:`模拟在办 ${code}`,workTypeId:type(code).id});const stage=s.getWorkbenchDetail(current.id)!.positions[1]!;const todo=await request('POST','/api/quick-todos',{title:'模拟供应商交付',workbench_id:current.id,position_id:stage.id,kind:'delivery',owner:'模拟供应商',due_date:'2026-10-20'},201);
  await request('PUT',`/api/quick-todos/${todo.id}`,{note:'模拟核对：尚缺测试资料',owner:'模拟供应商乙',due_date:'2026-10-25'});const updated=db.get<{note:string;status:string}>('SELECT * FROM quick_todo WHERE id=?',[todo.id])!;assert.match(updated.note,/尚缺测试资料/);assert.equal(updated.status,'open');assert.throws(()=>s.completeWorkbench(current.id),/阶段/);assert.ok(dossierReadiness(current.id).missing.some(x=>x.includes('模拟供应商交付')));await request('PUT',`/api/quick-todos/${todo.id}`,{status:'done'});assert.ok(dossierReadiness(current.id).missing.length);
 });
 await check('整月全员、多项目自动均分、研发优先、考勤及人工调整、实际Excel逐格对账',async()=>{
  const people=['模拟甲','模拟乙','模拟丙'],projects=['项目甲','项目乙','项目丙'],month='2026-10',days=31;
  const b=new ExcelJS.Workbook(),sheet=b.addWorksheet('工时明细表（填写）');for(let d=1;d<=days;d++){sheet.getCell(3,8+d).value={formula:`DATE(2026,10,${d})`,result:new Date(Date.UTC(2026,9,d))};sheet.getCell(3,8+d).numFmt='m/d/yy';sheet.getCell(4,8+d).value='星期一';}sheet.getCell('C3').value='人员';sheet.mergeCells('C3:C4');sheet.getCell('D3').value='工时类型';sheet.mergeCells('D3:D4');sheet.getCell('E3').value='项目名称';sheet.mergeCells('E3:E4');sheet.getCell(3,40).value=new Date(Date.UTC(2026,8,30));sheet.getCell(4,40).value='星期三';
  let row=5;for(const person of people)for(const project of projects){sheet.getCell(row,3).value=person;sheet.getCell(row,4).value='服务工时';sheet.getCell(row,5).value=project;sheet.getCell(row,40).value={formula:`SUM(I${row}:AM${row})`,result:0};row++;}
  const template=await ts.storeTimesheetSource('模拟部门模板.xlsx',Buffer.from(await b.xlsx.writeBuffer()));
  const rb=new ExcelJS.Workbook(),rs=rb.addWorksheet('研发');rs.addRow(['人员','日期','小时']);rs.addRow([people[0],'2026-10-01',2]);const rd=await ts.storeTimesheetSource('模拟研发.xlsx',Buffer.from(await rb.xlsx.writeBuffer()));
  const ab=new ExcelJS.Workbook(),as=ab.addWorksheet('考勤');as.addRow(['人员','日期','状态','项目']);for(const person of people)for(let d=1;d<=days;d++)as.addRow([person,`${month}-${String(d).padStart(2,'0')}`,d===2?'休息':'工作',d===3?'项目乙':'']);const attendance=await ts.storeTimesheetSource('模拟考勤.xlsx',Buffer.from(await ab.xlsx.writeBuffer()));
  const input:import('../src/domain/timesheets.ts').RunInput={month,templateId:template.id,rdId:rd.id,attendanceId:attendance.id,rdMapping:{sheet:'研发',startRow:2,personColumn:1,dateColumn:2,hoursColumn:3},attendanceMapping:{sheet:'考勤',startRow:2,personColumn:1,dateColumn:2,statusColumn:3,projectColumn:4},projects,requiredPeople:people,assignments:Object.fromEntries(people.map(p=>[p,projects])),rdComplete:true};
  const result=await request('POST','/api/timesheets',input,201) as Awaited<ReturnType<typeof ts.createTimesheetRun>>;assert.deepEqual(result.issues,[]);assert.equal(result.days.filter(d=>d.person===people[0]&&d.date==='2026-10-01').reduce((s,d)=>s+d.department,0),6);
  assert.equal(result.days.find(d=>d.person===people[0]&&d.date==='2026-10-01')?.department,2);assert.equal(result.projectTotals['项目丙']!>0,true);assert.equal(result.personTotals[people[0]!]!,238);assert.equal(result.personTotals[people[1]!]!,240);
  const bad=await ts.createTimesheetRun({...input,requiredPeople:[...people,'漏填员工']});assert.ok(bad.issues.some(i=>i.code==='PERSON_ROW_MISSING'));assert.equal(bad.canFinalize,false);
  const adjusted=await ts.createTimesheetRun({...input,overrides:[{person:people[0]!,date:'2026-10-01',status:'work',project:'项目甲',hours:1.5,source:'模拟半天活动核对依据'}]});assert.equal(adjusted.days.find(d=>d.person===people[0])?.department,1.5);assert.equal(ts.getTimesheetRun(result.id).result.personTotals[people[0]!],238);
  const bytes=await ts.exportTimesheet(result.id);writeFileSync(join(root,'模拟部门全员整月.xlsx'),bytes);const out=new ExcelJS.Workbook();await out.xlsx.load(bytes as never);const os=out.getWorksheet(sheet.name)!;assert.ok(os.getCell('I3').value instanceof Date);assert.equal((os.getCell('I3').value as Date).toISOString().slice(0,10),'2026-10-01');assert.equal(os.getCell(3,40).text,'合计');assert.equal(os.getCell(4,40).text,'--');
  for(let r=5;r<14;r++){let expected=0;for(let d=1;d<=days;d++){const date=`${month}-${String(d).padStart(2,'0')}`,allocation=result.days.find(v=>v.person===os.getCell(r,3).text&&v.project===os.getCell(r,5).text&&v.date===date)?.department??0;assert.equal(os.getCell(r,8+d).value??0,allocation);expected+=allocation;}assert.ok(Math.abs(Number(os.getCell(r,40).result)-expected)<1e-8);}
  assert.deepEqual((await ts.readSource(template.id)).source.digest,template.digest);
 });
 await check('历史补录结束日期未知可留空，不能填造历史日期',()=>{const w=s.createWorkbench({name:'未知结束日期的历史项目',workTypeId:type('software-project').id,historical:true});assert.equal(w.status,'done');assert.equal(w.actual_end_date,null);assert.equal(w.start_date,null);});
 await check('扫描PDF兜底抽取拒绝无法识别的二进制并保持有界处理',async()=>{const {extractPdfLoose}=await import('../src/core/extract.ts');const r=extractPdfLoose(Buffer.from('['+'\\'.repeat(100000)));assert.equal(r.ok,false);});
 await check('数据库重开后期次步骤、日期、来源范围及材料持久保留，外键和完整性通过',()=>{
  db.closeDatabase();db.initDatabase(process.env.WORKBENCH_DB!);assert.equal(p.requirePeriod(meetings[1]!.q.id).scheduled_date,'2026-09-21');assert.equal(JSON.parse(p.requirePeriod(summaryPeriod.id).source_period_ids).length,selected.length);assert.equal(db.all('PRAGMA foreign_key_check').length,0);assert.equal(Object.values(db.get('PRAGMA integrity_check')!)[0],'ok');
 });
 writeFileSync(join(root,'验证记录.json'),JSON.stringify({kind:'anonymous simulated validation',checks,root},null,2));writeFileSync(resolve('.tmp/phase2-validation-latest.json'),JSON.stringify({root,checks:checks.length},null,2));console.log(`第二阶段模拟业务验证 ${checks.length} 场景通过：${root}`);
}finally{await app.close();db.closeDatabase();}
