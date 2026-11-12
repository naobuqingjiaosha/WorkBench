import {RecordComposer} from './WorkRecords';
import {useWorkbenchCollection} from '../components/useWorkbenchCollection';
import {useWorkflowInbox, type Inbox} from '../components/WorkflowPanels';
import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {api, useApi, type Workbench, type Artifact} from '../api';
import {Button, Card, Empty, Input, Loading, Modal, Tag, STATUS_TEXT, statusKind, fmtTime, useDebounced, useToast} from '../ui';
import type {RouteKey} from '../App';
import {FilePreview, FilePreviewButton} from '../components/FilePreview';
import {TemplatePreview} from '../components/TemplatePreview';
import {LoadError, NavIcon} from '../components/DesignSystem';

// CSS pixels follow window size, display scaling and browser zoom.
const homeDensities = [
  {query:'(min-width:1000px) and (max-height:684px)',rows:2},
  {query:'(min-width:1000px) and (max-height:890px)',rows:3},
  {query:'(min-width:1000px) and (max-height:1100px)',rows:4},
  {query:'(min-width:1600px) and (min-height:1900px)',rows:8},
  {query:'(min-width:1600px) and (min-height:1500px)',rows:6},
].map(({query,rows})=>({media:window.matchMedia(query),rows}));
function watchHomeSize(notify:()=>void) {
  homeDensities.forEach(({media})=>media.addEventListener('change',notify));
  return ()=>homeDensities.forEach(({media})=>media.removeEventListener('change',notify));
}
function homePageSize() {
  return homeDensities.find(({media})=>media.matches)?.rows ?? 5;
}
function HomePager({label,total,page,pageSize,change}:{label:string;total:number;page:number;pageSize:number;change:(offset:number)=>void}) {
  const pages=Math.max(1,Math.ceil(total/pageSize));
  return <nav className="home-pagination" aria-label={label}>
    <span>共 {total} 项</span><Button size="sm" disabled={page===0} onClick={()=>change((page-1)*pageSize)}>上一页</Button>
    <span>{page+1} / {pages}</span><Button size="sm" disabled={page>=pages-1} onClick={()=>change((page+1)*pageSize)}>下一页</Button>
  </nav>;
}
type HomeAction = {key:string; category:string; entered?:string; workId?:number; name:string; detail:string; status:string; tone:'err'|'warn'|'info'; action:string; href?:string; todoId?:number; due?:string};
const inboxCategory:Record<string,string> = {
  overdue:'周期提醒', dueToday:'周期提醒', docDraft:'成果核对', material:'材料清单', evidence:'影像清单',
};
function inboxActions(data:Inbox|undefined,works:Workbench[]):HomeAction[] {
  if (!data) return [];
  const actions:HomeAction[] = [
    ...data.periods.map(p=>({category:'工作期次',entered:p.created_at,key:`period-${p.id}`,workId:p.workbench_id,name:p.name,detail:`${p.report_period} · ${p.missing[0]||(p.nextAction==='文件已生成，可下载或继续编辑'?'查看本期材料与成果':p.nextAction)}`,status:p.overdue?'已逾期':/核对|确认|复核/.test(p.nextAction||'')?'待核对':'待处理',tone:p.overdue?'err' as const:'warn' as const,action:/核对.*草稿/.test(p.nextAction||'')?'核对草稿':/核对/.test(p.nextAction||'')?'核对材料':'继续办理',href:`#/workbench?id=${p.workbench_id}&periodId=${p.id}`,due:p.due_date})),
    ...works.filter(w=>w.schedule?.recurring&&w.schedule.shouldRemind&&(w.schedule.daysUntil??0)>0).map(w=>({category:'周期提醒',key:`remind-${w.id}`,workId:w.id,name:w.name,detail:`${w.schedule!.label} · 到期 ${w.schedule!.nextDue}`,status:'即将到期',tone:'warn' as const,action:'查看提醒',href:`#/workbench?id=${w.id}`,due:w.schedule!.nextDue??undefined})),
    ...data.other.map((p,i)=>({category:inboxCategory[p.kind]||'工作清单',due:p.dueAt||undefined,key:`other-${i}`,workId:p.workbenchId,name:p.workbenchName,detail:`${p.title} · ${p.reason}`,status:/缺|材料/.test(p.reason)?'待补材料':'待处理',tone:'warn' as const,action:['overdue','dueToday'].includes(p.kind)?'办理本期':'查看清单',href:`#${p.href}`})),
    ...data.todos.map(p=>({category:p.kind==='delivery'?'供应商交付':p.kind==='coordination'?'协调事项':'个人待办',entered:p.created_at,key:`todo-${p.id}`,name:p.title,detail:p.note||'',status:'待处理',tone:'info' as const,action:'完成',todoId:p.id,due:p.due_date||undefined})),
    ...data.timesheets.map(p=>({category:'部门工时',key:`hours-${p.id}`,workId:p.workbench_id??undefined,name:'部门月度工时',detail:`${p.month} · ${p.exceptions?`${p.exceptions} 项异常`:'待人工复核定稿'}`,status:'待核对',tone:'warn' as const,action:'继续办理',href:`#/workbench?task=timesheets&runId=${p.id}${p.workbench_id?`&id=${p.workbench_id}`:''}${p.period_id?`&periodId=${p.period_id}`:''}`})),
  ];
  return actions.sort((a,b)=>(a.tone==='err'?0:1)-(b.tone==='err'?0:1)||(a.due||'9999').localeCompare(b.due||'9999')||(a.status==='待核对'?0:1)-(b.status==='待核对'?0:1));
}
function HomeTitle({icon,children}:{icon:string;children:React.ReactNode}) {return <span className={`home-card-title home-title-${icon}`}><NavIcon name={icon}/>{children}</span>;}
function HomeInboxSort({value,onChange,refresh,disabled}:{value:string;onChange:(value:string)=>void;refresh:()=>void;disabled:boolean}) {
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{const close=(event:PointerEvent)=>{if(!ref.current?.contains(event.target as Node)&&ref.current)ref.current.open=false;};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[]);
  return <details ref={ref} className="home-sort" onKeyDown={e=>{if(e.key==='Escape'&&ref.current){ref.current.open=false;ref.current.querySelector('summary')?.focus();}}}><summary>{value==='due'?'截止时间（从近到远）':value==='urgent'?'按紧急程度排序':'按工作名称排序'}<span aria-hidden="true">⌄</span></summary><div className="home-sort-menu">{[{value:'due',label:'截止时间（从近到远）'},{value:'urgent',label:'按紧急程度排序'},{value:'name',label:'按工作名称排序'}].map(option=><button key={option.value} aria-pressed={value===option.value} onClick={()=>{onChange(option.value);if(ref.current)ref.current.open=false;}}>{option.label}</button>)}<button disabled={disabled} onClick={()=>{refresh();if(ref.current)ref.current.open=false;}}>刷新待办</button></div></details>;
}

