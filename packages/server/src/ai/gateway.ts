/**
 * AI 网关 —— 所有大模型调用的唯一入口
 *
 * 统一走 OpenAI 兼容协议（/chat/completions、/embeddings），
 * 因此 DeepSeek、通义、智谱、Kimi、Ollama、各类中转站用同一套代码。
 *
 * 职责：
 *   1. 按"用途"找模型档案 → 找服务商 → 取 key
 *   2. 发请求（含超时、重试、JSON 模式）
 *   3. 记录每次调用的耗时与 token 用量到 ai_call_log
 *   4. 把各种错误翻译成人能看懂的中文提示
 */
import { run } from '../db/index.ts';
import { authorizeRequest, finishRequest } from './consent.ts';
import { getSetting } from '../core/config.ts';
import { getProvider, resolveApiKey, resolveProfile, type AiProfile, type AiProvider, type AiPurpose } from './providers.ts';

/**
 * 消息内容可以是纯文本，也可以是「文本 + 图片」的多段结构（OpenAI 视觉格式）。
 * 只有视觉模型收得下图片 —— 所以调用方必须先确认该用途配的是 `qwen3-vl-*` 这类模型。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  /** assistant 请求调用的工具（role=assistant 时可能有） */
  tool_calls?: ToolCall[];
  /** role=tool 时：回给模型的是哪个调用 */
  tool_call_id?: string;
  name?: string;
}

/** 取消息里的纯文本部分（多段内容时把 text 段拼起来），用于日志与规则判断 */
export function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/** OpenAI 风格的函数调用 */
export interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

/** 工具定义（OpenAI 风格） */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  /** Per-request DeepSeek structured-writing option; does not mutate the model profile. */
  thinking?: 'disabled';
  purpose?: AiPurpose;
  messages: ChatMessage[];
  /** 需要严格 JSON 输出时传 JSON Schema（部分服务商用 json_object 即可） */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** 覆盖档案里的模型 */
  model?: string;
  /** 覆盖服务商 */
  providerId?: number;
  /** 允许模型调用的工具；给了就走工具调用模式 */
  tools?: ToolSpec[];
  ref?: { type: string; id?: number };
  /** 不记录日志（测试连接用） */
  silent?: boolean;
}

export interface ChatResult {
  ok: boolean;
  text: string;
  model: string;
  providerCode: string;
  /**
   * reasoning = 模型"想"掉的 token（推理模型才有）。
   * 它同样算在 max_tokens 里：一次只要两个字的回答，思考也能花掉一百多个 token。
   * 单独记出来，是为了让「被截断」这类问题一眼能看出是思考吃的预算，而不是提示词写太长。
   */
  usage: { prompt: number; output: number; total: number; reasoning?: number };
  latencyMs: number;
  /** 模型请求调用的工具（走工具调用模式时才有） */
  toolCalls?: ToolCall[];
  error?: string;
  raw?: unknown;
}

export class AiError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

/* --------------------------- 服务商连通性 --------------------------- */

export interface ProviderTestResult {
  ok: boolean
  message: string
  models?: string[]
  latencyMs?: number
}

function buildHeaders(p: AiProvider): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = resolveApiKey(p);
  if (key) headers.Authorization = `Bearer ${key}`;
  if (p.extra_headers) {
    try {
      const extra = JSON.parse(p.extra_headers) as Record<string, string>;
      Object.assign(headers, extra);
    } catch {
      /* 忽略非法的额外请求头 */
    }
  }
  return headers;
}

