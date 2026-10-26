import {useEditorGuard} from './NavigationGuard';
import {useEffect,useState} from 'react';
import {api,useApi,type Artifact,type Template} from '../api';
import {Button,Card,Field,Textarea,Select,Tag,useAction,useToast} from '../ui';
import {GenerateModal} from '../pages/GenerateModal';
import {DocVersionsModal} from '../pages/DocVersions';
import {FilePreviewButton} from './FilePreview';

type Choice={inspectionId?:number;id:number;name:string;required?:boolean;materialId?:number|null;generation_scope?:'period'|'record'};
export function WorkDocuments({workbenchId,workTypeId,periodId,content,onContentChange,onSaveContent,templates,validFinalIds,materials=[],inspectionRevisions=[],inspectionMode=false,refreshKey,contentLabel="本次业务内容",disabled=false,onChanged}:{
 validFinalIds?:number[];workbenchId:number;workTypeId:number;periodId?:number;content:string;onContentChange:(s:string)=>void;
 onSaveContent:()=>Promise<void>;templates:Choice[];refreshKey?:string;inspectionMode?:boolean;inspectionRevisions?:{id:number;revision:number;project?:string;date?:string}[];contentLabel?:string;materials?:{id:number;title:string}[];disabled?:boolean;onChanged:()=>void;
}){
 const [contentDirty,setContentDirty]=useState(false),[savedContent,setSavedContent]=useState(content);
 useEffect(()=>{if(!contentDirty)setSavedContent(content);},[content,contentDirty]);
 const saveContent=async()=>{await onSaveContent();setContentDirty(false);setSavedContent(content);};
 useEditorGuard({dirty:contentDirty&&content!==savedContent,save:saveContent,discard:()=>{onContentChange(savedContent);setContentDirty(false);}});
 const pool=useApi<{items:Template[]}>(`/api/templates?workTypeId=${workTypeId}`);
 const files=useApi<{items:(Artifact&{work_period_id:number|null;template_id:number|null;is_final:number;inspection_draft_id?:number|null;inspection_id?:number|null;inspection_revision?:number;version_group?:string;revision?:number;generation_values?:Record<string,string>})[]}>(`/api/artifacts?workbenchId=${workbenchId}&limit=500`);
 useEffect(()=>{if(refreshKey!==undefined)files.reload();},[refreshKey]);
 const [choosing,setChoosing]=useState(false),[picked,setPicked]=useState<number[]>([]),[required,setRequired]=useState<number[]>([]);
 const [resultMaterials,setResultMaterials]=useState<Record<string,number|null>>({});
 const [generating,setGenerating]=useState<(Choice&{values?:Record<string,string>})|null>(null),[versions,setVersions]=useState<number|null>(null);
 const {busy,run}=useAction(),toast=useToast();
 useEffect(()=>{if(!choosing){setPicked(templates.map(t=>t.id));setResultMaterials(Object.fromEntries(templates.map(t=>[String(t.id),t.materialId??null])));setRequired(templates.filter(t=>t.required).map(t=>t.id));}},[templates,choosing]);
 const refresh=()=>{files.reload();onChanged();};
 const saveTemplates=()=>void run(async()=>{
  await saveContent();
  if(periodId){
   const selection={templateIds:picked,requiredIds:required.filter(id=>picked.includes(id)),resultMaterials:Object.fromEntries(picked.map(id=>[id,resultMaterials[String(id)]??null]))};
   const expected=await api.post(`/api/periods/${periodId}/templates`,selection);
   await api.post(`/api/periods/${periodId}/templates`,{...selection,apply:true,expected});
  }else await api.put(`/api/workbenches/${workbenchId}/templates`,{templateIds:picked,requiredIds:required.filter(id=>picked.includes(id))});
  setChoosing(false);refresh();toast('已保存适用模板','ok');
 });
 const open=(t:Choice,values?:Record<string,string>)=>void run(async()=>{await saveContent();setGenerating({...t,values});});
 const allResults=files.data?.items.filter(a=>a.kind==='generated'&&(periodId?a.work_period_id===periodId:!a.work_period_id))??[];
 const results=allResults.filter(a=>!a.version_group||!allResults.some(b=>b.version_group===a.version_group&&(b.revision??0)>(a.revision??0)));
 return <div className="document-workspace col">
  {!inspectionMode&&<><Field label={contentLabel} hint="填写已确认的事实；内容会保存到当前工作或期次，并带入模板中的“内容 / 业务内容 / 本期内容”字段。其他字段在生成窗口核对。">
   <Textarea value={content} onChange={v=>{setContentDirty(true);onContentChange(v);}} rows={5} disabled={disabled} placeholder="填写工作安排、实际情况、会议记录或拟稿要点…"/>
  </Field>
  <div className="row"><Button disabled={disabled||busy} onClick={()=>void run(async()=>{await saveContent();toast('业务内容已保存','ok');})}>保存业务内容</Button><span className="small muted">生成前也会自动保存本次内容</span></div></>}
  <Card title="适用模板 → 生成文书" extra={<Button disabled={disabled||busy} onClick={()=>setChoosing(!choosing)}>{choosing?'收起选择':'选择 / 调整模板'}</Button>}>
   <p className="small muted">模板用于生成新文件；来源资料按需选择；生成成果自动归入当前工作{periodId?'及本期':''}。签章件、合同及供应商证明另行归档核对。</p>
   {pool.error&&<p role="alert">{pool.error.message}</p>}
   {choosing&&<div className="col template-choices">
    {!pool.data?.items.length&&<p>此类型暂无模板，可先保存内容，后续在模板库上传并指定适用工作类型。</p>}
    {pool.data?.items.map(t=><div className="template-choice" key={t.id}><label><input type="checkbox" checked={picked.includes(t.id)} onChange={e=>setPicked(a=>e.target.checked?[...a,t.id]:a.filter(id=>id!==t.id))}/>{t.name} · {t.file_format}</label>{picked.includes(t.id)&&<label className="small"><input type="checkbox" checked={required.includes(t.id)} onChange={e=>setRequired(a=>e.target.checked?[...a,t.id]:a.filter(id=>id!==t.id))}/>本期必备成果</label>}{picked.includes(t.id)&&materials.length>0&&<Field label="对应成果要求（可选）"><Select value={String(resultMaterials[String(t.id)]??'')} onChange={v=>setResultMaterials(a=>({...a,[String(t.id)]:v?Number(v):null}))} options={[{value:'',label:'独立成果（同名要求自动匹配）'},...materials.map(m=>({value:String(m.id),label:m.title}))]}/><span className="small muted">选择后，生成及定稿自动更新此项，无需再次绑定文件。</span></Field>}</div>)}
    <Button disabled={busy} onClick={saveTemplates}>保存模板选择</Button>
   </div>}
   {!templates.length&&!choosing&&<p>暂未选择模板。可先填写内容，再选择适用的 Word / Excel 模板。</p>}
   <div className="template-actions">{inspectionMode&&<span className="small muted">单次表册从上方检查记录生成；下方汇总与累计台账使用本期或本年度全部检查记录，记录变化后请重新生成。</span>}{templates.filter(t=>!inspectionMode||t.generation_scope==='period').map(t=><Button kind="primary" key={t.id} disabled={disabled||busy} onClick={()=>open(t)}>{t.name} · 生成</Button>)}</div>
  </Card>
  <Card title={`生成成果（${results.length}）`}>
   {files.error&&<p role="alert">成果加载失败：{files.error.message} <Button onClick={files.reload}>重试</Button></p>}
   {files.loading&&!files.data&&<p>正在加载成果…</p>}
   {!files.loading&&!files.error&&!results.length&&<p className="small muted">生成后自动保存于此，无需再次上传或绑定。预览核对后可修改、保存新版本或定稿。</p>}
   {results.map(a=><div className="result-row" key={a.id}><div><strong>{a.file_name}</strong><div className="small muted">{pool.data?.items.find(t=>t.id===a.template_id)?.name??'模板成果'}{a.inspection_id?` · ${inspectionRevisions.find(r=>r.id===a.inspection_id)?.project??'检查记录'} · ${inspectionRevisions.find(r=>r.id===a.inspection_id)?.date??''}`:periodId?' · 本期':''}</div></div><Tag kind={a.is_final&&(!validFinalIds||validFinalIds.includes(a.id))?'ok':'default'}>{a.inspection_id&&inspectionRevisions.find(r=>r.id===a.inspection_id)?.revision!==a.inspection_revision?'旧检查内容 · 需重新生成':a.is_final?(validFinalIds&&!validFinalIds.includes(a.id)?'旧定稿已失效 · 请重新核对':'已定稿'):a.inspection_draft_id?(a.inspection_id?'已生成':'待确认草稿'):'草稿'}</Tag><div className="row"><FilePreviewButton artifact={a}/><a className="btn btn-sm" href={`/api/artifacts/${a.id}/file`}>下载</a>{a.inspection_draft_id&&<a className="btn btn-sm" href={`#/workbench?id=${workbenchId}&periodId=${periodId}&draftId=${a.inspection_draft_id}`}>继续编辑草稿</a>}{a.template_id&&!a.inspection_draft_id&&<Button size="sm" disabled={disabled||busy||!!a.inspection_id&&inspectionRevisions.find(r=>r.id===a.inspection_id)?.revision!==a.inspection_revision} onClick={()=>void run(async()=>{const r=await api.get<{values:Record<string,string>}>(`/api/artifacts/${a.id}/generation-values`);await saveContent();setGenerating({inspectionId:a.inspection_id??undefined,id:a.template_id!,name:pool.data?.items.find(t=>t.id===a.template_id)?.name??a.title,values:r.values});})}>修改 / 定稿</Button>}<Button size="sm" onClick={()=>setVersions(a.id)}>版本记录</Button></div></div>)}
  </Card>
  {generating&&<GenerateModal templateId={generating.id} templateName={generating.name} workbenchId={workbenchId} periodId={periodId} inspectionId={generating.inspectionId} initialValues={generating.values} initialInstruction={content} onClose={()=>setGenerating(null)} onSaved={refresh}/>}
  {versions&&<DocVersionsModal id={versions} onClose={()=>setVersions(null)} onChanged={refresh}/>}
 </div>;
}
