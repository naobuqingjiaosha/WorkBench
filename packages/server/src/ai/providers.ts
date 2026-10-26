/**
 * 模型服务商与模型档案（数据库访问层）
 */
import { all, get, run } from '../db/index.ts';

export interface AiProvider {
  id: number;
  code: string;
  name: string;
  kind: string;
  base_url: string;
  api_key: string | null;
  api_key_env: string | null;
  extra_headers: string | null;
  enabled: number;
  is_builtin: number;
  remark: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AiProfile {
  id: number;
  purpose: AiPurpose;
  name: string;
  provider_id: number | null;
  model: string | null;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  embedding_dim: number | null;
  extra_body: string | null;
  note: string | null;
  updated_at: string;
}

export type AiPurpose = 'writing' | 'extract' | 'reasoning' | 'vision' | 'embedding' | 'agent';

/**
 * 六种用途。
 *
 * `wired` 表示**当前代码里真的有地方调用它**。写在这里是为了不骗人：
 * 「图像识别」的档案能配、能测，但影像证据那条流程还没接上模型，
 * 界面必须标出来，否则配好了却一直不生效，人会以为是 Key 或模型的问题。
 */
export const PURPOSES: { purpose: AiPurpose; name: string; usage: string; wired: boolean }[] = [
  { purpose: 'writing', name: '文书写作', usage: '生成公文、报告、方案、总结等正文', wired: true },
  { purpose: 'extract', name: '信息抽取', usage: '从合同、纪要、清单里抽取字段值', wired: true },
  { purpose: 'reasoning', name: '复杂推理', usage: '缺项分析、合规检查、多步判断', wired: true },
  { purpose: 'agent', name: 'AI 助手', usage: '对话式办事：查数据、改字段、记备忘。需要模型支持工具调用', wired: true },
  { purpose: 'vision', name: '图像识别', usage: '看照片：是否符合拍摄要求、要不要补拍', wired: true },
  { purpose: 'embedding', name: '向量化', usage: '知识库语义检索与问答', wired: true },
];

export function listProviders(onlyEnabled = false): AiProvider[] {
  return all<AiProvider>(
    `SELECT * FROM ai_provider ${onlyEnabled ? 'WHERE enabled = 1' : ''} ORDER BY sort_order, id`,
  );
}

export function getProvider(idOrCode: number | string): AiProvider | undefined {
  return typeof idOrCode === 'number'
    ? get<AiProvider>('SELECT * FROM ai_provider WHERE id = ?', [idOrCode])
    : get<AiProvider>('SELECT * FROM ai_provider WHERE code = ?', [idOrCode]);
}

export function upsertProvider(input: Partial<AiProvider> & { code: string; name: string; base_url: string }): number {
  const existing = getProvider(input.code);
  let extra = input.extra_headers === undefined ? null : input.extra_headers;
  if(extra) {const given=JSON.parse(extra) as Record<string,unknown>;if(!given || Array.isArray(given) || typeof given!=='object' || Object.values(given).some(v=>typeof v!=='string'))throw new Error('额外请求头必须是字符串映射');
    const old=JSON.parse(existing?.extra_headers ?? '{}') as Record<string,string>;
    for(const k of Object.keys(given)) if(given[k]==='******') {if(k in old)given[k]=old[k];else delete given[k];}
    extra=JSON.stringify(given);
  }
  if (existing) {
    run(
      `UPDATE ai_provider SET name = ?, kind = COALESCE(?, kind), base_url = ?, api_key = COALESCE(?, api_key),
         api_key_env = COALESCE(?, api_key_env), extra_headers = COALESCE(?, extra_headers),
         enabled = COALESCE(?, enabled), remark = COALESCE(?, remark),
         sort_order = COALESCE(?, sort_order), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      [
        input.name,
        input.kind ?? null,
        input.base_url,
        input.api_key ?? null,
        input.api_key_env ?? null,
        extra,
        input.enabled ?? null,
        input.remark ?? null,
        input.sort_order ?? null,
        existing.id,
      ],
    );
    return existing.id;
  }
  const r = run(
    `INSERT INTO ai_provider (code, name, kind, base_url, api_key, api_key_env, extra_headers, enabled, is_builtin, remark, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.code,
      input.name,
      input.kind ?? 'openai-compatible',
      input.base_url,
      input.api_key ?? null,
      input.api_key_env ?? null,
      extra,
      input.enabled ?? 1,
      input.is_builtin ?? 0,
      input.remark ?? null,
      input.sort_order ?? 100,
    ],
  );
  return r.lastInsertRowid;
}

export function deleteProvider(id: number): void {
  const p = getProvider(id);
  if (!p) return;
  if (p.is_builtin) throw new Error('预置服务商不能删除，可以停用');
  run('DELETE FROM ai_provider WHERE id = ?', [id]);
  /**
   * 指向它的模型档案要一起清干净。
   *
   * 外键会把 provider_id 置空，但模型名会留下 —— 于是配置看起来「选过模型」，
   * 实际解析时会回退到写作服务商、拿一个那边根本没有的模型名去调，
   * 报出来的错跟真正的原因（服务商没了）差着十万八千里。
   * 这里把模型名也清掉，界面就会老实提示「还没配置」。
   */
  run("UPDATE ai_profile SET model = NULL, embedding_dim = NULL WHERE provider_id IS NULL AND model IS NOT NULL");
}

/* ------------------------------ 模型档案 ------------------------------ */

export function listProfiles(): (AiProfile & { provider_name: string | null; provider_code: string | null })[] {
  return all(
    `SELECT p.*, v.name AS provider_name, v.code AS provider_code
       FROM ai_profile p LEFT JOIN ai_provider v ON v.id = p.provider_id
      ORDER BY CASE p.purpose WHEN 'writing' THEN 1 WHEN 'extract' THEN 2 WHEN 'reasoning' THEN 3 WHEN 'agent' THEN 4 WHEN 'vision' THEN 5 ELSE 6 END`,
  );
}

export function getProfile(purpose: AiPurpose): AiProfile | undefined {
  return get<AiProfile>('SELECT * FROM ai_profile WHERE purpose = ?', [purpose]);
}

/**
 * 哪些用途可以在没配时回退到「文书写作」。
 *
 * **只有纯文本生成类的可以。** 视觉和向量化有硬性能力要求：
 *   · 看图必须是多模态模型 —— 回退到 DeepSeek 这种文本模型，它会回一句
 *     "invalid content type" 之类的错，用户根本猜不到是"没配视觉模型"；
 *   · 向量化必须走 /embeddings —— 回退到对话模型就是那个 404。
 * 所以这两个用途宁可明确报「还没指定服务商」，也不要拿个干不了这活的模型去撞。
 */
const FALLBACK_TO_WRITING: AiPurpose[] = ['extract', 'reasoning', 'agent'];

/** 取档案：文本类用途没配就回退到 writing；视觉/向量化不回退 */
export function resolveProfile(purpose: AiPurpose): AiProfile | undefined {
  const p = getProfile(purpose);
  if (p && p.provider_id) return p;
  if (FALLBACK_TO_WRITING.includes(purpose)) {
    const w = getProfile('writing');
    if (w && w.provider_id) return { ...w, purpose, name: `${w.name}（回退）` };
  }
  return p;
}

export function upsertProfile(input: Partial<AiProfile> & { purpose: AiPurpose; name: string }): number {
  const existing = getProfile(input.purpose);
  if (existing) {
    run(
      `UPDATE ai_profile SET name = ?, provider_id = ?, model = ?, temperature = COALESCE(?, temperature),
         max_tokens = COALESCE(?, max_tokens), timeout_ms = COALESCE(?, timeout_ms),
         embedding_dim = COALESCE(?, embedding_dim), extra_body = COALESCE(?, extra_body),
         note = COALESCE(?, note), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
      [
        input.name,
        input.provider_id ?? null,
        input.model ?? null,
        input.temperature ?? null,
        input.max_tokens ?? null,
        input.timeout_ms ?? null,
        input.embedding_dim ?? null,
        input.extra_body ?? null,
        input.note ?? null,
        existing.id,
      ],
    );
    return existing.id;
  }
  const r = run(
    `INSERT INTO ai_profile (purpose, name, provider_id, model, temperature, max_tokens, timeout_ms, embedding_dim, extra_body, note)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      input.purpose,
      input.name,
      input.provider_id ?? null,
      input.model ?? null,
      input.temperature ?? 0.2,
      input.max_tokens ?? 4096,
      input.timeout_ms ?? 120000,
      input.embedding_dim ?? null,
      input.extra_body ?? null,
      input.note ?? null,
    ],
  );
  return r.lastInsertRowid;
}

/** 对外返回时把 key 打码 */
function maskHeaders(raw:string|null):string|null {try{return raw?JSON.stringify(Object.fromEntries(Object.keys(JSON.parse(raw)).map(k=>[k,'******']))):null;}catch{return null;}}

export function maskProvider(p: AiProvider): AiProvider & { has_key: boolean; key_hint: string } {
  const key = resolveApiKey(p);
  return {
    ...p,
    api_key: null,
    extra_headers:maskHeaders(p.extra_headers),
    has_key: Boolean(key),
    key_hint: key ? '已配置' : '',
  };
}

export function resolveApiKey(p: AiProvider): string {
  if (p.api_key_env && process.env[p.api_key_env]) return String(process.env[p.api_key_env]);
  return p.api_key ?? '';
}

/** 预置服务商模板 */
export const BUILTIN_PROVIDERS: {
  code: string;
  name: string;
  base_url: string;
  api_key_env: string;
  remark: string;
  sort_order: number;
}[] = [
  {
    code: 'deepseek',
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    api_key_env: 'DEEPSEEK_API_KEY',
    remark: '中文写作性价比高。模型：deepseek-chat / deepseek-reasoner',
    sort_order: 10,
  },
  {
    code: 'openai-compatible',
    name: 'OpenAI 兼容（中转/自建）',
    base_url: 'https://api.openai.com/v1',
    api_key_env: 'OPENAI_API_KEY',
    remark: '任何兼容 /chat/completions 的服务都能用，改成你的 base_url 即可',
    sort_order: 20,
  },
  {
    code: 'dashscope',
    name: '阿里通义千问（兼容模式）',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api_key_env: 'DASHSCOPE_API_KEY',
    remark: '模型：qwen-plus / qwen-max / text-embedding-v3',
    sort_order: 30,
  },
  {
    code: 'zhipu',
    name: '智谱 GLM',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    api_key_env: 'ZHIPU_API_KEY',
    remark: '模型：glm-4-plus / embedding-3',
    sort_order: 40,
  },
  {
    code: 'moonshot',
    name: '月之暗面 Kimi',
    base_url: 'https://api.moonshot.cn/v1',
    api_key_env: 'MOONSHOT_API_KEY',
    remark: '模型：moonshot-v1-8k / kimi-k2',
    sort_order: 50,
  },
  {
    code: 'lmstudio',
    name: '本地 LM Studio',
    base_url: 'http://127.0.0.1:1234/v1',
    api_key_env: 'LM_STUDIO_API_KEY',
    remark: '本机服务，API Token 可选；模型名称从 LM Studio 获取',
    sort_order: 55,
  },
  {
    code: 'ollama',
    name: '本地 Ollama',
    base_url: 'http://127.0.0.1:11434/v1',
    api_key_env: 'OLLAMA_API_KEY',
    remark: '数据不出本机。模型：qwen2.5:14b / bge-m3（向量）',
    sort_order: 60,
  },
];

/** 预置服务商里默认启用的（其余需要用户自己开） */
export const DEFAULT_ENABLED_PROVIDERS = ['deepseek', 'openai-compatible'];

export function seedProviders(): void {
  for (const p of BUILTIN_PROVIDERS) {
    const enabled = DEFAULT_ENABLED_PROVIDERS.includes(p.code) ? 1 : 0;
    const existing = getProvider(p.code);
    if (existing) {
      // 已存在时只保证"停用状态"与默认一致，不动其它字段（避免覆盖用户配置）
      // 已有配置（包括停用状态）由用户决定。
      continue;
    }
    upsertProvider({ ...p, kind: 'openai-compatible', enabled, is_builtin: 1 });
  }
  const defaults: { purpose: AiPurpose; name: string; model: string }[] = [
    { purpose: 'writing', name: '文书写作', model: 'deepseek-chat' },
    { purpose: 'extract', name: '信息抽取', model: 'deepseek-chat' },
    { purpose: 'reasoning', name: '复杂推理', model: 'deepseek-reasoner' },
    { purpose: 'agent', name: 'AI 助手', model: 'deepseek-chat' },
    { purpose: 'vision', name: '图像识别', model: 'qwen-vl-max' },
    { purpose: 'embedding', name: '向量化', model: 'text-embedding-v3' },
  ];
  for (const d of defaults) {
    if (getProfile(d.purpose)) continue;
    /**
     * 「AI 助手」默认跟着「复杂推理」走。
     *
     * 写死一个模型名在这里是不对的：不同账号能用的模型名不一样（本机 DeepSeek 只有
     * deepseek-flash / deepseek-v4-pro，没有 deepseek-chat）。助手这条线还有额外要求
     * ——必须支持工具调用——所以默认继承你已经调好的推理模型最稳，之后可以在界面上单独换。
     */
    if (d.purpose === 'agent') {
      const reasoning = getProfile('reasoning');
      if (reasoning) {
        upsertProfile({
          purpose: 'agent',
          name: d.name,
          provider_id: reasoning.provider_id,
          model: reasoning.model,
          temperature: reasoning.temperature,
          max_tokens: reasoning.max_tokens,
          timeout_ms: reasoning.timeout_ms,
        });
        continue;
      }
    }
    const provider =
      d.purpose === 'embedding' || d.purpose === 'vision'
        ? getProvider('dashscope')
        : getProvider('deepseek') ?? getProvider('openai-compatible');
    upsertProfile({ purpose: d.purpose, name: d.name, provider_id: provider?.id ?? null, model: d.model });
  }
}
