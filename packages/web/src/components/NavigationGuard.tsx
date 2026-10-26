import {createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Button, Modal} from '../ui';

type Editor = {dirty:boolean; busy?:boolean; save?:()=>Promise<void>; discard?:()=>void};
const GuardContext = createContext({register:(_id:symbol,_editor:()=>Editor)=>()=>{}, request:(next:()=>void)=>next()});

/** Keep editor buffers mounted until an explicit discard or a successful save. */
export function NavigationGuard({children}:{children:ReactNode}) {
  const editors=useRef(new Map<symbol,()=>Editor>());
  const [pending,setPending]=useState<{next:()=>void; editors:Editor[]}|null>(null);
  const [saving,setSaving]=useState(false), [error,setError]=useState('');
  const value=useMemo(()=>({
    register:(id:symbol,editor:()=>Editor)=>{editors.current.set(id,editor);return ()=>{editors.current.delete(id);};},
    request:(next:()=>void)=>{const dirty=[...editors.current.values()].map(read=>read()).filter(e=>e.dirty||e.busy);if(!dirty.length){next();return;}setError('');setPending({next,editors:dirty});},
  }),[]);
  useEffect(()=>{const unload=(e:BeforeUnloadEvent)=>{if([...editors.current.values()].some(read=>(read().dirty||read().busy))){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',unload);return ()=>window.removeEventListener('beforeunload',unload);},[]);
  return <GuardContext.Provider value={value}>{children}<Modal open={!!pending} title="还有未保存的修改" onClose={()=>{if(!saving)setPending(null);}} footer={<>
    <Button disabled={saving} onClick={()=>setPending(null)}>继续编辑</Button>
    <Button disabled={saving||pending?.editors.some(e=>e.busy)} onClick={()=>{pending?.editors.forEach(e=>e.discard?.());const next=pending?.next;setPending(null);next?.();}}>不保存离开</Button>
    <Button kind="primary" disabled={saving||pending?.editors.some(e=>e.busy)||!pending?.editors.every(e=>e.save)} onClick={async()=>{if(!pending||saving)return;setSaving(true);setError('');try{for(const editor of pending.editors)await editor.save!();const next=pending.next;setPending(null);next();}catch(e){setError((e as Error).message||'保存失败，输入已保留');}finally{setSaving(false);}}}>{saving?'保存中…':'保存并离开'}</Button>
  </>}>{pending?.editors.some(e=>e.busy)&&<p role="status">当前操作尚未结束，请继续留在编辑页，等待完成后再离开。</p>}<p>离开前可以保存当前修改。放弃只会丢弃尚未保存的输入，已保存记录和文件会保留。</p>{!pending?.editors.every(e=>e.save)&&<p className="muted">当前表单需在原编辑区保存，请选择“继续编辑”。</p>}{error&&<div role="alert" className="notice notice-err">{error}。页面与输入已保留。</div>}</Modal></GuardContext.Provider>;
}
export const useNavigationGuard=()=>useContext(GuardContext);
export function useEditorGuard(editor:Editor){
  const guard=useNavigationGuard(),id=useRef(Symbol()),latest=useRef(editor);latest.current=editor;
  useEffect(()=>guard.register(id.current,()=>latest.current),[guard]);
  return guard.request;
}
