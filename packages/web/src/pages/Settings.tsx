import {PageSplit,SectionNav,LoadError} from '../components/DesignSystem';
import {useEditorGuard} from '../components/NavigationGuard';
import { useEffect, useState } from 'react';
import LocalModelSettings from '../components/LocalModelSettings';
import { api, useApi, type AiProfile, type AiProvider, type KbComplianceConfig, type KbExtractConfig, type KbExtractSettings, type KbSource } from '../api';

/** 例外放行留痕的一行（GET /api/kb/compliance/exceptions） */
interface KbComplianceExceptionRow {
  id: number;
  rule_code: string;
  artifact_id: number | null;
  artifact_title: string | null;
  clause_path: string | null;
  severity: string | null;
  reason: string;
  actor: string | null;
  created_at: string;
}
import { Button, Card, Empty, Field, Input, Loading, Modal, Select, Tag, Textarea, fmtSize, fmtTime, useAction, useToast } from '../ui';

/** 用途说明的兜底文案；正常情况下用后端返回的 purposes（它才知道哪个用途真的接进了流程） */
const PURPOSE_TEXT: Record<string, { name: string; usage: string; wired: boolean }> = {
  writing: { name: '文书写作', usage: '生成公文、报告、方案、总结', wired: true },
  extract: { name: '信息抽取', usage: '从合同、纪要里抽取字段', wired: true },
  reasoning: { name: '复杂推理', usage: '缺项分析、合规检查', wired: true },
  agent: { name: 'AI 助手', usage: '对话式办事：查数据、改字段、记备忘', wired: true },
  vision: { name: '图像识别', usage: '看照片：是否符合拍摄要求、要不要补拍', wired: true },
  embedding: { name: '向量化', usage: '知识库语义检索', wired: true },
};

export default function SettingsPage() {
  const toast = useToast();
  const [section,setSection]=useState('runtime');
  const health=useApi<{status:string;webBuilt:boolean;time:string;loadedBuild:{startedAt:string;sourceSha256:string;frontendSha256:string}}>('/api/health');
  const overview = useApi<{
    providers: AiProvider[];
    profiles: AiProfile[];
    purposes: { purpose: string; name: string; usage: string; wired: boolean }[];
  }>('/api/ai/overview');
  const system = useApi<{
    dataRoot: string;
    dbFile: string;
    configFile: string | null;
    node: string;
    platform: string;
    settings: { key: string; value: string | null }[];
  }>('/api/system/info');
  const [editProvider, setEditProvider] = useState<AiProvider | 'new' | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  const providers = overview.data?.providers ?? [];
  const profiles = overview.data?.profiles ?? [];
  const setting = (key: string) => system.data?.settings.find((s) => s.key === key)?.value ?? '';

  const [form, setForm] = useState({ org: '', operator: '', style: '' });
  useEffect(() => {
    if (!system.data) return;
    setForm({
      org: setting('app.org'),
      operator: setting('app.operator'),
      style: setting('ai.writing_style'),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system.data]);

  const { busy, run } = useAction();
  const savedForm={org:setting('app.org'),operator:setting('app.operator'),style:setting('ai.writing_style')};
  const [baseline,setBaseline]=useState('');
  useEffect(()=>{if(system.data)setBaseline(JSON.stringify(savedForm));},[system.data]);
  const dirty=!!baseline&&JSON.stringify(form)!==baseline;
  const saveForm=async()=>{await api.put('/api/settings',{'app.org':form.org,'app.operator':form.operator,'ai.writing_style':form.style});setBaseline(JSON.stringify(form));toast('本栏目已保存','ok');};
  const request=useEditorGuard({dirty,save:saveForm,discard:()=>setForm(JSON.parse(baseline))});


  return (
    <PageSplit nav={<SectionNav value={section} onChange={v=>request(()=>setSection(v))} items={[{value:'runtime',label:'运行状态'},{value:'models',label:'模型与资料'},{value:'backup',label:'目录与备份'},{value:'app',label:'应用与导出'}]}/>}><div className="section-content">
      {section==='runtime'&&<><Card title="运行状态" extra={<Button onClick={health.reload}>重新检查</Button>}>{health.error?<LoadError error={health.error} retry={health.reload}/>:health.loading?<Loading/>:<><div className="summary-grid"><div>服务状态<strong>{health.data?.status==='ok'?'正常':'待核查'}</strong></div><div>前端构建<strong>{health.data?.webBuilt?'已加载':'未找到'}</strong></div><div>运行方式<strong>本机</strong></div></div><p className="small muted">检查时间 {fmtTime(health.data?.time)} · 当前连接 {window.location.origin}</p></>}</Card><Card title="高级诊断" collapsible defaultOpen={false}><dl className="kv"><dt>启动时间</dt><dd>{fmtTime(health.data?.loadedBuild.startedAt)}</dd><dt>后端摘要</dt><dd className="mono">{health.data?.loadedBuild.sourceSha256}</dd><dt>前端摘要</dt><dd className="mono">{health.data?.loadedBuild.frontendSha256}</dd></dl></Card></>}
      <div className="settings-panel" hidden={section!=='models'}>
      <div className="notice notice-info">
        模型接口按 OpenAI 兼容协议接入，支持 LM Studio、Ollama 及兼容的云端服务。
        API Key 只存在本机数据库里，只在本机 <code>127.0.0.1</code> 上使用，接口返回时一律打码。
      </div>

      <LocalModelSettings providers={providers} profiles={profiles} onSaved={overview.reload} />

      <Card
        title="模型服务商"
        extra={
          <Button size="sm" kind="primary" onClick={() => setEditProvider('new')}>
            ＋ 添加服务商
          </Button>
        }
      >
        {overview.loading ? (
          <Loading />
        ) : overview.error ? <LoadError error={overview.error} retry={overview.reload}/> : (
          <table className="table">
            <thead>
              <tr>
                <th>名称</th>
                <th>Base URL</th>
                <th>API Key</th>
                <th>状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                    {p.is_builtin ? <Tag> 预置</Tag> : null}
                    {p.remark && <div className="small muted">{p.remark}</div>}
                  </td>
                  <td className="mono small" style={{ maxWidth: 260, wordBreak: 'break-all' }}>
                    {p.base_url}
                  </td>
                  <td className="small">
                    {p.has_key ? (
                      <span className="mono">{p.key_hint}</span>
                    ) : /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/.test(p.base_url) ? (
                      <span className="muted">可选（本机服务）</span>
                    ) : p.api_key_env ? (
                      <span className="muted">未填（或设环境变量 {p.api_key_env}）</span>
                    ) : (
                      <Tag kind="warn">未填</Tag>
                    )}
                  </td>
                  <td>
                    {p.enabled ? <Tag kind="ok">已启用</Tag> : <Tag>已停用</Tag>}
                  </td>
                  <td className="nowrap">
                    <Button
                      size="sm"
                      disabled={testingId === p.id}
                      onClick={async () => {
                        setTestingId(p.id);
                        try {
                          const r = await api.post<{ ok: boolean; message: string; models?: string[]; latencyMs?: number }>(
                            `/api/ai/providers/${p.id}/test`,
                          );
                          toast(
                            r.ok
                              ? `✓ ${r.message}${r.latencyMs ? `（${r.latencyMs}ms）` : ''}${r.models?.length ? `：${r.models.slice(0, 8).join(', ')}${r.models.length > 8 ? ' …' : ''}` : ''}`
                              : `✗ ${r.message}`,
                            r.ok ? 'ok' : 'err',
                          );
                        } catch (e) {
                          toast((e as { message: string }).message, 'err');
                        } finally {
                          setTestingId(null);
                        }
                      }}
                    >
                      {testingId === p.id ? '测试中…' : '测试连接'}
                    </Button>
                    <Button size="sm" onClick={() => setEditProvider(p)}>
                      配置
                    </Button>
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          await api.put(`/api/ai/providers/${p.id}`, { enabled: p.enabled ? 0 : 1 });
                          overview.reload();
                        } catch (e) {
                          toast((e as { message: string }).message, 'err');
                        }
                      }}
                    >
                      {p.enabled ? '停用' : '启用'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="模型档案（按用途指定用哪个模型）">
        <div className="small muted mb12">
          文本用途未配置时回退到「文书写作」；图像识别和向量化必须单独配置对应模型。
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>用途</th>
              <th>服务商</th>
              <th>模型名</th>
              <th>温度</th>
              <th>最长输出</th>
              <th>超时</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <ProfileRow
                key={p.purpose}
                profile={p}
                providers={providers}
                meta={overview.data?.purposes?.find((x) => x.purpose === p.purpose)}
                onSaved={overview.reload}
              />
            ))}
          </tbody>
        </table>
      </Card>

      </div><div className="settings-panel" hidden={section!=='app'}>
      <Card title="应用设置">
        <div className="inline-fields">
          <Field label="单位名称" hint="出现在公文抬头、盖章处、模板变量 {单位名称}">
            <Input value={form.org} onChange={(v) => setForm({ ...form, org: v })} placeholder="某某单位" />
          </Field>
          <Field label="默认经办人" hint="生成文书时默认的编制人">
            <Input value={form.operator} onChange={(v) => setForm({ ...form, operator: v })} placeholder="你的名字" />
          </Field>
        </div>
        <Field label="写作风格约束" hint="每次调用写作模型时固定注入，用来约束文风和禁止编造">
          <Textarea value={form.style} onChange={(v) => setForm({ ...form, style: v })} rows={3} />
        </Field>
        <Button
          kind="primary"
          disabled={busy||!dirty}
          onClick={()=>void run(saveForm)}
        >
          保存设置
        </Button>
      </Card>

      </div><div className="settings-panel" hidden={section!=='backup'}>
      <Card title="目录与运行环境">
        {system.loading ? (
          <Loading />
        ) : system.error ? <LoadError error={system.error} retry={system.reload}/> : (
          <dl className="kv">
            <dt>数据目录</dt>
            <dd className="mono">{system.data?.dataRoot}</dd>
            <dt>数据库</dt>
            <dd className="mono">{system.data?.dbFile}</dd>
            <dt>本机配置</dt>
            <dd className="mono">{system.data?.configFile || "当前环境不加载本机配置"}</dd>
            <dt>运行环境</dt>
            <dd>
              Node {system.data?.node} / {system.data?.platform}
            </dd>
          </dl>
        )}
        <div className="notice mt12 small">
          想换数据目录（比如放到 OneDrive 同步）？编辑当前环境的本机 <code>workbench.config.json</code>（位置见上方），把 <code>dataRoot</code>{' '}
          改成新路径，然后把原来的整个文件夹复制过去，重启程序即可。
        </div>
      </Card>

      <BackupCard />
      </div><div className="settings-panel" hidden={section!=='models'}><AiLogsCard/><KbExtractCard/><ComplianceCard/><OcrCard/></div>

      {editProvider && (
        <ProviderModal
          provider={editProvider === 'new' ? undefined : editProvider}
          onClose={() => setEditProvider(null)}
          onSaved={() => {
            setEditProvider(null);
            overview.reload();
          }}
        />
      )}
    </div></PageSplit>
  );
}

