import './isolated-guard.ts';
import PizZip from 'pizzip';
/**
 * AI 助手自检
 *
 * 用假模型（本机 HTTP 服务）返回确定的 tool_calls，验证：
 *   ① 写入不会直接落库，只生成待确认动作
 *   ② 确认后才真正执行，且数据确实变了
 *   ③ 忽略的动作不会执行
 *   ④ 破坏性动作不会被"全部执行"带走
 *   ⑤ 记忆写进去之后，下一轮对话真的会被注入（这是"以后用到能给正确答案"的关键）
 *   ⑥ 出文书时也会带上备忘
 *
 * 需要服务已启动：node packages/server/test/agent-e2e.ts
 */
import { createServer } from 'node:http';

const BASE = process.env.BASE!;
const FAKE_PORT = Number(process.env.FAKE_PORT ?? 8799);
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

/* ---------- 假模型：按脚本依次返回工具调用 ---------- */

type Scripted =
  | { toolCalls: { name: string; args: Record<string, unknown> }[]; text?: string }
  | { text: string };

let script: Scripted[] = [];
let seenPrompts: string[] = [];

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
      const parsed = JSON.parse(body || '{}') as { messages?: { role: string; content: string }[] };
      seenPrompts.push((parsed.messages ?? []).map((m) => m.content).join('\n'));
      const step = script.shift() ?? { text: '（脚本用完了）' };
      if ('toolCalls' in step) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'fake-agent',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: step.text ?? '',
                  tool_calls: step.toolCalls.map((t, i) => ({
                    id: `call_${i}`,
                    type: 'function',
                    function: { name: t.name, arguments: JSON.stringify(t.args) },
                  })),
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          }),
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'fake-agent',
          choices: [{ message: { role: 'assistant', content: step.text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: (e as Error).message } }));
    }
  });
});
await new Promise<void>((r) => fakeServer.listen(FAKE_PORT, '127.0.0.1', () => r()));
console.log(`\n假模型已启动：${FAKE_BASE}\n`);

/* ---------- 记录原配置，跑完还原 ---------- */
/**
 * 自检会动两个档案：「AI 助手」（助手本体）和「文书写作」（用来验证记忆会注入到出文书）。
 * **两个都要快照、都要还原** —— 只还原一个的话，跑一次自检就会把你的写作模型留在一个
 * 随后被删掉的测试服务商上（这个坑真踩过一次）。
 */
const snapshot = (await api('/api/ai/profiles')).json?.data?.items ?? [];
const cfg = {
  agent: snapshot.find((p: { purpose: string }) => p.purpose === 'agent'),
  writing: snapshot.find((p: { purpose: string }) => p.purpose === 'writing'),
  providers: ((await api('/api/ai/providers')).json?.data?.items ?? []).map((p: { id: number; enabled: number }) => ({ id: p.id, enabled: p.enabled })),
};

