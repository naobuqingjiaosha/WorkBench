import { BusinessEvidence,type Evidence } from '../components/BusinessEvidence';
/**
 * 出文书 —— 从工作里打开的弹窗
 *
 * 这不是独立功能，而是「工作 + 模板 → 文件」这一个动作。
 * 工作已知（从哪进来的）、模板已知（点的是哪个模板），所以原来的
 * 「第 1 步选模板和工作台」整块去掉，直接从确认内容开始。
 *
 * 自动带入的部分已经填好（项目信息 + 系统变量），你只需要补剩下的，
 * 或者让模型把正文补上。
 */
import { useEffect, useRef, useState } from 'react';
import {useDirtyClose} from '../components/useUnsavedClose';
import {
  api,
  useApi,
  type Artifact,
  type KbComplianceResult,
  type TemplateVarSpec,
} from '../api';
import { Button, Card, Empty, Field, Loading, Modal, Select, Tag, Textarea, Input, fmtTime, useAction, useToast } from '../ui';

interface DraftResult {  ok: boolean;
  sourceSignature?:string;
  contextSignature?:string;
  evidence?:Evidence;
  variables: Record<string, string>;
  specs: TemplateVarSpec[];
  missing: string[];
  rationale: Record<string, string>;
  sources?: Record<string, { from: string; via: string }>;
  warnings: string[];
  usage: { prompt: number; output: number; total: number };
  model: string;
  latencyMs: number;
  error?: string;
  rawText?: string;
  /** 本轮检索到的制度及实际给模型的正文。 */
  knowledge?: { source: string; title: string; heading?: string | null; score: number; optional?: boolean; documentId?: number | null; snippet?: string; docNo?: string | null; retrieval?: string }[];
  /** 没查到依据的原因（知识库还空着 / 没配向量化模型 / 检索报错） */
  knowledgeError?: string;
}

interface FieldVar extends TemplateVarSpec {
  collectionFields?:string[];
  preset?: string;
  source?: string;
  via?: string;
}

/* ------------------------- 页面内预览（B4-12） ------------------------- */

/**
 * 预览计划里的一段。口径与后端 `domain/generate.ts` 的 `PreviewSegment` 一致，
 * 只做 `text` / `table` / `image` 三种 —— **不做前端重新解析 docx**（那会生成第二真源）。
 */
interface PreviewSegment {
  kind: 'text' | 'table' | 'image';
  part?: string;
  lines?: string[];
  headers?: string[] | null;
  rows?: string[][];
  collection?: string | null;
  truncatedRows?: number;
  caption?: string;
  url?: string;
  takenAt?: string | null;
  inserted?: boolean;
  missingNote?: string;
}

/** 产物合法性校验的结论（红/绿横幅就是它） */
interface PreviewCheck {
  ok: boolean;
  kind: 'template-xml' | 'output-xml' | 'plain-text' | 'skipped';
  reason: string;
  errors: string[];
}

interface PreviewData {
  check: PreviewCheck;
  plan?: {
    template: { id: number; name: string; format: string; fileFormat: string };
    segments: PreviewSegment[];
    counts: { text: number; table: number; image: number };
    tableRows: number;
    paginationNote: string;
    limitations: string[];
    renderedBytes: number;
  };
  warnings: string[];
  missing: string[];
  missingImages: string[];
  fileName: string;
  notes: string[];
  /**
   * 出文书前口径校验的结论（B3-9）。后端钩子挂在**预览响应**上（不拦预览，只把问题摆出来）：
   * 哪一项、错在哪、依据是哪份制度的哪一条 —— 让人在点保存之前就看见。
   */
  compliance?: KbComplianceResult;
}

/** 表格预览一次最多显示多少行（与大段文本一起避免弹窗卡顿；后端也会按 500 行折叠） */
const PREVIEW_MAX_ROWS = 200;

const SOURCE_LABEL: Record<string, string> = {
  system: '系统自动',
  archive: '项目信息',
  native: '工作台字段',
  'mapped-empty': '项目信息未填',
  unmapped: '',
};

function CollectionEditor({name,columns,value,onChange}:{name:string;columns:string[];value:string;onChange:(value:string)=>void}){
  let rows:Record<string,unknown>[]=[];
  try{const parsed=value.trim()?JSON.parse(value):[];if(!Array.isArray(parsed)||parsed.some(r=>!r||typeof r!=='object'||Array.isArray(r)))throw Error();rows=parsed;}
  catch{return <><p role="alert">表格内容格式异常，请修正后继续，原内容已保留。</p><Textarea value={value} onChange={onChange}/></>;}
  return <div className="col"><span className="small muted">{name} · {rows.length} 条。逐项核对，待补项须据实填写。</span>
    {rows.map((row,index)=><fieldset key={index} style={{minWidth:0,border:'1px solid var(--line)',borderRadius:8,padding:12}}><legend>第 {index+1} 条</legend><div className="grid grid-2">{columns.map(column=><Field key={column} label={column}><Textarea rows={column==='序号'?1:2} value={String(row[column]??'')} onChange={text=>onChange(JSON.stringify(rows.map((r,i)=>i===index?{...r,[column]:text}:r)))}/></Field>)}</div></fieldset>)}
    {!rows.length&&<Button onClick={()=>onChange(JSON.stringify([Object.fromEntries(columns.map(c=>[c,c==='序号'?1:'']))]))}>填写第一条</Button>}
  </div>;
}

