import {useWorkbenchCollection} from '../components/useWorkbenchCollection';
import {useWorkflowInbox, type Inbox} from '../components/WorkflowPanels';
import {useEffect, useRef, useState} from 'react';
import {api, useApi, type Workbench, type Artifact} from '../api';
import {Button, Card, Empty, Input, Loading, Modal, Tag, fmtTime, useDebounced, useToast} from '../ui';
import type {RouteKey} from '../App';
import {FilePreviewButton} from '../components/FilePreview';
import {LoadError, NavIcon} from '../components/DesignSystem';

type HomeAction = {key:string; workId?:number; name:string; detail:string; status:string; tone:'err'|'warn'|'info'; icon:string; action:string; href?:string; todoId?:number; due?:string};
function inboxActions(data:Inbox|undefined):HomeAction[] {
  if (!data) return [];
  const actions:HomeAction[] = [
    ...data.periods.map(p=>({key:`period-${p.id}`,workId:p.workbench_id,name:p.name,detail:`${p.report_period} · ${p.missing[0]||p.nextAction}`,status:p.overdue?'已逾期':/核对|确认|复核/.test(p.nextAction||'')?'待核对':'待处理',tone:p.overdue?'err' as const:'warn' as const,icon:/工时/.test(p.name)?'person':'files',action:/核对.*草稿/.test(p.nextAction||'')?'核对草稿':/核对/.test(p.nextAction||'')?'核对材料':'继续办理',href:`#/workbench?id=${p.workbench_id}&periodId=${p.id}`,due:p.due_date})),
    ...data.other.map((p,i)=>({key:`other-${i}`,workId:p.workbenchId,name:p.workbenchName,detail:`${p.title} · ${p.reason}`,status:/缺|材料/.test(p.reason)?'待补材料':'待处理',tone:'warn' as const,icon:'wrench',action:'查看清单',href:`#${p.href}`})),
    ...data.todos.map(p=>({key:`todo-${p.id}`,name:p.title,detail:[p.due_date&&`截止 ${p.due_date}`,p.note].filter(Boolean).join(' · ')||'未设置截止时间',status:'待处理',tone:'info' as const,icon:'records',action:'完成',todoId:p.id,due:p.due_date||undefined})),
    ...data.timesheets.map(p=>({key:`hours-${p.id}`,workId:p.workbench_id??undefined,name:'部门月度工时',detail:`${p.month} · ${p.exceptions?`${p.exceptions} 项异常`:'待人工复核定稿'}`,status:'待核对',tone:'warn' as const,icon:'person',action:'继续办理',href:`#/workbench?task=timesheets&runId=${p.id}${p.workbench_id?`&id=${p.workbench_id}`:''}${p.period_id?`&periodId=${p.period_id}`:''}`})),
  ];
  return actions.sort((a,b)=>(a.tone==='err'?0:1)-(b.tone==='err'?0:1)||(a.due||'9999').localeCompare(b.due||'9999')||(a.status==='待核对'?0:1)-(b.status==='待核对'?0:1));
}
function HomeIcon({name}:{name:string}) {
  if(name==='bell-filled')return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 18h16l-2-4V9a6 6 0 0 0-12 0v5z M9 20a3 3 0 0 0 6 0z"/></svg>;
  if(name==='clock-filled')return <svg viewBox="0 0 24 24" aria-hidden="true"><circle fill="currentColor" cx="12" cy="12" r="11"/><path d="M12 5v7l5 3" fill="none" stroke="white" strokeWidth="1.6" strokeLinecap="round"/></svg>;
  if(name==='chart-filled')return <svg viewBox="0 0 24 24" aria-hidden="true"><rect fill="currentColor" opacity=".55" x="2" y="12" width="5" height="11" rx="1.5"/><rect fill="currentColor" opacity=".8" x="10" y="6" width="5" height="17" rx="1.5"/><rect fill="currentColor" x="18" y="1" width="5" height="22" rx="1.5"/></svg>;
  if(name==='files-filled')return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 1h10l6 6v16H4z"/><path d="M14 1v6h6" fill="#ffffff66"/><path d="M8 12h8M8 16h8" stroke="white" strokeWidth="1.6"/></svg>;
  const paths:Record<string,string>={bell:'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 21h4',clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v6l4 2',chart:'M4 13h3v8H4z M11 8h3v13h-3z M18 3h3v18h-3z',person:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-2a8 8 0 0 1 16 0v2',search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',monitor:'M3 4h18v13H3z M12 17v4M8 21h8',wrench:'M15 3a6 6 0 0 0-7 8L2 17a3 3 0 0 0 4 4l6-6a6 6 0 0 0 8-7l-4 4-4-4z',cloud:'M6 19a5 5 0 0 1-1-10 7 7 0 0 1 13-2 6 6 0 0 1 0 12z',files:'M5 2h10l4 4v16H5z M14 2v5h5M8 11h8M8 15h8M8 18h5'};
  return paths[name]?<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>:<NavIcon name={name}/>;
}
function HomeTitle({icon,children}:{icon:string;children:React.ReactNode}) {return <span className={`home-card-title home-title-${icon}`}><HomeIcon name={icon+'-filled'}/>{children}</span>;}
function HomeInboxSort({value,onChange,refresh,disabled}:{value:string;onChange:(value:string)=>void;refresh:()=>void;disabled:boolean}) {
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{const close=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node)&&ref.current)ref.current.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
  return <details ref={ref} className="home-sort" onKeyDown={e=>{if(e.key==='Escape'&&ref.current){ref.current.open=false;ref.current.querySelector('summary')?.focus();}}}><summary>{value==='urgent'?'按紧急程度排序':'按工作名称排序'}<span aria-hidden="true">⌄</span></summary><div className="home-sort-menu">{[{value:'urgent',label:'按紧急程度排序'},{value:'name',label:'按工作名称排序'}].map(option=><button key={option.value} aria-pressed={value===option.value} onClick={()=>{onChange(option.value);if(ref.current)ref.current.open=false;}}>{option.label}</button>)}<button disabled={disabled} onClick={()=>{refresh();if(ref.current)ref.current.open=false;}}>刷新待办</button></div></details>;
}

