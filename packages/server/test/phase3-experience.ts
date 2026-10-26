import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import PizZip from 'pizzip';
import ExcelJS from 'exceljs';
mkdirSync(resolve('.tmp'),{recursive:true});
const root = process.env.WORKBENCH_ISOLATION_ROOT!;
process.env.WORKBENCH_TEST_MODE='1';
(await import('../src/core/bootstrap.ts')).bootstrap();
const s=await import('../src/domain/service.ts'),p=await import('../src/domain/periods.ts'),db=await import('../src/db/index.ts');
const {artifactAbsPath,saveArtifact}=await import('../src/core/store.ts');
const {generateVariables,saveGeneratedDocument}=await import('../src/domain/generate.ts');
const {INTEGRITY_TYPES}=await import('../src/domain/integrity-config.ts');
const app=(await import('fastify')).default();await app.register((await import('@fastify/multipart')).default);
(await import('../src/api/routes-work.ts')).registerWorkRoutes(app);
(await import('../src/api/routes-workflow.ts')).registerWorkflowRoutes(app);
(await import('../src/api/routes-generate.ts')).registerGenerateRoutes(app);
(await import('../src/api/routes-files.ts')).registerFileRoutes(app);
let count=0;
async function check(name:string,fn:()=>unknown|Promise<unknown>){await fn();count++;console.log('✓ '+name);}
async function request(method:'GET'|'POST'|'PUT',url:string,payload?:object,status=200){const r=await app.inject({method,url,payload});assert.equal(r.statusCode,status,r.body);return r.json().data;}
const type=(code:string)=>s.listWorkTypes().find(t=>t.code===code)!;
const annual=s.createWorkbench({name:'匿名年度计划',workTypeId:type('integrity-annual-plan').id,templateIds:[]});
const summary=s.createWorkbench({name:'匿名部门总结',workTypeId:type('department-year').id,templateIds:[]});
const one=p.listPeriods(annual.id)[0]!,two=p.listPeriods(summary.id)[0]!;
const zip=new PizZip();zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{内容}</w:t></w:r></w:p></w:body></w:document>');
const docPath=join(root,'mechanism.docx');writeFileSync(docPath,zip.generate({type:'nodebuffer'}));
const word=s.registerTemplate({absSourcePath:docPath,name:'计划成果',workTypeId:annual.work_type_id});await s.rescanTemplate(word.id);
const book=new ExcelJS.Workbook();book.addWorksheet('正文').getCell('A1').value='{内容}';const xlsxPath=join(root,'mechanism.xlsx');await book.xlsx.writeFile(xlsxPath);
const excel=s.registerTemplate({absSourcePath:xlsxPath,name:'总结成果',workTypeId:summary.work_type_id});await s.rescanTemplate(excel.id);
const generic=s.registerTemplate({absSourcePath:docPath,name:'未分类安全检查表'});
try{
 await check('8项固定工作含年度计划，合同承诺不替代固定项',()=>{assert.equal(INTEGRITY_TYPES.length,8);assert.ok(INTEGRITY_TYPES.some(t=>t.code==='integrity-annual-plan'));assert.ok(!INTEGRITY_TYPES.some(t=>String(t.code)==='integrity-commitment'));});
 await check('显式暂不选模板保持空集，未分类表单不会跨类型出现',async()=>{assert.equal(s.listTemplatesForWorkbench(annual.id).length,0);assert.ok(!s.listTemplates({workTypeId:annual.work_type_id}).some(t=>t.id===generic.id));await request('GET',`/api/generate/fields/${generic.id}?workbenchId=${annual.id}&periodId=${one.id}`,undefined,409);});
 await check('软件项目只实例化软件阶段及材料',()=>{const w=s.createWorkbench({name:'匿名软件',workTypeId:type('software-project').id});const stages=s.getWorkbenchDetail(w.id)!.positions;assert.deepEqual(stages.map(x=>x.name),['需求与计划','设计与研发','测试与交付','验收与归档']);assert.ok(!JSON.stringify(stages).includes('安全检查'));});
 await check('后端拒绝跨工作类型字段、预览及保存，不依赖页面过滤',async()=>{await request('GET',`/api/generate/fields/${word.id}?workbenchId=${summary.id}&periodId=${two.id}`,undefined,409);await request('POST','/api/generate/preview',{templateId:word.id,workbenchId:summary.id,periodId:two.id,values:{内容:'跨类型'}},409);await request('POST','/api/generate/save',{templateId:word.id,workbenchId:summary.id,periodId:two.id,values:{内容:'跨类型'}},409);});
 await check('本期选择模板只改变本期，错误类型与过期差异请求被拒绝',async()=>{for(const [q,t] of [[one,word],[two,excel]] as const){const body={templateIds:[t.id],requiredIds:[t.id]};const expected=await request('POST',`/api/periods/${q.id}/templates`,body);await request('POST',`/api/periods/${q.id}/templates`,{...body,expected,apply:true});}await request('POST',`/api/periods/${one.id}/templates`,{templateIds:[excel.id]},400);assert.equal(s.listTemplatesForWorkbench(annual.id).length,0);});
 await check('业务内容映射到字段，期次隔离，Word实际可读且自动归属',async()=>{p.updatePeriod(one.id,{content:'年度计划确认正文'});const fields=await request('GET',`/api/generate/fields/${word.id}?workbenchId=${annual.id}&periodId=${one.id}`);assert.equal(fields.variables[0].preset,'年度计划确认正文');const r=await saveGeneratedDocument({templateId:word.id,workbenchId:annual.id,periodId:one.id,values:{内容:'年度计划定稿'},saveMode:'final'});assert.match(new PizZip(readFileSync(artifactAbsPath(r.artifact))).file('word/document.xml')!.asText(),/年度计划定稿/);assert.equal(db.get<{work_period_id:number}>('SELECT work_period_id FROM artifact WHERE id=?',[r.artifact.id])?.work_period_id,one.id);const saved=await request('GET',`/api/artifacts/${r.artifact.id}/generation-values`);assert.equal(saved.values.内容,'年度计划定稿');});
 await check('Excel实际可读且按模板、工作及期次自动保存',async()=>{const r=await saveGeneratedDocument({templateId:excel.id,workbenchId:summary.id,periodId:two.id,values:{内容:'总结独立正文'},saveMode:'final'});const b=new ExcelJS.Workbook();await b.xlsx.readFile(artifactAbsPath(r.artifact));assert.equal(b.worksheets[0]!.getCell('A1').value,'总结独立正文');assert.equal(r.artifact.workbench_id,summary.id);assert.equal(r.artifact.template_id,excel.id);});
 await check('文书定稿后无需重复维护旧步骤或绑定材料即可完成',()=>{assert.ok(JSON.parse(p.requirePeriod(one.id).steps).some((x:{status:string})=>x.status==='open'));p.updatePeriod(one.id,{status:'done'});assert.equal(p.requirePeriod(one.id).status,'done');assert.equal(db.get<{n:number}>('SELECT count(*) AS n FROM period_material WHERE period_id=?',[one.id])!.n,0);});
 await check('模板映射成果要求后，草稿自动已提供、定稿自动核对，无须重复上传绑定',async()=>{
  const m=await request('POST',`/api/periods/${two.id}/materials`,{title:'年度总结核对稿',requirementKind:'generated'},201);
  const selection={templateIds:[excel.id],requiredIds:[excel.id],resultMaterials:{[excel.id]:m.id}};
  const expected=await request('POST',`/api/periods/${two.id}/templates`,selection);await request('POST',`/api/periods/${two.id}/templates`,{...selection,expected,apply:true});
  const draft=await saveGeneratedDocument({templateId:excel.id,workbenchId:summary.id,periodId:two.id,values:{内容:'映射草稿'},saveMode:'new'});
  assert.equal(db.get<{status:string}>('SELECT status FROM period_material WHERE id=?',[m.id])!.status,'provided');
  const final=await saveGeneratedDocument({templateId:excel.id,workbenchId:summary.id,periodId:two.id,values:{内容:'映射定稿'},saveMode:'final'});
  const linked=db.get<{status:string;artifact_id:number}>('SELECT * FROM period_material WHERE id=?',[m.id])!;assert.equal(linked.status,'verified');assert.equal(linked.artifact_id,final.artifact.id);assert.notEqual(linked.artifact_id,draft.artifact.id);
 });
 await check('来源资料默认不进入生成上下文，显式选择后才读取',async()=>{const a=await saveArtifact({data:'不应自动引用的文件正文',dirAbs:s.workbenchOutputDirAbs(summary,'source'),fileName:'source.txt',kind:'source',title:'匿名来源',workbenchId:summary.id});db.run('UPDATE artifact SET work_period_id=? WHERE id=?',[two.id,a.artifact.id]);const none=await generateVariables({templateId:excel.id,workbenchId:summary.id,periodId:two.id,skipAi:true});assert.ok(!none.evidence?.text.includes('不应自动引用的文件正文'));const chosen=await generateVariables({templateId:excel.id,workbenchId:summary.id,periodId:two.id,skipAi:true,referenceArtifactIds:[a.artifact.id]});assert.match(chosen.evidence!.text,/不应自动引用的文件正文/);});
 await check('行政后端拒绝供应商交付事项',async()=>{await request('POST','/api/quick-todos',{workbench_id:annual.id,title:'错误交付',kind:'delivery'},400);});
 await check('只读目录只浏览，输出保持平台目录，目录穿越被拒绝且原件不变',async()=>{const folder=mkdtempSync(join(process.env.WORKBENCH_ISOLATION_ROOT!,'reference-'));const original=join(folder,'reference.txt');writeFileSync(original,'只读原件');await request('PUT',`/api/workbenches/${summary.id}/reference-folder`,{path:folder});const list=await request('GET',`/api/workbenches/${summary.id}/reference-folder`);assert.equal(list.items[0].name,'reference.txt');const download=await app.inject(`/api/workbenches/${summary.id}/reference-file?path=reference.txt`);assert.equal(download.body,'只读原件');await request('GET',`/api/workbenches/${summary.id}/reference-file?path=../mechanism.docx`,undefined,403);assert.equal(s.getWorkbench(summary.id)!.external_root,null);assert.equal(readFileSync(original,'utf8'),'只读原件');});
 assert.equal(db.all('PRAGMA foreign_key_check').length,0);console.log(`第三轮体验回归：${count} 项通过`);
}finally{await app.close();db.closeDatabase();}
