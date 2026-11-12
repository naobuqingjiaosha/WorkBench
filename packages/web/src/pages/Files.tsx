import {useEditorGuard} from '../components/NavigationGuard';
import {useModalSave} from '../components/useUnsavedClose';
import {useWorkbenchCollection} from '../components/useWorkbenchCollection';
import {WorkbenchSelect} from '../components/WorkbenchSelect';
import {SectionNav,LoadError} from '../components/DesignSystem';
import {DocVersionsModal} from './DocVersions';
import { useEffect, useRef, useState } from 'react';
import { api, useApi, type Artifact } from '../api';
import { Button, Card, Empty, Field, Input, Loading, Modal, Select, Tag, Textarea, fmtSize, fmtTime, useDebounced, useToast } from '../ui';
import { FilePreview } from '../components/FilePreview';
import type { RouteKey } from '../App';
/** `DELETE /api/artifacts/:id` 的返回（routes-files.ts）。软删除这条路一定带 `message`，原样转述 */
interface DeleteArtifactResult {
  deleted: boolean;
  /** 这次是"移到回收站"（软删除），不是彻底删除 —— 磁盘文件默认不动 */
  trashed: boolean;
  /** 磁盘文件有没有被真的删掉（不带 `withFile=1` 时恒为 false） */
  fileRemoved: boolean;
  message: string;
}

const KIND_TEXT: Record<string, string> = {
  generated: '生成文书',
  evidence: '影像证据',
  source: '原始资料',
  scan: '扫描件',
  template: '模板',
  other: '其它',
};