export default function DashboardPage({go}:{go:(k:RouteKey,p?:Record<string,string>)=>void}) {
  const all=useWorkbenchCollection(), inbox=useWorkflowInbox();
  const files=useApi<{items:Artifact[]}>('/api/artifacts?kind=generated&limit=2');
  const [search,setSearch]=useState(false),[page,setPage]=useState(0),[busy,setBusy]=useState(false),[actionError,setActionError]=useState(''),[sort,setSort]=useState('urgent');
  const items=all.data?.items??[], active=items.filter(w=>!['done','archived'].includes(w.status)), actions=inboxActions(inbox.data);
  if(sort==='name')actions.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
  const pendingIds=new Set(actions.map(a=>a.workId).filter(Boolean));
  const recent=[...active].filter(w=>!pendingIds.has(w.id)).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).slice(0,3);
  const reviewIds=new Set(actions.filter(a=>a.workId&&(a.status==='待核对'||/核对|确认|复核/.test(a.detail))).map(a=>a.workId));
  const reviewCount=active.filter(w=>reviewIds.has(w.id)).length;
  const pageCount=Math.max(1,Math.ceil(actions.length/3)), safePage=Math.min(page,pageCount-1);
  const now=new Date(), month=`${now.getFullYear()}年${now.getMonth()+1}月`;
  const refresh=async()=>{setBusy(true);try{await inbox.refresh();}finally{setBusy(false);}};
  const complete=async(id:number)=>{setBusy(true);setActionError('');try{await api.put(`/api/quick-todos/${id}`,{status:'done'});inbox.reload();}catch(e){setActionError((e as Error).message);}finally{setBusy(false);}};
  return <div className="home-page">
    <header className="home-header">
      <div><h2>工作台</h2><p>{month} · {all.error?'工作数量读取失败':all.loading?'正在读取工作':`${active.length}项在办工作`} · {inbox.error?'待办读取失败':inbox.loading?'正在读取待办':`${actions.length}项待处理`}</p></div>
      <div className="home-header-actions"><button className="home-search" onClick={()=>setSearch(true)}><HomeIcon name="search"/><span>搜索工作、成果、模板</span></button><button className="btn home-bell" aria-label="查看待处理事项" onClick={()=>{document.getElementById('home-inbox')?.scrollIntoView({behavior:'smooth',block:'start'});document.getElementById('home-inbox')?.focus();}}><HomeIcon name="bell"/></button><Button kind="primary" onClick={()=>go('workbench',{create:'1'})}>＋ 新建工作</Button></div>
    </header>
    {search&&<Modal open title="搜索工作、成果、模板" wide onClose={()=>setSearch(false)}><GlobalSearch go={go}/></Modal>}
    <div className="dashboard-grid">
      <div className="dashboard-stack">
        <div id="home-inbox" tabIndex={-1}>
          <Card className="home-inbox" title={<HomeTitle icon="bell">待我处理</HomeTitle>} extra={<HomeInboxSort value={sort} onChange={value=>{setSort(value);setPage(0);}} disabled={busy||inbox.loading} refresh={()=>void refresh()}/> }>
            {inbox.syncError&&<div className="notice notice-err" role="alert">期次同步失败：{inbox.syncError}。当前待办可能不完整，请刷新重试。</div>}
            {actionError&&<div className="notice notice-err" role="alert">{actionError}</div>}
            {inbox.error?<LoadError error={inbox.error} retry={inbox.reload}/>:!inbox.data&&inbox.loading?<Loading/>:!actions.length?<Empty text="当前没有待办理事项。"/>:actions.slice(safePage*3,safePage*3+3).map(a=><div className="home-action-row" key={a.key}><span className={`home-symbol tone-${a.tone}`}><HomeIcon name={a.icon}/></span><div className="home-row-text"><strong title={a.name}>{a.name}</strong><p title={a.detail}>{a.detail}</p></div><Tag kind={a.tone}>{a.status}</Tag>{a.href?<a className="btn btn-default btn-sm" href={a.href}>{a.action}</a>:<Button size="sm" disabled={busy} onClick={()=>void complete(a.todoId!)}>{a.action}</Button>}</div>)}
            {pageCount>1&&<div className="home-pagination"><span>共 {actions.length} 项 · {safePage+1} / {pageCount}</span><Button size="sm" disabled={!safePage} onClick={()=>setPage(safePage-1)}>上一页</Button><Button size="sm" disabled={safePage===pageCount-1} onClick={()=>setPage(safePage+1)}>下一页</Button></div>}
            {inbox.data?.otherTruncated&&<p className="small muted">其他待办较多，请进入工作查看完整清单。</p>}
          </Card>
        </div>
        <Card className="home-continue" title={<HomeTitle icon="clock">继续办理</HomeTitle>} extra={<Button kind="ghost" size="sm" onClick={()=>go('workbench')}>全部工作 →</Button>}>
          {all.error?<LoadError error={all.error} retry={all.reload}/>:all.loading?<Loading/>:!recent.length?<Empty text={active.length?'当前在办工作已列在待我处理中。':'还没有在办工作，从新建工作开始。'} action={<Button onClick={()=>go('workbench',active.length?{}:{create:'1'})}>{active.length?'查看全部工作':'新建工作'}</Button>}/>:recent.map((w,i)=><div className="home-action-row" key={w.id}><span className={`home-symbol tone-${['blue','purple','green'][i]}`}><HomeIcon name={w.work_type_mode==='process'?(i===1?'cloud':'monitor'):'files'}/></span><div className="home-row-text"><strong title={w.name}>{w.name}</strong><p>{w.work_type_name} · 更新 {fmtTime(w.updated_at)}</p></div><Button size="sm" onClick={()=>go('workbench',{id:String(w.id)})}>继续办理</Button></div>)}
        </Card>
      </div>
      <div className="dashboard-stack">
        <Card className="home-overview" title={<HomeTitle icon="chart">工作概览</HomeTitle>}>
          {all.error?<LoadError error={all.error} retry={all.reload}/>:all.loading?<Loading/>:<div className="summary-grid"><div>在办<strong>{active.length}</strong></div><div title="在办工作中有明确待核对、待确认或待复核事项的工作数；属于在办子集">待核对<strong>{inbox.error||inbox.syncError?'—':inbox.loading?'…':reviewCount}</strong></div><div>已结束<strong>{items.filter(w=>w.status==='done').length}</strong></div></div>}
        </Card>
        <WorkCalendar items={items} go={go}/>
        <Card className={`home-files${!files.loading&&!files.error&&!files.data?.items.length?' home-files-empty':''}`} title={<HomeTitle icon="files">最近成果</HomeTitle>}>
          {files.error?<LoadError error={files.error} retry={files.reload}/>:files.loading?<Loading/>:!files.data?.items.length?<Empty text="尚无生成成果，进入工作编辑草稿后生成。"/>:files.data.items.map(a=><div className="home-file-row" key={a.id}><span className={`home-file-icon ${/\.xlsx?$/i.test(a.file_name)?'excel':''}`}>{/\.xlsx?$/i.test(a.file_name)?'X':/\.docx?$/i.test(a.file_name)?'W':'文'}</span><div className="home-row-text"><strong title={a.title||a.file_name}>{a.title||a.file_name}</strong><p>{fmtTime(a.created_at)}</p></div><Tag kind={a.is_final?'ok':'default'}>{a.is_final==null?'未标注':a.is_final?'已定稿':'草稿'}</Tag><FilePreviewButton artifact={a}/></div>)}
          <p className="home-file-note">ⓘ 文件生成与业务完成分别记录。</p>
        </Card>
        <button className="home-record-link" onClick={()=>go('records')}><HomeIcon name="records"/><strong>随手记工作</strong><span>›</span></button>
      </div>
    </div>
  </div>;
}

