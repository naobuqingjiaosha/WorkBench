import {useRef,useState,type ReactNode} from 'react';
import {api,type Template} from '../api';
import {Button,Card,Field,Select,useToast} from '../ui';
import {useEditorGuard} from './NavigationGuard';

type Selected=Record<number,{required:boolean;materialId:number|null}>;
type Choice={id:number;required?:boolean;materialId?:number|null};
const selectionOf=(choices:Choice[]):Selected=>Object.fromEntries(choices.map(t=>[t.id,{required:Boolean(t.required),materialId:t.materialId??null}]));
export function TemplateChoices({workbenchId,periodId,templates,options,loading,loadError,reload,materials,disabled,saveContent,onChanged,children}:{
  workbenchId:number;periodId?:number;templates:Choice[];options:Template[];loading:boolean;loadError?:string;reload:()=>void;
  materials:{id:number;title:string}[];disabled:boolean;saveContent:()=>Promise<void>;onChanged:()=>void;children:ReactNode;
}){
  const [visible,setVisible]=useState(false),[edit,setEdit]=useState<{base:Selected;selected:Selected}|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),lock=useRef(false),toast=useToast();
  const selected=edit?.selected??selectionOf(templates),dirty=!!edit&&JSON.stringify(selected)!==JSON.stringify(edit.base);
  const toggle=()=>{
    if(!visible&&!dirty){const base=selectionOf(templates);setEdit({base,selected:base});}
    setVisible(!visible);
  };
  const change=(id:number,value:Selected[number]|null)=>{
    if(!edit)return;
    const entries={...selected};
    if(value)entries[id]=value;else delete entries[id];
    setEdit({...edit,selected:entries});setError('');
  };
  const discard=()=>{setEdit(null);setVisible(false);setError('');};
  const save=async()=>{
    if(!edit||!dirty)return;
    if(lock.current||disabled)throw Error('当前操作尚未结束，请稍后保存模板');
    lock.current=true;setBusy(true);setError('');
    try{
      await saveContent();
      const ids=Object.keys(selected).map(Number);
      const selection={templateIds:ids,requiredIds:ids.filter(id=>selected[id]!.required),resultMaterials:Object.fromEntries(ids.map(id=>[id,selected[id]!.materialId]))};
      if(periodId){
        const path='/api/periods/'+periodId+'/templates';
        const expected=await api.post<{before:Choice[]}>(path,selection);
        if(JSON.stringify(selectionOf(expected.before??[]))!==JSON.stringify(edit.base)){
          onChanged();
          throw Error('此期适用模板已从其他入口更新，当前选择已保留。请放弃本页选择并重新核对。');
        }
        await api.post(path,{...selection,apply:true,expected});
      }else{
        await api.put('/api/workbenches/'+workbenchId+'/templates',selection);
      }
      discard();onChanged();toast('已保存适用模板','ok');
    }catch(e){setError((e as Error).message);throw e;}
    finally{lock.current=false;setBusy(false);}
  };
  useEditorGuard({dirty,busy,save,discard});
  return <Card title="适用模板 → 生成文书" extra={<Button disabled={disabled||busy} onClick={toggle}>{visible?'收起选择':'选择 / 调整模板'}</Button>}>
    <p className="small muted">模板用于生成新文件；来源资料按需选择；生成成果自动归入当前工作{periodId?'及本期':''}。签章件、合同及供应商证明另行归档核对。</p>
    {dirty&&!visible&&<p role="status">模板选择尚未保存，展开后可继续核对。</p>}
    {visible&&<fieldset className="col template-choices" disabled={busy||disabled} style={{border:0,padding:0,margin:0}}>
      {loadError?<p role="alert">模板读取失败：{loadError} <Button onClick={reload}>重试读取模板</Button></p>:loading&&!options.length?<p role="status">正在读取模板…</p>:!options.length&&<p>此类型暂无模板，可先保存内容，后续在模板库上传并指定适用工作类型。</p>}
      {options.map(t=>{
        const entry=selected[t.id];
        return <div className="template-choice" key={t.id}>
          <label><input type="checkbox" checked={!!entry} onChange={e=>change(t.id,e.target.checked?(edit?.base[t.id]??{required:false,materialId:null}):null)}/>{t.name} · {t.file_format}</label>
          {entry&&<label className="small"><input type="checkbox" checked={entry.required} onChange={e=>change(t.id,{...entry,required:e.target.checked})}/>本期必备成果</label>}
          {entry&&materials.length>0&&<Field label="对应成果要求（可选）"><Select value={String(entry.materialId??'')} onChange={v=>change(t.id,{...entry,materialId:v?Number(v):null})} options={[{value:'',label:'独立成果（同名要求自动匹配）'},...materials.map(m=>({value:String(m.id),label:m.title}))]}/></Field>}
        </div>;
      })}
      {error&&<p role="alert">{error}</p>}
      <div className="row"><Button disabled={!dirty||!!loadError||loading||busy} onClick={()=>void save().catch(()=>{})}>{busy?'正在保存模板…':'保存模板选择'}</Button>
        {dirty&&<Button onClick={discard}>放弃本页模板选择</Button>}
      </div>
    </fieldset>}
    {!templates.length&&!visible&&<p>暂未选择模板。可先填写内容，再选择适用的 Word / Excel 模板。</p>}
    {children}
  </Card>;
}
