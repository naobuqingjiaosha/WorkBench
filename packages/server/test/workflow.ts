import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
const parent = resolve('.tmp');
mkdirSync(parent, { recursive: true });
const tmp = process.env.WORKBENCH_ISOLATION_ROOT!;


process.env.WORKBENCH_TEST_MODE = '1';
const { bootstrap } = await import('../src/core/bootstrap.ts');
bootstrap();
const { all, get, run, getDb, closeDatabase } = await import('../src/db/index.ts');
const service = await import('../src/domain/service.ts');
const periods = await import('../src/domain/periods.ts');
const timesheets = await import('../src/domain/timesheets.ts');
const consent = await import('../src/ai/consent.ts');
const { fetchWithTimeout } = await import('../src/ai/gateway.ts');
const { registerWorkflowRoutes } = await import('../src/api/routes-workflow.ts');
const { registerConsentRoutes } = await import('../src/api/routes-consent.ts');
const { registerTimesheetRoutes } = await import('../src/api/routes-timesheets.ts');
const { registerGenerateRoutes } = await import('../src/api/routes-generate.ts');
const { registerFileRoutes } = await import('../src/api/routes-files.ts');
const { artifactAbsPath } = await import('../src/core/store.ts');
const { saveArtifact } = await import('../src/core/store.ts');
const { saveGeneratedDocument } = await import('../src/domain/generate.ts');
const { relevantMemories } = await import('../src/domain/agent.ts');
const { findChainHead, markFinal } = await import('../src/domain/versions.ts');
const Fastify = (await import('fastify')).default;
const app = Fastify();
await app.register((await import('@fastify/multipart')).default);
registerWorkflowRoutes(app);
registerConsentRoutes(app);
registerTimesheetRoutes(app);
registerGenerateRoutes(app);
registerFileRoutes(app);
const checks: string[] = [];
const test = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); checks.push(name); console.log('✓ ' + name); };
try {
    const type = service.upsertWorkType({ code: 'workflow-test', name: '匿名报送', category: 'admin', mode: 'document' });
    const wb = service.createWorkbench({ name: '安全月报（匿名样例）', workTypeId: type });
    await test('月底、闰年、季度和年度跨界', () => { assert.equal(periods.periodDue('2024-02-01', 0, 31), '2024-02-29'); assert.equal(periods.periodDue('2026-02-01', 0, 31), '2026-02-28'); assert.equal(periods.periodDue('2026-10-01', 3, 5), '2027-01-05'); assert.equal(periods.periodDue('2026-01-01', 12, 5), '2027-01-05'); });
    periods.savePeriodRule(wb.id, { frequency: 'monthly', first_period: '2026-09', due_month_offset: 1, due_day: 5, requirements: ['检查记录'] });
    const rows = periods.syncPeriods(wb.id, '2026-10-04'), sep = rows.find(p => p.report_period === '2026-09')!, oct = rows.find(p => p.report_period === '2026-10')!;
    await test('报告期与截止日期分离且重复同步幂等', () => { assert.equal(sep.due_date, '2026-10-05'); assert.equal(periods.syncPeriods(wb.id, '2026-10-04').length, 2); });
    await test('缺必备材料不能完成，旧入口不能绕过', () => { assert.throws(() => periods.updatePeriod(sep.id, { status: 'done' }), /材料/); assert.throws(() => service.completeWorkbench(wb.id), /独立期次/); });
    await test('修改规则不改已有期次快照', () => { periods.savePeriodRule(wb.id, { frequency: 'monthly', first_period: '2026-09', due_month_offset: 1, due_day: 15, requirements: ['新的材料'] }); const next = periods.syncPeriods(wb.id, '2026-11-01'); assert.equal(next.find(p => p.id === sep.id)?.due_date, '2026-10-05'); assert.equal(next[0]?.due_date, '2026-12-15'); });
    const material = get<{
        id: number;
    }>('SELECT id FROM period_material WHERE period_id=?', [sep.id])!;
    await test('不适用必须有原因', async () => { const response = await app.inject({ method: 'PUT', url: `/api/periods/${sep.id}/materials/${material.id}`, payload: { status: 'na' } }); assert.equal(response.statusCode, 400); });
    await test('补报旧期不影响新期且单期截止日独立', async () => { await app.inject({ method: 'PUT', url: `/api/periods/${sep.id}/materials/${material.id}`, payload: { status: 'na', note: '本期经确认不适用（测试）' } }); periods.updatePeriod(sep.id, { due_date: '2026-10-06', content: '已确认本期事实' }); periods.updatePeriod(sep.id, { status: 'done' }); assert.equal(periods.requirePeriod(oct.id).status, 'open'); assert.equal(periods.requirePeriod(oct.id).due_date, '2026-11-05'); });
    const other = service.createWorkbench({ name: '清廉季报（匿名样例）', workTypeId: type });
    await test('跨工作期次关联被拒绝', () => assert.throws(() => periods.requirePeriod(sep.id, other.id), /不属于/));
    const foreign = await saveArtifact({ data: '匿名材料', dirAbs: join(process.env.WORKBENCH_DATA_DIR!, other.folder_path), fileName: '材料.txt', workbenchId: other.id, kind: 'source', title: '材料' });
    await test('跨工作附件不能关联本期', async () => { const m = get<{
        id: number;
    }>('SELECT id FROM period_material WHERE period_id=?', [oct.id])!; const response = await app.inject({ method: 'PUT', url: `/api/periods/${oct.id}/materials/${m.id}`, payload: { status: 'verified', artifact_id: foreign.artifact.id } }); assert.equal(response.statusCode, 400); });
    await test('本期上传自动关联且关闭期次拒绝上传',async()=>{
      const upload=async(id:number)=>{const boundary='workflow-upload';const payload=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="workbenchId"\r\n\r\n${wb.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="periodId"\r\n\r\n${id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="material.txt"\r\nContent-Type: text/plain\r\n\r\nanonymous\r\n--${boundary}--\r\n`);return app.inject({method:'POST',url:'/api/artifacts/upload',headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload});};
      const response=await upload(oct.id);assert.equal(response.statusCode,201,response.body);const id=response.json().data.items[0].id;assert.equal(get<{work_period_id:number}>('SELECT work_period_id FROM artifact WHERE id=?',[id])?.work_period_id,oct.id);assert.equal((await upload(sep.id)).statusCode,400);
    });
    const templateFile = join(tmp, '月报.docx');
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>报告期：{报告期} 本期内容：{本期内容}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
    writeFileSync(templateFile, zip.generate({ type: 'nodebuffer' }));
    const template = service.registerTemplate({ absSourcePath: templateFile, name: '匿名月报', workTypeId: type });
    service.setBoundTemplateIds(wb.id,[template.id]);
    for(const q of [sep,oct]) {const snapshot=JSON.parse(periods.requirePeriod(q.id).snapshot);run('UPDATE work_period SET snapshot=? WHERE id=?',[JSON.stringify({...snapshot,templates:periods.periodTemplates(wb.id)}),q.id]);}
    await test('生成件关联明确期次，旧期与新期版本链独立', async () => { periods.updatePeriod(sep.id, { status: 'open' }); const a = await saveGeneratedDocument({ templateId: template.id, workbenchId: wb.id, periodId: sep.id, values: { 报告期: '2026-09', 本期内容: '测试事实' }, saveMode: 'final' }); const b = await saveGeneratedDocument({ templateId: template.id, workbenchId: wb.id, periodId: oct.id, values: { 报告期: '2026-10', 本期内容: '另一事实' }, saveMode: 'final' }); assert.notEqual(a.version?.group, b.version?.group); assert.equal(get<{
        work_period_id: number;
    }>('SELECT work_period_id FROM artifact WHERE id=?', [a.artifact.id])?.work_period_id, sep.id); assert.equal(periods.requirePeriod(oct.id).status, 'open'); });
    await test('无期次历史文件不自动吸收到当前链', async () => { const old = await saveGeneratedDocument({ templateId: template.id, workbenchId: other.id, values: { 报告期: '未知', 本期内容: '历史' } }); assert.ok(old.artifact.id); assert.equal(findChainHead({ workbenchId: other.id, templateId: template.id, periodKey: '2026/10月' }), null); });
    await test('缺失必填事实不能直接定稿', async () => { await assert.rejects(() => saveGeneratedDocument({ templateId: template.id, workbenchId: other.id, values: {}, saveMode: 'final' }), /必填/); });
    await test('旧定稿入口阻断缺项，拒绝不会建立版本链或改变定稿', async () => {
        const draft = await saveGeneratedDocument({templateId:template.id, workbenchId:other.id, values:{}, saveMode:'new'});
        assert.ok(draft.missing.length);
        const before = get('SELECT version_group,is_final,final_at FROM artifact WHERE id=?',[draft.artifact.id]);
        assert.throws(() => markFinal(draft.artifact.id,true), /必填/);
        assert.deepEqual(get('SELECT version_group,is_final,final_at FROM artifact WHERE id=?',[draft.artifact.id]),before);
    });
    await test('旧定稿入口接受完整草稿，文件丢失则拒绝', async () => {
        const draft = await saveGeneratedDocument({templateId:template.id,workbenchId:other.id,values:{报告期:'2026-09',本期内容:'核对事实'},saveMode:'new'});
        assert.equal(markFinal(draft.artifact.id,true).is_final,1);
        markFinal(draft.artifact.id,false);
        const path = artifactAbsPath(draft.artifact); renameSync(path,path+'.missing');
        try { assert.throws(()=>markFinal(draft.artifact.id,true), /文件丢失/); } finally {renameSync(path+'.missing',path);}
    });
    await test('启用期次的工作禁止无期次字段、预览和保存', async () => {
        assert.equal((await app.inject({method:'GET',url:`/api/generate/fields/${template.id}?workbenchId=${wb.id}`})).statusCode,400);
        await assert.rejects(()=>saveGeneratedDocument({templateId:template.id,workbenchId:wb.id,values:{}}),/选择报告期/);
        const r=await app.inject({method:'POST',url:'/api/generate/preview',payload:{templateId:template.id,workbenchId:wb.id,values:{}}});assert.equal(r.statusCode,400,r.body);
    });
    await test('缺图片、XLSX 跨富文本占位和正文损坏均阻止旧定稿', async () => {
        const imageZip=new PizZip(zip.generate({type:'nodebuffer'}));imageZip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{@图片 检查现场}</w:t></w:r></w:p></w:body></w:document>');
        const image=await saveArtifact({data:imageZip.generate({type:'nodebuffer'}),dirAbs:join(process.env.WORKBENCH_DATA_DIR!,'gate'),fileName:'缺图片.docx',title:'图片回归',kind:'generated'});
        assert.throws(()=>markFinal(image.artifact.id,true),/必填/);
        const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('报告');sheet.getCell('A1').value={richText:[{text:'{检查'},{text:'次数}'}]};
        const xlsx=await saveArtifact({data:Buffer.from(await book.xlsx.writeBuffer()),dirAbs:join(process.env.WORKBENCH_DATA_DIR!,'gate'),fileName:'缺事实.xlsx',title:'表格回归',kind:'generated'});
        assert.throws(()=>markFinal(xlsx.artifact.id,true),/必填/);
        const broken=await saveArtifact({data:new PizZip().generate({type:'nodebuffer'}),dirAbs:join(process.env.WORKBENCH_DATA_DIR!,'gate'),fileName:'缺正文.docx',title:'正文回归',kind:'generated'});
        assert.throws(()=>markFinal(broken.artifact.id,true),/正文/);
        imageZip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body></w:document>');
        const invalid=await saveArtifact({data:imageZip.generate({type:'nodebuffer'}),dirAbs:join(process.env.WORKBENCH_DATA_DIR!,'gate'),fileName:'损坏结构.docx',title:'结构回归',kind:'generated'});
        assert.throws(()=>markFinal(invalid.artifact.id,true),/XML 不合法/);
    });
    await test('补办旧年月的自动字段按报告期，缺少工作上下文拒绝', async () => { service.writeTemplateVars(template, { variables: ['年份', '月份', '报告期'].map(name => ({ name, type: 'text' as const })) }); const snap=JSON.parse(periods.requirePeriod(sep.id).snapshot);run('UPDATE work_period SET snapshot=? WHERE id=?',[JSON.stringify({...snap,templates:periods.periodTemplates(wb.id)}),sep.id]); const response = await app.inject({ method: 'GET', url: `/api/generate/fields/${template.id}?workbenchId=${wb.id}&periodId=${sep.id}` }); assert.equal(response.statusCode, 200); const vars = response.json().data.variables; assert.equal(vars.find((v: {
        name: string;
    }) => v.name === '月份').preset, '2026年9月'); assert.equal(vars.find((v: {
        name: string;
    }) => v.name === '报告期').preset, '2026-09'); assert.equal((await app.inject({ method: 'GET', url: `/api/generate/fields/${template.id}?periodId=${sep.id}` })).statusCode, 400); });
    await test('定稿文件丢失或材料关联缺失不能完成期次', () => { const snapshot = JSON.parse(oct.snapshot); run('UPDATE work_period SET snapshot=? WHERE id=?', [JSON.stringify({ ...snapshot, templates: [{ id: template.id }] }), oct.id]); run("UPDATE period_material SET status='na',note='样例豁免' WHERE period_id=?", [oct.id]); const a = get<import('../src/core/store.ts').Artifact>('SELECT * FROM artifact WHERE work_period_id=? AND is_final=1', [oct.id])!; const path = artifactAbsPath(a); renameSync(path, path + '.test-missing'); try {
        assert.throws(() => periods.updatePeriod(oct.id, { status: 'done' }), /待生成/);
    }
    finally {
        renameSync(path + '.test-missing', path);
    } run("UPDATE period_material SET status='verified',artifact_id=NULL WHERE period_id=?", [oct.id]); assert.throws(() => periods.updatePeriod(oct.id, { status: 'done' }), /关联文件/); run("UPDATE period_material SET status='na' WHERE period_id=?", [oct.id]); });
    await test('记忆排除过期、其他工作和其他期次', () => { for (const [text, wid, pid, until] of [['有效', wb.id, null, null], ['过期', wb.id, null, '2001-01-01'], ['其他工作', other.id, null, null], ['仅上期', wb.id, sep.id, null]] as const)
        run('INSERT INTO agent_memory(text,workbench_id,period_id,valid_until,confirmed) VALUES(?,?,?,?,1)', [text, wid, pid, until]); assert.deepEqual(relevantMemories(wb.id, '', 10, oct.id).map(m => m.text), ['有效']); });
    await test('局部更正记忆保留原有效期', async () => { const id = run("INSERT INTO agent_memory(text,valid_from,valid_until,confirmed) VALUES('日期记忆','2026-01-01','2026-12-31',1)").lastInsertRowid; assert.equal((await app.inject({ method: 'PUT', url: `/api/agent/memories/${id}`, payload: { text: '更正内容' } })).statusCode, 200); assert.equal(get<{
        valid_until: string;
    }>('SELECT valid_until FROM agent_memory WHERE id=?', [id])?.valid_until, '2026-12-31'); });
    await test('快速待办只需标题，完成操作可重复', async () => { const r = await app.inject({ method: 'POST', url: '/api/quick-todos', payload: { title: '匿名临时事项' } }); const id = r.json().data.id; assert.equal(r.statusCode, 201); for (let n = 0; n < 2; n++)
        assert.equal((await app.inject({ method: 'PUT', url: `/api/quick-todos/${id}`, payload: { status: 'done' } })).statusCode, 200); });
    const projectType = service.upsertWorkType({ code: 'project-example', name: '信息化项目（待配置骨架）', category: 'project', mode: 'process' });
    const stage = service.upsertPosition({ work_type_id: projectType, code: 'acceptance', name: '验收准备', seq: 1 });
    service.upsertMaterial({ position_template_id: stage, name: '交付材料', required: 1 });
    const project = service.createWorkbench({ name: '匿名项目', workTypeId: projectType });
    const pos = get<{
        id: number;
    }>('SELECT id FROM position_instance WHERE workbench_id=?', [project.id])!;
    await test('阶段完成受材料核对阻断', () => assert.throws(() => service.setPositionStatus(pos.id, 'done'), /未核对/));
    await test('项目不适用有原因后可完成阶段', async () => { const c = get<{
        id: number;
    }>('SELECT id FROM checklist_item WHERE position_instance_id=?', [pos.id])!; assert.equal((await app.inject({ method: 'PUT', url: `/api/checklist/${c.id}/review`, payload: { status: 'na', note: '匿名验收例外' } })).statusCode, 200); service.setPositionStatus(pos.id, 'done'); });
    await test('归档必备模板不会删除阶段缺项', () => {
        const pt=service.upsertWorkType({code:'required-doc-fix',name:'必备文书回归',category:'project',mode:'process'});
        const stage=service.upsertPosition({work_type_id:pt,code:'acceptance',name:'验收',seq:1});
        const doc=service.registerTemplate({absSourcePath:templateFile,name:'必备验收文书',workTypeId:pt});
        service.setPositionDocTemplates(stage,[{templateId:doc.id,required:1}]);
        const project=service.createWorkbench({name:'匿名必备项目',workTypeId:pt});
        const pos=get<{id:number}>('SELECT id FROM position_instance WHERE workbench_id=?',[project.id])!;
        assert.throws(()=>service.setPositionStatus(pos.id,'done'),/必备文书/);
        run("UPDATE template SET archived_at='2026-10-04' WHERE id=?",[doc.id]);
        assert.equal(service.listWorkbenchPositionDocs(project.id).items[0]?.requiredTotal,1);
        assert.throws(()=>service.setPositionStatus(pos.id,'done'),/必备文书/);
    });
    await test('记忆更正保留完整替代链和来源，历史不能重新启用', async () => {
        const id=run("INSERT INTO agent_memory(text,source,workbench_id,confirmed) VALUES('原事实','原始来源',?,1)",[wb.id]).lastInsertRowid;
        for(const text of ['第一次更正','第二次更正']) assert.equal((await app.inject({method:'PUT',url:`/api/agent/memories/${id}`,payload:{text,source:'核对记录'}})).statusCode,200);
        const items=(await app.inject({method:'GET',url:`/api/agent/memories/${id}/history`})).json().data.items;
        assert.deepEqual(items.map((x:{text:string})=>x.text),['第二次更正','第一次更正','原事实']);assert.equal(items[2].source,'原始来源');
        assert.equal((await app.inject({method:'PUT',url:`/api/agent/memories/${items[2].id}`,payload:{status:'active'}})).statusCode,400);
        assert.ok(!relevantMemories(wb.id,'原事实',200).some(m=>m.text==='原事实'));
    });
    await test('项目要求快照不随全局删除变化，单阶段应用须匹配预览', async () => {
        const pt=service.upsertWorkType({code:'snapshot-fix',name:'阶段快照回归',category:'project',mode:'process'});
        const stage=service.upsertPosition({work_type_id:pt,code:'stage',name:'阶段',seq:1});const doc=service.registerTemplate({absSourcePath:templateFile,name:'快照文书',workTypeId:pt});
        service.setPositionDocTemplates(stage,[{templateId:doc.id,required:1}]);
        const a=service.createWorkbench({name:'匿名快照甲',workTypeId:pt}), b=service.createWorkbench({name:'匿名快照乙',workTypeId:pt});
        const pos=get<{id:number}>('SELECT id FROM position_instance WHERE workbench_id=?',[a.id])!;
        service.setPositionDocTemplates(stage,[]);
        assert.equal(service.listWorkbenchPositionDocs(a.id).items[0]?.requiredTotal,1);assert.throws(()=>service.setPositionStatus(pos.id,'done'),/必备文书/);
        const preview=(await app.inject({method:'POST',url:`/api/positions/${pos.id}/doc-requirements`,payload:{}})).json().data;
        assert.equal((await app.inject({method:'POST',url:`/api/positions/${pos.id}/doc-requirements`,payload:{apply:true,expected:{}}})).statusCode,409);
        const applied=await app.inject({method:'POST',url:`/api/positions/${pos.id}/doc-requirements`,payload:{apply:true,expected:preview}});assert.equal(applied.statusCode,200,applied.body);
        assert.equal(service.listWorkbenchPositionDocs(a.id).items[0]?.requiredTotal,0);assert.equal(service.listWorkbenchPositionDocs(b.id).items[0]?.requiredTotal,1);
        assert.ok(get("SELECT id FROM workflow_event WHERE action='project-doc-requirements'"));
    });
    await test('结构化记忆冲突阻止直接定稿和旧定稿，选择与依据留痕', async () => {
        const id=run("INSERT INTO agent_memory(text,source,workbench_id,confirmed,fact_key,fact_value) VALUES('旧内容','历史核对记录',?,1,'本期内容','旧内容')",[other.id]).lastInsertRowid;
        const values={报告期:'2026-09',本期内容:'本期实际内容'};
        await assert.rejects(()=>saveGeneratedDocument({templateId:template.id,workbenchId:other.id,values,saveMode:'final'}),/来源冲突/);
        const draft=await saveGeneratedDocument({templateId:template.id,workbenchId:other.id,values,saveMode:'new'});assert.throws(()=>markFinal(draft.artifact.id,true),/来源冲突/);
        await assert.rejects(()=>saveGeneratedDocument({templateId:template.id,workbenchId:other.id,values,saveMode:'final',factChoices:{本期内容:{value:'错误值',reason:'核对'}}}),/来源冲突/);
        const confirmed=await saveGeneratedDocument({templateId:template.id,workbenchId:other.id,values,saveMode:'final',factChoices:{本期内容:{value:values.本期内容,reason:'已核对本期原始台账'}}});
        const audit=JSON.parse(get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[confirmed.artifact.id])!.snapshot);
        assert.equal(audit.conflicts[0].candidates[0].source,'历史核对记录');assert.equal(audit.choices.本期内容.reason,'已核对本期原始台账');
        const path=artifactAbsPath(confirmed.artifact), bytes=(await import('node:fs')).readFileSync(path);writeFileSync(path,Buffer.concat([bytes,Buffer.from('changed')]));
        try{assert.throws(()=>markFinal(confirmed.artifact.id,true),/确认已失效/);}finally{writeFileSync(path,bytes);}
        const history=await app.inject({method:'PUT',url:`/api/agent/memories/${id}`,payload:{fact_key:'本期内容',fact_value:'更正后值'}});assert.equal(history.statusCode,200,history.body);
        const old=get<{supersedes_id:number}>('SELECT supersedes_id FROM agent_memory WHERE id=?',[id])!;assert.equal(get<{fact_value:string}>('SELECT fact_value FROM agent_memory WHERE id=?',[old.supersedes_id])?.fact_value,'旧内容');
    });
    let requests = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { requests++; assert.equal(init?.redirect, 'error'); return new Response('{}'); };
    process.env.WORKBENCH_TEST_MODE = '0';
    try {
        await test('拒绝授权后没有任何网络发送', async () => { const call = fetchWithTimeout('https://model.invalid/v1/chat/completions', { method: 'POST', body: '{"model":"test","messages":[]}' }, 1000); const rejection = assert.rejects(call, /取消/); const r = consent.pendingRequests()[0]!; assert.ok(r); assert.equal(requests, 0); consent.decideRequest(r.id, r.digest, false); await rejection; assert.equal(requests, 0); });
        await test('内容摘要错误不能批准，批准后仅发送一次', async () => { const call = fetchWithTimeout('https://model.invalid/v1/embeddings', { method: 'POST', body: '{"model":"embed","input":"匿名测试"}' }, 1000); const r = consent.pendingRequests()[0]!; assert.throws(() => consent.decideRequest(r.id, 'wrong', true), /过期|变更/); consent.decideRequest(r.id, r.digest, true); await call; assert.equal(requests, 1); assert.throws(() => consent.decideRequest(r.id, r.digest, true)); assert.equal(get<{
            payload: string;
        }>('SELECT payload FROM ai_request WHERE id=?', [r.id])?.payload, ''); });
        await test('同样内容新调用仍须重新批准；过期不发送', async () => { const call = fetchWithTimeout('https://model.invalid/v1/embeddings', { method: 'POST', body: '{"model":"embed","input":"匿名测试"}' }, 1000); const rejection = assert.rejects(call, /超时|取消/); const r = consent.pendingRequests()[0]!; assert.ok(r); run("UPDATE ai_request SET expires_at='2000-01-01' WHERE id=?", [r.id]); await rejection; assert.equal(requests, 1); });
    }
    finally {
        globalThis.fetch = originalFetch;
        process.env.WORKBENCH_TEST_MODE = '1';
    }
    await test('重启遗留待发请求失效', () => { run("INSERT INTO ai_request(id,owner,target,purpose,model,payload,digest,created_at,expires_at) VALUES('old','previous-process','https://model.invalid','test','test','secret','hash','2000','2099')"); consent.pendingRequests(); assert.equal(get<{
        state: string;
    }>("SELECT state FROM ai_request WHERE id='old'")?.state, 'expired'); });
    for (const month of ['2026-02', '2024-02', '2026-04', '2026-07'])
        await test(`${month} 工时计算、28/29/30/31天导出、样式与源文件保护`, async () => {
            const days = timesheets.monthDays(month), book = new ExcelJS.Workbook(), sheet = book.addWorksheet('工时明细表（填写）');
            book.addWorksheet('保留说明').getCell('A1').value = '原始说明';
            sheet.getCell('A1').value = '2025年度1月';
            sheet.mergeCells('A1:E1');
            sheet.getCell('C5').value = '测试人员甲';
            sheet.getCell('D5').value = '部门工时';
            sheet.getCell('E5').value = '已成立项目甲';
            sheet.getCell('C5').font = { bold: true };
            sheet.getCell('C6').value='测试人员甲';sheet.getCell('D6').value='研发工时';sheet.getCell('E6').value='研发项目';sheet.getCell('I6').value=5;
            sheet.getCell(6,9+days).value={formula:`SUM(I6:${sheet.getColumn(8+days).letter}6)`,result:5};
            book.getWorksheet('保留说明')!.getCell('A2').value='历史说明：2025年度1月';
            for (let d = 1; d <= days; d++) {
                sheet.getCell(3, 8 + d).value = d;
                sheet.getCell(4, 8 + d).value = '星期一';
            }
            sheet.getCell(5, 9 + days).value = { formula: `SUM(I5:${sheet.getColumn(8 + days).letter}5)`, result: 0 };
            const bytes = Buffer.from(await book.xlsx.writeBuffer());
            const template = await timesheets.storeTimesheetSource('模板.xlsx', bytes);
            const rdBook = new ExcelJS.Workbook(), rd = rdBook.addWorksheet('研发');
            rd.addRow(['人员', '日期', '工时', '项目']);
            rd.addRow(['测试人员甲', month + '-01', 3, '研发甲']);
            rd.addRow(['测试人员甲', month + '-01', 2, '研发乙']);
            const rdSource = await timesheets.storeTimesheetSource('研发.xlsx', Buffer.from(await rdBook.xlsx.writeBuffer()));
            const attBook = new ExcelJS.Workbook(), att = attBook.addWorksheet('考勤');
            att.addRow(['人员', '日期', '状态', '项目']);
            for (let d = 1; d <= days; d++)
                att.addRow(['测试人员甲', `${month}-${String(d).padStart(2, '0')}`, d === 1 ? '工作' : d === 2 ? '请假' : '休息', '']);
            const attendance = await timesheets.storeTimesheetSource('考勤.xlsx', Buffer.from(await attBook.xlsx.writeBuffer()));
            const result = await timesheets.createTimesheetRun({ requiredPeople:['测试人员甲'],month, templateId: template.id, rdId: rdSource.id, attendanceId: attendance.id, rdMapping: { sheet: '研发', startRow: 2, personColumn: 1, dateColumn: 2, hoursColumn: 3, projectColumn: 4 }, attendanceMapping: { sheet: '考勤', startRow: 2, personColumn: 1, dateColumn: 2, statusColumn: 3, projectColumn: 4 }, projects: ['已成立项目甲'], assignments: { 测试人员甲: '已成立项目甲' }, rdComplete: true });
            assert.equal(result.canFinalize, true);
            assert.equal(result.days[0]?.department, 3);
            assert.equal(result.personTotals['测试人员甲'], 3);
            assert.equal(result.days[1]?.department, 0);
            const output = await timesheets.exportTimesheet(result.id);
            writeFileSync(join(tmp, `${month}-工时样例.xlsx`), output);
            const out = new ExcelJS.Workbook();
            await out.xlsx.load(output as never);
            assert.equal(out.getWorksheet('保留说明')?.getCell('A1').value, '原始说明');
            assert.equal(out.getWorksheet('工时明细表（填写）')?.getCell('I5').value, 3);
            assert.equal(out.getWorksheet('工时明细表（填写）')?.getCell('I6').value,5);
            assert.deepEqual(out.getWorksheet('工时明细表（填写）')?.getCell(6,9+days).value,{formula:`SUM(I6:${sheet.getColumn(8+days).letter}6)`,result:5});
            assert.equal(out.getWorksheet('保留说明')?.getCell('A2').value,'历史说明：2025年度1月');
            sheet.getCell('D6').value='未确认类型';assert.throws(()=>timesheets.departmentLayout(book,month),/工时类型/);
            assert.equal(out.getWorksheet('工时明细表（填写）')?.getCell('C5').font.bold, true);
            assert.equal(out.getWorksheet('工时明细表（填写）')?.getCell('A1').isMerged, true);
            assert.equal((await timesheets.readSource(template.id)).source.digest, template.digest);
        });
    await test('研发超额、未知考勤、未知项目与重复考勤均阻断', () => { const r = timesheets.calculateTimesheet({ month: '2026-02', people: ['甲'], projects: ['项目'], assignments: {}, rdComplete: true, rd: [{ person: '甲', date: '2026-02-01', hours: 9, source: '原始' }], attendance: [{ person: '甲', date: '2026-02-01', status: '半天', source: '考勤' }, { person: '甲', date: '2026-02-02', status: 'work', source: '考勤' }, { person: '甲', date: '2026-02-02', status: 'work', source: '重复' }] }); for (const code of ['RD_OVER_8', 'ATT_UNKNOWN', 'PROJECT_UNKNOWN', 'ATT_DUPLICATE', 'ATT_MISSING'])
        assert.ok(r.issues.some(i => i.code === code)); assert.equal(r.canFinalize, false); });
    await test('未知研发或考勤人员阻断，确认别名才正确扣除', () => {
        const input={month:'2026-02',people:['甲'],projects:['项目'],assignments:{甲:'项目'},rdComplete:true,rd:[{person:'甲简称',date:'2026-02-01',hours:8,source:'研发原表'}],attendance:Array.from({length:28},(_,i)=>({person:'甲',date:`2026-02-${String(i+1).padStart(2,'0')}`,status:i?'休息':'工作',source:'已核对考勤'}))};
        assert.equal(timesheets.calculateTimesheet(input).canFinalize,false);
        const mapped=timesheets.calculateTimesheet({...input,aliases:{甲简称:'甲'}});assert.equal(mapped.canFinalize,true);assert.equal(mapped.days[0]?.rd,8);assert.equal(mapped.days[0]?.department,0);
        const unrelated={...input,rd:[{...input.rd[0]!,person:'其他部门乙'}]};
        assert.equal(timesheets.calculateTimesheet({...unrelated,exclusions:{其他部门乙:'研发中心其他部门，经部门名册确认'}}).canFinalize,true);
        assert.equal(timesheets.calculateTimesheet({...unrelated,exclusions:{其他部门乙:''}}).canFinalize,false);
        assert.equal(timesheets.calculateTimesheet({...input,aliases:{甲简称:'不存在'}}).canFinalize,false);
        assert.equal(timesheets.calculateTimesheet({...input,exclusions:{甲:'不能排除本部门'}}).canFinalize,false);
        assert.equal(timesheets.calculateTimesheet({...input,rd:[],attendance:[...input.attendance,{...input.attendance[0]!,person:'新增乙'}]}).canFinalize,false);
    });
    await test('024/025 在旧结构副本升级时保留必备失效绑定和历史记忆', async () => {
        const old=new DatabaseSync(join(tmp,'upgrade-fixture.db'));
        try {
            old.exec("CREATE TABLE position_instance(id INTEGER PRIMARY KEY,position_template_id INTEGER);CREATE TABLE template(id INTEGER PRIMARY KEY,name TEXT,archived_at TEXT);CREATE TABLE position_template_doc(position_template_id INTEGER,template_id INTEGER,required INTEGER,seq INTEGER,deleted_at TEXT);CREATE TABLE agent_memory(id INTEGER PRIMARY KEY,text TEXT);CREATE TABLE artifact(id INTEGER PRIMARY KEY);");
            old.exec("INSERT INTO position_instance VALUES(1,2);INSERT INTO template VALUES(3,'已归档必备','2026-01-01');INSERT INTO position_template_doc VALUES(2,3,1,10,NULL);INSERT INTO agent_memory VALUES(1,'旧记忆');");
            const {readFileSync}=await import('node:fs');
            old.exec(readFileSync(resolve('packages/server/src/db/migrations/024_project_doc_snapshot.sql'),'utf8'));
            old.exec(readFileSync(resolve('packages/server/src/db/migrations/025_memory_facts.sql'),'utf8'));
            assert.equal(JSON.parse((old.prepare('SELECT doc_requirements FROM position_instance').get() as {doc_requirements:string}).doc_requirements)[0].required,1);
            assert.equal((old.prepare('SELECT text FROM agent_memory').get() as {text:string}).text,'旧记忆');
            assert.equal(Object.values(old.prepare('PRAGMA quick_check').get()!)[0],'ok');
        }finally{old.close();}
    });
    await test('隔离数据库迁移、在线备份与恢复副本完整性', async () => { const before = all('SELECT id,report_period,workbench_id FROM work_period ORDER BY id'); const file = join(tmp, 'backup.db'); await backup(getDb(), file); const copy = new DatabaseSync(file); assert.deepEqual(copy.prepare('SELECT id,report_period,workbench_id FROM work_period ORDER BY id').all(), before); assert.equal(Object.values(copy.prepare('PRAGMA quick_check').get()!)[0], 'ok'); assert.equal(copy.prepare('PRAGMA foreign_key_check').all().length, 0); copy.close(); });
    await test('实际恢复流程保留新表和关联，并生成恢复前备份', async () => { const { createBackup, restoreBackup } = await import('../src/core/backup.ts'); const dir = join(tmp, 'backups'), before = all('SELECT * FROM work_period ORDER BY id'); const snap = await createBackup({ dir, kind: 'manual', skipPrune: true }); assert.equal(snap.ok, true); run("INSERT INTO quick_todo(title) VALUES('恢复后应不存在的测试事项')"); const report = await restoreBackup(snap.name, { dir }); assert.equal(report.verify.ok, true); assert.equal(report.rolledBack, false); assert.equal(report.preRestore?.ok, true); assert.deepEqual(all('SELECT * FROM work_period ORDER BY id'), before); assert.equal(get("SELECT id FROM quick_todo WHERE title='恢复后应不存在的测试事项'"), undefined); });
    writeFileSync(join(tmp, '验证记录.json'), JSON.stringify({ checks, passed: checks.length, scope: '匿名样例；没有真实业务或外部请求', output: tmp }, null, 2));
    console.log(`工作流测试：${checks.length} 项通过；样例与验证记录：${tmp}`);
}
finally {
    await app.close();
    closeDatabase();
}
