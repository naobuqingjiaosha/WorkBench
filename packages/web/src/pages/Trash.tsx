import {PageActions} from '../components/PageActions';
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
import {LoadError, NavIcon, SectionTitle} from '../components/DesignSystem';
import { useEffect, useRef, useState } from 'react';
import {useNavigationGuard} from '../components/NavigationGuard';
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
  counts: Record<TrashKind, number>;
  kinds: string[];
}

interface EmptyResult {
  message: string;
  purged: number; covered: number; retained: number; protected: number; failed: number; notExecuted: number; filesRemoved: number;
  skipped?: string[]; warnings?: string[];
  scope: { limit: number; snapshot: number; totalAtStart: number; outsideSnapshot: number; remaining: number; olderThanDays: number | null; cutoff: string | null };
  items: { kind: string; id: number; title: string; status: string; reason?: string; filesRemoved?: number; skipped?: string[]; warnings?: string[]; parent?: { kind: string; id: number } }[];
}
const RESULT_TEXT: Record<string, string> = { purged: '已删除', covered: '随父项删除', retained: '保留期未处理', protected: '安全拒绝（记录保留）', failed: '失败', notExecuted: '未执行' };

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
  const [purgeWithFile, setPurgeWithFile] = useState(false);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyOlder, setEmptyOlder] = useState('7');
  const emptyLock = useRef(false);
  const [emptyBusy, setEmptyBusy] = useState(false);
  const [emptyResult, setEmptyResult] = useState<EmptyResult | null>(null);
  const [emptyError, setEmptyError] = useState('');
  const [checkedList, setCheckedList] = useState<TrashList | null>(null);
  const checkedAfterError = checkedList !== null;
  const [checking, setChecking] = useState(false);
  const [purgeMessage, setPurgeMessage] = useState('');
  const guard = useNavigationGuard();
  useEffect(() => guard.register(Symbol('trash-empty'), () => ({ dirty: false, busy: emptyLock.current })), [guard]);
  useEffect(() => guard.changed(), [guard, emptyBusy]);
  const closeEmpty = () => { if (!emptyLock.current) setEmptyOpen(false); };


  const path = kind ? `/api/trash?kind=${encodeURIComponent(kind)}` : '/api/trash';
  const list = useApi<TrashList>(path, [kind]);
  const items = list.data?.items ?? [];

  useEffect(() => {
    setBusyId(null);
  }, [kind]);

  /** 按类型统计条数（顶部筛选旁的小字） */
  const countOf = (k: TrashKind) => list.data?.counts?.[k] ?? 0;

  const restore = async (e: TrashEntry) => {
    if (emptyLock.current) return;
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
    if (!purging || emptyLock.current) return;
    setBusyId(`${purging.kind}:${purging.id}`);
    try {
      const r = await api.del<{ message: string; filesRemoved: number; skipped?: string[]; warnings?: string[] }>(
        `/api/trash/${purging.kind}/${purging.id}?withFile=${purgeWithFile ? 1 : 0}`,
      );
      toast(r.message || '已彻底删除', r.skipped?.length || r.warnings?.length ? 'info' : 'ok');
      setPurgeMessage(r.message || '已彻底删除');
      setPurging(null);
      list.reload();
    } catch (err) {
      toast((err as { message: string }).message, 'err');
    } finally {
      setBusyId(null);
    }
  };

  const checkAfterError = async () => {
    if (emptyLock.current || checking) return;
    setChecking(true);setCheckedList(null);
    try {
      const verified = await api.get<TrashList>('/api/trash?limit=2000');
      setCheckedList(verified);
      list.reload();
    } catch (err) { toast((err as Error).message, 'err'); }
    finally { setChecking(false); }
  };

  const doEmpty = async () => {
    // useRef同步加锁：React重绘前的第二次确认也不能发出请求。
    if (emptyLock.current || busyId || (emptyError && !checkedAfterError)) return;
    emptyLock.current = true;
    const selectedOlder = emptyOlder;
    setEmptyBusy(true);setEmptyError('');setCheckedList(null);
    try {
      const qs = selectedOlder === 'all' ? '' : `?olderThanDays=${selectedOlder}`;
      const r = await api.del<EmptyResult>(`/api/trash${qs}`);
      setEmptyResult(r);
      toast(r.message, r.failed || r.notExecuted ? 'err' : r.skipped?.length || r.warnings?.length || r.protected || r.retained || r.scope.outsideSnapshot ? 'info' : 'ok');
      list.reload();
    } catch (err) {
      const message = `未取得完整清理结果：${(err as Error).message}。部分目标可能已经删除；请先重新核对列表及文件，再决定是否再次确认。不会自动重试。`;
      setEmptyError(message);toast(message, 'err');
    } finally {
      emptyLock.current = false;
      setEmptyBusy(false);
    }
  };

  const emptyReport = <>
    {emptyBusy && <p role="status" className="notice notice-info">正在处理本次范围，请等待结果。保留期与关闭操作已锁定。</p>}
    {emptyError && <div role="alert" className="notice notice-err"><p>{emptyError}</p><Button disabled={checking || emptyBusy} onClick={() => void checkAfterError()}>{checking ? '核对中…' : '重新核对列表'}</Button>{checkedList && <div aria-label="核对快照">
      <p>已取得全部类型的核对快照：{checkedList.items.length} / {checkedList.count} 项（最多2000项），不受页面筛选影响。请阅读下列实际返回的记录并核对文件，再决定是否再次确认清空。</p>
      {checkedList.count > checkedList.items.length && <p>仍有条目超出核对快照；这不是完整清空或完整核对证明。</p>}
      <details open><summary>此次核对返回的记录（{checkedList.items.length} 项）</summary>
        {checkedList.items.length === 0 ? <p>此次读取未发现回收站记录；文件是否完整仍须核对。</p> : <ul>{checkedList.items.map(e => <li key={`${e.kind}:${e.id}`}>{KIND_TEXT[e.kind] ?? e.kind} #{e.id} · {e.title} · 删除于 {fmtTime(e.deletedAt)}</li>)}</ul>}
      </details>
      <p>这是核对时的快照；列表刷新失败不改变此快照，其他窗口后续变化不在本次核对内。</p>
    </div>}</div>}
    {emptyResult && <div aria-label="清理结果" className="mt12">
      <p role="status" className={`notice ${emptyResult.failed || emptyResult.notExecuted ? 'notice-err' : 'notice-info'}`}>{emptyBusy || emptyError ? '上次已收到的结果：' : ''}{emptyResult.message}</p>
      <p className="small muted">本次保留期：{emptyResult.scope.olderThanDays === null ? '全部' : `${emptyResult.scope.olderThanDays} 天`}；快照 {emptyResult.scope.snapshot} / {emptyResult.scope.totalAtStart} 项，上限 {emptyResult.scope.limit} 项。逐项提交，不是整批回滚。父项删除包含其所有子记录，子项日期不单独限制；未纳入快照的子项也可能随父项删除。</p>
      {emptyResult.scope.outsideSnapshot > 0 && <p className="notice notice-info">仍有条目未纳入本次快照，不能视为全部清空；不会自动继续下一批。</p>}
      <details open={Boolean(emptyResult.failed || emptyResult.notExecuted || emptyResult.protected || emptyResult.skipped?.length || emptyResult.warnings?.length)}>
        <summary>逐项结果（{emptyResult.items.length} 项）</summary>
        <ul>{emptyResult.items.map(e => <li key={`${e.kind}:${e.id}`}>
          <strong>{KIND_TEXT[e.kind] ?? e.kind} #{e.id} · {e.title}：{RESULT_TEXT[e.status] ?? e.status}</strong>
          {e.parent && <span>（父项：{KIND_TEXT[e.parent.kind] ?? e.parent.kind} #{e.parent.id}）</span>}
          {e.reason && <p>{e.reason}</p>}
          {e.skipped?.map((v,i) => <p key={`skip${i}`}>安全保留：{v}</p>)}
          {e.warnings?.map((v,i) => <p key={`warn${i}`}>清理警告：{v}</p>)}
        </li>)}</ul>
      </details>
    </div>}
  </>;

  return (
    <div className="trash-view">
      <PageActions>
        <Button size="sm" disabled={emptyBusy} onClick={list.reload}>刷新</Button>
        <Button size="sm" kind="danger" disabled={emptyBusy || !!busyId || (!list.data?.count && !emptyError)} onClick={() => setEmptyOpen(true)}>清空回收站</Button>
      </PageActions>
        <div className="notice notice-info">
          移入回收站会隐藏记录，磁盘文件默认保留。
          恢复时将核对原关联。<strong>彻底删除不可恢复</strong>，操作前需再次确认。
        </div>

        <div className="trash-filters">
          <div>
            <Select
              value={kind}
              disabled={emptyBusy}
              onChange={value => { if (!emptyLock.current) setKind(value); }}
              placeholder="全部类型"
              options={KIND_ORDER.map((k) => ({ value: k, label: `${KIND_TEXT[k]}（${countOf(k)}）` }))}
            />
          </div>
          <div className="small muted">
            {list.data && <>回收站共 <strong>{list.data.count}</strong> 项，当前显示 {items.length} 项。<span className="trash-breakdown">{KIND_ORDER.filter(k=>countOf(k)>0).map(k=><span key={k}>{KIND_TEXT[k]} {countOf(k)}</span>)}</span></>}清空操作适用于全部类型。
          </div>
        </div>

      {(emptyResult || emptyError) && !emptyOpen && <Card title="最近一次清理结果">{emptyReport}</Card>}
      {purgeMessage && <Card title="最近一次单项删除结果"><p role="status">{purgeMessage}</p></Card>}
      <Card className="trash-results" title={<SectionTitle icon="trash">{kind ? `回收站 · ${KIND_TEXT[kind]}` : '回收站里的全部内容'}</SectionTitle>}>
        {list.loading ? (
          <Loading />
        ) : list.error ? <LoadError error={list.error} retry={list.reload}/> : items.length === 0 ? (
          <Empty text={kind ? `回收站里没有${KIND_TEXT[kind]}。` : '回收站是空的 —— 删除的工作台、文件、阶段、字段都会先到这里。'} />
        ) : (
          <table className="table trash-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>名称</th>
                <th>删除时间</th>
                <th>说明</th>
                <th>操作</th>
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
                        <div className="check-title" title={e.title}>
                          <NavIcon name={e.kind==='position'?'chart':e.kind==='workbench'?'dashboard':'workbench'}/>{e.title}
                        </div>
                        <div className="small muted mono">#{e.id}</div>
                      </div>
                    </td>
                    <td className="small muted nowrap" title={fmtTime(e.deletedAt)}>
                      {agoText(e.deletedAt)}
                    </td>
                    <td className="small muted">{e.extra ?? '—'}</td>
                    <td className="trash-actions">
                      <Button size="sm" disabled={emptyBusy || busyId === key} onClick={() => {setRestoring(e);setRestoreResult('');}}>
                        {busyId === key ? '处理中…' : '恢复'}
                      </Button>
                      <Button
                        size="sm"
                        kind="danger"
                        disabled={emptyBusy || busyId === key}
                        onClick={() => {
                          setPurgeWithFile(false);
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
                    仅删除已登记且位于允许目录内的文件。绑定目录、用户另存的文件会保留，工作台建立的空目录可能被回收。
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
        onClose={closeEmpty}
        footer={
          <>
            <Button disabled={emptyBusy} onClick={closeEmpty}>{emptyResult || emptyError ? '关闭' : '取消'}</Button>
            <Button kind="danger" disabled={emptyBusy || checking || (!!emptyError && !checkedAfterError)} onClick={() => void doEmpty()}>
              {emptyBusy ? '清理中…' : emptyResult || emptyError ? '再次确认清空' : '确认清空'}
            </Button>
          </>
        }
      >
        <div className="notice notice-err">
          <strong>清空后不可恢复。</strong>
          处理全部类型（不受页面筛选限制），按删除时间倒序选取最多2000条快照，再应用保留期。逐目标删除记录与允许删除的磁盘文件；父项包含全部子记录，子项不另按日期保留。失败不会回滚已经完成的其他目标，也不会自动继续下一批。
        </div>
        <div className="mt12">
          <Select
            value={emptyOlder}
            disabled={emptyBusy}
            onChange={value => { if (!emptyLock.current) setEmptyOlder(value); }}
            options={[
              { value: '7', label: '只清删除超过 7 天的（推荐）' },
              { value: '30', label: '只清删除超过 30 天的' },
              { value: '1', label: '只清删除超过 1 天的' },
              { value: 'all', label: '全部清空（包括刚刚删的）' },
            ]}
          />
        </div>
        {emptyReport}
      </Modal>
    </div>
  );
}
