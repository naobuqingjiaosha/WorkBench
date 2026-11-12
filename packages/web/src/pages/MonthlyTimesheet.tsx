import {ProjectReportReview} from '../components/ProjectReportReview';
import {adoptProjectReport,installTimesheetTemplate,type PendingProjectReport,type AdoptedProjectReport,type ReportPreview,type TemplateProjectCatalog} from '../components/project-report-input';
import {adoptAttendance,attendanceReady,attendanceValidationKey,matchesTimesheetScope,type PendingAttendance} from '../components/timesheet-input';
import {useEditorGuard} from '../components/NavigationGuard';
import {SectionNav,LoadError} from '../components/DesignSystem';
import {useState,useEffect} from 'react';
import {api,useApi} from '../api';
import {Button,Card,Field,Input,Textarea,Select,useAction,Tag,Empty,Modal} from '../ui';
type Mapping={sheet:string;startRow:number;personColumn:number;dateHeaderRow?:number;dateStartColumn?:number;dateColumn?:number;hoursColumn?:number;statusColumn?:number;projectColumn?:number};
type Override={person:string;date:string;status:string;project?:string;hours?:number;source:string};
type Allocation={person:string;date:string;shares:Record<string,number>;reason:string};
type InputData={aliases?:Record<string,string>;peopleCandidates?:string[];pendingProjectReport?:PendingProjectReport;projectReport?:AdoptedProjectReport;projectReportHistory?:AdoptedProjectReport[];pendingAttendance?:PendingAttendance;workbenchId?:number;periodId?:number;month:string;templateId:string;rdId:string;attendanceId:string;rdMapping:Mapping;attendanceMapping:Mapping;attendanceSources:{id:string;mapping:Mapping}[];requiredPeople:string[];projects:string[];assignments:Record<string,string[]>;rdComplete:boolean;overrides:Override[];allocations:Allocation[];projectAliases?:Record<string,string>;payroll:{fullPay:boolean;workdays:number[];deductions:Record<string,number>}};
type Day={person:string;date:string;rd:number;department:number;project:string;basis:string};
type Result={days:Day[];issues:{code:string;person:string;date:string;message:string}[];personTotals:Record<string,number>;projectTotals:Record<string,number>;canFinalize:boolean};
type RecordData={id:number;artifact_id:number|null;input:InputData;result:Result;status:string};
type Profile={catalog?:TemplateProjectCatalog;messages?:string[];source:{name:string};mapping?:Mapping;people?:string[];projects?:string[];assignments?:Record<string,string[]>;workdays?:number[];sourceMonth?:string};
const map:Mapping={sheet:'工时明细表（填写）',startRow:5,personColumn:3,dateHeaderRow:3,dateStartColumn:9};
function DraftText({value,onChange,multiline=false}:{value:string;onChange:(value:string)=>void;multiline?:boolean}){
 const [text,setText]=useState(value),[focused,setFocused]=useState(false);
 useEffect(()=>{if(!focused)setText(value);},[value]);
 const props={value:text,onFocus:()=>setFocused(true),onBlur:()=>setFocused(false),onChange:(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>{setText(event.target.value);onChange(event.target.value);},className:'input'};
 return multiline?<textarea {...props} rows={4}/>:<input {...props}/>;
}
const initial=(month:string,workbenchId?:number,periodId?:number):InputData=>({workbenchId,periodId,month,templateId:'',rdId:'',attendanceId:'',rdMapping:map,attendanceMapping:{sheet:'考勤记录表',startRow:7,personColumn:2,dateHeaderRow:5,dateStartColumn:4},attendanceSources:[],requiredPeople:[],projects:[],assignments:{},rdComplete:false,overrides:[],allocations:[],payroll:{fullPay:true,workdays:[],deductions:{}}});
type MonthlyProps={workbenchId?:number;periodId?:number;runId?:number;initialMonth?:string;embedded?:boolean;boundTemplates?:{id:number;name:string}[]};
export default function MonthlyTimesheet(props:MonthlyProps){
 const period=useApi<{id:number;workbench_id:number;report_period:string}>(props.periodId?`/api/periods/${props.periodId}`:null);
 if(props.periodId){
  if(period.error)return <LoadError error={period.error} retry={period.reload}/>;
  if(!period.data)return <p role="status">正在核对所属期次…</p>;
  if(period.data.id!==props.periodId||period.data.workbench_id!==props.workbenchId||!/^20\d{2}-\d{2}$/.test(period.data.report_period))return <p role="alert">所属工作或月度期次不匹配，请返回上方重新选择期次。</p>;
 }
 const month=props.periodId?period.data!.report_period:props.initialMonth;
 return <MonthlyTimesheetForm key={`${props.workbenchId??0}-${props.periodId??0}-${month??''}`} {...props} initialMonth={month}/>;
}
function MonthlyTimesheetForm({workbenchId,periodId,runId,initialMonth,embedded=false,boundTemplates=[]}:MonthlyProps){
 const storage=`workbench-timesheet-${workbenchId??0}-${periodId??0}`;
 const [restored]=useState(()=>{
  const initialInput=initial(initialMonth??'',workbenchId,periodId);
  try {
   const saved=JSON.parse(localStorage.getItem(storage)??'null');
   if(!saved?.month||!matchesTimesheetScope(saved,{workbenchId,periodId,month:initialMonth}))
    return {input:initialInput,rejected:!!saved,hasDraft:false};
   // Old clients cached an entire run snapshot, including every parsed source cell.
   const {rd,attendance,sourceFiles,projectReportDetails,templateDigest,_runId,_names,...editable}=saved;
   const i:InputData={...initial(saved.month,workbenchId,periodId),...editable};
   if(i.pendingAttendance)delete i.pendingAttendance.validation;
   if(i.pendingProjectReport){
    i.pendingProjectReport.verified=false;i.pendingProjectReport.monthConfirmed=false;i.pendingProjectReport.mergeConfirmed=false;
    i.pendingProjectReport.choices=i.pendingProjectReport.choices.map(c=>({...c,confirmed:false}));
   }
   return {input:i,rejected:false,hasDraft:true,recordId:Number.isSafeInteger(_runId)?Number(_runId):undefined,names:_names as Record<string,string>|undefined};
  }catch{return {input:initialInput,rejected:true,hasDraft:false};}
 });
 const [input,setInput]=useState<InputData>(restored.input);
 const [referencePeople,setReferencePeople]=useState<string[]>([]);
 const [tab,setTab]=useState('people'),[selectedPerson,setSelectedPerson]=useState('');
 const [savedDraft,setSavedDraft]=useState(()=>JSON.stringify(input));
 const saveDraft=async()=>{localStorage.setItem(storage,JSON.stringify({...input,_runId:!stale?record?.id:undefined,_names:names}));setSavedDraft(JSON.stringify(input));setMessage('本机输入草稿已保存；计算结果和定稿分别处理。');};
 const [names,setNames]=useState<Record<string,string>>(restored.names??{}),[record,setRecord]=useState<RecordData|null>(null),[message,setMessage]=useState(restored.rejected?'本机草稿的工作、期次或月份不匹配，原草稿已保留但未载入。':''),[calendar,setCalendar]=useState(false),[instruction,setInstruction]=useState(''),[proposal,setProposal]=useState<Record<string,unknown>|null>(null),[person,setPerson]=useState(''),[dayEdit,setDayEdit]=useState<{day:Override;shares:string}|null>(null),[reviewed,setReviewed]=useState(false);
 const {busy,run}=useAction(),history=useApi<{items:{id:number;month:string;status:string}[]}>(`/api/timesheets?${new URLSearchParams({...workbenchId?{workbenchId:String(workbenchId)}:{},...periodId?{periodId:String(periodId)}:{}})}`);
 const templates=useApi<{items:{id:number;name:string}[]}>('/api/templates'),[library,setLibrary]=useState('');
 const [deductionError,setDeductionError]=useState('');
 const navigation=useEditorGuard({dirty:JSON.stringify(input)!==savedDraft,busy,save:saveDraft,discard:()=>{setInput(JSON.parse(savedDraft));setDayEdit(null);}});
 const stale=record&&JSON.stringify(record.input)!==JSON.stringify(input);
 useEffect(()=>{setReviewed(false);},[input,storage]);
 const load=async(id:number,showResult=false)=>{
  const r=await api.get<RecordData>(`/api/timesheets/${id}?view=edit`);
  if(!matchesTimesheetScope(r.input,{workbenchId,periodId,month:periodId?initialMonth:undefined}))throw new Error('记录不属于本工作、期次或月份');
  const i={...initial(r.input.month,workbenchId,periodId),...r.input};
  setInput(i);setRecord({...r,input:i});setCalendar(true);if(showResult)setTab('review');setProposal(null);setDayEdit(null);setSavedDraft(JSON.stringify(i));
  try{localStorage.setItem(storage,JSON.stringify({...i,_runId:id,_names:names}));}
  catch{setMessage('计算版本已保存在工作台。浏览器未能缓存输入，可从下方已保存版本继续。');}
 };
 useEffect(()=>{
  if(runId&&restored.hasDraft&&!restored.recordId){setMessage('已恢复本机输入草稿。查看其他计算结果可在已保存版本中选择。');return;}
  const target=runId??restored.recordId;
  if(target){void run(()=>load(target,true));return;}
  if(workbenchId)void api.get<{value:{people:string[]}}>(`/api/timesheets/preferences/${workbenchId}`)
   .then(p=>{if(p.value.people?.length)setReferencePeople(p.value.people);}).catch(()=>{});
 },[runId]);
 const install=async(id:string,name:string,kind:'template'|'rd')=>{
  const p=await api.post<Profile>('/api/timesheets/inspect',{id,month:input.month,kind});setNames(n=>({...n,[id]:name}));
  setInput(i=>kind==='template'?installTimesheetTemplate(i,id,p):{...i,rdId:id,rdMapping:p.mapping!,payroll:{...i.payroll,workdays:i.payroll.workdays.length?i.payroll.workdays:p.workdays??[]}});
  setMessage(`${name} 已识别${p.sourceMonth?'，资料月份 '+p.sourceMonth:''}。${kind==='rd'?'应计日期建议取自研发表有工时的日期，请结合考勤确认。':''}${(p.messages??[]).join('；')}`);if(kind==='rd')setCalendar(false);
 };
 const inspectAttendance=async(p:PendingAttendance,manual:boolean)=>{
  try{
   if(p.month!==input.month)throw Error('待核对考勤月份与当前月份不一致，请取消后重新选择');
   const result=await api.post<Profile>('/api/timesheets/inspect',{id:p.id,month:p.month,kind:'attendance',...(manual?{mapping:p.mapping}:{})});
   if(!result.mapping)throw Error('识别未返回有效映射，请人工核对');
   const checked={...p,mapping:result.mapping,error:undefined};
   setInput(i=>i.pendingAttendance?.id===p.id?{...i,pendingAttendance:{...checked,validation:{key:attendanceValidationKey(checked),people:result.people??[]}}}:i);
  }catch(e){setInput(i=>i.pendingAttendance?.id===p.id?{...i,pendingAttendance:{...p,validation:undefined,error:(e as Error).message||'识别失败，请重试'}}:i);}
 };
 const upload=(file:File|undefined,kind:'template'|'rd'|'attendance',replaceMain=false)=>{if(!file)return;void run(async()=>{if(!input.month)throw new Error('请先选择年月');if(input.pendingAttendance||input.pendingProjectReport)throw new Error('请先采用或取消待核对资料');const form=new FormData();form.append('file',file);const s=await api.upload<{id:string;name:string}>('/api/timesheets/sources',form);if(kind==='attendance'){const pending:PendingAttendance={replaceMain,id:s.id,name:s.name,month:input.month,mapping:{...initial(input.month).attendanceMapping}};setInput(i=>({...i,pendingAttendance:pending}));await inspectAttendance(pending,false);}else await install(s.id,s.name,kind);});};
 const inspectProjectReport=async(p:PendingProjectReport)=>{
  try{
   if(p.month!==input.month)throw Error('月报候选不属于当前月份，请取消后重新上传');
   const result=await api.post<{source:{id:string;name:string;digest:string};report:ReportPreview}>('/api/timesheets/inspect',{id:p.id,month:p.month,kind:'project-report'});
   if(result.source.digest!==p.digest)throw Error('月报来源已变化，请重新上传');
   const template=input.templateId?await api.post<Profile>('/api/timesheets/inspect',{id:input.templateId,month:input.month,kind:'template'}):undefined;
   setInput(i=>i.pendingProjectReport?.id===p.id?{...i,pendingProjectReport:{...p,preview:result.report,verified:true,error:undefined,monthConfirmed:false,mergeConfirmed:false,catalog:template?.catalog,formalNames:[...new Set([...(template?.projects??[]),...(template?.catalog?.items.map(c=>c.name)??[])])],choices:result.report.rows.map(row=>{const old=p.choices.find(c=>c.key===row.key&&c.name===row.name);return {key:row.key,name:row.name,target:old?.target??'',alias:old?.alias??false,selected:old?.selected??false,confirmed:false};})}}:i);
  }catch(e){setInput(i=>i.pendingProjectReport?.id===p.id?{...i,pendingProjectReport:{...p,verified:false,monthConfirmed:false,error:(e as Error).message}}:i);}
 };
 const uploadProjectReport=(file:File|undefined)=>{if(!file)return;void run(async()=>{
  if(!input.month)throw Error('请先选择办理年月');if(input.pendingAttendance||input.pendingProjectReport)throw Error('请先采用或取消待核对资料');
  if(!/\.xlsx$/i.test(file.name))throw Error('本月项目月报须为XLSX文件');
  const form=new FormData();form.append('file',file);const source=await api.upload<{id:string;name:string;digest:string}>('/api/timesheets/sources',form);
  const pending:PendingProjectReport={...source,month:input.month,choices:[],monthConfirmed:false,mergeConfirmed:false};
  setInput(i=>({...i,pendingProjectReport:pending}));await inspectProjectReport(pending);
 });};
 const calculate=()=>run(async()=>{if(input.pendingAttendance||input.pendingProjectReport)throw new Error('请先采用或取消待核对资料');if(periodId&&input.month!==initialMonth)throw new Error('月份必须与所属期次一致');if(!input.requiredPeople.length)throw new Error('请先核对并填写本月明确参与名单，来源人员不会自动纳入');if(deductionError)throw new Error(deductionError);if(!calendar||!input.rdComplete)throw new Error('请先核对应计薪日期和研发资料完整性');const r=await api.post<Result&{id:number}>('/api/timesheets',input);await load(r.id);history.reload();setTab('review');setMessage('已重新计算并保存，其他逐日修改保留。');});
 const apply=async(patch:Record<string,unknown>)=>{if(!record||stale)throw new Error('请先计算保存当前输入，再调整这次结果');const r=await api.post<{id:number}>(`/api/timesheets/${record.id}/edit`,patch);await load(r.id);history.reload();setMessage('修改已写入新记录，汇总与导出已重新计算。');};
 return <div className={`col timesheet-workspace${embedded?' timesheet-inline':''}`} data-tab={tab} style={{gap:20}}><Card className="timesheet-input-card" title={embedded?`部门月度工时 · ${input.month}`:undefined}> <div className="view-tabs mt16">{[['people','人员与项目'],['daily','逐日分配'],['review','核对结果']].map(([v,label])=><button key={v} className={tab===v?'selected':''} onClick={()=>setTab(v)}>{label}</button>)}</div>{tab==='people'&&<><fieldset className="timesheet-input-scroll" disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}>
  <div className="row timesheet-scope"><Field label="数据月份"><Input type="month" disabled={!!periodId} value={input.month} onChange={month=>{if(periodId)return;navigation(()=>{setInput({...initial(month,workbenchId,periodId),templateId:input.templateId,peopleCandidates:input.requiredPeople,projects:input.projects,assignments:input.assignments});setRecord(null);setCalendar(false);});}}/></Field>{periodId&&<span className="small muted">{embedded?'月份随所属期次，换月请使用上方期次选择。':'月份随所属期次，请先返回所属工作再选择月份。'}</span>}</div>
  <p className="timesheet-next" role="status"><strong>下一步：</strong>{input.pendingProjectReport?'核对月报项目与正式名称后采用，或取消保留原输入':input.pendingAttendance?'核对新考勤映射后采用，或取消并保留原输入':!input.month?'选择本次办理月份':!input.rdId?'上传研发中心工时表':!input.templateId?'上传部门工时模板或上期部门表，并核对本月项目':!input.attendanceId?'上传本月员工、外包考勤':!input.requiredPeople.length||!input.projects.length?'核对本月人员与正式项目名称':!calendar||!input.rdComplete?'核对应计日期并确认研发资料完整':!record||stale?'生成并核对工时表':'查看逐日分配和核对结果，确认后导出'}</p>
  {message&&<p role="status">{message}</p>}
  <section className="timesheet-source-panel"><h4>来源资料 · {[input.rdId,input.attendanceId,input.templateId].filter(Boolean).length} 份主资料</h4>{boundTemplates.length>0&&<div className="notice"><strong>{periodId?'本期':'本工作'}已绑定模板</strong><p className="small">选择适用的部门工时Excel模板作为计算输出格式，仍需核对本月人员、项目和日期。</p><div className="row">{boundTemplates.map(t=><Button key={t.id} disabled={busy||!input.month||!!input.pendingProjectReport||!!input.pendingAttendance} onClick={()=>void run(async()=>{const s=await api.post<{id:string;name:string}>(`/api/timesheets/library/${t.id}`,{});await install(s.id,s.name,'template');})}>使用 {t.name}</Button>)}</div></div>}<div className="timesheet-uploads">{([
    {kind:'rd',label:'研发中心工时表',id:input.rdId},
    {kind:'attendance',label:'考勤资料',id:input.attendanceId},
    {kind:'template',label:'统一模板 / 上期部门工时表',id:input.templateId},
  ] as const).map(c=><label className="source-upload" key={c.kind}>
    <span className="source-format" aria-hidden="true">X</span>
    <span className="source-name"><strong>{c.label}</strong><small>{c.id?names[c.id]??'已保存资料副本':'选择 Excel 文件'}</small></span>
    <span className="source-pick">{c.kind==='attendance'&&c.id?'补充考勤':c.id?'重新选择':'选择文件'}</span>
    <input aria-label={c.label} type="file" accept=".xlsx,.xls" disabled={busy||!input.month||!!input.pendingAttendance||!!input.pendingProjectReport} onChange={e=>{const file=e.target.files?.[0];e.target.value='';upload(file,c.kind);}}/>
  </label>)}</div>
  {input.pendingAttendance&&<div className="notice" role="region" aria-label="待核对考勤"><strong>待核对考勤：{input.pendingAttendance.name}</strong><p>副本已上传保存，尚未采用；{input.pendingAttendance.replaceMain?'验证并采用后替换主考勤，其他补充考勤保持；此前原输入不变。':input.attendanceId?'原主考勤及补充考勤仍保留，采用后添加为补充考勤。':'验证后将作为主考勤。'}取消只撤下本次待采用输入，不删除上传副本。</p>
   {input.pendingAttendance.error&&<p role="alert">{input.pendingAttendance.error}</p>}
   {(['sheet','startRow','personColumn','dateHeaderRow','dateStartColumn','dateColumn','statusColumn','projectColumn'] as const).map(field=><Field key={field} label={{sheet:'工作表名称',startRow:'数据起始行',personColumn:'姓名列号',dateHeaderRow:'日期标题行（横表）',dateStartColumn:'首日列号（横表）',dateColumn:'日期列号（逐行表）',statusColumn:'考勤状态列号（逐行表）',projectColumn:'项目列号（可选）'}[field]}><Input value={String(input.pendingAttendance!.mapping[field]??'')} onChange={v=>setInput(i=>({...i,pendingAttendance:{...i.pendingAttendance!,validation:undefined,mapping:{...i.pendingAttendance!.mapping,[field]:field==='sheet'?v:v===''?undefined:Number(v)}}}))}/></Field>)}
   <p className="small">横向日期表填写日期标题行和首日列；逐行表请清空这两项，填写日期列和考勤状态列。行列编号从1开始。</p>
   {attendanceReady(input.pendingAttendance,input.month)&&<p role="status">映射验证通过，识别人员：{input.pendingAttendance.validation!.people.join('、')}。请核对后采用。</p>}
   <div className="row"><Button onClick={()=>void run(()=>inspectAttendance(input.pendingAttendance!,false))}>重新自动识别</Button><Button onClick={()=>void run(()=>inspectAttendance(input.pendingAttendance!,true))}>验证手动映射</Button><Button disabled={!attendanceReady(input.pendingAttendance,input.month)} onClick={()=>void run(async()=>{const pending=input.pendingAttendance!;setInput(adoptAttendance(input));setNames(n=>({...n,[pending.id]:pending.name}));setMessage('新考勤已采用，请重新计算并核对；原有其他输入保留。');})}>采用此考勤</Button><Button onClick={()=>{setInput(i=>{const {pendingAttendance:_,...rest}=i;return rest;});setMessage('已取消本次待采用考勤，原输入保留；上传副本未删除。');}}>取消本次考勤</Button></div>
  </div>}
  <div className="supplemental-sources">
  <Field label="本月项目月报（可选 XLSX）"><input type="file" accept=".xlsx" disabled={busy||!input.month||!!input.pendingAttendance||!!input.pendingProjectReport} onChange={e=>{const file=e.target.files?.[0];e.target.value='';uploadProjectReport(file);}}/></Field>
  {input.projectReport&&<div className="source-review"><p>已采用月报：{input.projectReport.sourceName??input.projectReport.id} · {input.projectReport.month} · {input.projectReport.choices.length}项来源选择；保留{input.projectReportHistory?.length??0}份此前采用来源。人员参与须另行核对。</p><Button disabled={busy||!!input.pendingAttendance||!!input.pendingProjectReport} onClick={()=>void run(async()=>{const current=input.projectReport!;const pending:PendingProjectReport={id:current.id,name:current.sourceName??'已保存月报',digest:current.digest,month:current.month,monthConfirmed:false,mergeConfirmed:false,choices:current.choices.map(c=>({...c,selected:true,confirmed:false}))};setInput(i=>({...i,pendingProjectReport:pending}));await inspectProjectReport(pending);})}>重新核对此月报（读取当前模板名称）</Button></div>}
  {input.pendingProjectReport&&<ProjectReportReview pending={input.pendingProjectReport} formalNames={[...input.projects,...(input.pendingProjectReport.formalNames??[])]} catalog={input.pendingProjectReport.catalog} onChange={pendingProjectReport=>setInput(i=>({...i,pendingProjectReport}))} onRetry={()=>void run(()=>inspectProjectReport(input.pendingProjectReport!))} onAdopt={()=>void run(async()=>{setInput(adoptProjectReport(input));setMessage('月报所选项目已补入清单；原项目、人员参与与未涉及简称保留。请逐人核对参与项目，再计算。');})} onCancel={()=>{setInput(i=>{const {pendingProjectReport:_,...rest}=i;return rest;});setMessage('已取消本次月报，原输入与上传副本保留。');}}/>}

  {input.attendanceSources.map((s,n)=><p key={s.id}>补充考勤 {n+1}：{names[s.id]??'已保存副本'} <Button disabled={!!input.pendingAttendance} size="sm" onClick={()=>setInput({...input,attendanceSources:input.attendanceSources.filter(x=>x.id!==s.id)})}>移除此输入</Button></p>)}
  {input.attendanceId&&<Field label="替换主考勤（保留补充考勤）"><input type="file" accept=".xlsx,.xls" disabled={busy||!!input.pendingAttendance||!!input.pendingProjectReport} onChange={e=>{const file=e.target.files?.[0];e.target.value='';upload(file,'attendance',true);}}/></Field>}
  <details><summary>从现有模板库选择</summary><Select value={library} onChange={setLibrary} options={[{value:'',label:'选择部门工时模板'},...(templates.data?.items??[]).filter(t=>/工时/.test(t.name)).map(t=>({value:String(t.id),label:t.name}))]}/><Button disabled={busy||!library||!input.month||!!input.pendingProjectReport||!!input.pendingAttendance} onClick={()=>void run(async()=>{const s=await api.post<{id:string;name:string}>(`/api/timesheets/library/${library}`,{});await install(s.id,s.name,'template');})}>使用模板</Button></details>
  <details><summary>规则与历史参考</summary><p>模板适配所选月份；名单与应计日期需逐月核对。应计日先扣研发与明确扣薪，再按整小时均分部门项目；余数依所列参与项目顺序分配，可逐日手动改份额。未知项目保留待核对。</p></details>
  </div></section><div hidden={tab!=='people'}>
  <p role="status">{input.requiredPeople.length?'仅处理下方明确名单；来源中其他人员不会自动纳入。':'本月尚无明确名单。来源候选不是已确认范围，请核对后在下方名单填写需要纳入的人员。'}</p>
  {!!input.peopleCandidates?.length&&<p className="small">来源人员候选（模板或切月参考，未自动纳入）：{input.peopleCandidates.join('、')}</p>}
  {!!referencePeople.length&&<p className="small">历史名单参考（须重新确认本月范围）：{referencePeople.join('、')}</p>}
  {!input.requiredPeople.length&&[{'label':'模板或上期候选','people':input.peopleCandidates},{'label':'历史名单','people':referencePeople}].map(({label,people})=>people?.length?<Button key={label} size="sm" onClick={()=>setInput(i=>({...i,requiredPeople:[...new Set(people)]}))}>确认采用{label}（{people.length}人）</Button>:null)}
  <div className="grid grid-2 timesheet-roster"><Field label="本月明确参与名单（一行一人，填写即确认范围）"><DraftText multiline value={input.requiredPeople.join('\n')} onChange={v=>setInput({...input,requiredPeople:v.split('\n').map(x=>x.trim()).filter(Boolean)})}/></Field><Field label="本月部门项目（一行一个正式项目名）"><DraftText multiline value={input.projects.join('\n')} onChange={v=>setInput({...input,projects:v.split('\n').map(x=>x.trim()).filter(Boolean)})}/></Field></div>
  <Field label="实际应计薪日期（日号，用空格或逗号分隔）"><DraftText value={input.payroll.workdays.join(', ')} onChange={v=>{setCalendar(false);setInput({...input,payroll:{...input.payroll,workdays:v.split(/[,，\s]+/).filter(Boolean).map(Number)}});}}/></Field>
  <label><input type="checkbox" checked={calendar} onChange={e=>setCalendar(e.target.checked)}/> 已按本月资料核对以上日期，包括调休上班和节假日；不是直接按周一至周五推算</label><br/>
  <label><input type="checkbox" checked={input.rdComplete} onChange={e=>setInput({...input,rdComplete:e.target.checked})}/> 已确认研发资料完整，未列人员或日期表示零研发工时</label>
  <details><summary>人员参与项目、扣薪例外与数据映射</summary>
   {input.requiredPeople.map(p=><Field key={p} label={`${p} 参与项目（普通坐班自动均分）`}><select multiple value={input.assignments[p]??[]} onChange={e=>setInput({...input,assignments:{...input.assignments,[p]:Array.from(e.target.selectedOptions,o=>o.value)}})} style={{width:'100%',minHeight:80}}>{input.projects.map(p=><option key={p}>{p}</option>)}</select></Field>)}
   <p>出差、驻场等明确项目请在生成结果逐日指定；项目不明确会保留待核对，不把历史脚本比例固定使用。</p>
   <Field label="扣薪例外（姓名|YYYY-MM-DD=扣薪小时，一行一条）"><DraftText multiline value={Object.entries(input.payroll.deductions).map(([k,v])=>`${k}=${v}`).join('\n')} onChange={v=>{setDeductionError(v.split('\n').filter(x=>x.trim()).some(x=>!/^.+\|20\d{2}-\d{2}-\d{2}=\d+(?:\.\d+)?$/.test(x.trim()))?'扣薪例外格式不完整，请按 姓名|YYYY-MM-DD=小时 填写':'');setInput({...input,payroll:{...input.payroll,deductions:Object.fromEntries(v.split('\n').filter(x=>x.includes('=')).map(x=>{const [key,h]=x.split('=');return [key?.trim(),Number(h)];}))}});}}/></Field>
   <Field label="来源姓名别名（来源姓名=本月名单姓名，一行一条）"><DraftText multiline value={Object.entries(input.aliases??{}).map(([from,to])=>`${from}=${to}`).join('\n')} onChange={v=>setInput({...input,aliases:Object.fromEntries(v.split('\n').filter(x=>x.includes('=')).map(x=>{const at=x.indexOf('=');return [x.slice(0,at).trim(),x.slice(at+1).trim()];}))})}/></Field>
   <Field label="考勤项目简称对应关系（简称=已确认项目，一行一条）"><DraftText multiline value={Object.entries(input.projectAliases??{}).map(([k,v])=>`${k}=${v}`).join('\n')} onChange={v=>setInput({...input,projectAliases:Object.fromEntries(v.split('\n').filter(x=>x.includes('=')).map(x=>{const at=x.indexOf('=');return [x.slice(0,at).trim(),x.slice(at+1).trim()];}))})}/></Field>
   {(['rdMapping','attendanceMapping'] as const).map(k=><Field key={k} label={k==='rdMapping'?'研发识别映射':'已采用主考勤映射（不作用于待核对副本）'}><p>{input[k].sheet}</p>{(['sheet','startRow','personColumn','dateHeaderRow','dateStartColumn'] as const).map(field=><Field key={field} label={{sheet:'工作表',startRow:'数据起始行',personColumn:'姓名列号',dateHeaderRow:'日期行',dateStartColumn:'首日列号'}[field]}><Input disabled={k==='attendanceMapping'&&!!input.pendingAttendance} value={String(input[k][field]??'')} onChange={v=>setInput({...input,[k]:{...input[k],[field]:field==='sheet'?v:Number(v)}})}/></Field>)}</Field>)}
  </details>
  </div></fieldset><div className="action-dock"><Tag kind={JSON.stringify(input)!==savedDraft?'warn':'ok'}>{JSON.stringify(input)!==savedDraft?'输入有修改':'输入草稿已保存'}</Tag><div className="spacer"/><Button disabled={busy} onClick={()=>void run(saveDraft)}>保存输入草稿</Button><Button kind="primary" disabled={busy||!!input.pendingAttendance||!!input.pendingProjectReport||!input.templateId||!input.rdId||!input.attendanceId||!input.requiredPeople.length||!input.projects.length||!calendar||!input.rdComplete} onClick={()=>void calculate()}>{busy?'计算中…':record?'重新计算并保存':'生成并核对工时表'}</Button></div></>}
 {tab!=='people'&&message&&<p role="status">{message}</p>}</Card>
 {!record&&tab!=='people'&&<Card><Empty text="提供资料并确认人员和日期后，生成可核对的工时结果。" action={<Button onClick={()=>setTab('people')}>返回人员与项目</Button>}/></Card>}
 {record&&<Card className="timesheet-results" title={tab==='daily'?'逐日分配':'人员、项目与核对结果'} extra={<Tag kind={record.status==='final'?'ok':'warn'}>{record.status==='final'?'已定稿':'核对稿'} · 版本 {record.id}</Tag>}><div className="timesheet-results-scroll">
  {stale&&<p role="alert">输入已改变，请重新生成后再修改或导出。</p>}
  <p>部门合计 {Object.values(record.result.personTotals).reduce((s,v)=>s+v,0).toFixed(2)} 小时；研发合计 {record.result.days.reduce((s,d)=>s+d.rd,0)} 小时；{record.result.issues.length} 项待核对。</p>
  <div hidden={tab==='daily'}><div className="grid grid-2"><div>{Object.entries(record.result.personTotals).map(([p,h])=><p key={p}>{p}：部门 {h} + 研发 {record.result.days.filter(d=>d.person===p).reduce((s,d)=>s+d.rd,0)} 小时</p>)}</div><div>{Object.entries(record.result.projectTotals).map(([p,h])=><p key={p}>{p}：{h.toFixed(2)} 小时</p>)}</div></div>
  <div className="row"><Input value={person} onChange={setPerson} placeholder="要加入的人员姓名"/><Button disabled={busy||!person.trim()||!!stale} onClick={()=>void run(async()=>{await apply({peopleToAdd:[person.trim()]});setPerson('');})}>添加人员并匹配资料</Button></div>
  <Field label="告诉模型怎么调整"><Textarea value={instruction} onChange={setInstruction} placeholder="例如：加入一位已确认参与的人员；调整某人某天的部门项目工时"/></Field><Button disabled={busy||!instruction.trim()||!!stale} onClick={()=>void run(async()=>{const r=await api.post<{patch:Record<string,unknown>}>(`/api/timesheets/${record.id}/suggest`,{instruction});setProposal(r.patch);})}>生成修改建议</Button>
  {proposal&&<div className="notice"><p>核对模型提出的具体修改；采用后重新计算并生成新版本。</p><p>{String(proposal.reason??'请核对下列改动')}</p><details><summary>查看本次修改明细</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(proposal,null,2)}</pre></details><Button disabled={busy||!!stale} onClick={()=>void run(()=>apply(proposal))}>采用修改并重新计算</Button></div>}
  <details open={record.result.issues.length>0}><summary>需要补充或核对的问题</summary><div >{record.result.issues.map((i,n)=><p key={n}>{i.person} {i.date}：{i.message} {i.person&&i.date&&<Button size="sm" disabled={busy||!!stale} onClick={()=>{setDayEdit({day:{person:i.person,date:i.date,status:'work',source:'',project:''},shares:''});}}>修改此日</Button>}</p>)}</div></details>
  </div><div className="daily-split"><SectionNav value={selectedPerson} onChange={setSelectedPerson} items={[{value:'',label:'全部人员'},...Object.keys(record.result.personTotals).map(p=>({value:p,label:p}))]}/><div style={{overflowX:'auto'}}><table className="table"><thead><tr><th>人员</th><th>日期</th><th>研发</th><th>部门</th><th>项目</th><th>修改</th></tr></thead><tbody>{record.result.days.filter(d=>!selectedPerson||d.person===selectedPerson).map((d,n)=><tr key={n}><td>{d.person}</td><td>{d.date}</td><td>{d.rd}</td><td>{d.department}</td><td>{d.project}</td><td><Button size="sm" disabled={busy||!!stale} onClick={()=>{const days=record.result.days.filter(x=>x.person===d.person&&x.date===d.date);setDayEdit({day:{person:d.person,date:d.date,status:'work',hours:days.reduce((s,x)=>s+x.department,0),project:d.project,source:''},shares:days.filter(x=>x.project).map(x=>`${x.project}=${x.department}`).join('\n')});}}>调整</Button></td></tr>)}</tbody></table></div></div>

  </div><div className="row timesheet-result-actions"><Button disabled={!!stale} onClick={()=>api.download(`/api/timesheets/${record.id}/export`)}>{record.status==='final'?(record.artifact_id?'下载已定稿文件':'下载历史重建核对稿'):'导出核对稿'}</Button>{record.status!=='final'&&<><label><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/> 已核对 Excel 与原始资料</label><Button disabled={busy||!!stale||!reviewed||!record.result.canFinalize||record.status==='final'} onClick={()=>void run(async()=>{await api.post(`/api/timesheets/${record.id}/finalize`,{reviewed:true});await load(record.id);history.reload();})}>保存核对后的定稿</Button></>}</div>
 </Card>}
 {dayEdit&&<DayAdjustmentEditor initial={dayEdit} projects={input.projects} busy={busy} onClose={()=>setDayEdit(null)}
  onSave={patch=>void run(()=>apply(patch))}/>}
 <Card className="timesheet-history" title="已保存的工时版本" collapsible defaultOpen={false}>{history.error&&<LoadError error={history.error} retry={history.reload}/>} {history.data?.items.map(r=><p key={r.id}><Button onClick={()=>navigation(()=>void run(()=>load(r.id,true)))}>{r.month} · {r.status==='final'?'已定稿':'核对记录'} · 版本 {r.id}</Button></p>)}</Card></div>;
}