export function SearchControl({go}:{go:(key:RouteKey,params?:Record<string,string>)=>void}) {
  const [search,setSearch]=useState(false);
  const [searchPreview,setSearchPreview]=useState<SearchTarget|null>(null);
  useEffect(()=>{
    const shortcut=(event:KeyboardEvent)=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&!document.querySelector('[role="dialog"]')) {
        event.preventDefault(); setSearch(true);
      }
    };
    window.addEventListener('keydown',shortcut);
    return ()=>window.removeEventListener('keydown',shortcut);
  },[]);
  return <><button className="home-search" aria-label="搜索工作、成果、模板" onClick={()=>setSearch(true)}><NavIcon name="search"/><span>搜索工作、文件、资料或知识…</span><kbd>Ctrl K</kbd></button>
    {search&&<Modal open title="搜索工作、成果、模板" wide onClose={()=>setSearch(false)}><GlobalSearch go={(key,params)=>{setSearch(false);go(key,params);}} onPreview={setSearchPreview}/></Modal>}
    {searchPreview?.kind==='artifact' && <FilePreview id={searchPreview.id} onClose={()=>setSearchPreview(null)}/>}
    {searchPreview?.kind==='template' && <TemplatePreview template={{id:searchPreview.id,name:searchPreview.title}} onClose={()=>setSearchPreview(null)}/>}
  </>;
}

