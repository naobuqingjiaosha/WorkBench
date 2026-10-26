import {DocVersionsModal} from '../pages/DocVersions';
/**
 * 页面内预览（清单 B4-12「真·预览」）
 *
 * 以前想看一份文件长什么样，唯一入口是「下载」——用户必须离开浏览器、磁盘上留副本。
 * 这个组件把 `GET /api/artifacts/:id/preview` 的结果**按后端说的 kind 渲染**：
 *   · image      → `<img>`（原图）
 *   · pdf        → `<iframe>`（浏览器内置阅读器）
 *   · text       → `<pre className="preview-pane">`（原文，超 2 MiB 会截断并说明）
 *   · unsupported→ 明确的「不能预览」提示 + 原因；docx/xlsx 额外显示**文本摘要**，
 *                  并写明"这是文本摘要，不是排版预览"（后端 excerptNote 的原话）
 *
 * 三条底线：
 *   ① 不假装：不支持的类型就说支持不了，绝不显示一个空白框充数；
 *   ② 不改变既有下载行为：弹窗底部的「下载」按钮走的就是**原来那个** `/api/artifacts/:id/file`；
 *   ③ 样式沿用项目既有组件与类（Modal / Button / Tag / notice-xxx / preview-pane），不新造样式体系。
 */
import { useState } from 'react';
import { api, useApi } from '../api';
import { Button, Loading, Modal, Tag, fmtSize } from '../ui';

export interface PreviewData {
  sheets?:{name:string;rows:{text:string;colSpan:number;rowSpan:number}[][]}[];
  id: number;
  title: string;
  fileName: string;
  fileRel: string;
  kind: 'image' | 'pdf' | 'text' | 'spreadsheet' | 'unsupported';
  supported: boolean;
  renderAs: 'img' | 'iframe' | 'text' | 'none';
  mime: string;
  sizeBytes: number;
  recordedBytes: number | null;
  contentUrl: string | null;
  downloadUrl: string;
  text?: string;
  encoding?: string;
  truncated?: boolean;
  chars?: number;
  excerpt?: string;
  excerptNote?: string;
  reason?: string;
  note?: string;
}

const KIND_TEXT: Record<PreviewData['kind'], string> = {
  spreadsheet:'Excel内容预览',
  image: '图片',
  pdf: 'PDF',
  text: '文本',
  unsupported: '不能预览',
};

