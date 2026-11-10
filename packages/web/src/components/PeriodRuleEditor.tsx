import {useRef,useState} from 'react';
import {api} from '../api';
import {Button,Field,Input,Select,Textarea,useToast} from '../ui';
import {useEditorGuard} from './NavigationGuard';

export interface PeriodRule {
  frequency:string;first_period:string;due_month_offset:number;due_day:number;remind_days:number;
  requirements:string;steps:string;version:number;
}
const currentMonth=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());
function fields(rule:PeriodRule|null) {
  return {
    frequency:rule?.frequency??'monthly',first:rule?.first_period??currentMonth(),
    offset:String(rule?.due_month_offset??1),day:String(rule?.due_day??5),remind:String(rule?.remind_days??3),
    requirements:rule?(JSON.parse(rule.requirements) as string[]).join('\n'):'',
  };
}
type Fields=ReturnType<typeof fields>;
const labels:Record<keyof Fields,string>={frequency:'频率',first:'首个报告期',offset:'截止月份偏移',day:'截止日号',remind:'提前提醒天数',requirements:'必备材料'};
const keys=Object.keys(labels) as (keyof Fields)[];

export function PeriodRuleEditor({workbenchId,rule,onClose,onSaved}:{workbenchId:number;rule:PeriodRule|null;onClose:()=>void;onSaved:()=>void}) {
  const [base,setBase]=useState(rule),[draft,setDraft]=useState(()=>fields(rule));
  const [latest,setLatest]=useState<PeriodRule|null|undefined>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const lock=useRef(false),toast=useToast(),original=fields(base);
  const dirty=keys.some(k=>original[k]!==draft[k]);
  const change=(key:keyof Fields,value:string)=>setDraft(s=>({...s,[key]:value}));
  const save=async()=>{
    if(lock.current)throw Error('正在保存排期规则');
    if(latest!==undefined)throw Error('请先核对其他窗口保存的规则');
    lock.current=true;setBusy(true);setError('');
    try{
      const numbers=[draft.offset,draft.day,draft.remind];
      if(numbers.some(n=>!/^\d+$/.test(n)))throw Error('截止月份偏移、截止日号与提前提醒天数均需填写非负整数');
      await api.put('/api/workbenches/'+workbenchId+'/periods/rule',{
        frequency:draft.frequency,first_period:draft.first.trim(),due_month_offset:Number(draft.offset),due_day:Number(draft.day),
        remind_days:Number(draft.remind),requirements:draft.requirements.split('\n').map(s=>s.trim()).filter(Boolean),
        steps:JSON.parse(base?.steps??'[]'),expectedVersion:base?.version??null,sync:true,
      });
      onSaved();onClose();toast('排期规则已保存，已有期次保留原快照','ok');
    }catch(e){
      const problem=e as {message:string;code?:string;detail?:{current:PeriodRule|null}};
      setError(problem.message);
      if(problem.code==='PERIOD_RULE_CHANGED'&&problem.detail)setLatest(problem.detail.current);
      throw e;
    }finally{lock.current=false;setBusy(false);}
  };
  useEditorGuard({dirty,busy,save,discard:onClose});
  const reconcile=(keep:boolean)=>{
    if(latest===undefined)return;
    const updated=fields(latest);
    if(keep)for(const key of keys)if(draft[key]!==original[key])updated[key]=draft[key];
    setBase(latest);setDraft(updated);setLatest(undefined);setError('');
  };
  return <div className="col">
    <p>规则用于新期次。已有期次保留配置快照，截止日号 31 在短月份取月末。</p>
    <fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
      <div className="grid grid-3">
        <Field label="频率"><Select value={draft.frequency} onChange={v=>change('frequency',v)} options={[{value:'monthly',label:'月报'},{value:'quarterly',label:'季报'},{value:'yearly',label:'年报'}]}/></Field>
        <Field label="首个报告期（2026-09 / 2026-Q3 / 2026）"><Input value={draft.first} onChange={v=>change('first',v)}/></Field>
        <Field label="截止月份：从报告期首月偏移几个月"><Input type="number" value={draft.offset} onChange={v=>change('offset',v)}/></Field>
        <Field label="截止日号"><Input type="number" value={draft.day} onChange={v=>change('day',v)}/></Field>
        <Field label="提前提醒天数"><Input type="number" value={draft.remind} onChange={v=>change('remind',v)}/></Field>
      </div>
      <Field label="必备材料（一行一项）"><Textarea value={draft.requirements} onChange={v=>change('requirements',v)}/></Field>
    </fieldset>
    {error&&<div className="notice notice-warn" role="alert">{error}
      {latest!==undefined&&<><ul>{keys.filter(k=>fields(latest)[k]!==original[k]).map(k=><li key={k}>{labels[k]} · 已保存：{fields(latest)[k]||'空'} · 本页：{draft[k]||'空'}</li>)}</ul>
      <Button onClick={()=>reconcile(false)}>采用已保存规则</Button> <Button onClick={()=>reconcile(true)}>保留本页修改并核对</Button></>}
    </div>}
    <Button disabled={busy||latest!==undefined||!dirty&&base!==null} onClick={()=>void save().catch(()=>{})}>{busy?'正在保存规则…':'保存规则'}</Button>
  </div>;
}