function ProfileRow({
  profile,
  providers,
  meta: metaFromApi,
  onSaved,
}: {
  profile: AiProfile;
  providers: AiProvider[];
  meta?: { name: string; usage: string; wired: boolean };
  onSaved: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = useState({
    providerId: profile.provider_id ? String(profile.provider_id) : '',
    model: profile.model ?? '',
    temperature: String(profile.temperature),
    maxTokens: String(profile.max_tokens),
    timeoutMs: String(profile.timeout_ms),
  });
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => {
    setForm({ providerId: profile.provider_id ? String(profile.provider_id) : '', model: profile.model ?? '',
      temperature: String(profile.temperature), maxTokens: String(profile.max_tokens), timeoutMs: String(profile.timeout_ms) });
    setModels([]);
  }, [profile.provider_id, profile.model, profile.temperature, profile.max_tokens, profile.timeout_ms]);
  const { busy, run } = useAction();
  const meta = metaFromApi ?? PURPOSE_TEXT[profile.purpose] ?? { name: profile.name, usage: '', wired: true };

  return (
    <tr>
      <td>
        <strong>{meta.name}</strong>
        {!meta.wired && (
          <>
            {' '}
            <Tag kind="warn">暂未接入</Tag>
          </>
        )}
        <div className="small muted">{meta.usage}</div>
        {profile.purpose === 'agent' && (
          <div className="small muted">
            助手要能<b>调用工具</b>才能真正查数据、改字段；点「试调用」会顺带检查这一点。
          </div>
        )}
        {!meta.wired && (
          <div className="small" style={{ color: 'var(--warn)' }}>
            这条流程还没接上模型：现在配了也不会被调用，等做「照片是否合格」时才会用到。
          </div>
        )}
      </td>
      <td>
        <Select
          value={form.providerId}
          onChange={(v) => {
            setForm({ ...form, providerId: v });
            if (v) {
              api
                .get<{ models: string[] }>(`/api/ai/providers/${v}/models`)
                .then((r) => setModels(r.models))
                .catch((e: { message?: string }) => {
                  setModels([]);
                  toast(`没取到模型列表：${e?.message ?? '未知原因'}`, 'err');
                });
            }
          }}
          placeholder="未指定"
          options={providers.map((p) => ({ value: String(p.id), label: p.name }))}
        />
      </td>
      <td>
        <Input value={form.model} onChange={(v) => setForm({ ...form, model: v })} placeholder="模型名" />
        {models.length > 0 && (
          <div className="small muted" style={{ maxWidth: 240 }}>
            可用：
            {models.slice(0, 6).map((m) => (
              <a key={m} className="clickable" style={{ marginLeft: 4 }} onClick={() => setForm({ ...form, model: m })}>
                {m}
              </a>
            ))}
          </div>
        )}
        {/*
          向量化只能选 embedding 模型。DeepSeek 这类服务商只有对话模型，
          列出来的名字看着都能选，选了才发现 /embeddings 是 404 —— 提前说一句。
        */}
        {profile.purpose === 'embedding' && models.length > 0 && !models.some((m) => /embed|bge|gte|m3|nomic/i.test(m)) && (
          <div className="small" style={{ color: 'var(--warn)', maxWidth: 240 }}>
            这些模型名里看不出向量化模型。向量化要用专门的 embedding 模型，
            对话模型调 /embeddings 会返回 404。
          </div>
        )}
      </td>
      <td style={{ width: 80 }}>
        <Input value={form.temperature} onChange={(v) => setForm({ ...form, temperature: v })} />
      </td>
      <td style={{ width: 90 }}>
        <Input value={form.maxTokens} onChange={(v) => setForm({ ...form, maxTokens: v })} />
      </td>
      <td style={{ width: 90 }}>
        <Input value={form.timeoutMs} onChange={(v) => setForm({ ...form, timeoutMs: v })} />
      </td>
      <td className="nowrap">
        <Button
          size="sm"
          kind="primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api.put(`/api/ai/profiles/${profile.purpose}`, {
                name: meta.name,
                providerId: form.providerId ? Number(form.providerId) : null,
                model: form.model,
                temperature: Number(form.temperature),
                maxTokens: Number(form.maxTokens),
                timeoutMs: Number(form.timeoutMs),
              });
              onSaved();
            }, '已保存')
          }
        >
          保存
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            try {
              const r = await api.post<{
                text?: string;
                dim?: number;
                message?: string;
                warning?: string;
                toolCalling?: boolean;
                model: string;
                latencyMs?: number;
                usage?: { output: number; reasoning?: number };
              }>(`/api/ai/profiles/${profile.purpose}/test`, {});
              const detail =
                r.dim !== undefined
                  ? `${r.message ?? `向量化成功，维度 ${r.dim}`}`
                  : `模型 ${r.model} 回复：${(r.text ?? '').slice(0, 120)}`;
              // 通过但仍然有话说（例如推理模型把 token 用在思考上）—— 说清楚，别让人以为一切正常
              toast(r.warning ? `✓ 通了，但要注意：${r.warning}` : `✓ ${detail}`, r.warning ? 'info' : 'ok');
            } catch (e) {
              toast((e as { message: string }).message, 'err');
            }
          }}
        >
          试调用
        </Button>
      </td>
    </tr>
  );
}

