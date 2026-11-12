import {NavIcon, SectionTitle} from '../components/DesignSystem';
import {useEffect,useRef,useState} from 'react';
import {api,useApi,type WorkType,type Template} from '../api';
import {Button,Card,Field,Input,Loading,Modal,Select,Textarea,Tag} from '../ui';
import {useEditorGuard,useNavigationGuard} from '../components/NavigationGuard';
import {WorkTypeEditor} from '../components/WorkTypeEditor';
import {TYPE_GROUPS} from '../work-type-navigation';
import type {WorkflowConfig,ConfigState,ConfigStage,ConfigPeriodMaterial} from '../../../server/src/domain/workflow-config-types';

const clone=<T,>(x:T):T=>JSON.parse(JSON.stringify(x));
const key=()=>crypto.randomUUID();
const kinds=[{value:'external',label:'外部材料（需关联与核对）'},{value:'reference',label:'参考资料'},{value:'generated',label:'生成成果'}];
const legacyKind={value:'legacy',label:'旧规则兼容（新建或改名须选择用途）'};
const emptyStage=(seq:number):ConfigStage=>({code:'S'+seq,name:'新阶段',seq,folder_name:null,period_dir:null,description:null,duration_hint:null,materials:[],evidences:[],documents:[]});
export default function ProcessPage(){
 const types=useApi<{items:WorkType[]}>('/api/work-types?includeArchived=1');const [active,setActive]=useState<number|null>(null);const guard=useNavigationGuard();
 const layout=useRef<HTMLDivElement>(null),returnType=useRef<number|null>(null);
 const back=()=>guard.request(()=>{returnType.current=active;setActive(null);});
 useEffect(()=>{
  const pane=layout.current?.querySelector<HTMLElement>('.workflow-config-pane');
  if(active!==null){
   pane?.scrollTo({top:0});
   if(pane&&window.matchMedia('(max-width: 999px)').matches){pane.focus({preventScroll:true});pane.scrollIntoView({block:'start'});}
  }else if(returnType.current!==null){
   layout.current?.querySelector<HTMLButtonElement>(`button[data-work-type="${returnType.current}"]`)?.focus();
   returnType.current=null;
  }
 },[active]);
 return <div ref={layout} className={`col workflow-config${active!==null?' workflow-config-open':''}`} style={{gap:12}}>
 <div className="workflow-toolbar"><WorkTypeEditor types={types.data?.items??[]} onDone={id=>{types.reload();setActive(id);}}/></div>
 <div className="notice notice-info">先保存草稿，再核对差异并发布配置。发布后的规则供之后新建的工作使用。</div>
 {types.error&&<div role="alert">{types.error.message}<Button onClick={types.reload}>重试列表</Button></div>}
 <div className="page-split"><Card className="workflow-type-list" title={<SectionTitle icon="chart">工作类型</SectionTitle>}>{types.loading?<Loading/>:[...TYPE_GROUPS,{value:'',label:'待确认分类'}].map(group=>{
   const entries=types.data?.items.filter(t=>(t.navigation_group??'')===group.value)??[];
   return entries.length>0&&<section key={group.value}><h4>{group.label}</h4>{entries.map(t=>{
     const status=t.archived_at?'已停用':t.published_config_id?'已发布':'未发布草稿';
     return <button type="button" key={t.id} data-work-type={t.id} aria-label={`${t.display_name||t.name} · ${status}`} aria-pressed={active===t.id} className="workflow-type-option" onClick={()=>{if(active!==t.id)guard.request(()=>setActive(t.id));}}>
       <NavIcon name={group.value==='administration'?'clipboard':group.value==='engineering'?'settings':'workbench'}/><span className="workflow-type-name">{t.display_name||t.name}</span><Tag kind={t.archived_at?'default':t.published_config_id?'ok':'warn'}>{status}</Tag></button>;
   })}</section>;
 })}</Card>
 {active?<div className="col workflow-config-pane" tabIndex={-1}><ConfigLoader key={active} id={active} changed={types.reload} back={back}/></div>:
 <Card title={<SectionTitle icon="workbench">选择工作类型</SectionTitle>} className="workflow-intro">
   <div className="workflow-intro-lead"><NavIcon name="workbench"/><h3>从工作类型中选择一项</h3><p>查看现行规则，编辑草稿，或复制一个新类型。</p></div>
   <ol>{[['编辑配置','维护类型、阶段和材料要求'],['保存草稿','可继续修改和补全'],['检查差异并发布','核对变更后供新工作采用']].map(([title,hint],i)=><li key={title}><span>{i+1}</span><div><strong>{title}</strong><small>{hint}</small></div></li>)}</ol>
 </Card>}</div></div>;
}
function ConfigLoader({id,changed,back}:{id:number;changed:()=>void;back:()=>void}){
 const loaded=useApi<ConfigState>('/api/workflow-config/'+id);
 if(loaded.loading||loaded.error||!loaded.data)return <><button className="btn workflow-back" onClick={back}>返回工作类型</button>{loaded.error?<div role="alert">{loaded.error.message}<Button onClick={loaded.reload}>重试配置</Button></div>:<Loading/>}</>;
 return <ConfigEditor initial={loaded.data} changed={changed} back={back}/>;
}
function ConfigEditor({initial,changed,back}:{initial:ConfigState;changed:()=>void;back:()=>void}){
 const [expandedStage,setExpandedStage]=useState<number|null>(null);
 const stageHeading=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  if(expandedStage!==null&&stageHeading.current){
   stageHeading.current.focus({preventScroll:true});stageHeading.current.scrollIntoView({block:'nearest'});
  }
 },[expandedStage]);
 const [state,setState]=useState(initial),[p,setP]=useState(()=>clone(initial.payload)),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
 const [latest,setLatest]=useState<ConfigState|null>(null),[preview,setPreview]=useState<{before:WorkflowConfig|null;after:WorkflowConfig;digest:string}|null>(null),[note,setNote]=useState(''),[history,setHistory]=useState(false);
 const lock=useRef(false),publishId=useRef<string|null>(null);const guard=useNavigationGuard();const templates=useApi<{items:(Template&{health_ok?:number|null})[]}>('/api/templates');
 const dirty=JSON.stringify(p)!==JSON.stringify(state.payload);const path='/api/workflow-config/'+state.typeId;
 const accept=(r:ConfigState)=>{
  if(expandedStage!==null){
   const current=p.stages[expandedStage];
   const index=r.payload.stages.findIndex(s=>current&&(current.id?s.id===current.id:s.code===current.code));
   setExpandedStage(index===-1?null:index);
  }
  setState(r);setP(clone(r.payload));setLatest(null);setPreview(null);changed();
 };
 const act=async(fn:()=>Promise<void>)=>{if(lock.current)throw Error('正在保存或发布，请稍候');lock.current=true;setBusy(true);setError('');setSuccess('');try{await fn();}catch(e){setError((e as Error).message);throw e;}finally{lock.current=false;setBusy(false);}};
 const save=()=>act(async()=>{accept(await api.post<ConfigState>(path+'/draft',{revision:state.revision,baseVersionId:state.baseVersionId,payload:p}));setSuccess('草稿已保存；已发布配置及已有工作未改变。');});
 useEditorGuard({dirty,busy,save,discard:()=>{setP(clone(state.payload));setPreview(null);}});
 const edit=(fn:(x:WorkflowConfig)=>void)=>{const next=clone(p);fn(next);setP(next);setPreview(null);setSuccess('');};
 const stage=(i:number,fn:(s:ConfigStage)=>void)=>edit(x=>fn(x.stages[i]));
 const textField=(label:string,value:string|null,onChange:(v:string)=>void)=><Field label={label}><Input value={value??''} onChange={onChange}/></Field>;
 const templateOptions=[{value:'',label:'未指定'},...(templates.data?.items??[]).map(t=>({value:String(t.id),label:t.name+(t.health_ok===0?'（不可用）':'')}))];
 const templateSelect=(value:number|null,onChange:(v:number|null)=>void)=><Select value={value===null?'':String(value)} onChange={v=>onChange(v?Number(v):null)} options={templateOptions.some(o=>o.value===String(value))||value===null?templateOptions:[...templateOptions,{value:String(value),label:`#${value}（失效引用，请处理）`}]}/>;
 const status=state.versions.find(v=>v.id===state.publishedId);
 return <div className="col workflow-config-editor" style={{gap:14}}>
 <Card className="config-version" title={p.type.name||'类型草稿'} extra={<Tag>{state.archivedAt?'已停用':status?'已发布 v'+status.version_no:'尚未发布'}</Tag>}>
 <button className="btn workflow-back" onClick={back}>返回工作类型</button>
 <p>草稿修订 {state.revision}，基于{status?'已发布 v'+status.version_no:'空白配置'}。{dirty?'本页有未保存修改。':state.hasDraft?'有已保存但未发布的草稿。':'草稿与已发布配置一致。'}</p>
 <div className="row config-buttons">  <Button kind="primary" disabled={busy||!dirty} onClick={()=>void save().catch(()=>{})}>{busy?'处理中…':'保存草稿'}</Button><Button disabled={busy||dirty||!state.hasDraft} onClick={()=>void act(async()=>{setPreview(await api.post(path+'/preview',{revision:state.revision,baseVersionId:state.baseVersionId}));publishId.current=key();}).catch(()=>{})}>检查差异并发布</Button>
 <Button disabled={busy||!state.publishedId||dirty} onClick={()=>void act(async()=>{accept(await api.post<ConfigState>(path+'/availability',{enabled:!!state.archivedAt,expectedArchivedAt:state.archivedAt,publishedId:state.publishedId}));setSuccess('类型状态已保存；已有工作、周期及历史成果不受影响。');}).catch(()=>{})}>{state.archivedAt?'恢复新建':'停用新建'}</Button>
 <Button disabled={busy} onClick={()=>setHistory(!history)}>版本记录</Button><Button disabled={busy||dirty||!state.hasDraft||!state.publishedId} onClick={()=>{if(window.confirm('放弃已保存草稿，恢复为当前已发布配置？已有工作不变。'))void act(async()=>accept(await api.post<ConfigState>(path+'/discard',{revision:state.revision,baseVersionId:state.baseVersionId}))).catch(()=>{});}}>放弃已保存草稿</Button></div>
 </Card>
 {error&&<div role="alert" className="notice notice-err">{error}。输入已保留；网络结果未知时先核对最新状态。<Button disabled={busy} onClick={()=>void act(async()=>setLatest(await api.get<ConfigState>(path))).catch(()=>{})}>核对最新状态</Button></div>}
 {success&&<div role="status" className="notice notice-info">{success}</div>}
 {latest&&<Card title="最新配置与本页比较"><ConfigDifference before={p} after={latest.payload}/><p>可采用最新内容；若保留本页，将以最新修订为基线保存本页整份配置，请先核对上方差异。</p><Button disabled={busy} onClick={()=>accept(latest)}>采用最新内容</Button><Button disabled={busy} onClick={()=>{setState(latest);setLatest(null);setPreview(null);setError('');}}>保留本页内容，以最新修订为基线</Button></Card>}
 {state.issues.length>0&&<div className="notice notice-warn">发布前待处理：{state.issues.join('；')}。可以继续保存不完整草稿。</div>}
 {history&&<div>{state.versions.map(v=><p key={v.id}>v{v.version_no} · {v.created_at} · {v.origin==='legacy-baseline'?'迁移兼容基线（不是旧实例来源证明）':'已发布'}：{v.change_note}</p>)}</div>}
 <fieldset disabled={busy} style={{border:0,padding:0,display:'grid',gap:14}}>
 <Card title={<SectionTitle icon="clipboard">类型与执行方式</SectionTitle>}><div className="grid workflow-basic-fields">{textField('类型名称',p.type.name,v=>edit(x=>{x.type.name=v;}))}<Field label="稳定编码"><Input value={p.type.code} disabled onChange={()=>{}}/></Field>
 <Field label="导航分类"><Select value={p.type.navigation_group??''} onChange={v=>edit(x=>{x.type.navigation_group=v as WorkflowConfig['type']['navigation_group'];x.type.domain=v==='administration'?'admin':'project';})} options={[{value:'',label:'待确认'},...TYPE_GROUPS]}/></Field>
 {textField('业务分类',p.type.category,v=>edit(x=>{x.type.category=v;}))}<Field label="执行方式"><Select value={p.type.mode} onChange={v=>edit(x=>{x.type.mode=v as 'process'|'document';})} options={[{value:'process',label:'阶段流程'},{value:'document',label:'文书 / 周期事务'}]}/></Field>
 <Field label="专用能力"><Select value={p.type.executor} onChange={v=>edit(x=>{x.type.executor=v as 'general'|'timesheet';})} options={[{value:'general',label:'通用材料与文书'},{value:'timesheet',label:'月度部门工时'}]}/></Field>
 {textField('图标（可选）',p.type.icon,v=>edit(x=>{x.type.icon=v||null;}))}{textField('颜色（可选）',p.type.color,v=>edit(x=>{x.type.color=v||null;}))}<Field label="列表顺序"><Input type="number" value={String(p.type.sort_order)} onChange={v=>edit(x=>{x.type.sort_order=Number(v);})}/></Field></div>
 <Field label="说明"><Textarea value={p.type.description??''} onChange={v=>edit(x=>{x.type.description=v||null;})}/></Field><p className="small muted">已使用类型不能改领域、业务分类或执行能力。月检专用能力不由名称决定，也不随复制继承。</p></Card>
 {p.legacyPeriodDefaults!==undefined&&<Card title="旧周期值无法解析"><p>原值保存在兼容基线中。请按实际要求配置新周期，或明确改为无默认周期；不会修改已有实例。</p><Button onClick={()=>{if(window.confirm('明确清除草稿中的不可解析旧周期值？历史版本和实例不改。'))edit(x=>{delete x.legacyPeriodDefaults;});}}>清除草稿中的旧周期值</Button></Card>}
 <Card title={<SectionTitle icon="clock">默认周期</SectionTitle>}><Field label="频率"><Select value={p.period?.frequency??''} onChange={v=>edit(x=>{x.period=v?{frequency:v as 'monthly'|'quarterly'|'yearly',due_month_offset:0,due_day:31,remind_days:3,steps:[],materials:[]}:null;})} options={[{value:'',label:'无独立周期'},...['monthly','quarterly','yearly'].map((v,i)=>({value:v,label:['月度','季度','年度'][i]}))]}/></Field>
 {p.period&&<><div className="grid grid-3">{(['due_month_offset','due_day','remind_days'] as const).map((k,i)=><Field key={k} label={['截止月份偏移','截止日（31为月底）','提前提醒天数'][i]}><Input type="number" value={String(p.period![k])} onChange={v=>edit(x=>{x.period![k]=Number(v);})}/></Field>)}</div><Field label="办理指导步骤（一行一步）"><Textarea value={p.period.steps.join('\n')} onChange={v=>edit(x=>{x.period!.steps=v.split('\n');})}/></Field>
 <p>材料用途与成果模板明确关联；步骤仅作指导，不代替实际业务事实。</p>
 {p.period.materials.map((m,i)=><Card key={m.key} title={'每期材料 '+(i+1)}><div className="grid grid-2">{textField('材料名称',m.title,v=>edit(x=>{x.period!.materials[i].title=v;}))}<Field label="材料用途"><Select value={m.kind} onChange={v=>edit(x=>{const a=x.period!.materials[i];a.kind=v as ConfigPeriodMaterial['kind'];if(v!=='generated')a.templateId=null;})} options={[...kinds,...m.kind==='legacy'?[legacyKind]:[]]}/></Field></div><label><input type="checkbox" checked={m.required} onChange={e=>edit(x=>{x.period!.materials[i].required=e.target.checked;})}/>必备材料</label>{m.kind==='generated'&&<Field label="成果模板">{templateSelect(m.templateId,v=>edit(x=>{x.period!.materials[i].templateId=v;}))}</Field>}<Button onClick={()=>edit(x=>{x.period!.materials.splice(i,1);})}>移出草稿</Button></Card>)}
 <Button onClick={()=>edit(x=>{x.period!.materials.push({key:key(),title:'新材料',kind:'external',required:true,templateId:null});})}>增加周期材料</Button></>}
 </Card>
 <Card title={<SectionTitle icon="chart">阶段顺序与要求</SectionTitle>}><p>调整这里只影响新工作；已有阶段的顺序、目录与材料保持原状。阶段流程与独立周期不能混用。</p>
 {p.stages.map((s,i)=><section key={s.id??'draft-'+i} className="workflow-stage">
  <button type="button" className="workflow-stage-heading" ref={expandedStage===i?stageHeading:undefined}
   aria-expanded={expandedStage===i} onClick={()=>setExpandedStage(expandedStage===i?null:i)}>
   <span aria-hidden="true">{expandedStage===i?'▾':'▸'}</span> 阶段 {i+1} · {s.name||'未命名阶段'}
  </button>
  {expandedStage===i&&<div className="workflow-stage-fields"><div className="row"><Button disabled={i===0} onClick={()=>{setExpandedStage(i-1);edit(x=>{[x.stages[i-1],x.stages[i]]=[x.stages[i],x.stages[i-1]];x.stages.forEach((s,j)=>s.seq=j+1);});}}>上移</Button><Button disabled={i===p.stages.length-1} onClick={()=>{setExpandedStage(i+1);edit(x=>{[x.stages[i+1],x.stages[i]]=[x.stages[i],x.stages[i+1]];x.stages.forEach((s,j)=>s.seq=j+1);});}}>下移</Button><Button onClick={()=>{if(window.confirm('从草稿移除此阶段？既有实例及历史版本保留。')){setExpandedStage(null);edit(x=>{x.stages.splice(i,1);x.stages.forEach((s,j)=>s.seq=j+1);});}}}>移出草稿</Button></div>
 <div className="grid grid-2"><Field label="阶段编码"><Input disabled={!!s.id} value={s.code} onChange={v=>stage(i,a=>{a.code=v;})}/></Field>{textField('阶段名称',s.name,v=>stage(i,a=>{a.name=v;}))}{textField('目录名',s.folder_name,v=>stage(i,a=>{a.folder_name=v||null;}))}{textField('目录分期格式',s.period_dir,v=>stage(i,a=>{a.period_dir=v||null;}))}{textField('建议时长',s.duration_hint,v=>stage(i,a=>{a.duration_hint=v||null;}))}</div><Field label="阶段说明"><Textarea value={s.description??''} onChange={v=>stage(i,a=>{a.description=v||null;})}/></Field>
 <h4>材料要求</h4>{s.materials.map((m,j)=><Card key={m.key} title={'材料 '+(j+1)}>{textField('名称',m.name,v=>stage(i,a=>{a.materials[j].name=v;}))}<Field label="用途"><Select value={m.kind} onChange={v=>stage(i,a=>{a.materials[j].kind=v as typeof m.kind;})} options={[...kinds,...m.kind==='legacy'?[legacyKind]:[]]}/></Field>{textField('材料分类',m.category,v=>stage(i,a=>{a.materials[j].category=v;}))}{textField('留存说明',m.retention,v=>stage(i,a=>{a.materials[j].retention=v||null;}))}{textField('提示',m.hint,v=>stage(i,a=>{a.materials[j].hint=v||null;}))}<label><input type="checkbox" checked={!!m.required} onChange={e=>stage(i,a=>{a.materials[j].required=e.target.checked?1:0;})}/>必备</label><Field label="参考模板">{templateSelect(m.template_id,v=>stage(i,a=>{a.materials[j].template_id=v;}))}</Field><Button onClick={()=>stage(i,a=>{a.materials.splice(j,1);})}>移出草稿</Button></Card>)}
 <Button onClick={()=>stage(i,a=>{a.materials.push({key:key(),name:'新材料',category:'material',kind:'external',required:1,template_id:null,retention:null,hint:null});})}>增加阶段材料</Button>
 <h4>影像要求</h4>{s.evidences.map((e,j)=><Card key={e.key} title={'影像 '+(j+1)}>{textField('影像名称',e.title,v=>stage(i,a=>{a.evidences[j].title=v;}))}<div className="grid grid-2"><Field label="最少数量"><Input type="number" value={String(e.min_count)} onChange={v=>stage(i,a=>{a.evidences[j].min_count=Number(v);})}/></Field><Field label="最多数量（可空）"><Input type="number" value={e.max_count===null?'':String(e.max_count)} onChange={v=>stage(i,a=>{a.evidences[j].max_count=v===''?null:Number(v);})}/></Field></div>{textField('拍摄要点',e.shooting_points,v=>stage(i,a=>{a.evidences[j].shooting_points=v||null;}))}{textField('拍摄角度',e.angles,v=>stage(i,a=>{a.evidences[j].angles=v||null;}))}{textField('影像提示',e.hint,v=>stage(i,a=>{a.evidences[j].hint=v||null;}))}<label><input type="checkbox" checked={!!e.required} onChange={v=>stage(i,a=>{a.evidences[j].required=v.target.checked?1:0;})}/>必备</label><Button onClick={()=>stage(i,a=>{a.evidences.splice(j,1);})}>移出草稿</Button></Card>)}
 <Button onClick={()=>stage(i,a=>{a.evidences.push({key:key(),title:'新影像',required:1,min_count:1,max_count:null,shooting_points:null,angles:null,hint:null});})}>增加影像要求</Button>
 <h4>阶段文书模板</h4>{!s.documents.length&&<p className="small muted">未指定阶段模板：新工作保持空绑定，不自动采用类型模板池；来源未知的旧实例保留原有兼容行为。</p>}{s.documents.map((d,j)=><div className="row" key={j}>{templateSelect(d.templateId,v=>stage(i,a=>{a.documents[j].templateId=v??0;}))}<label><input type="checkbox" checked={!!d.required} onChange={e=>stage(i,a=>{a.documents[j].required=e.target.checked?1:0;})}/>必须出具</label><Input value={d.note??''} placeholder="模板说明" onChange={v=>stage(i,a=>{a.documents[j].note=v||null;})}/><Button onClick={()=>stage(i,a=>{a.documents.splice(j,1);})}>移除绑定</Button></div>)}<Button onClick={()=>stage(i,a=>{a.documents.push({templateId:0,required:0,seq:(a.documents.length+1)*10,note:null});})}>增加阶段模板</Button>
 </div>}</section>)}<Button onClick={()=>{setExpandedStage(p.stages.length);edit(x=>{let n=x.stages.length+1;while(x.stages.some(s=>s.code==='S'+n))n++;x.stages.push({...emptyStage(n),seq:x.stages.length+1});});}}>增加阶段</Button></Card>
 </fieldset>
 <Modal open={!!preview} title="检查变更并发布配置" onClose={()=>{if(!busy)setPreview(null);}} footer={<><Button disabled={busy} onClick={()=>setPreview(null)}>取消</Button><Button kind="primary" disabled={busy||!note.trim()} onClick={()=>void act(async()=>{accept(await api.post<ConfigState>(path+'/publish',{revision:state.revision,baseVersionId:state.baseVersionId,note,previewDigest:preview!.digest,operationId:publishId.current}));setNote('');setSuccess('配置已发布。仅之后新建的工作采用此版本，既有实例未修改。');}).catch(()=>{})}>{busy?'发布中…':'确认发布配置'}</Button></>}>
 {preview&&<>{error&&<div role="alert" className="notice notice-err">{error}；草稿与输入保留。</div>}<p>发布后，新工作采用以下配置。在办工作、历史期次、定稿及实际完成状态不变。</p><ConfigDifference before={preview.before} after={preview.after}/><Field label="变更说明"><Textarea disabled={busy} value={note} onChange={setNote}/></Field></>}
 </Modal>
 </div>;
}
const labels:Record<string,string>={type:'类型',stages:'阶段',period:'周期',name:'名称',code:'编码',domain:'领域',category:'业务分类',navigation_group:'导航分类',mode:'执行方式',executor:'专用能力',description:'说明',icon:'图标',color:'颜色',sort_order:'顺序',seq:'顺序',folder_name:'目录名',period_dir:'分期目录',duration_hint:'时长提示',materials:'材料',evidences:'影像',documents:'模板',kind:'用途',required:'必备',title:'名称',template_id:'模板编号',templateId:'模板编号',retention:'留存说明',hint:'提示',min_count:'最少数量',max_count:'最多数量',shooting_points:'拍摄要点',angles:'角度',note:'说明',frequency:'频率',due_day:'截止日',due_month_offset:'月份偏移',remind_days:'提醒天数',steps:'步骤'};
function flat(value:unknown,path=''):Record<string,string>{if(value===null||typeof value!=='object')return {[path]:value===null?'无':String(value)};return Object.fromEntries(Object.entries(value).filter(([k])=>!['key','id','legacyTypeId','schemaVersion','digest','work_type_id','position_template_id','created_at','updated_at','archived_at'].includes(k)).flatMap(([k,v])=>Object.entries(flat(v,path+(path?' / ':'')+(labels[k]??(/^\d+$/.test(k)?String(Number(k)+1):k))))));}
function ConfigDifference({before,after}:{before:WorkflowConfig|null;after:WorkflowConfig}){const a=flat(before??{}),b=flat(after);const changed=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>a[k]!==b[k]);return changed.length?<div style={{maxHeight:360,overflow:'auto'}}><ul>{changed.map(k=><li key={k}>{k}：{a[k]??'未设置'} → {b[k]??'移除'}</li>)}</ul></div>:<p>配置内容没有差异。</p>;}