export default function DashboardPage({go,openAlerts=false}:{openAlerts?:boolean;go:(k:RouteKey,p?:Record<string,string>)=>void}) {
  const all=useWorkbenchCollection(), inbox=useWorkflowInbox();
  const files=useApi<{items:Artifact[]}>('/api/artifacts?kind=generated&limit=3');
  const [notifications,setNotifications]=useState(openAlerts);
  const inboxPageSize=useSyncExternalStore(watchHomeSize,homePageSize);
  const [inboxOffset,setInboxOffset]=useState(0),[recentOffset,setRecentOffset]=useState(0);
  const [calendarOpen,setCalendarOpen]=useState(false);
  const [busy,setBusy]=useState(false),[actionError,setActionError]=useState(''),[sort,setSort]=useState('due');
  const items=all.data?.items??[], active=items.filter(w=>!['done','archived'].includes(w.status)), actions=inboxActions(inbox.data,active);
  if(sort==='due')actions.sort((a,b)=>(a.due||'9999').localeCompare(b.due||'9999'));
  if(sort==='name')actions.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
  const recent=[...active].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)||b.id-a.id).slice(0,Math.max(5,inboxPageSize));
  const deadlines=workDeadlines(active,inbox.data?.periods??[]);
  const reviewIds=new Set(actions.filter(a=>a.workId&&(a.status==='待核对'||/核对|确认|复核/.test(a.detail))).map(a=>a.workId));
  const reviewCount=active.filter(w=>reviewIds.has(w.id)).length;
  const pageCount=Math.max(1,Math.ceil(actions.length/inboxPageSize)), safePage=Math.min(Math.floor(inboxOffset/inboxPageSize),pageCount-1);
  const recentPage=Math.floor(Math.min(recentOffset,Math.max(0,recent.length-1))/inboxPageSize);
  const refresh=async()=>{setBusy(true);try{await inbox.refresh();}finally{setBusy(false);}};
  const complete=async(id:number)=>{setBusy(true);setActionError('');try{await api.put(`/api/quick-todos/${id}`,{status:'done'});inbox.reload();}catch(e){setActionError((e as Error).message);}finally{setBusy(false);}};
  const showInbox=(key?:string)=>{
    const index=key?actions.findIndex(a=>a.key===key):-1;
    setInboxOffset(Math.max(0,index));setNotifications(false);
    requestAnimationFrame(()=>{const target=document.getElementById('home-inbox');target?.scrollIntoView({block:'start'});target?.focus();});
  };
  return <div className="home-page home-focused">
    <header className="home-header">
      <div><h2>工作台首页</h2></div>
      <div className="home-header-actions">
        <SearchControl go={go}/>
        <button className="btn home-bell" aria-label="查看通知与提醒" aria-haspopup="dialog" onClick={()=>setNotifications(true)}><NavIcon name="bell"/>{!inbox.loading&&!inbox.error&&actions.length>0&&<span className="home-notice-count" aria-label={`${actions.length}项待处理`}>{actions.length}</span>}{(inbox.error||inbox.syncError)&&<span aria-label="提醒信息不完整">!</span>}</button>
        <Button onClick={()=>go('records')}>随手记</Button>
        <Button kind="primary" onClick={()=>go('workbench',{create:'1'})}>＋ 新建工作</Button>
      </div>
    </header>
    {notifications&&<Modal open title="通知与提醒" onClose={()=>setNotifications(false)} footer={<Button onClick={()=>showInbox()}>查看全部待处理</Button>}>
      <div className="home-notifications">
        <p className="muted">查看待处理事项与已登记的截止安排。</p>
        {inbox.syncError&&<p className="notice notice-err" role="alert">期次同步失败，提醒可能不完整。<Button size="sm" disabled={busy} onClick={()=>void refresh()}>重新同步</Button></p>}
        <h4>待处理事项</h4>
        {inbox.error?<LoadError error={inbox.error} retry={inbox.reload}/>:!inbox.data&&inbox.loading?<Loading/>:!actions.length?<Empty text="当前没有待处理提醒。"/>:actions.slice(0,5).map(a=><div className="home-notice-row" key={a.key}><div><strong>{a.name}</strong><p>{a.detail}</p></div>{a.href?<a className="btn btn-sm" href={a.href}>{a.action}</a>:<Button size="sm" onClick={()=>showInbox(a.key)}>查看待办</Button>}</div>)}
        {actions.length>5&&!inbox.error&&<p className="small muted">显示前5项，共{actions.length}项；可查看全部待处理。</p>}
        <h4>近期截止</h4>
        {all.error?<LoadError error={all.error} retry={all.reload}/>:all.loading?<Loading/>:<><DeadlineList entries={deadlines.slice(0,5)}/>{deadlines.length>5&&<p className="small muted">显示前5项截止，完整安排见首页“日程”。</p>}</>}
      </div>
    </Modal>}
    <div className="home-main-grid">
      <div className="home-primary">
        <div id="home-inbox" tabIndex={-1}>
          <Card className="home-inbox" title={<HomeTitle icon="clipboard">待我处理</HomeTitle>} extra={<HomeInboxSort value={sort} onChange={value=>{setSort(value);setInboxOffset(0);}} disabled={busy||inbox.loading} refresh={()=>void refresh()}/> }>
            <p className="home-section-note">需要我继续跟进的工作事项{inbox.data&&!inbox.error?`，共 ${actions.length} 项`: ''}。</p>
            {inbox.syncError&&<div className="notice notice-err" role="alert">期次同步失败：{inbox.syncError}。当前待办可能不完整，请刷新重试。</div>}
            {actionError&&<div className="notice notice-err" role="alert">{actionError}</div>}
            {inbox.error?<LoadError error={inbox.error} retry={inbox.reload}/>:!inbox.data&&inbox.loading?<Loading/>:!actions.length?<Empty text="当前没有待办理事项。"/>:<table className="table home-table inbox-table">
              <thead><tr><th>工作事项</th><th>所属类型</th><th title="有登记记录时显示创建日期">登记时间</th><th>截止时间</th><th>操作</th></tr></thead>
              <tbody>{actions.slice(safePage*inboxPageSize,(safePage+1)*inboxPageSize).map(a=><tr key={a.key}>
                <td><span className="home-work-title"><NavIcon name="workbench"/><strong title={a.name}>{a.name}</strong></span>{a.detail&&<small className="home-task-detail" title={a.detail}>{a.detail}</small>}</td>
                <td data-label="类型"><span className="tag">{a.category}</span></td>
                <td data-label="登记">{a.entered?fmtTime(a.entered).slice(0,10):'—'}</td>
                <td data-label="截止"><time>{a.due||'—'}</time><small className={'home-status '+a.tone}>{a.status}</small></td>
                <td>{a.href?<a className="btn btn-default btn-sm" href={a.href}>{a.action}</a>:<Button size="sm" disabled={busy} onClick={()=>void complete(a.todoId!)}>{a.action}</Button>}</td>
              </tr>)}</tbody>
            </table>}
            {inbox.data&&!inbox.error&&<HomePager label="待办分页" total={actions.length} page={safePage} pageSize={inboxPageSize} change={setInboxOffset}/>}
            {inbox.data?.otherTruncated&&<p className="small muted">其他待办较多，请进入工作查看完整清单。</p>}
          </Card>
        </div>
        <Card className="home-continue" title={<HomeTitle icon="clock">继续办理</HomeTitle>} extra={<Button kind="ghost" size="sm" onClick={()=>go('workbench')}>全部工作 →</Button>}>
          <p className="home-section-note">最近更新的在办工作</p>
          {all.error?<LoadError error={all.error} retry={all.reload}/>:all.loading?<Loading/>:!recent.length?<Empty text="暂无在办工作。" action={<Button onClick={()=>go('workbench',{create:'1'})}>新建工作</Button>}/>:<table className="table home-table continue-table">
            <thead><tr><th>工作事项</th><th>最近更新</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>{recent.slice(recentPage*inboxPageSize,(recentPage+1)*inboxPageSize).map(w=><tr key={w.id}><td><span className="home-work-title"><NavIcon name="workbench"/><strong title={w.name}>{w.name}</strong></span><small title={w.work_type_name}>{w.work_type_name}</small></td><td data-label="更新">{fmtTime(w.updated_at)}</td><td><Tag kind={statusKind(w.status)}>{STATUS_TEXT[w.status]||w.status}</Tag></td><td><Button size="sm" onClick={()=>go('workbench',{id:String(w.id)})}>继续办理</Button></td></tr>)}</tbody>
          </table>}

          {recent.length>inboxPageSize&&<HomePager label="最近工作分页" total={recent.length} page={recentPage} pageSize={inboxPageSize} change={setRecentOffset}/>}
        </Card>
      </div>
      <aside className="home-secondary" aria-label="截止与辅助入口">
        <Card className="home-overview" title={<HomeTitle icon="chart">工作概览</HomeTitle>}>
    <section className="home-stat-line" aria-label="工作统计">
      {all.error?<LoadError error={all.error} retry={all.reload}/>:all.loading?<Loading text="正在读取工作统计…"/>:<><span>在办 <strong>{active.length}</strong></span><span title="在办工作中有明确待核对、确认或复核事项的工作数">待核对 <strong>{inbox.error||inbox.syncError?'—':inbox.loading?'…':reviewCount}</strong></span><span>已结束 <strong>{items.filter(w=>w.status==='done').length}</strong></span></>}
    </section>
        </Card>
        <Card className="home-deadlines" title={<HomeTitle icon="clock">日程</HomeTitle>} extra={<Button size="sm" kind="ghost" onClick={()=>setCalendarOpen(true)}>查看完整月历</Button>}>

          {all.error?<LoadError error={all.error} retry={all.reload}/>:all.loading?<Loading/>:<RecentDeadlines entries={deadlines} limit={inboxPageSize>=5?5:inboxPageSize-1}/>}
          {calendarOpen&&<Modal open title="完整月历" onClose={()=>setCalendarOpen(false)}>
            {all.error?<LoadError error={all.error} retry={all.reload}/>:all.loading?<Loading/>:<WorkCalendar items={items} go={go}/>}
          </Modal>}
        </Card>
        <Card className={`home-files${!files.loading&&!files.error&&!files.data?.items.length?' home-files-empty':''}`} title={<HomeTitle icon="workbench">最近成果</HomeTitle>}>
          {files.error?<LoadError error={files.error} retry={files.reload}/>:files.loading?<Loading/>:!files.data?.items.length?<Empty text="尚无生成成果，进入工作编辑草稿后生成。"/>:files.data.items.map(a=><div className="home-file-row" key={a.id}><span className={`home-file-icon ${/\.xlsx?$/i.test(a.file_name)?'excel':''}`}>{/\.xlsx?$/i.test(a.file_name)?'X':/\.docx?$/i.test(a.file_name)?'W':'文'}</span><div className="home-row-text"><strong title={a.title||a.file_name}>{a.title||a.file_name}</strong><p>{fmtTime(a.created_at)}</p></div><Tag kind={a.is_final?'ok':'default'}>{a.is_final==null?'未标注':a.is_final?'已定稿':'草稿'}</Tag><FilePreviewButton artifact={a}/></div>)}
          <p className="home-file-note">ⓘ 文件生成与业务完成分别记录。</p>
        </Card>
        <RecordComposer compact/>
      </aside>
    </div>
  </div>;
}

