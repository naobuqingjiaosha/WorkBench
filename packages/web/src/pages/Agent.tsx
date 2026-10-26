/**
 * AI 助手 —— 把「AI 梳理」升级成对话
 *
 * 用户的原话：「我可能有一个事情没空仔细操作，直接交代给大模型，他帮我记住或者直接修改了。」
 *
 * 所以这一页的重点不是聊天，而是**交代**：
 *   说一句"把清廉工程的负责人改成张工" → 它生成一条待确认动作 → 你点一下才生效。
 *   说一句"记一下：签收记录 9 月 30 日前补齐" → 记成备忘，以后对话和出文书都会自动用上。
 *
 * 写入一律两步走（提议 → 确认），破坏性动作（删工作台）还要额外的二次确认 ——
 * 这是上面定下的底线，界面上必须让它显眼。
 */
import WorkRecordsPage,{RecordMessageText} from './WorkRecords';
import {SectionNav,LoadError} from '../components/DesignSystem';
import {InspectionDrafts} from '../components/InspectionDrafts';
import { useEffect, useRef, useState } from 'react';
import { api, useApi, type Workbench } from '../api';
import { MemoryLifecycle } from '../components/WorkflowPanels';
import { Button, Card, Empty, Input, Loading, Select, Tag, Textarea, fmtSize, fmtTime, useAction, useToast } from '../ui';
import { ProposalsPanel } from './Proposals';
import BusinessAssistantEvidence from '../components/BusinessAssistantEvidence';

/* ============================== 类型 ============================== */

interface AgentAction {
  id: number;
  tool: string;
  payload: string;
  summary: string;
  risk: 'normal' | 'destructive';
  status: 'pending' | 'applied' | 'discarded' | 'failed' | 'undone';
  result: string | null;
  error: string | null;
  applied_at: string | null;
  created_at: string;
}

interface AgentMessage {
  businessRunId?: number;
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  actions: AgentAction[];
}

interface AgentReply {
  business?: {id:number};
  sessionId: number;
  messageId: number;
  text: string;
  actions: AgentAction[];
  trace: { tool: string; args: Record<string, unknown>; result?: string }[];
  usage: { prompt: number; output: number; total: number };
  model: string;
  memoriesUsed: number;
}

interface Memory {
  id: number;
  text: string;
  workbench_id: number | null;
  due_date: string | null;
  created_at: string;
}

type Tab = 'records' | 'chat' | 'memory' | 'proposals' | 'audit';

/* ============================== 页面 ============================== */

export default function AgentPage() {
  const [tab, setTab] = useState<Tab>('chat');
  const [savedRun,setSavedRun]=useState<number|null>(null);
  const history=useApi<{items:{id:number;question:string;artifact_id:number|null;created_at:string}[]}>('/api/agent/business');
  const [pendingCount, setPendingCount] = useState(0);

  const tabs: [Tab, string][] = [
    ['chat', '对话'],
    ['records', '工作记录'],
    ['memory', '补充备忘'],
    ['proposals', '待确认建议'],
    ['audit', '操作记录'],
  ];

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        {tabs.map(([k, label]) => (
          <button key={k} className={`btn btn-sm${tab === k ? ' btn-primary' : ''}`} onClick={() => setTab(k)}>
            {label}
            {k === 'proposals' && pendingCount > 0 ? `（${pendingCount}）` : ''}
          </button>
        ))}
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          记住你告知的工作，查询来源；正式业务修改仍由你确认
        </span>
      </div>

      {tab === 'chat' && <div className="chat-layout"><aside className="chat-history"><Card title="最近业务问答" extra={<Button size="sm" onClick={history.reload}>刷新</Button>}>{history.error?<LoadError error={history.error} retry={history.reload}/>:history.loading?<Loading/>:!history.data?.items.length?<Empty text="还没有业务问答记录"/>:history.data.items.slice(0,20).map(r=><button className="chat-history-item" key={r.id} onClick={()=>setSavedRun(r.id)}>{r.question.slice(0,55)}<span className="small muted">{fmtTime(r.created_at)}</span></button>)}</Card></aside><div className="section-content"><ChatPanel onPending={setPendingCount}/>{savedRun&&<Card title="问答证据" extra={<Button size="sm" onClick={()=>setSavedRun(null)}>关闭</Button>}><BusinessAssistantEvidence key={savedRun} runId={savedRun}/></Card>}</div></div>}
      {tab !== 'chat' && <div className="agent-secondary">
      {tab === 'records' && <WorkRecordsPage/>}
      {tab === 'memory' && <><MemoryPanel /><MemoryLifecycle /></>}
      {tab === 'proposals' && <ProposalsPanel onPending={setPendingCount} />}
      {tab === 'audit' && <AuditPanel />}
      </div>}
    </div>
  );
}

/* ============================== 对话 ============================== */