function DayAdjustmentEditor({initial,projects,busy,onSave,onClose}:{
 initial:{day:Override;shares:string};projects:string[];busy:boolean;
 onSave:(patch:Record<string,unknown>)=>void;onClose:()=>void;
}){
 const [day,setDay]=useState(initial.day),[shares,setShares]=useState(initial.shares);
 const [error,setError]=useState('');
 const request=useEditorGuard({dirty:JSON.stringify(day)!==JSON.stringify(initial.day)||shares!==initial.shares,busy,discard:onClose},'editor');
 const close=()=>{if(!busy)request(onClose);};
 const saveShares=()=>{
  const values:Record<string,number>=Object.create(null);
  for(const line of shares.split('\n').filter(line=>line.trim())){
   const at=line.lastIndexOf('='),name=line.slice(0,at).trim(),hours=line.slice(at+1).trim();
   if(at<1||!name||!/^\d+$/.test(hours)){setError('请按 项目=非负整数小时 填写');return;}
   if(Object.hasOwn(values,name)){setError('同一项目只能填写一次');return;}
   values[name]=Number(hours);
  }
  setError('');
  onSave({allocations:[{person:day.person,date:day.date,shares:values,reason:day.source}]});
 };
 return <div className="timesheet-day-drawer"><Modal open title={`逐日调整 · ${day.person} · ${day.date}`} onClose={close}
  footer={<Button disabled={busy} onClick={close}>取消此日编辑</Button>}>
  <fieldset disabled={busy}>
   <Field label="修改依据"><Input value={day.source} onChange={source=>setDay({...day,source})}/></Field>
   <Field label="部门小时（研发扣除后；修改总数须提供依据）"><Input type="number" value={String(day.hours??'')} onChange={v=>setDay({...day,hours:v===''?undefined:Number(v)})}/></Field>
   <Field label="明确归属项目"><Select value={day.project??''} onChange={project=>setDay({...day,project})} options={[{value:'',label:'按参与项目自动分配'},...projects.map(p=>({value:p,label:p}))]}/></Field>
   <Button disabled={!day.source.trim()} onClick={()=>onSave({overrides:[day]})}>保存此日工时和项目</Button>
   <Field label="仅调整项目份额（项目=整数小时，一行一个，总数不变）"><Textarea value={shares} onChange={v=>{setShares(v);setError('');}}/></Field>
   {error&&<p className="notice notice-err" role="alert">{error}</p>}
   <Button disabled={!day.source.trim()} onClick={saveShares}>保持总工时，更新分配</Button>
  </fieldset>
 </Modal></div>;
}