function WorkCalendar({items,go}:{items:Workbench[];go:(k:RouteKey,p?:Record<string,string>)=>void}) {
  const today=new Date(),[month,setMonth]=useState(()=>new Date(today.getFullYear(),today.getMonth(),1)),[day,setDay]=useState(today.getDate());
  const key=month.getFullYear()+'-'+String(month.getMonth()+1).padStart(2,'0'),date=key+'-'+String(day).padStart(2,'0');
  const due=items.filter(w=>w.period_due?.slice(0,10)===date||w.plan_end_date?.slice(0,10)===date);
  const first=(new Date(month.getFullYear(),month.getMonth(),1).getDay()+6)%7,days=new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
  const cells=Math.ceil((first+days)/7)*7;
  const change=(n:number)=>{setMonth(new Date(month.getFullYear(),month.getMonth()+n,1));setDay(1);};
  return <Card className="home-calendar" title={<span>日程 <button className="home-month" aria-label="今天" title="返回本月，定位今天" onClick={()=>{setMonth(new Date(today.getFullYear(),today.getMonth(),1));setDay(today.getDate());}}>{month.getFullYear()}年{month.getMonth()+1}月</button></span>} extra={<><button className="home-calendar-nav" aria-label="上个月" onClick={()=>change(-1)}>‹</button><button className="home-calendar-nav" aria-label="下个月" onClick={()=>change(1)}>›</button></>}>
    <div className="calendar-grid">{['一','二','三','四','五','六','日'].map(d=><span key={d}>{d}</span>)}{Array.from({length:cells},(_,i)=>{const d=i-first+1,dt=key+'-'+String(d).padStart(2,'0'),inMonth=d>0&&d<=days;return inMonth?<button key={i} aria-label={dt} aria-pressed={d===day} className={d===day?'selected':items.some(w=>w.period_due?.startsWith(dt)||w.plan_end_date?.startsWith(dt))?'has-event':''} onClick={()=>setDay(d)}>{d}</button>:<span className="calendar-outside" key={i}>{new Date(month.getFullYear(),month.getMonth(),d).getDate()}</span>;})}</div>
    <div className="calendar-events">{due.length?due.map(w=><button key={w.id} onClick={()=>go('workbench',{id:String(w.id)})}>{month.getMonth()+1}月{day}日 · {w.name}<span className="muted">（截止 / 计划结束）</span></button>):<span>{month.getMonth()+1}月{day}日 · 暂无已登记的安排</span>}</div>
  </Card>;
}