const restoreProfile = async (p: Record<string, unknown> | undefined): Promise<void> => {
  if (!p) return;
  await api(`/api/ai/profiles/${p.purpose}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: p.name,
      providerId: p.provider_id,
      model: p.model,
      temperature: p.temperature,
      maxTokens: p.max_tokens,
      timeoutMs: p.timeout_ms,
    }),
  });
};

console.log('[1] 把「AI 助手」指向假模型');
const fake = await api('/api/ai/providers', {
  method: 'POST',
  body: JSON.stringify({ code: `fake-agent-${Date.now()}`, name: '本机测试助手模型', baseUrl: FAKE_BASE, apiKey: 'k', enabled: 1, sortOrder: 9 }),
});
const fakeId = fake.json?.data?.id as number;
check('创建测试服务商', Boolean(fakeId), fake.json);
await api('/api/ai/profiles/agent', {
  method: 'PUT',
  body: JSON.stringify({ name: 'AI 助手', providerId: fakeId, model: 'fake-agent', temperature: 0.2, maxTokens: 4096, timeoutMs: 30000 }),
});

/* 用隔离库里专门创建的工作台做靶子 */
const typesForTest=(await api('/api/work-types')).json?.data?.items ?? [];
await api('/api/workbenches',{method:'POST',body:JSON.stringify({name:'清廉工程月度检查',workTypeId:typesForTest.find((t:{code:string})=>t.code==='admin')?.id ?? typesForTest[0]?.id})});
const wbList = await api('/api/workbenches');
const target = (wbList.json?.data?.items ?? []).find((w: { name: string }) => w.name.includes('清廉工程')) as
  | { id: number; name: string; owner: string | null }
  | undefined;
check('找到测试用的工作台', Boolean(target), (wbList.json?.data?.items ?? []).map((w: { name: string }) => w.name));
const wbId = target?.id as number;
const ownerBefore = target?.owner ?? null;
/** 这几个原值都要快照 —— 第 9 节会写它们，清理时必须还原成原样而不是写死 null */
const fullBefore = (await api(`/api/workbenches/${wbId}`)).json?.data?.workbench as {
  summary: string | null;
  start_date: string | null;
  plan_end_date: string | null;
  contract_amount: number | null;
};
const summaryBefore = fullBefore?.summary ?? null;
const dateBefore = {
  start: fullBefore?.start_date ?? null,
  plan: fullBefore?.plan_end_date ?? null,
  amount: fullBefore?.contract_amount ?? null,
};

console.log('\n[2] 写类工具：只生成待确认动作，不直接落库');
script = [
  { toolCalls: [{ name: 'set_workbench_field', args: { workbench: '清廉工程月度检查', field: 'owner', value: '【自检】李四' } }] },
  { text: '我准备把负责人改成【自检】李四，请确认。' },
];
const turn1 = await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ message: '把清廉工程的负责人改成【自检】李四' }) });
const sessionId = turn1.json?.data?.sessionId as number;
check('对话返回成功', turn1.json?.ok === true, turn1.json);
check('生成了 1 条待确认动作', (turn1.json?.data?.actions?.length ?? 0) === 1, turn1.json?.data?.actions);
const action1 = turn1.json?.data?.actions?.[0];
check('动作是 pending 状态', action1?.status === 'pending', action1);
check('动作摘要是人话', String(action1?.summary ?? '').includes('owner'), action1?.summary);

const wbAfter1 = await api(`/api/workbenches/${wbId}`);
check('**还没落库**：负责人没变', (wbAfter1.json?.data?.workbench?.owner ?? null) === ownerBefore, wbAfter1.json?.data?.workbench?.owner);

console.log('\n[3] 确认后才执行');
const applied = await api(`/api/agent/actions/${action1?.id}/apply`, { method: 'POST', body: '{}' });
check('执行成功', applied.json?.ok === true, applied.json);
const wbAfter2 = await api(`/api/workbenches/${wbId}`);
check('**已落库**：负责人变了', wbAfter2.json?.data?.workbench?.owner === '【自检】李四', wbAfter2.json?.data?.workbench?.owner);
check('执行结果带前后值', String(JSON.stringify(applied.json?.data?.result ?? {})).includes('before'), applied.json?.data?.result);

console.log('\n[4] 忽略的动作不执行');
script = [
  { toolCalls: [{ name: 'set_workbench_field', args: { workbench: '清廉工程月度检查', field: 'summary', value: '【自检】不该被写入' } }] },
  { text: '准备改备注。' },
];
const turn2 = await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ sessionId, message: '把备注改成【自检】不该被写入' }) });
const action2 = turn2.json?.data?.actions?.[0];
await api(`/api/agent/actions/${action2?.id}/discard`, { method: 'POST', body: '{}' });
const wbAfter3 = await api(`/api/workbenches/${wbId}`);
check('被忽略的改动没有生效', (wbAfter3.json?.data?.workbench?.summary ?? '') !== '【自检】不该被写入', wbAfter3.json?.data?.workbench?.summary);

console.log('\n[5] 破坏性动作不会被「全部执行」带走');
script = [
  { toolCalls: [{ name: 'delete_workbench', args: { workbench: '清廉工程月度检查' } }] },
  { toolCalls: [{ name: 'set_workbench_field', args: { workbench: '清廉工程月度检查', field: 'summary', value: '【自检】普通改动' } }] },
  { text: '一条删除、一条普通改动，都在等你确认。' },
];
const turn3 = await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ sessionId, message: '删掉清廉工程，顺便把备注改成【自检】普通改动' }) });
const actions3 = turn3.json?.data?.actions ?? [];
check('生成了两条动作', actions3.length === 2, actions3.map((a: { summary: string }) => a.summary));
check('删除被标为破坏性', actions3.some((a: { risk: string }) => a.risk === 'destructive'), actions3.map((a: { risk: string }) => a.risk));

const bulk = await api('/api/agent/actions/apply-all', { method: 'POST', body: JSON.stringify({ sessionId }) });
check('全部执行跳过了破坏性动作', (bulk.json?.data?.skippedDestructive ?? 0) >= 1, bulk.json?.data);
const wbStill = await api(`/api/workbenches/${wbId}`);
check('工作台还在（没被删）', wbStill.json?.ok === true, wbStill.json?.error);

console.log('\n[6] 记忆：写进去、并且在下一轮对话里被用上');
script = [
  { toolCalls: [{ name: 'remember', args: { text: '【自检】制度汇编签收记录须在 2026-09-30 前补齐', workbench: '清廉工程月度检查', due: '2026-09-30' } }] },
  { text: '记下了，请确认。' },
];
const turn4 = await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ sessionId, message: '记一下：签收记录 9 月 30 日前补齐' }) });
const action4 = turn4.json?.data?.actions?.[0];
await api(`/api/agent/actions/${action4?.id}/apply`, { method: 'POST', body: '{}' });
const mem = await api('/api/agent/memories');
check('备忘已写入', (mem.json?.data?.items ?? []).some((m: { text: string }) => m.text.includes('签收记录')), mem.json?.data?.items);

seenPrompts = [];
script = [{ text: '按备忘，9 月 30 日前补齐。' }];
await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ sessionId, message: '签收记录那件事什么时候要交？' }) });
const joined = seenPrompts.join('\n');
check('**下一轮对话把备忘注入了提示词**', joined.includes('签收记录须在 2026-09-30 前补齐'), joined.slice(0, 300));
check('提示词里说明了"用户已确认执行过"', joined.includes('已经确认执行过'), joined.slice(0, 400));

console.log('\n[7] 出文书时也带上备忘');
script = [{ text: JSON.stringify({ 被检查项目: '清廉工程月度检查', 检查时间: '2026年9月18日', 检查内容: '【自检】', 检查结果: '【自检】' }) }];
// 助手用的推理档案正好也是出文书要用的写作档案，这里换成写作档案指向假模型
await api('/api/ai/profiles/writing', {
  method: 'PUT',
  body: JSON.stringify({ name: '文书写作', providerId: fakeId, model: 'fake-agent', temperature: 0.2, maxTokens: 4096, timeoutMs: 30000 }),
});
seenPrompts = [];
const templateZip=new PizZip();
templateZip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
templateZip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
templateZip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{被检查项目} {检查时间} {检查内容} {检查结果}</w:t></w:r></w:p></w:body></w:document>');
const templateForm=new FormData();templateForm.append('workTypeId',String(typesForTest.find((t:{code:string})=>t.code==='admin')?.id ?? typesForTest[0]?.id));templateForm.append('files',new Blob([templateZip.generate({type:'nodebuffer'})]),'监督检查工作记录表.docx');await api('/api/templates/upload',{method:'POST',body:templateForm});
const tpl = (await api('/api/templates?limit=300')).json?.data?.items?.find((t: { name: string }) => t.name.includes('监督检查工作记录表'));
const draft = await api('/api/generate/draft', {
  method: 'POST',
  body: JSON.stringify({ templateId: tpl?.id, workbenchId: wbId, known: {}, referenceArtifactIds: [], skipAi: false }),
});
check('出文书调通了', draft.json?.data?.ok === true, draft.json);
check(
  '**出文书的提示词里带上了备忘**',
  seenPrompts.join('\n').includes('签收记录须在 2026-09-30 前补齐'),
  seenPrompts.join('\n').slice(0, 400),
);

console.log('\n[8] 读类工具不会生成待确认动作');
script = [
  { toolCalls: [{ name: 'list_workbenches', args: {} }] },
  { text: '你有 2 份工作。' },
];
const turn5 = await api('/api/agent/chat', { method: 'POST', body: JSON.stringify({ sessionId, message: '我有哪些工作？' }) });
check('读操作没有产生待确认动作', (turn5.json?.data?.actions?.length ?? 0) === 0, turn5.json?.data?.actions);
check('工具轨迹里能看到它查了什么', (turn5.json?.data?.trace ?? []).some((t: { tool: string }) => t.tool === 'list_workbenches'), turn5.json?.data?.trace);

/* ---------- 清理 ---------- */

console.log('\n[9] 局部更新不会误清其它字段（改一个字段不能顺手把别的清空）');
const before9 = await api(`/api/workbenches/${wbId}`);
const keep = before9.json?.data?.workbench as {
  counterpart: string | null;
  contract_no: string | null;
  start_date: string | null;
  plan_end_date: string | null;
  summary: string | null;
  contract_amount: number | null;
};
// 先给几个字段写上值，才能验证"没被清空"
await api(`/api/workbenches/${wbId}`, {
  method: 'PUT',
  body: JSON.stringify({ startDate: '2026-01-05', planEndDate: '2026-12-31', contractAmount: 12345, summary: '【自检】原备注' }),
});
const seeded = (await api(`/api/workbenches/${wbId}`)).json?.data?.workbench;
check('准备：日期/金额/备注已写入', seeded?.start_date === '2026-01-05' && seeded?.contract_amount === 12345, seeded);

const partial = await api(`/api/workbenches/${wbId}`, { method: 'PUT', body: JSON.stringify({ owner: '【自检】王五' }) });
check('只改负责人成功', partial.json?.ok === true, partial.json);
check(
  '**对方单位/合同编号/起止日期/金额/备注都没被清空**',
  partial.json?.data?.workbench?.counterpart === keep.counterpart &&
    partial.json?.data?.workbench?.contract_no === keep.contract_no &&
    partial.json?.data?.workbench?.start_date === '2026-01-05' &&
    partial.json?.data?.workbench?.plan_end_date === '2026-12-31' &&
    partial.json?.data?.workbench?.contract_amount === 12345 &&
    partial.json?.data?.workbench?.summary === '【自检】原备注',
  {
    counterpart: partial.json?.data?.workbench?.counterpart,
    contract_no: partial.json?.data?.workbench?.contract_no,
    start_date: partial.json?.data?.workbench?.start_date,
    plan_end_date: partial.json?.data?.workbench?.plan_end_date,
    contract_amount: partial.json?.data?.workbench?.contract_amount,
    summary: partial.json?.data?.workbench?.summary,
  },
);
const cleared = await api(`/api/workbenches/${wbId}`, { method: 'PUT', body: JSON.stringify({ owner: null, summary: null, startDate: null }) });
check(
  '显式传 null 能清空字段',
  cleared.json?.data?.workbench?.owner === null && cleared.json?.data?.workbench?.summary === null && cleared.json?.data?.workbench?.start_date === null,
  { owner: cleared.json?.data?.workbench?.owner, summary: cleared.json?.data?.workbench?.summary, start: cleared.json?.data?.workbench?.start_date },
);

console.log('\n[10] 清理自检产生的数据');
/**
 * 只丢**本会话**产生的待确认动作。
 * 原来是不带过滤地把全系统待确认动作全 discard —— 用户自己攒下的提议会被自检顺手删掉，
 * 而用户完全不知道发生了什么。现在按会话 id 限定，并回查本会话确实清空了。
 */
const sessionPending = (await api(`/api/agent/actions?sessionId=${sessionId}`)).json?.data?.items ?? [];
for (const a of sessionPending) {
  await api(`/api/agent/actions/${a.id}/discard`, { method: 'POST', body: '{}' });
}
const pendLeft = (await api(`/api/agent/actions?sessionId=${sessionId}`)).json?.data?.count ?? -1;
check('本会话留下的待确认动作已清空', pendLeft === 0, { left: pendLeft });
check('清理范围限定本会话', sessionPending.every((a:{session_id:number})=>a.session_id===sessionId));
// 还原成快照里的原值，而不是写死 null —— summary 原值可能是有内容的
await api(`/api/workbenches/${wbId}`, {
  method: 'PUT',
  body: JSON.stringify({ owner: ownerBefore, summary: summaryBefore, startDate: dateBefore.start, planEndDate: dateBefore.plan, contractAmount: dateBefore.amount }),
});
for (const m of (await api('/api/agent/memories')).json?.data?.items ?? []) {
  if (String(m.text).includes('【自检】')) await api(`/api/agent/memories/${m.id}`, { method: 'DELETE' });
}
await api(`/api/workbenches/${wbId}`, { method: 'PUT', body: JSON.stringify({ owner: ownerBefore }) });
await api('/api/ai/providers/' + fakeId, { method: 'DELETE' });
for (const p of cfg.providers) await api(`/api/ai/providers/${p.id}`, { method: 'PUT', body: JSON.stringify({ enabled: p.enabled }) });
await restoreProfile(cfg.agent);
await restoreProfile(cfg.writing);
const finalProfiles = (await api('/api/ai/profiles')).json?.data?.items ?? [];
const agentNow = finalProfiles.find((p: { purpose: string }) => p.purpose === 'agent');
const writingNow = finalProfiles.find((p: { purpose: string }) => p.purpose === 'writing');
check(
  '助手档案已还原',
  agentNow?.provider_id === cfg.agent?.provider_id && agentNow?.model === cfg.agent?.model,
  { want: { p: cfg.agent?.provider_id, m: cfg.agent?.model }, got: { p: agentNow?.provider_id, m: agentNow?.model } },
);
check(
  '**文书写作档案已还原**（自检不能把你的写作模型留在测试服务商上）',
  writingNow?.provider_id === cfg.writing?.provider_id && writingNow?.model === cfg.writing?.model,
  { want: { p: cfg.writing?.provider_id, m: cfg.writing?.model }, got: { p: writingNow?.provider_id, m: writingNow?.model } },
);
const finalWb = await api(`/api/workbenches/${wbId}`);
check('工作台已还原', (finalWb.json?.data?.workbench?.owner ?? null) === ownerBefore, finalWb.json?.data?.workbench?.owner);
const memLeft = (await api('/api/agent/memories')).json?.data?.items ?? [];
check('自检备忘已清理', !memLeft.some((m: { text: string }) => String(m.text).includes('【自检】')), memLeft.length);
check('测试服务商已删除', !((await api('/api/ai/providers')).json?.data?.items ?? []).some((p: { id: number }) => p.id === fakeId));

fakeServer.close();
console.log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项\n`);
if (failCount > 0) process.exitCode = 1;
