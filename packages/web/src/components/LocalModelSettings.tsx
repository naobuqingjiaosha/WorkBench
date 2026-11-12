import {SectionTitle} from './DesignSystem';
import { useEffect, useId, useState } from 'react';
import { api, type AiProfile, type AiProvider } from '../api';
import { Button, Card, Field, Input, Tag, useAction } from '../ui';

export default function LocalModelSettings({ providers, profiles, onSaved }: {
  providers: AiProvider[]; profiles: AiProfile[]; onSaved: () => void;
}) {
  const provider = providers.find(p => p.code === 'lmstudio');
  const assigned = (purpose: string) => profiles.find(p => p.purpose === purpose && p.provider_id === provider?.id)?.model ?? '';
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:1234/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [connection, setConnection] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { busy, run } = useAction();
  const listId = useId();

  useEffect(() => {
    setBaseUrl(provider?.base_url ?? 'http://127.0.0.1:1234/v1');
    setModel(assigned('writing')); setVisionModel(assigned('vision')); setEmbeddingModel(assigned('embedding'));
    setApiKey('');
  }, [provider?.id, provider?.base_url, profiles]);

  const modelInput = (value: string, onChange: (value: string) => void, label: string) => (
    <input className="input" list={listId} aria-label={label} placeholder={label} disabled={busy}
      value={value} onChange={event => onChange(event.target.value)} />
  );
  const request = () => ({ baseUrl, apiKey: apiKey || (provider?.has_key ? undefined : '') });

  return <Card title={<SectionTitle icon="dashboard">本地模型 · LM Studio</SectionTitle>}>
    <div className="inline-fields">
      <Field label="服务地址" required>
        <Input value={baseUrl} disabled={busy} placeholder="http://127.0.0.1:1234/v1" onChange={value => {
          setBaseUrl(value); setModels([]); setConnection(null); setConnectionError(null);
        }} />
      </Field>
      <Field label="API Token（可选）" hint={provider?.has_key ? '已保存 Token，留空沿用' : 'LM Studio 开启身份验证时填写'}>
        <Input type="password" disabled={busy} value={apiKey} onChange={value => {
          setApiKey(value); setConnection(null); setConnectionError(null);
        }} />
      </Field>
    </div>
    <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
      <Button size="sm" disabled={busy || !baseUrl.trim()} onClick={() => void run(async () => {
        setConnection(null); setConnectionError(null);
        try {
          const result = await api.post<{ baseUrl: string; models: string[]; latencyMs: number }>('/api/ai/local/models', request());
          setBaseUrl(result.baseUrl); setModels(result.models);
          setConnection(result.models.length ? `已连接 · ${result.models.length} 个模型 · ${result.latencyMs}ms` : '已连接 · 尚无可用模型');
        } catch (error) {
          setModels([]); setConnectionError((error as { message: string }).message);
        }
      })}>{busy ? '处理中...' : '检测连接 / 获取模型'}</Button>
      {connection && <Tag kind="ok">{connection}</Tag>}
    </div>
    {connectionError && <div className="notice notice-err mt12" role="alert">{connectionError}</div>}
    <datalist id={listId}>{models.map(name => <option key={name} value={name} />)}</datalist>
    <div className="inline-fields mt12">
      <Field label="文本模型" required>{modelInput(model, setModel, '选择或填写文本模型')}</Field>
      <Field label="图像模型（可选）">{modelInput(visionModel, setVisionModel, '支持图像输入的模型')}</Field>
      <Field label="向量模型（可选）">{modelInput(embeddingModel, setEmbeddingModel, 'Embedding 模型')}</Field>
    </div>
    <div className="notice small mb12">
      保存后，文书写作、信息抽取、复杂推理和 AI 助手切换为本地文本模型。
      未指定图像或向量模型时，对应用途停用，不沿用云端配置。AI 助手需模型支持工具调用。
    </div>
    <Button kind="primary" disabled={busy || !model.trim() || !baseUrl.trim()} onClick={() => void run(async () => {
      await api.put('/api/ai/local', { ...request(), model, visionModel, embeddingModel });
      onSaved();
    }, '已切换为 LM Studio 本地模型')}>保存并启用本地模型</Button>
  </Card>;
}
