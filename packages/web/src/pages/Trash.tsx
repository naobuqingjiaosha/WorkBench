/**
 * 回收站
 *
 * 「删除」在这个平台上是**软删除**：记录打上 `deleted_at` 标记进这里，磁盘文件默认一个都不动。
 * 所以这个页面的主线是「恢复」，而「彻底删除」是那条**不可恢复**的岔路 —— 界面上必须把两者分得清清楚楚：
 *   · 恢复        → 主按钮。后端能恢复不完整时（文件已不在磁盘、工作台还在回收站里）会带回 warnings，
 *                  这里原样 toast 出来，不吞掉。
 *   · 彻底删除    → 危险按钮 + 二次确认，文案里明写「不可恢复」，并让用户选"要不要连磁盘文件一起删"。
 *   · 清空回收站  → 更危险：一次确认 + 默认保留最近 7 天的（要全清得显式选）。
 *
 * 风格沿用现有页面（Card / table / Button / Tag / useApi / useToast），不新造 CSS。
 */
import {LoadError} from '../components/DesignSystem';
import { useEffect, useState } from 'react';
import { api, useApi } from '../api';
import { Button, Card, Empty, Loading, Modal, Select, Tag, fmtTime, useToast } from '../ui';

/** 后端 `core/trash.ts` 的 TrashKind；界面上给它们中文名与顺序 */
type TrashKind = 'workbench' | 'artifact' | 'position' | 'field' | 'alias';

const KIND_TEXT: Record<string, string> = {
  workbench: '工作台',
  artifact: '文件',
  position: '阶段',
  field: '项目信息字段',
  alias: '变量别名',
};

/** 类型筛选的展示顺序（先工作台：整台被删是最常见、也最要紧的一种） */
const KIND_ORDER: TrashKind[] = ['workbench', 'artifact', 'position', 'field', 'alias'];

const KIND_TAG: Record<string, 'default' | 'ok' | 'warn' | 'err' | 'info'> = {
  workbench: 'info',
  artifact: 'default',
  position: 'warn',
  field: 'ok',
  alias: 'default',
};

interface TrashEntry {
  kind: string;
  id: number;
  title: string;
  deletedAt: string;
  extra?: string;
}

interface TrashList {
  items: TrashEntry[];
  total: number;
  count: number;
  kinds: string[];
}