/* ============================== 全局搜索 ============================== */

/**
 * 这几个类型**就地声明**，不走 `api.ts` —— 那个文件是公共契约，正在被别人改，
 * 为一个新卡片往里加类型不划算。字段与 `core/search-all.ts` 的 `SearchHit` 一一对应。
 */
interface GsHit {
  kind: 'workbench' | 'artifact' | 'template' | 'kb' | 'position' | string;
  id: number;
  title: string;
  subtitle: string;
  /** 命中词已用 【】 标好的原文片段（不是 HTML） */
  snippet: string;
  score: number;
  route: string;
}

interface GsGroup {
  kind: string;
  label: string;
  count: number;
  hits: GsHit[];
}

interface GsResult {
  query: string;
  total: number;
  groups: GsGroup[];
  elapsedMs: number;
  kinds?: { kind: string; label: string }[];
  truncated?: boolean;
}

interface GsSuggest {
  kind: string;
  label: string;
  id: number;
  title: string;
  subtitle: string;
  route: string;
}

/** 默认勾选的范围（与服务端 SEARCH_KINDS 同序） */
const GS_KINDS: { kind: string; label: string }[] = [
  { kind: 'workbench', label: '工作台' },
  { kind: 'artifact', label: '文件' },
  { kind: 'template', label: '模板' },
  { kind: 'kb', label: '制度' },
  { kind: 'position', label: '阶段' },
];

