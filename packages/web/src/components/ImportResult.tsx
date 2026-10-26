import {useState} from 'react';
import {api} from '../api';
import {useAction} from '../ui';

/** A reviewed existing Office document can satisfy a requirement without regenerating history. */
export function ImportResult({workbenchId,templateId,positionCode,periodId,inspectionId,inspectionRevision,name,disabled,onSaved}:{workbenchId:number;templateId:number;positionCode?:string;periodId?:number;inspectionId?:number;inspectionRevision?:number;name:string;disabled?:boolean;onSaved:()=>void}) {
 const [reviewed,setReviewed]=useState(false),{busy,run}=useAction();
 return <div className="row small"><label><input type="checkbox" checked={reviewed} disabled={disabled||busy} onChange={e=>setReviewed(e.target.checked)}/> 已核对原文，导入为定稿</label><label>导入已有「{name}」<input type="file" accept=".docx,.xlsx" disabled={disabled||busy||!reviewed} onChange={e=>{
  const f=e.target.files?.[0];if(!f)return;
  void run(async()=>{const form=new FormData();form.append('file',f);form.append('workbenchId',String(workbenchId));form.append('templateId',String(templateId));form.append('final','true');form.append('reviewed','true');if(positionCode)form.append('positionCode',positionCode);if(periodId)form.append('periodId',String(periodId));if(inspectionId){form.append('inspectionId',String(inspectionId));form.append('inspectionRevision',String(inspectionRevision));}try{await api.upload('/api/artifacts/upload',form);setReviewed(false);}finally{onSaved();}});
 }}/></label></div>;
}
