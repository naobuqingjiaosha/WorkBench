import './isolated-guard.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import PizZip from 'pizzip';

const base = process.env.BASE!;
let embeddings = 0, chats = 0, lastPrompt = '', passed = 0;
const mock = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += String(part);
  res.setHeader('Content-Type', 'application/json');
  if (req.url?.endsWith('/embeddings')) { embeddings++; res.writeHead(500); res.end('{}'); return; }
  if (req.url?.endsWith('/models')) { res.end(JSON.stringify({ data: [{ id: 'local-policy' }] })); return; }
  chats++; lastPrompt = raw;
  res.end(JSON.stringify({ choices: [{ message: { content: '应留存设备铭牌与序列号照片。[资料1]' }, finish_reason: 'stop' }] }));
});
await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
const mockBase = 'http://127.0.0.1:' + (mock.address() as {port:number}).port + '/v1';
async function api(path: string, method = 'GET', body?: Record<string,unknown> | FormData) {
  const result = await fetch(base + path, { method,
    headers: body instanceof FormData || !body ? undefined : { 'Content-Type': 'application/json' },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  return { status: result.status, data: await result.json() as any };
}
function check(name: string, test: () => void) { test(); passed++; console.log('✓ ' + name); }
const originalProfiles = (await api('/api/ai/profiles')).data.data.items;
let providerId: number | undefined;
try {
  const provider = await api('/api/ai/providers', 'POST', { code: 'keyword-test', name: '关键词隔离模型', baseUrl: mockBase, enabled: 1 });
  providerId = provider.data.data.id;
  for (const purpose of ['writing', 'embedding']) await api('/api/ai/profiles/' + purpose, 'PUT',
    { name: purpose, providerId, model: 'local-policy' });
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const originalText = '第一条 为规范设备验收管理，特制定本制度。第二条 验收时应核对设备铭牌与序列号，并保留照片。第三条 原文和验收记录应在本机保管。';
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + originalText + '</w:t></w:r></w:p><w:sectPr/></w:body></w:document>');
  const bytes = zip.generate({ type: 'nodebuffer' });
  const form = new FormData();
  form.append('file', new Blob([bytes], {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}), '验收制度.docx');
  form.append('path', '匿名制度/验收制度.docx');
  const uploaded = await api('/api/kb/upload', 'POST', form);
  check('上传保留原文和目录，未触发向量化', () => {
    assert.equal(uploaded.status, 201); assert.equal(uploaded.data.data.items[0].chars > 20, true);
    assert.ok(uploaded.data.data.items[0].file_rel.includes('匿名制度/')); assert.equal(embeddings, 0);
  });
  const artifactId = uploaded.data.data.items[0].id;
  const imported = await api('/api/kb/import', 'POST', {artifactId, embed:true});
  const documentId = imported.data.data.documentId;
  check('旧客户端要求向量化也只建本地全文索引', () => {
    assert.equal(imported.status, 201); assert.ok(imported.data.data.chunks > 0);
    assert.equal(imported.data.data.embedded, 0); assert.equal(embeddings, 0);
  });
  for (const mode of ['fulltext', 'semantic', 'hybrid']) {
    const searched = await api('/api/kb/search?mode=' + mode + '&q=' + encodeURIComponent('序列号'));
    check(mode + ' 请求统一走关键词并返回原文', () => {
      assert.equal(searched.status, 200); assert.equal(searched.data.data.mode, 'fulltext');
      assert.ok(searched.data.data.merged.some((hit:any) => hit.documentId === documentId && hit.snippet.includes('序列号')));
      assert.deepEqual(searched.data.data.semantic, []); assert.equal(embeddings, 0);
    });
  }
  const named = await api('/api/kb/search?q=' + encodeURIComponent('匿名制度/验收制度'));
  check('制度名称可以定位原文', () => assert.ok(named.data.data.merged.some((hit:any) => hit.documentId === documentId)));
  const disabled = await api('/api/kb/documents/' + documentId + '/embed', 'POST', {});
  check('旧向量接口明确停用且无模型请求', () => { assert.equal(disabled.status, 410); assert.equal(embeddings, 0); });
  const ask = await api('/api/kb/ask', 'POST', {question:'序列号应如何留存？'});
  check('制度问答使用本地原文与本地写作模型', () => {
    assert.equal(ask.status, 200, JSON.stringify(ask.data)); assert.ok(ask.data.data.citations.length > 0);
    assert.ok(lastPrompt.includes('设备铭牌')); assert.equal(chats, 1); assert.equal(embeddings, 0);
  });
  const cloud = await api('/api/ai/providers', 'POST', { code:'keyword-cloud-test', name:'禁止外发测试', baseUrl:'https://example.com/v1', apiKey:'fake', enabled:1 });
  await api('/api/ai/profiles/writing', 'PUT', {name:'写作',providerId:cloud.data.data.id,model:'fake'});
  const blocked = await api('/api/kb/ask', 'POST', {question:'序列号'});
  check('云端写作配置不能收到制度问答原文', () => { assert.equal(blocked.status,409); assert.equal(blocked.data.error.code,'LOCAL_MODEL_REQUIRED'); assert.equal(chats,1); });
  await api('/api/ai/profiles/writing', 'PUT', {name:'写作',providerId,model:'local-policy'});
  await api('/api/ai/providers/' + cloud.data.data.id, 'DELETE');
  const sourcePath = join(dirname(process.env.WORKBENCH_TEST_DB!), '制度来源', '2.已印发');
  mkdirSync(sourcePath,{recursive:true});
  writeFileSync(join(sourcePath,'0.验收管理制度.docx'),bytes);
  const source = await api('/api/kb/sources','POST',{path:sourcePath,name:'匿名来源'});
  check('只读制度来源可登记',()=>assert.equal(source.status,201));
  const sourceId = source.data.data.source.id;
  const extracting = await api('/api/kb/sources/' + sourceId + '/extract','POST',{embed:true});
  check('目录抽取已受理',()=>assert.equal(extracting.status,202,JSON.stringify(extracting.data)));
  let state:any;
  for(let i=0;i<80;i++){
    state=(await api('/api/kb/sources/' + sourceId + '/extract/status')).data.data;
    if(!state.running)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  check('目录抽取保留原文且未向量化',()=>{
    assert.equal(state.running,false); assert.ok(state.status.job.done>0);
    assert.equal(state.status.job.failed,0); assert.equal(state.status.job.embedded,0); assert.equal(embeddings,0);
  });
  const detail=await api('/api/kb/documents/' + documentId);
  check('原文片段及顺序仍可查看',()=>{
    assert.ok(detail.data.data.chunks.some((chunk:any)=>chunk.content.includes('序列号')));
    assert.ok(detail.data.data.chunks.every((chunk:any,i:number)=>chunk.seq===i+1));
  });
  const status=await api('/api/kb/status');
  const diagnostics=await api('/api/kb/diagnostics');
  check('状态与诊断不要求向量模型',()=>{
    assert.equal(status.data.data.retrievalMode,'fulltext'); assert.equal(status.data.data.embedding.configured,false);
    assert.ok(diagnostics.data.data.checks.every((item:any)=>item.ok)); assert.equal(embeddings,0);
  });
  const deleted=await api('/api/kb/documents/' + documentId,'DELETE');
  const after=await api('/api/kb/search?q=' + encodeURIComponent('匿名制度/验收制度'));
  check('移除文档后该文档不再参与检索',()=>{
    assert.equal(deleted.status,200); assert.ok(!after.data.data.merged.some((hit:any)=>hit.documentId===documentId));
  });
  console.log('本地关键词知识库端到端验证：' + passed + ' 项通过，向量请求 0 次');
} finally {
  for(const profile of originalProfiles) await api('/api/ai/profiles/' + profile.purpose,'PUT',{
    name:profile.name,providerId:profile.provider_id,model:profile.model,timeoutMs:profile.timeout_ms,
    temperature:profile.temperature,maxTokens:profile.max_tokens,embeddingDim:profile.embedding_dim,
  });
  if(providerId) await api('/api/ai/providers/' + providerId,'DELETE');
  await new Promise<void>(resolve=>mock.close(()=>resolve()));
}
