/**
 * AI 梳理项目信息 · 提议确认
 *
 * 运行中的模型读模板，提议「该建哪些项目信息字段」「哪些变量名归到哪个字段」。
 * 铁律：模型只提案，**必须你确认才落盘**，且只能新增、不能改名/删除/改变已有字段的含义。
 *
 * 为什么要有这个页面：612 个变量名靠手配不现实，但也不能让模型直接改数据模型 ——
 * 中间这一步人工确认，是「不编造」原则在配置层面的落点。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, useApi, type AiProposal, type ProjectField, type WorkType } from '../api';
import { Button, Card, Empty, Field, Loading, Select, Tag, useAction, useToast } from '../ui';

interface AnalyzeResult {
  ok: boolean;
  batchId: string;
  created: number;
  analyzedTemplates: number;
  distinctVars: number;
  truncated: boolean;
  batches: { vars: number; proposals: number; truncated: boolean; error?: string }[];
  usage: { prompt: number; output: number };
  message?: string;
  rawText?: string;
}

/**
 * 提议面板 —— 嵌在「AI 助手」里当一个页签。
 * onPending 让外层知道还有多少条没处理（显示在页签上）。
 */
export function ProposalsPanel({ onPending }: { onPending?: (n: number) => void } = {}) {
  const toast = useToast();
  const { busy, run } = useAction();
  const types = useApi<{ items: WorkType[] }>('/api/work-types');
  const [workTypeId, setWorkTypeId] = useState<number | null>(null);
  const [batchSize, setBatchSize] = useState(40);
  const [lastRun, setLastRun] = useState<AnalyzeResult | null>(null);

  const effectiveWt = workTypeId ?? types.data?.items[0]?.id ?? null;
  const proposals = useApi<{ items: AiProposal[] }>(
    effectiveWt ? `/api/archive/proposals?status=pending&workTypeId=${effectiveWt}` : null,
  );
  const fields = useApi<{ items: ProjectField[] }>(
    effectiveWt ? `/api/archive/fields?workTypeId=${effectiveWt}` : null,
  );

  const items = proposals.data?.items ?? [];

  // 让外层页签能显示"还有几条没处理"
  useEffect(() => {
    onPending?.(items.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);
  const fieldItems = items.filter((p) => p.kind === 'field');
  const aliasItems = items.filter((p) => p.kind === 'alias');

  /** 已有字段的 key → 显示名，用于把 alias 提议翻译成人话 */
  const fieldLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of fields.data?.items ?? []) m.set(f.field_key, f.label);
    return m;
  }, [fields.data]);

  /** 待建字段的 key → 提议的显示名（这些字段还没落库） */
  const proposedLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of fieldItems) {
      if (p.payload.field_key) m.set(p.payload.field_key, String(p.payload.label ?? p.payload.field_key));
    }
    return m;
  }, [fieldItems]);

  const labelOf = (key: string) => fieldLabel.get(key) ?? proposedLabel.get(key) ?? key;

  const analyze = () =>
    run(async () => {
      if (!effectiveWt) throw { message: '请先选择工作类型' };
      const r = await api.post<AnalyzeResult>('/api/archive/analyze', { workTypeId: effectiveWt, batchSize });
      setLastRun(r);
      proposals.reload();
      fields.reload();
      if (!r.ok) throw { message: r.message ?? '模型没有返回可用结果' };
      if (r.created === 0) toast('模型没有提出新的建议 —— 现有配置可能已经够用了', 'info');
    });

  const accept = (p: AiProposal) =>
    run(async () => {
      await api.post(`/api/archive/proposals/${p.id}/accept`, {});
      proposals.reload();
      fields.reload();
    });

  const reject = (p: AiProposal) =>
    run(async () => {
      await api.post(`/api/archive/proposals/${p.id}/reject`, {});
      proposals.reload();
    });

  const acceptAll = (kind?: 'field' | 'alias') =>
    run(async () => {
      const r = await api.post<{ accepted: number; failed: { id: number; message: string }[] }>(
        '/api/archive/proposals/accept-all',
        { workTypeId: effectiveWt, kind },
      );
      proposals.reload();
      fields.reload();
      if (r.failed.length) {
        toast(`采纳 ${r.accepted} 条，${r.failed.length} 条被拒：${r.failed[0]?.message ?? ''}`, 'err');
      } else {
        toast(`已采纳 ${r.accepted} 条`, 'ok');
      }
    });

  const rejectAll = () =>
    run(async () => {
      const r = await api.post<{ rejected: number }>('/api/archive/proposals/reject-all', { workTypeId: effectiveWt });
      proposals.reload();
      toast(`已忽略 ${r.rejected} 条`, 'info');
    });

  if (types.loading) return <Loading />;
  const typeItems = types.data?.items ?? [];

  return (
    <div>
      <Card title="让模型梳理项目信息">
        <p className="muted small" style={{ marginTop: 0 }}>
          模型会读这个工作类型下所有模板的变量名，找出「反复出现的项目级信息」，
          建议建成项目信息字段，并把同义的变量名归到一起（如「监理单位」「监理项目部」都归到「监理机构」）。
          <br />
          <strong>模型只提建议，采纳与否由你决定</strong> —— 落盘后运行时不再需要模型。
        </p>

        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="工作类型">
            <Select
              value={String(effectiveWt ?? '')}
              onChange={(v) => setWorkTypeId(Number(v))}
              options={typeItems.map((t) => ({ value: String(t.id), label: `${t.name}（${t.template_count} 份模板）` }))}
            />
          </Field>
          <Field label="每次分析多少个变量" hint="太大容易被截断，40–60 比较稳">
            <Select
              value={String(batchSize)}
              onChange={(v) => setBatchSize(Number(v))}
              options={[
                { value: '30', label: '30' },
                { value: '40', label: '40' },
                { value: '60', label: '60' },
                { value: '100', label: '100' },
              ]}
            />
          </Field>
          <Button kind="primary" disabled={busy || !effectiveWt} onClick={analyze}>
            {busy ? '分析中…（可能要一分钟）' : '开始梳理'}
          </Button>
        </div>

        {lastRun && (
          <div className={`notice ${lastRun.ok ? 'notice-ok' : 'notice-warn'}`} style={{ marginTop: 12 }}>
            {lastRun.ok ? (
              <>
                分析了 <strong>{lastRun.analyzedTemplates}</strong> 份模板、<strong>{lastRun.distinctVars}</strong> 个变量，
                分 {lastRun.batches.length} 批，提出 <strong>{lastRun.created}</strong> 条建议
                {lastRun.truncated && '（有批次被截断，建议调小每批变量数再跑一次）'}
                　·　消耗 {lastRun.usage.prompt + lastRun.usage.output} tokens
              </>
            ) : (
              <>模型没有返回可用结果：{lastRun.message}</>
            )}
          </div>
        )}
      </Card>

      <Card
        title={`待确认的建议（${items.length}）`}
        extra={
          items.length > 0 ? (
            <div className="row" style={{ gap: 8 }}>
              <Button size="sm" kind="primary" disabled={busy} onClick={() => acceptAll()}>
                全部采纳
              </Button>
              <Button size="sm" disabled={busy} onClick={rejectAll}>
                全部忽略
              </Button>
            </div>
          ) : null
        }
      >
        {proposals.loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty text="没有待确认的建议。点上面的「开始梳理」让模型读一遍模板；如果刚梳理过且都处理完了，就说明现有配置够用了。" />
        ) : (
          <>
            {fieldItems.length > 0 && (
              <>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h4 style={{ margin: 0 }}>建议新建的字段（{fieldItems.length}）</h4>
                  <Button size="sm" disabled={busy} onClick={() => acceptAll('field')}>
                    采纳全部字段
                  </Button>
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>显示名称</th>
                      <th>字段标识</th>
                      <th>类型</th>
                      <th>模型的理由</th>
                      <th> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fieldItems.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>{String(p.payload.label ?? p.payload.field_key)}</strong>
                        </td>
                        <td className="mono small">{String(p.payload.field_key)}</td>
                        <td className="small">{String(p.payload.type ?? 'text')}</td>
                        <td className="small muted">{p.reason ?? '—'}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <Button size="sm" kind="primary" disabled={busy} onClick={() => accept(p)}>
                            采纳
                          </Button>{' '}
                          <Button size="sm" disabled={busy} onClick={() => reject(p)}>
                            忽略
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {aliasItems.length > 0 && (
              <>
                <div
                  className="row"
                  style={{ justifyContent: 'space-between', alignItems: 'center', margin: '16px 0 8px' }}
                >
                  <h4 style={{ margin: 0 }}>建议的变量归属（{aliasItems.length}）</h4>
                  <Button size="sm" disabled={busy} onClick={() => acceptAll('alias')}>
                    采纳全部归属
                  </Button>
                </div>
                <p className="muted small" style={{ marginTop: 0 }}>
                  这些变量名会自动从对应的项目信息字段取值 —— 填一次，所有用到它们的模板都带上。
                </p>
                <table className="table">
                  <thead>
                    <tr>
                      <th>模板里的变量名</th>
                      <th>归到哪个字段</th>
                      <th>状态</th>
                      <th> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {aliasItems.map((p) => {
                      const key = String(p.payload.field_key ?? '');
                      const known = fieldLabel.has(key);
                      return (
                        <tr key={p.id}>
                          <td>
                            <code>{`{${String(p.payload.var_name)}}`}</code>
                          </td>
                          <td>
                            {labelOf(key)}
                            <span className="muted small">（{key}）</span>
                          </td>
                          <td>
                            {known ? (
                              <Tag kind="ok">字段已存在</Tag>
                            ) : proposedLabel.has(key) ? (
                              <Tag kind="warn">依赖上方待建字段</Tag>
                            ) : (
                              <Tag kind="err">字段不存在</Tag>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <Button size="sm" kind="primary" disabled={busy} onClick={() => accept(p)}>
                              采纳
                            </Button>{' '}
                            <Button size="sm" disabled={busy} onClick={() => reject(p)}>
                              忽略
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </>
        )}
      </Card>

      <Card title="当前项目信息字段" collapsible>
        <p className="muted small" style={{ marginTop: 0 }}>
          采纳「新建字段」的建议后会出现在这里。显示名称可改，字段标识是稳定契约不可改。
        </p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {(fields.data?.items ?? []).map((f) => (
            <Tag key={f.id} kind={f.seed ? 'info' : f.origin === 'ai' ? 'warn' : 'default'}>
              {f.label} <span className="muted">{f.field_key}</span>
            </Tag>
          ))}
        </div>
      </Card>
    </div>
  );
}