type Deadline = {key:string;workId:number;name:string;date:string;label:string;periodId?:number};
function workDeadlines(items:Workbench[],periods:Inbox['periods']):Deadline[] {
  return items.flatMap(w=>{
    const dates=new Map<string,string[]>();
    for(const [raw,label] of [[w.period_due,'期次截止'],[w.schedule?.nextDue,'周期提醒'],[w.plan_end_date,'计划结束']] as const){
      if(!raw||!/^\d{4}-\d{2}-\d{2}/.test(raw))continue;
      const date=raw.slice(0,10);dates.set(date,[...(dates.get(date)??[]),label]);
    }
    return [...dates].map(([date,labels])=>({key:`${w.id}-${date}`,workId:w.id,name:w.name,date,label:labels.join(' / '),periodId:labels.includes('期次截止')?periods.find(p=>p.workbench_id===w.id&&p.due_date?.slice(0,10)===date)?.id:undefined}));
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.workId-b.workId);
}
function DeadlineList({entries}:{entries:Deadline[]}) {
  const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  return !entries.length?<Empty text="暂无已登记的截止安排。"/>:<ul className="home-deadline-list">{entries.map(d=><li key={d.key}><a href={`#/workbench?id=${d.workId}${d.periodId?`&periodId=${d.periodId}`:''}`}><span className="home-deadline-date"><time dateTime={d.date}>{d.date}</time>{d.date<=today&&<Tag kind={d.date<today?'err':'warn'}>{d.date<today?'已逾期':'今天'}</Tag>}</span><strong title={d.name}>{d.name}</strong><span className="small muted">{d.label}</span></a></li>)}</ul>;
}
function RecentDeadlines({entries,limit}:{entries:Deadline[];limit:number}) {
  const [expanded,setExpanded]=useState(false);
  return <>
    <DeadlineList entries={entries.slice(0,limit)}/>
    {entries.length>limit&&<Button kind="ghost" size="sm" onClick={()=>setExpanded(true)}>查看全部 {entries.length} 项截止</Button>}
    {expanded&&<Modal open title="全部截止安排" onClose={()=>setExpanded(false)}><DeadlineList entries={entries}/></Modal>}
  </>;
}

function WorkCalendar({items,go}:{items:Workbench[];go:(k:RouteKey,p?:Record<string,string>)=>void}) {
  const today=new Date(),[month,setMonth]=useState(()=>new Date(today.getFullYear(),today.getMonth(),1)),[day,setDay]=useState(today.getDate());
  const key=month.getFullYear()+'-'+String(month.getMonth()+1).padStart(2,'0'),date=key+'-'+String(day).padStart(2,'0');
  const due=items.filter(w=>w.schedule?.nextDue===date||w.period_due?.slice(0,10)===date||w.plan_end_date?.slice(0,10)===date);
  const first=(new Date(month.getFullYear(),month.getMonth(),1).getDay()+6)%7,days=new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
  const cells=Math.ceil((first+days)/7)*7;
  const change=(n:number)=>{setMonth(new Date(month.getFullYear(),month.getMonth()+n,1));setDay(1);};
  return <Card className="home-calendar" title={<span>截止月历 <button className="home-month" aria-label="今天" title="返回本月，定位今天" onClick={()=>{setMonth(new Date(today.getFullYear(),today.getMonth(),1));setDay(today.getDate());}}>{month.getFullYear()}年{month.getMonth()+1}月</button></span>} extra={<><button className="home-calendar-nav" aria-label="上个月" onClick={()=>change(-1)}>‹</button><button className="home-calendar-nav" aria-label="下个月" onClick={()=>change(1)}>›</button></>}>
    <div className="calendar-grid">{['一','二','三','四','五','六','日'].map(d=><span key={d}>{d}</span>)}{Array.from({length:cells},(_,i)=>{const d=i-first+1,dt=key+'-'+String(d).padStart(2,'0'),inMonth=d>0&&d<=days;return inMonth?<button key={i} aria-label={dt} aria-pressed={d===day} className={d===day?'selected':items.some(w=>w.schedule?.nextDue===dt||w.period_due?.startsWith(dt)||w.plan_end_date?.startsWith(dt))?'has-event':''} onClick={()=>setDay(d)}>{d}</button>:<span className="calendar-outside" key={i}>{new Date(month.getFullYear(),month.getMonth(),d).getDate()}</span>;})}</div>
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

type SearchTarget = Pick<GsHit,'kind'|'id'|'title'|'route'>;

function GlobalSearch({ go,onPreview }: { go: (k: RouteKey, p?: Record<string, string>) => void; onPreview:(hit:SearchTarget)=>void }) {
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

  const openHit = (event:React.MouseEvent<HTMLAnchorElement>, hit:SearchTarget) => {
    if(event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if(hit.kind==='artifact' || hit.kind==='template'){
      onPreview(hit);
      return;
    }
    const parsed = gsParseRoute(hit.route);
    if (!parsed) {
      toast(`这一条没给出可跳转的页面（${hit.route}）`, 'info');
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
                <a
                  key={`${s.kind}#${s.id}`}
                  className="global-search-hit"
                  href={'#'+s.route}
                  style={{ padding: '7px 12px', borderBottom: '1px solid var(--line)' }}
                  onClick={(event) => openHit(event,s)}
                >
                  <span className="tag" style={{ marginRight: 6 }}>
                    {s.label}
                  </span>
                  <strong style={{ fontSize: 13.5 }}>{s.title}</strong>
                  {s.subtitle && <span className="muted small">　{s.subtitle}</span>}
                </a>
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
                    <a
                      key={`${h.kind}#${h.id}`}
                      className="global-search-hit"
                      href={'#'+h.route}
                      style={{ padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 8 }}
                      onClick={(event) => openHit(event,h)}
                    >
                      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                        <strong style={{ fontSize: 13.5 }}>
                          <GsText text={h.title} />
                        </strong>
                        <span className="muted small ellipsis">{h.subtitle}</span>
                      </div>
                      <div className="small muted" style={{ marginTop: 2 }}>
                        <GsText text={h.snippet} />
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
