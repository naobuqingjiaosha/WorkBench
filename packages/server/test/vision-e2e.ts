import './isolated-guard.ts';
import PizZip from 'pizzip';
/**
 * 影像初检自检
 *
 * 用假视觉模型（本机 HTTP 服务，会检查请求里确实带了图片）验证：
 *   ① 没配视觉模型时，给的是人能看懂的提示，而不是拿写作模型硬试
 *   ② 单张审 → 结论落库（evidence_review）
 *   ③ 整条清单审 → 数量不够判 issue，并说明缺几张
 *   ④ 出文书时，照片会被"翻译"成文字进提示词（写作模型看不了图，这一步是关键）
 *   ⑤ 跑完清理：测试照片、结论、服务商与档案全部还原
 *
 * 需要服务已启动：node packages/server/test/vision-e2e.ts
 */
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

const BASE = process.env.BASE!;
const FAKE_PORT = Number(process.env.FAKE_PORT ?? 8797);
const FAKE_BASE = `http://127.0.0.1:${FAKE_PORT}/v1`;

let pass = 0;
let failCount = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failCount += 1;
    console.log(`  ✗ ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}

async function api(path: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: init?.body instanceof FormData || init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/* ---------- 手搓一张最小 PNG ---------- */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function makePng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = x % 2 ? 30 : 220;
      raw[o + 1] = 60;
      raw[o + 2] = x % 2 ? 200 : 40;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 假视觉模型：断言请求里带了图片，返回固定结论 ---------- */
let sawImagePart = 0;
let sawPromptWithPoints = false;
let reviewCount = 0;

const fakeServer = createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end('{}');
    return;
  }
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}') as { messages?: { content?: unknown }[]; tools?: unknown[] };
      const contents = (parsed.messages ?? []).map((m) => m.content);
      const flat = JSON.stringify(contents);
      if (flat.includes('image_url') && flat.includes('data:image/png;base64,')) sawImagePart += 1;
      if (flat.includes('拍摄要点')) sawPromptWithPoints = true;

      // 第一次返回"有问题"，第二次返回"合格" —— 用来验证两种结论都能落库
      reviewCount += 1;
      const verdict = reviewCount === 1 ? 'issue' : 'ok';
      const payload =
        parsed.tools && (parsed.tools as unknown[]).length
          ? null
          : {
              seen: '画面里是一块横向条纹的牌子，能看到边框',
              verdict,
              summary: verdict === 'issue' ? '没有拍到铭牌上的文字，看不清型号' : '铭牌文字清晰，满足要求',
              issues: verdict === 'issue' ? ['看不清型号铭牌', '角度偏斜'] : [],
              suggestion: verdict === 'issue' ? '正对铭牌补拍一张特写' : '',
            };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'fake-vl',
          choices: [
            {
              message: payload ? { role: 'assistant', content: JSON.stringify(payload) } : { role: 'assistant', content: '好的' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
        }),
      );
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: (e as Error).message } }));
    }
  });
});
await new Promise<void>((r) => fakeServer.listen(FAKE_PORT, '127.0.0.1', () => r()));
console.log(`\n假视觉模型已启动：${FAKE_BASE}\n`);

/* ---------- 快照原配置 ---------- */
const snapshot = (await api('/api/ai/profiles')).json?.data?.items ?? [];
const cfg = {
  vision: snapshot.find((p: { purpose: string }) => p.purpose === 'vision'),
  writing: snapshot.find((p: { purpose: string }) => p.purpose === 'writing'),
  providers: ((await api('/api/ai/providers')).json?.data?.items ?? []).map((p: { id: number; enabled: number }) => ({ id: p.id, enabled: p.enabled })),
};
const restore = async (p: Record<string, unknown> | undefined): Promise<void> => {
  if (!p) return;
  await api(`/api/ai/profiles/${p.purpose}`, {
    method: 'PUT',
    body: JSON.stringify({ name: p.name, providerId: p.provider_id, model: p.model, temperature: p.temperature, maxTokens: p.max_tokens, timeoutMs: p.timeout_ms }),
  });
};

console.log('[1] 没配视觉模型时，提示要能看懂');
await api('/api/ai/profiles/vision', { method: 'PUT', body: JSON.stringify({ name: '图像识别', providerId: null, model: '' }) });
const png = makePng(160, 100);
const up = await (async () => {
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), '【自检】铭牌.png');
  fd.append('kind', 'source');
  fd.append('note', '【自检】铭牌');
  return api('/api/artifacts/upload', { method: 'POST', body: fd });
})();
const noVisionArtifact = up.json?.data?.items?.[0]?.id as number;
check('测试照片已上传', Boolean(noVisionArtifact), up.json);
const noVision = await api('/api/evidence/review', { method: 'POST', body: JSON.stringify({ artifactId: noVisionArtifact }) });
check(
  '未配视觉模型时给出人话提示（而不是拿写作模型硬试）',
  /图像识别|模型接入/.test(String(noVision.json?.error?.message ?? '')),
  noVision.json?.error?.message,
);

console.log('\n[2] 指向假视觉模型后，单张审');
const fake = await api('/api/ai/providers', {
  method: 'POST',
  body: JSON.stringify({ code: `fake-vl-${Date.now()}`, name: '本机测试视觉模型', baseUrl: FAKE_BASE, apiKey: 'k', enabled: 1, sortOrder: 9 }),
});
const fakeId = fake.json?.data?.id as number;
check('创建测试视觉服务商', Boolean(fakeId), fake.json);
await api('/api/ai/profiles/vision', {
  method: 'PUT',
  body: JSON.stringify({ name: '图像识别', providerId: fakeId, model: 'fake-vl', temperature: 0.1, maxTokens: 2048, timeoutMs: 30000 }),
});

const before = sawImagePart;
const r1 = await api('/api/evidence/review', { method: 'POST', body: JSON.stringify({ artifactId: noVisionArtifact }) });
check('审图成功', r1.json?.ok === true, r1.json);
check('**请求里真的带了图片数据**', sawImagePart > before, { saw: sawImagePart });
check('结论被记下来（issue）', r1.json?.data?.verdict === 'issue', r1.json?.data);
check('问题清单带回来了', (r1.json?.data?.issues?.length ?? 0) > 0, r1.json?.data?.issues);

const listed = await api(`/api/evidence/reviews?artifactId=${noVisionArtifact}`);
check('结论能查回来（落库了）', (listed.json?.data?.items?.length ?? 0) >= 1, listed.json?.data);

console.log('\n[3] 整条清单审：数量不够要判 issue 并说明缺几张');
// 建立专用项目和清单，只修改独立测试数据库。
const typesForVision=(await api('/api/work-types')).json?.data?.items ?? [];
const processType=typesForVision.find((t:{mode:string;code:string})=>t.code==='project'&&t.mode==='process');
const testWorkbench=await api('/api/workbenches',{method:'POST',body:JSON.stringify({name:'【自检】影像验证',workTypeId:processType?.id})});
const workbenchId=testWorkbench.json?.data?.id as number;
const detailForVision=(await api('/api/workbenches/'+workbenchId)).json?.data;
const itemId=(detailForVision?.positions ?? []).flatMap((p:{checklist:{id:number;kind:string}[]})=>p.checklist).find((c:{kind:string})=>c.kind==='evidence')?.id as number;
check('找到/造出一条影像清单',Boolean(itemId),{itemId,workbenchId});
const {initDatabase,run,closeDatabase}=await import('../src/db/index.ts');
initDatabase(process.env.WORKBENCH_TEST_DB!);
run('UPDATE checklist_item SET min_count=2 WHERE id=?',[itemId]);
closeDatabase();
const evidenceForm=new FormData();evidenceForm.append('workbenchId',String(workbenchId));evidenceForm.append('checklistItemId',String(itemId));evidenceForm.append('files',new Blob([png],{type:'image/png'}),'【自检】证据.png');
const evidenceUpload=await api('/api/artifacts/evidence',{method:'POST',body:evidenceForm});
check('测试照片关联正确工作台的影像清单',evidenceUpload.json?.ok===true,evidenceUpload.json);
const r2 = itemId ? await api(`/api/evidence/review-checklist/${itemId}`, { method: 'POST', body: '{}' }) : null;
check('整条清单审返回结论', r2?.json?.ok === true, r2?.json);
check(
  '**数量不够 → 判 issue 并说明缺几张**',
  r2?.json?.data?.verdict === 'issue' && String((r2?.json?.data?.issues ?? []).join(' ')).includes('数量不够'),
  { verdict: r2?.json?.data?.verdict, issues: r2?.json?.data?.issues },
);

console.log('\n[4] 出文书时照片被翻译成文字进提示词');
let promptText = '';
const promptServer = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}') as { messages?: { content?: unknown }[] };
      promptText = JSON.stringify(parsed.messages ?? []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake-writer', choices: [{ message: { role: 'assistant', content: '{"被检查项目":"【自检】","检查时间":"【自检】","检查内容":"【自检】","检查结果":"【自检】"}' }, finish_reason: 'stop' }], usage: {} }));
    } catch (e) {
      res.writeHead(400).end(JSON.stringify({ error: { message: (e as Error).message } }));
    }
  });
});
const PROMPT_PORT = FAKE_PORT + 1;
await new Promise<void>((r) => promptServer.listen(PROMPT_PORT, '127.0.0.1', () => r()));
const writerProvider = await api('/api/ai/providers', {
  method: 'POST',
  body: JSON.stringify({ code: `fake-writer-${Date.now()}`, name: '本机测试写作模型', baseUrl: `http://127.0.0.1:${PROMPT_PORT}/v1`, apiKey: 'k', enabled: 1, sortOrder: 9 }),
});
await api('/api/ai/profiles/writing', {
  method: 'PUT',
  body: JSON.stringify({ name: '文书写作', providerId: writerProvider.json?.data?.id, model: 'fake-writer', temperature: 0.2, maxTokens: 2048, timeoutMs: 30000 }),
});
const templateZip=new PizZip();
templateZip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
templateZip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
templateZip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{被检查项目} {检查时间} {检查内容} {检查结果}</w:t></w:r></w:p></w:body></w:document>');
const templateForm=new FormData();templateForm.append('workTypeId',String(processType.id));templateForm.append('files',new Blob([templateZip.generate({type:'nodebuffer'})]),'监督检查工作记录表.docx');await api('/api/templates/upload',{method:'POST',body:templateForm});
const tpl = ((await api('/api/templates?limit=300')).json?.data?.items ?? []).find((t: { variable_count: number;work_type_id:number }) => t.variable_count > 0 && t.work_type_id===processType.id);
const draft = await api('/api/generate/draft', {
  method: 'POST',
  body: JSON.stringify({
    templateId: tpl?.id,
    workbenchId,
    known: {},
    skipAi: false,
    referenceArtifactIds: [noVisionArtifact],
  }),
});
check('出文书调通', draft.json?.data?.ok === true, draft.json?.data?.error ?? draft.json?.data);
check(
  '**提示词里出现了照片识别结果**',
  promptText.includes('现场照片') && (promptText.includes('铭牌') || promptText.includes('画面里')),
  promptText.slice(0, 500),
);
check('提示词里注明"可能看错"（不许当成权威事实）', promptText.includes('可能看错'), promptText.slice(0, 400));

