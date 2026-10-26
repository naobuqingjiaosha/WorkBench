/** 模型接入接口：服务商增删改、连通性测试、模型档案 */
import type { FastifyInstance } from 'fastify';
import {
  PURPOSES,
  deleteProvider,
  getProvider,
  listProfiles,
  listProviders,
  maskProvider,
  resolveApiKey,
  upsertProfile,
  upsertProvider,
  type AiPurpose,
} from '../ai/providers.ts';
import { chat, embed, testProvider,fetchWithTimeout } from '../ai/gateway.ts';
import { discoverLocalModels, configureLocalModels } from '../ai/local-model.ts';
import { ApiError, body, fail, intParam, ok, optNum, optStr, requireStr } from './reply.ts';

const modelCache = new Map<number, { at: number; models: string[] }>();

async function fetchModels(providerId: number): Promise<string[]> {
  const cached = modelCache.get(providerId);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.models;
  const p = getProvider(providerId);
  if (!p) return [];
  const base = p.base_url.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = resolveApiKey(p);
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const res=await fetchWithTimeout(`${base}/models`,{headers},20000);
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
    modelCache.set(providerId, { at: Date.now(), models });
    return models;
  } catch {
    return [];
  }
}

export function registerAiRoutes(app: FastifyInstance): void {
  app.post('/api/ai/local/models', async (req, reply) => {
    try {
      const b = body(req);
      return ok(reply, await discoverLocalModels({ baseUrl: optStr(b, 'baseUrl'), apiKey: optStr(b, 'apiKey') }));
    } catch (e) { return fail(reply, e); }
  });

  app.put('/api/ai/local', async (req, reply) => {
    try {
      const b = body(req);
      const result = configureLocalModels({ baseUrl: optStr(b, 'baseUrl'), apiKey: optStr(b, 'apiKey'),
        model: requireStr(b, 'model', '文本模型'), visionModel: optStr(b, 'visionModel'), embeddingModel: optStr(b, 'embeddingModel') });
      modelCache.delete(result.providerId);
      return ok(reply, result);
    } catch (e) { return fail(reply, e); }
  });

  app.get('/api/ai/providers', async (_req, reply) => ok(reply, { items: listProviders().map(maskProvider), purposes: PURPOSES }));

  app.post('/api/ai/providers', async (req, reply) => {
    try {
      const b = body(req);
      const id = upsertProvider({
        code: requireStr(b, 'code', '编码').replace(/[^0-9A-Za-z-_]/g, '-'),
        name: requireStr(b, 'name', '名称'),
        kind: optStr(b, 'kind') ?? 'openai-compatible',
        base_url: requireStr(b, 'baseUrl', 'Base URL'),
        api_key: optStr(b, 'apiKey') ?? null,
        api_key_env: optStr(b, 'apiKeyEnv') ?? null,
        extra_headers: optStr(b, 'extraHeaders') ?? null,
        enabled: optNum(b, 'enabled') ?? 1,
        remark: optStr(b, 'remark') ?? null,
        sort_order: optNum(b, 'sortOrder') ?? 100,
      });
      return ok(reply, { id }, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.put('/api/ai/providers/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const cur = getProvider(id);
      if (!cur) throw new ApiError('NOT_FOUND', '服务商不存在', 404);
      const b = body(req);
      const apiKey = optStr(b, 'apiKey');
      const newId = upsertProvider({
        code: cur.code,
        name: optStr(b, 'name') ?? cur.name,
        kind: optStr(b, 'kind') ?? cur.kind,
        base_url: optStr(b, 'baseUrl') ?? cur.base_url,
        // 传空字符串表示"不改动"，传 __CLEAR__ 表示清空
        api_key: apiKey === undefined || apiKey === '' ? cur.api_key : apiKey === '__CLEAR__' ? null : apiKey,
        api_key_env: optStr(b, 'apiKeyEnv') ?? cur.api_key_env,
        extra_headers: optStr(b, 'extraHeaders') ?? cur.extra_headers,
        enabled: optNum(b, 'enabled') ?? cur.enabled,
        remark: optStr(b, 'remark') ?? cur.remark,
        sort_order: optNum(b, 'sortOrder') ?? cur.sort_order,
      });
      modelCache.delete(id);
      return ok(reply, { id: newId });
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.delete('/api/ai/providers/:id', async (req, reply) => {
    try {
      deleteProvider(intParam(req, 'id'));
      return ok(reply, { deleted: true });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 测试连通性 */
  app.post('/api/ai/providers/:id/test', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const model = optStr(b, 'model');
      const apiKey = optStr(b, 'apiKey');
      // 允许"先填 key 直接测"，不强制先保存
      if (apiKey) {
        const cur = getProvider(id);
        if (!cur) throw new ApiError('NOT_FOUND', '服务商不存在', 404);
        const { run } = await import('../db/index.ts');
        run('UPDATE ai_provider SET api_key = ? WHERE id = ?', [apiKey, id]);
      }
      const r = await testProvider(id, model);
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 拉取可用模型列表（有的服务商不支持，会返回空数组） */
  app.get('/api/ai/providers/:id/models', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const models = await fetchModels(id);
      return ok(reply, { models, supported: models.length > 0 });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 模型档案 */
  app.get('/api/ai/profiles', async (_req, reply) => ok(reply, { items: listProfiles(), purposes: PURPOSES }));

  app.put('/api/ai/profiles/:purpose', async (req, reply) => {
    try {
      const purpose = (req.params as { purpose: string }).purpose as AiPurpose;
      if (!PURPOSES.some((p) => p.purpose === purpose)) throw new ApiError('BAD_PARAM', `未知用途：${purpose}`);
      const b = body(req);
      const meta = PURPOSES.find((p) => p.purpose === purpose);
      const id = upsertProfile({
        purpose,
        name: optStr(b, 'name') ?? meta?.name ?? purpose,
        provider_id: optNum(b, 'providerId') ?? null,
        model: optStr(b, 'model') ?? null,
        temperature: optNum(b, 'temperature') ?? 0.2,
        max_tokens: optNum(b, 'maxTokens') ?? 4096,
        timeout_ms: optNum(b, 'timeoutMs') ?? 120000,
        embedding_dim: optNum(b, 'embeddingDim') ?? null,
        extra_body: optStr(b, 'extraBody') ?? null,
        note: optStr(b, 'note') ?? null,
      });
      return ok(reply, { id });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 用某个档案发一条测试消息，确认端到端可用 */
  app.post('/api/ai/profiles/:purpose/test', async (req, reply) => {
    try {
      const purpose = (req.params as { purpose: string }).purpose as AiPurpose;
      const b = (req.body ?? {}) as Record<string, unknown>;
      const prompt = optStr(b, 'prompt') ?? '用一句话说明你是谁、当前时间。';
      if (purpose === 'embedding') {
        const r = await embed(['这是一条测试文本'], { purpose });
        if (!r.ok) throw new ApiError('AI_FAILED', r.error ?? '向量化失败');
        return ok(reply, { ok: true, dim: r.vectors[0]?.length ?? 0, model: r.model, message: `向量化成功，维度 ${r.vectors[0]?.length ?? 0}` });
      }
      /**
       * 「AI 助手」要单独测：它靠**工具调用**干活，模型不支持就只会变成普通聊天，
       * 而普通对话测试照样能通过 —— 那样用户以为配好了，真用起来才发现"交代的事它不做"。
       * 所以这里发一个必须调工具的请求，直接看它会不会调。
       */
      if (purpose === 'agent') {
        const r = await chat({
          purpose,
          messages: [{ role: 'user', content: '请调用工具查一下当前时间。' }],
          tools: [
            {
              type: 'function',
              function: { name: 'get_time', description: '获取当前时间', parameters: { type: 'object', properties: {} } },
            },
          ],
          maxTokens: 1024,
          ref: { type: 'profile-test' },
        });
        if (!r.ok) throw new ApiError('AI_FAILED', r.error ?? '调用失败');
        const names = (r.toolCalls ?? []).map((c) => c.function.name);
        const called = names.length > 0;
        return ok(reply, {
          ok: true,
          text: r.text,
          model: r.model,
          provider: r.providerCode,
          latencyMs: r.latencyMs,
          usage: r.usage,
          toolCalling: called,
          warning: called
            ? undefined
            : '这个模型没有返回工具调用。助手可能只会聊天、不会真的查数据和改字段，建议换一个支持 function calling 的模型。',
          message: called
            ? `调用成功，模型会调工具（${names.join('、')}），用时 ${r.latencyMs}ms`
            : '调用成功，但模型没有调用工具',
        });
      }
      const r = await chat({
        purpose,
        messages: [{ role: 'user', content: prompt }],
        // 探针要给推理模型留出"思考"的余量：它想事情也占 max_tokens，
        // 200 的额度会被思考吃光，返回 finish_reason=length，
        // 于是接口明明是通的、测试却报「输出被截断」——把人往错误方向带。
        maxTokens: 1024,
        ref: { type: 'profile-test' },
      });
      const usage = r.usage;
      const reasoningNote = usage.reasoning ? `，其中思考占 ${usage.reasoning} tokens` : '';
      if (!r.ok) {
        // 截断了但已经拿到内容 —— 对「能不能调通」这个问题来说算通过，把情况说清楚即可
        if (r.text.trim()) {
          return ok(reply, {
            ok: true,
            text: r.text,
            model: r.model,
            provider: r.providerCode,
            latencyMs: r.latencyMs,
            usage,
            warning: `${r.error}（本次仍拿到了内容，说明接口是通的）`,
          });
        }
        throw new ApiError('AI_FAILED', r.error ?? '调用失败');
      }
      return ok(reply, {
        ok: true,
        text: r.text,
        model: r.model,
        provider: r.providerCode,
        latencyMs: r.latencyMs,
        usage,
        message: `调用成功（输出 ${usage.output} tokens${reasoningNote}，用时 ${r.latencyMs}ms）`,
      });
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 简单对话（界面上试问用） */
  app.post('/api/ai/chat', async (req, reply) => {
    try {
      const b = body(req);
      const message = requireStr(b, 'message', '内容');
      const purpose = (optStr(b, 'purpose') as AiPurpose) ?? 'writing';
      const r = await chat({
        purpose,
        messages: [{ role: 'user', content: message }],
        ref: { type: 'chat' },
      });
      if (!r.ok) throw new ApiError('AI_FAILED', r.error ?? '调用失败');
      return ok(reply, r);
    } catch (e) {
      return fail(reply, e);
    }
  });
}
