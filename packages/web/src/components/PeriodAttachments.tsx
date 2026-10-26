import {useState} from 'react';
import {api} from '../api';
import {Button,Field,Input,useAction} from '../ui';
import {FilePreviewButton} from './FilePreview';
export interface ExternalMaterial {id:number;title:string;status:string;artifact_id:number|null;required:number;exists:boolean;ready:boolean;fileName:string|null}
export function PeriodAttachments({periodId,workbenchId,materials,files,disabled,onChanged}:{periodId:number;workbenchId:number;materials:ExternalMaterial[];files:{id:number;file_name:string;kind:string;file_role:string}[];disabled:boolean;onChanged:()=>void}){
 const {busy,run}=useAction(),[title,setTitle]=useState('');
 const upload=async(file:File,material?:ExternalMaterial)=>{
  const form=new FormData();form.append('workbenchId',String(workbenchId));form.append('periodId',String(periodId));form.append('fileRole',material?'external':'source');form.append('file',file);
  const r=await api.upload<{items:{id:number}[]}>('/api/artifacts/upload',form);const a=r.items[0];if(!a)throw Error('附件未保存');
  if(material)await api.put(`/api/periods/${periodId}/materials/${material.id}`,{status:'provided',artifact_id:a.id});onChanged();
 };
 return <div className="col">
  <p className="small muted">普通文书无需先准备附件。历史资料可按需参考；外部签章件、合同及证明须上传原件副本并人工确认。</p>
  {materials.map(m=><div key={m.id} className="attachment-row"><strong>{m.title}{m.required?'（必需外部附件）':''}</strong><span className="small">{m.ready?'已确认':m.exists?'附件已收到，待核对':'待提供'}{m.fileName?` · ${m.fileName}`:''}</span><div className="row">
   {m.artifact_id&&m.exists&&<FilePreviewButton artifact={{id:m.artifact_id,file_name:m.fileName??m.title}}/>}
   <label className="btn btn-sm">{m.exists?'替换附件':'上传附件'}<input aria-label={`上传${m.title}`} type="file" disabled={disabled||busy} className="attachment-input" onChange={e=>{const f=e.target.files?.[0];if(f)void run(()=>upload(f,m));}}/></label>
   {m.exists&&!m.ready&&<Button size="sm" disabled={disabled||busy} onClick={()=>void run(async()=>{await api.put(`/api/periods/${periodId}/materials/${m.id}`,{status:'verified',artifact_id:m.artifact_id,note:'用户已核对外部附件'});onChanged();})}>确认附件符合要求</Button>}
   {!m.ready&&!disabled&&<Button size="sm" disabled={busy} onClick={()=>{const reason=window.prompt('本项不适用的实际依据');if(reason?.trim())void run(async()=>{await api.put(`/api/periods/${periodId}/materials/${m.id}`,{status:'na',note:reason});onChanged();});}}>本项不适用</Button>}
  </div></div>)}
  <label className="btn">添加参考资料<input type="file" aria-label="添加参考资料" disabled={disabled||busy} className="attachment-input" onChange={e=>{const f=e.target.files?.[0];if(f)void run(()=>upload(f));}}/></label>
  {files.filter(f=>f.kind!=='generated'&&!materials.some(m=>m.artifact_id===f.id)).map(f=><div className="row" key={f.id}><span>{f.file_name}</span><FilePreviewButton artifact={f}/><a href={`/api/artifacts/${f.id}/file`}>下载</a></div>)}
  <details><summary>需要补充外部证明要求</summary><Field label="外部附件名称"><Input value={title} onChange={setTitle} placeholder="例如：合同签章件、项目验收证明"/></Field><Button disabled={disabled||busy||!title.trim()} onClick={()=>void run(async()=>{await api.post(`/api/periods/${periodId}/materials`,{title,requirementKind:'external'});setTitle('');onChanged();})}>添加外部附件要求</Button></details>
 </div>;
}