function ProviderModal({ provider, onClose, onSaved }: { provider?: AiProvider; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    code: provider?.code ?? '',
    name: provider?.name ?? '',
    baseUrl: provider?.base_url ?? '',
    apiKey: '',
    apiKeyEnv: provider?.api_key_env ?? '',
    remark: provider?.remark ?? '',
    extraHeaders: '',
  });
  const { busy, run } = useAction();

  return (
    <Modal
      open
      title={provider ? `配置服务商：${provider.name}` : '添加服务商'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            kind="primary"
            disabled={busy || !form.name || !form.baseUrl}
            onClick={() =>
              run(async () => {
                const payload: Record<string, unknown> = {
                  name: form.name,
                  baseUrl: form.baseUrl,
                  apiKey: form.apiKey || undefined,
                  apiKeyEnv: form.apiKeyEnv || undefined,
                  remark: form.remark || undefined,
                };
                if (!provider) payload.code = form.code || form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                if (provider) await api.put(`/api/ai/providers/${provider.id}`, payload);
                else await api.post('/api/ai/providers', payload);
                onSaved();
              }, '已保存')
            }
          >
            保存
          </Button>
        </>
      }
    >
      {!provider && (
        <div className="inline-fields">
          <Field label="标识" hint="英文，程序内部用">
            <Input value={form.code} onChange={(v) => setForm({ ...form, code: v })} placeholder="my-provider" />
          </Field>
          <Field label="显示名称" required>
            <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          </Field>
        </div>
      )}
      {provider && (
        <Field label="显示名称" required>
          <Input value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        </Field>
      )}
      <Field label="Base URL" required hint="通常以 /v1 结尾，例如 https://api.deepseek.com/v1">
        <Input value={form.baseUrl} onChange={(v) => setForm({ ...form, baseUrl: v })} placeholder="https://api.deepseek.com/v1" />
      </Field>
      <Field
        label="API Key"
        hint={provider?.has_key ? `已保存（${provider.key_hint}）。留空表示不改动；填 __CLEAR__ 可清空。` : '直接粘贴，只存本机数据库'}
      >
        <Input value={form.apiKey} onChange={(v) => setForm({ ...form, apiKey: v })} placeholder={provider?.has_key ? '••••••••（不改动）' : 'sk-…'} />
      </Field>
      <Field label="或使用环境变量名" hint="填了环境变量名时优先读环境变量，例如 DEEPSEEK_API_KEY">
        <Input value={form.apiKeyEnv} onChange={(v) => setForm({ ...form, apiKeyEnv: v })} />
      </Field>
      <Field label="备注">
        <Input value={form.remark} onChange={(v) => setForm({ ...form, remark: v })} />
      </Field>
      <div className="notice small">
        常见 Base URL：DeepSeek <code>https://api.deepseek.com/v1</code> · 通义{' '}
        <code>https://dashscope.aliyuncs.com/compatible-mode/v1</code> · 智谱 <code>https://open.bigmodel.cn/api/paas/v4</code> · 本地 Ollama{' '}
        <code>http://127.0.0.1:11434/v1</code>
      </div>
    </Modal>
  );
}

