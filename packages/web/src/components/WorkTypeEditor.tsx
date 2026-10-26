import {useState} from 'react';
import {api,type WorkType} from '../api';
import {Button,Field,Input,Modal,Select,Textarea,useAction} from '../ui';
import {TYPE_GROUPS,type NavigationGroup} from '../work-type-navigation';
import {useUnsavedClose} from './useUnsavedClose';

export function WorkTypeEditor({type,onDone,defaultGroup='administration'}:{type?:WorkType;defaultGroup?:NavigationGroup;onDone:(id:number,group?:NavigationGroup)=>void}) {
 const [open,setOpen]=useState(false),{busy,run}=useAction();
 const [group,setGroup]=useState<NavigationGroup|''>(type ? type.navigation_group??'' : defaultGroup);
 const domain=group==='administration'?'admin':'project';
 const [code,setCode]=useState(type?.code??''),[name,setName]=useState(type?.name??''),[category,setCategory]=useState(type?.category??TYPE_GROUPS.find(g=>g.value===defaultGroup)!.label),[mode,setMode]=useState(type?.mode??(defaultGroup==='administration'?'document':'process')),[description,setDescription]=useState(type?.description??''),[executor,setExecutor]=useState(type?.executor??'general');
 const defaults=type?.period_defaults?JSON.parse(type.period_defaults):null;
 const [frequency,setFrequency]=useState(defaults?.frequency??''),[offset,setOffset]=useState(String(defaults?.due_month_offset??0)),[day,setDay]=useState(String(defaults?.due_day??31)),[remind,setRemind]=useState(String(defaults?.remind_days??3)),[requirements,setRequirements]=useState((defaults?.requirements??[]).join('\n'));
 const [steps,setSteps]=useState((defaults?.steps??[]).join('\n'));
 const close=useUnsavedClose({group,code,name,category,mode,description,executor,frequency,offset,day,remind,requirements,steps},()=>{
   setGroup(type?type.navigation_group??'':defaultGroup);setCode(type?.code??'');setName(type?.name??'');
   setCategory(type?.category??TYPE_GROUPS.find(g=>g.value===defaultGroup)!.label);setMode(type?.mode??(defaultGroup==='administration'?'document':'process'));
   setDescription(type?.description??'');setExecutor(type?.executor??'general');setFrequency(defaults?.frequency??'');
   setOffset(String(defaults?.due_month_offset??0));setDay(String(defaults?.due_day??31));setRemind(String(defaults?.remind_days??3));
   setRequirements((defaults?.requirements??[]).join('\n'));setSteps((defaults?.steps??[]).join('\n'));setOpen(false);
 });
 const save=()=>run(async()=>{
   const payload={code,name,domain,category,mode,description,executor,navigationGroup:group,periodDefaults:mode==='document'&&frequency?{frequency,due_month_offset:Number(offset),due_day:Number(day),remind_days:Number(remind),requirements:requirements.split('\n').map((v:string)=>v.trim()).filter(Boolean),steps:steps.split('\n').filter(Boolean)}:null};
   const r=type?await api.put<{id:number}>(`/api/work-types/${type.id}`,payload):await api.post<{id:number}>('/api/work-types',payload);
   setOpen(false);onDone(r.id,group||undefined);
 });
 return <><Button size="sm" onClick={()=>setOpen(true)}>{type?'编辑类型与默认规则':'＋ 新增工作类型'}</Button><Modal open={open} title={type?'编辑工作类型':'新增工作类型'} onClose={close} footer={<><Button onClick={close}>取消</Button><Button kind="primary" disabled={busy||!group||!code.trim()||!name.trim()||!category.trim()} onClick={()=>void save()}>保存</Button></>}>
 <p>领域和分类用于组织工作，执行方式决定是否创建阶段。规则修改仅影响新工作；已有工作保留自己的要求和目录。</p>
 <Field label="导航分类" required hint="仅用于查找和选择；各类型仍保留独立流程。"><Select value={group} placeholder="请选择分类" onChange={v=>setGroup(v as NavigationGroup)} options={type?TYPE_GROUPS.filter(g=>type.domain==='admin'?g.value==='administration':g.value!=='administration'):TYPE_GROUPS}/></Field>
 <Field label="业务分类" hint={domain==='admin'?'安全管理、清廉工程、部门综合管理、临时工作':group==='engineering'?'工程施工、工程安装、工程技术服务等':'软件研发、系统集成、信息技术服务等'}><Input value={category} onChange={setCategory}/></Field>
 <Field label="类型编码"><Input value={code} onChange={setCode} disabled={!!type}/></Field><Field label="类型名称"><Input value={name} onChange={setName}/></Field>
 <Field label="执行方式" hint="已创建工作后不可更改执行方式；需要另一种方式时新建类型。"><Select value={mode} onChange={setMode} disabled={!!type?.workbench_count} options={[{value:'document',label:'文书 / 简单事务（可配置周期）'},{value:'process',label:'阶段流程（可配置阶段及要求）'}]}/></Field>
 <Field label="专用办理能力"><Select value={executor} onChange={v=>setExecutor(v as 'general'|'timesheet')} options={[{value:'general',label:'通用办理与文书'},{value:'timesheet',label:'部门工时计算与 Excel 成果'}]}/></Field>
 {mode==='document'&&<><Field label="默认周期"><Select value={frequency} onChange={setFrequency} options={[{value:'',label:'无默认周期 / 单次工作'},{value:'monthly',label:'月度'},{value:'quarterly',label:'季度'},{value:'yearly',label:'年度'}]}/></Field>{frequency&&<><div className="grid grid-3"><Field label="截止月份偏移"><Input type="number" value={offset} onChange={setOffset}/></Field><Field label="截止日（31 表示月底）"><Input type="number" value={day} onChange={setDay}/></Field><Field label="提前提醒天数"><Input type="number" value={remind} onChange={setRemind}/></Field></div><Field label="每期必备材料（一行一项）"><Textarea value={requirements} onChange={setRequirements}/></Field><Field label="每期办理步骤（一行一步）"><Textarea value={steps} onChange={setSteps}/></Field></>}</>}
 <Field label="说明"><Textarea value={description} onChange={setDescription}/></Field></Modal></>;
}
