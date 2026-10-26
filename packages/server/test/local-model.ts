import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import PizZip from 'pizzip';

mkdirSync(resolve('.tmp'), { recursive: true });
const tmp = process.env.WORKBENCH_ISOLATION_ROOT!;


process.env.WORKBENCH_TEST_MODE = '1';
const { bootstrap } = await import('../src/core/bootstrap.ts');
bootstrap();
const { get, closeDatabase } = await import('../src/db/index.ts');
const { getProvider, getProfile, maskProvider } = await import('../src/ai/providers.ts');
const { localModelBase } = await import('../src/ai/local-model.ts');
const { resolveTarget, chat, embed } = await import('../src/ai/gateway.ts');
const { registerAiRoutes } = await import('../src/api/routes-ai.ts');
const { registerGenerateRoutes } = await import('../src/api/routes-generate.ts');
const { registerTemplate } = await import('../src/domain/service.ts');
const app = (await import('fastify')).default();
registerAiRoutes(app); registerGenerateRoutes(app);
const requests: { path: string; authorization?: string; body: Record<string, unknown> }[] = [];
let listMode = 'ok', failChat = false;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
  requests.push({ path: req.url!, authorization: req.headers.authorization, body });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/models') {
    if (listMode === 'auth') { res.writeHead(401); res.end('{}'); return; }
    if (listMode === 'bad') { res.end(JSON.stringify({ unexpected: [] })); return; }
    if (listMode === 'redirect') { res.writeHead(302, { Location: 'https://example.com' }); res.end('{}'); return; }
    res.end(JSON.stringify({ data: [{ id: 'local-text' }, { id: 'local-embed' }, { id: 'local-text' }, { id: null }] })); return;
  }
  if (req.url === '/v1/embeddings') {
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }], usage: { total_tokens: 1 } })); return;
  }
  if (req.url === '/v1/chat/completions') {
    if (failChat) { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'local model unavailable' } })); return; }
    const message = body.tools ? { content: '', tool_calls: [{ id: 'local-tool', type: 'function', function: { name: 'get_time', arguments: '{}' } }] }
      : { content: body.response_format ? JSON.stringify({ 内容: '本地生成正文', _依据: { 内容: '本次资料' } }) : '本地模型回复' };
    res.end(JSON.stringify({ choices: [{ message, finish_reason: body.tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return;
  }
  res.writeHead(404); res.end('{}');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let passed = 0;
async function check(name: string, test: () => void | Promise<void>) { await test(); passed++; console.log('✓ ' + name); }
try {
  await check('LM Studio 预置配置停用且无云端绑定变更', () => {
    assert.equal(getProvider('lmstudio')?.base_url, 'http://127.0.0.1:1234/v1');
    assert.equal(getProvider('lmstudio')?.enabled, 0);
    assert.equal(getProvider(getProfile('writing')!.provider_id!)?.code, 'deepseek');
  });
  await check('本机地址补齐 /v1，IPv6 与自定义端口可用', () => {
    assert.equal(localModelBase(baseUrl + '/'), baseUrl + '/v1');
    assert.equal(localModelBase('http://[::1]:1235/v1/'), 'http://[::1]:1235/v1');
  });
  await check('外部地址、错误路径及携带凭据的地址在联网前拒绝', async () => {
    const count = requests.length;
    for (const url of ['https://example.com/v1', 'http://user:secret@localhost:1234', 'http://localhost:1234/api/v1', 'http://localhost:1234/v1?key=x', 'file:///tmp', 'http://localhost:1234/v1#x']) {
      assert.equal((await app.inject({ method: 'POST', url: '/api/ai/local/models', payload: { baseUrl: url } })).statusCode, 400);
    }
    assert.equal(requests.length, count);
  });
  await check('未保存的本机连接可发现模型，不发送虚构 Key 或改动配置', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/ai/local/models', payload: { baseUrl } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().data.models, ['local-embed', 'local-text']);
    assert.equal(requests.at(-1)!.authorization, undefined);
    assert.equal(getProvider('lmstudio')?.enabled, 0);
  });
  await check('身份验证、异常响应和重定向返回明确错误', async () => {
    for (const [mode, status] of [['auth', 401], ['bad', 502], ['redirect', 503]] as const) {
      listMode = mode;
      assert.equal((await app.inject({ method: 'POST', url: '/api/ai/local/models', payload: { baseUrl } })).statusCode, status);
    }
    listMode = 'ok';
  });
  await check('一次切换文本用途，未指定图像和向量用途不沿用云端', async () => {
    const result = await app.inject({ method: 'PUT', url: '/api/ai/local', payload: { baseUrl, model: 'local-text' } });
    assert.equal(result.statusCode, 200);
    for (const purpose of ['writing', 'extract', 'reasoning', 'agent'] as const) {
      assert.equal(resolveTarget(purpose).provider.code, 'lmstudio');
      assert.equal(resolveTarget(purpose).model, 'local-text');
    }
    assert.throws(() => resolveTarget('vision'), /还没有指定/);
    assert.throws(() => resolveTarget('embedding'), /还没有指定/);
  });
  await check('无效模型配置不部分修改已保存配置', async () => {
    const before = getProfile('writing');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/ai/local', payload: { baseUrl, model: 'changed', embeddingModel: 'x'.repeat(201) } })).statusCode, 400);
    assert.deepEqual(getProfile('writing'), before);
  });
  await check('对话通过本机兼容接口执行且不产生外发确认', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/ai/chat', payload: { message: '本机测试' } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().data.text, '本地模型回复');
    assert.equal(requests.at(-1)!.path, '/v1/chat/completions');
    assert.equal(requests.at(-1)!.body.model, 'local-text');
    assert.equal(requests.at(-1)!.body.stream, false);
    assert.equal(get<{ n: number }>('SELECT count(*) AS n FROM ai_request')!.n, 0);
  });
  await check('文书生成流程使用本地模型 JSON 输出', async () => {
    const zip = new PizZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文：{内容}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
    const path = join(tmp, 'local-template.docx'); writeFileSync(path, zip.generate({ type: 'nodebuffer' }));
    const template = registerTemplate({ absSourcePath: path, name: '本地接口测试' });
    const result = await app.inject({ method: 'POST', url: '/api/generate/draft', payload: { templateId: template.id, instruction: '根据本次资料填写' } });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().data.variables.内容, '本地生成正文');
    assert.deepEqual(result.json().data.knowledge, []);
  });
  await check('AI 助手工具调用通过本机模型返回', async () => {
    const result = await app.inject({ method: 'POST', url: '/api/ai/profiles/agent/test', payload: {} });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().data.toolCalling, true);
  });
  await check('Token 被正确发送和脱敏，向量维度不会继承旧服务', async () => {
    await app.inject({ method: 'PUT', url: '/api/ai/local', payload: { baseUrl, model: 'local-text', apiKey: 'local-test-token', visionModel: 'local-vision', embeddingModel: 'local-embed' } });
    assert.equal(getProfile('embedding')?.embedding_dim, null);
    assert.equal(resolveTarget('vision').model, 'local-vision');
    assert.equal((await embed(['本机向量测试'])).ok, true);
    assert.equal(requests.at(-1)!.authorization, 'Bearer local-test-token');
    const list = await app.inject({ method: 'POST', url: '/api/ai/local/models', payload: { baseUrl } });
    assert.equal(list.statusCode, 200);
    assert.equal(requests.at(-1)!.authorization, 'Bearer local-test-token');
    assert.equal(maskProvider(getProvider('lmstudio')!).api_key, null);
    assert.ok(!(await app.inject('/api/ai/providers')).body.includes('local-test-token'));
  });
  await check('本地模型失败不会回退到云端', async () => {
    failChat = true; const before = requests.length;
    const result = await chat({ messages: [{ role: 'user', content: '本机失败测试' }] });
    assert.equal(result.ok, false);
    assert.equal(result.providerCode, 'lmstudio');
    assert.equal(requests.length, before + 1);
  });
  await check('本地服务关闭时返回连接错误，仍保留原配置', async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const before = getProfile('writing');
    const result = await app.inject({ method: 'POST', url: '/api/ai/local/models', payload: { baseUrl } });
    assert.equal(result.statusCode, 503);
    assert.equal(result.json().error.code, 'LOCAL_UNAVAILABLE');
    assert.deepEqual(getProfile('writing'), before);
  });
  console.log(`LM Studio 接口测试：${passed} 项通过；隔离目录：${tmp}`);
} finally {
  await app.close();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  closeDatabase();
}
