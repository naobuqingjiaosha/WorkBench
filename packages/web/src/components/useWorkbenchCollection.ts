import {useCallback,useEffect,useState} from 'react';
import {api,type Workbench,type ApiErrorShape} from '../api';

/** The endpoint caps each response at 500; finish paging before local filtering. */
export function useWorkbenchCollection(archived=false){
 const [tick,setTick]=useState(0),[state,setState]=useState<{archived:boolean;data?:{items:Workbench[]};loading:boolean;error?:ApiErrorShape}>({archived,loading:true});
 useEffect(()=>{
  const controller=new AbortController();let current=true;
  setState({archived,loading:true});
  void (async()=>{
   try{
    const items=new Map<number,Workbench>();
    for(let offset=0;;offset+=500){
     const batch=await api.get<{items:Workbench[]}>(`/api/workbenches?archived=${archived}&limit=500&offset=${offset}`,controller.signal);
     for(const item of batch.items)items.set(item.id,item);
     if(batch.items.length<500)break;
    }
    if(current)setState({archived,data:{items:[...items.values()]},loading:false});
   }catch(error){if(current)setState({archived,loading:false,error:error as ApiErrorShape});}
  })();
  return()=>{current=false;controller.abort();};
 },[archived,tick]);
 const reload=useCallback(()=>setTick(t=>t+1),[]);
 return {...(state.archived===archived?state:{loading:true,data:undefined,error:undefined}),reload};
}