function ChatPanel({ onPending }: { onPending: (n: number) => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [lastTrace, setLastTrace] = useState<AgentReply['trace']>([]);
  const [workbenchId, setWorkbenchId] = useState('');
  const [periodId,setPeriodId]=useState('');
  const [suggestOnOpen,setSuggestOnOpen]=useState<number|undefined>();
  const [inspectionContext,setInspectionContext]=useState<{templates:{id:number;name:string}[]}|null>(null);
  useEffect(()=>{let active=true;setInspectionContext(null);if(periodId)api.get<{readiness:{monthly:boolean};snapshot:string}>(`/api/periods/${periodId}`).then(p=>{if(active&&p.readiness.monthly)setInspectionContext({templates:JSON.parse(p.snapshot).templates.filter((t:{generation_scope?:string})=>t.generation_scope!=='period')});}).catch(()=>{});return()=>{active=false;};},[periodId]);
  const [businessPeriods,setBusinessPeriods]=useState<{id:number;report_period:string}[]>([]);
  useEffect(()=>{let active=true;setPeriodId('');setBusinessPeriods([]);if(workbenchId)api.get<{items:{id:number;report_period:string}[]}>(`/api/workbenches/${workbenchId}/periods`).then(r=>{if(active)setBusinessPeriods(r.items);}).catch(()=>{});return ()=>{active=false;};},[workbenchId]);
  const chatRequest=useRef<{body:string;key:string}|null>(null);
  const [recordMode,setRecordMode]=useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const workbenches = useWorkbenches();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  const loadActions = async (sid: number | null) => {
    const r = await api.get<{ count: number }>(`/api/agent/actions${sid ? `?sessionId=${sid}` : ''}`);
    onPending(r.count);
  };

  /**
   * 发照片给助手看。
   *
   * 走的是同一条对话接口：先把照片登记成文件（挂在选中的工作台下，没选就进待归档），
   * 然后把 artifact id 一起发过去 —— 助手用 review_photos 工具让视觉模型看懂它，
   * 再自己决定接下来做什么（核销清单 / 写字段 / 记备忘 / 直接回答）。
   */
  const sendPhotos = (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    void run(async () => {
      const ids: number[] = [];
      for (const f of list) {
        const fd = new FormData();
        fd.append('file', f, f.name);
        if (workbenchId) {
          fd.append('workbenchId', workbenchId);
          fd.append('kind', 'evidence');
        } else {
          fd.append('kind', 'source');
        }
        fd.append('note', f.name.replace(/\.[^.]+$/, ''));
        const r = await api.upload<{ items: { id: number }[] }>('/api/artifacts/upload', fd);
        for (const it of r.items) ids.push(it.id);
      }
      const text = input.trim() || '看看这几张照片，告诉我拍得对不对，然后该做什么就做什么。';
      setInput('');
      setMessages((prev) => [
        ...prev,
        { id: -Date.now(), role: 'user', content: `${text}\n（附了 ${ids.length} 张照片）`, created_at: new Date().toISOString(), actions: [] },
      ]);
      try {
        const r = await api.post<AgentReply>('/api/agent/chat', {
          sessionId,
          message: text,
          workbenchId: workbenchId ? Number(workbenchId) : null,
          artifactIds: ids,
          periodId:periodId?Number(periodId):null,
        });
        setSessionId(r.sessionId);
        setLastTrace(r.trace);
        const openedDraft=r.trace.find(t=>t.tool==='inspection_draft');if(openedDraft?.args.periodId)setPeriodId(String(openedDraft.args.periodId));if(openedDraft?.args.created)setSuggestOnOpen(Number(openedDraft.args.draftId));
        setMessages((prev) => [
          ...prev,
          { id: r.messageId, role: 'assistant', content: r.text, created_at: new Date().toISOString(), actions: r.actions, businessRunId:r.business?.id },
        ]);
        await loadActions(r.sessionId);
      } catch (e) {
        toast((e as { message: string }).message, 'err');
      }
    });
  };

  const send = () =>
    run(async () => {
      const text = input.trim();
      if (!text) return;
      setInput('');
      const requestBody=JSON.stringify({sessionId,text,workbenchId,periodId,recordMode});
      if(chatRequest.current?.body!==requestBody)chatRequest.current={body:requestBody,key:crypto.randomUUID()};
      const optimistic: AgentMessage = {
        id: -Date.now(),
        role: 'user',
        content: text,
        created_at: new Date().toISOString(),
        actions: [],
      };
      setMessages((prev) => [...prev, optimistic]);
      try {
        const r = await api.post<AgentReply>('/api/agent/chat', {
          sessionId,
          message: text,
          requestKey:chatRequest.current!.key,
          recordMode:recordMode||undefined,
          workbenchId: workbenchId ? Number(workbenchId) : null,
          periodId:periodId?Number(periodId):null,
        });
        chatRequest.current=null;
        setSessionId(r.sessionId);
        setLastTrace(r.trace);
        const openedDraft=r.trace.find(t=>t.tool==='inspection_draft');if(openedDraft?.args.periodId)setPeriodId(String(openedDraft.args.periodId));if(openedDraft?.args.created)setSuggestOnOpen(Number(openedDraft.args.draftId));
        setMessages((prev) => [
          ...prev,
          { id: r.messageId, role: 'assistant', content: r.text, created_at: new Date().toISOString(), actions: r.actions, businessRunId:r.business?.id },
        ]);
        await loadActions(r.sessionId).catch(() => toast('回复已保存，待确认列表刷新失败，请刷新页面查看', 'err'));
        if (!r.actions.length) toast(`完成（${r.model}，${(r.usage.total / 1000).toFixed(1)}k tokens）`, 'ok');
      } catch (e) {
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setInput(text);
        toast((e as { message: string }).message, 'err');
      }
    });

  const applyOne = (id: number, destructive: boolean) =>
    run(async () => {
      if (destructive && !window.confirm('这是破坏性操作，执行后不可恢复。确定执行吗？')) return;
      const r = await api.post<{ result: unknown }>(`/api/agent/actions/${id}/apply`, {});
      toast(`已执行：${JSON.stringify(r.result).slice(0, 80)}`, 'ok');
      await refresh();
    });

  const discardOne = (id: number) =>
    run(async () => {
      await api.post(`/api/agent/actions/${id}/discard`, {});
      await refresh();
    });

  const applyAll = () =>
    run(async () => {
      const r = await api.post<{ applied: number; skippedDestructive: number }>('/api/agent/actions/apply-all', {
        sessionId,
      });
      toast(
        `已执行 ${r.applied} 条${r.skippedDestructive ? `，${r.skippedDestructive} 条破坏性操作需要逐条确认` : ''}`,
        'ok',
      );
      await refresh();
    });

  const refresh = async () => {
    if (sessionId) {
      const r = await api.get<{ items: AgentMessage[] }>(`/api/agent/messages?sessionId=${sessionId}`);
      setMessages(r.items);
    }
    await loadActions(sessionId);
  };

  const pending = messages.flatMap((m) => m.actions).filter((a) => a.status === 'pending');

  return (
    <>
      {inspectionContext&&periodId&&<InspectionDrafts key={periodId} refreshKey={messages.length} suggestOnOpen={suggestOnOpen} onSuggestionStarted={()=>setSuggestOnOpen(undefined)} periodId={Number(periodId)} workbenchId={Number(workbenchId)} templates={inspectionContext.templates}/>}
      <Card
        title="本次对话"
        extra={
          <>
            <Select value={recordMode} onChange={setRecordMode} options={[{value:'',label:'自动识别'},{value:'capture',label:'记工作记录'},{value:'query',label:'查工作记录／总结'}]}/>
            <Select
              value={workbenchId}
              onChange={setWorkbenchId}
              placeholder="不指定工作"
              options={(workbenches.data?.items ?? []).map((w) => ({ value: String(w.id), label: w.name }))}
            />
            {!!businessPeriods.length&&<Select value={periodId} onChange={setPeriodId} placeholder="期间由问题或唯一资料期次确定" options={businessPeriods.map(p=>({value:String(p.id),label:p.report_period}))}/>}
            {sessionId && (
              <Button
                size="sm"
                onClick={() => {
                  setSessionId(null);
                  setMessages([]);
                  setLastTrace([]);
                  onPending(0);
                }}
              >
                新对话
              </Button>
            )}
          </>
        }
      >
        <div className="notice notice-info">
          直接说事就行，例如：
          <strong>「记一下：今天已经把会议材料发给办公室了」</strong>、
          <strong>「我这个月做了什么？」</strong>，也可以询问项目进展或起草正式文书。
          <br />
          <span className="small">
            工作记录保存在本机，可跨对话查询、更正与撤回；不需要配置模型。记录回顾按原话列出，正式业务分析与文书起草使用对应证据和模型。
            <strong>定稿、实际完成与业务修改仍需明确确认。</strong>
          </span>
        </div>

        {messages.length === 0 && !busy && (
          <Empty text="还没有对话。上面输入框里直接交代一件事，或者先问一句「我有哪些工作？」" />
        )}

        <div className="col" style={{ gap: 14, marginTop: messages.length ? 12 : 0 }}>
          {messages.map((m) => (
            <div key={m.id} className={`chat-message ${m.role}`}>
              <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Tag kind={m.role === 'user' ? 'info' : 'ok'}>{m.role === 'user' ? '我' : '助手'}</Tag>
                <div style={{ flex: 1, whiteSpace: 'pre-wrap', lineHeight: 1.75 }}><RecordMessageText text={m.content}/></div>
                <span className="muted small nowrap">{fmtTime(m.created_at)}</span>
              </div>
              {m.businessRunId&&<BusinessAssistantEvidence runId={m.businessRunId}/>}
              {m.actions.length > 0 && (
                <div className="col" style={{ gap: 8, marginTop: 8, marginLeft: 46 }}>
                  {m.actions.map((a) => (
                    <ActionCard
                      key={a.id}
                      action={a}
                      busy={busy}
                      onApply={() => applyOne(a.id, a.risk === 'destructive')}
                      onDiscard={() => discardOne(a.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && <Loading text="助手正在处理…" />}
          <div ref={endRef} />
        </div>
      </Card>

      {pending.length > 1 && (
        <Card title={`待确认动作（${pending.length}）`} extra={<Button size="sm" kind="primary" disabled={busy} onClick={applyAll}>全部执行</Button>}>
          <p className="muted small" style={{ marginTop: 0 }}>
            「全部执行」只处理普通动作；删除这类破坏性操作必须逐条确认。
          </p>
          <div className="col" style={{ gap: 8 }}>
            {pending.map((a) => (
              <ActionCard
                key={a.id}
                action={a}
                busy={busy}
                onApply={() => applyOne(a.id, a.risk === 'destructive')}
                onDiscard={() => discardOne(a.id)}
              />
            ))}
          </div>
        </Card>
      )}

      {lastTrace.length > 0 && (
        <Card title="这一轮它做了什么" collapsible>
          <div className="col" style={{ gap: 6 }}>
            {lastTrace.map((t, i) => (
              <div key={i} className="small">
                <span className="mono">{t.tool}</span>
                <span className="muted"> {JSON.stringify(t.args).slice(0, 120)}</span>
                {t.result && <div className="muted" style={{ marginLeft: 12 }}>→ {t.result.slice(0, 160)}</div>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="chat-composer">
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Textarea
              value={input}
              onChange={setInput}
              rows={2}
              placeholder="交代一件事，或者问一句…（Enter 发送，Shift+Enter 换行）"
            />
          </div>
          <Button disabled={busy} onClick={() => photoRef.current?.click()} title="把照片交给它看：拍到了什么、是否符合要求、接下来该做什么">
            📷 附照片
          </Button>
          <Button kind="primary" disabled={busy || !input.trim()} onClick={send}>
            {busy ? '处理中…' : '发送'}
          </Button>
        </div>
        <input
          ref={photoRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files;
            e.target.value = '';
            sendPhotos(files);
          }}
        />
        <p className="muted small" style={{ marginBottom: 0 }}>
          照片会先存进{workbenchId ? '选中的这份工作' : '待归档'}，然后交给视觉模型看懂 ——
          它据此判断、并把该做的事提成待确认动作（比如核销某条影像清单、记一条备忘）。
        </p>
      </Card>
    </>
  );
}

function ActionCard({
  action,
  busy,
  onApply,
  onDiscard,
}: {
  action: AgentAction;
  busy: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const destructive = action.risk === 'destructive';
  const done = action.status !== 'pending';
  return (
    <div className={`action-card${destructive ? ' action-card-danger' : ''}`}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <Tag kind={destructive ? 'err' : done ? 'default' : 'warn'}>
          {destructive
            ? '破坏性'
            : action.status === 'applied'
              ? '已执行'
              : action.status === 'undone'
                ? '已撤销'
                : action.status === 'discarded'
                  ? '已忽略'
                  : action.status === 'failed'
                    ? '执行失败'
                    : '待确认'}
        </Tag>
        <div style={{ flex: 1 }}>
          <div>{action.summary}</div>
          <div className="small muted mono">{action.tool}</div>
          {action.error && <div className="small" style={{ color: 'var(--err)' }}>失败：{action.error}</div>}
          {action.result && !action.error && (
            <div className="small muted">结果：{action.result.slice(0, 160)}</div>
          )}
        </div>
        {!done && (
          <div className="row nowrap" style={{ gap: 6 }}>
            <Button size="sm" kind={destructive ? 'danger' : 'primary'} disabled={busy} onClick={onApply}>
              执行
            </Button>
            <Button size="sm" disabled={busy} onClick={onDiscard}>
              忽略
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================== 记忆 ============================== */

function MemoryPanel() {
  const toast = useToast();
  const { busy, run } = useAction();
  const [items, setItems] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [due, setDue] = useState('');
  const [workbenchId, setWorkbenchId] = useState('');
  const workbenches = useWorkbenches();

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get<{ items: Memory[] }>('/api/agent/memories');
      setItems(r.items);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const wbName = (id: number | null) => workbenches.data?.items.find((w) => w.id === id)?.name;

  return (
    <>
      <div className="notice notice-info">
        <strong>记忆 = 你交代过、但没有对应字段可以填的信息。</strong>
        例如「签收记录 9 月 30 日前补齐」。它不会躺在这里吃灰 ——
        <strong>对话时和出文书时都会自动带上</strong>，所以以后问到相关的事，模型能直接给正确答案。
        <br />
        <span className="small">
          能填进「项目信息」字段的，应该填字段而不是记在这里（字段是结构化的，更可靠）。手动记的一条不需要确认；
          让助手记的会先生成待确认动作。
        </span>
      </div>

      <Card title={`已记住 ${items.length} 条`} extra={<Button size="sm" onClick={() => void load()}>刷新</Button>}>
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Input value={text} onChange={setText} placeholder="记一条：例如「清廉工程 9 月 30 日前补齐签收记录」" onEnter={() => undefined} />
          </div>
          <Input value={due} onChange={setDue} placeholder="期限(可空)" />
          <Select
            value={workbenchId}
            onChange={setWorkbenchId}
            placeholder="不指定工作"
            options={(workbenches.data?.items ?? []).map((w) => ({ value: String(w.id), label: w.name }))}
          />
          <Button
            kind="primary"
            disabled={busy || !text.trim()}
            onClick={() =>
              run(async () => {
                await api.post('/api/agent/memories', {
                  text,
                  dueDate: due || null,
                  workbenchId: workbenchId ? Number(workbenchId) : null,
                });
                setText('');
                setDue('');
                await load();
              }, '已记住')
            }
          >
            记下来
          </Button>
        </div>

        {loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty text="还没有记住任何事。在对话里说一句「记一下：…」，或者在上面手动记一条。" />
        ) : (
          <table className="table mt12">
            <thead>
              <tr>
                <th>内容</th>
                <th style={{ width: 160 }}>属于</th>
                <th style={{ width: 110 }}>期限</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td>{m.text}</td>
                  <td className="small muted">{m.workbench_id ? wbName(m.workbench_id) ?? `#${m.workbench_id}` : '全局'}</td>
                  <td className="small muted">{m.due_date ?? '—'}</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await api.del(`/api/agent/memories/${m.id}`);
                          await load();
                          toast('已删除', 'ok');
                        })
                      }
                    >
                      删除
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

/* ============================== 记录（操作审计） ============================== */

/**
 * 「记录」这一页要回答的问题是：**出了问题能不能倒查到谁在什么时候改了哪个字段、用了哪个模板、花了多少 token**。
 *
 * 数据来自三个后端接口（都注册在 `api/routes-agent.ts` 里）：
 *   GET /api/audit/actions      助手动作（含改动前后对比、状态、来源）
 *   GET /api/audit/generations  出文书记录（模板 / 工作台 / 是否落盘 / 文件大小）
 *   GET /api/audit/summary      概览（数量、按状态、token 合计、费用估算）
 *
 * 翻页用后端给的 `nextBefore`（自增 id 游标），**不用 offset** —— offset 在有新记录写入时会
 * 让同一行出现两次、有的行永远看不到。前端另外按 id 去一次重，双重保险。
 */

interface AuditActionItem {
  id: number;
  createdAt: string;
  appliedAt: string | null;
  status: string;
  statusLabel: string;
  tool: string;
  toolLabel: string;
  actionType: string;
  risk: string;
  destructive: boolean;
  sessionId: number | null;
  messageId: number | null;
  source: string;
  sourceLabel: string;
  confirmedBy: string | null;
  workbench: { id: number; name: string | null; code: string | null; deleted: boolean } | null;
  workbenchSource: string | null;
  /** 目标对象当前在不在回收站里（软删除，迁移 015 之后才有意义） */
  targetDeleted: boolean;
  target: string;
  field: string | null;
  fieldLabel: string | null;
  before: unknown;
  beforeKnown: boolean;
  /** 快照来源：before_json / payload._before / result.before；null = 这条没留快照 */
  beforeSource: 'before_json' | 'payload._before' | 'result.before' | null;
  snapshotColumnPresent: boolean;
  snapshotNote: string | null;
  after: unknown;
  change: string;
  summary: string;
  error: string | null;
  resultPreview: string | null;
}

interface AuditGenerationItem {
  id: number;
  createdAt: string;
  status: string;
  statusLabel: string;
  mode: string;
  modeLabel: string;
  purpose: string | null;
  templateId: number | null;
  templateName: string | null;
  templateCategory: string | null;
  workbenchId: number | null;
  workbenchName: string | null;
  workbenchCode: string | null;
  /** 这份工作台已经被软删除（记录照样留着，只打标记） */
  workbenchDeleted: boolean;
  artifactId: number | null;
  artifactTitle: string | null;
  /** 落盘文件已进回收站 */
  artifactDeleted: boolean;
  fileName: string | null;
  filePath: string | null;
  fileRootKind: string | null;
  sizeBytes: number | null;
  /** 文件是不是**真的**还在磁盘上：true 在 / false 不在 / null 判定不了（外部根没绑定） */
  onDisk: boolean | null;
  variableCount: number;
  variablesPreview: string | null;
  tokensApprox: number | null;
  tokensSource: string | null;
  message: string | null;
}

interface AuditPage<T> {
  items: T[];
  count: number;
  limit: number;
  hasMore: boolean;
  nextBefore: number | null;
  degraded: string[];
}

interface AuditSummary {
  days: number;
  since: string;
  windowLabel: string;
  actions: {
    recent: number;
    total: number;
    pending: number;
    pendingRecent: number;
    byStatus: { status: string; label: string; count: number }[];
    byTool: { tool: string; label: string; count: number }[];
  };
  generations: {
    recent: number;
    total: number;
    ok: number;
    failed: number;
    byStatus: { status: string; label: string; count: number }[];
  };
  tokens: {
    calls: number;
    prompt: number;
    output: number;
    total: number;
    byPurpose: { purpose: string; calls: number; tokens: number }[];
    allTimeCalls: number;
    allTimeTokens: number;
    testCalls: number;
    testTokens: number;
    scope: string;
  };
  cost: {
    available: boolean;
    currency: string;
    amount: number | null;
    unit?: string;
    reason?: string;
    note?: string;
    basis?: string;
  };
  degraded: string[];
}

/** 待确认黄 / 已执行绿 / 已拒绝灰 / 已撤销（失败）红 —— 与需求里的颜色一一对应 */
const AUDIT_STATUS_KIND: Record<string, 'default' | 'ok' | 'warn' | 'err'> = {
  pending: 'warn',
  applied: 'ok',
  discarded: 'default',
  failed: 'err',
  undone: 'err',
};

/**
 * 撤销入口。
 *
 * 后端 `POST /api/agent/actions/:id/undo` 已经接通（`domain/agent.ts` 的 `undoAction` +
 * `api/routes-agent.ts` 里那条路由）：按动作**提出时**留下的 `before_json` 快照，把目标恢复成
 * 改动前的值，并另存一条 `tool='undo_action'` 的审计记录。所以这里：
 *   · 撤销前二次确认，文案写明「将把『字段 X』恢复为改动前的值「旧值」，并把这次撤销记入审计」；
 *   · 失败时后端原样返回中文原因（400），由 useAction 的 toast 显示；
 *   · 成功后刷新列表 —— 这一行的状态会从「已执行」变成「已撤销」。
 */
const UNDO_ROUTE_READY = true;
const UNDO_HINT = '撤销入口未启用（前端开关 UNDO_ROUTE_READY = false）';

/** 只有这五种动作在提出时记了改动前快照，后端也只接受它们 —— 其余置灰，别让人白点一下 */
const UNDOABLE_TOOLS = new Set([
  'set_workbench_field',
  'set_archive_value',
  'mark_checklist',
  'note_artifact',
  'delete_workbench',
]);

/** 撤销接口的返回（`{ok:true, data:{...}}` 里的 data） */
interface AgentUndoReply {
  actionId: number;
  undone: boolean;
  tool: string;
  restored: { field: string; from: unknown; to: unknown };
  /** 后端给的中文说明，直接 toast 它 */
  detail: string;
  /** 这次撤销留下的审计记录 id（列表里刷新后能看到这条 undo_action） */
  logActionId: number;
}

/**
 * 撤销按钮能不能点：不能点就把原因写在 title 上（后端一定会拒的情形，不让人白点一下再看报错）。
 *
 * 注意别拿 `beforeSource !== 'before_json'` 当判据：审计接口解析 `{before, field}` 这种新快照时
 * 会先命中 `payload._before`（见 routes-agent.ts 的 auditBeforeValue），于是 `beforeSource` 是
 * `payload._before` —— 那不代表没有快照。反过来，`beforeSource === null` 才基本等于"这条没快照"。
 */
function undoBlocker(a: AuditActionItem): string | null {
  if (!UNDO_ROUTE_READY) return UNDO_HINT;
  if (a.status !== 'applied') return '只有「已执行」的动作能撤销';
  if (!UNDOABLE_TOOLS.has(a.tool)) {
    return `「${a.toolLabel}」这类动作在提出时不记改动前快照，无法安全撤销 —— 请按上面的改动摘要手工改回`;
  }
  // delete_workbench 的目标本来就是"已删除"的工作台，撤销正是把它从回收站恢复
  if (a.targetDeleted && a.tool !== 'delete_workbench') {
    return '目标对象已经进了回收站（已删除），撤销会被拒绝 —— 请先从回收站恢复它，再撤销这条动作';
  }
  if (a.tool !== 'delete_workbench' && a.beforeSource === null) {
    return a.snapshotColumnPresent
      ? '这条动作没有留改动前快照（迁移 015 之前的存量动作），撤销会被拒绝 —— 请手工改回'
      : '当前库里还没有 agent_action.before_json 列（迁移 015 未执行），撤销会被拒绝';
  }
  return null;
}

/** 二次确认里显示的"改动前的值"（太长就截断，别让 confirm 弹窗撑爆） */
function fmtUndoValue(v: unknown): string {
  if (v === null || v === undefined) return '（空）';
  if (typeof v === 'string') return v.trim() === '' ? '（空）' : v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  if (!s) return '（空）';
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** 二次确认里显示的"要恢复哪个字段" */
function undoFieldText(a: AuditActionItem): string {
  if (a.fieldLabel) return a.fieldLabel;
  if (a.field) return a.field;
  if (a.tool === 'mark_checklist') return '清单状态';
  if (a.tool === 'note_artifact') return '文件说明';
  if (a.tool === 'delete_workbench') return '整份工作';
  return '这条改动';
}

function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 追加时不重复：id 已经见过的丢掉（游标翻页本就该不重，这里再兜一层） */
function mergeById<T extends { id: number }>(prev: T[], next: T[]): T[] {
  const seen = new Set(prev.map((x) => x.id));
  return [...prev, ...next.filter((x) => !seen.has(x.id))];
}

function AuditPanel() {
  const toast = useToast();
  const { busy, run } = useAction();
  const workbenches = useWorkbenches();
  const [sub, setSub] = useState<'actions' | 'generations'>('actions');
  const [workbenchId, setWorkbenchId] = useState('');
  const [status, setStatus] = useState('');
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [actions, setActions] = useState<AuditActionItem[]>([]);
  const [gens, setGens] = useState<AuditGenerationItem[]>([]);
  const [cursor, setCursor] = useState<{ actions: number | null; generations: number | null }>({ actions: null, generations: null });
  const [hasMore, setHasMore] = useState<{ actions: boolean; generations: boolean }>({ actions: false, generations: false });
  const [notes, setNotes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /** 只认最后一次请求的响应：切筛选时在途的旧响应不能覆盖新结果 */
  const reqId = useRef(0);

  const refresh = (mode: 'reset' | 'more') =>
    run(async () => {
      const my = ++reqId.current;
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: '50' });
        if (workbenchId) params.set('workbenchId', workbenchId);
        if (mode === 'more') {
          const c = sub === 'actions' ? cursor.actions : cursor.generations;
          if (c === null) return;
          params.set('before', String(c));
        }
        if (sub === 'actions' && status) params.set('status', status);

        const s = await api.get<AuditSummary>('/api/audit/summary?days=7');
        const degraded = [...(s.degraded ?? [])];

        if (sub === 'actions') {
          const r = await api.get<AuditPage<AuditActionItem>>(`/api/audit/actions?${params.toString()}`);
          if (my !== reqId.current) return;
          degraded.push(...(r.degraded ?? []));
          setActions((prev) => (mode === 'reset' ? r.items : mergeById(prev, r.items)));
          setCursor((c) => ({ ...c, actions: r.nextBefore }));
          setHasMore((m) => ({ ...m, actions: r.hasMore }));
        } else {
          const r = await api.get<AuditPage<AuditGenerationItem>>(`/api/audit/generations?${params.toString()}`);
          if (my !== reqId.current) return;
          degraded.push(...(r.degraded ?? []));
          setGens((prev) => (mode === 'reset' ? r.items : mergeById(prev, r.items)));
          setCursor((c) => ({ ...c, generations: r.nextBefore }));
          setHasMore((m) => ({ ...m, generations: r.hasMore }));
        }
        setSummary(s);
        setNotes([...new Set(degraded)]);
      } finally {
        if (my === reqId.current) setLoading(false);
      }
    });

  /* 换标签页 / 换筛选 = 从第一页重新拉；游标和"还有更多"一起清掉 */
  useEffect(() => {
    setCursor({ actions: null, generations: null });
    setHasMore({ actions: false, generations: false });
    setActions([]);
    setGens([]);
    void refresh('reset');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, workbenchId, status]);

  const more = sub === 'actions' ? hasMore.actions : hasMore.generations;
  const cost = summary?.cost;
  const pending = summary?.actions.pending ?? 0;

  return (
    <>
      <div className="notice notice-info">
        <strong>这里回答「出了问题是哪一步就不对了」。</strong>
        每一条助手动作都留着：什么时候提的、要改哪个字段、<strong>从什么改成什么</strong>、谁点的确认；
        每一份出文书也留着：用的哪张模板、给哪份工作、落到哪个文件、多大。
        <br />
        <span className="small">
          记录只读 —— 这个页面不会修改任何数据。
          <strong>已删除的工作台 / 文件也照常显示</strong>（名字后面标「已删除」），审计以留痕为先，不隐藏。
          「已执行」的动作右边有「撤销」：按提出时留下的快照把目标恢复成改动前的值，并另存一条
          <span className="mono"> undo_action </span>
          记录（撤销谁、把哪个字段从什么改回了什么都能倒查）。<strong>没留快照的动作按钮是灰的</strong>
          （迁移 015 之前的存量动作、改设置/改模型这类），只能在界面上手工改回 —— 不会"假装撤销成功"。
        </span>
      </div>

      {/* ---------------- 顶部概览条 ---------------- */}
      <div className="grid grid-4">
        <div className="stat">
          <div className="k">近 7 天助手动作</div>
          <div className="v">{summary ? summary.actions.recent : '—'}</div>
          <div className="d">历史累计 {summary ? summary.actions.total : '—'} 条</div>
        </div>
        <div className="stat">
          <div className="k">待确认</div>
          <div className="v" style={{ color: pending > 0 ? 'var(--warn)' : undefined }}>
            {summary ? pending : '—'}
          </div>
          <div className="d">{pending > 0 ? '需要人点一下才生效' : '没有挂着的待确认动作'}</div>
        </div>
        <div className="stat">
          <div className="k">出文书</div>
          <div className="v">{summary ? summary.generations.recent : '—'}</div>
          <div className="d">近 7 天，累计 {summary ? summary.generations.total : '—'} 份</div>
        </div>
        <div className="stat">
          <div className="k">token 合计</div>
          <div className="v">{fmtTokens(summary?.tokens.total ?? null)}</div>
          <div className="d">
            {summary
              ? `${summary.tokens.calls} 次调用 · ${cost?.available ? `≈ ${cost.currency === 'CNY' ? '¥' : ''}${cost.amount}` : '未配置计价，只报 token'}`
              : '—'}
          </div>
        </div>
      </div>

      {/* 按状态 / 按类型分布：一串小标签，比塞进表格里更好扫 */}
      {summary && (summary.actions.byStatus.length > 0 || summary.actions.byTool.length > 0) && (
        <div className="row row-wrap" style={{ gap: 6 }}>
          <span className="muted small">近 7 天动作分布：</span>
          {summary.actions.byStatus.map((s) => (
            <Tag key={s.status} kind={AUDIT_STATUS_KIND[s.status] ?? 'default'}>
              {s.label} {s.count}
            </Tag>
          ))}
          {summary.actions.byTool.slice(0, 6).map((t) => (
            <Tag key={t.tool} kind="info">
              {t.label} {t.count}
            </Tag>
          ))}
          <span className="muted small">
            · 测试调用 {summary.tokens.testCalls} 次 / {summary.tokens.testTokens} tokens（{summary.tokens.scope}）
          </span>
        </div>
      )}

      {notes.length > 0 && (
        <div className="notice notice-warn">
          <strong>降级说明（表结构或参数所限，已按最接近的口径显示）：</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {notes.map((n) => (
              <li key={n} className="small">
                {n}
              </li>
            ))}
          </ul>
        </div>
      )}

      <Card
        title="记录"
        extra={
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className={`btn btn-sm${sub === 'actions' ? ' btn-primary' : ''}`} onClick={() => setSub('actions')}>
              助手动作
            </button>
            <button className={`btn btn-sm${sub === 'generations' ? ' btn-primary' : ''}`} onClick={() => setSub('generations')}>
              出文书
            </button>
            <Select
              value={workbenchId}
              onChange={setWorkbenchId}
              placeholder="全部工作台"
              options={(workbenches.data?.items ?? []).map((w) => ({ value: String(w.id), label: w.name }))}
            />
            {sub === 'actions' && (
              <Select
                value={status}
                onChange={setStatus}
                placeholder="全部状态"
                options={[
                  { value: 'pending', label: '待确认' },
                  { value: 'applied', label: '已执行' },
                  { value: 'discarded', label: '已拒绝' },
                  { value: 'failed', label: '失败' },
                  { value: 'undone', label: '已撤销' },
                ]}
              />
            )}
            <Button size="sm" disabled={busy} onClick={() => void refresh('reset')}>
              刷新
            </Button>
          </div>
        }
      >
        {loading && !actions.length && !gens.length ? (
          <Loading />
        ) : sub === 'actions' ? (
          actions.length === 0 ? (
            <Empty
              text={
                workbenchId || status
                  ? '当前筛选条件下还没有记录。把「工作台 / 状态」清成全部再看看。'
                  : '还没有记录。在「对话」里交代一件事、助手提议过动作之后，这里就会出现每一条的来龙去脉。'
              }
            />
          ) : (
            <table className="table mt12">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>时间</th>
                  <th style={{ width: 130 }}>类型</th>
                  <th style={{ width: 210 }}>目标</th>
                  <th>改动摘要</th>
                  <th style={{ width: 84 }}>状态</th>
                  <th style={{ width: 72 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.id}>
                    <td className="small muted nowrap">
                      {fmtTime(a.createdAt)}
                      {a.appliedAt && <div className="muted">执行 {fmtTime(a.appliedAt)}</div>}
                    </td>
                    <td className="small">
                      {a.toolLabel}
                      <div className="mono muted">{a.tool}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {a.sourceLabel}
                        {a.confirmedBy ? ` · ${a.confirmedBy}` : ''}
                      </div>
                    </td>
                    <td className="small">
                      {a.target}
                      {a.destructive && (
                        <>
                          {' '}
                          <Tag kind="err">破坏性</Tag>
                        </>
                      )}
                      {a.targetDeleted && (
                        <>
                          {' '}
                          <Tag kind="warn" >目标已删除</Tag>
                        </>
                      )}
                    </td>
                    <td className="small">
                      {a.change}
                      {!a.beforeKnown && a.snapshotNote && (
                        <div className="muted" style={{ fontSize: 11.5 }} title={a.snapshotNote}>
                          （{a.snapshotNote}）
                        </div>
                      )}
                      {a.beforeKnown && a.beforeSource && a.beforeSource !== 'before_json' && (
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          改动前值来自 {a.beforeSource === 'payload._before' ? '动作参数里的快照' : '执行结果里的快照'}（库里还没有 before_json 快照列）
                        </div>
                      )}
                      {a.error && <div style={{ color: 'var(--err)' }}>失败：{a.error}</div>}
                    </td>
                    <td>
                      <Tag kind={AUDIT_STATUS_KIND[a.status] ?? 'default'}>{a.statusLabel}</Tag>
                    </td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      {a.status === 'applied' ? (
                        <Button
                          size="sm"
                          disabled={busy || undoBlocker(a) !== null}
                          title={undoBlocker(a) ?? '撤销这条动作：按改动前的快照恢复原值，并记入审计'}
                          onClick={() =>
                            run(async () => {
                              /**
                               * 二次确认：写明把哪个字段恢复成什么值、这次撤销会进审计。
                               * 文案里的"旧值"用的是审计接口已经解析好的 `before`；这条没留快照时
                               * 按钮本来就是灰的，这里只是多一层说明。
                               */
                              const beforeText = a.beforeKnown
                                ? fmtUndoValue(a.before)
                                : '（这条没留改动前快照，后端会拒绝）';
                              const ok = window.confirm(
                                a.tool === 'delete_workbench'
                                  ? `将从回收站恢复${a.target}，并把这次撤销记入审计。\n\n只撤销这一条删除动作。确定撤销吗？`
                                  : `将把『${undoFieldText(a)}』恢复为改动前的值「${beforeText}」，并把这次撤销记入审计。\n\n` +
                                      '只撤销这一条动作；如果它之后还有别的改动动过同一个字段，后端会拒绝。确定撤销吗？',
                              );
                              if (!ok) return;
                              const r = await api.post<AgentUndoReply>(`/api/agent/actions/${a.id}/undo`, {});
                              toast(r?.detail || '已撤销，并把这次撤销记入了审计', 'ok');
                              await refresh('reset');
                            })
                          }
                        >
                          撤销
                        </Button>
                      ) : (
                        <span className="muted small">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : gens.length === 0 ? (
          <Empty
            text={
              workbenchId
                ? '这个工作台还没有出过文书。换个工作台或清掉筛选看看。'
                : '还没有记录。出过一份文书（`POST /api/generate/save`）之后，这里会记下模板、落盘位置和大小。'
            }
          />
        ) : (
          <table className="table mt12">
            <thead>
              <tr>
                <th style={{ width: 130 }}>时间</th>
                <th style={{ width: 200 }}>模板</th>
                <th style={{ width: 170 }}>工作台</th>
                <th style={{ width: 110 }}>是否落盘</th>
                <th>文件</th>
                <th style={{ width: 110 }}>token</th>
              </tr>
            </thead>
            <tbody>
              {gens.map((g) => (
                <tr key={g.id}>
                  <td className="small muted nowrap">{fmtTime(g.createdAt)}</td>
                  <td className="small">
                    {g.templateName ?? (g.templateId ? `模板 #${g.templateId}` : '（模板已删除）')}
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {g.templateCategory ?? '—'} · {g.modeLabel}
                    </div>
                  </td>
                  <td className="small">
                    {g.workbenchName ?? (g.workbenchId ? `#${g.workbenchId}（名称未知）` : '未绑定工作台')}
                    {g.workbenchDeleted && (
                      <>
                        {' '}
                        <Tag kind="warn">已删除</Tag>
                      </>
                    )}
                    {g.workbenchCode && <div className="muted mono">{g.workbenchCode}</div>}
                  </td>
                  <td>
                    {g.status !== 'ok' ? (
                      <Tag kind="err">失败</Tag>
                    ) : g.onDisk === true ? (
                      <Tag kind="ok">已落盘</Tag>
                    ) : g.onDisk === false ? (
                      <Tag kind="warn">文件不在了</Tag>
                    ) : (
                      <Tag kind="default">无法判定</Tag>
                    )}
                    {g.artifactDeleted && (
                      <div style={{ marginTop: 4 }}>
                        <Tag kind="warn">文件已进回收站</Tag>
                      </div>
                    )}
                  </td>
                  <td className="small">
                    {g.fileName ? (
                      <>
                        {g.fileName}
                        <div className="muted mono" style={{ fontSize: 11.5 }}>
                          {fmtSize(g.sizeBytes)}
                          {g.fileRootKind === 'external' ? ' · 外部资料目录' : ''}
                          {g.filePath ? ` · ${g.filePath}` : ''}
                        </div>
                      </>
                    ) : (
                      <span className="muted">{g.message ?? '—'}</span>
                    )}
                  </td>
                  <td className="small">
                    {g.tokensApprox !== null ? (
                      <span title={g.tokensSource ?? ''}>≈{g.tokensApprox}</span>
                    ) : (
                      <span className="muted" title="generation_log 没有 token 列，且找不到对应的写作调用记录">
                        —
                      </span>
                    )}
                    <div className="muted" style={{ fontSize: 11.5 }}>
                      {g.variableCount} 个变量
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {more && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
            <Button disabled={busy} onClick={() => void refresh('more')}>
              {busy ? '加载中…' : '加载更多'}
            </Button>
          </div>
        )}
      </Card>

      {cost && (
        <Card title="token 与费用" collapsible>
          <div className="kv">
            <dt>统计窗口</dt>
            <dd>
              {summary?.windowLabel}　<span className="muted">{summary?.tokens.scope}</span>
            </dd>
            <dt>token 合计</dt>
            <dd>
              输入 {summary?.tokens.prompt ?? 0} + 输出 {summary?.tokens.output ?? 0} = <strong>{summary?.tokens.total ?? 0}</strong>
              （{summary?.tokens.calls ?? 0} 次调用；历史累计 {summary?.tokens.allTimeTokens ?? 0} tokens /{' '}
              {summary?.tokens.allTimeCalls ?? 0} 次）
            </dd>
            <dt>费用估算</dt>
            <dd>
              {cost.available ? (
                <>
                  ≈ {cost.currency === 'CNY' ? '¥' : ''}
                  {cost.amount}　<span className="muted small">{cost.basis}</span>
                </>
              ) : (
                <span className="muted">未估算：{cost.reason}</span>
              )}
            </dd>
            <dt>按用途</dt>
            <dd>
              {(summary?.tokens.byPurpose ?? []).length === 0
                ? '—'
                : (summary?.tokens.byPurpose ?? []).map((p) => (
                    <div key={p.purpose} className="small">
                      {p.purpose}：{p.tokens} tokens（{p.calls} 次）
                    </div>
                  ))}
            </dd>
          </div>
        </Card>
      )}
    </>
  );
}

/* ============================== 小工具 ============================== */

function useWorkbenches() {
  const [data, setData] = useState<{ items: Workbench[] } | null>(null);
  useEffect(() => {
    api
      .get<{ items: Workbench[] }>('/api/workbenches')
      .then(setData)
      .catch(() => setData(null));
  }, []);
  return { data };
}
