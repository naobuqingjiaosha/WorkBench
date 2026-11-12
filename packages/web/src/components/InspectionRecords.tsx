import {InspectionDrafts} from './InspectionDrafts';
import {ImportResult} from './ImportResult';
import {useRef,useState} from 'react';
import {useDirtyClose} from './useUnsavedClose';
import {api,useApi} from '../api';
import {Button,Card,Field,Input,Textarea,Select,Modal,Tag,useAction} from '../ui';
import {GenerateModal} from '../pages/GenerateModal';
interface Inspection {id:number;project:string;inspection_date:string;subject:string;content:string;result:string;rectification:string;supervisor:string;method:string;supervised_unit:string;findings:string;remarks:string;revision:number;ready:boolean;missing:string[]}
type Form=Pick<Inspection,'project'|'inspection_date'|'subject'|'content'|'result'|'rectification'|'supervisor'|'method'|'supervised_unit'|'findings'|'remarks'>;
export function InspectionRecords({periodId,workbenchId,month,templates,disabled,onChanged}:{periodId:number;workbenchId:number;month:string;templates:{id:number;name:string}[];disabled:boolean;onChanged:()=>void}){
 const data=useApi<{records:Inspection[]}>(`/api/periods/${periodId}/inspections`),{busy,run}=useAction();
 const [editing,setEditing]=useState<Inspection|null|undefined>(undefined),[generating,setGenerating]=useState<{record:Inspection;templateId:number}|null>(null);
 const extra={supervisor:'',method:'',supervised_unit:'',findings:'',remarks:''};
 const [form,setForm]=useState<Form>({project:'',inspection_date:month+'-01',subject:'',content:'',result:'',rectification:'',...extra});
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const initial=useRef('');
 const close=useDirtyClose(editing!==undefined&&JSON.stringify(form)!==initial.current,()=>setEditing(undefined));
 const edit=(r:Inspection|null)=>{const next=r?{...extra,...r}:{project:'',inspection_date:today.startsWith(month)?today:'',subject:'',content:'',result:'',rectification:'',...extra};initial.current=JSON.stringify(next);setEditing(r);setForm(next);};
 const refresh=()=>{data.reload();onChanged();};
 const set=(k:keyof Form)=>(value:string)=>setForm(a=>({...a,[k]:value}));
 return <><InspectionDrafts showWorkLink={false} key={periodId} periodId={periodId} workbenchId={workbenchId} templates={templates} onChanged={refresh}/><Card title={`已确认检查记录（${data.data?.records.length??0}）`}>
  <p className="small muted">一次检查只填一次。不同项目、多次检查分别保存，同一记录可生成适用的 Word、Excel 表册。</p>
  {data.error&&<p role="alert">检查记录加载失败：{data.error.message} <Button onClick={data.reload}>重试</Button></p>}
  {data.loading&&!data.data&&<p>正在加载检查记录…</p>}
  {!data.loading&&!data.error&&!data.data?.records.length&&<p>尚无已确认的检查事实；上方草稿可随时保存和下载。</p>}
  {data.data?.records.map(r=><RecordRow key={`${r.id}-${r.revision}`} record={r} periodId={periodId} workbenchId={workbenchId} onChanged={refresh} templates={templates} disabled={disabled||busy} onEdit={()=>edit(r)} onGenerate={templateId=>setGenerating({record:r,templateId})}/>)}
  {editing!==undefined&&<Modal open title={editing?'修改检查记录':'新增检查记录'} onClose={close} footer={<><Button onClick={close}>取消</Button><Button kind="primary" disabled={busy||!form.project.trim()||!form.inspection_date||!form.subject.trim()||!form.content.trim()||!form.result.trim()} onClick={()=>void run(async()=>{if(editing)await api.put(`/api/periods/${periodId}/inspections/${editing.id}`,{...form,revision:editing.revision});else await api.post(`/api/periods/${periodId}/inspections`,form);setEditing(undefined);refresh();})}>保存检查记录</Button></>}>
   <div className="grid grid-2"><Field label="检查项目" required><Input value={form.project} onChange={set('project')} placeholder="项目名称"/></Field><Field label="检查日期" required><Input type="date" value={form.inspection_date} onChange={set('inspection_date')}/></Field></div>
   <Field label="监督事项" required><Input value={form.subject} onChange={set('subject')}/></Field>
   <Field label="检查内容" required><Textarea value={form.content} onChange={set('content')} rows={3}/></Field>
   <Field label="检查结果" required><Textarea value={form.result} onChange={set('result')} rows={3}/></Field>
   <Field label="发现问题（单独记录；未发现问题也请据实填写）"><Textarea value={form.findings} onChange={set('findings')} rows={2}/></Field>
   <Field label="整改情况（可选）"><Textarea value={form.rectification} onChange={set('rectification')} rows={2}/></Field>
   <div className="grid grid-2"><Field label="监督人员"><Input value={form.supervisor} onChange={set('supervisor')}/></Field><Field label="监督方式"><Input value={form.method} onChange={set('method')}/></Field></div>
   <Field label="接受监督单位"><Input value={form.supervised_unit} onChange={set('supervised_unit')}/></Field>
   <Field label="备注"><Textarea value={form.remarks} onChange={set('remarks')} rows={2}/></Field>
   {editing&&<p className="small muted">修改后，原成果保留；可按更新后的记录重新生成文件。</p>}
  </Modal>}
  {generating&&<GenerateModal templateId={generating.templateId} templateName={templates.find(t=>t.id===generating.templateId)?.name} workbenchId={workbenchId} periodId={periodId} inspectionId={generating.record.id} onClose={()=>setGenerating(null)} onSaved={refresh}/>}
 </Card></>;
}
function RecordRow({record:r,templates,disabled,onEdit,onGenerate,periodId,workbenchId,onChanged}:{record:Inspection;periodId:number;workbenchId:number;onChanged:()=>void;templates:{id:number;name:string}[];disabled:boolean;onEdit:()=>void;onGenerate:(id:number)=>void}){
 const [template,setTemplate]=useState(String(templates[0]?.id??''));
 return <div className="inspection-card"><div className="row"><strong>{r.project}</strong><span>{r.inspection_date} · {r.subject}</span><Tag kind={r.ready?'ok':'default'}>{r.ready?'文件已生成':'待生成 / 内容变化待更新'}</Tag><Button size="sm" disabled={disabled} onClick={onEdit}>修改检查记录</Button></div>
 {!r.ready&&r.missing.length>0&&<p className="small notice">待完成：{r.missing.join('、')}</p>}
 <details><summary>查看检查内容</summary><p>检查内容：{r.content}</p><p>检查结果：{r.result}</p><p>整改情况：{r.rectification||'未填写'}</p><details><summary>补录已有表册</summary>{templates.map(t=><ImportResult key={t.id} templateId={t.id} name={t.name} workbenchId={workbenchId} periodId={periodId} inspectionId={r.id} inspectionRevision={r.revision} disabled={disabled} onSaved={onChanged}/>)}</details></details>
 {!disabled&&(templates.length?<div className="row"><Select value={template} onChange={setTemplate} options={templates.map(t=>({value:String(t.id),label:t.name}))}/><Button disabled={!templates.some(t=>String(t.id)===template)} onClick={()=>onGenerate(Number(template))}>生成本次检查表册</Button></div>:<p className="small muted">在下方选择适用模板后，可用此记录直接生成表册。</p>)}
 </div>;
}
