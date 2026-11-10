import {Button,Field} from '../ui';
import {reportNameSuggestions,type PendingProjectReport,type TemplateProjectCatalog} from './project-report-input';

export function ProjectReportReview({pending,formalNames,catalog,onChange,onRetry,onAdopt,onCancel}:{pending:PendingProjectReport;formalNames:string[];catalog?:TemplateProjectCatalog;onChange:(p:PendingProjectReport)=>void;onRetry:()=>void;onAdopt:()=>void;onCancel:()=>void}){
 const change=(index:number,patch:Partial<PendingProjectReport['choices'][number]>)=>onChange({...pending,mergeConfirmed:false,choices:pending.choices.map((c,n)=>n===index?{...c,...patch}:c)});
 return <section className="notice" aria-label="待核对项目月报">
  <strong>待核对项目月报：{pending.name}</strong>
  <p>已保存来源副本，尚未采用。采用仅补入所选项目和明确勾选的简称；原项目、人员参与、逐日修改保留。替换月报也不自动删除旧项目，请在清单中人工核对。</p>
  {pending.error&&<p role="alert">{pending.error}</p>}
  {!pending.verified&&<p role="status">需要重新读取来源后核对，恢复的选择暂不代表已验证。</p>}
  {pending.preview&&<>
   <p>{pending.preview.warning}。完成100%仍保留，不从月报推断人员、合同或逐日工时。</p>
   <label><input type="checkbox" checked={pending.monthConfirmed} onChange={e=>onChange({...pending,monthConfirmed:e.target.checked})}/> 已核对此资料用于 {pending.month}，标题未写年份时由我确认年份</label>
   {catalog?.warnings.map((w,n)=><p key={n}>{w}</p>)}
   <p className="small">正式名称建议来自已选模板明确项目字段及当前清单，仅供核对；无匹配可填写经确认的正式名称。建设单位不等于合同客户。</p>
   <Button onClick={()=>onChange({...pending,mergeConfirmed:false,choices:pending.choices.map(c=>({...c,selected:true}))})}>选中全部候选（仍需逐项确认名称）</Button>
   {pending.preview.rows.map((row,index)=>{const c=pending.choices[index];if(!c)return null;const suggestions=reportNameSuggestions(row.name,formalNames);return <div key={row.key} style={{borderTop:'1px solid var(--border)',padding:'12px 0'}}>
    <label><input type="checkbox" checked={c.selected} onChange={e=>change(index,{selected:e.target.checked})}/> {row.name}</label>
    <p className="small">来源：{row.sheet} 第{row.row}行 · 建设单位：{row.unit||'未填'} · 累计比例：{row.progress||'未填'}</p>
    <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>本月完成：{row.completed||'未填，不能据此认定本月无工作'}</p>
    {row.duplicate&&<p role="status">月报有同名项目，请按来源行逐项确认，不能自动合并。</p>}
    <p className="small">{suggestions.length?`名称建议（${suggestions.length}项，未采用）：${suggestions.join('；')}`:'未找到名称建议，请人工确认正式名称。'}</p>
    <Field label="正式项目名称（选取建议或人工填写）"><input className="input" list={`project-report-${index}`} value={c.target} onChange={e=>change(index,{target:e.target.value,confirmed:false})}/><datalist id={`project-report-${index}`}>{[...new Set(formalNames)].map(n=><option key={n} value={n}/>)}</datalist></Field>
    <Button size="sm" onClick={()=>change(index,{target:row.name,confirmed:false})}>以月报名称填写（仍需确认）</Button>
    <label><input type="checkbox" checked={c.confirmed} disabled={!c.target.trim()} onChange={e=>change(index,{confirmed:e.target.checked})}/> 已核对本行所选正式名称</label>
    <label><input type="checkbox" checked={c.alias} onChange={e=>change(index,{alias:e.target.checked,confirmed:false})}/> 将本行月报名称明确用作该正式项目的考勤简称</label>
    {catalog?.items.filter(item=>item.name===c.target).map((item,n)=><p key={n} className="small">模板参考：{item.sheet} 第{item.row}行；客户：{item.customer||'未载明'}；合同编号：{item.contract||'未载明'}（仅显示模板原字段，不补造）</p>)}
   </div>;})}
   <label><input type="checkbox" checked={pending.mergeConfirmed} onChange={e=>onChange({...pending,mergeConfirmed:e.target.checked})}/> 如有多行映射到同一正式项目，我已核对并确认合并到一个清单项</label>
  </>}
  <div className="row"><Button onClick={onRetry}>重新读取月报</Button><Button disabled={!pending.verified||!pending.monthConfirmed} onClick={onAdopt}>采用已确认项目</Button><Button onClick={onCancel}>取消本次月报</Button></div>
 </section>;
}
