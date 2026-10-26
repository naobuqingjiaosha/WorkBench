import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import PizZip from 'pizzip';
import ExcelJS from 'exceljs';

mkdirSync(resolve('.tmp'), { recursive: true });
const tmp = process.env.WORKBENCH_ISOLATION_ROOT!;


process.env.WORKBENCH_TEST_MODE = '1';
const { bootstrap } = await import('../src/core/bootstrap.ts');
bootstrap();
const { get, run, closeDatabase } = await import('../src/db/index.ts');
const service = await import('../src/domain/service.ts');
const kb = await import('../src/core/kb.ts');
const { searchKnowledge } = await import('../src/core/knowledge.ts');
const policy = await import('../src/domain/policy-requirements.ts');
const { generateVariables, saveGeneratedDocument } = await import('../src/domain/generate.ts');
const { markFinal, rollbackToRevision } = await import('../src/domain/versions.ts');
const { assertFinalArtifact } = await import('../src/domain/finalization.ts');
const { artifactAbsPath } = await import('../src/core/store.ts');
const { upsertProvider, upsertProfile } = await import('../src/ai/providers.ts');
const { embeddingSignature } = await import('../src/ai/gateway.ts');
const { registerGenerateRoutes } = await import('../src/api/routes-generate.ts');
const { registerKbRoutes } = await import('../src/api/routes-kb.ts');
const { requestsPolicyReference } = await import('../src/domain/policy-reference.ts');
const { runAgentTurn } = await import('../src/domain/agent.ts');
const app = (await import('fastify')).default();
registerGenerateRoutes(app);
registerKbRoutes(app);
const originalFetch = globalThis.fetch;
let prompt = '', calls = 0, failEmbedding = false;
let scripted: Record<string, unknown>[] = [];
globalThis.fetch = async (_input, init) => {
  // 所有请求在内存里模拟，不监听端口、不发送任何资料。
  const body = JSON.parse(String(init?.body)) as { messages?: { content: string }[]; input?: string[] };
  calls++;
  if (body.input) {
    if (failEmbedding) throw new Error('模拟向量模型不可用');
    return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0] })) }));
  }
  prompt = body.messages!.map(m => m.content).join('\n');
  if (scripted.length) return new Response(JSON.stringify({ choices: [{ message: scripted.shift() }], usage: {} }));
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ 本期内容: '已核对的事实', _依据: { 本期内容: '来自本次资料' } }) } }], usage: {} }));
};
let passed = 0;
async function test(name: string, fn: () => unknown | Promise<unknown>) {
  await fn(); passed++; console.log('✓ ' + name);
}
try {
  const type = service.upsertWorkType({ code: 'policy-test', name: '匿名制度验证', category: 'project', mode: 'document' });
  const wb = service.createWorkbench({ name: '匿名制度工作', workTypeId: type });
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>历史示例人数99，本期内容：{本期内容}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  const source = join(tmp, '检查报告.docx');
  writeFileSync(source, zip.generate({ type: 'nodebuffer' }));
  const template = service.registerTemplate({ absSourcePath: source, name: '安全检查报告', workTypeId: type });
  const id = kb.upsertKbDocument({ title: '安全检查管理办法', docType: '制度规范' });
  kb.indexDocumentText(id, '第一条 检查要求\n每月开展安全检查，并按实际记录填写检查情况，不得将制度规定当作本次完成事实。');
  run("UPDATE kb_document SET scope_layer='unit',version_status='current' WHERE id=?", [id]);
  const otherId = kb.upsertKbDocument({ title: '材料归档办法', docType: '制度规范' });
  kb.indexDocumentText(otherId, '第二条 归档要求\n材料归档应保留真实来源并按期次归档，历史文书不能替代本次事实。');
  const citation = '依据《安全检查管理办法》第一条，按本期实际检查记录填写。';
  const required = { mode: 'required' as const, documentIds: [id] };
  const provider = upsertProvider({ code: 'policy-mock', name: '内存模拟', base_url: 'http://127.0.0.1:1/v1', enabled: 1 });
  upsertProfile({ purpose: 'writing', name: '写作模拟', provider_id: provider, model: 'mock' });
  upsertProfile({ purpose: 'agent', name: '聊天模拟', provider_id: provider, model: 'mock' });
  await test('仅当前直接请求可启用，否定、转述和引号不触发', () => {
    for (const text of ['帮我参考制度', '请帮我参考制度，写安全检查报告', '安全检查，帮我参考制度']) assert.equal(requestsPolicyReference(text), true, text);
    for (const text of ['', '参考制度', '不要帮我参考制度', '以后只有说帮我参考制度才启用', '说明“帮我参考制度”的含义']) assert.equal(requestsPolicyReference(text), false, text);
  });
  await test('新模板默认关闭制度，旧设置接口仍可读取', async () => {
    const result = await app.inject({ method: 'GET', url: `/api/generate/policy/${template.id}` });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().data.requirement.mode, 'off');
    assert.ok(result.json().data.documents.some((d: { id: number }) => d.id === id));
    const update = await app.inject({ method: 'PUT', url: `/api/generate/policy/${template.id}`, payload: { mode: 'reference', documentIds: [id] } });
    assert.equal(update.statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/generate/policy/${template.id}` })).json().data.requirement.documentIds, [id]);
    policy.setPolicyRequirement(template.id, { mode: 'reference', documentIds: [] });
  });
  await test('未向量化制度也能全文检索，返回条款路径与原文', async () => {
    const result = await searchKnowledge('安全检查', { modules: ['policy'] });
    assert.equal(result.hits[0]?.documentId, id);
    assert.equal(result.hits[0]?.retrieval, 'fulltext');
    assert.ok(result.hits[0]?.heading?.includes('第一条'));
    assert.ok(result.hits[0]?.snippet.includes('每月开展'));
    assert.equal(calls, 0);
  });
  await test('旧上传数据缺少FTS时自动补齐本地索引', async () => {
    run('DELETE FROM kb_chunk_search WHERE document_id=?', [id]);
    assert.ok((await searchKnowledge('安全检查', { modules: ['policy'] })).hits.some(h => h.documentId === id));
  });
  await test('明确请求只对本轮发送制度依据', async () => {
    const result = await generateVariables({ templateId: template.id, workbenchId: wb.id, instruction: '帮我参考制度，安全检查' });
    assert.equal(result.ok, true);
    assert.ok(result.knowledge.some(h => h.documentId === id));
    assert.ok(result.knowledge.every(h => h.source !== '模板库'));
    assert.ok(prompt.includes('选定模板的结构与格式'));
    assert.ok(prompt.includes('不能作为本期事实或制度规定'));
    assert.ok(prompt.includes('不得把规定写成已完成的事实'));
  });
  await test('下一轮默认关闭，即使旧模板设置仍为参考', async () => {
    policy.setPolicyRequirement(template.id, { mode: 'reference', documentIds: [id] });
    run('DELETE FROM kb_chunk_search WHERE document_id=?', [id]);
    const result = await generateVariables({ templateId: template.id, workbenchId: wb.id, instruction: '安全检查' });
    assert.equal(result.knowledge.length, 0);
    assert.ok(!prompt.includes('每月开展安全检查'));
    assert.equal(get<{n:number}>('SELECT count(*) AS n FROM kb_chunk_search WHERE document_id=?', [id])!.n, 0);
    assert.equal((await searchKnowledge('安全检查')).counts.policy, 0);
  });
  await test('普通接口请求不能用旧布尔参数启用制度', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/generate/draft', payload: {
      templateId: template.id, workbenchId: wb.id, instruction: '安全检查', useKnowledge: true,
    } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().data.knowledge, []);
    assert.ok(!prompt.includes('每月开展安全检查'));
  });
  await test('预览和保存不隐式执行制度校验或建链', async () => {
    const payload = { templateId: template.id, workbenchId: wb.id, values: { 本期内容: '依据《不存在的制度》第九十九条' } };
    const preview = await app.inject({ method: 'POST', url: '/api/generate/preview', payload: { ...payload, want: 'plan' } });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().data.compliance, undefined);
    const saved = await app.inject({ method: 'POST', url: '/api/generate/save', payload });
    assert.equal(saved.statusCode, 201);
    assert.equal(saved.json().data.citationLinks, undefined);
  });
  await test('聊天明确请求可查制度，下一轮同名工具只能查模板且不回灌旧制度', async () => {
    const tool = { role: 'assistant', content: '', tool_calls: [{ id: 'knowledge-test', type: 'function', function: {
      name: 'search_knowledge', arguments: JSON.stringify({ query: '安全检查' }),
    } }] };
    scripted = [tool, { role: 'assistant', content: '本轮制度原文标记：每月开展安全检查' }];
    const enabled = await runAgentTurn({ message: '帮我参考制度，安全检查', workbenchId: wb.id });
    assert.ok(prompt.includes('每月开展安全检查'));
    assert.ok(enabled.trace.some(t => t.result?.includes('每月开展安全检查')));
    scripted = [tool, { role: 'assistant', content: '普通生成完成' }];
    await runAgentTurn({ sessionId: enabled.sessionId, message: '继续写普通报告', workbenchId: wb.id });
    assert.ok(!prompt.includes('每月开展安全检查'));
    assert.ok(!prompt.includes('本轮制度原文标记'));
  });
  await test('指定制度独占检索范围，多份必查制度不被五条名额挤掉', async () => {
    const ids = [id, otherId];
    for (let i = 0; i < 5; i++) {
      const doc = kb.upsertKbDocument({ title: `其他必查制度${i}` });
      kb.indexDocumentText(doc, '第三条\n应当保留全部审批材料与实际工作记录，不得以历史模板示例替代实际事实。'); ids.push(doc);
    }
    const result = await searchKnowledge('安全检查', { modules: ['policy'], budget: 5, documentIds: ids });
    for (const doc of ids) assert.ok(result.hits.some(h => h.documentId === doc));
    assert.ok((await searchKnowledge('安全检查', { modules: ['policy'], documentIds: [otherId] })).hits.every(h => h.documentId === otherId));
  });
  await test('失效和历史制度不会检索为依据', async () => {
    run("UPDATE kb_document SET decision='stale' WHERE id=?", [id]);
    assert.equal((await searchKnowledge('安全检查', { modules: ['policy'], documentIds: [id] })).hits.length, 0);
    run("UPDATE kb_document SET decision='active',version_status='superseded' WHERE id=?", [id]);
    assert.equal((await searchKnowledge('安全检查', { modules: ['policy'], documentIds: [id] })).hits.length, 0);
    run("UPDATE kb_document SET version_status='current' WHERE id=?", [id]);
  });
  await test('模式、制度编号和外单位参考制度由服务端校验', async () => {
    for (const input of [{ mode: 'unknown', documentIds: [] }, { mode: 'required', documentIds: [-1] }, { mode: 'required', documentIds: [999999] }]) {
      assert.throws(() => policy.setPolicyRequirement(template.id, input));
    }
    run("UPDATE kb_document SET scope_layer='reference' WHERE id=?", [otherId]);
    assert.throws(() => policy.setPolicyRequirement(template.id, { mode: 'required', documentIds: [otherId] }), /外单位/);
    policy.setPolicyRequirement(template.id, { mode: 'reference', documentIds: [otherId] });
    assert.equal((await searchKnowledge('材料归档', { modules: ['policy'], documentIds: [otherId], authorityOnly: true })).hits.length, 0);
  });
  await test('旧必查设置与失效制度不影响默认生成', async () => {
    policy.setPolicyRequirement(template.id, required);
    run("UPDATE kb_document SET decision='stale' WHERE id=?", [id]);
    const before = calls;
    const result = await generateVariables({ templateId: template.id, workbenchId: wb.id });
    assert.equal(result.knowledge.length, 0);
    assert.equal(calls, before + 1);
    const manual = await generateVariables({ templateId: template.id, workbenchId: wb.id, skipAi: true, known: { 本期内容: '手填内容' } });
    assert.equal(manual.ok, true); assert.equal(calls, before + 1);
    run("UPDATE kb_document SET decision='active' WHERE id=?", [id]);
  });
  await test('默认定稿不会继承模板必查制度要求', async () => {
    const before = get<{ n: number }>("SELECT count(*) AS n FROM artifact WHERE kind='generated'")!.n;
    const saved = await saveGeneratedDocument({ templateId: template.id, workbenchId: wb.id, values: { 本期内容: '事实已填但没有依据' }, saveMode: 'final' });
    assert.equal(saved.artifact.is_final, 1);
    assert.equal(JSON.parse(get<{snapshot:string}>('SELECT snapshot FROM artifact_policy_requirement WHERE artifact_id=?', [saved.artifact.id])!.snapshot).mode, 'off');
    assert.equal(get<{ n: number }>("SELECT count(*) AS n FROM artifact WHERE kind='generated'")!.n, before + 1);
  });
  await test('草稿可以保存，但旧版定稿入口不能绕过且状态不变', async () => {
    const draft = await saveGeneratedDocument({ templateId: template.id, workbenchId: wb.id, values: { 本期内容: '手填事实' } });
    // 模拟旧版文书已经保存的必查快照，验证历史数据完整性。
    run('UPDATE artifact_policy_requirement SET snapshot=? WHERE artifact_id=?', [JSON.stringify(required), draft.artifact.id]);
    const before = get('SELECT is_final,version_group FROM artifact WHERE id=?', [draft.artifact.id]);
    assert.throws(() => markFinal(draft.artifact.id, true), /必须参考制度/);
    assert.deepEqual(get('SELECT is_final,version_group FROM artifact WHERE id=?', [draft.artifact.id]), before);
    const updated = await saveGeneratedDocument({ templateId: template.id, workbenchId: wb.id, values: { 本期内容: '另一版手填事实' }, saveMode: 'update' });
    policy.setPolicyRequirement(template.id, { mode: 'off', documentIds: [] });
    assert.throws(() => markFinal(draft.artifact.id, true), /必须参考制度/);
    const rolled = await rollbackToRevision(updated.artifact.id, 1);
    assert.throws(() => markFinal(rolled.artifactId, true), /必须参考制度/);
    policy.setPolicyRequirement(template.id, required);
  });
  await test('实际正文中有效引用才能定稿，文件变化会重新核对', async () => {
    const saved = await saveGeneratedDocument({ templateId: template.id, workbenchId: wb.id, values: { 本期内容: citation }, saveMode: 'final' });
    assert.equal(saved.artifact.is_final, 1);
    run('UPDATE artifact_policy_requirement SET snapshot=? WHERE artifact_id=?', [JSON.stringify(required), saved.artifact.id]);
    assertFinalArtifact(saved.artifact);
    const path = artifactAbsPath(saved.artifact), bytes = readFileSync(path);
    const altered = new PizZip(bytes);
    altered.file('word/document.xml', altered.file('word/document.xml')!.asText().replace('第一条', '第九十九条'));
    writeFileSync(path, altered.generate({ type: 'nodebuffer' }));
    assert.throws(() => assertFinalArtifact(saved.artifact), /必须参考制度/);
    writeFileSync(path, bytes);
  });
  await test('每份指定必查制度都要有效引用，只有检索命中不能定稿', () => {
    assert.throws(() => policy.assertPolicyCitations({ mode: 'required', documentIds: [id, otherId] }, citation), /尚未引用/);
    assert.throws(() => policy.assertPolicyCitations(required, citation + '依据《不存在的制度》第二条'), /缺失/);
  });
  await test('已引用制度失效后完成检查仍会阻断', () => {
    run("UPDATE kb_document SET decision='stale' WHERE id=?", [id]);
    assert.throws(() => policy.assertPolicyCitations(required, citation), /必须参考制度/);
    run("UPDATE kb_document SET decision='active' WHERE id=?", [id]);
  });
  await test('Excel 富文本与Word拆分文本引用按实际成品核对', async () => {
    const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('依据');
    sheet.getCell('A1').value = { richText: [{ text: '依据《安全检查管理办法》' }, { text: '第一条' }] };
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    policy.assertPolicyCitations(required, policy.policyTextFromBytes(bytes, '.xlsx'));
    const unused = new PizZip(bytes);
    unused.file('xl/worksheets/sheet1.xml', unused.file('xl/worksheets/sheet1.xml')!.asText().replace(/<c\b[^>]*>[\s\S]*?<\/c>/g, ''));
    assert.throws(() => policy.assertPolicyCitations(required, policy.policyTextFromBytes(unused.generate({ type: 'nodebuffer' }), '.xlsx')), /必须参考制度/);
    const split = new PizZip(zip.generate({ type: 'nodebuffer' }));
    split.file('word/document.xml', '<w:document><w:p><w:r><w:t>《安全检查管理办法》</w:t></w:r><w:r><w:t>第一条</w:t></w:r></w:p></w:document>');
    policy.assertPolicyCitations(required, policy.policyTextFromBytes(split.generate({ type: 'nodebuffer' }), '.docx'));
  });
  await test('即使存在旧向量和可用向量服务，制度检索仍只查询本地原文', async () => {
    upsertProfile({ purpose: 'embedding', name: '向量模拟', provider_id: provider, model: 'mock-embed', embedding_dim: 2 });
    const row = get<{ id: number }>('SELECT id FROM kb_chunk WHERE document_id=?', [id])!;
    run('UPDATE kb_chunk SET embedding=?,embedding_model=? WHERE id=?', [kb.encodeVector([1, 0]), embeddingSignature(), row.id]);
    kb.invalidateCache(); failEmbedding = true;
    const before = calls;
    const hit = (await searchKnowledge('安全检查', { modules: ['policy'], documentIds: [id] })).hits[0]!;
    assert.equal(hit.retrieval, 'fulltext'); assert.ok(hit.heading?.includes('第一条'));
    assert.equal(calls, before);
    const apiSearch = await app.inject('/api/kb/search?mode=semantic&q=' + encodeURIComponent('安全检查'));
    assert.equal(apiSearch.json().data.mode, 'fulltext');
    assert.ok(apiSearch.json().data.merged.some((h: {documentId:number}) => h.documentId === id));
    assert.equal(calls, before);
    const disabled = await app.inject({ method: 'POST', url: '/api/kb/documents/' + id + '/embed', payload: {} });
    assert.equal(disabled.statusCode, 410); assert.equal(calls, before);
    const generated = await generateVariables({ templateId: template.id, workbenchId: wb.id, instruction: '帮我参考制度，安全检查' });
    assert.ok(generated.knowledge.some(h => h.documentId === id));
    assert.equal(calls, before + 1); // 只有写作请求，无向量请求。
  });
  console.log(`制度生成测试：${passed} 项通过；隔离目录：${tmp}`);
} finally {
  globalThis.fetch = originalFetch;
  await app.close(); closeDatabase();
}