function AiLogsCard() {
  const toast = useToast();
  const logs = useApi<{
    items: { id: number; purpose: string; provider_code: string; model: string; ok: number; latency_ms: number; total_tokens: number; error_message: string | null; created_at: string }[];
    summary: { purpose: string; calls: number; ok_calls: number; tokens: number; avg_ms: number }[];
  }>('/api/ai/logs?limit=50');

  return (
    <Card
      title="模型调用记录（用于控成本和排查）"
      collapsible
      extra={
        <>
          <Button size="sm" onClick={() => logs.reload()}>
            刷新
          </Button>
          <Button
            size="sm"
            kind="danger"
            onClick={async () => {
              // 后端是 DELETE FROM ai_call_log WHERE is_test=0：全量删除，界面只列了最近 50 条，先确认
              if (!window.confirm('确定清空全部调用记录？（列表只显示最近 50 条，更早的记录也会一并删除，不可恢复）')) return;
              try {
                await api.del('/api/ai/logs');
                logs.reload();
              } catch (e) {
                toast(`清空失败：${(e as { message: string }).message}`, 'err');
              }
            }}
          >
            清空
          </Button>
        </>
      }
    >
      {(logs.data?.summary.length ?? 0) > 0 && (
        <div className="row row-wrap mb12" style={{ gap: 16 }}>
          {logs.data?.summary.map((s) => (
            <div key={s.purpose} className="small">
              <strong>{PURPOSE_TEXT[s.purpose]?.name ?? s.purpose}</strong>：{s.calls} 次（成功 {s.ok_calls}），
              {s.tokens} tokens，平均 {Math.round(s.avg_ms ?? 0)}ms
            </div>
          ))}
        </div>
      )}
      {logs.loading ? (
        <Loading />
      ) : (logs.data?.items.length ?? 0) === 0 ? (
        <Empty text="还没有调用记录。" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>时间</th>
              <th>用途</th>
              <th>服务商/模型</th>
              <th>结果</th>
              <th>耗时</th>
              <th>tokens</th>
            </tr>
          </thead>
          <tbody>
            {logs.data?.items.map((l) => (
              <tr key={l.id}>
                <td className="small muted nowrap">{fmtTime(l.created_at)}</td>
                <td className="small nowrap">{PURPOSE_TEXT[l.purpose]?.name ?? l.purpose}</td>
                <td className="small">
                  {l.provider_code} / {l.model}
                </td>
                <td className="small">{l.ok ? <Tag kind="ok">成功</Tag> : <span style={{ color: 'var(--err)' }}>{l.error_message}</span>}</td>
                <td className="small muted nowrap">{l.latency_ms ? `${(l.latency_ms / 1000).toFixed(1)}s` : '—'}</td>
                <td className="small muted nowrap">{l.total_tokens || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ------------------------------ 备份与恢复 ------------------------------ */

interface BackupVerifyInfo {
  ok: boolean;
  quickCheck: string;
  foreignKeyCheck: number;
  workbenchCount: number | null;
  checkedAt: string;
  durationMs: number;
  errors: string[];
}

interface BackupItem {
  name: string;
  kind: 'daily' | 'weekly' | 'manual';
  kindLabel: string;
  createdAt: string;
  sizeBytes: number;
  note: string | null;
  /** true 通过 / false 坏（留证不删）/ null 还没校验过 */
  ok: boolean | null;
  bad: boolean;
  sidecarMissing: boolean;
  verify: BackupVerifyInfo | null;
}

interface BackupOverviewData {
  dir: string;
  dbFile: string;
  scope: string;
  restoring: boolean;
  config: {
    auto: boolean;
    hour: number;
    keepDaily: number;
    keepWeekly: number;
    weeklyDay: number;
    dirRaw: string;
    origin: Record<string, string>;
  };
  items: BackupItem[];
  lastRestoreInterrupted: { phase: string; at: string; from: string; preRestore: string | null; dbFile: string } | null;
}

interface RestoreReport {
  restored: string;
  preRestore: { name: string; ok: boolean; errors: string[] } | null;
  workbenchCountBefore: number | null;
  workbenchCountAfter: number | null;
  verify: BackupVerifyInfo;
  rolledBack: boolean;
  steps: string[];
  warnings: string[];
  finishedAt: string;
}

/** 同盘判断：备份和数据库在一块盘上，硬盘坏了一起没 —— 值得说一句 */
function sameDrive(a: string, b: string): boolean {
  const da = a.slice(0, 2).toLowerCase();
  const dbb = b.slice(0, 2).toLowerCase();
  return /^[a-z]:$/.test(da) && da === dbb;
}

/* ------------------------------ 知识库抽取口径（B3-8） ------------------------------ */

/**
 * 「知识库抽取口径」卡片。
 *
 * 三个口径用户没给过定论，于是做成设置项而不是写死在代码里 ——
 * 卡片上每一项都直接摆出**可选项 + 选它的后果**（不是只写个名字），
 * 因为这三项决定了"同一份制度会不会在检索里出现三次""法规算不算依据""旧版会不会被当依据"。
 *
 * 改完必须重新抽取一次才生效：抽取读的是 app_setting 里的当前值，
 * 重跑靠「来源 + 相对路径」稳定键原地更新，不产生重复行（卡片上也这么写）。
 */
function KbExtractCard() {
  const toast = useToast();
  const cfg = useApi<KbExtractConfig>('/api/kb/extract/config');
  const { busy, run } = useAction();
  const [form, setForm] = useState<KbExtractSettings>({ dedup: 'prefer_docx', scope: 'mark', version: 'final_only' });
  const sources = useApi<{ items: KbSource[] }>('/api/kb/sources');
  const [running, setRunning] = useState<number | null>(null);

  useEffect(() => {
    if (!cfg.data) return;
    setForm(cfg.data.settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.data]);

  const save = () =>
    run(async () => {
      await api.put('/api/settings', { 'kb.dedup': form.dedup, 'kb.scope': form.scope, 'kb.version': form.version });
      cfg.reload();
    }, '口径已保存。要让新口径生效，请到「知识库 → 制度来源目录」对每个来源点一次「开始抽取」（重跑不会产生重复数据）。');

  const reExtract = (s: KbSource) =>
    run(async () => {
      const r = await api.post<{ jobId: number; total: number }>(`/api/kb/sources/${s.id}/extract`, { embed: true, ocr: false });
      setRunning(s.id);
      toast(`已按新口径起任务：${s.label ?? s.path}（${r.total} 个文件）。进度见「知识库 → 制度来源目录」。`, 'ok');
    });

  const keys = cfg.data?.keys ?? { dedup: 'kb.dedup', scope: 'kb.scope', version: 'kb.version' };
  const options = cfg.data?.options;

  const renderGroup = (k: keyof KbExtractSettings, title: string, hint: string) =>
    options?.[k] ? (
      <div className="mt12" key={k}>
        <div className="small">
          <strong>{title}</strong>
          <span className="muted">
            {' '}
            （设置键 <code>{keys[k]}</code>）—— {hint}
          </span>
        </div>
        <div className="col mt8" style={{ gap: 6 }}>
          {options[k].map((o) => (
            <label key={o.value} className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="radio"
                name={`kb-${k}`}
                checked={form[k] === o.value}
                onChange={() => setForm({ ...form, [k]: o.value as never })}
              />
              <span>
                <strong>{o.label}</strong>
                <br />
                <span className="muted">{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    ) : null;

  return (
    <Card
      title="知识库抽取口径（决定哪些制度进库、进几份）"
      extra={
        <Button size="sm" disabled={cfg.loading} onClick={cfg.reload}>
          刷新
        </Button>
      }
    >
      <div className="notice notice-info">
        这三项决定<strong>知识库里有几份制度、能不能把旧版当依据</strong>，改完必须<strong>重新抽取</strong>才生效。
        重跑靠「来源 + 相对路径」稳定键<strong>原地更新</strong>，不会产生重复数据；换口径后按新口径不该入库的行会被清理掉。
        当前生效值：去重 <code>{form.dedup}</code> · 范围 <code>{form.scope}</code> · 版本 <code>{form.version}</code>。
      </div>

      {renderGroup('dedup', '① 去重：同一份制度的多版本/多副本怎么算一份', '决定"同一份制度会不会在检索里出现三次"')}
      {renderGroup('scope', '② 范围：法规与参考制度（非本单位发文）要不要入库', '决定"依据哪条国家标准"查不查得到')}
      {renderGroup('version', '③ 版本：上会稿与历史版本要不要抽取', '决定旧版会不会被当成现行依据（B3-10 双链尤其怕这个）')}

      <div className="row mt16" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button kind="primary" disabled={busy} onClick={save}>
          保存口径
        </Button>
        <span className="small muted">
          {cfg.error ? `读不到口径：${cfg.error.message}` : '保存后按新口径重跑一次才会生效。'}
        </span>
      </div>

      {(sources.data?.items ?? []).length > 0 && (
        <div className="mt16">
          <div className="small">
            <strong>按当前口径重跑这些来源：</strong>
          </div>
          <table className="table mt8">
            <thead>
              <tr>
                <th>来源</th>
                <th style={{ width: 120 }}>已入库</th>
                <th style={{ width: 160 }}>上次抽取</th>
                <th style={{ width: 120 }} />
              </tr>
            </thead>
            <tbody>
              {(sources.data?.items ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="small mono ellipsis" title={s.path}>
                    {s.label ?? s.path}
                  </td>
                  <td className="small">
                    {s.extracted_docs ?? 0} 份 / {s.extracted_chunks ?? 0} 块
                  </td>
                  <td className="small muted nowrap">{fmtTime(s.last_extract_at ?? null)}</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    <Button size="sm" disabled={busy} onClick={() => reExtract(s)}>
                      {running === s.id ? '已起任务' : '按新口径重跑'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sources.data?.items && sources.data.items.length === 0 && (
        <div className="notice notice-warn mt12">
          还没有登记制度来源目录。先到「知识库 → 公司制度」登记一个目录，再回到这里选口径并抽取。
        </div>
      )}
    </Card>
  );
}

/**
 * 「出文书前口径校验」卡片（B3-9）。
 *
 * 两个层次摆在一起：
 *   · **严格度**（唯一的总闸）：block = 不通过就阻止保存；warn = 只提示。
 *     默认取 docs/11 B3-9 的口径（block）。
 *   · **规则清单**（规则数据化）：每条规则的级别与开关都能在这里改，**改完立刻生效、不用改代码**。
 *     未实现的规则（implemented=false，docs/11 表里那 12 条公文惯例规则的草案）**不允许启用** ——
 *     启用了却永远不响，比没有这条规则更糟（后端会拒绝并说明理由，这里原样显示那句话）。
 * 下面还列最近 10 条**例外放行留痕**：谁在何时、以什么理由放行了哪条规则（B1-3 审计要看的）。
 */
function ComplianceCard() {
  const cfg = useApi<KbComplianceConfig>('/api/kb/compliance/config');
  const logs = useApi<{ items: KbComplianceExceptionRow[] }>('/api/kb/compliance/exceptions?limit=10');
  const { busy, run } = useAction();
  const [strictness, setStrictness] = useState<'block' | 'warn'>('block');

  useEffect(() => {
    if (cfg.data) setStrictness(cfg.data.strictness);
  }, [cfg.data]);

  const saveStrictness = (v: string) =>
    run(async () => {
      await api.put('/api/kb/compliance/config', { strictness: v });
      setStrictness(v as 'block' | 'warn');
      cfg.reload();
    }, '已保存。下一次出文书就按新严格度走。');

  const patchRule = (code: string, patch: { enabled?: boolean; severity?: 'block' | 'warn' | 'info' }) =>
    run(async () => {
      await api.put(`/api/kb/compliance/rules/${code}`, patch);
      cfg.reload();
    });

  const rules = cfg.data?.rules ?? [];
  const active = rules.filter((r) => r.enabled && r.hasChecker && r.implemented);
  const drafts = rules.filter((r) => !r.implemented);

  return (
    <Card
      title="出文书前口径校验（条款级引用 + 口径）"
      extra={
        <Button size="sm" disabled={cfg.loading} onClick={cfg.reload}>
          刷新
        </Button>
      }
    >
      <div className="notice notice-info">
        出文书前会核对文书里引用的<strong>每一条制度条款</strong>（是否存在、是不是被替换的版本、同一事项有没有两个冲突口径、
        变量里的数字与条款规定是否一致），并把问题指到<strong>具体位置</strong>与<strong>具体依据</strong>。
        当前生效的规则 {active.length} 条（其中 block {active.filter((r) => r.severity === 'block').length} 条）。
      </div>

      <div className="mt12">
        <div className="small">
          <strong>① 严格度</strong>
          <span className="muted">
            {' '}
            （设置键 <code>{cfg.data?.keys.strictness ?? 'compliance.strictness'}</code>）—— 决定"不通过"是拦下还是只提示
          </span>
        </div>
        <div className="col mt8" style={{ gap: 6 }}>
          {(cfg.data?.strictnessOptions ?? []).map((o) => (
            <label key={o.value} className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input type="radio" name="compliance-strictness" checked={strictness === o.value} onChange={() => saveStrictness(o.value)} disabled={busy} />
              <span>
                <strong>{o.label}</strong>
                <br />
                <span className="muted">{o.note}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt16">
        <div className="small">
          <strong>② 规则（数据化：改完立刻生效）</strong>
          <span className="muted">　{cfg.data?.note}</span>
        </div>
        <table className="table mt8">
          <thead>
            <tr>
              <th>规则</th>
              <th style={{ width: 150 }}>级别</th>
              <th style={{ width: 90 }}>启用</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.code}>
                <td className="small">
                  <div>
                    <strong>{r.name}</strong>
                  </div>
                  <div className="mono muted">{r.code}</div>
                  {r.origin ? <div className="muted">出处：{r.origin}</div> : null}
                </td>
                <td>
                  <Select
                    value={r.severity}
                    onChange={(v) => patchRule(r.code, { severity: v as 'block' | 'warn' | 'info' })}
                    options={[
                      { value: 'block', label: 'block 拦下' },
                      { value: 'warn', label: 'warn 提示' },
                      { value: 'info', label: 'info 参考' },
                    ]}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    className="check-box"
                    checked={r.enabled}
                    disabled={busy}
                    onChange={(e) => patchRule(r.code, { enabled: e.target.checked })}
                  />
                </td>
                <td className="small muted">
                  {r.message}
                  {r.fix_hint ? <div>怎么改：{r.fix_hint}</div> : null}
                  {!r.implemented ? <div style={{ color: 'var(--warn)' }}>草案：检查逻辑尚未实现，启用会被拒绝（避免"启用了却永远不响"）。</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {drafts.length > 0 && (
          <div className="small muted mt8">
            其中 {drafts.length} 条是 docs/11 B3-9 表里的公文惯例规则（金额大小写、日期序列、附件一致…），
            按文档要求<strong>先做草案给人改</strong>，实现检查逻辑后才允许启用。
          </div>
        )}
      </div>

      <div className="mt16">
        <div className="small">
          <strong>③ 例外放行留痕（最近 10 条）</strong>
          <span className="muted">　谁在何时、以什么理由放行了哪条规则 —— 放行不会改产物，只留痕</span>
        </div>
        {(logs.data?.items ?? []).length === 0 ? (
          <div className="small muted mt8">还没有例外放行记录。</div>
        ) : (
          <table className="table mt8">
            <thead>
              <tr>
                <th style={{ width: 170 }}>时间</th>
                <th style={{ width: 200 }}>规则</th>
                <th>理由</th>
                <th style={{ width: 180 }}>文书</th>
              </tr>
            </thead>
            <tbody>
              {(logs.data?.items ?? []).map((e) => (
                <tr key={e.id}>
                  <td className="small muted nowrap">{fmtTime(e.created_at)}</td>
                  <td className="small mono">{e.rule_code}</td>
                  <td className="small">{e.reason}</td>
                  <td className="small muted ellipsis">{e.artifact_title ?? (e.artifact_id ? `#${e.artifact_id}` : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cfg.error && <div className="notice notice-err mt12 small">读不到口径校验配置：{cfg.error.message}</div>}
    </Card>
  );
}

/**
 * 「备份」卡片。
 *
 * 用户的核心风险是"数据库只有本地一份"：这张卡片要让他能一眼看到
 * 「自动备份开着没、每天几点、备份在哪、最近几份好不好」，
 * 并且能一键补一份、一键恢复。
 *
 * 恢复是危险动作，所以走一个二次确认弹窗，明文写清"会先用当前数据做一份备份，
 * 再从选定的备份恢复"，并要求手输「恢复」二字才让点。
 */
function BackupCard() {
  const toast = useToast();
  const ov = useApi<BackupOverviewData>('/api/backups');
  const { busy, run } = useAction();
  const [form, setForm] = useState({ auto: true, hour: 3, keepDaily: 7, keepWeekly: 4 });
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null);
  const [report, setReport] = useState<RestoreReport | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  useEffect(() => {
    if (!ov.data) return;
    setForm({ auto: ov.data.config.auto, hour: ov.data.config.hour, keepDaily: ov.data.config.keepDaily, keepWeekly: ov.data.config.keepWeekly });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ov.data]);

  const items = ov.data?.items ?? [];
  const badCount = items.filter((i) => i.ok === false).length;
  const unverified = items.filter((i) => i.ok === null).length;
  const dir = ov.data?.dir ?? '';
  const dbFile = ov.data?.dbFile ?? '';

  const saveSettings = () =>
    run(async () => {
      await api.put('/api/settings', {
        'backup.auto': form.auto,
        'backup.hour': Number(form.hour),
        'backup.keepDaily': Number(form.keepDaily),
        'backup.keepWeekly': Number(form.keepWeekly),
      });
      ov.reload();
    }, '备份设置已保存（自动备份立即按新配置运行）');

  return (
    <Card
      title="备份（数据库只有本地一份，这里给它上保险）"
      extra={
        <>
          <Button size="sm" onClick={() => ov.reload()}>
            刷新
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.post<{ items: BackupItem[]; total: number; bad: { name: string; errors: string[] }[] }>(
                  '/api/backups/verify',
                );
                ov.reload();
                if (r.bad.length) toast(`校验完 ${r.total} 份：${r.bad.length} 份没通过（文件已保留，没有删除）`, 'err');
                else toast(`校验完 ${r.total} 份，全部通过`, 'ok');
              })
            }
          >
            校验
          </Button>
          <Button
            size="sm"
            kind="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const r = await api.post<BackupItem>('/api/backups', { kind: 'manual', note: '手动备份（设置页）' });
                ov.reload();
                if (r.ok === true) toast(`已备份：${r.name}（校验通过，工作台 ${r.verify?.workbenchCount ?? '?'} 个）`, 'ok');
                else toast(`备份文件已生成 ${r.name}，但校验没通过：${(r.verify?.errors ?? []).join('；')}`, 'err');
              })
            }
          >
            立即备份
          </Button>
        </>
      }
    >
      <div className="notice notice-info small">
        备份只针对<strong>数据库</strong>（工作台、字段、别名、清单、记录、配置都在里面），
        <strong>不会删除也不会动</strong> <code>data/files</code> 里的用户文件。
        快照用 SQLite 在线备份 API 生成（不是复制正在写的文件），每份都会做{' '}
        <code>quick_check</code> 与 <code>foreign_key_check</code>；没通过校验的文件会被标记为「坏」并<strong>保留下来</strong>，不会静默删掉。
      </div>

      {ov.data?.lastRestoreInterrupted && (
        <div className="notice notice-warn mt12 small">
          上一次恢复没有正常结束（{fmtTime(ov.data.lastRestoreInterrupted.at)}，从 {ov.data.lastRestoreInterrupted.from} 恢复，阶段{' '}
          {ov.data.lastRestoreInterrupted.phase}）。当前数据库：<code>{ov.data.lastRestoreInterrupted.dbFile}</code>；
          恢复前的自动备份：<code>{ov.data.lastRestoreInterrupted.preRestore ?? '（无）'}</code>。
          如果数据看起来不对，可以在下面选中那份恢复前备份再恢复一次。
        </div>
      )}

      <div className="row row-wrap mt12" style={{ gap: 14, alignItems: 'flex-end' }}>
        <label className="row clickable" style={{ gap: 6 }}>
          <input type="checkbox" className="check-box" checked={form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} />
          <span>每天自动备份</span>
        </label>
        <Field label="备份时间" hint="每天这个点之后第一次运行时就备份（错过也会补）">
          <Select
            value={String(form.hour)}
            onChange={(v) => setForm({ ...form, hour: Number(v) })}
            options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))}
          />
        </Field>
        <Field label="保留日备份数" hint="超出按时间删最旧的">
          <Input type="number" value={String(form.keepDaily)} onChange={(v) => setForm({ ...form, keepDaily: Number(v) || 0 })} />
        </Field>
        <Field label="保留周备份数" hint="周备优先保留">
          <Input type="number" value={String(form.keepWeekly)} onChange={(v) => setForm({ ...form, keepWeekly: Number(v) || 0 })} />
        </Field>
        <Button kind="primary" disabled={busy} onClick={saveSettings}>
          保存备份设置
        </Button>
      </div>

      <div className="small muted mt12">
        备份目录：<code>{dir}</code>
        {ov.data ? `（来自：${ov.data.config.origin.dir}）` : ''}
        ；数据库：<code>{dbFile}</code>
        {dir && dbFile && sameDrive(dir, dbFile) && (
          <div className="mt8" style={{ color: 'var(--warn)' }}>
            注意：备份和数据库在<strong>同一块盘</strong>上，硬盘坏了会一起丢。想要真正防硬盘故障，请把{' '}
            <code>workbench.config.json</code> 里的 <code>backup.dir</code> 指到另一块盘或 OneDrive/坚果云同步目录。
          </div>
        )}
      </div>

      {report && (
        <div className={`notice ${report.verify.ok ? 'notice-ok' : 'notice-warn'} mt12 small`}>
          <strong>
            恢复结果：{report.rolledBack ? '已退回恢复前的数据' : report.verify.ok ? '成功' : '有问题'}
          </strong>
          （来自 {report.restored}，{fmtTime(report.finishedAt)}）
          <div className="mt8">
            工作台数量：恢复前 {report.workbenchCountBefore ?? '?'} → 恢复后 {report.workbenchCountAfter ?? '?'}；
            校验：<code>{report.verify.quickCheck}</code>，
            <code>foreign_key_check</code> {report.verify.foreignKeyCheck} 处违规。
          </div>
          {report.steps.map((s, i) => (
            <div key={i} className="mt8">
              · {s}
            </div>
          ))}
          {report.warnings.map((w, i) => (
            <div key={`w${i}`} className="mt8" style={{ color: 'var(--warn)' }}>
              ⚠ {w}
            </div>
          ))}
          <div className="mt8">
            <Button size="sm" onClick={() => setReport(null)}>
              知道了
            </Button>
          </div>
        </div>
      )}

      {ov.loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty text="还没有任何备份。点右上角「立即备份」先做一份。" />
      ) : (
        <table className="table mt12">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>大小</th>
              <th>校验</th>
              <th>说明</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.name}>
                <td className="small nowrap">
                  {fmtTime(b.createdAt)}
                  <div className="small muted mono ellipsis" style={{ maxWidth: 220 }} title={b.name}>
                    {b.name}
                  </div>
                </td>
                <td className="small nowrap">
                  <Tag kind={b.kind === 'manual' ? 'info' : 'default'}>{b.kindLabel}</Tag>
                </td>
                <td className="small muted nowrap">{fmtSize(b.sizeBytes)}</td>
                <td className="small">
                  {b.ok === true ? (
                    <Tag kind="ok">通过</Tag>
                  ) : b.ok === false ? (
                    <Tag kind="err">坏</Tag>
                  ) : (
                    <Tag kind="warn">未校验</Tag>
                  )}
                  {b.verify?.workbenchCount !== null && b.verify?.workbenchCount !== undefined && (
                    <span className="muted small"> {b.verify.workbenchCount} 个工作台</span>
                  )}
                  {b.ok === false && <div style={{ color: 'var(--err)' }}>{(b.verify?.errors ?? []).join('；')}</div>}
                  {b.sidecarMissing && <div className="muted small">缺少校验记录，点「校验」重新检查</div>}
                </td>
                <td className="small muted">{b.note ?? ''}</td>
                <td className="nowrap">
                  <Button
                    size="sm"
                    disabled={busy || b.ok === false}
                    title={b.ok === false ? '这份备份没通过校验，不能用来恢复' : '从这个备份恢复'}
                    onClick={() => setRestoreTarget(b)}
                  >
                    恢复
                  </Button>
                  <Button
                    size="sm"
                    kind="ghost"
                    disabled={busy || busyName === b.name}
                    onClick={async () => {
                      if (!window.confirm(`删除备份 ${b.name}？删除后不能再从它恢复。`)) return;
                      setBusyName(b.name);
                      try {
                        await api.del(`/api/backups/${encodeURIComponent(b.name)}`);
                        toast('已删除', 'ok');
                        ov.reload();
                      } catch (e) {
                        toast((e as { message: string }).message, 'err');
                      } finally {
                        setBusyName(null);
                      }
                    }}
                  >
                    删除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {badCount > 0 && (
        <div className="notice notice-warn mt12 small">
          有 {badCount} 份备份没通过校验。它们<strong>没有被删除</strong>（坏文件本身就是排查线索），
          可以照常删除，或先留着手工检查。
        </div>
      )}
      {unverified > 0 && (
        <div className="notice mt12 small">
          有 {unverified} 份备份还没校验过（可能是从别处复制进来的，或校验记录丢了）。点右上角「校验」跑一遍。
        </div>
      )}

      {restoreTarget && (
        <RestoreModal
          item={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onDone={(r) => {
            setRestoreTarget(null);
            setReport(r);
            ov.reload();
          }}
        />
      )}
    </Card>
  );
}

/** 恢复的二次确认：必须手输「恢复」两个字；文案明写"先备份当前数据" */
function RestoreModal({ item, onClose, onDone }: { item: BackupItem; onClose: () => void; onDone: (r: RestoreReport) => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState('');

  return (
    <Modal
      open
      title="从备份恢复（会覆盖当前数据）"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            kind="danger"
            disabled={busy || confirm.trim() !== '恢复'}
            onClick={() =>
              run(async () => {
                const r = await api.post<RestoreReport>(`/api/backups/${encodeURIComponent(item.name)}/restore`, { confirm: confirm.trim() });
                toast(
                  r.rolledBack
                    ? '这次恢复没成功，已自动退回恢复前的数据'
                    : r.verify.ok
                      ? `恢复完成：工作台 ${r.workbenchCountAfter ?? '?'} 个`
                      : '恢复完成但校验没通过，请看详情',
                  r.verify.ok && !r.rolledBack ? 'ok' : 'err',
                );
                onDone(r);
              })
            }
          >
            确认恢复
          </Button>
        </>
      }
    >
      <div className="notice notice-warn">
        <strong>会先用当前数据做一份备份，再从选定的备份恢复。</strong>
        <div className="mt8">
          也就是：恢复错了还有退路 —— 恢复前那一刻的数据会被自动备份成一份「手动」备份，你能在列表里找到它再恢复回来。
        </div>
        <div className="mt8">
          恢复期间工作台会<strong>暂停接受写入</strong>（几秒钟），已经在跑的写入会先等它结束；
          <code>data/files</code> 里的用户文件不会被删除或修改。
        </div>
      </div>
      <dl className="kv mt12">
        <dt>选中的备份</dt>
        <dd className="mono">{item.name}</dd>
        <dt>时间 / 类型</dt>
        <dd>
          {fmtTime(item.createdAt)} · {item.kindLabel}
        </dd>
        <dt>大小</dt>
        <dd>{fmtSize(item.sizeBytes)}</dd>
        <dt>校验</dt>
        <dd>
          {item.ok === true ? '通过' : item.ok === false ? `坏：${(item.verify?.errors ?? []).join('；')}` : '未校验'}
          {item.verify?.workbenchCount !== null && item.verify?.workbenchCount !== undefined
            ? `（${item.verify.workbenchCount} 个工作台）`
            : ''}
        </dd>
      </dl>
      <Field label="请输入「恢复」两个字确认" required hint="这一步是为了防止手滑点错">
        <Input value={confirm} onChange={setConfirm} placeholder="恢复" />
      </Field>
    </Modal>
  );
}

interface OcrStatusData {
  enabled: boolean;
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
  candidates: number;
  needOcr: number;
  lastMessage: string;
  tessdata: { dir: string; files: { name: string; bytes: number }[] };
  langs: { lang: string; ready: boolean; bytes: number }[];
  items: {
    id: number;
    artifact_id: number;
    status: string;
    chars: number | null;
    confidence: number | null;
    ocr_error: string | null;
    file_name: string;
    title: string;
  }[];
}

function OcrCard() {
  const toast = useToast();
  const st = useApi<OcrStatusData>('/api/ocr/status');
  const system = useApi<{ settings: { key: string; value: string | null }[] }>('/api/system/info');
  const { busy, run } = useAction();

  const setting = (key: string) => system.data?.settings.find((s) => s.key === key)?.value ?? '';
  const enabled = setting('ocr.enabled') === '1';
  const lang = setting('ocr.lang') || 'chi_sim+eng';

  // 有排队中/识别中的任务时自动刷新
  useEffect(() => {
    if (!st.data || (st.data.pending === 0 && st.data.running === 0)) return;
    const t = setTimeout(() => st.reload(), 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.data]);

  const statusTag = (s: string) => {
    if (s === 'done') return <Tag kind="ok">已识别</Tag>;
    if (s === 'running') return <Tag kind="info">识别中</Tag>;
    if (s === 'pending') return <Tag kind="warn">排队中</Tag>;
    if (s === 'failed') return <Tag kind="err">失败</Tag>;
    return <Tag>已跳过</Tag>;
  };

  return (
    <Card
      title="扫描件 OCR（把图片和扫描件里的文字变成可检索内容）"
      extra={
        <>
          <Button size="sm" onClick={() => st.reload()}>
            刷新
          </Button>
          <Button
            size="sm"
            kind="primary"
            disabled={busy || !enabled}
            onClick={() =>
              run(async () => {
                const r = await api.post<{ langs: { lang: string; bytes: number }[] }>('/api/ocr/prepare');
                toast(`语言包已就绪：${r.langs.map((l) => `${l.lang}(${(l.bytes / 1024 / 1024).toFixed(1)}MB)`).join('、')}`, 'ok');
                st.reload();
              })
            }
          >
            下载语言包
          </Button>
        </>
      }
    >
      <div className="row row-wrap" style={{ gap: 10 }}>
        <label className="row clickable" style={{ gap: 6 }}>
          <input
            type="checkbox"
            className="check-box"
            checked={enabled}
            onChange={async (e) => {
              try {
                await api.put('/api/settings', { 'ocr.enabled': e.target.checked });
                toast(e.target.checked ? 'OCR 已启用，之后上传的图片会自动识别' : 'OCR 已关闭', 'ok');
                system.reload();
                st.reload();
              } catch (err) {
                toast((err as { message: string }).message, 'err');
              }
            }}
          />
          <span>启用 OCR</span>
        </label>
        <Select
          value={lang}
          onChange={async (v) => {
            try {
              await api.put('/api/settings', { 'ocr.lang': v });
              system.reload();
              st.reload();
            } catch (err) {
              toast(`OCR 语言保存失败：${(err as { message: string }).message}`, 'err');
            }
          }}
          options={[
            { value: 'chi_sim+eng', label: '简体中文 + 英文（推荐）' },
            { value: 'chi_sim', label: '仅简体中文' },
            { value: 'eng', label: '仅英文（更快更准）' },
            { value: 'chi_sim+eng+jpn', label: '中文 + 英文 + 日文' },
          ]}
        />
        <Button
          size="sm"
          disabled={busy || !enabled}
          onClick={() =>
            run(async () => {
              const r = await api.post<{ queued: number }>('/api/ocr/scan-missing');
              toast(r.queued > 0 ? `已把 ${r.queued} 个文件排上队，后台正在识别` : '没有需要识别的文件', r.queued > 0 ? 'ok' : 'info');
              st.reload();
            })
          }
        >
          扫描历史文件
        </Button>
        <Button
          size="sm"
          disabled={busy || (st.data?.pending ?? 0) === 0}
          onClick={() =>
            run(async () => {
              const r = await api.post<{ cancelled: number }>('/api/ocr/cancel');
              toast(`已取消 ${r.cancelled} 个排队任务`, 'ok');
              st.reload();
            })
          }
        >
          取消排队
        </Button>
      </div>

      <div className="small muted mt12">
        语言包：{(st.data?.langs ?? []).map((l) => `${l.lang}${l.ready ? ` ✓ ${(l.bytes / 1024 / 1024).toFixed(1)}MB` : ' ✗ 未下载'}`).join('　')}
        <div className="mt8">
          语言包放在 <code>{st.data?.tessdata.dir}</code>，下载一次后永久离线可用。
          识别引擎是内置的 WASM 版本，<strong>不需要另外安装任何程序</strong>。
        </div>
      </div>

      <div className="grid grid-4 mt16">
        <div className="stat">
          <div className="k">待识别</div>
          <div className="v">{(st.data?.pending ?? 0) + (st.data?.running ?? 0)}</div>
          <div className="d">排队中 {st.data?.pending ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">已识别</div>
          <div className="v">{st.data?.done ?? 0}</div>
          <div className="d">文字已进全文索引</div>
        </div>
        <div className="stat">
          <div className="k">失败 / 跳过</div>
          <div className="v">{(st.data?.failed ?? 0) + (st.data?.skipped ?? 0)}</div>
          <div className="d">失败 {st.data?.failed ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">图片 / 扫描件</div>
          <div className="v">{st.data?.candidates ?? 0}</div>
          <div className="d">可识别的文件</div>
        </div>
      </div>

      {st.data?.lastMessage && <div className="notice notice-ok mt12">{st.data.lastMessage}</div>}

      {!enabled && (
        <div className="notice notice-warn mt12">
          OCR 当前是关闭的。开启后，上传的照片和扫描件会自动排队识别，识别出的文字会进入全文检索——
          这样「档案扫描件」里的内容也能被搜到。
        </div>
      )}

      <div className="notice mt12 small">
        <strong>两点要说明：</strong>
        <div className="mt8">
          1. 只能识别<strong>图片</strong>（PNG / JPG / BMP / TIFF / WebP）。扫描的 PDF 请先用扫描软件导出成图片再上传，
          或者用手机拍下来上传——本机 OCR 引擎读不了 PDF 内部格式。
        </div>
        <div className="mt8">
          2. 识别质量取决于图片清晰度。拍文件时尽量摆正、光线均匀、分辨率高一些；模糊或倾斜的图片识别率会明显下降。
        </div>
      </div>

      {(st.data?.items.length ?? 0) > 0 && (
        <table className="table mt16">
          <thead>
            <tr>
              <th>文件</th>
              <th>状态</th>
              <th>识别字数</th>
              <th>置信度</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {st.data?.items.map((it) => (
              <tr key={it.id}>
                <td className="small">
                  <div className="ellipsis" style={{ maxWidth: 260 }} title={it.file_name}>
                    {it.file_name}
                  </div>
                </td>
                <td>{statusTag(it.status)}</td>
                <td className="small muted nowrap">{it.chars ? `${it.chars} 字` : '—'}</td>
                <td className="small muted nowrap">{it.confidence !== null ? `${it.confidence}%` : '—'}</td>
                <td className="small muted">
                  {it.ocr_error ?? ''}
                  <Button
                    size="sm"
                    kind="ghost"
                    onClick={() =>
                      run(async () => {
                        // 接口如实回报"这次到底排上队没有"（routes-files.ts / requeueOcr）：
                        // 已经在跑或已经在队列里时不重复排，`queued:false` 就不能再说"已重新排队"。
                        const r = await api.post<{ queued: boolean; status: string; previous_attempts: number }>(
                          `/api/ocr/artifacts/${it.artifact_id}`,
                        );
                        if (r.queued) toast('已重新排队', 'ok');
                        else if (r.status === 'running') toast('该文件正在识别中，无需重复提交', 'info');
                        else toast('该文件已在识别队列里，无需重复提交', 'info');
                        st.reload();
                      })
                    }
                  >
                    重试
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
