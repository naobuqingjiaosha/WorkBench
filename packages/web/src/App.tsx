import {PageActionTarget} from './components/PageActions';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ToastHost } from './ui';
import WorkRecordsPage from './pages/WorkRecords';
import DashboardPage, {SearchControl} from './pages/Dashboard';
import WorkbenchPage from './pages/Workbench';
import ProcessPage from './pages/Process';
import FilesPage from './pages/Files';
import KnowledgePage from './pages/Knowledge';
import AgentPage from './pages/Agent';
import SettingsPage from './pages/Settings';
import TrashPage from './pages/Trash';
import ConsentHost from './components/ConsentHost';
import {NavigationGuard, useNavigationGuard} from './components/NavigationGuard';
import {NavIcon} from './components/DesignSystem';

/**
 * 路由。注意没有独立的「生成文书」页 —— 出文书是工作里的一个动作
 * （工作 + 模板 → 文件），从工作详情页的弹窗发起，见 pages/GenerateModal.tsx。
 * 也没有独立的「模板库」页 —— 模板并进知识库了，见 pages/Knowledge.tsx。
 */
type RouteKey = 'records' | 'dashboard' | 'workbench' | 'process' | 'files' | 'knowledge' | 'agent' | 'settings' | 'trash';

/** 合法路由。新增页面时改这里一处即可 */
const ROUTE_KEYS: RouteKey[] = [
  'records', 'dashboard', 'workbench', 'process', 'files', 'knowledge', 'agent', 'settings', 'trash',
];

interface RouteState {
  key: RouteKey;
  /** 传给子页面的参数，例如 { workbenchId: 3 } 或 { templateId: 2 } */
  params: Record<string, string>;
}

