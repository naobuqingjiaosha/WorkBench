import type {Workbench} from '../api';
import {Select} from '../ui';
import {LoadError} from './DesignSystem';
import type {useWorkbenchCollection} from './useWorkbenchCollection';

/** Publish choices only after every page has loaded; retain an existing selection on retry. */
export function WorkbenchSelect({collection,value,onChange,placeholder,disabled,label=(w)=>w.name}:{
  collection:ReturnType<typeof useWorkbenchCollection>;value:string;onChange:(value:string)=>void;
  placeholder:string;disabled?:boolean;label?:(work:Workbench)=>string;
}){
  const items=collection.data?.items??[];
  const options=items.map(work=>({value:String(work.id),label:label(work)}));
  if(value&&!options.some(option=>option.value===value))options.unshift({value,label:`当前关联工作 #${value}（未在列表中）`});
  return <>
    <Select value={value} onChange={onChange} placeholder={placeholder} disabled={disabled||collection.loading||!!collection.error} options={options}/>
    {collection.loading&&<span role="status" className="muted small">正在读取工作列表…</span>}
    {collection.error&&<LoadError error={{message:`工作列表加载失败：${collection.error.message}`}} retry={collection.reload}/>}
  </>;
}