export default function FilesPage({ params, go }: { params: Record<string, string>; go: (k: RouteKey, p?: Record<string, string>) => void }) {
  const toast = useToast();
  const [keyword, setKeyword] = useState('');
  const [workbenchId, setWorkbenchId] = useState(params.workbenchId ?? '');
  const [kind, setKind] = useState('');
  const [versionId,setVersionId]=useState<number|null>(null);
  const [uploadOpen,setUploadOpen]=useState(false),[uploadFile,setUploadFile]=useState<File|null>(null),[uploadKind,setUploadKind]=useState('source'),[uploadBusy,setUploadBusy]=useState(false),[uploadError,setUploadError]=useState('');
  const uploadPending=useRef(false);
  const clearUpload=()=>{setUploadOpen(false);setUploadFile(null);setUploadError('');setUploadKind('source');};
  const saveUpload=async()=>{
    if(uploadPending.current)throw Error('文件正在上传，请稍候');
    if(!uploadFile||!workbenchId)throw Error('请选择文件及所属工作');
    uploadPending.current=true;setUploadBusy(true);setUploadError('');
    try{const form=new FormData();form.append('file',uploadFile);form.append('workbenchId',workbenchId);form.append('kind',uploadKind);await api.upload('/api/artifacts/upload',form);clearUpload();reloadAll();toast('文件已上传','ok');}
    catch(e){setUploadError((e as Error).message);throw e;}
    finally{uploadPending.current=false;setUploadBusy(false);}
  };
  const requestUpload=useEditorGuard({dirty:uploadOpen&&!!uploadFile,busy:uploadBusy,save:saveUpload,discard:clearUpload});
  const closeUpload=()=>requestUpload(clearUpload);
  const [mode, setMode] = useState<'or' | 'and'>('or');
  const [detailId, setDetailId] = useState<number | null>(null);
  /** B4-12 正在页面内预览的那份文件（点「预览」或点缩略图） */
  const [previewOf, setPreviewOf] = useState<number | null>(null);
  const linkedArtifactId = Number(params.artifact);
  const linkedPreview = Number.isSafeInteger(linkedArtifactId) && linkedArtifactId > 0;
  const previewId = linkedPreview ? linkedArtifactId : previewOf;
  const closePreview = () => {
    setPreviewOf(null);
    if (linkedPreview) {
      const rest = {...params};
      delete rest.artifact;
      go('files', rest);
    }
  };
  const debounced = useDebounced(keyword, 400);
  const [page,setPage]=useState(0);
  const pageSize=20;
  useEffect(()=>setPage(0),[debounced,workbenchId,kind,mode]);

  const workbenches = useWorkbenchCollection();
  const stats = useApi<{ total: number; bytes: number; byKind: { kind: string; n: number; bytes: number }[]; indexed: number; missingFiles: { id: number; file_rel: string }[]; dataRoot: string }>(
    '/api/files/stats',
  );

  const searching = debounced.trim().length > 0;
  const searchResult = useApi<{ total: number; items: Artifact[]; keyword: string }>(
    searching
      ? `/api/search?${new URLSearchParams({ q: debounced, ...(workbenchId ? { workbenchId } : {}), ...(kind ? { kind } : {}), mode, limit: String(pageSize),offset:String(page*pageSize) }).toString()}`
      : null,
    [debounced, workbenchId, kind, mode],
  );
  const browse = useApi<{ total: number; items: Artifact[] }>(
    !searching ? `/api/artifacts?${new URLSearchParams({ ...(workbenchId ? { workbenchId } : {}), ...(kind ? { kind } : {}), limit: String(pageSize),offset:String(page*pageSize) }).toString()}` : null,
    [workbenchId, kind],
  );

  const items = searching ? searchResult.data?.items ?? [] : browse.data?.items ?? [];
  const loading = searching ? searchResult.loading : browse.loading;
  const wbName = (id: number | null) => workbenches.data?.items.find((w) => w.id === id);
  const categories = Object.entries(KIND_TEXT).map(([value,label]) => {
    if (value === 'template') return {value:'template-library',label:'前往模板库 →'};
    return {value,label:value==='generated'?'成果文件':label,count:stats.data?.byKind.find(k=>k.kind===value)?.n};
  });

  const reloadAll = () => {
    if (searching) searchResult.reload();
    else browse.reload();
    stats.reload();
  };

  const total=searching?searchResult.data?.total:browse.data?.total;
  useEffect(()=>{
    if(total!==undefined&&page*pageSize>=total&&page>0)setPage(Math.max(0,Math.ceil(total/pageSize)-1));
  },[total,page]);
  return (
    <div className="section-content file-library">
      <div className="library-toolbar">
        <SectionNav value={kind} onChange={v=>{if(v==='template-library')go('knowledge',{module:'template'});else setKind(v);}}
          items={[{value:'',label:'全部业务文件',count:stats.data?.total},...categories]}/>
        <Button size="sm" onClick={()=>go('workbench')}>按工作台看</Button>
        <Button size="sm" onClick={reloadAll}>刷新</Button>
        <Button kind="primary" onClick={()=>setUploadOpen(true)}>上传文件</Button>
      </div>
      <Card className="file-results">
        <div className="file-filter-bar">
        <div className="file-search-inputs">
          <div>
            <Input value={keyword} onChange={setKeyword} placeholder="搜文件内容、标题、文件名…例如：验收资料 / 应急照明 / 开箱" />
          </div>
          <Select
            value={mode}
            onChange={(v) => setMode(v as 'or' | 'and')}
            options={[
              { value: 'or', label: '任一关键词' },
              { value: 'and', label: '同时包含' },
            ]}
          />
        </div>
        <div className="inline-fields mt12">
          <Field label="限定工作台">
            <WorkbenchSelect collection={workbenches} value={workbenchId} onChange={setWorkbenchId} placeholder="全部工作台" label={w=>`${w.code} ${w.name}`}/>
          </Field>
          <Field label="文件类别">
            <Select
              value={kind}
              onChange={setKind}
              placeholder="全部类别"
              options={Object.entries(KIND_TEXT).map(([v, l]) => ({ value: v, label: l }))}
            />
          </Field>
        </div>
        </div>
        <div className="small muted">
          {searching ? (
            <>
              检索「{debounced}」，命中 <strong>{searchResult.data?.total ?? 0}</strong> 条（按相关度排序，匹配的是文件正文内容，不只是文件名）
            </>
          ) : (
            <>
              共 <strong>{browse.data?.total ?? 0}</strong> 个文件，已建索引 {stats.data?.indexed ?? 0} 条。输入关键词即可在文件正文里检索。
            </>
          )}
        </div>


      {(stats.data?.missingFiles?.length ?? 0) > 0 && (
        <div className="notice notice-warn">
          有 {stats.data?.missingFiles.length} 个文件在数据库里有记录、但磁盘上找不到（可能是被手工删掉或移走了）：
          {stats.data?.missingFiles.slice(0, 5).map((f) => (
            <div key={f.id} className="mono small">
              {f.file_rel}
            </div>
          ))}
        </div>
      )}

        <div className="file-list-head"><h3>{searching?'检索结果':kind?KIND_TEXT[kind]:'全部业务文件'}</h3>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  const r = await api.post<{ reindexed: number }>('/api/files/reindex');
                  toast(`已重建 ${r.reindexed} 条索引`, 'ok');
                  stats.reload();
                } catch (e) {
                  toast((e as { message: string }).message, 'err');
                }
              }}
              title="把手工复制进数据目录的文件重新纳入检索"
            >
              重建索引
            </Button>
        </div>
        {(searching?searchResult.error:browse.error) ? <LoadError error={(searching?searchResult.error:browse.error)!} retry={reloadAll}/> : loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty
            text={searching ? '没有找到匹配的文件。换个关键词，或把检索模式改成「任一关键词」。' : '还没有文件。'}
            action={<Button onClick={()=>{if(searching){setKeyword('');setKind('');setWorkbenchId('');}else setUploadOpen(true);}}>{searching?'清除筛选':'上传文件'}</Button>}
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">文件</th>
                <th scope="col">所属工作</th>
                <th scope="col">类别</th>
                <th scope="col">版本 / 状态</th>
                <th scope="col">大小</th>
                <th scope="col">时间</th>
                <th scope="col" aria-label="文件操作" />
              </tr>
            </thead>
            <tbody>
              {items.map((a) => {
                const wb = wbName(a.workbench_id);
                return (
                  <tr key={a.id}>
                    <td>
                      <div className="row" style={{ gap: 9 }}>
                        {isImg(a) ? (
                          // 缩略图本身就是最直接的预览入口（B4-12）：点一下在页面里看原图
                          <img
                            src={`/api/artifacts/${a.id}/file`}
                            className="clickable"
                            title="点一下在页面里预览"
                            onClick={() => setPreviewOf(a.id)}
                            style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 5 }}
                          />
                        ) : (
                          <span className={`file-ico ${a.file_ext?.includes('xls') ? 'xls' : a.file_ext?.includes('doc') ? 'doc' : 'pdf'}`}>
                            {(a.file_ext ?? '').replace('.', '').slice(0, 4).toUpperCase()}
                          </span>
                        )}
                        <div className="check-main">
                          <div className="check-title" title={a.file_rel}>{a.title || a.file_name}</div>
                        </div>
                      </div>
                    </td>
                    {(
                      <td className="small nowrap">
                        {wb ? (
                          <a className="clickable" onClick={() => go('workbench', { id: String(wb.id) })}>
                            {wb.name}
                          </a>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    <td className="small nowrap">
                      <Tag>{KIND_TEXT[a.kind] ?? a.kind}</Tag>
                    </td>
                    <td className="small muted nowrap">{a.kind==='generated'?<><Tag>{a.is_final?'已定稿':'未定稿'}</Tag><div>版本 {a.revision??'未标注'}</div></>:'—'}</td>
                    <td className="small muted nowrap">{fmtSize(a.size_bytes)}</td>
                    <td className="small muted nowrap">{fmtTime(a.captured_at ?? a.created_at)}</td>
                    <td className="nowrap">
                      {/* B4-12 真·预览：页面里直接看内容，不必下载（图片/PDF 直接渲染） */}
                      <Button size="sm" onClick={() => setPreviewOf(a.id)} title="在页面里直接看内容（图片/PDF/文本），不用下载">
                        预览
                      </Button>
                      <Button size="sm" onClick={() => api.download(`/api/artifacts/${a.id}/file`, a.file_name)}>
                        下载副本
                      </Button>
                      <details className="row-more"><summary>更多</summary>{a.kind==='generated'&&<Button size="sm" onClick={()=>setVersionId(a.id)}>版本记录</Button>}<Button size="sm" onClick={() => setDetailId(a.id)} title="查看详情、识别文字、重新识别">
                        详情
                      </Button>
                      <Button
                        size="sm"
                        kind="danger"
                        onClick={async () => {
                          /**
                           * 这里调的是 `DELETE /api/artifacts/:id`（**不带** `withFile=1`），
                           * 后端是软删除：记录进回收站、磁盘文件一个都不动、能恢复。
                           * 文案必须与之一致 —— 以前写「确定删除…（磁盘上的文件会保留）」，
                           * 没说记录去哪了，用户会以为记录真的没了，其实在回收站里等着恢复。
                           */
                          if (
                            !window.confirm(
                              `确定把记录「${a.file_name}」移到回收站？\n\n记录会从列表和检索里消失，磁盘上的原文件一个都不动，之后可以在「回收站」页恢复。`,
                            )
                          )
                            return;
                          try {
                            // 后端会把「移到哪、动了没动磁盘」写进 message，原样显示，不自己拼「已删除 XX」
                            const r = await api.del<DeleteArtifactResult>(`/api/artifacts/${a.id}`);
                            toast(r?.message ?? '已移到回收站，磁盘文件仍在原处，之后可以在回收站里恢复', 'ok');
                            reloadAll();
                          } catch (e) {
                            toast((e as { message: string }).message, 'err');
                          }
                        }}
                        title="把记录移到回收站（磁盘文件不动，之后可以恢复）"
                      >
                        移到回收站
                      </Button></details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {total!==undefined&&total>0&&<div className="library-pagination"><span>共 {total} 个文件 · 第 {page+1} 页</span>
          <Button size="sm" disabled={!page} onClick={()=>setPage(p=>p-1)}>上一页</Button>
          <Button size="sm" disabled={(page+1)*pageSize>=total} onClick={()=>setPage(p=>p+1)}>下一页</Button></div>}
      </Card>

      <Card title="数据目录" collapsible defaultOpen={false}>
        <div className="small muted">
          所有文件都在这里，是普通文件夹，可以直接用资源管理器打开、复制、同步备份。
          <div className="mono mt8">{stats.data?.dataRoot}</div>
          <div className="mt8">
            目录结构：<code>_模板库</code> 模板 · <code>_规范库</code> 制度参考 · <code>工作台</code> 各项目 ·{' '}
            <code>_待归档</code> 未归属文件
          </div>
        </div>
      </Card>

      {detailId !== null && <FileDetailModal id={detailId} onClose={() => setDetailId(null)} onChanged={reloadAll} />}
      {previewId !== null && <FilePreview key={previewId} id={previewId} onClose={closePreview} />}
      {versionId!==null&&<DocVersionsModal id={versionId} onClose={()=>setVersionId(null)} onChanged={reloadAll}/>}
      <Modal open={uploadOpen} title="上传业务文件" onClose={closeUpload} footer={<><Button disabled={uploadBusy} onClick={closeUpload}>取消</Button><Button kind="primary" disabled={uploadBusy||!uploadFile||!workbenchId} onClick={()=>void saveUpload().catch(()=>{})}>{uploadBusy?'上传中…':'上传文件'}</Button></>}>
        <Field label="所属工作"><WorkbenchSelect collection={workbenches} value={workbenchId} onChange={setWorkbenchId} placeholder="请选择工作" disabled={uploadBusy}/></Field><Field label="类别"><Select disabled={uploadBusy} value={uploadKind} onChange={setUploadKind} options={[{value:'source',label:'原始资料'},{value:'other',label:'附件 / 其他'}]}/></Field><Field label="文件"><input type="file" disabled={uploadBusy} onChange={e=>setUploadFile(e.target.files?.[0]??null)}/></Field>{uploadError&&<p role="alert" className="notice notice-err">{uploadError}。所选文件保留，请核对文件库后重试。</p>}
      </Modal>
    </div>
  );
}

/* ------------------------------ 文件详情 ------------------------------ */

interface FileDetailData {
  artifact: Artifact & { extracted_text: string | null; ocr_text: string | null; doc_date: string | null; file_rel: string };
  abs_path: string;
  exists: boolean;
  ocr: { status: string; chars: number; error: string | null };
  can_ocr: boolean;
}

function FileDetailModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const d = useApi<FileDetailData>(`/api/artifacts/${id}`);
  const [note, setNote] = useState<string | null>(null);

  // 识别中时自动刷新
  useEffect(() => {
    const s = d.data?.ocr.status;
    if (s !== 'pending' && s !== 'running') return;
    const t = setTimeout(() => d.reload(), 1800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.data]);

  const a = d.data?.artifact;
  const editor = useModalSave(note !== null && note !== a?.title, async () => {
    if (!a || !note?.trim()) throw Error('请填写文件标题');
    await api.put(`/api/artifacts/${a.id}`, {title: note.trim()});
    setNote(null);
    toast('已保存', 'ok');
    d.reload();
    onChanged();
  }, onClose);
  const text = a?.ocr_text || a?.extracted_text || '';
  const isImg = a ? /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(a.file_name) : false;

  const ocrTag = (s?: string) => {
    if (s === 'done') return <Tag kind="ok">已识别</Tag>;
    if (s === 'running') return <Tag kind="info">识别中…</Tag>;
    if (s === 'pending') return <Tag kind="warn">排队中</Tag>;
    if (s === 'failed') return <Tag kind="err">识别失败</Tag>;
    if (s === 'skipped') return <Tag>未识别</Tag>;
    return <Tag>不适用</Tag>;
  };

  return (
    <Modal
      open
      wide
      title={a?.title || a?.file_name || '文件详情'}
      onClose={editor.close}
      busy={editor.busy}
      footer={
        <>
          <Button disabled={editor.busy} onClick={editor.close}>关闭</Button>
          {a && (
            <Button kind="primary" onClick={() => api.download(`/api/artifacts/${a.id}/file`, a.file_name)}>
              下载文件
            </Button>
          )}
        </>
      }
    >
      {d.loading ? (
        <Loading />
      ) : !a ? (
        <div className="notice notice-err">加载失败</div>
      ) : (
        <>
          <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
            {isImg && <img src={`/api/artifacts/${a.id}/file`} style={{ width: 180, borderRadius: 8, border: '1px solid var(--line)' }} />}
            <dl className="kv" style={{ flex: 1 }}>
              <dt>文件名</dt>
              <dd className="mono small">{a.file_name}</dd>
              <dt>位置</dt>
              <dd className="mono small">{a.file_rel}</dd>
              <dt>大小</dt>
              <dd>{fmtSize(a.size_bytes)}</dd>
              <dt>归档时间</dt>
              <dd>{fmtTime(a.created_at)}</dd>
              {a.captured_at && (
                <>
                  <dt>拍摄时间</dt>
                  <dd>{fmtTime(a.captured_at)}（来自照片 EXIF）</dd>
                </>
              )}
              <dt>OCR</dt>
              <dd>
                {ocrTag(d.data?.ocr.status)}
                {d.data?.ocr.error && <span className="small muted"> {d.data.ocr.error}</span>}
              </dd>
            </dl>
          </div>

          {!d.data?.exists && <div className="notice notice-err mt12">磁盘上找不到这个文件了（可能被手工移动或删除）。</div>}

          <div className="row mt16" style={{ gap: 8 }}>
            <strong>识别 / 抽取到的文字</strong>
            <span className="small muted">共 {text.length} 字，检索时用的就是这段内容</span>
            <div className="spacer" />
            {d.data?.can_ocr && (
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    // 接口如实回报"这次到底排上队没有"（routes-files.ts / requeueOcr）：
                    // 已经在跑或已经在队列里时不重复排，`queued:false` 就不能再说"已重新排队"。
                    const r = await api.post<{ queued: boolean; status: string; previous_attempts: number }>(
                      `/api/ocr/artifacts/${a.id}`,
                    );
                    if (r.queued) toast('已重新排队识别', 'ok');
                    else if (r.status === 'running') toast('该文件正在识别中，无需重复提交', 'info');
                    else toast('该文件已在识别队列里，无需重复提交', 'info');
                    d.reload();
                  } catch (e) {
                    toast((e as { message: string }).message, 'err');
                  }
                }}
              >
                {d.data.ocr.status === 'done' ? '重新识别' : '开始识别'}
              </Button>
            )}
          </div>
          {text ? (
            <Textarea value={text} onChange={() => undefined} rows={10} disabled />
          ) : (
            <div className="notice mt8 small">
              这个文件没有可检索的文字。
              {isImg ? '点上面的「开始识别」让 OCR 认一下。' : '如果是扫描版 PDF，请导出成图片后再上传。'}
            </div>
          )}

          <Field label="备注 / 标题" hint="改完点保存，会同步更新检索索引">
            <Input value={note ?? a.title} onChange={setNote} />
          </Field>
          <Button
            size="sm"
            disabled={editor.busy || note === null || !note.trim() || note === a.title}
            onClick={editor.save}
          >
            保存
          </Button>

          <div className="notice mt16 small">
            磁盘上的完整路径：<code>{d.data?.abs_path}</code>
          </div>
        </>
      )}
    </Modal>
  );
}

function isImg(a: Artifact): boolean {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.file_name);
}
