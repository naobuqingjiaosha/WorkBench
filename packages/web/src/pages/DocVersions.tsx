/**
 * 文书版本链（B1-4）—— 「版本」标签页
 *
 * 解决的问题：同一份文书改三遍，以前磁盘上是 `XXX_v1/v2/v3.docx` 三个并列的文档，
 * 界面上也看不出"这是同一份的三个版本"，"哪份是最终版"只能靠文件名猜。
 *
 * 这里一屏说清三件事：
 *   1. 这条链有几版、哪一版是**当前正式文件**、哪一版是**定稿**；
 *   2. 每一版的**真实绝对路径**（+ 下载），旧版本也仍然在磁盘上、能下载；
 *   3. 两版之间「哪个字段改了」—— 只比变量，不比对 docx 正文
 *      （正文差异大量来自格式噪声，会淹没真改动；见 docs/09 §4.8.4 的否决理由）。
 *
 * 刻意不做的事：不在这个弹窗里删除任何版本（版本删除走「文件」列表的常规删除，
 * 而且中间版本"永不删除"是硬口径）；不提供"用某一版覆盖当前版"的静默操作 ——
 * 回滚也是**新增一版**，中间版本一个都不动。
 */
import { useState } from 'react';
import { api, useApi } from '../api';
import { Button, Empty, Loading, Modal, Tag, fmtSize, fmtTime, useAction, useToast } from '../ui';

interface VersionItem {
  id: number;
  revision: number;
  is_final: number;
  final_at: string | null;
  supersedes_id: number | null;
  file_name: string;
  file_rel: string;
  abs_path: string;
  exists: boolean;
  size_bytes: number | null;
  sha256: string | null;
  title: string;
  created_at: string;
  current: boolean;
  head: boolean;
  mode: string | null;
  unchained: boolean;
  label: string;
  url: string | null;
}

interface VersionChainData {
  group: string | null;
  unchained: boolean;
  finalId: number | null;
  finalRevision: number | null;
  final: { id: number; revision: number | null; label: string } | null;
  items: VersionItem[];
  versions_dir: string | null;
  note: string;
  artifact: { id: number; title: string; file_name: string; kind: string };
}

interface DiffData {
  from: number;
  to: number;
  changes: { key: string; from: string; to: string }[];
  same: number;
  missing: number[];
  note: string;
}

const MODE_TEXT: Record<string, string> = { ai: '模型生成', manual: '手工填', hybrid: '混合' };

