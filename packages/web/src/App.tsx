import { useEffect, useState } from 'react';
import { api } from './api';
import { ToastHost } from './ui';
import WorkRecordsPage from './pages/WorkRecords';
import DashboardPage from './pages/Dashboard';
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

const NAV: { group: string; items: { key: RouteKey; label: string; icon: string; desc: string }[] }[] = [
  {
    group: '总览',
    items: [{ key: 'dashboard', label: '工作台首页', icon: '◫', desc: '工作进度与待办' }],
  },
  {
    group: '工作办理',
    items: [
      { key: 'workbench', label: '我的工作台', icon: '▤', desc: '按工作类型组织，按适用阶段与独立期次办理' },
      { key: 'files', label: '文件库', icon: '⌸', desc: '所有文件：按工作/类别筛、下载、改名、做 OCR' },
    ],
  },
  {
    group: '资料与工具',
    items: [
      { key: 'process', label: '流程规范', icon: '⇉', desc: '每步该做什么、留什么材料' },
      { key: 'knowledge', label: '知识库', icon: '❖', desc: '模板、制度、资料 —— 检索与提问' },
      { key: 'agent', label: 'AI 助手', icon: '✦', desc: '基于业务证据问答、分析和起草文书' },
    ],
  },
  {
    group: '系统管理',
    items: [
      { key: 'trash', label: '回收站', icon: '♻', desc: '删掉的工作台/文件/阶段都在这儿，能恢复，也能彻底删除' },
      { key: 'settings', label: '系统配置', icon: '⚙', desc: '模型接入、目录、参数' },
    ],
  },
];

export default function App() {
  return <NavigationGuard><AppShell /></NavigationGuard>;
}

function AppShell() {
  const [route, setRoute] = useState<RouteState>(readRoute);
  const [mobileOpen,setMobileOpen]=useState(false);
  const guard=useNavigationGuard();

  const [aiReady, setAiReady] = useState<boolean | null | 'error'>(null);

  const go = (key: RouteKey, params: Record<string, string> = {}) => {
    const query = new URLSearchParams(params).toString();
    window.location.hash = `#/${key}${query ? `?${query}` : ''}`;
  };

  useEffect(() => {
    const onHash = () => {
      const target=window.location.hash, next=readRoute();
      const previous=`#/${route.key}${Object.keys(route.params).length?'?'+new URLSearchParams(route.params):''}`;
      window.history.replaceState(null,'',previous);
      guard.request(()=>{window.history.replaceState(null,'',target);setRoute(next);setMobileOpen(false);document.querySelector('.content')?.scrollTo({top:0});});
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

  const current = NAV.flatMap((g) => g.items).find((i) => i.key === route.key);

  return (
    <ToastHost>
      <ConsentHost />
      <div className={`app${route.key==='dashboard'?' app-home':''}`}>
        <aside className={`sidebar${mobileOpen?' mobile-open':''}`}>
          <div className="brand">
            <h1>工作台</h1>
            <p>行政管理 · 项目实施</p>
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
            {aiReady === null ? '正在检查模型…' : aiReady === 'error' ? '模型状态读取失败' : aiReady ? '模型已就绪' : <span onClick={() => go('settings')} className="clickable">⚠ 还没配置模型</span>}
          </div>
        </aside>

        <main className="main">
          <header className={`topbar${route.key==='dashboard'?' dashboard-topbar':''}${route.key==='workbench'&&(route.params.id||route.params.task)?' detail-topbar':''}`}>
            <button className="btn mobile-menu" onClick={()=>setMobileOpen(v=>!v)} aria-label="切换导航">☰</button>
            <div>
              <h2>{current?.label ?? '工作记录'}</h2>
              <div className="sub">{current?.desc}</div>
            </div>
          </header>
          <div className={`content page-${route.key}`}>
            {route.key === 'records' && <WorkRecordsPage params={route.params} />}
            {route.key === 'dashboard' && <DashboardPage go={go} />}
            {route.key === 'workbench' && <WorkbenchPage go={go} params={route.params} />}
            {route.key === 'process' && <ProcessPage />}
            {route.key === 'files' && <FilesPage params={route.params} go={go} />}
            {route.key === 'knowledge' && <KnowledgePage key={route.params.module} params={route.params} />}
            {route.key === 'agent' && <AgentPage />}
            {route.key === 'trash' && <TrashPage />}
            {route.key === 'settings' && <SettingsPage />}
          </div>
        </main>
      </div>
    </ToastHost>
  );
}

export type { RouteKey, RouteState };
