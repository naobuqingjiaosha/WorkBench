import {useWorkbenchCollection} from './useWorkbenchCollection';
import {WorkbenchSelect} from './WorkbenchSelect';
import { useEffect, useRef, useState } from 'react';
import { api, useApi, type TemplateVarSpec } from '../api';
import { Button, Field, Loading, Modal, Select, Tag, Textarea, useAction, useToast } from '../ui';
import { TemplateFieldRecognition } from './TemplateFieldRecognition';

interface Inspection {
  template: { id: number; name: string; file_format: string };
  health: { ok: boolean; reason: string | null };
  renderable: boolean;
  scan: {
    preview: string; previewTruncated?: boolean; warnings: string[];
    variables: { name: string; raw: string; prefix: string; fallback: string | null }[];
    locations?: { name: string; raw: string; location: string; context: string }[];
  };
  structure: { collections: { name: string; fields: string[] }[]; images: { name: string }[]; warnings: string[] };
  savedVariables: TemplateVarSpec[];
  added: string[]; removed: string[];
}
interface Trial {
  check: { ok: boolean; reason: string; errors: string[] };
  missing: string[]; missingImages: string[]; warnings: string[]; fileName: string;
  plan?: {
    paginationNote: string; limitations: string[];
    segments: { kind: string; part?: string; lines?: string[]; headers?: string[] | null; rows?: string[][]; collection?: string | null; truncatedRows?: number; caption?: string; missingNote?: string }[];
  };
}
interface Autofill {
  today:string;
  resolved:{name:string;value:string;from:string;via?:string}[];
  autoCount:number;todoCount:number;
}

function markVariables(text: string, selected = '') {
  return text.split(/(\{[^{}\r\n\t]+\})/g).map((part, i) => part.startsWith('{') && part.endsWith('}')
    ? <mark key={i} style={{ background: selected && part.includes(selected) ? '#ffd47c' : '#e0edff', borderRadius: 3 }}>{part}</mark>
    : part);
}

function sampleValues(data: Inspection): Record<string, string> {
  return Object.fromEntries(data.scan.variables.filter(v => !v.prefix).map(v => {
    const collection = data.structure.collections.find(c => c.name === v.name);
    if (collection) return [v.name, JSON.stringify([1, 2].map(n => Object.fromEntries(collection.fields.map(f => [f, `测试${f}${n}`]))), null, 2)];
    const spec = data.savedVariables.find(s => s.name === v.name);
    return [v.name, spec?.example ?? v.fallback ?? (spec?.type === 'number' ? '123' : spec?.type === 'date' ? '2026-01-01' : `测试${v.name}`)];
  }));
}