/** 最少输入几个字才去请求（免得每敲一个字都打一次库） */
const GS_MIN = 2;
/** 停顿时长：输入停下来 300ms 后才发请求 */
const GS_DEBOUNCE = 300;

/**
 * 把服务端给的 `route` 拆成 `go()` 需要的「页面 + 参数」。
 *
 * `route` 形如 `/workbench?id=39&tab=flow`、`/files?artifact=12`、`/knowledge`。
 * 前端路由就是 hash（`#/workbench?id=39`），所以这里直接解析，不需要额外字段。
 * 认不出的路径返回 null，调用方退化成"只显示路径"。
 */
function gsParseRoute(path: string): { key: RouteKey; params: Record<string, string> } | null {
  const m = /^\/([a-z-]+)(?:\?(.*))?$/.exec(path.trim());
  if (!m) return null;
  const key = m[1] as RouteKey;
  if (!['dashboard', 'workbench', 'process', 'files', 'knowledge', 'agent', 'settings'].includes(key)) return null;
  const params: Record<string, string> = {};
  new URLSearchParams(m[2] ?? '').forEach((v, k) => {
    params[k] = v;
  });
  return { key, params };
}

/**
 * 把带 【】 标记的片段渲染出来。
 * **不用 dangerouslySetInnerHTML**：按标记切开，命中词交给 `<mark className="hl">`（样式复用 styles.css 里已有的 .hl）。
 */