export function DocVersionsModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const chain = useApi<VersionChainData>(`/api/artifacts/${id}/versions`);
  const [pending,setPending]=useState<{version:VersionItem;action:'final'|'unfinal'|'rollback'}|null>(null);
  const [tab, setTab] = useState<'versions' | 'diff'>('versions');
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [diff, setDiff] = useState<DiffData | null>(null);

  const items = chain.data?.items ?? [];

  /** 打开对比页时给一对默认值：最老的一版 → 最新的一版（"这份文书一共改了哪几个字段"） */
  const openDiff = () => {
    setTab('diff');
    if (items.length >= 2) {
      if (from === null) setFrom(items[0]!.revision);
      if (to === null) setTo(items[items.length - 1]!.revision);
    }
  };

  const doDiff = (f: number, t: number) =>
    run(async () => {
      const r = await api.get<DiffData>(`/api/artifacts/${id}/diff?from=${f}&to=${t}`);
      setDiff(r);
    });

  const doMarkFinal = (v: VersionItem, final: boolean) =>
    run(async () => {
      const r = await api.post<{ changed: boolean; message: string }>(`/api/artifacts/${v.id}/mark-final`, { final });
      toast(r.message, 'ok');
      chain.reload();
      onChanged?.();setPending(null);
    });

  const doRollback = (v: VersionItem) =>
    run(async () => {
      const r = await api.post<{ revision: number; message: string }>(`/api/artifacts/${id}/rollback-to/${v.revision}`);
      toast(r.message, 'ok');
      chain.reload();
      onChanged?.();setPending(null);
    });

  return (
    <Modal
      open
      wide
      title={`版本 · ${chain.data?.artifact.title ?? '文书'}`}
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            {chain.data?.note ?? ''}
          </span>
          <Button onClick={onClose}>关闭</Button>
        </>
      }
    >
      {chain.loading ? (
        <Loading text="正在读取版本…" />
      ) : chain.error ? (
        <div className="notice notice-err">读取版本失败：{chain.error.message}<Button onClick={chain.reload}>重试</Button></div>
      ) : !chain.data ? null : (
        <>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" kind={tab === 'versions' ? 'primary' : undefined} onClick={() => setTab('versions')}>
              版本
            </Button>
            <Button
              size="sm"
              kind={tab === 'diff' ? 'primary' : undefined}
              onClick={openDiff}
              disabled={items.length < 2}
              title={items.length < 2 ? '至少要有两版才能对比' : '看这两版之间哪些字段改了'}
            >
              两版对比
            </Button>
            {chain.data.final && (
              <Tag kind="ok">🔒 定稿 {chain.data.final.label}</Tag>
            )}
            {chain.data.unchained && <Tag>未分链</Tag>}
          </div>

          <div className="notice notice-info mt12 small">
            当前最新文件是<strong>版本号最大的那一版</strong>，最新不等于定稿；旧版本移到 <code>.versions</code> 归档目录里，
            <strong>仍然在磁盘上、可以下载和回滚</strong>，不会被删掉。定稿之后这条链不能再被覆盖
            （要改必须先取消定稿）。
          </div>

          {tab === 'versions' ? (
            <>
              <table className="table mt12">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>版本</th>
                    <th>文件</th>
                    <th style={{ width: 150 }}>生成时间</th>
                    <th style={{ width: 90 }}>大小</th>
                    <th style={{ width: 250 }} />
                  </tr>
                </thead>
                <tbody>
                  {items.map((v) => (
                    <tr key={v.id}>
                      <td className="nowrap">
                        <strong>v{v.revision}</strong>
                        {v.head && <> <Tag kind="info">当前</Tag></>}
                        {v.is_final === 1 && <> <Tag kind="ok">🔒 定稿</Tag></>}
                        {v.unchained && <div className="small muted">（未分链）</div>}
                      </td>
                      <td>
                        <div className="mono small ellipsis" title={v.abs_path || v.file_rel}>
                          {v.abs_path || v.file_rel}
                        </div>
                        <div className="small muted">
                          {v.file_name}
                          {v.mode ? ` · ${MODE_TEXT[v.mode] ?? v.mode}` : ''}
                          {!v.exists && <span style={{ color: 'var(--err)' }}> · ⚠ 磁盘上找不到这个文件</span>}
                        </div>
                      </td>
                      <td className="small nowrap muted">{fmtTime(v.created_at)}</td>
                      <td className="small nowrap muted">{fmtSize(v.size_bytes)}</td>
                      <td className="nowrap">
                        {v.url && (
                          <Button size="sm" onClick={() => api.download(v.url!, v.file_name)}>
                            下载
                          </Button>
                        )}
                        {v.is_final === 1 ? (
                          <Button size="sm" disabled={busy} onClick={() => setPending({version:v,action:'unfinal'})} title="取消后这条链才能继续更新">
                            取消定稿
                          </Button>
                        ) : (
                          <Button size="sm" disabled={busy} onClick={() => setPending({version:v,action:'final'})} title="同一条链只能有一个最终版；标了之后不能再覆盖">
                            🔒 标为定稿
                          </Button>
                        )}
                        {!v.head && (
                          <Button
                            size="sm"
                            disabled={busy || Boolean(chain.data?.final)}
                            onClick={() => setPending({version:v,action:'rollback'})}
                            title={
                              chain.data?.final
                                ? '这条链已有定稿，先取消定稿才能回滚'
                                : `把 v${v.revision} 的内容复制回来，成为新的一版（中间的版本都留着）`
                            }
                          >
                            回滚到这一版
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {chain.data.versions_dir && (
                <div className="notice mt12 small">
                  归档目录：<code>{chain.data.versions_dir}</code>
                  <br />
                  <span className="muted">
                    在资源管理器里打开就是上面这个路径（平台不会替你在系统里弹出窗口）。
                    下一版生成时，当前这一版的正式文件会被移动到 <code>v{items.length ? items[items.length - 1]!.revision : 1}.docx</code> 这类名字下。
                  </span>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="row mt12" style={{ gap: 8, alignItems: 'flex-end' }}>
                <label className="small">
                  从
                  <select
                    className="input select"
                    value={String(from ?? '')}
                    onChange={(e) => setFrom(Number(e.target.value))}
                  >
                    {items.map((v) => (
                      <option key={v.id} value={v.revision}>
                        v{v.revision}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="small">
                  到
                  <select
                    className="input select"
                    value={String(to ?? '')}
                    onChange={(e) => setTo(Number(e.target.value))}
                  >
                    {items.map((v) => (
                      <option key={v.id} value={v.revision}>
                        v{v.revision}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  kind="primary"
                  size="sm"
                  disabled={busy || from === null || to === null}
                  onClick={() => doDiff(from ?? 1, to ?? 1)}
                >
                  对比
                </Button>
              </div>

              {!diff ? (
                <Empty text="选两版，点「对比」—— 只比变量（哪个字段改了），不比 docx 正文。" />
              ) : (
                <div className="mt12">
                  <div className="small muted">{diff.note}</div>
                  {diff.changes.length === 0 ? (
                    <div className="notice notice-info mt8">
                      v{diff.from} 与 v{diff.to} 的变量取值完全一样（{diff.same} 项），没有字段变化。
                    </div>
                  ) : (
                    <table className="table mt8">
                      <thead>
                        <tr>
                          <th style={{ width: 200 }}>字段</th>
                          <th>v{diff.from}</th>
                          <th>v{diff.to}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.changes.map((c) => (
                          <tr key={c.key}>
                            <td className="mono small">{c.key}</td>
                            <td className="small">{c.from || <span className="muted">（空）</span>}</td>
                            <td className="small">{c.to || <span className="muted">（空）</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
      <Modal open={!!pending} title={pending?.action==='rollback'?'从历史版本新建':'确认版本状态'} onClose={()=>{if(!busy)setPending(null);}} footer={<><Button disabled={busy} onClick={()=>setPending(null)}>返回核对</Button><Button kind="primary" disabled={busy} onClick={()=>{if(!pending)return;if(pending.action==='rollback')void doRollback(pending.version);else void doMarkFinal(pending.version,pending.action==='final');}}>确认</Button></>}><p>{pending?.version.file_name} · v{pending?.version.revision}</p><p>{pending?.action==='rollback'?'将所选历史内容复制为新版本，原有版本保留。':pending?.action==='final'?'请确认已人工核对内容。标为定稿将锁定本版本链；不表示已报送或业务完成。':'取消定稿后可以继续编辑和生成新版本，已有文件会保留。'}</p></Modal>
    </Modal>
  );
}
