import { tx, run } from '../db/index.ts';
import { ApiError } from '../api/reply.ts';
import { fetchWithTimeout } from './gateway.ts';
import { getProvider, getProfile, resolveApiKey, upsertProvider, upsertProfile, type AiPurpose } from './providers.ts';

export const LM_STUDIO_BASE = 'http://127.0.0.1:1234/v1';

export function localModelBase(raw = LM_STUDIO_BASE): string {
  let url: URL;
  try { url = new URL(raw.trim()); }
  catch { throw new ApiError('BAD_LOCAL_URL', '请输入有效的 LM Studio 服务地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash) {
    throw new ApiError('BAD_LOCAL_URL', '本机模型地址仅支持 localhost、127.0.0.1 或 [::1]，不能带密码、查询参数或片段');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (path && path !== '/v1') throw new ApiError('BAD_LOCAL_URL', 'LM Studio 兼容接口地址应以 /v1 结尾');
  return `${url.origin}/v1`;
}

function localKey(base: string, apiKey?: string): string {
  if (apiKey !== undefined) return apiKey.trim();
  const existing = getProvider('lmstudio');
  return existing && existing.base_url === base ? resolveApiKey(existing) : '';
}

export async function discoverLocalModels(input: { baseUrl?: string; apiKey?: string }) {
  const baseUrl = localModelBase(input.baseUrl);
  const apiKey = localKey(baseUrl, input.apiKey);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(`${baseUrl}/models`, { headers }, 10000);
    if ([401, 403].includes(response.status)) throw new ApiError('LOCAL_AUTH', 'LM Studio 要求身份验证，请填写它的 API Token', 401);
    if (!response.ok) throw new ApiError('LOCAL_HTTP', `LM Studio 模型列表接口返回 HTTP ${response.status}`, 502);
    const data = await response.json() as { data?: unknown };
    if (!Array.isArray(data.data)) throw new ApiError('LOCAL_RESPONSE', '服务未返回兼容的模型列表，请检查地址是否指向 LM Studio', 502);
    const models = [...new Set(data.data.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string' || !item.id.trim()) return [];
      return [item.id.trim()];
    }))].sort();
    return { baseUrl, models, latencyMs: Date.now() - started };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const timedOut = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
    throw new ApiError('LOCAL_UNAVAILABLE', timedOut ? 'LM Studio 连接超时，请检查服务端口和运行状态'
      : `无法连接 ${baseUrl}，请在 LM Studio 的 Developer 页面启动服务`, 503);
  }
}

export function configureLocalModels(input: { baseUrl?: string; apiKey?: string; model: string; visionModel?: string; embeddingModel?: string }) {
  const baseUrl = localModelBase(input.baseUrl);
  const model = input.model.trim();
  if (!model || model.length > 200) throw new ApiError('BAD_MODEL', '请选择或填写有效的文本模型名称');
  const optionalModel = (value?: string): string | null => {
    const text = value?.trim() ?? '';
    if (text.length > 200) throw new ApiError('BAD_MODEL', '模型名称不能超过 200 个字符');
    return text || null;
  };
  const visionModel = optionalModel(input.visionModel), embeddingModel = optionalModel(input.embeddingModel);
  const apiKey = localKey(baseUrl, input.apiKey);
  return tx(() => {
    const providerId = upsertProvider({ code: 'lmstudio', name: '本地 LM Studio', base_url: baseUrl, enabled: 1,
      kind: 'openai-compatible', api_key: apiKey, api_key_env: '', extra_headers: '{}', sort_order: 55 });
    const targets: { purpose: AiPurpose; model: string | null }[] = [
      ...(['writing', 'extract', 'reasoning', 'agent'] as AiPurpose[]).map(purpose => ({ purpose, model })),
      { purpose: 'vision', model: visionModel }, { purpose: 'embedding', model: embeddingModel },
    ];
    for (const target of targets) {
      const existing = getProfile(target.purpose);
      upsertProfile({ purpose: target.purpose, name: existing?.name ?? target.purpose,
        provider_id: target.model ? providerId : null, model: target.model, timeout_ms: 180000, extra_body: '{}' });
    }
    // 向量维度属于具体模型，不能继承上一个服务商的设置。
    run("UPDATE ai_profile SET embedding_dim=NULL WHERE purpose='embedding'");
    return { providerId, baseUrl, model, visionModel, embeddingModel };
  });
}