function readRoute(): RouteState {
  const [key, query] = window.location.hash.replace(/^#\/?/, '').split('?');
  const params: Record<string, string> = {};
  new URLSearchParams(query ?? '').forEach((v, k) => { params[k] = v; });
  // 兼容原来的工时链接，具体工作统一在「我的工作台」内打开。
  if (key === 'timesheets') return { key: 'workbench', params: { task: 'timesheets' } };
  return { key: ROUTE_KEYS.includes(key as RouteKey) ? key as RouteKey : 'dashboard', params };
}

function browserEntryIndex(): number | undefined {
  // Chromium exposes the true position even after a same-URL navigation or reload.
  return (window as Window & {navigation?:{currentEntry?:{index:number}}}).navigation?.currentEntry?.index;
}

const NAV: { group: string; items: { key: RouteKey; label: string; icon: string; desc: string }[] }[] = [
  {
    group: '总览',
    items: [{ key: 'dashboard', label: '工作台首页', icon: '◫', desc: '日常工作、资料与常用工具' }],
  },
  {
    group: '工作办理',
    items: [
      { key: 'workbench', label: '我的工作台', icon: '▤', desc: '管理正在办理的工作与历史成果' },
      { key: 'files', label: '文件库', icon: '⌸', desc: '集中查看业务资料与成果文件' },
    ],
  },
  {
    group: '资料与工具',
    items: [
      { key: 'process', label: '流程规范', icon: '⇉', desc: '维护工作类型、办理阶段与材料要求' },
      { key: 'knowledge', label: '知识库', icon: '❖', desc: '模板资料与业务参考' },
      { key: 'agent', label: 'AI 助手', icon: '✦', desc: '问答、整理与工作记录' },
    ],
  },
  {
    group: '资源管理',
    items: [
      { key: 'trash', label: '回收站', icon: '♻', desc: '恢复误删的记录，谨慎清理不再需要的内容' },
      { key: 'settings', label: '系统配置', icon: '⚙', desc: '模型接入、目录、参数' },
    ],
  },
];

export default function App() {
  return <NavigationGuard><AppShell /></NavigationGuard>;
}

function AppShell() {
  const [route, setRoute] = useState<RouteState>(readRoute);
  const currentEntry=useRef<number>(0);
  const traversal=useRef<{target:number; restoring:boolean}|null>(null);
  const allowedHash=useRef<string|null>(null);
  const [mobileOpen,setMobileOpen]=useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!mobileOpen) return;
    sidebar.current?.querySelector<HTMLButtonElement>('.drawer-close')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMobileOpen(false); }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(sidebar.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const wide = window.matchMedia('(min-width: 1000px)');
    const resize = () => { if (wide.matches) setMobileOpen(false); };
    document.addEventListener('keydown', onKey);
    wide.addEventListener('change', resize);
    return () => {
      document.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', resize);
      menuButton.current?.focus({preventScroll:true});
    };
  }, [mobileOpen]);
  const guard=useNavigationGuard();

  const [aiReady, setAiReady] = useState<boolean | null | 'error'>(null);

  const openHash = (hash:string) => {
    setMobileOpen(false);
    if(window.location.hash===hash)return;
    guard.request(()=>{
      allowedHash.current=hash;
      window.location.hash=hash;
    });
  };
  const go = (key: RouteKey, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    openHash(`#/${key}${query ? `?${query}` : ''}`);
  };

  useEffect(() => {
    const position=browserEntryIndex()??window.history.state?.workbenchNavIndex;
    currentEntry.current=Number.isSafeInteger(position)?position:0;
    window.history.replaceState({...window.history.state,workbenchNavIndex:currentEntry.current},'');
  }, []);

  useEffect(() => {
    const onHash = (event:HashChangeEvent) => {
      if(event.newURL && event.newURL!==window.location.href)return;
      const prior=currentEntry.current;
      const state=window.history.state;
      const position=browserEntryIndex()??(Number.isSafeInteger(state?.workbenchNavIndex)?state.workbenchNavIndex:prior+1);
      if(position!==state?.workbenchNavIndex)window.history.replaceState({...state,workbenchNavIndex:position},'');
      const move=traversal.current;
      if(position===prior){
        // The original history entry and URL are back in place before the prompt opens.
        if(move?.restoring){
          traversal.current=null;
          guard.request(()=>{
            traversal.current={target:move.target,restoring:false};
            window.history.go(move.target-prior);
          });
        }
        return;
      }
      const approved=allowedHash.current===window.location.hash || (move && !move.restoring && move.target===position);
      allowedHash.current=null;
      if(!approved && guard.hasEdits()){
        traversal.current={target:position,restoring:true};
        window.history.go(prior-position);
        return;
      }
      traversal.current=null;
      const next=readRoute();
      currentEntry.current=position;
      setRoute(next);
      setMobileOpen(false);
      if(route.key!=='settings'||next.key!=='settings')document.querySelector('.content')?.scrollTo({top:0});
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [route,guard]);

  useEffect(() => {
    api
      .get<{ configured: boolean }>('/api/ai/status')
      .then((r) => setAiReady(r.configured))
      .catch(() => setAiReady('error'));
  }, [route.key, route.params.id]);

  const [actionTarget,setActionTarget]=useState<HTMLDivElement|null>(null);
  const current = NAV.flatMap((g) => g.items).find((i) => i.key === route.key);

  return (
    <ToastHost>
      <ConsentHost />
      <div className={`app${route.key==='dashboard'?' app-home':''}`} onClick={event=>{
        if(event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
        const anchor=(event.target as Element).closest<HTMLAnchorElement>('a[href^="#/"]');
        if(!anchor||anchor.target||anchor.hasAttribute('download'))return;
        event.preventDefault();
        openHash(anchor.hash);
      }}>
        {mobileOpen && <div className="drawer-backdrop" aria-hidden="true" onClick={()=>setMobileOpen(false)}/>}
        <aside id="primary-navigation" ref={sidebar} className={`sidebar${mobileOpen?' mobile-open':''}`} role={mobileOpen?'dialog':undefined} aria-modal={mobileOpen||undefined} aria-label="主导航">
          <div className="brand">
            {mobileOpen && <button type="button" className="drawer-close icon-btn" aria-label="关闭导航" onClick={()=>setMobileOpen(false)}>×</button>}
            <h1><NavIcon name="knowledge"/>个人工作台</h1>
          </div>
          <nav className="nav">
            {NAV.map((g) => (
              <div key={g.group}>
                <div className="nav-group">{g.group}</div>
                {g.items.map((item) => (
                  <button type="button" aria-current={route.key === item.key ? 'page' : undefined}
                    key={item.key}
                    className={`nav-item${route.key === item.key ? ' active' : ''}`}
                    onClick={() => go(item.key)}
                  >
                    <span className="ico"><NavIcon name={item.key}/></span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-foot">
            {aiReady === null ? '正在检查模型…' : aiReady === 'error' ? '模型状态读取失败' : aiReady ? '模型已就绪' : <button type="button" className="sidebar-status" onClick={() => go('settings',{section:'models'})}>配置模型 →</button>}
          </div>
        </aside>

        <PageActionTarget.Provider value={actionTarget}><main className="main" inert={mobileOpen}>
          <header className={`topbar${route.key==='dashboard'?' dashboard-topbar':''}${route.key==='workbench'&&(route.params.id||route.params.task)?' detail-topbar':''}`}>
            <button ref={menuButton} className="btn mobile-menu" onClick={()=>setMobileOpen(true)} aria-controls="primary-navigation" aria-expanded={mobileOpen} aria-label="切换导航">☰</button>
            <div>
              <h2>{current?.label ?? '工作记录'}</h2>
              <div className="sub">{current?.desc}</div>
            </div>
            <div className="page-heading-tools">
              {(route.key==='process'||(route.key==='workbench'&&!route.params.id&&!route.params.task))&&<SearchControl go={go}/>}
              <div className="page-action-slot" ref={setActionTarget}/>
              {(route.key==='process'||(route.key==='workbench'&&!route.params.id&&!route.params.task))&&<button className="heading-bell" aria-label="查看通知与提醒" onClick={()=>go('dashboard',{view:'alerts'})}><NavIcon name="bell"/></button>}
            </div>
          </header>
          <div className={`content page-${route.key}`}>
            {route.key === 'records' && <WorkRecordsPage params={route.params} />}
            {route.key === 'dashboard' && <DashboardPage go={go} openAlerts={route.params.view==='alerts'} />}
            {route.key === 'workbench' && <WorkbenchPage go={go} params={route.params} />}
            {route.key === 'process' && <ProcessPage />}
            {route.key === 'files' && <FilesPage params={route.params} go={go} />}
            {route.key === 'knowledge' && <KnowledgePage key={route.params.module} params={route.params} go={go} />}
            {route.key === 'agent' && <AgentPage />}
            {route.key === 'trash' && <TrashPage />}
            {route.key === 'settings' && <SettingsPage params={route.params} />}
          </div>
        </main></PageActionTarget.Provider>
      </div>
    </ToastHost>
  );
}

export type { RouteKey, RouteState };