/**
 * 三个保存方式（B1-4）。文案就是给用户看的**后果说明**：
 * "上一版去哪了""之后还能不能改" —— 不说清楚的话，用户只会在点完之后才发现在猜。
 */
const SAVE_MODE_OPTIONS: { value: 'new' | 'update' | 'final'; label: string; hint: string }[] = [
  {
    value: 'update',
    label: '更新这一版',
    hint: '同一份文书接着改：上一版移到 .versions 归档目录（仍能下载、能回滚），新一版占正式文件名。',
  },
  {
    value: 'final',
    label: '另存为定稿',
    hint: '出完这一版直接标为最终版：之后这条链不能再被覆盖，要改得先取消定稿。',
  },
  {
    value: 'new',
    label: '新建',
    hint: '另一份不同用途的文书：新开一条版本链，两边互不影响。',
  },
];

export function GenerateModal({
  templateId,
  templateName,
  workbenchId,
  periodId,
  inspectionId,
  initialInstruction,
  initialValues,
  positionCode,
  onClose,
  onSaved,
}: {
  templateId: number;
  templateName?: string;
  workbenchId: number;
  periodId?: number;
  inspectionId?:number;
  initialInstruction?: string;
  initialValues?: Record<string,string>;
  positionCode?: string | null;
  onClose: () => void;
  onSaved?: (a: Artifact) => void;
}) {
  const toast = useToast();
  const { busy, run } = useAction();

  const fields = useApi<{
    sourceSignature:string;
    template: { id: number; name: string; file_format: string; description: string | null };
    inspectionRevision:number|null;
    variables: FieldVar[];
    summary: { total: number; auto: number; todo: number };
  }>(
    `/api/generate/fields/${templateId}?${new URLSearchParams({
      workbenchId: String(workbenchId),
      ...(periodId ? { periodId: String(periodId) } : {}),
      ...(inspectionId?{inspectionId:String(inspectionId)}:{}),
      ...(positionCode ? { positionCode } : {}),
    }).toString()}`,
  );

  const [values, setValues] = useState<Record<string, string>>({});
  const [factConflicts,setFactConflicts] = useState<{field:string;value:string;candidates:{id:number;value:string;source:string|null}[]}[]>([]);
  const [factChoices,setFactChoices] = useState<Record<string,{value:string;reason:string}>>({});
  const [factReasons,setFactReasons] = useState<Record<string,string>>({});
  useEffect(()=>setFactChoices({}),[values]);
  const [instruction, setInstruction] = useState(initialInstruction??'');
  const [refIds, setRefIds] = useState<number[]>([]);
  const baseline=useRef<string|null>(null);
  const close=useDirtyClose(baseline.current!==null&&(JSON.stringify(values)!==baseline.current||instruction!==(initialInstruction??'')||refIds.length>0),onClose);
  const [draft, setDraft] = useState<DraftResult | null>(null);
  /** 页面内预览的结果（B4-12）：`plan.segments` + 产物校验结论 */
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [showRefs, setShowRefs] = useState(false);
  /**
   * 保存方式（B1-4）。默认「更新这一版」—— 用户从工作台点开某个模板再出一次，
   * 十有八九是"这份文书还要改"，而不是"再出一份新的"；选错了最多多一条链，
   * 而默认出新的会让人永远分不清哪份是最终版（这正是 B1-4 要解决的事）。
   *
   * `new` = 另一份不同用途；`update` = 接着上一版（旧版进 .versions）；`final` = 出完就定稿。
   */
  const [saveMode, setSaveMode] = useState<'new' | 'update' | 'final'>('update');
  /**
   * 这份文书现在已经有的版本情况（有链时把「更新这一版」说清楚会变成第几版、
   * 以及"已有定稿不能再覆盖"先摆在眼前）。服务端算，界面不自己猜。
   */
  const chain = useApi<{
    exists: boolean;
    liveCount: number;
    nextRevision: number;
    headRevision: number | null;
    headId: number | null;
    blocked: boolean;
    finalRevision: number | null;
    message: string;
    schemaReady: boolean;
  }>(
    `/api/generate/chain?${new URLSearchParams({
      templateId: String(templateId),
      workbenchId: String(workbenchId),
      ...(periodId ? { periodId: String(periodId) } : {}),
      ...(inspectionId?{inspectionId:String(inspectionId)}:{}),
      ...(positionCode ? { positionCode } : {}),
    }).toString()}`,
  );

  const refs = useApi<{ items: Artifact[] }>(`/api/artifacts?workbenchId=${workbenchId}&limit=${periodId?500:60}`);
  const referenceItems=refs.data?.items.filter(a=>!periodId||(a as Artifact&{work_period_id?:number}).work_period_id===periodId)??[];

  useEffect(() => {
    if (!fields.data) return;
    const next: Record<string, string> = {};
    for (const v of fields.data.variables) if (v.preset) next[v.name] = v.preset;
    Object.assign(next, initialValues ?? {});
    baseline.current=JSON.stringify(next);
    setValues(next);
    setDraft(null);
    /** 换了模板/工作台，旧的预览计划就不再是这一份的内容了 —— 清掉，别让人看错 */
    setPreview(null);
  }, [fields.data]);

  /**
   * 已经有定稿时，「更新这一版 / 另存为定稿」后端一定会拦下（不静默覆盖）。
   * 这里先把选中项挪到「新建」，让用户看到的是"能点的那一个"，
   * 而不是点完保存才收到 400。
   */
  useEffect(() => {
    if (chain.data?.blocked && saveMode !== 'new') setSaveMode('new');
  }, [chain.data, saveMode]);

  const variables = fields.data?.variables ?? [];
  const summary = fields.data?.summary;
  const needsInput=(v:FieldVar,value:string|undefined)=>{
    if(v.collectionFields?.length){try{const rows=JSON.parse(value??'');return !Array.isArray(rows)||!rows.length||rows.some(row=>v.collectionFields!.some(column=>row?.[column]===undefined||row?.[column]===null||String(row?.[column]??'').includes('【待补')));}catch{return true;}}
    return !value?.trim()||value.includes('【待补');
  };
  const autoVars = variables.filter((v) => v.preset&&!needsInput(v,v.preset));
  const todoVars = variables.filter((v) => !v.preset||needsInput(v,v.preset));
  const missingRequired = variables.filter((v) => v.required !== false && needsInput(v,values[v.name]));

  const doDraft = (skipAi: boolean) =>
    run(async () => {
      const requestInstruction = instruction;
      setInstruction(prev => prev.replace(/(^|[，,。；;！!？?\n])\s*(?:请\s*)?帮我参考制度(?=\s|$|[：:，,。；;]|并|来|后|生成|写|修改)/g, '$1'));
      const r = await api.post<DraftResult>('/api/generate/draft', {
        templateId,
        workbenchId,
        periodId,
        inspectionId,
        inspectionRevision:fields.data?.inspectionRevision,
        positionCode: positionCode || null,
        known: !skipAi && draft?.knowledge?.length
          ? Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== draft.variables[key]))
          : values,
        instruction: requestInstruction,
        referenceArtifactIds: refIds,
        skipAi,
      });
      setDraft(r);
      if (r.ok) {
        setValues((prev) => ({ ...prev, ...r.variables }));
        if (skipAi) toast('已按已知信息填入，请补充剩下的', 'ok');
        else toast(`生成完成，用时 ${(r.latencyMs / 1000).toFixed(1)}s`, 'ok');
      } else {
        toast(r.error ?? '生成失败', 'err');
      }
    });

  /**
   * 保存。`saveMode` 三选项（B1-4）由界面显式传给后端 —— 接口的缺省值是"新建"，
   * 这里绝不依赖缺省，避免将来后端改了缺省就悄悄换了落盘行为。
   * 保存只检查事实及成品完整性，不自动调用制度接口。
   */
  const doSave = (fileName?: string,mode?:'new'|'update'|'final') =>
    run(async () => {
      const effectiveMode=mode??saveMode;
      const facts = await api.post<{conflicts:typeof factConflicts}>('/api/generate/facts',{workbenchId,periodId,values});
      setFactConflicts(facts.conflicts);
      if (effectiveMode==='final' && facts.conflicts.some(c=>factChoices[c.field]?.value!==c.value || !factChoices[c.field]?.reason.trim())) {
        toast('存在事实来源冲突，请在下方选择本次值并填写确认依据','err'); return;
      }
      const r = await api.post<{
        artifact: Artifact;
        missing: string[];
        version: { group: string; revision: number; isFinal: boolean } | null;
        warnings: string[];
        complianceExceptions?: number;
      }>('/api/generate/save', {
        templateId,
        workbenchId,
        periodId,
        inspectionId,
        inspectionRevision:fields.data?.inspectionRevision,
        positionCode: positionCode || null,
        values,
        fileName,
        mode: draft ? 'ai' : 'manual',
        saveMode:effectiveMode,
        expectedHeadId:chain.data?.headId,
        expectedSourceSignature:draft?.sourceSignature,
        expectedContextSignature:draft?.contextSignature??fields.data?.sourceSignature,
        sourceArtifactIds:refIds,
        factChoices,
      });
      const v = r.version ? `（v${r.version.revision}${r.version.isFinal ? ' · 已定稿' : ''}）` : '';
      toast(`已保存${v}：${r.artifact.file_name}`, 'ok');
      if (r.complianceExceptions) {
        toast(`这份文书有 ${r.complianceExceptions} 项口径例外，已留痕（谁、何时、以什么理由放行）。`, 'info');
      }
      // 旧版本搬到哪了、定稿意味着什么 —— 如实转述，不静默
      for (const w of r.warnings ?? []) if(!w.includes('移到归档目录'))toast(w, 'info');
      onSaved?.(r.artifact);
      onClose();
    });

  /**
   * 「预览」（B4-12 真·预览）—— **不再是下载**。
   *
   * 改造前这里是 `postBlob → saveBlob`：点一下就在磁盘上留一个 `_预览.docx`，
   * 用户必须离开浏览器打开文件（docs/09 §7.1 第 18 条），而且坏模板产出的坏文件
   * "下载得到、打不开"，预览这一步没有任何可读性判断。
   * 现在改成：拿回后端的 `plan.segments` + 产物校验结论，在**弹窗里**渲染正文/表格/缩略图，
   * 并在顶部给一条红/绿横幅（校验不通过时写明原因）。下载只作为兜底保留。
   */
  const doPreview = () =>
    run(async () => {
      /**
       * `want:'plan'` 是**必须的**：同一个路径不传它就是老契约（回 docx 文件流，供 e2e 断言）。
       * 界面永远要计划（结构化内容 + 产物校验结论），所以这里显式声明。
       */
      const r = await api.post<PreviewData>('/api/generate/preview', {
        templateId,
        workbenchId,
        periodId,
        inspectionId,
        inspectionRevision:fields.data?.inspectionRevision,
        positionCode: positionCode || null,
        values,
        want: 'plan',
      });
      setPreview(r);
      /**
       * 预览**不拦**（这正是预览的意义）：后端的钩子把口径校验结论挂在 `r.compliance` 上，
       * 这里接住并显示 —— 让人在点保存之前就看到"哪一处引用悬空、依据是哪一条"。
       */
      if (!r.check.ok) toast(`产物结构有异常：${r.check.reason}`, 'err');
      else if (r.missing.length) toast(`已生成预览，但有 ${r.missing.length} 项没填（文件里会保留占位符）`, 'info');
      else toast('内容预览已生成', 'ok');
    });

  /**
   * 兜底下载：与改造前那个动作是**同一个后端行为**（现在是 `/preview/file`），默认动作不再是它。
   *
   * `workbenchId` / `positionCode` **必须带上**：服务端拿它定位"这一次渲染该用哪个工作台、哪个阶段"
   * 的影像素材（`buildRenderAssets()`）。以前这里只传 `templateId` + `values`，服务端 `workbenchId=null`
   * 就退回"全库影像按名字找同名的"，下载到的 docx 里可能是**别的工作台的同名照片** ——
   * 与「预览」「用系统打开」「正式生成」三条路不同源。现在四处传的是同一组参数。
   */
  const doDownload = () =>
    run(async () => {
      const { blob, missing } = await api.postBlob('/api/generate/preview/file', {
        templateId,
        workbenchId,
        periodId,
        inspectionId,
        inspectionRevision:fields.data?.inspectionRevision,
        positionCode: positionCode || null,
        values,
      });
      const fmt = fields.data?.template.file_format ?? 'docx';
      const ext = fmt === 'xlsx' ? 'xlsx' : fmt === 'text' ? 'txt' : fmt;
      api.saveBlob(blob, `${templateName ?? fields.data?.template.name ?? '文档'}_预览.${ext}`);
      if (missing.length) toast(`已下载，但有 ${missing.length} 个变量没填：${missing.slice(0, 5).join('、')}`, 'err');
      else toast('预览文件已下载，可直接打开检查', 'ok');
    });

  /**
   * 「用系统打开」：真正最准的预览（本机装了 Word 时）。
   *
   * 后端把这一次的渲染结果写进**平台运行目录**的预览临时文件（uuid 命名、不进 artifact、
   * 不进用户绑定目录、24 小时过期），再交给系统默认程序；机器上没关联 Word 时不报 500，
   * 只是打不开 —— 这里就照实说「请下载后查看」。
   */
  const doOpenInSystem = () =>
    run(async () => {
      const r = await api.post<{ opened: boolean; fileName: string }>('/api/generate/preview/open', {
        templateId,
        workbenchId,
        periodId,
        inspectionId,
        inspectionRevision:fields.data?.inspectionRevision,
        positionCode: positionCode || null,
        values,
      });
      toast(
        r.opened
          ? '已交给系统默认程序打开。若窗口没出现，说明本机未关联 Word，请用「下载」后查看。'
          : '本机未关联 Word，请用「下载」后查看。',
        r.opened ? 'ok' : 'info',
      );
    });

  /** 预览计划里的一段 → 页面内可读的表格/分节（变量已被服务端替换成实际值） */
  const renderSegment = (seg: PreviewSegment, i: number) => {
    if (seg.kind === 'text') {
      return (
        <div key={i} className="mb12">
          {seg.part && <div className="small muted mb8">{seg.part}</div>}
          <div className="preview-pane">{(seg.lines ?? []).join('\n')}</div>
        </div>
      );
    }
    if (seg.kind === 'table') {
      const rows = seg.rows ?? [];
      const shown = rows.slice(0, PREVIEW_MAX_ROWS);
      return (
        <div key={i} className="mb12">
          <div className="small muted mb8">
            表格{seg.collection ? `（循环集合「${seg.collection}」）` : ''} · 共 {rows.length} 行
            {seg.truncatedRows ? `（已折叠 ${seg.truncatedRows} 行，完整内容请下载或用系统打开）` : ''}
          </div>
          <div style={{ overflow: 'auto', maxHeight: 320 }}>
            <table className="table">
              {seg.headers && seg.headers.length > 0 && (
                <thead>
                  <tr>{seg.headers.map((h, j) => <th key={j}>{h}</th>)}</tr>
                </thead>
              )}
              <tbody>
                {shown.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) => (
                      <td key={ci} style={{ whiteSpace: 'pre-wrap' }}>{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > PREVIEW_MAX_ROWS && (
            <div className="small muted mt8">
              页面里只展开前 {PREVIEW_MAX_ROWS} 行（共 {rows.length} 行），其余请下载或用系统打开查看。
            </div>
          )}
        </div>
      );
    }
    return (
      <div key={i} className="mb12">
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          {seg.url ? (
            <img
              src={seg.url}
              alt={seg.caption ?? '图片'}
              style={{ maxWidth: 220, maxHeight: 220, borderRadius: 8, border: '1px solid var(--line)', background: '#f4f4f5' }}
            />
          ) : (
            <div className="small muted" style={{ width: 220 }}>（缩略图不可用）</div>
          )}
          <div className="small">
            {seg.caption}
            {seg.inserted === false && <div style={{ color: 'var(--warn)' }}>{seg.missingNote}</div>}
          </div>
        </div>
      </div>
    );
  };

  return (
    <Modal
      open
      wide
      title={`出文书 · ${templateName ?? fields.data?.template.name ?? ''}`}
      onClose={close}
      footer={
        <>

          <span className="muted small" style={{ marginRight: 'auto' }}>
            {summary
              ? `${summary.total} 项内容　·　需补充 ${missingRequired.length} 项`
              : ''}
            {draft ? `　·　模型 ${draft.model}，${draft.usage.total} tokens` : ''}
          </span>
          <Button onClick={doPreview} disabled={busy || !variables.length} title="在页面里看内容（变量已替换），不下载文件">
            {busy ? '预览中…' : '预览'}
          </Button>
          <Button onClick={() => doSave(undefined,saveMode==='new'?'new':'update')} disabled={busy || !variables.length}>保存草稿</Button>
          <Button kind="primary" onClick={() => doSave(undefined,'final')} disabled={busy || !variables.length || !!chain.data?.blocked}>核对无误并定稿</Button>
        </>
      }
    >
      {chain.data?.blocked&&<p className="notice">已有定稿不能覆盖。若需修改，请先保存新草稿，再从成果的“修改 / 定稿”入口核对新版本；旧定稿会保留。</p>}
      {fields.loading ? (
        <Loading text="正在读取模板变量…" />
      ) : fields.error ? (
        <div className="notice notice-err">读取变量失败：{fields.error.message} <Button onClick={fields.reload}>重试</Button></div>
      ) : variables.length === 0 ? (
        <div className="notice notice-warn">
          这个模板里没有可填的变量。请打开模板确认已把可变内容写成 <code>{'{变量名}'}</code>，然后到「模板库」重新扫描。
        </div>
      ) : (
        <>
          {draft?.warnings.map((w, i) => (
            <div key={i} className="notice notice-warn mb8">
              {w}
            </div>
          ))}
          {draft?.error && <div className="notice notice-err mb8">{draft.error}</div>}

          {/* 检索到的制度原文可核查；检索命中不等于内容已经合规。 */}
          {draft?.ok && (draft.knowledge?.length ?? 0) === 0 && draft.knowledgeError && (
            <div className="notice notice-info mb8">
              制度检索提示：{draft.knowledgeError}
              <br />
              <span className="muted small">
                请到知识库确认制度已抽取，或指定适用制度。涉及制度的内容仍需核对。
              </span>
            </div>
          )}
          {draft?.ok && (draft.knowledge?.length ?? 0) > 0 && (
            <Card title={`本轮检索到的制度（${draft.knowledge!.length}）`} collapsible>
              <p className="muted small" style={{ marginTop: 0 }}>
                以下是本轮给模型参考的制度片段。检索分数表示相关度，不表示内容已合规；定稿前请核对适用范围、版本和引用。
              </p>
              <div className="col" style={{ gap: 6 }}>
                {draft.knowledge!.map((k, i) => (
                  <div key={i} className="col small" style={{ gap: 4 }}>
                    <div className="row" style={{ gap: 8 }}>
                    <Tag kind={k.source.includes('制度') ? 'info' : 'ok'}>{k.source}</Tag>
                    <span className="ellipsis" style={{ flex: 1 }}>
                      《{k.title}》{k.docNo ? `（${k.docNo}）` : ''}
                      {k.heading ? <span className="muted"> · {k.heading}</span> : null}
                    </span>
                    {k.optional ? (
                      <span className="muted nowrap">可选</span>
                    ) : (
                      <span className="muted nowrap">{{ fulltext: '全文命中', semantic: '语义命中', both: '全文+语义', specified: '指定制度' }[k.retrieval ?? ''] ?? '检索命中'}</span>
                    )}
                    </div>
                    {k.snippet && <details><summary>查看本轮参考原文</summary><p style={{ whiteSpace: 'pre-wrap' }}>{k.snippet}</p></details>}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 自动带出的部分：折叠起来，不用你操心 */}
          {autoVars.length > 0 && (
            <Card title={`已自动带出（${autoVars.length}）`} collapsible>
              <p className="muted small" style={{ marginTop: 0 }}>
                这些值来自项目信息和系统（如今天的日期），已经填好了。要改的话点开直接改。
              </p>
              <div className="col" style={{ gap: 8 }}>
                {autoVars.map((v) => (
                  <div className="row" key={v.name} style={{ gap: 10, alignItems: 'center' }}>
                    <span className="small" style={{ width: 130, flexShrink: 0 }}>
                      {v.label ?? v.name}
                    </span>
                    <div style={{ flex: 1 }}>
                      {v.collectionFields?.length?<CollectionEditor name={v.label??v.name} columns={v.collectionFields} value={values[v.name]??''} onChange={val=>setValues({...values,[v.name]:val})}/>:<Textarea rows={v.type==='longtext'||(values[v.name]?.length??0)>80?4:2} value={values[v.name] ?? ''} onChange={(val) => setValues({ ...values, [v.name]: val })} />}
                    </div>
                    {v.source && <Tag kind="ok">{SOURCE_LABEL[v.source] ?? v.source}</Tag>}
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* 要填的部分 */}
          <Card
            title={`需要填写（${todoVars.length}）`}
            extra={
              <>
                <Button size="sm" onClick={() => doDraft(true)} disabled={busy}>
                  只填已知信息
                </Button>
                <Button size="sm" kind="primary" onClick={() => doDraft(false)} disabled={busy}>
                  {busy ? '处理中…' : '✎ 让模型补全'}
                </Button>
              </>
      }
          >
            {todoVars.length === 0 ? (
              <Empty text="所有内容都能自动带出，直接保存即可。" />
            ) : (
              <div className="col" style={{ gap: 0 }}>
                {todoVars.map((v) => (
                  <div className="var-row" key={v.name}>
                    <div>
                      <div className="var-name">
                        {v.label ?? v.name}
                        {v.required !== false && <span className="req"> *</span>}
                      </div>
                      <div className="small muted mono">{v.name}</div>
                      {v.hint && !v.collectionFields?.length&&<div className="small muted">{v.hint}</div>}
                      {v.source === 'mapped-empty' && (
                        <div className="small" style={{ color: 'var(--warn)' }}>
                          项目信息里有这一项但还没填 —— 填了以后就不用每次手打了
                        </div>
                      )}
                      {draft?.rationale?.[v.name] && (
                        <div className="small" style={{ color: 'var(--info)' }} title="模型说明这个值的依据">
                          依据：{draft.rationale[v.name]}
                        </div>
                      )}
                    </div>
                    <div>
                      {v.collectionFields?.length?<CollectionEditor name={v.label??v.name} columns={v.collectionFields} value={values[v.name]??''} onChange={val=>setValues({...values,[v.name]:val})}/>:v.type === 'longtext' ? (
                        <Textarea
                          value={values[v.name] ?? ''}
                          onChange={(val) => setValues({ ...values, [v.name]: val })}
                          rows={4}
                          placeholder={v.example ?? ''}
                        />
                      ) : (
                        <Input
                          value={values[v.name] ?? ''}
                          onChange={(val) => setValues({ ...values, [v.name]: val })}
                          placeholder={v.example ?? ''}
                        />
                      )}
                      {(values[v.name] ?? '').includes('【待补') && (
                        <div className="small" style={{ color: 'var(--warn)' }}>
                          ⚠ 这项还是待补状态，定稿前请填上
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* 补充要求与参考资料：默认折叠，多数时候用不上 */}
          <Card
            title="补充要求 / 参考资料"
            collapsible
            extra={
              <Button size="sm" onClick={() => setShowRefs((s) => !s)}>
                {showRefs ? '收起' : `参考资料${refIds.length ? `（已选 ${refIds.length}）` : ''}`}
              </Button>
            }
          >
            <Field label="本次特别要求" hint="填写本次文书的补充要求、结构或措辞偏好…">
              <Textarea
                value={instruction}
                onChange={setInstruction}
                rows={3}
                placeholder="把这次的具体情况写在这里，模型会据此生成内容"
              />
            </Field>
            <p className="small muted">这里选择的是本次实际工作材料。</p>
            {showRefs && (
              <Field label="参考资料" hint="勾选后会把文件正文一起给模型看">
                {refs.loading ? (
                  <Loading text="读取资料…" />
                ) : referenceItems.length === 0 ? (
                  <div className="small muted">这份工作还没有上传资料。</div>
                ) : (
                  <div className="col" style={{ gap: 4, maxHeight: 200, overflow: 'auto' }}>
                    {referenceItems.map((a) => (
                      <label key={a.id} className="row small clickable" style={{ gap: 6 }}>
                        <input
                          type="checkbox"
                          className="check-box"
                          checked={refIds.includes(a.id)}
                          onChange={(e) => setRefIds(e.target.checked ? [...refIds, a.id] : refIds.filter((x) => x !== a.id))}
                        />
                        <span className="ellipsis" style={{ flex: 1 }}>
                          {a.title}
                        </span>
                        <span className="muted mono nowrap">{a.file_name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </Field>
            )}
          </Card>

          {/*
            B3-9：制度依据（条款级引用）+ 出文书前口径校验。
            放在「保存方式」之前 —— 先把依据核对干净，再决定这一版怎么存。
          */}
          {factConflicts.length > 0 && <Card title="事实来源冲突 · 定稿前逐项确认">
            <p>可采用记忆中的值，或保留本次核对值；请填写实际确认依据。改变字段后须重新确认。</p>
            {factConflicts.map(c=><div className="col" key={c.field}><strong>{c.field} · 当前填写：{values[c.field] ?? ''}</strong>
              {c.candidates.map(x=><div className="row" key={x.id}><span>记忆 #{x.id}：{x.value} · 来源：{x.source || '未说明'}</span><Button disabled={busy} onClick={()=>setValues(v=>({...v,[c.field]:x.value}))}>采用此值</Button></div>)}
              <Input value={factReasons[c.field] ?? ''} onChange={reason=>{setFactReasons(v=>({...v,[c.field]:reason}));setFactChoices(v=>{const next={...v};delete next[c.field];return next;});}} placeholder="确认依据，例如本期已核对统计表"/>
              <Button disabled={busy || !factReasons[c.field]?.trim()} onClick={()=>setFactChoices(v=>({...v,[c.field]:{value:values[c.field] ?? '',reason:factReasons[c.field]!}}))}>确认采用当前填写值</Button>
              {factChoices[c.field]?.value===(values[c.field] ?? '') && <span>已记录选择与依据</span>}
            </div>)}
          </Card>}
          {/* 保存方式（B1-4）：同一份文书改三遍，以前是三个并列的独立文档，谁也说不清哪份是最终版 */}
          {workbenchId && <BusinessEvidence workbenchId={workbenchId} periodId={periodId} snapshot={draft?.evidence}/>}
          <Card title="更多保存选项与版本" collapsible defaultOpen={false}>
            <p className="muted small" style={{ marginTop: 0 }}>
              {chain.data?.message?.replace(/期次[\\/](\d{4}-\d{2})[\\/]检查[\\/](\d+)[\\/]修订[\\/]\d+/g,'$1 · 检查 #$2') ?? '正在确认文书版本…'}
            </p>
            <div className="col" style={{ gap: 6 }}>
              {SAVE_MODE_OPTIONS.map((o) => {
                const disabled = busy || (Boolean(chain.data?.blocked) && o.value !== 'new');
                return (
                  <label
                    key={o.value}
                    className="row small clickable"
                    style={{ gap: 6, alignItems: 'flex-start', opacity: disabled ? 0.5 : 1 }}
                    title={disabled ? chain.data?.message ?? '' : o.hint}
                  >
                    <input
                      type="radio"
                      className="check-box"
                      name="save-mode"
                      checked={saveMode === o.value}
                      disabled={disabled}
                      onChange={() => setSaveMode(o.value)}
                    />
                    <span>
                      <strong>{o.label}</strong>
                      {o.value === 'update' && <span className="muted">（推荐）</span>}
                      <span className="muted">　{o.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {chain.data?.blocked && (
              <div className="notice notice-warn mt8 small">
                {chain.data.message}
              </div>
            )}
          </Card>

          {missingRequired.length > 0 && (
            <div className="notice notice-warn">
              还有 <strong>{missingRequired.length}</strong> 项必填没填：{missingRequired.map((v) => v.label ?? v.name).join('、')}
              。直接保存的话，文件里会原样保留 <code>{'{变量名}'}</code> 占位符，方便你打开 Word 手工补。
            </div>
          )}

          {/* 页面内预览（B4-12）：不再是"下载一个 docx 让你自己开" */}
          {preview && (
            <Card title="预览（内容 · 页面内）">
              {/*
                产物合法性横幅（B4-12 必做②）：绿 = 结构合法可正常打开；
                红 = 结构异常并写明原因，同时说明**已阻止保存**。
                没有这条横幅，预览就只是好看。
              */}
              {preview.check.ok ? (
                <div className="notice notice-ok mb12">
                  ✓ {preview.check.reason}
                  {preview.check.kind === 'plain-text' && <span className="muted">（纯文本模板不做 XML 校验）</span>}
                </div>
              ) : (
                <div className="notice notice-err mb12">
                  ✗ 产物结构异常，已阻止保存：{preview.check.reason}
                  {preview.check.errors.length > 1 && (
                    <ul className="small" style={{ margin: '6px 0 0 18px' }}>
                      {preview.check.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                  <div className="small mt8">
                    先修模板或重新上传（模板库里的「重新扫描/体检」），再出文书；这样保存出来的文件 Word 才打得开。
                  </div>
                </div>
              )}

              {/* 口径提示：内容预览 ≠ 排版预览，界面必须写明（B4-12 风险①） */}
              <p className="muted small" style={{ marginTop: 0 }}>{preview.plan?.paginationNote}</p>

              {preview.plan && (
                <div className="row small muted mb8" style={{ gap: 10, flexWrap: 'wrap' }}>
                  <span>
                    {preview.plan.counts.text} 段文字 · {preview.plan.counts.table} 个表格 · {preview.plan.counts.image} 张图片
                  </span>
                  <span>表格共 {preview.plan.tableRows} 行</span>
                  <span>{Math.max(1, Math.round(preview.plan.renderedBytes / 1024))} KB</span>
                </div>
              )}

              {preview.warnings.map((w, i) => (
                <div key={i} className="notice notice-warn mb8 small">{w}</div>
              ))}
              {preview.missing.length > 0 && (
                <div className="notice notice-warn mb8 small">
                  这些项没有值，页面里与真实文书里都会原样保留 <code>{'{变量名}'}</code>：{preview.missing.slice(0, 12).join('、')}
                  {preview.missing.length > 12 ? ` 等 ${preview.missing.length} 项` : ''}
                </div>
              )}

              {(preview.plan?.segments.length ?? 0) === 0 ? (
                <Empty text="这个模板里没有可展示的正文内容（可能是空模板，或内容全在图片/表格里没扫到）。" />
              ) : (
                <div style={{ maxHeight: 480, overflow: 'auto' }}>
                  {preview.plan!.segments.map(renderSegment)}
                </div>
              )}

              {/*
                只做文本/表格/图片三层的如实说明（B4-12 验收④与风险①）：
                缩略图/分页示意图**没有可靠实现**，所以这里明说"仅内容预览 + 图片缩略图"，
                绝不画一个假的页面示意图让人以为那就是排版。
              */}
              <details className="small muted mt8">
                <summary className="clickable">这次预览做到了什么、没做什么</summary>
                <ul style={{ margin: '6px 0 0 18px' }}>
                  {(preview.plan?.limitations ?? []).map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                  <li>没有页面缩略图/分页示意图：浏览器里没有可靠的 docx 排版渲染，本项目不做假示意图；要看真实版式请用「用系统打开」。</li>
                </ul>
              </details>

              <div className="row mt12" style={{ gap: 8 }}>
                <Button size="sm" onClick={doDownload} disabled={busy} title="兜底：把这一次的渲染结果下载到本机">
                  下载
                </Button>
                <Button size="sm" onClick={doOpenInSystem} disabled={busy} title="写一份临时文件交给本机 Word 打开（最准的版式预览）">
                  用系统打开
                </Button>
                <div className="spacer" />
                <Button size="sm" kind="ghost" onClick={() => setPreview(null)} disabled={busy}>
                  收起预览
                </Button>
              </div>
              <div className="small muted mt8">
                临时文件写在平台自己的运行目录（uuid 命名、24 小时过期、不进「文件」清单），不会落到你绑定的资料目录里。
              </div>
            </Card>
          )}

          {draft?.rawText && (
            <Card title="模型返回内容（非合法 JSON，供你手工整理）">
              <div className="preview-pane">{draft.rawText}</div>
            </Card>
          )}
        </>
      )}
    </Modal>
  );
}
