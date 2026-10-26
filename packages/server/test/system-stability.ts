import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import PizZip from 'pizzip';
const parent=resolve('.tmp');mkdirSync(parent,{recursive:true});
const root=process.env.WORKBENCH_ISOLATION_ROOT!;

process.env.WORKBENCH_TEST_MODE='1';
const config=await import('../src/core/config.ts');
(await import('../src/core/bootstrap.ts')).bootstrap();
const paths=await import('../src/core/paths.ts'),db=await import('../src/db/index.ts');
const store=await import('../src/core/store.ts'),s=await import('../src/domain/service.ts');
const {saveGeneratedDocument}=await import('../src/domain/generate.ts');
const periods=await import('../src/domain/periods.ts'),evidence=await import('../src/domain/business-evidence.ts');
const hours=await import('../src/domain/timesheets.ts');
const failures:string[]=[];
async function check(name:string,fn:()=>unknown|Promise<unknown>){try{await fn();console.log('PASS '+name);}catch(e){failures.push(name);console.error('FAIL '+name+': '+(e as Error).message);}}
try{
 await check('隔离运行目录不会触及正式预览和日志',()=>assert.equal(config.RUNTIME_ROOT,join(root,'runtime')));
 const external=join(root,'readonly-originals');mkdirSync(external);writeFileSync(join(external,'original.txt'),'ORIGINAL');
 const junction=join(config.DATA_ROOT,'linked');symlinkSync(external,junction,'junction');
 await check('数据根目录链接不能越界读取',()=>assert.throws(()=>paths.resolveInAnyRoot(join(junction,'original.txt')),/链接|越界/));
 await check('目录链接不能写入外部原件目录',async()=>{await assert.rejects(()=>store.saveArtifact({dirAbs:junction,fileName:'unexpected.txt',data:'BAD',kind:'source',title:'越界'}),/链接|越界/);assert.equal(existsSync(join(external,'unexpected.txt')),false);});
 await check('目录链接不能绕过删除授权',()=>assert.throws(()=>paths.assertUsable(join(junction,'original.txt'),'delete'),/链接|越界/));
 const wt=s.upsertWorkType({code:'stability',name:'稳定性匿名测试',category:'行政管理',mode:'document'});
 const w=s.createWorkbench({name:'匿名文件测试',workTypeId:wt});
 const zip=new PizZip();zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{内容}</w:t></w:r></w:p></w:body></w:document>');
 const source=join(root,'template.docx');writeFileSync(source,zip.generate({type:'nodebuffer'}));
 const t=s.registerTemplate({absSourcePath:source,name:'匿名文书',workTypeId:wt});await s.rescanTemplate(t.id);s.setBoundTemplateIds(w.id,[t.id]);
 const base={templateId:t.id,workbenchId:w.id,values:{内容:'有效正文'},saveMode:'update' as const};
 await saveGeneratedDocument(base);
 await check('旧窗口不能把旧内容接续成最新版本',async()=>{
  const previous=db.get<{id:number}>('SELECT id FROM artifact ORDER BY id DESC LIMIT 1')!;
  await saveGeneratedDocument({...base,expectedHeadId:previous.id});
  await assert.rejects(()=>saveGeneratedDocument({...base,expectedHeadId:previous.id}),/已有新版本/);
 });
 await check('并发重复保存只有一个提交成功且版本唯一',async()=>{
  const rs=await Promise.allSettled([saveGeneratedDocument(base),saveGeneratedDocument(base)]);
  assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);
  assert.match(String((rs.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/正在保存文书/);
  assert.equal(db.all('SELECT version_group,revision FROM artifact WHERE version_group IS NOT NULL GROUP BY version_group,revision HAVING count(*)>1').length,0);
 });
 await check('证据登记失败时文件和版本一并回滚，重试成功',async()=>{
  const before=db.all('SELECT id,file_rel,revision FROM artifact ORDER BY id');
  const bytes=before.map(a=>readFileSync(store.artifactAbsPath(store.getArtifact(Number(a.id))!)));
  db.run("CREATE TRIGGER test_reject_review BEFORE INSERT ON artifact_fact_review BEGIN SELECT RAISE(ABORT,'injected review failure'); END");
  try{await assert.rejects(()=>saveGeneratedDocument(base),/injected review failure/);}finally{db.run('DROP TRIGGER test_reject_review');}
  assert.deepEqual(db.all('SELECT id,file_rel,revision FROM artifact ORDER BY id'),before);
  before.forEach((a,i)=>assert.deepEqual(readFileSync(store.artifactAbsPath(store.getArtifact(Number(a.id))!)),bytes[i]));
  await saveGeneratedDocument(base);
 });
 await check('回滚当前版本成功；登记失败时旧文件与版本不变',async()=>{
  const v=await import('../src/domain/versions.ts');
  let head=db.get<{id:number;revision:number}>('SELECT id,revision FROM artifact WHERE workbench_id=? AND kind=\'generated\' ORDER BY id DESC LIMIT 1',[w.id])!;
  await v.rollbackToRevision(head.id,head.revision);
  head=db.get<{id:number;revision:number}>('SELECT id,revision FROM artifact WHERE workbench_id=? AND kind=\'generated\' ORDER BY id DESC LIMIT 1',[w.id])!;
  const before=db.all('SELECT id,file_rel,revision FROM artifact ORDER BY id'),bytes=readFileSync(store.artifactAbsPath(store.getArtifact(head.id)!));
  db.run("CREATE TRIGGER test_reject_review BEFORE INSERT ON artifact_fact_review BEGIN SELECT RAISE(ABORT,'rollback failure'); END");
  try{await assert.rejects(()=>v.rollbackToRevision(head.id,head.revision),/rollback failure/);}finally{db.run('DROP TRIGGER test_reject_review');}
  assert.deepEqual(db.all('SELECT id,file_rel,revision FROM artifact ORDER BY id'),before);assert.deepEqual(readFileSync(store.artifactAbsPath(store.getArtifact(head.id)!)),bytes);
 });
 await check('起草后来源变化不能把旧正文保存成新来源定稿',async()=>{
  const {generateVariables}=await import('../src/domain/generate.ts');
  const draft=await generateVariables({...base,skipAi:true});s.updateWorkbench(w.id,{business_content:'起草之后变化'});
  await assert.rejects(()=>saveGeneratedDocument({...base,expectedSourceSignature:draft.sourceSignature}),/来源已变化/);
 });
 await check('完成与归档不会使自己的定稿失效；磁盘改动使旧核对失效',async()=>{
  const final=await saveGeneratedDocument({...base,saveMode:'final'}),{assertFinalArtifact}=await import('../src/domain/finalization.ts'),v=await import('../src/domain/versions.ts');
  s.completeWorkbench(w.id);assertFinalArtifact(store.getArtifact(final.artifact.id)!);s.archiveWorkbench(w.id);s.unarchiveWorkbench(w.id);
  const review=JSON.parse(db.get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[final.artifact.id])!.snapshot);delete review.sourceSignature;delete review.sourceArtifactIds;
  db.run('UPDATE artifact_fact_review SET snapshot=? WHERE artifact_id=?',[JSON.stringify(review),final.artifact.id]);assert.throws(()=>assertFinalArtifact(store.getArtifact(final.artifact.id)!),/旧版定稿未保存来源签名/);v.markFinal(final.artifact.id,true);assertFinalArtifact(store.getArtifact(final.artifact.id)!);
  const path=store.artifactAbsPath(store.getArtifact(final.artifact.id)!),doc=new PizZip(readFileSync(path));doc.file('word/document.xml',doc.file('word/document.xml')!.asText().replace('有效正文','磁盘已修改'));
  writeFileSync(path,doc.generate({type:'nodebuffer'}));assert.throws(()=>assertFinalArtifact(store.getArtifact(final.artifact.id)!),/定稿文件已被修改/);
  v.markFinal(final.artifact.id,false);v.markFinal(final.artifact.id,true);assertFinalArtifact(store.getArtifact(final.artifact.id)!);
 });
 await check('普通期次来源修改后旧定稿不充抵当前成果',async()=>{
  const annualType=s.listWorkTypes().find(t=>t.code==='integrity-annual-plan')!;
  const tpl=s.registerTemplate({absSourcePath:source,name:'年度匿名稿',workTypeId:annualType.id});await s.rescanTemplate(tpl.id);
  const annual=s.createWorkbench({name:'匿名年度来源',workTypeId:annualType.id,templateIds:[tpl.id]});s.setBoundTemplateIds(annual.id,[tpl.id]);
  periods.savePeriodRule(annual.id,{frequency:'yearly',first_period:'2026',requirements:[]});
  const p=periods.listPeriods(annual.id)[0]!;
  // Normal period template preview/apply API (no snapshot patching).
  const app=(await import('fastify')).default();(await import('../src/api/routes-workflow.ts')).registerWorkflowRoutes(app);
  const payload={templateIds:[tpl.id],requiredIds:[tpl.id]};const preview=(await app.inject({method:'POST',url:`/api/periods/${p.id}/templates`,payload})).json().data;
  assert.equal((await app.inject({method:'POST',url:`/api/periods/${p.id}/templates`,payload:{...payload,expected:preview,apply:true}})).statusCode,200);await app.close();
  periods.updatePeriod(p.id,{content:'来源第一版'});
  const old=await saveGeneratedDocument({templateId:tpl.id,workbenchId:annual.id,periodId:p.id,values:{内容:'年度计划正文'},saveMode:'final'});
  periods.updatePeriod(p.id,{status:'done'});periods.updatePeriod(p.id,{status:'open',content:'来源第二版'});
  assert.equal(periods.periodReadiness(p.id).canComplete,false);assert.throws(()=>periods.updatePeriod(p.id,{status:'done'}),/待生成/);
  assert.ok(existsSync(store.artifactAbsPath(store.getArtifact(old.artifact.id)!)));
  // Simulate the exact old snapshot shape; modification must not silently accept it.
  const snapshot=JSON.parse(db.get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[old.artifact.id])!.snapshot);delete snapshot.sourceSignature;delete snapshot.sourceArtifactIds;
  db.run('UPDATE artifact_fact_review SET snapshot=? WHERE artifact_id=?',[JSON.stringify(snapshot),old.artifact.id]);
  periods.updatePeriod(p.id,{content:'来源第三版'});assert.equal(periods.periodReadiness(p.id).canComplete,false);
 });
 await check('重复完成不补造或覆盖历史结束日期',()=>{
  const project=s.upsertWorkType({code:'history-stability',name:'匿名历史类型',category:'项目实施',domain:'project',mode:'document'});
  for(const date of [undefined,'2025-12-31']){const old=s.createWorkbench({name:'匿名历史',workTypeId:project,historical:true,actualEndDate:date});s.completeWorkbench(old.id);assert.equal(s.getWorkbench(old.id)!.actual_end_date,date??null);}
 });
 await check('工时拒绝非工时工作归属',async()=>{
  await assert.rejects(()=>hours.createTimesheetRun({workbenchId:w.id,month:'2026-02',templateId:'unused',rdId:'unused',attendanceId:'unused',rdMapping:{sheet:'unused',firstRow:2,nameColumn:1,dateColumn:2,hoursColumn:3},attendanceMapping:{sheet:'unused',firstRow:2,nameColumn:1,dateColumn:2,statusColumn:3},rdComplete:true,projects:['A'],assignments:{匿名员工:['A']}} as unknown as Parameters<typeof hours.createTimesheetRun>[0]),/工时只能关联/);
 });
 await check('研发工时与明确休息冲突不能定稿',()=>{
  const r=hours.calculateTimesheet({month:'2026-02',people:['匿名员工'],requiredPeople:['匿名员工'],projects:['A'],assignments:{匿名员工:['A']},rdComplete:true,rd:[{person:'匿名员工',date:'2026-02-01',hours:8,source:'匿名研发'}],attendance:Array.from({length:28},(_,n)=>({person:'匿名员工',date:`2026-02-${String(n+1).padStart(2,'0')}`,status:'rest',source:'匿名考勤'}))});
  assert.equal(r.canFinalize,false);assert.ok(r.issues.some(i=>i.code==='RD_ATT_CONFLICT'));
 });
 await check('旧生成路径重读变更后的资料并披露过期核对',async()=>{
  const a=await store.saveArtifact({dirAbs:join(config.DATA_ROOT,w.folder_path),fileName:'source.txt',data:'检查次数：3次',kind:'source',title:'匿名资料',workbenchId:w.id});
  writeFileSync(a.absPath,'检查次数：9次');const context=await (await import('../src/domain/work-context.ts')).collectWorkContext(w.id,null,[a.artifact.id]);
  assert.match(context.text,/9次/);assert.doesNotMatch(context.text,/3次/);assert.ok(context.warnings.some(x=>x.includes('已更新')));
 });
 await check('累计谈话台账按条目日期检索，行政临时记录进入当季证据',async()=>{
  const talk=s.createWorkbench({name:'匿名年度谈话',workTypeId:s.listWorkTypes().find(t=>t.code==='integrity-talk')!.id});
  await store.saveArtifact({dirAbs:join(config.DATA_ROOT,talk.folder_path),fileName:'年度台账.txt',data:'2026-02-03 往期谈话不能混入\n2026-08-03 本季谈话甲\n谈话内容：进度沟通',kind:'source',title:'年度台账',workbenchId:talk.id,docDate:'2026-01-01'});
  const scope={start:'2026-07-01',end:'2026-10-01'};
  const pack=await evidence.collectBusinessEvidence({...scope,workbenchId:talk.id});const body=pack.facts.map(f=>f.text).join('\n');assert.match(body,/本季谈话甲/);assert.doesNotMatch(body,/往期谈话不能混入/);
  // 模拟升级前已存在的单次工作；新建入口已转为工作记录，历史证据仍须兼容。
  const legacyId=db.run("INSERT INTO workbench(code,name,work_type_id,folder_path) VALUES('LEGACY-STABILITY','清廉匿名临时事项',?,'legacy-stability')",[s.listWorkTypes().find(t=>t.code==='temporary-task')!.id]).lastInsertRowid;
  const temp=s.getWorkbench(legacyId)!;s.updateWorkbench(temp.id,{business_content:'2026-08-07 已开展匿名协调\n2026-11-01 未来计划不能混入'});
  const texts=(await evidence.collectBusinessEvidence({...scope,workbenchId:temp.id})).facts.filter(f=>f.kind==='record');assert.match(texts.map(f=>f.text).join('\n'),/匿名协调/);assert.ok(texts.every(f=>f.certainty==='unverified'));assert.doesNotMatch(JSON.stringify(texts),/未来计划不能混入/);
  const automatic=(await evidence.collectBusinessEvidence({...scope,domain:'admin',category:'清廉工程'})).facts;assert.match(JSON.stringify(automatic),/匿名协调/);
 });
 assert.equal(readFileSync(join(external,'original.txt'),'utf8'),'ORIGINAL');
}finally{db.closeDatabase();}
assert.deepEqual(failures,[],'稳定性反例未全部通过');
