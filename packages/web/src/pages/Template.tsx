import { TemplateHistory } from '../components/BusinessEvidence';
import { useRef, useState } from 'react';
import type React from 'react';
import { api, useApi, type Template, type TemplateVarSpec, type WorkType } from '../api';
import { Button, Card, Empty, Field, Input, Loading, Modal, Select, Tag, fmtTime, useAction, useToast } from '../ui';
import { TemplatePreview } from '../components/TemplatePreview';

const CATEGORY_TEXT: Record<string, string> = { general: '通用', admin: '行政管理', project: '项目实施', safety:'行政管理 · 安全生产',integrity:'行政管理 · 清廉工程',department:'行政管理 · 部门综合' };
const CATEGORY_OPTIONS=Object.entries(CATEGORY_TEXT).map(([value,label])=>({value,label}));

/**
 * 模板健康状态（服务端 template 表的三列，迁移 014）。
 * `api.ts` 里的 `Template` 类型还没同步这三个字段，这里就地补上，避免为了显示一个标签去改公共类型。
 *   health_ok = null 未校验 / 1 好 / 0 坏（打不开或 XML 不合法，出文书会被服务端拦下）
 */
type TemplateHealthFields = {
  health_ok?: number | null;
  health_note?: string | null;
  health_checked_at?: string | null;
};
type TemplateRow = Template & TemplateHealthFields;

/** 坏模板的统一说明。 */
function brokenNote(t: TemplateRow): string {
  const note = (t.health_note ?? '').trim() || '文件结构已损坏，Word/Excel 打不开';
  const when = t.health_checked_at ? `（校验于 ${fmtTime(t.health_checked_at)}）` : '';
  return `${note}${when}`;
}

/**
 * 模板库面板（嵌在知识库页里，不再单独占一个导航项）。
 *
 * 模板属于「知识」的一部分 —— 和制度、规范、历史资料一样，都是开展工作的依据。
 * 分成两个入口反而让人不知道该去哪找。
 */