/* ---------- 清理 ---------- */
console.log('\n[5] 清理');
await api(`/api/artifacts/${noVisionArtifact}?withFile=true`, { method: 'DELETE' });
const evidenceId=evidenceUpload.json?.data?.items?.[0]?.id;
if(evidenceId)await api('/api/artifacts/'+evidenceId+'?withFile=true',{method:'DELETE'});
await api('/api/workbenches/'+workbenchId,{method:'DELETE'});
await api(`/api/ai/providers/${fakeId}`, { method: 'DELETE' });
await api(`/api/ai/providers/${writerProvider.json?.data?.id}`, { method: 'DELETE' });
for (const p of cfg.providers) await api(`/api/ai/providers/${p.id}`, { method: 'PUT', body: JSON.stringify({ enabled: p.enabled }) });
await restore(cfg.vision);
await restore(cfg.writing);
const afterProfiles = (await api('/api/ai/profiles')).json?.data?.items ?? [];
const visionNow = afterProfiles.find((p: { purpose: string }) => p.purpose === 'vision');
const writingNow = afterProfiles.find((p: { purpose: string }) => p.purpose === 'writing');
check('视觉档案已还原', visionNow?.provider_id === cfg.vision?.provider_id && visionNow?.model === cfg.vision?.model, {
  want: { p: cfg.vision?.provider_id, m: cfg.vision?.model },
  got: { p: visionNow?.provider_id, m: visionNow?.model },
});
check('写作档案已还原', writingNow?.provider_id === cfg.writing?.provider_id && writingNow?.model === cfg.writing?.model, {
  want: { p: cfg.writing?.provider_id, m: cfg.writing?.model },
  got: { p: writingNow?.provider_id, m: writingNow?.model },
});
const reviewsLeft = (await api(`/api/evidence/reviews?workbenchId=${workbenchId}`)).json?.data?.items ?? [];
check('测试照片的结论随照片一起清掉了', reviewsLeft.length === 0, reviewsLeft.length);
console.log(`     假模型共收到 ${reviewCount} 次请求，其中带图片的 ${sawImagePart} 次；提示词里带拍摄要求：${sawPromptWithPoints}`);

fakeServer.close();
promptServer.close();
console.log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项\n`);
if (failCount > 0) process.exitCode = 1;
