import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';

mkdirSync(resolve('.tmp'),{recursive:true});
const root = process.env.WORKBENCH_ISOLATION_ROOT!;


process.env.WORKBENCH_TEST_MODE='1';
const {bootstrap}=await import('../src/core/bootstrap.ts');bootstrap();
const {get,all,run,closeDatabase}=await import('../src/db/index.ts');
const s=await import('../src/domain/service.ts');
const p=await import('../src/domain/periods.ts');
const wf=await import('../src/domain/workflow.ts');
const ts=await import('../src/domain/timesheets.ts');
const {dossierReadiness}=await import('../src/domain/dossier.ts');
const {collectWorkContext}=await import('../src/domain/work-context.ts');
const {saveArtifact,artifactAbsPath,getArtifact}=await import('../src/core/store.ts');
const {saveGeneratedDocument,generateVariables}=await import('../src/domain/generate.ts');
const {resolvePeriodKey}=await import('../src/domain/versions.ts');
const app=(await import('fastify')).default();
await app.register((await import('@fastify/multipart')).default);
(await import('../src/api/routes-core.ts')).registerCoreRoutes(app);
(await import('../src/api/routes-work.ts')).registerWorkRoutes(app);
(await import('../src/api/routes-workflow.ts')).registerWorkflowRoutes(app);
(await import('../src/api/routes-timesheets.ts')).registerTimesheetRoutes(app);
(await import('../src/api/routes-template.ts')).registerTemplateRoutes(app);
(await import('../src/api/routes-files.ts')).registerFileRoutes(app);
const checks:string[]=[];
async function check(name:string,fn:()=>unknown|Promise<unknown>){await fn();checks.push(name);console.log('✓ '+name);}
const request=async(method:'POST'|'PUT',url:string,payload:object,status=200)=>{const r=await app.inject({method,url,payload});assert.equal(r.statusCode,status,r.body);return r.json().data;};
try{
 const created=await request('POST','/api/work-types',{code:'business-admin-stage',name:'行政排查',domain:'admin',category:'安全管理',mode:'process'},201);
 const adminStageType=created.id;
 const stage=await request('POST','/api/position-templates',{workTypeId:adminStageType,code:'inspect',name:'排查',seq:1,folderName:'排查资料'},201);
 s.upsertMaterial({position_template_id:stage.id,name:'检查记录'});
 const a=s.createWorkbench({name:'阶段式行政甲',workTypeId:adminStageType}),b=s.createWorkbench({name:'阶段式行政乙',workTypeId:adminStageType});
 const ap=s.getWorkbenchDetail(a.id)!.positions[0]!,bp=s.getWorkbenchDetail(b.id)!.positions[0]!;
 await check('阶段式行政按领域分组、使用 A 编号并创建阶段',async()=>{assert.match(a.code,/-A-/);assert.equal(ap.code,'inspect');const count=(await app.inject('/api/workbenches/count')).json().data;assert.equal(count.admin,2);assert.equal(count.project,0);assert.equal(s.listWorkbenches().find(w=>w.id===a.id)?.work_type_mode,'process');});
 await check('重复新增类型、阶段返回冲突且不覆盖原配置',async()=>{await request('POST','/api/work-types',{code:'business-admin-stage',name:'误覆盖'},409);await request('POST','/api/position-templates',{workTypeId:adminStageType,code:'inspect',name:'误覆盖'},409);assert.equal(s.getWorkType(adminStageType)?.name,'行政排查');assert.equal(s.getPosition(stage.id)?.name,'排查');});
 await check('阶段按 ID 编辑顺序与名称，不增行也不丢清单',async()=>{await request('PUT',`/api/position-templates/${stage.id}`,{name:'现场排查',seq:3});assert.equal(s.listPositions(adminStageType).length,1);assert.equal(s.getPosition(stage.id)?.seq,3);assert.equal(s.getPosition(stage.id)?.materials.length,1);assert.equal(ap.name,'排查');await request('PUT',`/api/position-templates/${stage.id}`,{code:'new-code'},409);});
 await check('实例目录与期次目录独立，规范修改不影响既有实例',()=>{s.setPositionFolderName(ap.id,'甲的材料');s.setPositionPeriodDir(ap.id,'{yyyy}\\{mm}月');assert.notEqual(s.getWorkbenchDetail(a.id)!.positions[0]!.stage_abs,s.getWorkbenchDetail(b.id)!.positions[0]!.stage_abs);assert.equal(s.getPosition(stage.id)?.folder_name,'排查资料');assert.equal(s.getWorkbenchDetail(bp.workbench_id??b.id)!.positions[0]!.period_dir,null);s.upsertPosition({id:stage.id,work_type_id:adminStageType,code:'inspect',name:'现场排查',folder_name:'新默认目录'});assert.match(s.getWorkbenchDetail(b.id)!.positions[0]!.stage_abs,/排查资料$/);assert.ok(resolvePeriodKey({workbenchId:a.id,positionCode:'inspect'}));assert.equal(resolvePeriodKey({workbenchId:b.id,positionCode:'inspect'}),null);});
 await check('阶段与独立期次组合明确拒绝',()=>assert.throws(()=>p.savePeriodRule(a.id,{frequency:'monthly',first_period:'2026-10'}),/阶段/));
 const item=ap.checklist[0]!;
 const file=await saveArtifact({data:'匿名检查：已核实检查三次。',dirAbs:join(process.env.WORKBENCH_DATA_DIR!,a.folder_path),fileName:'检查.txt',kind:'source',title:'检查记录',workbenchId:a.id,checklistItemId:item.id});
 await check('提供、核对与结束阶段使用同一完成口径',()=>{s.updateChecklistItem(item.id,{status:'done'});assert.equal(s.recalcProgress(a.id),0);assert.throws(()=>s.completeWorkbench(a.id),/阶段/);wf.reviewProjectMaterial(item.id,{status:'verified'});assert.equal(s.recalcProgress(a.id),50);s.setPositionStatus(ap.id,'done');assert.equal(s.recalcProgress(a.id),100);s.completeWorkbench(a.id);});
 await check('实际文件丢失使办理进度和归档检查同时回退',()=>{renameSync(file.absPath,file.absPath+'.missing');assert.ok(s.recalcProgress(a.id)<100);assert.equal(dossierReadiness(a.id).canArchive,false);assert.throws(()=>s.archiveWorkbench(a.id),/文件丢失/);renameSync(file.absPath+'.missing',file.absPath);});
 await check('不适用阶段需依据且材料要求可按实例调整',async()=>{assert.throws(()=>s.setPositionStatus(bp.id,'skipped'),/原因/);const c=s.getWorkbenchDetail(b.id)!.positions[0]!.checklist[0]!;await request('PUT',`/api/checklist/${c.id}/requirement`,{required:false,reason:'本项目采用其他佐证'});assert.equal(s.getPosition(stage.id)?.materials[0]?.required,1);s.setPositionStatus(bp.id,'skipped',{note:'本次工作不开展现场排查'});s.completeWorkbench(b.id);});
 await check('浏览器通用上传真正关联材料清单，跨工作关联在写文件前拒绝',async()=>{
   const w=s.createWorkbench({name:'上传材料验收',workTypeId:adminStageType}),stage=s.getWorkbenchDetail(w.id)!.positions[0]!,item=stage.checklist[0]!;
   const upload=async(wid:number)=>{const boundary='business-upload';return app.inject({method:'POST',url:'/api/artifacts/upload',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="workbenchId"\r\n\r\n${wid}\r\n--${boundary}\r\nContent-Disposition: form-data; name="checklistItemId"\r\n\r\n${item.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.txt"\r\nContent-Type: text/plain\r\n\r\nanonymous evidence\r\n--${boundary}--\r\n`)});};
   const response=await upload(w.id);assert.equal(response.statusCode,201,response.body);const file=response.json().data.items[0];assert.equal(file.checklist_item_id,item.id);assert.equal(file.position_code,stage.code);
   wf.reviewProjectMaterial(item.id,{status:'verified'});s.setPositionStatus(stage.id,'done');s.completeWorkbench(w.id);
   const before=all('SELECT id FROM artifact').length;const rejected=await upload(a.id);assert.ok(rejected.statusCode>=400);assert.equal(all('SELECT id FROM artifact').length,before);
 });
 const docProject=s.upsertWorkType({code:'doc-project',name:'项目报告',domain:'project',category:'软件研发',mode:'document'});
 const simple=s.createWorkbench({name:'项目文书事务',workTypeId:docProject});
 await check('文书型项目按领域分组并使用 P 编号',async()=>{assert.match(simple.code,/-P-/);assert.equal((await app.inject('/api/workbenches/count')).json().data.project,1);});
 for(const [frequency,key] of [['monthly','2026-10'],['quarterly','2026-Q3'],['yearly','2026']] as const){
  await check(`${frequency} 类型默认规则创建独立期次并冻结材料要求`,()=>{const id=s.upsertWorkType({code:'period-'+frequency,name:frequency,domain:'admin',category:'部门综合管理',mode:'document',period_defaults:JSON.stringify({frequency,due_day:31,due_month_offset:0,requirements:['本期记录']})});const w=s.createWorkbench({name:frequency,workTypeId:id,firstPeriod:key});const period=p.listPeriods(w.id).find(x=>x.report_period===key)!;assert.ok(period);const snapshot=period.snapshot;s.upsertWorkType({id,code:'period-'+frequency,name:frequency,period_defaults:JSON.stringify({frequency,requirements:['新要求']})});assert.equal(p.requirePeriod(period.id).snapshot,snapshot);assert.equal(all('SELECT * FROM period_material WHERE period_id=?',[period.id]).length,1);});
 }
 await check('创建失败整体回滚，不残留半个工作',()=>{const before=all('SELECT id FROM workbench').length;assert.throws(()=>s.createWorkbench({name:'错误排期',workTypeId:docProject,periodRule:{frequency:'monthly',due_day:99}}),/范围/);assert.equal(all('SELECT id FROM workbench').length,before);});
 const software=s.listWorkTypes().find(t=>t.code==='software-project')!,integration=s.listWorkTypes().find(t=>t.code==='integration-project')!;
 const historical=s.createWorkbench({name:'已结束的软件项目（匿名）',workTypeId:software.id,historical:true,actualEndDate:'2025-12-31'}),integrated=s.createWorkbench({name:'集成项目（匿名）',workTypeId:integration.id});
 await check('软件研发与系统集成使用不同阶段，历史结束和档案状态分离',()=>{assert.notDeepEqual(s.getWorkbenchDetail(historical.id)?.positions.map(p=>p.name),s.getWorkbenchDetail(integrated.id)?.positions.map(p=>p.name));assert.equal(dossierReadiness(historical.id).businessStatus,'completed');assert.equal(dossierReadiness(historical.id).dossierStatus,'collecting');assert.throws(()=>s.archiveWorkbench(historical.id),/材料/);});
 const delivery=await request('POST','/api/quick-todos',{title:'供应商交付测试报告',kind:'delivery',owner:'匿名供应商',workbench_id:historical.id,due_date:'2026-10-20'},201);
 await check('供应商交付和协调事项有工作归属并参与归档检查',async()=>{for(const stage of s.getWorkbenchDetail(historical.id)!.positions){for(const item of stage.checklist){await saveArtifact({data:'匿名模拟历史材料，非实际业务事实',dirAbs:s.workbenchOutputDirAbs(historical,'source'),fileName:`历史-${item.id}.txt`,kind:'source',title:item.title,workbenchId:historical.id,checklistItemId:item.id,positionCode:stage.code});wf.reviewProjectMaterial(item.id,{status:'verified'});}}assert.ok(s.getWorkbenchDetail(historical.id)!.positions.every(p=>p.status!=='done'));assert.throws(()=>s.archiveWorkbench(historical.id),/交付|协调/);await request('PUT',`/api/quick-todos/${delivery.id}`,{status:'done'});assert.equal(dossierReadiness(historical.id).canArchive,true);s.archiveWorkbench(historical.id);s.unarchiveWorkbench(historical.id);assert.equal(s.getWorkbench(historical.id)?.status,'done');});
 const reportType=s.upsertWorkType({code:'source-report',name:'来源报告',domain:'admin',category:'安全管理',mode:'document'}),report=s.createWorkbench({name:'安全月报（匿名）',workTypeId:reportType});
 const zip=new PizZip();zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>报告期：{报告期} 记录：{内容}</w:t></w:r></w:p></w:body></w:document>');
 const templatePath=join(root,'匿名报告模板.docx');writeFileSync(templatePath,zip.generate({type:'nodebuffer'}));
 const template=s.registerTemplate({absSourcePath:templatePath,name:'匿名报告',workTypeId:reportType});
 s.setBoundTemplateIds(report.id,[template.id]);p.savePeriodRule(report.id,{frequency:'monthly',first_period:'2026-09',requirements:[]});const periods=p.syncPeriods(report.id,'2026-10-01'),sep=periods.find(p=>p.report_period==='2026-09')!,oct=periods.find(p=>p.report_period==='2026-10')!;
 const source=await saveArtifact({data:'本期事实：现场核实三次检查，没有新增问题。',dirAbs:join(process.env.WORKBENCH_DATA_DIR!,report.folder_path),fileName:'九月真实记录.txt',kind:'source',title:'九月检查',workbenchId:report.id});run('UPDATE artifact SET work_period_id=? WHERE id=?',[sep.id,source.artifact.id]);
 p.updatePeriod(sep.id,{content:'已核实本期三次检查'});p.updatePeriod(oct.id,{content:'十月事实不得进入九月'});
 await check('自动汇总材料正文及人工记录，明确隔离其他期次',async()=>{const context=await collectWorkContext(report.id,sep.id);assert.match(context.text,/现场核实三次/);assert.match(context.text,/已核实本期三次/);assert.doesNotMatch(context.text,/十月事实/);assert.equal(context.sources[0]?.id,source.artifact.id);});
 const providers=await import('../src/ai/providers.ts');const pid=providers.upsertProvider({code:'business-model',name:'匿名模拟',base_url:'http://127.0.0.1:18791/v1',enabled:1});providers.upsertProfile({purpose:'writing',name:'写作',provider_id:pid,model:'simulated'});
 const originalFetch=globalThis.fetch;let sent='';
 await check('AI 从本期业务证据生成可核对初稿，人工修改后生成 Word 定稿',async()=>{
  globalThis.fetch=async(url,init)=>{assert.equal(new URL(String(url)).hostname,'127.0.0.1');sent=String(init?.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({内容:'依据本期三次检查记录形成初稿',_依据:{内容:'九月真实记录.txt'}})},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'Content-Type':'application/json'}});};
  try{const draft=await generateVariables({templateId:template.id,workbenchId:report.id,periodId:sep.id,referenceArtifactIds:[source.artifact.id],instruction:'汇总本期检查记录'});assert.equal(draft.ok,true);assert.match(sent,/现场核实三次/);assert.doesNotMatch(sent,/十月事实不得/);const result=await saveGeneratedDocument({templateId:template.id,workbenchId:report.id,periodId:sep.id,values:{...draft.variables,内容:'人工核实：本期检查三次，无新增问题。'},saveMode:'final'});assert.ok(result.artifact.is_final);const xml=new PizZip(readFileSync(artifactAbsPath(result.artifact))).file('word/document.xml')!.asText();assert.match(xml,/人工核实/);writeFileSync(join(root,'已核实月报.docx'),readFileSync(artifactAbsPath(result.artifact)));p.updatePeriod(sep.id,{status:'done'});}finally{globalThis.fetch=originalFetch;}
 });
 await check('必备与可选模板分开，可选模板不阻断完成',()=>{s.setBoundTemplateIds(report.id,[template.id],[]);p.savePeriodRule(report.id,{frequency:'monthly',first_period:'2026-09',requirements:[]});const november=p.syncPeriods(report.id,'2026-11-01')[0]!;assert.equal(JSON.parse(november.snapshot).templates[0].required,false);p.updatePeriod(november.id,{status:'done'});assert.equal(p.requirePeriod(oct.id).status,'open');});
 await check('字段编辑前保留旧模板和旧映射，可以按历史版本下载',async()=>{const old=s.readTemplateVars(template);s.writeTemplateVars(template,{variables:[{name:'内容',required:true,type:'text',label:'人工核对'}]});const history=(await app.inject(`/api/templates/${template.id}/history`)).json().data.items;assert.ok(history.length);assert.equal((await app.inject(`/api/templates/${template.id}/history/${history[0].id}/file`)).statusCode,200);s.writeTemplateVars(s.getTemplate(template.id)!,old);});
 await check('历史项目可导入已有文书定稿，满足阶段要求后归档且不修改原件',async()=>{
   const type=s.upsertWorkType({code:'historical-results',name:'历史项目成果',domain:'project',category:'软件研发',mode:'process'});
   const t=s.registerTemplate({absSourcePath:templatePath,name:'验收报告',workTypeId:type}),stage=s.upsertPosition({work_type_id:type,code:'archive',name:'验收归档'});
   s.setPositionDocTemplates(stage,[{templateId:t.id,required:1}]);
   const w=s.createWorkbench({name:'有历史定稿的项目',workTypeId:type,historical:true,actualEndDate:'2025-12-31'}),position=s.getWorkbenchDetail(w.id)!.positions[0]!;
   const bytes=readFileSync(join(root,'已核实月报.docx')),before=readFileSync(templatePath);
   const boundary='historical-result';const fields={workbenchId:String(w.id),positionCode:position.code,templateId:String(t.id),final:'true',reviewed:'true'};
   const prefix=Object.entries(fields).map(([key,value])=>`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join('')+`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="history.docx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`;
   const response=await app.inject({method:'POST',url:'/api/artifacts/upload',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat([Buffer.from(prefix),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])});
   assert.equal(response.statusCode,201,response.body);assert.equal(response.json().data.items[0].is_final,1);s.setPositionStatus(position.id,'done');s.archiveWorkbench(w.id);assert.deepEqual(readFileSync(templatePath),before);assert.equal(s.getWorkbench(w.id)?.actual_end_date,'2025-12-31');
 });
 await check('周期工作的完成、整体结束、停止续期和归档构成闭环',()=>{
   const w=s.createWorkbench({name:'可结束的周期工作',workTypeId:docProject,periodRule:{frequency:'monthly',due_day:31,requirements:[]}});
   assert.throws(()=>p.closePeriodSeries(w.id),/期次/);for(const period of p.listPeriods(w.id))p.updatePeriod(period.id,{status:'done'});
   const before=p.listPeriods(w.id).length;p.closePeriodSeries(w.id);assert.equal(p.syncPeriods(w.id,'2028-12-31').length,before);assert.equal(dossierReadiness(w.id).canArchive,true);s.archiveWorkbench(w.id);s.unarchiveWorkbench(w.id);assert.equal(s.getWorkbench(w.id)?.status,'done');
 });
 const hoursType=s.listWorkTypes().find(t=>t.code==='department-hours')!;
 const hours=s.createWorkbench({name:'部门甲工时（匿名）',workTypeId:hoursType.id,firstPeriod:'2026-02'}),otherHours=s.createWorkbench({name:'部门乙工时（匿名）',workTypeId:hoursType.id,firstPeriod:'2026-02'});
 const hp=p.listPeriods(hours.id).find(x=>x.report_period==='2026-02')!,op=p.listPeriods(otherHours.id).find(x=>x.report_period==='2026-02')!;
 const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('工时明细表（填写）');sheet.getCell('C5').value='匿名甲';sheet.getCell('D5').value='部门工时';sheet.getCell('E5').value='成立项目';for(let d=1;d<=28;d++)sheet.getCell(3,8+d).value=d;sheet.getCell(5,37).value={formula:'SUM(I5:AJ5)',result:0};
 const ht=await ts.storeTimesheetSource('部门模板.xlsx',Buffer.from(await book.xlsx.writeBuffer()));
 const rdBook=new ExcelJS.Workbook(),rd=rdBook.addWorksheet('研发');rd.addRow(['人员','日期','工时','项目']);rd.addRow(['匿名甲','2026-02-01',2,'研发项目']);const hr=await ts.storeTimesheetSource('研发.xlsx',Buffer.from(await rdBook.xlsx.writeBuffer()));
 const attBook=new ExcelJS.Workbook(),att=attBook.addWorksheet('考勤');att.addRow(['人员','日期','状态']);for(let d=1;d<=28;d++)att.addRow(['匿名甲',`2026-02-${String(d).padStart(2,'0')}`,d===1?'工作':'休息']);const ha=await ts.storeTimesheetSource('考勤.xlsx',Buffer.from(await attBook.xlsx.writeBuffer()));
 const input:import('../src/domain/timesheets.ts').RunInput={workbenchId:hours.id,periodId:hp.id,month:'2026-02',templateId:ht.id,rdId:hr.id,attendanceId:ha.id,rdMapping:{sheet:'研发',startRow:2,personColumn:1,dateColumn:2,hoursColumn:3,projectColumn:4},attendanceMapping:{sheet:'考勤',startRow:2,personColumn:1,dateColumn:2,statusColumn:3},projects:['成立项目'],assignments:{匿名甲:'成立项目'},requiredPeople:['匿名甲'],rdComplete:true};
 let runId=0;
 await check('工时自动扣除研发，人工调整形成新运行且保留原始输入',async()=>{const initial=await ts.createTimesheetRun(input);assert.equal(initial.days[0]?.department,6);const adjusted=await ts.createTimesheetRun({...input,overrides:[{person:'匿名甲',date:'2026-02-01',status:'work',hours:2,source:'已核实部门工作两小时'}]});assert.equal(adjusted.canFinalize,true);assert.equal(adjusted.days[0]?.department,2);assert.equal(ts.getTimesheetRun(initial.id).result.days[0]?.department,6);runId=adjusted.id;});
 await check('工时跨工作、跨月份关联和未定稿完成均被拒绝',async()=>{await assert.rejects(()=>ts.createTimesheetRun({...input,periodId:op.id}),/不属于/);await assert.rejects(()=>ts.createTimesheetRun({...input,month:'2026-03'}),/年月/);assert.throws(()=>p.updatePeriod(hp.id,{status:'done'}),/工时/);assert.throws(()=>p.updatePeriod(op.id,{status:'done'}),/工时/);});
 await check('工时人工核对后保存有效 Excel 成果，只有所属期次可以完成',async()=>{await assert.rejects(()=>ts.finalizeTimesheet(runId,false),/确认/);const done=await ts.finalizeTimesheet(runId,true);assert.ok(done.artifactId);const a=getArtifact(done.artifactId!)!;assert.equal((a as typeof a & {work_period_id:number}).work_period_id,hp.id);assert.ok(existsSync(artifactAbsPath(a)));writeFileSync(join(root,'部门工时定稿.xlsx'),readFileSync(artifactAbsPath(a)));p.updatePeriod(hp.id,{status:'done'});assert.equal(p.requirePeriod(op.id).status,'open');const exportBook=new ExcelJS.Workbook();await exportBook.xlsx.load(readFileSync(artifactAbsPath(a)) as never);assert.equal(exportBook.getWorksheet('工时明细表（填写）')?.getCell('I5').value,2);});
 await check('工时定稿后丢失成果，重新完成期次受到阻断',()=>{const artifact=getArtifact(ts.getTimesheetRun(runId).artifact_id!)!;const path=artifactAbsPath(artifact);p.updatePeriod(hp.id,{status:'open'});renameSync(path,path+'.missing');assert.throws(()=>p.updatePeriod(hp.id,{status:'done'}),/文件|丢失/);renameSync(path+'.missing',path);p.updatePeriod(hp.id,{status:'done'});});
 await check('含期次、工时和事项的工作可软删恢复并清理元数据，无外键残留',async()=>{
   const {purgeFromTrash,restoreFromTrash}=await import('../src/core/trash.ts');
   const w=s.createWorkbench({name:'回收站关联样例',workTypeId:hoursType.id,firstPeriod:'2026-02'}),period=p.listPeriods(w.id).find(p=>p.report_period==='2026-02')!;
   await ts.createTimesheetRun({...input,workbenchId:w.id,periodId:period.id});await request('POST','/api/quick-todos',{title:'归属事项',workbench_id:w.id},201);
   s.deleteWorkbench(w.id);restoreFromTrash('workbench',w.id);assert.equal(p.listPeriods(w.id).length>0,true);s.deleteWorkbench(w.id);purgeFromTrash('workbench',w.id,{withFile:false});assert.equal(s.getWorkbench(w.id),undefined);assert.deepEqual(all('PRAGMA foreign_key_check'),[]);
 });
 await check('SQLite 迁移后外键、完整性和幂等种子通过',()=>{assert.deepEqual(all('PRAGMA foreign_key_check'),[]);assert.equal(Object.values(get('PRAGMA integrity_check')!)[0],'ok');const before=s.listWorkTypes().length;(void 0);bootstrap();assert.equal(s.listWorkTypes().length,before);});
 writeFileSync(join(root,'verification.json'),JSON.stringify({date:'2026-10-15',checks,passed:checks.length,samples:['已核实月报.docx','部门工时定稿.xlsx']},null,2));
 writeFileSync(join(root,'business-validation-latest.json'),JSON.stringify({root,db:process.env.WORKBENCH_DB,files:process.env.WORKBENCH_DATA_DIR,reportId:report.id,hoursId:hours.id,historicalId:historical.id}));
 console.log(`业务架构验证：${checks.length} 项通过；匿名验收环境：${root}`);
}finally{await app.close();closeDatabase();}