/** 删除时间 → 「3 小时前」这种人话；超过 30 天就退回具体日期 */
function agoText(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days} 天前`;
  return fmtTime(iso);
}

export default function TrashPage() {
  const toast = useToast();
  const [restoring,setRestoring]=useState<TrashEntry|null>(null),[restoreResult,setRestoreResult]=useState('');
  const [kind, setKind] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 等待二次确认的条目（null = 没有弹窗） */
  const [purging, setPurging] = useState<TrashEntry | null>(null);
  const [purgeWithFile, setPurgeWithFile] = useState(true);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyOlder, setEmptyOlder] = useState('7');

  const path = kind ? `/api/trash?kind=${encodeURIComponent(kind)}` : '/api/trash';
  const list = useApi<TrashList>(path, [kind]);
  const items = list.data?.items ?? [];

  useEffect(() => {
    setBusyId(null);
  }, [kind]);

  /** 按类型统计条数（顶部筛选旁的小字） */
  const countOf = (k: string) => items.filter((i) => i.kind === k).length;

  const restore = async (e: TrashEntry) => {
    setRestoreResult('');setBusyId(`${e.kind}:${e.id}`);
    try {
      const r = await api.post<{ message: string; warnings: string[] }>(`/api/trash/${e.kind}/${e.id}/restore`, {});
      /**
       * 恢复"只回来一半"时必须把后端的原话说给用户听（例如"磁盘文件已不在，只恢复了记录"）。
       * 后端已经把 warnings 拼进 message，这里原样 toast —— 不要自己另编一句"恢复成功"。
       */
      toast(r.message || '已恢复', r.warnings?.length ? 'err' : 'ok');setRestoreResult(r.message||'已恢复');
      list.reload();
    } catch (err) {
      toast((err as { message: string }).message, 'err');setRestoreResult((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const doPurge = async () => {
    if (!purging) return;
    setBusyId(`${purging.kind}:${purging.id}`);
    try {
      const r = await api.del<{ message: string; filesRemoved: number }>(
        `/api/trash/${purging.kind}/${purging.id}?withFile=${purgeWithFile ? 1 : 0}`,
      );
      toast(r.message || '已彻底删除', 'ok');
      setPurging(null);
      list.reload();
    } catch (err) {
      toast((err as { message: string }).message, 'err');
    } finally {
      setBusyId(null);
    }
  };

  const doEmpty = async () => {
    try {
      const qs = emptyOlder === 'all' ? '' : `?olderThanDays=${emptyOlder}`;
      const r = await api.del<{ message: string; purged: number; filesRemoved: number }>(`/api/trash${qs}`);
      toast(r.message || `已清空 ${r.purged} 项`, 'ok');
      setEmptyOpen(false);
      list.reload();
    } catch (err) {
      toast((err as { message: string }).message, 'err');
    }
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <Card
        title="回收站"
        extra={
          <>
            <Button size="sm" onClick={() => list.reload()}>
              刷新
            </Button>
            <Button size="sm" kind="danger" disabled={items.length === 0} onClick={() => setEmptyOpen(true)}>
              清空回收站
            </Button>
          </>
        }
      >
        <div className="notice notice-info">
          移入回收站会隐藏记录，磁盘文件默认保留。
          想撤回就点「恢复」；「彻底删除」才会真的清掉记录 —— <strong>那一步不可恢复</strong>。
        </div>

        <div className="inline-fields mt12">
          <div>
            <Select
              value={kind}
              onChange={setKind}
              placeholder="全部类型"
              options={KIND_ORDER.map((k) => ({ value: k, label: `${KIND_TEXT[k]}（${countOf(k)}）` }))}
            />
          </div>
          <div className="small muted" style={{ alignSelf: 'center', flex: '2 1 auto' }}>
            共 <strong>{list.data?.total ?? 0}</strong> 项
            {items.length > 0 && <>　·　{KIND_ORDER.filter((k) => countOf(k) > 0).map((k) => `${KIND_TEXT[k]} ${countOf(k)}`).join('　')}</>}
          </div>
        </div>
      </Card>

      <Card title={kind ? `回收站 · ${KIND_TEXT[kind]}` : '回收站里的全部内容'}>
        {list.loading ? (
          <Loading />
        ) : list.error ? <LoadError error={list.error} retry={list.reload}/> : items.length === 0 ? (
          <Empty text={kind ? `回收站里没有${KIND_TEXT[kind]}。` : '回收站是空的 —— 删除的工作台、文件、阶段、字段都会先到这里。'} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>类型</th>
                <th>名称</th>
                <th>删除时间</th>
                <th>说明</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((e) => {
                const key = `${e.kind}:${e.id}`;
                return (
                  <tr key={key}>
                    <td className="nowrap">
                      <Tag kind={KIND_TAG[e.kind] ?? 'default'}>{KIND_TEXT[e.kind] ?? e.kind}</Tag>
                    </td>
                    <td>
                      <div className="check-main">
                        <div className="check-title ellipsis" title={e.title}>
                          {e.title}
                        </div>
                        <div className="small muted mono">#{e.id}</div>
                      </div>
                    </td>
                    <td className="small muted nowrap" title={fmtTime(e.deletedAt)}>
                      {agoText(e.deletedAt)}
                    </td>
                    <td className="small muted">{e.extra ?? '—'}</td>
                    <td className="nowrap">
                      <Button size="sm" kind="primary" disabled={busyId === key} onClick={() => {setRestoring(e);setRestoreResult('');}}>
                        {busyId === key ? '处理中…' : '恢复'}
                      </Button>
                      <Button
                        size="sm"
                        kind="danger"
                        disabled={busyId === key}
                        onClick={() => {
                          setPurgeWithFile(true);
                          setPurging(e);
                        }}
                        title="彻底删除这条记录（不可恢复）"
                      >
                        彻底删除
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={!!restoring} title="恢复记录" onClose={()=>{if(!busyId)setRestoring(null);}} footer={<><Button disabled={!!busyId} onClick={()=>setRestoring(null)}>关闭</Button><Button kind="primary" disabled={!!busyId||!!restoreResult} onClick={()=>{if(restoring)void restore(restoring);}}>确认恢复</Button></>}><p>{restoring?.title}</p><p className="muted">类型：{KIND_TEXT[restoring?.kind??'']??restoring?.kind} · 删除于 {restoring?fmtTime(restoring.deletedAt):''}</p><p>{restoring?.extra}</p><p>按原关联恢复记录。关联缺失或文件不可访问时，会返回具体原因，请按结果核对。</p>{restoreResult&&<p role="status" className="notice">{restoreResult}</p>}</Modal>
      {/* ---------------- 彻底删除：二次确认 ---------------- */}
      <Modal
        open={purging !== null}
        title="彻底删除？"
        onClose={() => setPurging(null)}
        footer={
          <>
            <Button onClick={() => setPurging(null)}>取消</Button>
            <Button kind="danger" disabled={busyId !== null} onClick={() => void doPurge()}>
              {busyId ? '删除中…' : '确认彻底删除'}
            </Button>
          </>
        }
      >
        <div className="notice notice-err">
          <strong>彻底删除后不可恢复。</strong>
          这条记录会从数据库里真正消失；如果它下面还挂着东西（工作台的阶段、文件记录、清单），会一并清掉。
        </div>
        {purging && (
          <>
            <dl className="kv mt12">
              <dt>类型</dt>
              <dd>{KIND_TEXT[purging.kind] ?? purging.kind}</dd>
              <dt>名称</dt>
              <dd>{purging.title}</dd>
              <dt>删除时间</dt>
              <dd>{fmtTime(purging.deletedAt)}</dd>
              {purging.extra && (
                <>
                  <dt>说明</dt>
                  <dd className="small muted">{purging.extra}</dd>
                </>
              )}
            </dl>
            <div className="mt12">
              <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input type="radio" checked={purgeWithFile} onChange={() => setPurgeWithFile(true)} />
                <span>
                  <strong>连磁盘文件一起删</strong>
                  <div className="small muted">
                    只删**平台登记过**、且落在允许目录里的文件；绑定型工作台**不会**删你绑定的资料目录本身，
                    也不会碰你自己放进去的其它文件。工作台自己建的 `_` 前缀空目录会被回收。
                  </div>
                </span>
              </label>
              <label className="row mt8" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input type="radio" checked={!purgeWithFile} onChange={() => setPurgeWithFile(false)} />
                <span>
                  <strong>只删记录，磁盘文件留着</strong>
                  <div className="small muted">文件会留在原来的位置（以后想手工归档、或重新纳管都可以）。</div>
                </span>
              </label>
            </div>
          </>
        )}
      </Modal>

      {/* ---------------- 清空回收站 ---------------- */}
      <Modal
        open={emptyOpen}
        title="清空回收站？"
        onClose={() => setEmptyOpen(false)}
        footer={
          <>
            <Button onClick={() => setEmptyOpen(false)}>取消</Button>
            <Button kind="danger" onClick={() => void doEmpty()}>
              确认清空
            </Button>
          </>
        }
      >
        <div className="notice notice-err">
          <strong>清空后不可恢复。</strong>
          里面的记录会被逐条彻底删除；磁盘文件按下面选的保留期一并处理（平台登记过的文件会被删掉）。
        </div>
        <div className="mt12">
          <Select
            value={emptyOlder}
            onChange={setEmptyOlder}
            options={[
              { value: '7', label: '只清删除超过 7 天的（推荐）' },
              { value: '30', label: '只清删除超过 30 天的' },
              { value: '1', label: '只清删除超过 1 天的' },
              { value: 'all', label: '全部清空（包括刚刚删的）' },
            ]}
          />
        </div>
      </Modal>
    </div>
  );
}
