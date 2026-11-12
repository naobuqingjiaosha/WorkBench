import type {ReactNode} from 'react';
import {Button} from '../ui';
export function LoadError({error,retry}:{error:{message:string};retry:()=>void}){return <div className="notice notice-err" role="alert"><strong>暂时无法读取</strong><p>{error.message}</p><Button onClick={retry}>重试</Button></div>;}
export function SectionNav({items,value,onChange}:{items:{value:string;label:string;count?:number}[];value:string;onChange:(value:string)=>void}){return <nav className="section-nav" aria-label="页面分类">{items.map(item=><button type="button" key={item.value} className={value===item.value?'selected':''} aria-current={value===item.value?'page':undefined} onClick={()=>onChange(item.value)}><span>{item.label}</span>{item.count!==undefined&&<span className="small muted">{item.count}</span>}</button>)}</nav>;}
export function PageSplit({nav,children}:{nav:ReactNode;children:ReactNode}){return <div className="page-split">{nav}<div className="section-content">{children}</div></div>;}
const paths:Record<string,string>={
  dashboard:'M2 10.5 12 2l10 8.5 M5 9v12h5v-7h4v7h5V9',
  workbench:'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h8',
  files:'M2 6h8l2 3h10v12H2z',
  records:'M4 20l4-1L20 7l-3-3L5 16z',
  process:'M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2z M12 6v15',
  knowledge:'m12 2 9 4v12l-9 4-9-4V6z M3 6l9 4 9-4 M12 10v12',
  agent:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
  trash:'M4 6h16M9 3h6M6 6l1 15h10l1-15M10 10v7m4-7v7',
  settings:'m9 3 1-1h4l1 3 2 1 3-1 2 4-2 2v2l2 2-2 4-3-1-2 1-1 3h-4l-1-3-2-1-3 1-2-4 2-2v-2l-2-2 2-4 3 1 2-1z M15 12a3 3 0 1 0-6 0 3 3 0 0 0 6 0',
  bell:'M4 18h16l-2-3V9a6 6 0 0 0-12 0v6z M10 21h4',
  clipboard:'M8 5H4v17h16V5h-4 M9 3h6v4H9z M8 13l3 3 5-6',
  clock:'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 7v6l4 2',
  chart:'m2 7 10-5 10 5-10 5z M2 12l10 5 10-5 M2 17l10 5 10-5',
  search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
};
export function NavIcon({name}:{name:string}){return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]??paths.files}/></svg>;}
