import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,renameSync,utimesSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import PizZip from 'pizzip';
import ExcelJS from 'exceljs';
const root=process.env.WORKBENCH_ISOLATION_ROOT!;
assert(root,'Must use scripts/test-isolated.mjs --unit reliability-repairs');
(await import('../src/core/bootstrap.ts')).bootstrap();
const db=await import('../src/db/index.ts'),service=await import('../src/domain/service.ts');
const agent=await import('../src/domain/agent.ts'),trash=await import('../src/core/trash.ts');
const store=await import('../src/core/store.ts'),periods=await import('../src/domain/periods.ts');
const workflow=await import('../src/domain/workflow.ts');
const type=(code:string)=>service.listWorkTypes().find(t=>t.code===code)!;
const w=service.createWorkbench({name:'可靠性合成项目',workTypeId:type('software-project').id});
let passed=0;
async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();passed++;console.log('✓ '+name);}
try{
 await test('助手撤销拒绝覆盖人工新值，force也不放宽；无后续修改可正常撤销',()=>{
  service.updateWorkbench(w.id,{owner:'原负责人'});
  const a=agent.proposeAction('set_workbench_field',{workbench:'#'+w.id,field:'owner',value:'助手负责人'});
  assert(agent.applyAction(a.id).ok);
  service.updateWorkbench(w.id,{owner:'人工新负责人'});
  assert.throws(()=>agent.undoAction(a.id),/已被修改/);
  assert.throws(()=>agent.undoAction(a.id,{force:true}),/已被修改/);
  assert.equal(service.getWorkbench(w.id)?.owner,'人工新负责人');
  assert.equal(db.get<{status:string}>('SELECT status FROM agent_action WHERE id=?',[a.id])?.status,'applied');
  const b=agent.proposeAction('set_workbench_field',{workbench:'#'+w.id,field:'owner',value:'再次变更'});
  assert(agent.applyAction(b.id).ok);agent.undoAction(b.id);
  assert.equal(service.getWorkbench(w.id)?.owner,'人工新负责人');
 });
 await test('缺少执行后快照的历史动作拒绝猜测撤销',()=>{
  const a=agent.proposeAction('set_workbench_field',{workbench:'#'+w.id,field:'owner',value:'历史值'});
  assert(agent.applyAction(a.id).ok);
  db.run("UPDATE agent_action SET before_json=json_remove(before_json,'$.afterState') WHERE id=?",[a.id]);
  assert.throws(()=>agent.undoAction(a.id),/没有执行后的值快照/);
  assert.equal(service.getWorkbench(w.id)?.owner,'历史值');
 });
 await test('其余五类覆盖写动作均拒绝人工冲突，并允许无冲突撤销',async()=>{
  const archive=await import('../src/domain/archive.ts'),config=await import('../src/core/config.ts');
  const file=(await store.saveArtifact({data:'撤销摘要夹具',dirAbs:service.workbenchOutputDirAbs(w,'source'),fileName:'undo.txt',title:'撤销摘要夹具',kind:'source',workbenchId:w.id})).artifact;
  const item=db.get<{id:number}>('SELECT c.id FROM checklist_item c JOIN position_instance p ON p.id=c.position_instance_id WHERE p.workbench_id=? LIMIT 1',[w.id]);assert(item);
  const cases:{tool:string;args:Record<string,unknown>;change:()=>unknown;read:()=>unknown;manual:unknown}[]=[
   {tool:'set_archive_value',args:{workbench:'#'+w.id,field:'party_a_name',value:'助手甲方'},change:()=>archive.writeArchiveValues(w.id,{party_a_name:'人工甲方'}),read:()=>archive.readArchiveValues(w.id).party_a_name,manual:'人工甲方'},
   {tool:'mark_checklist',args:{itemId:String(item.id),status:'na'},change:()=>db.run("UPDATE checklist_item SET status='done' WHERE id=?",[item.id]),read:()=>db.get<{status:string}>('SELECT status FROM checklist_item WHERE id=?',[item.id])?.status,manual:'done'},
   {tool:'note_artifact',args:{artifactId:String(file.id),note:'助手摘要'},change:()=>db.run("UPDATE artifact SET summary='人工摘要' WHERE id=?",[file.id]),read:()=>store.getArtifact(file.id)?.summary,manual:'人工摘要'},
   {tool:'update_setting',args:{key:'app.org',value:'助手组织'},change:()=>config.setSetting('app.org','人工组织'),read:()=>config.getSetting('app.org',''),manual:'人工组织'},
   {tool:'update_ai_profile',args:{purpose:'writing',model:'test-agent-model'},change:()=>db.run("UPDATE ai_profile SET model='test-manual-model' WHERE purpose='writing'"),read:()=>db.get<{model:string}>("SELECT model FROM ai_profile WHERE purpose='writing'")?.model,manual:'test-manual-model'},
  ];
  for(const c of cases){
   const action=agent.proposeAction(c.tool,c.args);const applied=agent.applyAction(action.id);assert(applied.ok,applied.error);
   c.change();assert.throws(()=>agent.undoAction(action.id),/已被修改/);assert.throws(()=>agent.undoAction(action.id,{force:true}),/已被修改/);assert.deepEqual(c.read(),c.manual);
   const next=agent.proposeAction(c.tool,c.args);const again=agent.applyAction(next.id);assert(again.ok,again.error);agent.undoAction(next.id);assert.deepEqual(c.read(),c.manual);
   console.log('  '+c.tool+'：冲突保留、force拒绝、正常撤销通过');
  }
 });
 await test('备份不会删除名字像partial的无关旧文件或旧临时文件',async()=>{
  const dir=join(root,'backup-boundary');mkdirSync(dir);
  const names=['report.partial-draft.txt','workbench-manual-20000101-000000.db.partial-123'];
  for(const name of names){writeFileSync(join(dir,name),'必须保留');utimesSync(join(dir,name),new Date(0),new Date(0));}
  await (await import('../src/core/backup.ts')).createBackup({dir,source:db.getDb()});
  for(const name of names)assert.equal(readFileSync(join(dir,name),'utf8'),'必须保留');
  assert.equal(readdirSync(dir).filter(n=>n.includes('.partial-')).length,2);
 });
 await test('DOCX花括号、XML保留字符、换行和tab均保留文字语义',async()=>{
  const z=new PizZip();z.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  z.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{审计值}</w:t></w:r></w:p></w:body></w:document>');
  const p=join(root,'special.docx');writeFileSync(p,z.generate({type:'nodebuffer'}));
  const r=await (await import('../src/core/template.ts')).renderTemplate(p,{'审计值':'{记录}&<说明>\n下一行\t尾部'});
  assert(r.ok&&r.bytes);
  const xml=new PizZip(r.bytes).file('word/document.xml')!.asText();
  assert(xml.includes('{记录}&amp;&lt;说明&gt;'));assert(xml.includes('<w:br/>'));assert(xml.includes('<w:tab/>'));assert(!xml.includes('\uE000'));
  assert((await import('../src/domain/generate.ts')).validateXmlStructure(r.bytes,'docx').ok);
 });
 await test('父删除恢复只恢复本批子项，独立删除和重复删除不混淆；搜索与待办遵守父状态',async()=>{
  const folder=join((await import('../src/core/config.ts')).DATA_ROOT,'files-for-trash');mkdirSync(folder);
  const one=(await store.saveArtifact({data:Buffer.from('恢复测试正文'),dirAbs:folder,fileName:'a.txt',title:'恢复测试甲',kind:'source',workbenchId:w.id})).artifact;
  const two=(await store.saveArtifact({data:Buffer.from('恢复测试正文'),dirAbs:folder,fileName:'b.txt',title:'恢复测试乙',kind:'source',workbenchId:w.id,dedupe:false})).artifact;
  const pos=db.get<{id:number}>('SELECT id FROM position_instance WHERE workbench_id=?',[w.id])!;
  trash.markDeleted('position_instance','id=?',[pos.id]);store.deleteArtifact(one.id);
  const todo=Number(db.run("INSERT INTO quick_todo(title,workbench_id) VALUES('恢复测试待办',?)",[w.id]).lastInsertRowid);
  trash.softDeleteWorkbench(w.id);trash.softDeleteWorkbench(w.id);
  trash.restoreFromTrash('artifact',two.id);
  assert.equal(store.getArtifact(two.id),undefined);assert.equal(store.listArtifacts({workbenchId:w.id}).total,0);
  // Simulate an old index row: read guards must remain safe independently of index removal.
  db.run("INSERT OR REPLACE INTO artifact_search(id,wb_id,kind,seg_text,seg_name) VALUES(?,?,'source','恢 复 测 试','恢 复 测 试')",[two.id,w.id]);
  assert.equal((await import('../src/core/search.ts')).searchArtifacts('恢复测试').total,0);
  assert.equal((await import('../src/core/search-all.ts')).searchAll('恢复测试',{kinds:['artifact']}).total,0);
  assert(!(workflow.listWorkflowInbox().todos as {id:number}[]).some(t=>t.id===todo));
  trash.restoreFromTrash('workbench',w.id);
  assert(db.get<{deleted_at:string}>('SELECT deleted_at FROM artifact WHERE id=?',[one.id])?.deleted_at);
  assert(db.get<{deleted_at:string}>('SELECT deleted_at FROM position_instance WHERE id=?',[pos.id])?.deleted_at);
  assert(store.getArtifact(two.id));assert((workflow.listWorkflowInbox().todos as {id:number}[]).some(t=>t.id===todo));
 });
 await test('同一工时run失败后可重试，八路并发只一份成果，未确认拒绝且完成后幂等',async()=>{
  const ts=await import('../src/domain/timesheets.ts');
  const hw=service.createWorkbench({name:'并发工时',workTypeId:type('department-hours').id});
  const p=periods.listPeriods(hw.id)[0]!,days=ts.monthDays(p.report_period);
  const book=new ExcelJS.Workbook();book.addWorksheet('封面');const sheet=book.addWorksheet('工时明细表（填写）');
  for(let d=1;d<=31;d++)sheet.getCell(3,8+d).value=d;
  sheet.getCell(5,3).value='匿名甲';sheet.getCell(5,4).value='服务工时';sheet.getCell(5,5).value='项目甲';sheet.getCell(6,3).value='合计';book.addWorksheet('人员工时汇总及校验（仅查看）');
  sheet.getCell(5,40).value={formula:'SUM(I5:AM5)',result:0};sheet.getCell(6,40).value={formula:'SUM(AN5:AN5)',result:0};
  const template=await ts.storeTimesheetSource('template.xlsx',Buffer.from(await book.xlsx.writeBuffer()));
  const sources=[];
  for(const name of ['研发','考勤']){const b=new ExcelJS.Workbook(),s=b.addWorksheet(name);s.addRow(['姓名',...Array.from({length:days},(_,i)=>i+1)]);s.addRow(['匿名甲',...Array.from({length:days},()=>name==='研发'?0:'工作')]);sources.push(await ts.storeTimesheetSource(name+'.xlsx',Buffer.from(await b.xlsx.writeBuffer())));}
  const r=await ts.createTimesheetRun({workbenchId:hw.id,periodId:p.id,month:p.report_period,templateId:template.id,rdId:sources[0]!.id,attendanceId:sources[1]!.id,rdMapping:{sheet:'研发',startRow:2,personColumn:1,dateHeaderRow:1,dateStartColumn:2},attendanceMapping:{sheet:'考勤',startRow:2,personColumn:1,dateHeaderRow:1,dateStartColumn:2},requiredPeople:['匿名甲'],projects:['项目甲'],assignments:{'匿名甲':['项目甲']},rdComplete:true});
  await assert.rejects(()=>ts.finalizeTimesheet(r.id,false),/确认/);
  const inputPath=join((await import('../src/core/config.ts')).DATA_ROOT,'_工时处理','inputs',sources[0]!.id+'.xlsx');
  renameSync(inputPath,inputPath+'.held');
  try{
   const failed=await Promise.allSettled([ts.finalizeTimesheet(r.id,true),ts.finalizeTimesheet(r.id,true)]);
   assert(failed.every(x=>x.status==='rejected'));assert.notEqual(ts.getTimesheetRun(r.id).status,'final');assert.equal(store.listArtifacts({workbenchId:hw.id,kind:'generated'}).total,0);
  }finally{renameSync(inputPath+'.held',inputPath);}
  const results=await Promise.all(Array.from({length:8},()=>ts.finalizeTimesheet(r.id,true))),a=results[0]!;
  assert.equal(new Set(results.map(x=>x.artifactId)).size,1);assert.equal(store.listArtifacts({workbenchId:hw.id,kind:'generated'}).total,1);
  assert.equal((await ts.finalizeTimesheet(r.id,true)).artifactId,a.artifactId);
 });
 await test('同月不同检查与未归属照片不串用，预览和保存均只嵌入本检查照片',async()=>{
  const inspections=await import('../src/domain/inspections.ts'),g=await import('../src/domain/generate.ts');
  const iw=service.createWorkbench({name:'影像隔离检查',workTypeId:type('integrity-monthly-inspection').id});
  const p=periods.listPeriods(iw.id)[0]!;
  const create=(name:string)=>inspections.saveInspection(p.id,{project:name,inspection_date:p.report_period+'-01',subject:'现场检查',content:'人工记录',result:'已检查',rectification:'无'});
  const a=create('项目甲'),b=create('项目乙');
  const z=new PizZip();
  z.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{@图片 照片}</w:t></w:r></w:p></w:body></w:document>');
  const path=join(root,'照片检查.docx');writeFileSync(path,z.generate({type:'nodebuffer'}));
  const template=service.registerTemplate({absSourcePath:path,name:'照片检查',workTypeId:iw.work_type_id});await service.rescanTemplate(template.id);
  service.setBoundTemplateIds(iw.id,[template.id]);
  const app=(await import('fastify')).default();(await import('../src/api/routes-workflow.ts')).registerWorkflowRoutes(app);
  try{
   const diff=await app.inject({method:'POST',url:`/api/periods/${p.id}/templates`,payload:{}});assert.equal(diff.statusCode,200);
   const apply=await app.inject({method:'POST',url:`/api/periods/${p.id}/templates`,payload:{apply:true,expected:diff.json().data}});assert.equal(apply.statusCode,200);
  }finally{await app.close();}
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jUioAAAAASUVORK5CYII=','base64');
  const photo=async(id:number|null,name:string,data=png)=>{
   const saved=await store.saveArtifact({data,dirAbs:service.workbenchOutputDirAbs(iw,'evidence'),fileName:name+'.png',title:name,kind:'evidence',workbenchId:iw.id,dedupe:false});
   db.run('UPDATE artifact SET work_period_id=?,inspection_id=? WHERE id=?',[p.id,id,saved.artifact.id]);
  };
  await photo(b.id,'乙照片');await photo(null,'未归属照片');
  const opts={workbenchId:iw.id,periodId:p.id,inspectionId:a.id,inspectionRevision:a.revision};
  const media=(bytes:Buffer)=>Object.keys(new PizZip(bytes).files).filter(n=>/^word\/media\/[^/]+$/.test(n));
  const empty=await g.renderPreviewPlan(template.id,{},opts);assert(empty.bytes);assert.equal(media(empty.bytes).length,0);assert(empty.missingImages?.length);
  const emptySaved=await g.saveGeneratedDocument({...opts,templateId:template.id,values:{},saveMode:'new'});
  assert.equal(media(readFileSync(store.artifactAbsPath(emptySaved.artifact))).length,0);
  const ownPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  assert(!ownPng.equals(png));await photo(a.id,'甲照片',ownPng);
  const preview=await g.renderPreviewPlan(template.id,{},opts);assert(preview.bytes);assert.equal(media(preview.bytes).length,1);
  assert(new PizZip(preview.bytes).file(media(preview.bytes)[0]!)!.asNodeBuffer().equals(ownPng));
  const saved=await g.saveGeneratedDocument({...opts,templateId:template.id,values:{},saveMode:'final'});
  const bytes=readFileSync(store.artifactAbsPath(saved.artifact));assert.equal(media(bytes).length,1);assert(g.validateXmlStructure(bytes,'docx').ok);
  assert(new PizZip(bytes).file(media(bytes)[0]!)!.asNodeBuffer().equals(ownPng));
 });
 assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);
 console.log(`可靠性首批：${passed}组通过`);
}finally{db.closeDatabase();}
