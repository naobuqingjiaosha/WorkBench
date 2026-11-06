import {useRef,useState} from 'react';
import {api,type WorkType} from '../api';
import {Button,Field,Input,Modal,Select} from '../ui';
import {TYPE_GROUPS} from '../work-type-navigation';
import {useEditorGuard,useNavigationGuard} from './NavigationGuard';
import type {ConfigState} from '../../../server/src/domain/workflow-config-types';

/** Create/copy configuration only. No work instances, business facts or files are copied. */
export function WorkTypeEditor({types,onDone}:{types:WorkType[];onDone:(id:number)=>void}){
 const [open,setOpen]=useState(false),[code,setCode]=useState(''),[name,setName]=useState(''),[group,setGroup]=useState('administration'),[copy,setCopy]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const lock=useRef(false),guard=useNavigationGuard();
 const dirty=open&&!!(code||name||copy);
 const clear=()=>{setOpen(false);setCode('');setName('');setCopy('');setError('');};
 const save=async()=>{if(lock.current)throw Error('正在创建，请稍候');lock.current=true;setBusy(true);setError('');try{const source=types.find(t=>t.id===Number(copy));const r=await api.post<ConfigState>('/api/workflow-config',{code,name,navigationGroup:group,...source?{copyFrom:source.id,sourceVersionId:source.published_config_id}:{}});clear();onDone(r.typeId);}catch(e){setError((e as Error).message);throw e;}finally{lock.current=false;setBusy(false);}};
 useEditorGuard({dirty,busy,save,discard:clear});
 return <><Button onClick={()=>guard.request(()=>setOpen(true))}>新增 / 复制类型</Button><Modal open={open} title="建立类型草稿" onClose={()=>guard.request(clear)} footer={<><Button disabled={busy} onClick={()=>guard.request(clear)}>取消</Button><Button disabled={busy||!code.trim()||!name.trim()} onClick={()=>void save().catch(()=>{})}>{busy?'创建中…':'创建草稿'}</Button></>}>
 <p>草稿发布后才能新建工作。复制仅取已发布配置和模板引用，不复制工作记录或业务文件；专用月检能力不随复制继承。</p>
 {error&&<div role="alert" className="notice notice-err">{error}；输入已保留。</div>}
 <fieldset disabled={busy} style={{border:0,padding:0}}><Field label="起始配置"><Select value={copy} onChange={setCopy} options={[{value:'',label:'空白配置'},...types.filter(t=>t.published_config_id).map(t=>({value:String(t.id),label:t.name}))]}/></Field>
 {!copy&&<Field label="导航分类"><Select value={group} onChange={setGroup} options={TYPE_GROUPS}/></Field>}
 <Field label="新类型名称"><Input value={name} onChange={setName}/></Field><Field label="新类型编码" hint="字母、数字、横线或下划线；创建后不改。"><Input value={code} onChange={setCode}/></Field></fieldset>
 </Modal></>;
}
