import { useEffect, useState } from 'react';
import { api, useApi } from '../api';
import { Button, Input, Loading, Tag, useAction, useToast } from '../ui';

interface Candidate {id:string;name:string;type:string;location:string;context:string;original:string;reason:string;confidence:string}
export function TemplateFieldRecognition({templateId,onApplied}:{templateId:number;onApplied:()=>void}) {
  const [open,setOpen]=useState(true);
  const analysis=useApi<{fingerprint:string;candidates:Candidate[]}>(open?`/api/templates/${templateId}/smart-fields`:null);
  const [chosen,setChosen]=useState<Record<string,boolean>>({});
  const [names,setNames]=useState<Record<string,string>>({});
  const {busy,run}=useAction();const toast=useToast();
  useEffect(()=>{
    if(!analysis.data)return;
    setChosen(Object.fromEntries(analysis.data.candidates.slice(0,200).map(c=>[c.id,c.confidence==='high'])));
    setNames(Object.fromEntries(analysis.data.candidates.map(c=>[c.id,c.name])));
  },[analysis.data]);
  const selections=(analysis.data?.candidates ?? []).filter(c=>chosen[c.id]).map(c=>({id:c.id,name:names[c.id] ?? c.name}));
  return <div className="mt12" style={{border:'1px solid var(--line)',padding:12,borderRadius:8}}>
    <div className="row" style={{gap:8,flexWrap:'wrap'}}>
      <strong>自动识别待填写位置</strong>
      <Button size="sm" disabled={busy} onClick={()=>setOpen(v=>!v)}>{open?'收起识别建议':'智能识别填写位置'}</Button>
      {open&&<Button size="sm" disabled={busy||analysis.loading} onClick={analysis.reload}>重新分析原文</Button>}
    </div>
    <div className="small muted mt8">可识别日期结构、字段标签后的空位、表格空白单元格及通用 {'{变量}'}。先核对建议名称和位置，再确认转换；原文件会保留。</div>
    {open&&<>
      {analysis.loading&&<Loading text="正在分析字段标签和填写位置…"/>}
      {analysis.error&&<div className="notice notice-warn mt8">{analysis.error.message}</div>}
      {analysis.data&&<>
        <div className="notice notice-info mt8">发现 {analysis.data.candidates.length} 个建议位置。带有具体日期或仅凭相邻标签推断的位置默认不选，请确认用途。未标注空位或含义不明确的内容仍需人工检查。</div>
        {!analysis.data.candidates.length&&<div className="small muted mt8">未发现明确的待填空位。如果已使用具体变量名，可直接在下面自动带入；其他位置请在原文中明确字段标签或添加占位符。</div>}
        {analysis.data.candidates.slice(0,200).map(c=><div key={c.id} className="mt12" style={{borderBottom:'1px solid var(--line)',paddingBottom:10}}>
          <label className="row" style={{gap:8}}><input type="checkbox" disabled={busy} checked={Boolean(chosen[c.id])} onChange={e=>setChosen(p=>({...p,[c.id]:e.target.checked}))}/><strong>{c.location}</strong><Tag kind={c.confidence==='high'?'info':'warn'}>{c.confidence==='high'?'规则命中':'需核对'}</Tag></label>
          <div className="small mt8" style={{whiteSpace:'pre-wrap'}}>{c.context}</div>
          <div className="row mt8" style={{gap:8,flexWrap:'wrap'}}><span className="small">变量名称：</span><Input disabled={busy} value={names[c.id]??c.name} onChange={value=>setNames(p=>({...p,[c.id]:value}))}/><code>{`{${names[c.id]??c.name}}`}</code></div>
          <div className="small muted mt8">{c.reason} · 原内容：{c.original||'空白'}</div>
        </div>)}
        {analysis.data.candidates.length>200&&<div className="notice notice-warn mt8">每次最多确认 200 个位置，本次显示前 200 项；转换后可再次分析其余位置。</div>}
        <Button kind="primary" disabled={busy||!selections.length} onClick={()=>run(async()=>{
          await api.post(`/api/templates/${templateId}/smart-fields/apply`,{fingerprint:analysis.data!.fingerprint,selections});
          setOpen(false);onApplied();toast(`已将 ${selections.length} 个位置转换为变量，原件已保留`,'ok');
        })}>{busy?'正在转换…':`确认转换选中位置（${selections.length}）`}</Button>
      </>}
    </>}
  </div>;
}