export function FilePreview({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useApi<PreviewData>(`/api/artifacts/${id}/preview`);
  /** 图片解码失败：要看得见，而不是留一块空白让人以为"文件是空的" */
  const [imgFailed, setImgFailed] = useState(false);
  const data = d.data;
  const [versions,setVersions]=useState(false);
  const info=useApi<{artifact:{kind:string;is_final?:number;revision?:number;workbench_id:number|null;created_at:string}}>(`/api/artifacts/${id}`);

  const footer = (
    <>
      {info.data?.artifact.kind==='generated'&&<Button onClick={()=>setVersions(true)}>版本与差异</Button>}
      <Button onClick={onClose}>关闭</Button>
      {data && (
        // 兜底下载：与列表里的「下载」是同一个接口、同一个 api.download，行为一字未改
        <Button kind="primary" onClick={() => api.download(data.downloadUrl, data.fileName)}>
          下载副本
        </Button>
      )}
    </>
  );

  return (
    <Modal open wide title={data ? `预览：${data.title || data.fileName}` : '预览'} onClose={onClose} footer={footer}>
      {versions&&<DocVersionsModal id={id} onClose={()=>setVersions(false)}/>}
      {info.data&&<p className="small muted">工作 #{info.data.artifact.workbench_id??'未关联'} · 版本 {info.data.artifact.revision??'未标注'} · {info.data.artifact.is_final?'已定稿':'未定稿'}。下载副本不自动同步。</p>}
      {d.loading ? (
        <Loading text="正在读取文件内容…" />
      ) : d.error ? (
        <div className="notice notice-err">
          加载失败：{d.error.message} <Button onClick={d.reload}>重试</Button>
          <div className="small muted mt8">
            文件可能已被移到回收站、或已被手工删除。可以回到列表点「详情」看登记位置，或直接下载试试。
          </div>
        </div>
      ) : !data ? (
        <div className="notice notice-err">加载失败：没有拿到预览内容。</div>
      ) : (
        <>
          <div className="row" style={{ gap: 8 }}>
            <Tag kind={data.supported ? 'info' : 'warn'}>{KIND_TEXT[data.kind]}</Tag>
            <span className="small muted">
              {data.fileName} · {fmtSize(data.sizeBytes)} · {data.mime}
              {data.kind === 'text' && data.encoding && data.encoding !== 'utf-8' ? ` · 按 ${data.encoding.toUpperCase()} 解码` : ''}
            </span>
            <div className="spacer" />
            {data.contentUrl && (
              <a className="small clickable" href={data.contentUrl} target="_blank" rel="noreferrer">
                在新标签打开
              </a>
            )}
          </div>

          {/* 图片：直接看原图 */}
          {data.kind === 'image' && data.contentUrl && !imgFailed && (
            <div className="mt12">
              <img
                src={data.contentUrl}
                alt={data.title || data.fileName}
                onError={() => setImgFailed(true)}
                style={{ maxWidth: '100%', maxHeight: '62vh', display: 'block', borderRadius: 8, border: '1px solid var(--line)', background: '#f4f4f5' }}
              />
              {data.note && <div className="small muted mt8">{data.note}</div>}
            </div>
          )}
          {data.kind === 'image' && imgFailed && (
            <div className="notice notice-err mt12">
              图片没能显示出来（文件可能损坏，或磁盘上的文件已经不在了）。请点「下载」确认，或回列表看「详情」里的登记位置。
            </div>
          )}

          {/* PDF：交给浏览器内置阅读器 */}
          {data.kind === 'pdf' && data.contentUrl && (
            <div className="mt12">
              <iframe
                src={data.contentUrl}
                title={data.title || data.fileName}
                style={{ width: '100%', height: '62vh', border: '1px solid var(--line)', borderRadius: 8, background: '#f4f4f5' }}
              />
              {data.note && <div className="small muted mt8">{data.note}</div>}
            </div>
          )}

          {/* 文本：原文内容 */}
          {data.kind === 'text' && (
            <div className="mt12">
              {data.truncated && (
                <div className="notice notice-warn small">
                  文件较大，页面里只显示了一部分（{data.chars ?? 0} 字 / 共 {fmtSize(data.sizeBytes)}），后面的内容请下载查看。
                </div>
              )}
              <pre className="preview-pane mt8">{data.text ?? ''}</pre>
              {data.note && <div className="small muted mt8">{data.note}</div>}
            </div>
          )}

          {data.kind==='spreadsheet'&&<div style={{overflow:'auto',maxHeight:'62vh'}}>{data.sheets?.map((sheet,n)=><section key={n}><h4>{sheet.name}</h4><table style={{borderCollapse:'collapse',width:'100%'}}><tbody>{sheet.rows.map((row,r)=><tr key={r}>{row.map((cell,c)=><td key={c} colSpan={cell.colSpan} rowSpan={cell.rowSpan} style={{border:'1px solid var(--line)',padding:8,whiteSpace:'pre-wrap',minWidth:60}}>{cell.text}</td>)}</tr>)}</tbody></table></section>)}<p className="small muted">{data.note}</p></div>}
          {/* 不支持：说清为什么，并且给可核实的替代信息 */}
          {data.kind === 'unsupported' && (
            <div className="mt12">
              <div className="notice notice-warn">
                不能在页面里预览：{data.reason ?? '这个类型没有页面内预览。'}
              </div>
              {data.excerpt ? (
                <>
                  <div className="notice notice-info small mt12">{data.excerptNote}</div>
                  <pre className="preview-pane mt8">{data.excerpt}</pre>
                </>
              ) : (
                <div className="small muted mt12">{data.note ?? '没有可显示的文本内容，请下载后用对应的软件打开。'}</div>
              )}
            </div>
          )}

          <div className="small muted mt16 mono">{data.fileRel}</div>
        </>
      )}
    </Modal>
  );
}

/**
 * 列表行里的「预览」入口：自带开合状态，摆一个标签就行
 * （放在文件行上，与既有「下载」按钮并列，不动下载的行为）。
 */
export function FilePreviewButton({
  artifact,
  size = 'sm',
  label = '预览',
}: {
  artifact: { id: number; file_name?: string; title?: string };
  size?: 'sm' | 'md';
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} onClick={() => setOpen(true)} title={`在页面里直接看「${artifact.title || artifact.file_name || ''}」的内容，不下载`}>
        {label}
      </Button>
      {open && <FilePreview id={artifact.id} onClose={() => setOpen(false)} />}
    </>
  );
}