export function isLocalProvider(base:string):boolean {try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname);}catch{return false;}}

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** 测试服务商：拉模型列表；不支持 /models 就发一个最小对话请求 */
export async function testProvider(providerIdOrCode: number | string, model?: string): Promise<ProviderTestResult> {
  const p = getProvider(providerIdOrCode);
  if (!p) return { ok: false, message: '找不到该服务商' };
  if (!resolveApiKey(p) && !isLocalProvider(p.base_url)) {
    return { ok: false, message: `还没有配置 API Key（可在本页填写，或设置环境变量 ${p.api_key_env || 'XXX_API_KEY'}）` };
  }
  const base = normalizeBase(p.base_url);
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(`${base}/models`, { method: 'GET', headers: buildHeaders(p) }, 20000);
    if (res.ok) {
      const data = (await res.json()) as { data?: { id?: string }[] };
      const models = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).slice(0, 200);
      return {
        ok: true,
        message: models.length ? `连接成功，可用模型 ${models.length} 个` : '连接成功',
        models,
        latencyMs: Date.now() - started,
      };
    }
    // 有些服务商不提供 /models，退化为发一条最小消息
    const probe = await chat({
      purpose: 'writing',
      providerId: p.id,
      model: model || undefined,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
      timeoutMs: 25000,
      silent: true,
    });
    if (probe.ok) return { ok: true, message: '连接成功（该服务商未提供模型列表接口）', latencyMs: Date.now() - started };
    return { ok: false, message: probe.error ?? '连接失败' };
  } catch (e) {
    return { ok: false, message: friendlyError(e, p) };
  }
}

export async function fetchWithTimeout(url:string,init:RequestInit,timeoutMs:number):Promise<Response> {
 if(process.env.WORKBENCH_TEST_MODE==='1' && !isLocalProvider(url))throw new Error('隔离测试不允许调用外部模型');
 const consentId=isLocalProvider(url)?null:await authorizeRequest(url,String(init.body??''),new URL(url).pathname.endsWith('/embeddings')?'资料向量化':new URL(url).pathname.endsWith('/models')?'查询模型列表':'模型对话 / 写作 / 识别');
 const ac=new AbortController();let timer:ReturnType<typeof setTimeout>;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{ac.abort();reject(new DOMException('请求超时','TimeoutError'));},Math.max(1,timeoutMs));});
 try {return await Promise.race([expired,(async()=>{
   const response=await fetch(url,{...init,signal:ac.signal,redirect:'error'});
   const reader=response.body?.getReader(); const parts:Uint8Array[]=[];let size=0;
   if(reader)for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>32*1024*1024){await reader.cancel();throw new Error('模型响应超过 32MB 限制');}parts.push(value);}
   const bytes=Buffer.concat(parts);if(consentId)finishRequest(consentId,response.ok);return new Response([204,205,304].includes(response.status)?null:bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
 })()]);} catch(e){if(consentId)finishRequest(consentId,false);throw e;} finally{clearTimeout(timer!);}
}

function friendlyError(e: unknown, p?: AiProvider): string {
  const err = e as Error & { cause?: { code?: string } };
  const name = err?.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError') return '请求超时：网络慢或模型响应太久，可调大超时时间';
  const code = err?.cause?.code ?? (err as { code?: string }).code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败：Base URL 可能写错了，或本机 DNS/代理有问题';
  if (code === 'ECONNREFUSED') return `连接被拒绝：${p?.base_url ?? ''} 没有服务在监听（本地模型请确认 LM Studio/Ollama/vLLM 已启动）`;
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return '连接被重置：可能是代理/防火墙拦截，或服务商限流';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'HTTPS 证书校验失败：可能有代理在做中间人，检查系统代理设置';
  return err?.message || '未知错误';
}

function httpError(status: number, bodyText: string, p: AiProvider): AiError {
  let detail = bodyText.slice(0, 500);
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
    detail = j.error?.message ?? j.message ?? detail;
  } catch {
    /* 保持原文 */
  }
  if (status === 401 || status === 403) return new AiError('AUTH', `认证失败（${status}）：API Key 不对或没有该模型的权限。${detail}`, status);
  if (status === 404) {
    /**
     * 404 有两个常见原因，而且**模型名写错**（尤其大小写）比 Base URL 更常见 ——
     * 实测：把 qwen3.8-flash 写成 Qwen3.8-Flash，接口回的就是
     * "The model `Qwen3.8-Flash` does not exist"。只提示"检查 Base URL"会把人带偏。
     */
    return new AiError(
      'NOT_FOUND',
      `接口或模型不存在（404）：先确认模型名拼写与大小写（服务商区分大小写），再确认 Base URL 是否带 /v1。${detail}`,
      status,
    );
  }
  if (status === 429) return new AiError('RATE_LIMIT', `被限流或余额不足（429）：${detail}`, status);
  if (status >= 500) return new AiError('UPSTREAM', `服务商返回错误（${status}）：${detail}`, status);
  return new AiError('HTTP', `请求失败（${status}）：${detail}`, status);
}

