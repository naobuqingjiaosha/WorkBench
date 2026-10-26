import {useState} from 'react';
import {api,useApi} from '../api';
import {Button,Card,Field,Input,useAction} from '../ui';
export function ReferenceFolder({id}:{id:number}){
 const [draft,setDraft]=useState(''),[path,setPath]=useState('');const {busy,run}=useAction();
 const info=useApi<{root:string|null;items:{name:string;path:string;directory:boolean}[]}>(`/api/workbenches/${id}/reference-folder?path=${encodeURIComponent(path)}`);
 return <Card title="已有业务目录 · 只读参考"><p className="small muted">不改动原件，不扫描纳管。向AI业务助手明确提问时，可在读取预算内检索此目录；季度问题仅选择路径明确标注对应期间的文件，无法确认归属的资料会列为未读取。云端外发仍须逐次确认。</p>
 <p className="mono small">{info.data?.root??'尚未设置参考目录'}</p>
 <Field label="参考目录绝对路径"><Input value={draft} onChange={setDraft} placeholder="填写现有业务资料目录…"/></Field>
 <div className="row"><Button disabled={busy||!draft.trim()} onClick={()=>void run(async()=>{await api.put(`/api/workbenches/${id}/reference-folder`,{path:draft});setPath('');info.reload();})}>保存只读参考目录</Button>{info.data?.root&&<Button disabled={busy} onClick={()=>void run(async()=>{await api.put(`/api/workbenches/${id}/reference-folder`,{path:null});setPath('');info.reload();})}>取消参考</Button>}</div>
 {info.error&&<p role="alert">{info.error.message}</p>}
 {path&&<Button size="sm" onClick={()=>setPath(path.split('/').slice(0,-1).join('/'))}>返回上级</Button>}
 <div className="col">{info.data?.items.map(f=>f.directory?<Button size="sm" key={f.path} onClick={()=>setPath(f.path)}>📁 {f.name}</Button>:<a key={f.path} href={`/api/workbenches/${id}/reference-file?path=${encodeURIComponent(f.path)}`} target="_blank" rel="noreferrer">{f.name} · 查看原件</a>)}</div>
 </Card>;
}