export function TemplatePanel() {
  const toast = useToast();
  const types = useApi<{ items: WorkType[] }>('/api/work-types');
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [archived,setArchived]=useState(false);
  const list = useApi<{ items: Template[] }>(
    `/api/templates?archived=${archived}`,
  );
  const [uploadOpen, setUploadOpen] = useState(false);
  const [reuploading, setReuploading] = useState<Template | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const { busy: deletingBusy, run: runDelete } = useAction();
  const [editing, setEditing] = useState<Template | null>(null);
  const [previewing, setPreviewing] = useState<{ id: number; name: string } | null>(null);
  /**
   * 扫描结果。`raw` 是 /scan-preview 给的原始命中（带 `{#循环 …}` / `{@图片 …}` 标记原文），
   * 变量清单接口只给名字，光看名字分不出「集合名」和普通变量，所以这里两个接口一起拿。
   */
  const [scanning, setScanning] = useState<{
    id: number;
    name: string;
    preview: string;
    variables: { name: string }[];
    warnings: string[];
    raw: { name: string; raw: string }[];
  } | null>(null);
  /** 「检查模板是否可用」的 loading，复用本文件既有的 useAction */
  const { busy: checking, run: runHealthCheck } = useAction();
  const allRows = (list.data?.items ?? []) as TemplateRow[];
  const folderOptions = [...new Set(allRows.flatMap(t => {
    const parts=t.category.split('/');
    return parts.map((_,i)=>parts.slice(0,i+1).join('/'));
  }))].sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
  const rows = allRows.filter(t => (!category || t.category===category || t.category.startsWith(category+'/')) &&
    (!keyword || [t.name,t.code,t.description,t.category].some(s=>s?.toLowerCase().includes(keyword.toLowerCase()))));

  return (
    <div className="col" style={{ gap: 14 }}>
      <details className="template-guide card">
      <summary>模板使用说明 · 变量、循环与图片</summary>
      <div className="card-body">
      <div className="notice notice-info">
        <strong>模板怎么写？</strong> 打开你的 Word / Excel 模板，把每次会变的内容改写成 <code>{'{变量名}'}</code>，
        例如把「2026年3月」写成 <code>{'{检查月份}'}</code>、把单位名写成 <code>{'{单位名称}'}</code>。
        上传后系统会自动把变量扫出来；生成时大模型只填这些变量，系统会保留变量之外的文字样式；长文本可能改变分页，生成后请检查排版。
        也可以直接上传原始 Word / Excel，在「预览与核对 → 智能识别填写位置」中识别日期、字段空位和通用占位符，确认后转换为具体变量。
      </div>

      {/* 循环与图片是 docx 模板的两条「高级写法」，光靠上面那段说不清楚，这里给完整语法 + 一个表格行的例子 */}
      <div className="notice notice-info">
        <strong>行数不定的表格（循环）</strong>
        <div className="mt8">
          <code>{'{#循环 集合名}'}</code> … <code>{'{/循环}'}</code> 之间的内容会按集合里的条目重复。集合是一个数组，
          每个元素是一行；循环体里用 <code>{'{字段名}'}</code> 取「当前这一项」的字段，
          用 <code>{'{@序号}'}</code>（等价写法 <code>{'{_行号}'}</code>）取 1 起的行号。
          <strong>集合为空 → 整段/整行会被删掉</strong>，不会留空行。
        </div>
        <div className="mt8">
          最常见的是<strong>写在表格里的一行</strong>（首尾两个单元格放标记）：
        </div>
        <table className="table mt8" style={{ maxWidth: 640 }}>
          <thead>
            <tr>
              <th>序号</th>
              <th>名称</th>
              <th>单位</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono small">{'{#循环 材料清单}'}{'{序号}'}</td>
              <td className="mono small">{'{名称}'}</td>
              <td className="mono small">{'{单位}'}</td>
              <td className="mono small">{'{数量}'}{'{/循环}'}</td>
            </tr>
          </tbody>
        </table>
        <div className="small muted mt8">
          这样一行会按「材料清单」的条目数复制成 N 行；集合的取值在生成界面里按数组填
          （例如 <code>{'[{"序号":1,"名称":"水泥","单位":"吨","数量":10}]'}</code>），AI 生成时也会按数组给出。
        </div>
      </div>

      <div className="notice notice-info">
        <strong>插入现场照片（图片）</strong>
        <div className="mt8">
          <code>{'{@图片 图片名}'}</code>：按名称（照片标题或文件名，如 <code>门口全景</code>）、
          按序号（<code>{'{@图片 2}'}</code> = 本工作台/本阶段的第 2 张）从<strong>影像证据</strong>里取图插入。
          图片占位<strong>独占一个段落或单元格</strong>时，图片就插在原位置；单独写 <code>{'{@图片}'}</code> 表示「照片」。
        </div>
        <div className="mt8">
          两者可以一起用：<code>{'{#循环 现场照片}'}</code> <code>{'{@图片 照片}'}</code> <code>{'{/循环}'}</code>
          会一行一张地把该工作台的照片排进正文（<code>{'{#循环 现场照片}'}</code> 不用手填数据，直接取影像证据）。
        </div>
        <div className="small muted mt8">
          找不到的图片不会静默丢掉：正文里保留 <code>{'{@图片 名字}'}</code> 原样，并在生成结果的「没填」提示里列出「未能插入的图片」。
        </div>
      </div>

      </div></details>
      <Card
        title={`模板库（${rows.length}）`}
        extra={
          <>
            <Button onClick={()=>setArchived(v=>!v)}>{archived?'返回在用模板':'查看归档'}</Button>
            <Input value={keyword} onChange={setKeyword} placeholder="搜模板名" />
            <Select
              value={category}
              onChange={setCategory}
              placeholder="全部目录"
              options={folderOptions.map(value=>({value,label:CATEGORY_TEXT[value] ?? value.replaceAll('/',' / ')}))}
            />
            <Button
              disabled={checking}
              onClick={() =>
                runHealthCheck(async () => {
                  const r = await api.post<{ checked: number; bad: number }>('/api/templates/health-check');
                  list.reload();
                  toast(`检查了 ${r.checked} 个模板，发现 ${r.bad} 个有问题`, r.bad ? 'err' : 'ok');
                })
              }
            >
              {checking ? '检查中…' : '检查模板是否可用'}
            </Button>
            <Button kind="primary" onClick={() => setUploadOpen(true)}>
              ＋ 上传模板
            </Button>
          </>
        }
      >
        {list.loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            text={allRows.length ? '当前目录或关键词下没有匹配的模板。' : '还没有模板。先把你最常用的那份 Word 模板改好变量传上来。'}
            action={
              <Button kind="primary" onClick={() => setUploadOpen(true)}>
                上传第一个模板
              </Button>
            }
          />
        ) : (
          <table className="table template-table">
            <thead>
              <tr>
                <th>模板名</th>
                <th>类别</th>
                <th>变量</th>
                <th>格式</th>
                <th>更新时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                /** 只有明确校验为坏（0）才标红；null=还没校验过，不吓唬用户 */
                const broken = t.health_ok === 0;
                return (
                <tr key={t.id}>
                  <td>
                    <div className="row" style={{ gap: 9 }}>
                      <span className={`file-ico ${t.file_format?.includes('xls') ? 'xls' : 'doc'}`}>{t.file_format?.toUpperCase()}</span>
                      <div className="check-main">
                        <div className="check-title">
                          {t.name}
                          {broken && (
                            <span title={brokenNote(t)} style={{ marginLeft: 6 }}>
                              <Tag kind="err">模板损坏</Tag>
                            </span>
                          )}
                        </div>
                        {t.description && <div className="check-detail ellipsis">{t.description}</div>}
                        {broken && (
                          <div className="check-detail" style={{ color: 'var(--err)' }} title={brokenNote(t)}>
                            打不开：{t.health_note ?? '文件结构已损坏'}　→ 请在 Word/Excel 里打开原件、「另存为」后点本行的「重新上传」替换文件。
                          </div>
                        )}
                        {t.file_exists === false && <div className="check-detail" style={{ color: 'var(--err)' }}>模板文件丢失</div>}
                      </div>
                    </div>
                  </td>
                  <td className="small">{CATEGORY_TEXT[t.category] ?? t.category.replaceAll('/',' / ')}</td>
                  <td className="small nowrap">{t.variable_count > 0 ? <Tag kind="info">{t.variable_count} 个</Tag> : <Tag kind="warn">未扫描</Tag>}</td>
                  <td className="small nowrap">{t.renderable === false ? <Tag kind="err">不可填充</Tag> : <Tag kind="ok">可填充</Tag>}</td>
                  <td className="small muted nowrap">{fmtTime(t.updated_at ?? undefined)}</td>
                  <td className="nowrap">
                    {archived && <Button size="sm" onClick={async()=>{try{await api.post(`/api/templates/${t.id}/unarchive`);list.reload();toast('已恢复','ok');}catch(e){toast((e as {message:string}).message,'err');}}}>恢复</Button>}
                      <Button size="sm" onClick={() => setReuploading(t)}>
                        重新上传
                      </Button>
                    <Button size="sm" onClick={() => setEditing(t)}>
                      设置
                    </Button>
                    <Button
                      size="sm"
                      onClick={async () => {
                        try {
                          const [r, s] = await Promise.all([
                            api.post<{ preview: string; variables: { name: string }[]; warnings: string[] }>(`/api/templates/${t.id}/scan`),
                            /** 结构扫描：拿到「哪些是循环集合、哪些是图片」，好在这个弹窗里分开列 */
                            api.get<{ variables: { name: string; raw: string }[] }>(`/api/templates/${t.id}/scan-preview`),
                          ]);
                          setScanning({ id: t.id, name: t.name, preview: r.preview, variables: r.variables, warnings: r.warnings, raw: s.variables ?? [] });
                          list.reload();
                        } catch (e) {
                          toast((e as { message: string }).message, 'err');
                        }
                      }}
                    >
                      扫描变量
                    </Button>
                    <Button size="sm" onClick={() => setPreviewing(t)}>预览与核对</Button>
                    <Button size="sm" kind="ghost" onClick={() => api.download(`/api/templates/${t.id}/file`, `${t.name}.${t.file_format}`)}>
                      下载
                    </Button>
                    <Button size="sm" kind="danger" onClick={() => setDeleting(t)}>
                      {archived ? '彻底删除' : '删除'}
                    </Button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {previewing && <TemplatePreview key={previewing.id} template={previewing} onClose={() => setPreviewing(null)} onRescanned={list.reload} />}

      {deleting && (
        <Modal open title={archived ? '彻底删除模板' : '删除模板'}
          onClose={() => { if (!deletingBusy) setDeleting(null); }}
          footer={<>
            <Button disabled={deletingBusy} onClick={() => setDeleting(null)}>取消</Button>
            <Button kind="danger" disabled={deletingBusy} onClick={() => runDelete(async () => {
              await api.del(`/api/templates/${deleting.id}${archived ? '/permanent' : ''}`);
              setDeleting(null);
              list.reload();
              toast(archived ? '模板已彻底删除' : '模板已删除，可在「查看归档」中恢复', 'ok');
            })}>{deletingBusy ? '删除中…' : '确认删除'}</Button>
          </>}>
          <p>确认{archived ? '彻底删除' : '删除'}「{deleting.name}」？</p>
          <div className="notice notice-warn">{archived
            ? '将删除模板记录和当前文件，无法恢复。已生成过文件的模板会保留以供追溯，系统将阻止彻底删除。'
            : '删除后模板将移入归档，不再用于新文件生成；已有文件不受影响，可在「查看归档」中恢复。'}</div>
        </Modal>
      )}

      {reuploading && (
        <UploadTemplateModal
          template={reuploading}
          types={types.data?.items ?? []}
          onClose={() => setReuploading(null)}
          onDone={(items) => {
            setReuploading(null);
            list.reload();
            toast(`已替换模板，扫描到 ${items[0]?.template?.variable_count ?? 0} 个变量` +
              (items[0]?.warnings?.length ? `；${items[0].warnings[0]}` : ''), 'ok');
          }}
        />
      )}

      {uploadOpen && (
        <UploadTemplateModal
          types={types.data?.items ?? []}
          onClose={() => setUploadOpen(false)}
          onDone={(items) => {
            setUploadOpen(false);
            list.reload();
            const first = items[0];
            if (first?.template?.id) setPreviewing({ id: first.template.id, name: first.template.name ?? '新上传模板' });
            toast(
              first
                ? `已上传 ${items.length} 个模板，扫描到 ${first.template?.variable_count ?? 0} 个变量` +
                    (first.warnings?.length ? `；${first.warnings[0]}` : '')
                : '已上传',
              'ok',
            );
          }}
        />
      )}

      {editing && (
        <TemplateSettingsModal
          template={editing}
          types={types.data?.items ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
            toast('已保存', 'ok');
          }}
        />
      )}

      {scanning && (
        <Modal open wide title={`变量扫描结果：${scanning.name}`} onClose={() => setScanning(null)} footer={
          <Button kind="primary" onClick={() => { setPreviewing({ id: scanning.id, name: scanning.name }); setScanning(null); }}>预览并试填核对</Button>
        }>
          {scanning.variables.length === 0 ? (
            <div className="notice notice-warn">
              没有扫描到 <code>{'{变量}'}</code>。
              {scanning.warnings.map((w, i) => (
                <div key={i} className="mt8">
                  {w}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="mb12">
                共扫描到 <strong>{scanning.variables.length}</strong> 个变量：
                {scanning.variables.map((v) => (
                  <Tag key={v.name} kind="info">
                    {v.name}
                  </Tag>
                ))}
              </div>
              <LoopImageSummary raw={scanning.raw} />
              <div className="small muted">模板正文预览（用于核对变量位置）：</div>
              <div className="preview-pane mt8">
                {highlight(scanning.preview)}
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function highlight(text: string) {
  const parts: (string | React.ReactElement)[] = [];
  let last = 0;
  const re = /\{[^{}\n\t]{1,60}\}/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={i++} className="hl">
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** 原始命中（raw 是标记原文）→ 循环集合与图片名。变量清单只给名字，靠 raw 才分得出来 */
function splitLoopImage(raw: { name: string; raw: string }[]): {
  loops: { name: string; raw: string }[];
  images: { name: string; raw: string }[];
  plain: { name: string; raw: string }[];
} {
  const loops: { name: string; raw: string }[] = [];
  const images: { name: string; raw: string }[] = [];
  const plain: { name: string; raw: string }[] = [];
  for (const v of raw) {
    if (v.raw.startsWith('{#')) loops.push(v);
    else if (v.raw.startsWith('{@')) images.push(v);
    else plain.push(v);
  }
  return { loops, images, plain };
}

/**
 * 「这个模板里的循环与图片变量」。
 *
 * 这两类写法在变量清单里和普通变量长得一样（都只是个名字），
 * 但对填写的人意义完全不同：集合要给数组、图片由影像证据自动插入。
 */
function LoopImageSummary({ raw }: { raw: { name: string; raw: string }[] }) {
  const { loops, images } = splitLoopImage(raw);
  if (!loops.length && !images.length) {
    return (
      <div className="small muted mb12">
        这个模板里没有循环（<code>{'{#循环 集合名}'}</code>）或图片（<code>{'{@图片 名字}'}</code>）写法。
      </div>
    );
  }
  return (
    <div className="mb12">
      {loops.length > 0 && (
        <div className="mb8">
          <strong>循环集合（{loops.length}）</strong>
          <span className="small muted">　按行重复的表格/段落，值填数组；空数组 → 整段/整行删掉</span>
          <div className="mt8">
            {loops.map((v) => (
              <Tag key={v.name} kind="warn">
                {v.name}（{v.raw}）
              </Tag>
            ))}
          </div>
        </div>
      )}
      {images.length > 0 && (
        <div>
          <strong>图片（{images.length}）</strong>
          <span className="small muted">　按名称/序号取自本工作台或本阶段的影像证据，不用手填</span>
          <div className="mt8">
            {images.map((v) => (
              <Tag key={v.name} kind="ok">
                {v.name}（{v.raw}）
              </Tag>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UploadTemplateModal({
  template,
  types,
  onClose,
  onDone,
}: {
  template?: Template;
  types: WorkType[];
  onClose: () => void;
  onDone: (items: { template?: { id?: number; name?: string; variable_count?: number }; warnings?: string[] }[]) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [category, setCategory] = useState('general');
  const [workTypeId, setWorkTypeId] = useState('');
  const [description, setDescription] = useState('');
  const [over, setOver] = useState(false);
  const { busy, run } = useAction();
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <Modal
      open
      title={template ? `重新上传：${template.name}` : '上传模板'}
      onClose={() => { if (!busy) onClose(); }}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>取消</Button>
          <Button
            kind="primary"
            disabled={busy || !files.length || Boolean(template && files.length !== 1)}
            onClick={() =>
              run(async () => {
                const form = new FormData();
                files.forEach((f) => form.append('file', f, f.name));
                if (template) {
                  const r = await api.upload<{ template: { variable_count?: number }; warnings?: string[] }>(`/api/templates/${template.id}/reupload`, form);
                  onDone([r]);
                  return;
                }
                form.append('category', category);
                if (workTypeId) form.append('workTypeId', workTypeId);
                if (description) form.append('description', description);
                const r = await api.upload<{ items: { template?: { id?: number; name?: string; variable_count?: number }; warnings?: string[] }[] }>('/api/templates/upload', form);
                onDone(r.items);
              })
            }
          >
            {busy ? '上传并扫描中…' : template ? '确认替换' : '上传'}
          </Button>
        </>
      }
    >
      {template && <div className="notice notice-info mb12">选择一个新文件替换此模板，保留模板名称、类别、工作类型和已有绑定，并重新扫描变量。同名变量保留填写说明；旧文件保留在本地备份。替换不会改变归档状态。</div>}
      <div
        className={`drop${over ? ' over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          setFiles(Array.from(e.dataTransfer.files));
        }}
      >
        把 Word / Excel 模板拖进来，或点击选择
        <div className="small mt8">支持 .docx .xlsx（.doc/.xls 请先另存为新格式）</div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple={!template}
        accept=".docx,.xlsx,.xlsm"
        style={{ display: 'none' }}
        onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
      />
      {files.length > 0 && (
        <div className="mt12 col" style={{ gap: 4 }}>
          {files.map((f, i) => (
            <div key={i} className="row small">
              <span className="ellipsis" style={{ flex: 1 }}>
                {f.name}
              </span>
              <button className="icon-btn" onClick={() => setFiles((p) => p.filter((_, idx) => idx !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {!template && <div className="inline-fields mt12">
        <Field label="类别">
          <Select
            value={category}
            onChange={setCategory}
            options={[
              ...CATEGORY_OPTIONS,
            ]}
          />
        </Field>
        <Field label="绑定工作类型" hint="生成时可按类型筛选">
          <Select value={workTypeId} onChange={setWorkTypeId} placeholder="不绑定" options={types.map((t) => ({ value: String(t.id), label: t.name }))} />
        </Field>
      </div>}
      {!template && <Field label="说明">
        <Input value={description} onChange={setDescription} placeholder="这个模板用在什么场合" />
      </Field>}
    </Modal>
  );
}

function TemplateSettingsModal({
  template,
  types,
  onClose,
  onSaved,
}: {
  template: Template;
  types: WorkType[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const detail = useApi<{ template: Template; vars: { variables: TemplateVarSpec[] } }>(`/api/templates/${template.id}`);
  /** 结构扫描：变量清单只给名字，看不出哪些是循环集合、哪些是图片 —— 这里单独拿一次原始命中 */
  const preview = useApi<{ variables: { name: string; raw: string }[] }>(`/api/templates/${template.id}/scan-preview`);
  const [meta, setMeta] = useState({
    name: template.name,
    category: template.category,
    workTypeId: template.work_type_id ? String(template.work_type_id) : '',
    positionCode: template.position_code ?? '',
    description: template.description ?? '',
    usageNote: '',
  });
  const [vars, setVars] = useState<TemplateVarSpec[] | null>(null);
  const { busy, run } = useAction();

  const list = vars ?? detail.data?.vars.variables ?? [];

  return (
    <Modal
      open
      wide
      title={`模板设置：${template.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button
            kind="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.put(`/api/templates/${template.id}`, {
                  ...meta,
                  workTypeId: meta.workTypeId ? Number(meta.workTypeId) : null,
                  positionCode: meta.positionCode || null,
                });
                if (list.length) {
                  await api.put(`/api/templates/${template.id}/vars`, { variables: list });
                }
                onSaved();
              })
            }
          >
            保存
          </Button>
        </>
      }
    >
      <div className="inline-fields">
        <Field label="模板名称">
          <Input value={meta.name} onChange={(v) => setMeta({ ...meta, name: v })} />
        </Field>
        <Field label="类别">
          <Select
            value={meta.category}
            onChange={(v) => setMeta({ ...meta, category: v })}
            options={[
              ...(!CATEGORY_TEXT[meta.category] ? [{value:meta.category,label:meta.category.replaceAll('/',' / ')}] : []),
              ...CATEGORY_OPTIONS,
            ]}
          />
        </Field>
        <Field label="工作类型">
          <Select
            value={meta.workTypeId}
            onChange={(v) => setMeta({ ...meta, workTypeId: v })}
            placeholder="不绑定"
            options={types.map((t) => ({ value: String(t.id), label: t.name }))}
          />
        </Field>
      </div>
      <Field label="说明">
        <Input value={meta.description} onChange={(v) => setMeta({ ...meta, description: v })} />
      </Field>

      <div className="row mb8 mt16">
        <strong>变量清单（{list.length}）</strong>
        <span className="small muted">给每个变量补一个中文标签和填写提示，模型和大模型都会用到</span>
        <div className="spacer" />
        <Button
          size="sm"
          onClick={() =>
            run(async () => {
              await api.post(`/api/templates/${template.id}/scan`);
              detail.reload();
              preview.reload();
              setVars(null);
              toast('已重新扫描', 'ok');
            })
          }
        >
          重新扫描
        </Button>
      </div>

      {/* 「这个模板里的循环与图片」——填写的人只看变量名是分不出来的 */}
      <TemplateHistory id={template.id}/>
      <Card title="循环与图片" collapsible>
        {preview.loading ? (
          <Loading />
        ) : (
          <>
            <LoopImageSummary raw={preview.data?.variables ?? []} />
            <div className="small muted">
              用法：<code>{'{#循环 集合名}'}</code> … <code>{'{/循环}'}</code> 重复一段/一行（集合为空则整段删掉），
              循环体内 <code>{'{字段名}'}</code> 取当前项、<code>{'{@序号}'}</code> 取 1 起的行号；
              <code>{'{@图片 图片名}'}</code> 按名称或序号从影像证据插入图片（找不到会保留占位符并提示）。
            </div>
          </>
        )}
      </Card>

      {detail.loading ? (
        <Loading />
      ) : list.length === 0 ? (
        <div className="notice notice-warn">
          这个模板里没有扫描到变量。请打开模板，把要变的内容改成 <code>{'{变量名}'}</code> 后重新上传。
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 160 }}>变量名</th>
              <th style={{ width: 150 }}>界面标签</th>
              <th style={{ width: 110 }}>类型</th>
              <th style={{ width: 80 }}>必填</th>
              <th>填写提示 / 示例</th>
            </tr>
          </thead>
          <tbody>
            {list.map((v, i) => (
              <tr key={v.name}>
                <td className="mono small">{v.name}</td>
                <td>
                  <Input
                    value={v.label ?? ''}
                    onChange={(val) => {
                      const next = [...list];
                      next[i] = { ...v, label: val };
                      setVars(next);
                    }}
                  />
                </td>
                <td>
                  <Select
                    value={v.type ?? 'text'}
                    onChange={(val) => {
                      const next = [...list];
                      next[i] = { ...v, type: val as TemplateVarSpec['type'] };
                      setVars(next);
                    }}
                    options={[
                      { value: 'text', label: '短文本' },
                      { value: 'longtext', label: '长文本' },
                      { value: 'date', label: '日期' },
                      { value: 'number', label: '数字' },
                      { value: 'select', label: '选项' },
                    ]}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    className="check-box"
                    checked={v.required !== false}
                    onChange={(e) => {
                      const next = [...list];
                      next[i] = { ...v, required: e.target.checked };
                      setVars(next);
                    }}
                  />
                </td>
                <td>
                  <Input
                    value={v.hint ?? v.example ?? ''}
                    onChange={(val) => {
                      const next = [...list];
                      next[i] = { ...v, hint: val };
                      setVars(next);
                    }}
                    placeholder="例如：填 2026年3月 这样的中文格式"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