/* ------------------------------ 调用 ------------------------------ */

export function logCall(entry: {
  purpose?: string;
  provider_code?: string;
  model?: string;
  mode?: string;
  ok: boolean;
  latency_ms?: number;
  prompt_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  error_code?: string;
  error_message?: string;
  ref_type?: string;
  ref_id?: number;
}): void {
  try {
    run(
      `INSERT INTO ai_call_log (purpose, provider_code, model, mode, ok, latency_ms, prompt_tokens, output_tokens, total_tokens, error_code, error_message, ref_type, ref_id, is_test)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        entry.purpose ?? null,
        entry.provider_code ?? null,
        entry.model ?? null,
        entry.mode ?? 'chat',
        entry.ok ? 1 : 0,
        entry.latency_ms ?? null,
        entry.prompt_tokens ?? null,
        entry.output_tokens ?? null,
        entry.total_tokens ?? null,
        entry.error_code ?? null,
        entry.error_message?.slice(0, 1000) ?? null,
        entry.ref_type ?? null,
        entry.ref_id ?? null,
        process.env.WORKBENCH_TEST_MODE==='1' || entry.provider_code?.startsWith('fake-') ? 1 : 0,
      ],
    );
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

export interface ResolvedTarget {
  provider: AiProvider;
  profile: AiProfile;
  model: string;
}

export function resolveTarget(purpose: AiPurpose, opts: { providerId?: number; model?: string } = {}): ResolvedTarget {
  const profile = resolveProfile(purpose);
  if (!profile) {
    throw new AiError('NO_PROFILE', `还没有配置「${purpose}」用途的模型档案，请到「系统配置 → 模型接入」里选择服务商和模型`);
  }
  const providerId = opts.providerId ?? profile.provider_id;
  if (!providerId) {
    throw new AiError('NO_PROVIDER', `用途「${profile.name}」还没有指定服务商，请到「系统配置 → 模型接入」里选择`);
  }
  const provider = getProvider(providerId);
  if (!provider) throw new AiError('NO_PROVIDER', '模型档案指向的服务商已不存在，请重新选择');
  if (!provider.enabled) throw new AiError('DISABLED', `服务商「${provider.name}」已被停用`);
  const key = resolveApiKey(provider);
  if (!key && !isLocalProvider(provider.base_url)) {
    throw new AiError('NO_KEY', `服务商「${provider.name}」还没有填 API Key`);
  }
  const model = opts.model || profile.model || '';
  if (!model) throw new AiError('NO_MODEL', `用途「${profile.name}」还没有指定模型名`);
  return { provider, profile, model };
}

/**
 * 最近一次真实向量化调用的结果，按「服务商:模型」记。
 *
 * 为什么需要它：`resolveTarget` 只能检查"档案填没填、服务商启没启用、有没有 Key"，
 * 查不出**这个服务商压根没有 /embeddings 接口**（DeepSeek 就是）。于是会出现
 * 「状态显示向量化已就绪，传上去的文档却一篇也向量化不了」——绿灯骗人。
 * 这里把真实调用的结果记下来，readiness 就能说真话；换个模型/服务商就是新 key，自动重新判断。
 */
export function embeddingSignature():string {const t=resolveTarget('embedding');return JSON.stringify([t.provider.id,normalizeBase(t.provider.base_url),t.model,t.profile.embedding_dim ?? null]);}
function outcomeSignature(t:ResolvedTarget):string {return JSON.stringify([t.provider.id,t.provider.base_url,t.model,t.provider.updated_at,t.profile.updated_at]);}
const embedOutcomes = new Map<string, { ok: boolean; error?: string; code?: string; at: number }>();

/** 判断某类错误是不是"这个组合根本干不了向量化"（配置问题），而不是临时抖动 */
function isCapabilityError(code?: string): boolean {
  return code === 'NOT_FOUND' || code === 'AUTH' || code === 'DISABLED' || code === 'NO_KEY' || code === 'NO_MODEL';
}

/**
 * 某个用途现在到底能不能用 —— 一句话回答，附带不能用的原因。
 *
 * 界面上「模型已就绪」这种绿灯不能只看档案里填没填：
 * 服务商被停用、Key 还没填、模型名是空的，都会让调用失败；
 * 向量化还多一层 —— 服务商可能根本没有 embedding 接口。
 * 与其让用户点下去才发现，不如提前把原因说出来（顺手也能在自检里断言）。
 */
export function aiReadiness(purpose: AiPurpose): {
  ready: boolean;
  reason?: string;
  code?: string;
  provider?: string;
  model?: string;
} {
  let target: ResolvedTarget;
  try {
    target = resolveTarget(purpose);
  } catch (e) {
    const err = e as AiError;
    return { ready: false, reason: err.message, code: err.code };
  }
  if (purpose === 'embedding') {
    const last = embedOutcomes.get(outcomeSignature(target));
    if (last && !last.ok && isCapabilityError(last.code)) {
      return {
        ready: false,
        reason: last.error ?? '这个服务商/模型无法做向量化',
        code: last.code,
        provider: target.provider.name,
        model: target.model,
      };
    }
  }
  return { ready: true, provider: target.provider.name, model: target.model };
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const purpose = opts.purpose ?? 'writing';
  const started = Date.now();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(purpose, { providerId: opts.providerId, model: opts.model });
  } catch (e) {
    const err = e as AiError;
    logCall({ purpose, ok: false, error_code: err.code, error_message: err.message, ref_type: opts.ref?.type, ref_id: opts.ref?.id });
    return {
      ok: false,
      text: '',
      model: '',
      providerCode: '',
      usage: { prompt: 0, output: 0, total: 0 },
      latencyMs: 0,
      error: err.message,
    };
  }

  const { provider, profile, model } = target;
  // Evidence writing owns its fact/analysis/recommendation contract. A legacy
  // free-text global style must not override it with a second factual policy.
  const styleGuard = opts.ref?.type === 'business-evidence-writing'
    ? '公文体，简洁准确，段落清晰；保留事实、分析、建议及待补内容的不同身份。'
    : getSetting('ai.writing_style', '');
  const messages = opts.messages.map(m=>({...m}));
  if (styleGuard && purpose === 'writing' && !messages.some((m) => messageText(m).includes(styleGuard))) {
    const sys = messages.find((m) => m.role === 'system');
    if (sys) sys.content = `${messageText(sys)}\n\n【写作规范】${styleGuard}`;
    else messages.unshift({ role: 'system', content: `【写作规范】${styleGuard}` });
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: opts.temperature ?? profile.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? profile.max_tokens ?? 4096,
    stream: false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  // 工具调用模式：注意**不要同时开 json_object**，两者一起用多数服务商会互相打架
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
    delete body.response_format;
  }
  if (profile.extra_body) {
    try {
      const extra=JSON.parse(profile.extra_body) as Record<string,unknown>;
      for(const [key,value] of Object.entries(extra))if(!['model','messages','max_tokens','stream','tools','tool_choice','response_format'].includes(key))body[key]=value;
    } catch {
      /* 忽略非法 extra_body */
    }
  }

  if(opts.thinking==='disabled'&&new URL(provider.base_url).hostname==='api.deepseek.com'){
    body.thinking={type:'disabled'};delete body.reasoning_effort;
  }

  const timeoutMs = opts.timeoutMs ?? profile.timeout_ms ?? 120000;
  try {
    const res = await fetchWithTimeout(
      `${normalizeBase(provider.base_url)}/chat/completions`,
      { method: 'POST', headers: buildHeaders(provider), body: JSON.stringify(body) },
      timeoutMs,
    );
    const text = await res.text();
    if (!res.ok) throw httpError(res.status, text, provider);
    const data = JSON.parse(text) as {
      choices?: {
        message?: {
          content?: string;
          reasoning_content?: string;
          tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: string;
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      model?: string;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    const finishReason = data.choices?.[0]?.finish_reason;
    /** 模型请求调用的工具；有的服务商不返回 id，补一个，否则回填 tool 消息时对不上 */
    const toolCalls: ToolCall[] = (data.choices?.[0]?.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => ({
        id: c.id || `call_${i}_${Date.now().toString(36)}`,
        type: c.type ?? 'function',
        function: { name: c.function?.name as string, arguments: c.function?.arguments ?? '{}' },
      }));
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    const usage = {
      prompt: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      total: data.usage?.total_tokens ?? 0,
      ...(reasoningTokens > 0 ? { reasoning: reasoningTokens } : {}),
    };
    const latencyMs = Date.now() - started;
    // 输出被 max_tokens 截断时，content 往往是空串或半截 JSON。
    // 明说「被截断」而不是让上层收到一个空结果去猜，否则排查起来毫无线索。
    if (finishReason === 'length') {
      const why = reasoningTokens > 0 ? `（其中 ${reasoningTokens} 个 token 花在模型思考上）` : '';
      if (!opts.silent) {
        logCall({
          purpose,
          provider_code: provider.code,
          model: data.model ?? model,
          mode: opts.json ? 'json' : 'chat',
          ok: false,
          latency_ms: latencyMs,
          prompt_tokens: usage.prompt,
          output_tokens: usage.output,
          total_tokens: usage.total,
          error_code: 'TRUNCATED',
          error_message: `输出达到 max_tokens=${body.max_tokens} 被截断${why}，请调大上限或让提示词更精简`,
          ref_type: opts.ref?.type,
          ref_id: opts.ref?.id,
        });
      }
      return {
        ok: false,
        text: content,
        model: data.model ?? model,
        providerCode: provider.code,
        usage,
        latencyMs,
        error: `模型输出被截断（达到 max_tokens=${body.max_tokens}）${why}。请调大该用途的「最大 token」，或把任务拆小。`,
        raw: data,
      };
    }
    if (!opts.silent) {
      logCall({
        purpose,
        provider_code: provider.code,
        model: data.model ?? model,
        mode: opts.json ? 'json' : 'chat',
        ok: true,
        latency_ms: latencyMs,
        prompt_tokens: usage.prompt,
        output_tokens: usage.output,
        total_tokens: usage.total,
        ref_type: opts.ref?.type,
        ref_id: opts.ref?.id,
      });
    }
    return {
      ok: true,
      text: content,
      model: data.model ?? model,
      providerCode: provider.code,
      usage,
      latencyMs,
      ...(toolCalls.length ? { toolCalls } : {}),
      raw: data,
    };
  } catch (e) {
    const latencyMs = Date.now() - started;
    const message = e instanceof AiError ? e.message : friendlyError(e, provider);
    const code = e instanceof AiError ? e.code : 'NETWORK';
    if (!opts.silent) {
      logCall({
        purpose,
        provider_code: provider.code,
        model,
        mode: opts.json ? 'json' : 'chat',
        ok: false,
        latency_ms: latencyMs,
        error_code: code,
        error_message: message,
        ref_type: opts.ref?.type,
        ref_id: opts.ref?.id,
      });
    }
    return { ok: false, text: '', model, providerCode: provider.code, usage: { prompt: 0, output: 0, total: 0 }, latencyMs, error: message };
  }
}

/* ------------------------------ 向量 ------------------------------ */

export async function embed(texts: string[], opts: { purpose?: AiPurpose; providerId?: number; model?: string } = {}): Promise<{ ok: boolean; vectors: number[][]; error?: string; model?: string }> {
  const purpose = opts.purpose ?? 'embedding';
  const started = Date.now();
  let target: ResolvedTarget;
  try {
    target = resolveTarget(purpose, opts);
  } catch (e) {
    const err = e as AiError;
    logCall({ purpose, ok: false, error_code: err.code, error_message: err.message, mode: 'embedding' });
    return { ok: false, vectors: [], error: err.message };
  }
  const { provider, model } = target;
  const outcomeKey = outcomeSignature(target);
  try {
    const res = await fetchWithTimeout(
      `${normalizeBase(provider.base_url)}/embeddings`,
      { method: 'POST', headers: buildHeaders(provider), body: JSON.stringify({ model, input: texts }) },
      target.profile.timeout_ms ?? 120000,
    );
    const text = await res.text();
    if (!res.ok) throw httpError(res.status, text, provider);
    const data = JSON.parse(text) as { data?: { embedding: number[]; index: number }[]; usage?: { total_tokens?: number } };
    const vectors = (data.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if(vectors.length!==texts.length || !vectors.length || vectors.some(v=>!Array.isArray(v) || !v.length || v.length!==vectors[0]!.length || v.some(n=>!Number.isFinite(n)))) throw new Error('向量响应数量、维度或数值无效');
    embedOutcomes.set(outcomeKey, { ok: true, at: Date.now() });
    logCall({
      purpose,
      provider_code: provider.code,
      model,
      mode: 'embedding',
      ok: true,
      latency_ms: Date.now() - started,
      total_tokens: data.usage?.total_tokens ?? 0,
    });
    return { ok: true, vectors, model };
  } catch (e) {
    const raw = e instanceof AiError ? e.message : friendlyError(e, provider);
    /**
     * 向量化的 404 基本上是「这个服务商压根没有 embeddings 接口」，不是 Base URL 写错了。
     * 通用 404 提示会让人去改 Base URL，改半天也改不通 —— 实测 DeepSeek 就是这样：
     * /v1/embeddings 无论用哪个模型名都是 404，它只有对话模型。
     * 所以这里换一句话说，并给出能用的方向。
     */
    const is404 = e instanceof AiError && e.code === 'NOT_FOUND';
    const message = is404
      ? `服务商「${provider.name}」没有向量化接口（/embeddings 返回 404）。对话模型不能拿来做向量化，请改用提供 embedding 接口的服务商（如阿里通义 text-embedding-v3、智谱 embedding-3、OpenAI text-embedding-3-small，或本机 Ollama 跑 bge-m3）。`
      : raw;
    embedOutcomes.set(outcomeKey, {
      ok: false,
      error: message,
      code: e instanceof AiError ? e.code : 'NETWORK',
      at: Date.now(),
    });
    logCall({ purpose, provider_code: provider.code, model, mode: 'embedding', ok: false, latency_ms: Date.now() - started, error_code: 'EMBED', error_message: message });
    return { ok: false, vectors: [], error: message };
  }
}

/* --------------------------- JSON 结果解析 --------------------------- */

/** 容错解析模型返回的 JSON：剥掉 ```json 围栏、截取第一个完整对象 */
export function parseJsonLoose<T = unknown>(text: string): { ok: boolean; value?: T; error?: string } {
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  const tryParse = (s: string) => {
    try {
      return { ok: true as const, value: JSON.parse(s) as T };
    } catch {
      return null;
    }
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const start = cleaned.search(/[{[]/);
  if (start >= 0) {
    const open = cleaned[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = start; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const r = tryParse(cleaned.slice(start, i + 1));
          if (r) return r;
          break;
        }
      }
    }
  }
  return { ok: false, error: '模型返回的不是合法 JSON，已保留原文供人工修正' };
}
