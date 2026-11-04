import {useCallback,useEffect,useState} from 'react';
import {api,type Workbench,type ApiErrorShape} from '../api';

/** The endpoint caps each response at 500; finish paging before local filtering. */
export function useWorkbenchCollection(archived=false,workTypeId?:number){
 const [tick,setTick]=useState(0),[state,setState]=useState<{archived:boolean;workTypeId?:number;data?:{items:Workbench[]};loading:boolean;error?:ApiErrorShape}>({archived,workTypeId,loading:true});
 useEffect(()=>{
  const controller=new AbortController();let current=true;
  setState({archived,workTypeId,loading:true});
  void (async()=>{
   try{
    const items=new Map<number,Workbench>();
    for(let offset=0;;offset+=500){
     const batch=await api.get<{items:Workbench[]}>(`/api/workbenches?archived=${archived}&limit=500&offset=${offset}${workTypeId===undefined?'':`&workTypeId=${workTypeId}`}`,controller.signal);
     for(const item of batch.items)items.set(item.id,item);
     if(batch.items.length<500)break;
    }
    if(current)setState({archived,workTypeId,data:{items:[...items.values()]},loading:false});
   }catch(error){if(current)setState({archived,workTypeId,loading:false,error:error as ApiErrorShape});}
  })();
  return()=>{current=false;controller.abort();};
 },[archived,workTypeId,tick]);
 const reload=useCallback(()=>setTick(t=>t+1),[]);
 return {...(state.archived===archived&&state.workTypeId===workTypeId?state:{loading:true,data:undefined,error:undefined}),reload};
}