export function TemplatePreview({ template, onClose, onRescanned }: {
  template: { id: number; name: string }; onClose: () => void; onRescanned?: () => void;
}) {
  const inspection = useApi<Inspection>(`/api/templates/${template.id}/preview`);
  const { busy, run } = useAction();
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState('');
  const [trial, setTrial] = useState<Trial | null>(null);
  const [view, setView] = useState<'source' | 'trial'>('source');
  const works=useWorkbenchCollection();
  const [workbenchId,setWorkbenchId]=useState('');
  const [sources,setSources]=useState<Autofill | null>(null);
  const [manuallyEdited,setManuallyEdited]=useState<Set<string>>(new Set());
  const [autofillError,setAutofillError]=useState('');
  const [testMode,setTestMode]=useState(false);
  const touched=useRef(new Set<string>());
  const data = inspection.data;
  const name = data?.template.name ?? template.name;
  useEffect(() => {
    let current=true;
    if (data) {
      setValues(Object.fromEntries(data.scan.variables.filter(v=>!v.prefix).map(v=>[v.name,data.structure.collections.some(c=>c.name===v.name)?'[]':''])));
      setTrial(null);setView('source');setSources(null);setTestMode(false);setManuallyEdited(new Set());setAutofillError('');
      touched.current=new Set();
      if(data.health.ok&&data.renderable)api.post<Autofill>(`/api/templates/${template.id}/auto-fill`,{workbenchId:workbenchId?Number(workbenchId):null}).then(result=>{
        if(!current)return;
        setSources(result);
        setValues(prev=>({...prev,...Object.fromEntries(result.resolved.filter(r=>!touched.current.has(r.name)).map(r=>[r.name,r.value]))}));
      }).catch((error:{message:string})=>{if(current)setAutofillError(error.message);});
    }
    return ()=>{current=false;};
  }, [data,workbenchId,template.id]);
  const parseValues = () => {
    const parsed: Record<string, unknown> = { ...values };
    for (const collection of data?.structure.collections ?? []) {
      try {
        const items: unknown = JSON.parse(values[collection.name] || '[]');
        if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error();
        parsed[collection.name] = items;
      } catch { throw new Error(`「${collection.name}」需要填写 JSON 对象数组，例如 [{"名称":"测试材料"}]`); }
    }
    return parsed;
  };
  const canTrial = Boolean(data?.health.ok && data.renderable);
  const warnings = [...new Set([...(data?.scan.warnings ?? []), ...(data?.structure.warnings ?? [])])];
  const locations = (data?.scan.locations ?? []).filter(p => !selected || p.name === selected);

  return <Modal open wide title={`模板预览与核对：${name}`} onClose={onClose} footer={<>
    <Button disabled={busy} onClick={onClose}>关闭</Button>
    <Button disabled={busy || !data?.health.ok} onClick={() => run(async () => {
      await api.post(`/api/templates/${template.id}/scan`);
      onRescanned?.(); inspection.reload(); toast('已重新识别并更新变量清单', 'ok');
    })}>重新识别变量</Button>
    <Button disabled={busy || !canTrial} onClick={() => run(async () => {
      const r = await api.postBlob(`/api/templates/${template.id}/preview`, { values: parseValues(), download: true });
      api.saveBlob(r.blob, `试填_${name}.${data?.template.file_format ?? 'docx'}`);
      if (r.missing.length) toast(`试填文件还有 ${r.missing.length} 个变量未填写`, 'info');
    })}>下载试填文件</Button>
    <Button kind="primary" disabled={busy || !canTrial} onClick={() => run(async () => {
      setTrial(null);
      const result = await api.post<Trial>(`/api/templates/${template.id}/preview`, { values: parseValues() });
      setTrial(result); setView('trial');
    })}>{busy ? '处理中…' : '生成试填预览'}</Button>
  </>}>
    {inspection.loading && <Loading text="正在读取模板并检查变量…" />}
    {inspection.error && <div className="notice notice-err">{inspection.error.message}</div>}
    {data && <>
      <div className={`notice ${canTrial ? 'notice-info' : 'notice-warn'}`}>
        <strong>{!data.health.ok ? '模板文件不可用' : !data.renderable ? '该格式不支持变量填充' : '模板结构检查通过，可以试填'}</strong>
        <div className="mt8">{data.health.reason ?? '系统会带入有可靠来源的内容，请核对来源和字段位置；其余内容保持待填。结构检查通过不代表业务内容已经确认。'}</div>
      </div>
      {canTrial&&<TemplateFieldRecognition templateId={template.id} onApplied={()=>{onRescanned?.();inspection.reload();}}/>}
      <div className="mt12">
        <Field label="从工作档案自动带入" hint="切换工作会重新带入并清空本窗口当前填写值，请先完成当前核对。">
          <WorkbenchSelect collection={works} value={workbenchId} onChange={setWorkbenchId} placeholder="仅使用系统日期，不关联工作" disabled={busy}/>
        </Field>
        {autofillError&&<div className="notice notice-warn">自动带入失败：{autofillError}；仍可手动填写。</div>}
        {sources&&<div className="small muted">已自动带入 {sources.autoCount} 项，另有 {sources.todoCount} 项需填写或完善档案。检查、监督、签约等实际发生日期不会默认填今天；需要时可逐项明确采用今天。</div>}
        {testMode&&<div className="notice notice-warn mt8">当前使用测试示例，下载文件中的测试文字并非真实业务内容。</div>}
      </div>
      {warnings.map((w, i) => <div key={i} className="notice notice-warn mt8">{w}</div>)}
      {(data.added.length > 0 || data.removed.length > 0) && <div className="notice notice-warn mt8">
        当前文件与已保存的变量清单不一致。{data.added.length > 0 && `新识别：${data.added.join('、')}。`}{data.removed.length > 0 && `原清单中已不存在：${data.removed.join('、')}。`}核对后点击「重新识别变量」同步。
      </div>}
      <div className="row mt12" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Button kind={view === 'source' ? 'primary' : 'default'} onClick={() => setView('source')}>原文与变量位置</Button>
        <Button kind={view === 'trial' ? 'primary' : 'default'} disabled={!trial} onClick={() => setView('trial')}>试填结果</Button>
        <span className="small muted">识别到 {data.scan.variables.filter(v => !v.prefix).length} 个顶层变量 · 预览填写值不会写回工作档案</span>
      </div>
      <div className="small muted mt8">同名变量在所有位置都会填入同一个值；如果年份、月份、人员等需要分别填写，请在原模板中使用不同的变量名。</div>
      {view === 'source' && <>
        <h4>识别清单与待填写内容</h4>
        {data.scan.variables.length === 0 && <div className="notice notice-warn">原文尚无具体变量。可先用上方「智能识别填写位置」识别字段空位，核对后转换；如果模板本来就是固定内容，仍可预览检查文件。</div>}
        <div className="col" style={{ gap: 10 }}>
          {data.scan.variables.filter(v => !v.prefix).map(v => {
            const collection = data.structure.collections.find(c => c.name === v.name);
            const image = v.raw.startsWith('{@');
            const spec = data.savedVariables.find(s => s.name === v.name);
            const source=sources?.resolved.find(r=>r.name===v.name);
            const dateField=spec?.type==='date'||/日期|时间/.test(v.name);
            return <div key={v.name} style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Button size="sm" onClick={() => { setSelected(v.name); document.getElementById('template-variable-locations')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }}>{v.name} · 查看位置</Button>
                <Tag kind={image ? 'info' : collection ? 'warn' : 'default'}>{image ? '图片' : collection ? '循环集合' : '普通变量'}</Tag>
                <code>{v.raw}</code>{spec?.label && spec.label !== v.name && <span className="small muted">{spec.label}</span>}
              </div>
              {image ? <div className="small muted mt8">图片需要在具体工作台中从影像证据取用；此处会提示缺图，不会使用其他工作的照片。</div>
                : <Field label={collection ? `集合数据（JSON 数组；字段：${collection.fields.join('、')}；[] 表示删除循环区域）` : '预览填写值'}>
                  <Textarea rows={collection ? 5 : 2} disabled={busy} value={values[v.name] ?? ''} onChange={value => { touched.current.add(v.name);setValues(p => ({ ...p, [v.name]: value })); setManuallyEdited(p=>new Set([...p,v.name]));setTrial(null); }} />
                </Field>}
              {!image&&!collection&&<div className="small muted mt8">来源：{testMode?'测试示例':manuallyEdited.has(v.name)?'本窗口人工填写':source?.via??'正在查找可靠来源…'}{dateField&&sources&&<Button size="sm" disabled={busy} onClick={()=>{touched.current.add(v.name);setValues(p=>({...p,[v.name]:sources.today}));setManuallyEdited(p=>new Set([...p,v.name]));setTrial(null);}}>采用今天（{sources.today}）</Button>}</div>}
              {spec?.hint && <div className="small muted">填写说明：{spec.hint}</div>}
            </div>;
          })}
        </div>
        <div className="row mt12"><Button size="sm" disabled={busy} onClick={() => { touched.current=new Set(data.scan.variables.map(v=>v.name));setValues(sampleValues(data));setTestMode(true);setTrial(null); }}>使用测试示例（仅验证替换）</Button></div>
        <h4 id="template-variable-locations">变量位置{selected ? `：${selected}` : ''}</h4>
        {selected && <Button size="sm" onClick={() => setSelected('')}>显示全部位置</Button>}
        <div className="preview-pane mt8" style={{ maxHeight: 260, overflow: 'auto', background: '#fff', color: 'var(--text)' }}>
          {locations.slice(0, 200).map((p, i) => <div key={i} className="mb12"><div className="small muted">{p.location} · {p.name}</div><div style={{ whiteSpace: 'pre-wrap' }}>{markVariables(p.context, selected)}</div></div>)}
          {locations.length === 0 && <span className="muted">暂无单独的位置记录，请在下面的原文中核对。</span>}
          {locations.length > 200 && <div className="notice notice-warn">当前位置共 {locations.length} 处，展示前 200 处；可按变量筛选或下载原件检查。</div>}
        </div>
        <h4>模板原文（变量高亮）</h4>
        {data.scan.previewTruncated && <div className="notice notice-warn">原文摘要仅展示前 8000 字；上方位置清单仍包含摘要以外的命中，完整内容请下载原件。</div>}
        <div className="preview-pane mt8" style={{ whiteSpace: 'pre-wrap', maxHeight: 420, overflow: 'auto', background: '#fff', color: 'var(--text)' }}>{markVariables(data.scan.preview, selected) || '无可显示的文本'}</div>
      </>}
      {view === 'trial' && trial && <>
        <div className={`notice ${trial.check.ok ? 'notice-info' : 'notice-warn'} mt12`}>
          <strong>{trial.check.ok ? '试填文件结构检查通过' : '试填失败，文件结构存在问题'}</strong><div>{trial.check.reason}</div>
          {trial.check.errors.map((error, i) => <div key={i}>{error}</div>)}
        </div>
        {trial.missing.length > 0 && <div className="notice notice-warn mt8">未填写变量：{trial.missing.join('、')}</div>}
        {trial.missingImages.length > 0 && <div className="notice notice-warn mt8">未插入图片：{trial.missingImages.join('、')}</div>}
        {trial.warnings.map((warning, i) => <div key={i} className="notice notice-warn mt8">{warning}</div>)}
        {trial.plan && <>
          <div className="notice notice-info mt8">{trial.plan.paginationNote}</div>
          <div className="preview-pane mt12" style={{ maxHeight: 520, overflow: 'auto', background: '#fff', color: 'var(--text)' }}>
            {trial.plan.segments.map((seg, i) => <div className="mb12" key={i}>
              <div className="small muted mb8">{seg.part ?? (seg.kind === 'table' ? `表格${seg.collection ? ` · ${seg.collection}` : ''}` : '图片')}</div>
              {seg.kind === 'text' && <div style={{ whiteSpace: 'pre-wrap' }}>{markVariables((seg.lines ?? []).join('\n'))}</div>}
              {seg.kind === 'table' && <div style={{ overflow: 'auto' }}><table className="table">
                {seg.headers && <thead><tr>{seg.headers.map((h, j) => <th key={j}>{h}</th>)}</tr></thead>}
                <tbody>{seg.rows?.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci} style={{ whiteSpace: 'pre-wrap' }}>{markVariables(cell)}</td>)}</tr>)}</tbody>
              </table>{Boolean(seg.truncatedRows) && <div>已折叠 {seg.truncatedRows} 行，完整内容请下载试填文件。</div>}</div>}
              {seg.kind === 'image' && <div>{seg.caption} {seg.missingNote}</div>}
            </div>)}
          </div>
          <details className="mt12"><summary>预览范围说明</summary>{trial.plan.limitations.map((text, i) => <p key={i}>{text}</p>)}</details>
        </>}
      </>}
    </>}
  </Modal>;
}
