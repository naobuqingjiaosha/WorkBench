import {useRef,useState} from 'react';
import {api} from '../api';
import {Button,Field,Input} from '../ui';
import {useEditorGuard} from './NavigationGuard';
import {FilePreviewButton} from './FilePreview';
export interface ExternalMaterial {id:number;title:string;status:string;artifact_id:number|null;required:number;exists:boolean;ready:boolean;fileName:string|null}
type Expected=Pick<ExternalMaterial,'artifact_id'|'status'|'title'|'required'>&{requirement_kind:string};
type Pending={artifactId:number;materialId:number;fileName:string;expected:Expected};
type Props={periodId:number;workbenchId:number;materials:ExternalMaterial[];files:{id:number;file_name:string;kind:string;file_role:string}[];disabled:boolean;onChanged:()=>void};
export function PeriodAttachments(props:Props){return <AttachmentEditor key={`${props.workbenchId}:${props.periodId}`} {...props}/>;}
function AttachmentEditor({periodId,workbenchId,materials,files,disabled,onChanged}:Props){
 const [busy,setBusy]=useState(false),lock=useRef(false),[title,setTitle]=useState(''),[pending,setPending]=useState<Pending|null>(null),[error,setError]=useState('');
 const act=async(fn:()=>Promise<void>)=>{if(lock.current)throw Error('附件操作尚未结束，请稍候');lock.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);throw e;}finally{lock.current=false;setBusy(false);}};
 const run=(fn:()=>Promise<void>)=>void act(fn).catch(()=>{});
 const link=async(p:Pending)=>{
  if(disabled)throw Error('当前期次不可修改');
  const view=await api.get<{materials:(Expected&{id:number})[]}>(`/api/periods/${periodId}`),m=view.materials.find(m=>m.id===p.materialId);
  if(!m||m.title!==p.expected.title||m.required!==p.expected.required||m.requirement_kind!==p.expected.requirement_kind)throw Error('附件要求已变化，已保存文件保留；请核对后处理，不会自动覆盖');
  if(m.artifact_id===p.artifactId&&['provided','verified'].includes(m.status)){setPending(null);onChanged();return;}
  if(m.artifact_id!==p.expected.artifact_id||m.status!==p.expected.status)throw Error('附件关联或状态已被修改，已保存文件保留；不会覆盖其他修改');
  await api.put(`/api/periods/${periodId}/materials/${p.materialId}`,{status:'provided',artifact_id:p.artifactId,expected:p.expected});
  setPending(null);onChanged();
 };
 const request=useEditorGuard({dirty:!!pending,busy,save:async()=>{if(pending)await act(()=>link(pending));},discard:()=>{setPending(null);setError('');}});
 const upload=async(file:File,material?:ExternalMaterial)=>{
  if(pending)throw Error('请先处理已保存文件的关联');
  const form=new FormData();form.append('workbenchId',String(workbenchId));form.append('periodId',String(periodId));form.append('fileRole',material?'external':'source');form.append('file',file);
  const r=await api.upload<{items:{id:number}[]}>('/api/artifacts/upload',form);const a=r.items[0];if(!a)throw Error('未取得文件编号，保存结果待核实；请先查看文件库，勿直接重复上传');
  if(!material){onChanged();return;}
  const p:Pending={artifactId:a.id,materialId:material.id,fileName:file.name,expected:{artifact_id:material.artifact_id,status:material.status,title:material.title,required:material.required,requirement_kind:'external'}};
  setPending(p);
  // Keep recovery state mounted when the service is down; a failed parent reload can unmount this editor.
  // The pending card immediately exposes the known saved file. Refresh parents after successful reconciliation.
  await link(p);
 };
 return <div className="col">
  <p className="small muted">普通文书无需先准备附件。历史资料可按需参考；外部签章件、合同及证明须上传原件副本并人工确认。</p>
  {error&&<p role="alert" className="notice notice-err">{error}</p>}
  {pending&&<div className="notice notice-warn" role="status"><p>文件“{pending.fileName}”已保存（#{pending.artifactId}），关联结果待核对。重试只核对并关联这个文件，不重新上传。</p><a href={`/api/artifacts/${pending.artifactId}/file`}>下载已保存文件</a><Button disabled={busy||disabled} onClick={()=>run(()=>link(pending))}>核对并重试关联</Button><Button disabled={busy} onClick={()=>request(()=>{setPending(null);setError('');})}>保留文件，放弃本次关联</Button><p className="small">恢复信息仅保留在当前页面。刷新或明确放弃后，请从本期文件中核对已保存文件；不会自动删除文件。</p></div>}
  {materials.map(m=><div key={m.id} className="attachment-row"><strong>{m.title}{m.required?'（必需外部附件）':''}</strong><span className="small">{m.ready?'已确认':m.exists?'附件已收到，待核对':'待提供'}{m.fileName?` · ${m.fileName}`:''}</span><div className="row">
   {m.artifact_id&&m.exists&&<FilePreviewButton artifact={{id:m.artifact_id,file_name:m.fileName??m.title}}/>}
   <label className="btn btn-sm">{m.exists?'替换附件':'上传附件'}<input aria-label={`上传${m.title}`} type="file" disabled={disabled||busy||!!pending} className="attachment-input" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)run(()=>upload(f,m));}}/></label>
   {m.exists&&!m.ready&&<Button size="sm" disabled={disabled||busy||!!pending} onClick={()=>run(async()=>{await api.put(`/api/periods/${periodId}/materials/${m.id}`,{status:'verified',artifact_id:m.artifact_id,note:'用户已核对外部附件'});onChanged();})}>确认附件符合要求</Button>}
   {!m.ready&&!disabled&&<Button size="sm" disabled={busy||!!pending} onClick={()=>{const reason=window.prompt('本项不适用的实际依据');if(reason?.trim())run(async()=>{await api.put(`/api/periods/${periodId}/materials/${m.id}`,{status:'na',note:reason});onChanged();});}}>本项不适用</Button>}
  </div></div>)}
  <label className="btn">添加参考资料<input type="file" aria-label="添加参考资料" disabled={disabled||busy||!!pending} className="attachment-input" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)run(()=>upload(f));}}/></label>
  {files.filter(f=>f.kind!=='generated'&&!materials.some(m=>m.artifact_id===f.id)).map(f=><div className="row" key={f.id}><span>{f.file_name}</span><FilePreviewButton artifact={f}/><a href={`/api/artifacts/${f.id}/file`}>下载</a></div>)}
  <details><summary>需要补充外部证明要求</summary><Field label="外部附件名称"><Input value={title} onChange={setTitle} placeholder="例如：合同签章件、项目验收证明" disabled={disabled||busy||!!pending}/></Field><Button disabled={disabled||busy||!!pending||!title.trim()} onClick={()=>run(async()=>{await api.post(`/api/periods/${periodId}/materials`,{title,requirementKind:'external'});setTitle('');onChanged();})}>添加外部附件要求</Button></details>
 </div>;
}