function GsText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(【[^】]*】)/).map((part, i) =>
        part.startsWith('【') && part.endsWith('】') && part.length > 2 ? (
          <mark className="hl" key={i}>
            {part.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function GlobalSearch({ go }: { go: (k: RouteKey, p?: Record<string, string>) => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [kinds, setKinds] = useState<string[]>(GS_KINDS.map((k) => k.kind));
  const [result, setResult] = useState<GsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sug, setSug] = useState<GsSuggest[]>([]);
  /** 回车会立刻搜一次（哪怕只有 1 个字） */
  const [force, setForce] = useState(0);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);

  const settled = useDebounced(text.trim(), GS_DEBOUNCE);
  const enough = settled.length >= GS_MIN || (force > 0 && settled.length > 0);
  const nothingChecked = kinds.length === 0;

  // 主搜索：输入停下 300ms、且满 2 个字（或按了回车）才请求
  useEffect(() => {
    const mine = ++seq.current;
    if (!enough || nothingChecked) {
      setLoading(false);setResult(null);setError(null);
      if (!settled && !force) {
        setResult(null);
        setError(null);
      }
      return;
    }
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams({ q: settled, kinds: kinds.join(','), limit: '8' });
    api
      .get<GsResult>(`/api/search-all?${sp.toString()}`)
      .then((d) => {
        if (mine === seq.current) setResult(d);
      })
      .catch((e: { message?: string }) => {
        if (mine === seq.current) {
          setResult(null);
          setError(e?.message ?? '搜索失败');
        }
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [settled, enough, force, kinds, nothingChecked]);

  // 联想：与主搜索同一套防抖，只补"用户还在挑词"的那一段
  useEffect(() => {
    if (settled.length < GS_MIN) {
      setSug([]);
      return;
    }
    let alive = true;
    api
      .get<{ items: GsSuggest[] }>(`/api/search-all/suggest?q=${encodeURIComponent(settled)}`)
      .then((d) => {
        if (alive) setSug(d.items ?? []);
      })
      .catch(() => {
        if (alive) setSug([]);
      });
    return () => {
      alive = false;
    };
  }, [settled]);

  const toggleKind = (k: string) => {
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  };

  const hitAll = result?.groups.reduce((n, g) => n + g.hits.length, 0) ?? 0;
  const showHits = Boolean(result) && hitAll > 0;
  const showEmpty = Boolean(result) && !loading && hitAll === 0 && !nothingChecked;

  const openHit = (route: string) => {
    const parsed = gsParseRoute(route);
    if (!parsed) {
      toast(`这一条没给出可跳转的页面（${route}）`, 'info');
      return;
    }
    setOpen(false);
    go(parsed.key, parsed.params);
  };

  return (
    <Card
      title="⌕ 全局搜索"
      extra={
        result ? (
          <span className="muted small">
            命中 {result.total} 条 · {result.elapsedMs} ms
            {result.truncated ? '　（关键词过长，已截断前 200 字）' : ''}
          </span>
        ) : (
          <span className="muted small">一个框搜：工作台 / 文件 / 模板 / 制度 / 阶段</span>
        )
      }
    >
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <div className="global-search-input">
          <Input
            value={text}
            onChange={(v) => {
              setText(v);
              setForce(0);
              setOpen(true);
            }}
            onEnter={() => {
              setForce((f) => f + 1);
              setOpen(false);
            }}
            placeholder="搜工作台名称/编号、文件正文、模板名、制度内容、阶段…（至少 2 个字，回车立刻搜）"
          />
          {/* 联想下拉：只在输入过程中、且还没出结果时提示，避免和下面的结果打架 */}
          {open && sug.length > 0 && text.trim().length >= GS_MIN && !showHits && (
            <div
              style={{
                position: 'absolute',
                zIndex: 20,
                left: 0,
                right: 0,
                top: '100%',
                marginTop: 4,
                background: '#fff',
                border: '1px solid var(--line-strong)',
                borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,.10)',
                maxHeight: 280,
                overflowY: 'auto',
              }}
            >
              {sug.map((s) => (
                <div
                  key={`${s.kind}#${s.id}`}
                  className="clickable"
                  style={{ padding: '7px 12px', borderBottom: '1px solid var(--line)' }}
                  onClick={() => openHit(s.route)}
                >
                  <span className="tag" style={{ marginRight: 6 }}>
                    {s.label}
                  </span>
                  <strong style={{ fontSize: 13.5 }}>{s.title}</strong>
                  {s.subtitle && <span className="muted small">　{s.subtitle}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', paddingTop: 8 }}>
          {GS_KINDS.map((k) => (
            <label key={k.kind} className="row clickable" style={{ gap: 4, fontSize: 12.5 }}>
              <input type="checkbox" checked={kinds.includes(k.kind)} onChange={() => toggleKind(k.kind)} />
              {k.label}
            </label>
          ))}
        </div>
      </div>

      <div className="small muted" style={{ marginTop: 8 }}>
        {nothingChecked
          ? '至少勾一个搜索范围。'
          : loading
            ? '搜索中…'
            : showHits
              ? `在 ${kinds.length} 个范围里搜「${result?.query}」`
              : text.trim().length === 0
                ? `输入 ${GS_MIN} 个字开始搜索（停 ${GS_DEBOUNCE}ms 自动搜）。`
                : text.trim().length < GS_MIN
                  ? `再输 ${GS_MIN - text.trim().length} 个字就开始搜。`
                  : '正在等待输入停顿…'}
      </div>

      {error && <div className="notice notice-err mt12">搜索失败：{error}</div>}

      {loading && !result && (
        <div className="mt12">
          <Loading text="搜索中…" />
        </div>
      )}

      {showEmpty && (
        <div className="mt12">
          <Empty
            text={`没找到「${result?.query}」，试试更短的关键词${kinds.length < GS_KINDS.length ? '，或把搜索范围都勾上' : ''}。`}
          />
        </div>
      )}

      {showHits && (
        <div className="col mt12" style={{ gap: 12 }}>
          {result?.groups
            .filter((g) => g.hits.length > 0)
            .map((g) => (
              <div key={g.kind}>
                <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 13.5 }}>{g.label}</strong>
                  <span className="tag">{g.count}</span>
                </div>
                <div className="col" style={{ gap: 4, marginTop: 4 }}>
                  {g.hits.map((h) => (
                    <div
                      key={`${h.kind}#${h.id}`}
                      className="clickable"
                      title={`点击打开：${h.route}`}
                      style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 8 }}
                      onClick={() => openHit(h.route)}
                    >
                      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                        <strong style={{ fontSize: 13.5 }}>
                          <GsText text={h.title} />
                        </strong>
                        <span className="muted small ellipsis">{h.subtitle}</span>
                        <span className="muted small" style={{ marginLeft: 'auto' }}>
                          {h.route}
                        </span>
                      </div>
                      <div className="small muted" style={{ marginTop: 2 }}>
                        <GsText text={h.snippet} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
