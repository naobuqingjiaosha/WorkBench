import {useWorkbenchCollection} from '../components/useWorkbenchCollection';
import {WorkbenchSelect} from '../components/WorkbenchSelect';
import {LoadError} from '../components/DesignSystem';
import {FilePreview} from '../components/FilePreview';
/** 模板是日常知识库入口；制度维护移至系统配置。
 * 制度资料只在当前请求明确启用时参与引用，不因页面可见性自动启用。
 */
import { useEffect, useRef, useState } from 'react';
import {
  api, coverageApi, useApi,
  type Artifact, type CoverageSuggestion, type CoverageSummary, type CoverageUnmappedResponse,
  type KbExtractConfig, type KbExtractJob, type KbExtractPreview, type KbExtractSettings, type KbSource, type WorkType,
} from '../api';
import {
  Bar, Button, Card, Empty, Input, Loading, Modal, Select, Tag, fmtSize, fmtTime,
  useAction, useDebounced, useToast,
} from '../ui';
import { TemplatePanel } from './Template';
import type {RouteKey} from '../App';

/* ============================== 类型 ============================== */

interface KbStatus {
  documents: number;
  chunks: number;
  embedded: number;
  pending: number;
  dims: number | null;
  models: string[];
  indexedArtifacts: number;
  totalCandidates: number;
  notIndexed: number;
  embedding: {
    configured: boolean;
    /** 不能用的具体原因（服务商停用 / 没填 Key / 没选模型），界面直接说出来 */
    reason?: string | null;
    code?: string | null;
    provider: string | null;
    model: string | null;
    dims: number | null;
  };
  batch: { running: boolean; total: number; done: number; failed: number; current: string; message: string; finishedAt: string | null };
  hint: string;
}

interface KbDoc {
  id: number;
  artifact_id: number | null;
  title: string;
  source_rel: string | null;
  chunk_count: number;
  embedded_count: number;
  created_at: string;
}

interface KbHit {
  documentId: number | null;
  artifactId: number | null;
  title: string;
  heading: string | null;
  seq: number;
  content: string;
  score: number;
}

/** 界面上真正渲染的一条命中：merged（融合排序）与 semantic 统一成这个形状 */
interface DisplayHit {
  key: string;
  title: string;
  heading?: string | null;
  seq?: number;
  score: number;
  text: string;
  documentId: number | null;
  /** 命中来源：关键词 / 语义 / 两者都命中（只有 merged 里才有） */
  source?: string;
}

/* ============================== 主组件 ============================== */

type PolicyTab = 'docs' | 'files' | 'ask' | 'evidence';

export default function KnowledgePage({params,go}:{params:Record<string,string>;go:(key:RouteKey,params?:Record<string,string>)=>void}) {
  const [section, setSection] = useState('template');
  const id = Number(params.templateId);
  const linkedTemplateId = Number.isSafeInteger(id) && id > 0 ? id : undefined;
  const activeSection = linkedTemplateId ? 'template' : section;
  return <div className="section-content knowledge-library">
    <div className="view-tabs" aria-label="知识库功能">{[['template','模板库'],['coverage','字段映射']].map(([key,label])=>
      <button key={key} type="button" className={activeSection===key?'selected':''} aria-pressed={activeSection===key} onClick={()=>setSection(key)}>{label}</button>)}</div>
    {activeSection === 'template' ? <TemplatePanel linkedTemplateId={linkedTemplateId}
      onCloseLinked={()=>{const rest={...params};delete rest.templateId;go('knowledge',rest);}}
    /> : <CoveragePanel />}
  </div>;
}

/** 保留原维护/查询能力，只在设置的折叠维护区由用户主动打开。 */
export function PolicyMaintenancePanel() {
  const [policyTab, setPolicyTab] = useState<PolicyTab>('docs');
  return <div className="section-content">
    <p className="muted">此处维护后台参考资料。日常知识库展示模板；助手和文书的制度参考仍需在本次请求中明确启用。</p>
    <div className="view-tabs" aria-label="参考资料维护方式">
      {([['docs','已入库文档'],['files','找文件'],['ask','检索提问'],['evidence','查依据']] as [PolicyTab,string][]).map(([key,label]) =>
        <button type="button" key={key} aria-pressed={policyTab===key} className={policyTab===key?'selected':''} onClick={()=>setPolicyTab(key)}>{label}</button>)}
    </div>
    {policyTab === 'docs' && <PolicyDocsPanel />}
    {policyTab === 'files' && <FileSearchPanel />}
    {policyTab === 'ask' && <AskPanel />}
    {policyTab === 'evidence' && <EvidencePanel />}
  </div>;
}

/* ============================== 模板变量覆盖率 ============================== */

/**
 * 自动化率的头号瓶颈就摆在这张卡片上：模板里约 1089 个变量，只有约 385 个有别名映射，
 * 其余每一次出文书都得人手填一遍、或者让模型现写一遍。
 *
 * 两个口径必须**一起**显示：加权（按出现次数）约 35%、去重（按变量名）约 15%，
 * 差一倍多 —— 因为少数几个变量（项目名称、甲乙方…）在几十份模板里反复出现。
 * 只报一个必然误导，所以两行进度条、两个大数字，并把口径写清楚。
 *
 * 「已映射」与出文书时的判定完全同源（server/src/core/coverage.ts 复用 resolveVariable）。
 * 未映射的变量可以在这里「采纳建议」：先拿建议（规则优先、模型可用时让它判一遍），
 * 看到置信度与理由后点「确认写入」才落库 —— AI 只提案，不自己改档案。
 */
function CoveragePanel() {
  const toast = useToast();
  const { busy, run } = useAction();
  const types = useApi<{ items: WorkType[] }>('/api/work-types');
  /** '' = 全局（所有工作类型一起看）；选了具体类型则整张卡片只看该类，写入也按该类落别名 */
  const [scope, setScope] = useState('');
  const [sort, setSort] = useState<'count' | 'name'>('count');
  const [limit, setLimit] = useState(20);
  const scopeId = scope ? Number(scope) : null;
  const scopeQs = scope ? `&workTypeId=${scope}` : '';

  const cov = useApi<CoverageSummary>(`/api/coverage?top=10${scopeQs}`);
  const un = useApi<CoverageUnmappedResponse>(`/api/coverage/unmapped?sort=${sort}&limit=${limit}${scopeQs}`);
  /** 变量名 → 建议：undefined 还没问 / 'loading' 正在问 / null 没猜出来 */
  const [sugg, setSugg] = useState<Record<string, CoverageSuggestion | 'loading' | null | undefined>>({});

  const s = cov.data;
  const items = un.data?.items ?? [];
  const kind = (p: number): 'ok' | 'info' | 'warn' | 'err' => (p >= 80 ? 'ok' : p >= 60 ? 'info' : p >= 40 ? 'warn' : 'err');
  const confKind = (c: CoverageSuggestion['confidence']): 'ok' | 'warn' | 'default' => (c === 'high' ? 'ok' : c === 'medium' ? 'warn' : 'default');
  const confText = (c: CoverageSuggestion['confidence']): string => (c === 'high' ? '高' : c === 'medium' ? '中' : '低');

  /** 「采纳建议」：向后端要建议（不落库）。模型没配或失败时后端自动降级为规则建议 */
  const ask = (name: string) =>
    run(async () => {
      setSugg((x) => ({ ...x, [name]: 'loading' }));
      const r = await coverageApi.suggest([name], { workTypeId: scopeId, limit: 1 });
      const first = r.suggestions[0] ?? null;
      setSugg((x) => ({ ...x, [name]: first }));
      if (!first) toast(`没为「${name}」猜出建议 —— 这类变量多半要先在「流程规范 → 项目信息」建字段`, 'info');
      else if (r.ai.error && first.source === 'rule') toast(`模型没参与（${r.ai.error}），这是规则建议`, 'info');
    });

  /** 「确认写入」：走既有的别名写入接口，把映射落到档案别名表 */
  const write = (name: string, sug: CoverageSuggestion) =>
    run(async () => {
      await coverageApi.saveAlias(name, sug.fieldKey, scopeId);
      setSugg((x) => ({ ...x, [name]: undefined }));
      cov.reload();
      un.reload();
      toast(`已把「${name}」映射到「${sug.label}」，之后出文书会自动带出`, 'ok');
    });

  const typeOptions = (types.data?.items ?? []).map((t) => ({ value: String(t.id), label: t.name }));

  return (
    <Card
      title="模板变量覆盖率"
      extra={
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Select value={scope} onChange={setScope} placeholder="范围：全局（所有工作类型）" options={typeOptions} />
          <Button
            size="sm"
            disabled={cov.loading || un.loading}
            onClick={() => {
              cov.reload();
              un.reload();
            }}
          >
            刷新
          </Button>
        </div>
      }
    >
      {cov.loading ? (
        <Loading />
      ) : !s ? (
        <Empty text={cov.error?.message ?? '读不到覆盖率数据'} />
      ) : (
        <>
          <div className="grid grid-4">
            <div>
              <div className="small muted">加权覆盖率（按变量出现次数）</div>
              <strong style={{ fontSize: 26 }}>{s.percent}%</strong>
              <div className="small muted">
                {s.mappedVars} / {s.totalVars} 处引用
              </div>
            </div>
            <div>
              <div className="small muted">去重覆盖率（按变量名）</div>
              <strong style={{ fontSize: 26 }}>{s.distinctPercent}%</strong>
              <div className="small muted">
                {s.distinctMappedVars} / {s.distinctTotalVars} 个不同变量名
              </div>
            </div>
            <div>
              <div className="small muted">模板</div>
              <strong style={{ fontSize: 26 }}>{s.templates}</strong>
              <div className="small muted">完全映射 {s.fullyMapped} 份</div>
            </div>
            <div>
              <div className="small muted">未映射变量名</div>
              <strong style={{ fontSize: 26 }}>{s.unmappedSummary.distinctUnmapped}</strong>
              <div className="small muted">共 {s.unmappedSummary.unmappedOccurrences} 处要人管</div>
            </div>
          </div>

          <div className="mt12">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small">加权口径：一个变量在 5 份模板里出现就算 5 次</span>
              <span className="small muted">{s.percent}%</span>
            </div>
            <Bar value={s.percent} />
          </div>
          <div className="mt4">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="small">去重口径：同一个变量名跨模板只算 1 个</span>
              <span className="small muted">{s.distinctPercent}%</span>
            </div>
            <Bar value={s.distinctPercent} />
          </div>

          <div className="notice notice-info mt12">
            <strong>覆盖率低意味着：这些 {'{变量}'} 每出一份文书都要手填，或者让模型现写一遍。</strong>
            「已映射」= 在项目信息填齐的前提下，能像出文书时那样解析出值
            （系统自动填的 <code>_今天</code> / <code>_年份</code> 也算）。
            <br />
            两个口径差别很大是因为少数变量（项目名称、甲乙方…）在几十份模板里反复出现：
            <strong>加权 {s.percent}%</strong> 说的是「多少处能自动带出」，
            <strong>去重 {s.distinctPercent}%</strong> 说的是「还有多少个不同的名字要补」。
            <br />
            <span className="muted small">
              这里是<strong>映射覆盖率</strong>（别名表有多全），不是「这个项目现在自动填了多少」——
              后者看具体工作台的「项目信息」填了几成。
              {s.mappedBreakdown.viaSystem > 0 && `　已映射的 ${s.mappedBreakdown.viaSystem} 处是系统自动填的（日期 / 年月）。`}
              {s.noise.withDigits.occurrences > 0 &&
                `　另有 ${s.noise.withDigits.distinct} 个名字带序号（如「设备1名称」）共 ${s.noise.withDigits.occurrences} 处，它们通常不是项目信息；剔除后加权 ${s.noise.percentWithoutDigits}%、去重 ${s.noise.distinctPercentWithoutDigits}%。`}
              {s.unmappedSummary.danglingDistinct > 0 &&
                `　其中 ${s.unmappedSummary.danglingDistinct} 个变量「配了别名却取不到值」（映射到了别的工作类型的字段或已回收的字段），标了提示。`}
              {s.skipped.unreadable.length > 0 &&
                `　另有 ${s.skipped.unreadable.length} 份模板的变量清单读不到（文件不在数据目录里），没有算进分母：${s.skipped.unreadable
                  .slice(0, 3)
                  .map((t) => t.name)
                  .join('、')}${s.skipped.unreadable.length > 3 ? ' 等' : ''}。`}
            </span>
          </div>

          {s.unmappedTop.length > 0 && (
            <div className="mt12">
              <div className="small muted mb8">
                最该补的前 {s.unmappedTop.length} 个（按出现次数降序 —— 补一条，省下的手工次数最多）：
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {s.unmappedTop.map((u) => (
                  <Tag key={u.name} kind={u.reason === 'dangling' ? 'err' : 'warn'}>
                    {u.name} × {u.count}
                  </Tag>
                ))}
              </div>
            </div>
          )}

          <table className="table mt16">
            <thead>
              <tr>
                <th>工作类型</th>
                <th style={{ width: 70 }}>模板</th>
                <th style={{ width: 130 }}>变量数（加权）</th>
                <th style={{ width: 110 }}>已映射</th>
                <th style={{ width: 110 }}>加权覆盖率</th>
                <th style={{ width: 110 }}>去重覆盖率</th>
              </tr>
            </thead>
            <tbody>
              {s.byWorkType.map((w) => (
                <tr key={String(w.workTypeId)}>
                  <td>
                    <a
                      className="clickable"
                      title="只看这一类"
                      onClick={() => setScope(w.workTypeId === null ? '' : String(w.workTypeId))}
                    >
                      {w.name}
                    </a>
                  </td>
                  <td className="small">{w.templates}</td>
                  <td className="small">
                    {w.totalVars}
                    <span className="muted">（{w.distinctTotalVars} 个名字）</span>
                  </td>
                  <td className="small">{w.mappedVars}</td>
                  <td>
                    <Tag kind={kind(w.percent)}>{w.percent}%</Tag>
                  </td>
                  <td>
                    <Tag kind={kind(w.distinctPercent)}>{w.distinctPercent}%</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {s.worst.length > 0 && (
            <div className="mt16">
              <div className="small muted mb8">最缺映射的模板（先补这些最省事）：</div>
              <table className="table">
                <thead>
                  <tr>
                    <th>模板</th>
                    <th style={{ width: 110 }}>工作类型</th>
                    <th style={{ width: 110 }}>已映射 / 变量</th>
                    <th style={{ width: 90 }}>覆盖率</th>
                  </tr>
                </thead>
                <tbody>
                  {s.worst.slice(0, 10).map((r) => (
                    <tr key={r.templateId}>
                      <td>{r.templateName}</td>
                      <td className="small muted">{r.workTypeName}</td>
                      <td className="small">
                        {r.mappedVars} / {r.totalVars}
                      </td>
                      <td>
                        <Tag kind={kind(r.totalVars ? Math.round((r.mappedVars / r.totalVars) * 100) : 0)}>
                          {r.totalVars ? Math.round((r.mappedVars / r.totalVars) * 100) : 0}%
                        </Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt16">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>
                  未映射变量（{un.data?.total ?? 0} 个名字 / {un.data?.occurrences ?? 0} 处）
                </strong>
                <span className="muted small">
                  　点「采纳建议」看建议，确认后才会写进别名表
                  {scope ? `（写入范围：${typeOptions.find((o) => o.value === scope)?.label ?? scope}）` : '（写入范围：全局，只会建议通用字段）'}
                </span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Select
                  value={sort}
                  onChange={(v) => setSort(v === 'name' ? 'name' : 'count')}
                  options={[
                    { value: 'count', label: '按出现次数' },
                    { value: 'name', label: '按变量名' },
                  ]}
                />
                {limit < 200 && (un.data?.total ?? 0) > items.length && !un.loading && !un.error && (
                  <Button size="sm" onClick={() => setLimit(limit === 20 ? 50 : 200)}>
                    显示更多（{limit === 20 ? 50 : 200}）
                  </Button>
                )}
              </div>
            </div>

            {un.loading ? (
              <Loading />
            ) : items.length === 0 ? (
              <Empty text="这一类工作已经没有未映射变量了 —— 模板里所有 {变量} 都能自动带出。" />
            ) : (
              <table className="table mt12">
                <thead>
                  <tr>
                    <th>变量名 / 建议</th>
                    <th style={{ width: 90 }}>出现次数</th>
                    <th style={{ width: 240 }}>所在模板</th>
                    <th style={{ width: 190 }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((u) => {
                    const sg = sugg[u.name];
                    return (
                      <tr key={u.name}>
                        <td>
                          <strong className="mono">{u.name}</strong>
                          {u.reason === 'dangling' && (
                            <Tag kind="err">有映射但取不到值：{u.danglingFieldKeys.join('、')}</Tag>
                          )}
                          {sg === 'loading' && <div className="muted small">正在要建议…</div>}
                          {sg && sg !== 'loading' && (
                            <div className="small" style={{ marginTop: 4 }}>
                              建议映射到 <strong>{sg.label}</strong>{' '}
                              <span className="mono muted small">{sg.fieldKey}</span>{' '}
                              <Tag kind={sg.source === 'ai' ? 'info' : 'default'}>{sg.source === 'ai' ? 'AI' : '规则'}</Tag>{' '}
                              <Tag kind={confKind(sg.confidence)}>置信度 {confText(sg.confidence)}</Tag>
                              <div className="muted small">{sg.reason}</div>
                              {sg.rule && (
                                <div className="muted small">
                                  规则本来猜的是「{sg.rule.label}」（置信度 {confText(sg.rule.confidence)}）—— 两者不一致时请以语义为准。
                                </div>
                              )}
                            </div>
                          )}
                          {sg === null && (
                            <div className="muted small">
                              没猜出建议 —— 这类变量多半要先在「流程规范 → 项目信息」新建一个字段，再回来映射。
                            </div>
                          )}
                        </td>
                        <td className="small">
                          {u.count}
                          <div className="muted small">共 {u.templateCount} 份模板</div>
                        </td>
                        <td className="small muted" title={u.templates.map((t) => t.name).join('、')}>
                          {u.templates
                            .slice(0, 2)
                            .map((t) => t.name)
                            .join('、')}
                          {u.templateCount > 2 ? ` 等 ${u.templateCount} 份` : ''}
                        </td>
                        <td className="nowrap">
                          {sg && sg !== 'loading' ? (
                            <>
                              <Button size="sm" kind="primary" disabled={busy} onClick={() => write(u.name, sg)}>
                                确认写入
                              </Button>{' '}
                              <Button size="sm" disabled={busy} onClick={() => setSugg((x) => ({ ...x, [u.name]: undefined }))}>
                                不用
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" disabled={busy || sg === 'loading'} onClick={() => ask(u.name)}>
                              采纳建议
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/* ============================== 公司制度：上传 ============================== */

/** 上传结果：一个文件一条 */
interface UploadedItem {
  id: number;
  title: string;
  file_rel: string;
  /** 抽出来的正文字数，0 = 没有可识别的文字（多半是扫描件） */
  chars: number;
  duplicate: boolean;
}
interface UploadResult {
  items: UploadedItem[];
  failed: { name: string; error: string }[];
  folder: string;
}

/** 待上传的一批：path 是浏览器给的相对路径（文件夹上传时带目录） */
type PendingFile = { file: File; path: string };

/** Word 临时文件、系统垃圾文件 —— 传上来只会污染库，直接挡在门外 */
const JUNK_FILE = /(^|\/)(~\$|\._|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;
const JUNK_EXT = /\.(tmp|bak|lnk|db|ini)$/i;

function isJunk(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return name.startsWith('.') || JUNK_FILE.test(path) || JUNK_EXT.test(name);
}

/**
 * 把拖进来的东西摊平成文件清单。
 *
 * 拖文件夹时浏览器只给一个目录项，得靠 webkitGetAsEntry 自己递归 ——
 * 而且 readEntries 一次最多返回 100 条，必须读到返回空数组为止，
 * 否则「拖进来的文件夹只上传了前 100 个文件」这种问题极难发现。
 */
async function collectDropped(items: DataTransferItemList): Promise<PendingFile[]> {
  const roots: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const entry = items[i]?.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const out: PendingFile[] = [];

  const readAll = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));

  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isJunk(path)) out.push({ file, path });
      return;
    }
    if (!entry.isDirectory) return;
    const dir = `${prefix ? `${prefix}/` : ''}${entry.name}`;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await readAll(reader);
      if (!batch.length) break;
      for (const child of batch) await walk(child, dir);
    }
  };

  for (const root of roots) await walk(root, '');
  return out;
}

/**
 * 上传制度文件。
 *
 * 以前的做法是「自己把文件拷进数据目录的 _规范库 → 回界面点扫描」，
 * 传进来的文件根本没登记，扫描也扫不到，等于白拷。现在直接传：
 * 落到同一个目录、当场登记、当场切块入库。
 * 一个文件一个请求 —— 进度能看到第几个、坏文件也不会拖垮整批。
 */
function PolicyUploadCard({ onUploaded }: { onUploaded: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const filesRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const [errors, setErrors] = useState<{ name: string; error: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const doUpload = async (list: PendingFile[]): Promise<void> => {
    if (!list.length) {
      toast('没有可上传的文件', 'info');
      return;
    }
    setErrors([]);
    const ids: number[] = [];
    const errs: { name: string; error: string }[] = [];
    let dup = 0;
    let empty = 0;

    for (let i = 0; i < list.length; i += 1) {
      const f = list[i] as PendingFile;
      setProgress({ done: i, total: list.length, current: f.path });
      const fd = new FormData();
      fd.append('file', f.file, f.file.name);
      fd.append('path', f.path);
      try {
        const r = await api.post<UploadResult>('/api/kb/upload', fd);
        for (const it of r.items) {
          ids.push(it.id);
          if (it.duplicate) dup += 1;
          if (!it.chars) empty += 1;
        }
        errs.push(...r.failed);
      } catch (e) {
        errs.push({ name: f.path, error: (e as { message?: string }).message ?? '上传失败' });
      }
    }

    setProgress(null);
    setErrors(errs);
    onUploaded();
    if (!ids.length) {
      toast(errs[0] ? `上传失败：${errs[0].error}` : '没有文件上传成功', 'err');
      return;
    }

    const bits = [`已上传 ${ids.length} 个文件`];
    if (dup) bits.push(`${dup} 个和已有的同一份，已合并`);
    if (empty) bits.push(`${empty} 个没抽到文字（扫描件要先做 OCR）`);
    toast(`${bits.join('，')}，正在切块入库…`, 'ok');

    // 只处理刚传上来的这批：既快，也不会把「正文不足 50 字」的文件漏掉
    try {
      const r = await api.post<{ queued: number }>('/api/kb/import-all', { artifactIds: ids, embed: false });
      if (r.queued === 0) toast('这些文件之前已经入库过了', 'info');
    } catch (e) {
      toast(`入库没启动：${(e as { message?: string }).message ?? '未知原因'}`, 'err');
    }
    onUploaded();
  };

  const start = (list: PendingFile[]) => run(() => doUpload(list));

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.items;
    // 必须在事件回调里同步把 entry 取出来，拖放数据一出回调就失效了
    const entries = items
      ? Array.from(items).map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
      : [];
    if (entries.some(Boolean)) {
      run(async () => {
        const list = (await collectDropped(items as DataTransferItemList)).filter((f) => !isJunk(f.path));
        await doUpload(list);
      });
      return;
    }
    start(Array.from(e.dataTransfer.files).map((file) => ({ file, path: file.name })));
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>, useRelativePath: boolean) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ''; // 清空，同一个文件想再传一次时还能触发 change
    start(
      picked
        .map((file) => ({ file, path: useRelativePath ? file.webkitRelativePath || file.name : file.name }))
        .filter((f) => !isJunk(f.path)),
    );
  };

  // webkitdirectory 不在 React 的类型里，只能这样挂上去
  const dirAttrs = { webkitdirectory: '', directory: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>;

  return (
    <Card
      title="上传制度文件"
      extra={<span className="muted small">文件、整个文件夹都行；也可以直接拖进来</span>}
    >
      <div
        className={`drop-zone${dragOver ? ' drop-zone-on' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="drop-title">{dragOver ? '松手就开始上传' : '把文件或文件夹拖到这里'}</div>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <Button kind="primary" disabled={busy} onClick={() => filesRef.current?.click()}>
            选择文件
          </Button>
          <Button disabled={busy} onClick={() => dirRef.current?.click()}>
            选择整个文件夹
          </Button>
        </div>
        <div className="muted small drop-hint">
          制度、规范、标准、上级通知都可以传。传文件夹会<strong>保留里面的目录结构</strong>，
          你怎么分类，库里就怎么分类。传完自动切块入库 ——
          抽取后建立本地关键词索引，原文与出处保存在本机。
        </div>
      </div>

      <input ref={filesRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => onPick(e, false)} />
      <input ref={dirRef} type="file" multiple style={{ display: 'none' }} onChange={(e) => onPick(e, true)} {...dirAttrs} />

      {progress && (
        <div className="mt12">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="small">
              正在上传 {progress.done + 1} / {progress.total}：{progress.current}
            </span>
            <span className="small muted">{Math.round((progress.done / progress.total) * 100)}%</span>
          </div>
          <div className="bar mt4">
            <div className="bar-fill" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </div>
      )}

      {errors.length > 0 && (
        <div className="notice notice-err mt12">
          有 {errors.length} 个文件没传上去：
          {errors.slice(0, 8).map((x) => (
            <div key={x.name} className="small">
              · {x.name}：{x.error}
            </div>
          ))}
          {errors.length > 8 && <div className="small">…还有 {errors.length - 8} 个</div>}
        </div>
      )}
    </Card>
  );
}

/* ============================== 公司制度：来源目录 ============================== */

/** scan 接口的返回：files/dirs/bytes/skipped + 上限信息（truncated 时界面必须说清"只统计了一部分"） */
interface KbScanResult {
  files: number;
  dirs: number;
  bytes: number;
  /** 读不到的项（iCloud 未下载 / 没权限），已跳过，不中断统计 */
  skipped: number;
  truncated: boolean;
  truncatedBy: 'count' | 'time' | null;
  limit: number;
  timeLimitMs: number;
  elapsedMs: number;
}

/**
 * 制度来源目录（契约 §1 决定 3/7 —— 本阶段只搭框架）。
 *
 * 只做三件事：登记一个只读的来源文件夹、统计它的文件数与总大小、移除登记。
 * 界面上**刻意没有**「导入知识库 / 向量化」按钮：内容抽取要等工作台侧确认无误后
 * 再启用，现在点「统计」只数元数据（后端只 readdir + stat），
 * 不读取任何文件内容、不触发 iCloud 下载、不往来源目录里写任何东西。
 */
/**
 * 制度来源目录（B3-8：从"只统计元数据"走到"真抽内容"）。
 *
 * 界面上把两件事分得很清楚，因为用户最容易误解的就是这一点：
 *   · 「统计」只数文件数与大小，**不读内容**；
 *   · 「预览」按当前三个口径算出"会入库多少、哪些被跳过、为什么"，**仍然不写库**；
 *   · 「开始抽取」才真读正文 → 切块（带章节/条款路径）→ 建 FTS → 向量化。
 *
 * 三条硬承诺都写在卡片上，不是修辞：
 *   1. 只读你的目录：不写、不改名、不移动、不删除（抽完还会对比目录快照）；
 *   2. 单文件失败只跳过那一个并记原因，整批继续；
 *   3. 同一批重跑不产生重复数据（来源+相对路径是稳定键，原地更新）。
 */
function PolicySourceDirsCard() {
  const toast = useToast();
  const { busy, run } = useAction();
  const list = useApi<{ items: KbSource[] }>('/api/kb/sources');
  const cfg = useApi<KbExtractConfig>('/api/kb/extract/config');
  const [path, setPath] = useState('');
  const [lastScan, setLastScan] = useState<{ label: string; r: KbScanResult } | null>(null);
  const [preview, setPreview] = useState<{ id: number; label: string; r: KbExtractPreview } | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [job, setJob] = useState<KbExtractJob | null>(null);
  const embed = false;
  const [ocr, setOcr] = useState(false);
  const items = list.data?.items ?? [];

  /* 任务进度轮询：只在有任务时开，跑完/取消/失败即停 */
  const polling = useRef(false);
  useEffect(() => {
    polling.current = jobId !== null;
    if (jobId === null) return;
    let alive = true;
    const tick = async () => {
      while (alive && polling.current) {
        try {
          const r = await api.get<{ status: KbExtractJob }>(`/api/kb/sources/${jobId}/extract/status`);
          const s = r.status;
          if (!alive) return;
          setJob(s ?? null);
          if (!s?.running) {
            polling.current = false;
            list.reload();
            toast(s?.job?.message ?? '抽取结束', s?.job?.status === 'done' ? 'ok' : 'info');
            return;
          }
        } catch {
          /* 轮询失败不打断界面，下一轮回来自会好 */
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    };
    void tick();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const cur = cfg.data?.settings;

  const add = () =>
    run(async () => {
      const p = path.trim();
      if (!p) {
        toast('先填一个绝对路径，例如 D:\\资料\\3.制度', 'info');
        return;
      }
      const r = await api.post<{ source: KbSource }>('/api/kb/sources', { path: p });
      setPath('');
      list.reload();
      toast(`已登记「${r.source.label ?? r.source.path}」—— 只登记路径，没有读取里面的内容`, 'ok');
    });

  const scan = (s: KbSource) =>
    run(async () => {
      const r = await api.post<KbScanResult>(`/api/kb/sources/${s.id}/scan`, {});
      setLastScan({ label: s.label ?? s.path, r });
      list.reload();
      const head = `「${s.label ?? s.path}」：文件 ${r.files} 个 · 子目录 ${r.dirs} 个 · ${fmtSize(r.bytes)}`;
      toast(r.truncated ? `${head}（触到上限，只统计了一部分）` : head, r.truncated ? 'info' : 'ok');
    });

  const doPreview = (s: KbSource) =>
    run(async () => {
      const r = await api.post<KbExtractPreview>(`/api/kb/sources/${s.id}/preview`, { limit: 20 });
      setPreview({ id: s.id, label: s.label ?? s.path, r });
      toast(`按当前口径：将处理 ${r.total} 个文件，其中 ${r.willExtract} 个会入库（预览没有写任何数据）`, 'ok');
    });

  const doExtract = (s: KbSource) =>
    run(async () => {
      const r = await api.post<{ jobId: number; total: number; settings: KbExtractSettings; note: string }>(`/api/kb/sources/${s.id}/extract`, {
        embed,
        ocr,
      });
      setJobId(s.id);
      toast(`已起抽取任务：${r.total} 个文件（口径 去重=${r.settings.dedup} / 范围=${r.settings.scope} / 版本=${r.settings.version}）。进度见下方进度条。`, 'ok');
    });

  const cancel = () =>
    run(async () => {
      if (jobId === null) return;
      await api.post(`/api/kb/extract/${jobId}/cancel`, {});
      toast('已请求取消：已入库的成果保留，下次重跑只会补没做完的', 'info');
    });

  const remove = (s: KbSource) => {
    if (
      !window.confirm(
        `移除来源目录「${s.label ?? s.path}」？\n\n只删这条登记记录和它已经入库的文档，磁盘上的文件夹和文件一个都不会动。`,
      )
    )
      return;
    void run(async () => {
      await api.del(`/api/kb/sources/${s.id}`);
      list.reload();
      toast('已移除登记记录（磁盘上的文件未改动）', 'ok');
    });
  };

  const j = job?.job;
  const pct = j && j.total > 0 ? Math.round(((j.done + j.failed + j.skipped) / j.total) * 100) : 0;

  return (
    <Card
      title="制度来源目录（内容抽取）"
      extra={
        <Button size="sm" disabled={list.loading} onClick={list.reload}>
          刷新
        </Button>
      }
    >
      <div className="notice notice-info">
        <strong>抽取只读你的目录</strong>：不写、不改名、不移动、不删除里面的任何文件；
        中间产物落在平台自己的 <code>data/runtime/kb-tmp</code> 下。
        <br />
        单文件失败（坏 docx、空文件、扫描件没装 OCR）只跳过它并在下方列出原因，<strong>不会中断整批</strong>；
        同一批重跑不会产生重复数据（来源+相对路径是稳定键，原地更新）。
      </div>

      <div className="row mt12" style={{ gap: 8, flexWrap: 'wrap' }}>
        <span className="small muted">当前口径：</span>
        <Tag kind="info">去重 {cur?.dedup ?? '…'}</Tag>
        <Tag kind="info">范围 {cur?.scope ?? '…'}</Tag>
        <Tag kind="info">版本 {cur?.version ?? '…'}</Tag>
        <span className="small muted">（在「设置」页改，改完点「开始抽取」按新口径重跑）</span>
      </div>

      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <Input
            value={path}
            onChange={setPath}
            placeholder="粘贴制度文件夹的绝对路径，例如 D:\\资料\\3.制度"
            onEnter={add}
          />
        </div>
        <Button kind="primary" disabled={busy} onClick={add}>
          添加
        </Button>
      </div>

      {list.error && <div className="notice notice-err mt12">{list.error.message}</div>}

      {list.loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty text="还没有登记来源目录。把制度汇总文件夹的绝对路径填在上面，点「添加」即可。" />
      ) : (
        <table className="table mt16">
          <thead>
            <tr>
              <th>名称</th>
              <th>路径</th>
              <th style={{ width: 80 }}>文件数</th>
              <th style={{ width: 90 }}>总大小</th>
              <th style={{ width: 130 }}>已入库</th>
              <th style={{ width: 150 }}>上次抽取</th>
              <th style={{ width: 250 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>{s.label ?? '—'}</td>
                <td className="small mono ellipsis" title={s.path}>
                  {s.path}
                </td>
                <td className="small">{s.file_count}</td>
                <td className="small muted">{fmtSize(s.total_bytes)}</td>
                <td className="small">
                  {s.extracted_docs ?? 0} 份 / {s.extracted_chunks ?? 0} 块
                </td>
                <td className="small muted nowrap">{fmtTime(s.last_extract_at ?? null)}</td>
                <td className="nowrap" style={{ textAlign: 'right' }}>
                  <Button size="sm" disabled={busy} onClick={() => scan(s)}>
                    统计
                  </Button>{' '}
                  <Button size="sm" disabled={busy} onClick={() => doPreview(s)}>
                    预览
                  </Button>{' '}
                  <Button size="sm" kind="primary" disabled={busy} onClick={() => doExtract(s)}>
                    开始抽取
                  </Button>{' '}
                  <Button size="sm" disabled={busy} onClick={() => remove(s)}>
                    移除
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row mt12" style={{ gap: 16, flexWrap: 'wrap' }}>
        <label className="small">
          <input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} /> 对扫描件做 OCR（慢，需要先开
          OCR 设置；不开就把它记为"需要 OCR"跳过）
        </label>
      </div>

      {lastScan && (
        <div className={`${lastScan.r.truncated ? 'notice notice-warn' : 'notice notice-info'} mt12`}>
          「{lastScan.label}」：文件 {lastScan.r.files} 个 · 子目录 {lastScan.r.dirs} 个 ·{' '}
          {fmtSize(lastScan.r.bytes)}，耗时 {(lastScan.r.elapsedMs / 1000).toFixed(1)} 秒
          {lastScan.r.skipped > 0 && <>；{lastScan.r.skipped} 项读不到已跳过（iCloud 未下载或没有权限）</>}
          {lastScan.r.truncated && (
            <>
              <br />
              <strong>
                只统计了前{' '}
                {lastScan.r.truncatedBy === 'count' ? lastScan.r.limit : lastScan.r.files + lastScan.r.dirs} 项
              </strong>
              （
              {lastScan.r.truncatedBy === 'count'
                ? `已达 ${lastScan.r.limit} 项上限`
                : `已跑满 ${Math.round(lastScan.r.timeLimitMs / 1000)} 秒`}
              ），实际文件数比这更多。目录太大时分几个子目录分别登记会更准。
            </>
          )}
        </div>
      )}

      {preview && (
        <div className="notice notice-info mt12">
          <strong>
            「{preview.label}」抽取预览：{preview.r.total} 个文件，按当前口径 <em>将入库 {preview.r.willExtract} 份</em>
          </strong>
          （要读约 {fmtSize(preview.r.bytesToRead)}；预览只读标题/页眉，不写任何数据）
          <div className="small mt8">
            判定分布：
            {Object.entries(preview.r.byDecision).map(([k, v]) => (
              <Tag key={k} kind={k === 'extract' ? 'ok' : 'default'}>{DECISION_LABEL[k] ?? k} {v}</Tag>
            ))}
            {Object.entries(preview.r.byLayer).map(([k, v]) => (
              <Tag key={k} kind="info">{LAYER_LABEL[k] ?? k} {v}</Tag>
            ))}
            {preview.r.walk.truncated && <Tag kind="warn">目录项数触到上限，只处理了一部分</Tag>}
          </div>
          <table className="table mt8">
            <thead>
              <tr>
                <th>文件</th>
                <th style={{ width: 90 }}>文号</th>
                <th style={{ width: 90 }}>分区</th>
                <th style={{ width: 80 }}>版本</th>
                <th style={{ width: 70 }}>判定</th>
                <th>理由</th>
              </tr>
            </thead>
            <tbody>
              {preview.r.samples.map((s) => (
                <tr key={s.relPath}>
                  <td className="small ellipsis" title={s.relPath}>
                    {s.relPath}
                  </td>
                  <td className="small muted">{s.docNo ?? '—'}</td>
                  <td className="small">{LAYER_LABEL[s.scopeLayer] ?? s.scopeLayer}</td>
                  <td className="small">{VERSION_LABEL[s.versionStatus] ?? s.versionStatus}</td>
                  <td className="small">
                    <Tag kind={s.decision === 'extract' ? 'ok' : 'default'}>{DECISION_LABEL[s.decision] ?? s.decision}</Tag>
                  </td>
                  <td className="small muted">{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {job && j && (
        <div className={`${j.status === 'failed' ? 'notice notice-err' : j.status === 'done' ? 'notice notice-ok' : 'notice notice-info'} mt12`}>
          <strong>
            抽取进度：{j.done + j.failed + j.skipped}/{j.total}
            （入库 {j.done} · 跳过 {j.skipped} · 失败 {j.failed}）
          </strong>
          {j.status === 'running' && ` · 正在处理 ${j.current || '…'}`}
          {j.status !== 'running' && j.message && <> · {j.message}</>}
          <div className="mt8">
            <Bar value={pct} max={100} kind={j.status === 'failed' ? 'danger' : 'primary'} />
          </div>
          {job.settings && (
            <div className="small mt4 muted">
              本次口径：去重 {job.settings.dedup} · 范围 {job.settings.scope} · 版本 {job.settings.version}
               · 本地关键词索引
              {` · 用时 ${(job.elapsedMs / 1000).toFixed(1)} 秒`}
            </div>
          )}
          {j.status === 'running' && (
            <div className="mt8">
              <Button size="sm" onClick={cancel} disabled={busy}>
                取消（已入库的保留）
              </Button>
            </div>
          )}
          {job.failures.length > 0 && (
            <div className="mt8">
              <strong>跳过/失败的文件与原因（{job.failures.length} 个，其余文件都已处理完）：</strong>
              <ul className="small">
                {job.failures.slice(0, 30).map((f) => (
                  <li key={f.rel_path}>
                    <span className="mono">{f.rel_path}</span> —— {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

const DECISION_LABEL: Record<string, string> = {
  extract: '将入库',
  dedup: '重复跳过',
  scope: '范围外跳过',
  version: '版本跳过',
  kind: '非制度跳过',
};
const LAYER_LABEL: Record<string, string> = { unit: '本单位', regulation: '法规标准', reference: '参考制度' };
const VERSION_LABEL: Record<string, string> = { final: '定稿', current: '现行', superseded: '历史稿' };

/* ============================== 公司制度：文档列表 ============================== */

/**
 * 制度模块的主视图 —— 看库里有什么文档、导入新资料。
 * 「找文件」「检索提问」是它的两种用法，放在上面的子页签里。
 */
function PolicyDocsPanel() {
  const toast = useToast();
  const { busy, run } = useAction();
  const status = useApi<KbStatus>('/api/kb/status');
  const docs = useApi<{ items: KbDoc[] }>('/api/kb/documents');
  const [detailId, setDetailId] = useState<number | null>(null);

  useEffect(() => {
    if (!status.data?.batch.running) return;
    const t = setTimeout(() => {
      status.reload();
      docs.reload();
    }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data]);

  const s = status.data;
  const list = docs.data?.items ?? [];

  return (
    <>
      <div className="notice notice-info">
        <strong>公司制度放这里。</strong>
        制度、规范、标准合同、验收标准、上级通知 —— 直接上传就行（文件或整个文件夹）。
        入库后可按关键词查找原文；只有明确要求参考制度时，才用于本次生成。
        <br />
        <span className="muted small">
          想按关键词精确找文件，用上面的「找文件」；想查找原文片段或用本地模型回答，用「检索提问」。
        </span>
      </div>

      <PolicyUploadCard
        onUploaded={() => {
          status.reload();
          docs.reload();
        }}
      />

      <PolicySourceDirsCard />

      <Card
        title={`已入库文档（${s?.documents ?? 0}）`}
        extra={
          <>
            <Button size="sm" onClick={() => { status.reload(); docs.reload(); }}>
              刷新
            </Button>
            <Button
              size="sm"
              disabled={busy || s?.batch.running}
              title="把文件库里还没入库的文档（包括自己拷进 _规范库 的）都处理一遍"
              onClick={() =>
                run(async () => {
                  const r = await api.post<{ queued: number }>('/api/kb/import-all', { limit: 300, embed: false });
                  toast(
                    r.queued > 0 ? `已开始导入 ${r.queued} 篇文档，后台处理中` : '没有需要导入的文档',
                    r.queued > 0 ? 'ok' : 'info',
                  );
                  status.reload();
                })
              }
            >
              {s?.batch.running ? '导入中…' : '导入全部文件'}
            </Button>
          </>
        }
      >
        {status.loading ? (
          <Loading />
        ) : (
          <>
            <div className="grid grid-2">
              <div>
                <div className="small muted">已入库文档</div>
                <strong style={{ fontSize: 20 }}>{s?.documents ?? 0}</strong>
                <div className="small muted">共 {s?.chunks ?? 0} 个片段</div>
              </div>
              <div>
                <div className="small muted">未入库的文件</div>
                <strong style={{ fontSize: 20 }}>{s?.notIndexed ?? 0}</strong>
                <div className="small muted">共 {s?.totalCandidates ?? 0} 个候选</div>
              </div>
            </div>

            {s?.batch.running && (
              <div className="notice notice-info mt12">
                正在处理：{s.batch.done} / {s.batch.total}
                {s.batch.failed > 0 ? `（失败 ${s.batch.failed}）` : ''}
                {s.batch.current ? `　当前：${s.batch.current}` : ''}
              </div>
            )}

          </>
        )}

        {docs.loading ? (
          <Loading />
        ) : list.length === 0 ? (
          <Empty text="还没有入库的文档。把制度、规范文件放进 _规范库 后点「导入全部文件」。" />
        ) : (
          <table className="table mt16">
            <thead>
              <tr>
                <th>标题</th>
                <th style={{ width: 100 }}>片段</th>
                <th style={{ width: 150 }}>入库时间</th>
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a className="clickable" onClick={() => setDetailId(d.id)}>
                      {d.title}
                    </a>
                  </td>
                  <td className="small">{d.chunk_count}</td>
                  <td className="small muted nowrap">{fmtTime(d.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="使用建议" collapsible>
        <div className="small muted col" style={{ gap: 8 }}>
          <div>
            <strong>该放什么进去：</strong>制度文件、行业规范、标准合同模板、验收标准、历史项目的优秀文档、上级下发的通知要求。
            传文件夹会保留目录结构，按你自己的分类建子目录即可。
          </div>
          <div>
            <strong>两种入库方式：</strong>平时直接用上面的上传（文件或文件夹）；
            如果已经用资源管理器把文件拷进了数据目录的 <code>_规范库</code>，点「导入全部文件」也能把它们纳管。
            两边落到同一个地方，不会出现「拷进来了但库里没有」。
          </div>
          <div>
            <strong>扫描件与照片：</strong>上传后自动抽文字；扫描件 PDF 和图片会排队做 OCR，识别结果一并入库。
            没配 OCR 的话这类文件只能作为附件存放，检索不到内容。
          </div>
          <div>
            <strong>模板和制度的区别：</strong>模板是「要填的表」，制度是「办事的规矩」。
            模板负责格式；制度参考默认关闭，只在本次明确要求时提供原文依据。
          </div>
        </div>
      </Card>

      {detailId !== null && <DocDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
}

/* ============================== 查依据（跨模块） ============================== */

interface KnowledgeHit {
  source: 'template' | 'policy';
  sourceLabel: string;
  id: number;
  title: string;
  snippet: string;
  heading?: string | null;
  score: number;
  optional?: boolean;
  template?: { code: string; format: string; variableCount: number; workTypeId: number | null };
  documentId?: number | null;
  artifactId?: number | null;
}

interface KnowledgeResult {
  ok: boolean;
  error?: string;
  hits: KnowledgeHit[];
  counts: { template: number; policy: number };
  corpus: { templates: number; documents: number; chunks: number };
  skipped?: string;
}

/**
 * 查依据 —— 这一页是给「两个模块」这件事收口的。
 *
 * 模板库和公司制度分开摆，是为了你找东西方便；但大模型写内容时不分开问，
 * 它一次就把两边都查了。这一页让你看到的就是它看到的那份依据 ——
 * 写出来的东西对不对，可以先在这里核一遍口径。
 */
function EvidencePanel() {
  const types = useApi<{ items: WorkType[] }>('/api/work-types');
  const [q, setQ] = useState('');
  const [workTypeId, setWorkTypeId] = useState('');
  const [res, setRes] = useState<KnowledgeResult | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const { busy, run } = useAction();

  const doSearch = () =>
    run(async () => {
      if (!q.trim()) return;
      const r = await api.get<KnowledgeResult>(
        `/api/kb/knowledge?${new URLSearchParams({
          q,
          budget: '8',
          ...(workTypeId ? { workTypeId } : {}),
        }).toString()}`,
      );
      setRes(r);
    });

  const hits = res?.hits ?? [];
  const main = hits.filter((h) => !h.optional);
  const optional = hits.filter((h) => h.optional);

  return (
    <>
      <div className="notice notice-info">
        <strong>这里查的就是大模型写内容时看到的依据。</strong>
        模板库和公司制度虽然分开摆，但模型思考时是<strong>一起查</strong>的 ——
        制度定口径、模板定格式，不用你分两次找，也不用每次都查：没有具体线索时它会跳过这一步。
        <br />
        <span className="muted small">
          想看某次生成到底参考了什么，在「出文书」的结果里有一块「写内容时参考了」。
        </span>
      </div>

      <Card title="按一句话或几个词查依据">
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Input
              value={q}
              onChange={setQ}
              placeholder="例如：本月清廉工程月度检查，重点看制度执行和公开公示"
              onEnter={doSearch}
            />
          </div>
          <Select
            value={workTypeId}
            onChange={setWorkTypeId}
            placeholder="不限工作类型"
            options={(types.data?.items ?? []).map((t) => ({ value: String(t.id), label: t.name }))}
          />
          <Button kind="primary" disabled={busy || !q.trim()} onClick={doSearch}>
            {busy ? '查询中…' : '查依据'}
          </Button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          选了工作类型，会顺便把<strong>这类工作可用的表</strong>也列出来 —— 说不清该用哪张表时，
          把候选摆出来比猜一张更有用。
        </p>
      </Card>

      {res && (
        <Card
          title={
            res.skipped
              ? '没有检索'
              : `查到 ${main.length} 条依据${optional.length ? `，另有 ${optional.length} 张可选的表` : ''}`
          }
          extra={
            <span className="muted small">
              语料：模板 {res.corpus.templates} · 制度文档 {res.corpus.documents}（{res.corpus.chunks} 片段）
            </span>
          }
        >
          {res.skipped ? (
            <Empty text={res.skipped} />
          ) : (
            <>
              {res.error && <div className="notice notice-warn mb8">{res.error}</div>}
              {res.corpus.documents === 0 && (
                <div className="notice notice-info mb8">
                  公司制度这一侧还没有文档，所以现在只能查到模板。把制度文件放进 <code>_规范库</code>，
                  到「已入库文档」点「导入全部文件」即可。
                </div>
              )}

              {main.length === 0 ? (
                <Empty text="没有命中的依据。可以换个说法，或选一个工作类型看看那类工作有哪些表。" />
              ) : (
                <div className="col" style={{ gap: 10 }}>
                  {main.map((h, i) => (
                    <div key={`${h.source}-${h.id}-${i}`} className="check-main">
                      <div className="check-title">
                        <Tag kind={h.source === 'policy' ? 'info' : 'ok'}>{h.sourceLabel}</Tag>
                        {h.documentId ? (
                          <a className="clickable" onClick={() => setDetailId(h.documentId as number)}>
                            {h.title}
                          </a>
                        ) : (
                          <span>{h.title}</span>
                        )}
                        {h.heading ? <span className="muted small"> · {h.heading}</span> : null}
                        <span className="muted small">{(h.score * 100).toFixed(0)}%</span>
                      </div>
                      <div className="check-detail" style={{ whiteSpace: 'pre-wrap' }}>
                        {h.snippet}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {optional.length > 0 && (
                <div className="mt16">
                  <div className="small muted mb8">这类工作还可以用这些表（不是每张都要出）：</div>
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    {optional.map((h) => (
                      <Tag key={h.id} kind="default">
                        {h.title}
                        {h.template ? `（${h.template.format}，${h.template.variableCount} 项）` : ''}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {detailId !== null && <DocDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
}

/* ============================== 找文件（关键词） ============================== */
function FileSearchPanel() {
  const [q, setQ] = useState('');
  const [workbenchId, setWorkbenchId] = useState('');
  const [kind, setKind] = useState('');
  const [mode, setMode] = useState<'or' | 'and'>('or');
  const dq = useDebounced(q);

  const workbenches = useWorkbenchCollection();
  const stats = useApi<{ total: number; bytes: number; indexed: number; dataRoot: string }>('/api/files/stats');

  const searching = dq.trim().length > 0;
  const searchResult = useApi<{ total: number; items: Artifact[]; keyword: string }>(
    searching
      ? `/api/search?${new URLSearchParams({
          q: dq,
          ...(workbenchId ? { workbenchId } : {}),
          ...(kind ? { kind } : {}),
          mode,
          limit: '80',
        }).toString()}`
      : null,
    [dq, workbenchId, kind, mode],
  );
  const browse = useApi<{ total: number; items: Artifact[] }>(
    !searching
      ? `/api/artifacts?${new URLSearchParams({
          ...(workbenchId ? { workbenchId } : {}),
          ...(kind ? { kind } : {}),
          limit: '100',
        }).toString()}`
      : null,
    [workbenchId, kind],
  );

  const items = searching ? (searchResult.data?.items ?? []) : (browse.data?.items ?? []);
  const loading = searching ? searchResult.loading : browse.loading;
  const wbName = (id: number | null) => workbenches.data?.items.find((w) => w.id === id)?.name;

  return (
    <Card
      title={searching ? `检索「${dq}」` : '浏览全部文件'}
      extra={
        <>
          <Input value={q} onChange={setQ} placeholder="搜文件名或正文内容…" />
          <WorkbenchSelect collection={workbenches} value={workbenchId} onChange={setWorkbenchId} placeholder="全部工作"/>
          <Select
            value={kind}
            onChange={setKind}
            placeholder="全部类别"
            options={[
              { value: 'generated', label: '生成的文书' },
              { value: 'evidence', label: '影像证据' },
              { value: 'source', label: '原始资料' },
              { value: 'scan', label: '扫描件' },
            ]}
          />
          {searching && (
            <Select
              value={mode}
              onChange={(v) => setMode(v as 'or' | 'and')}
              options={[
                { value: 'or', label: '任一关键词' },
                { value: 'and', label: '全部关键词' },
              ]}
            />
          )}
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        共 {stats.data?.total ?? 0} 个文件 · {fmtSize(stats.data?.bytes)} · 已建索引 {stats.data?.indexed ?? 0} 个
        {searching && searchResult.data ? `　·　命中 ${searchResult.data.total} 个` : ''}
      </p>

      {loading ? (
        <Loading />
      ) : items.length === 0 ? (
        <Empty
          text={
            searching
              ? '没有匹配的文件。试试换个关键词，或切到「检索提问」按意思找。'
              : '还没有文件。生成文书、或到工作台里上传资料后会出现在这里。'
          }
        />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>文件</th>
              <th style={{ width: 170 }}>所属工作</th>
              <th style={{ width: 150 }}>时间</th>
              <th style={{ width: 80 }}>大小</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.title}</strong>
                  <div className="muted small mono ellipsis">{a.file_name}</div>
                </td>
                <td className="small muted">{wbName(a.workbench_id) ?? '—'}</td>
                <td className="small muted nowrap">{fmtTime(a.created_at)}</td>
                <td className="small muted">{fmtSize(a.size_bytes)}</td>
                <td className="nowrap" style={{ textAlign: 'right' }}>
                  <Button size="sm" onClick={() => api.download(`/api/artifacts/${a.id}/file`, a.file_name)}>
                    下载
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ============================== 检索提问（语义） ============================== */

function AskPanel() {
  const toast = useToast();
  const [question, setQuestion] = useState('');
  const mode = 'fulltext';
  const [result, setResult] = useState<{
    ok: boolean;
    error?: string;
    keyword?: string;
    semantic?: KbHit[];
    merged?: { key: string; source: string; score: number; title: string; snippet: string; artifactId: number | null; documentId: number | null }[];
    fulltext?: { total: number };
  } | null>(null);
  const [answer, setAnswer] = useState<{ answer: string; citations: { index: number; title: string; heading: string | null; seq: number }[] } | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const { busy, run } = useAction();

  const doSearch = () =>
    run(async () => {
      if (!question.trim()) return;
      setAnswer(null);
      const r = await api.get<typeof result>(`/api/kb/search?mode=${mode}&q=${encodeURIComponent(question)}&topK=10`);
      setResult(r);
      if (r && r.ok === false && r.error) toast(r.error, 'err');
    });

  const doAsk = () =>
    run(async () => {
      if (!question.trim()) return;
      const r = await api.post<{
        answer: string;
        citations: { index: number; title: string; heading: string | null; seq: number }[];
        hits: KbHit[];
      }>('/api/kb/ask', { question, topK: 6 });
      setAnswer({ answer: r.answer, citations: r.citations });
      setResult({ ok: true, semantic: r.hits, merged: [] });
    });

  /**
   * 展示用的命中列表。
   *
   * 原来只读 `result.semantic`，于是「只按关键词」模式**永远显示空结果** ——
   * 那个模式下后端把结果放在 `merged` 里、`semantic` 恒为空数组。
   * 而且混合检索真正排序过的也是 `merged`（全文与语义融合后的分数），
   * 直接读 semantic 等于把融合排序丢了。这里统一走 merged，没有再退回 semantic。
   */
  const hits: DisplayHit[] = result?.merged?.length
    ? result.merged.map((m) => ({
        key: m.key,
        title: m.title,
        score: m.score,
        text: m.snippet,
        documentId: m.documentId,
        source: m.source,
      }))
    : (result?.semantic ?? []).map((h) => ({
        key: `${h.documentId}-${h.seq}`,
        title: h.title,
        heading: h.heading,
        seq: h.seq,
        score: h.score,
        text: h.content,
        documentId: h.documentId,
      }));

  return (
    <>
      <div className="notice notice-info">
        <strong>本地关键词检索</strong>：输入制度名、条款关键词或文号，查找相关原文。
        <br />
        想知道<strong>文件叫什么名字</strong>，用「找文件」页更快也更省。
      </div>

      <Card title="检索 / 提问">
        <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <Input
              value={question}
              onChange={setQuestion}
              placeholder="例如：开箱验收要留存哪些影像资料？"
              onEnter={doSearch}
            />
          </div>
          <Button disabled={busy || !question.trim()} onClick={doSearch}>
            检索
          </Button>
          <Button kind="primary" disabled={busy || !question.trim()} onClick={doAsk}>
            问它
          </Button>
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          「检索」是找出相关原文段落；「问它」是把找到的段落交给大模型总结成答案，并标注每条结论的来源。
        </p>
      </Card>

      {answer && (
        <Card title="答案" extra={<Button size="sm" onClick={() => setAnswer(null)}>清除</Button>}>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{answer.answer}</div>
          {answer.citations.length > 0 && (
            <div className="mt12 small muted">
              依据：
              {answer.citations.map((c) => (
                <div key={c.index}>
                  [{c.index}] {c.title}
                  {c.heading ? ` · ${c.heading}` : ''}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {result && (
        <Card title={`检索结果${result.keyword ? `：${result.keyword}` : ''}`}>
          {result.ok === false ? (
            <Empty text={result.error ?? '检索失败'} />
          ) : hits.length === 0 ? (
            <Empty text="没有找到相关内容。换个说法试试，或先点上面的「导入全部文件」。" />
          ) : (
            <div className="col" style={{ gap: 10 }}>
              {hits.map((h, i) => (
                <div key={`${h.key}-${i}`} className="check-main">
                  <div className="check-title">
                    {h.documentId ? (
                      <a className="clickable" onClick={() => setDetailId(h.documentId as number)}>
                        {h.title}
                      </a>
                    ) : (
                      h.title
                    )}
                    {h.heading ? <span className="muted small"> · {h.heading}</span> : null}
                    {h.source && (
                      <Tag kind={h.source === 'both' ? 'ok' : h.source === 'semantic' ? 'info' : 'default'}>
                        关键词
                      </Tag>
                    )}
                    <Tag kind="info">{(h.score * 100).toFixed(0)}%</Tag>
                  </div>
                  <div className="check-detail" style={{ whiteSpace: 'pre-wrap' }}>
                    {h.text && h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {detailId !== null && <DocDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </>
  );
}

/* ============================== 文档详情 ============================== */

function DocDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useApi<{
    document: KbDoc;
    chunks: { id: number; seq: number; heading: string | null; content: string; has_vector: number }[];
  }>(`/api/kb/documents/${id}`);

  return (
    <Modal open wide title={d.data?.document.title ?? '文档详情'} onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      {d.loading ? (
        <Loading />
      ) : d.error ? (
        <Empty text={d.error.message} />
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            共 {(d.data?.chunks ?? []).length} 个片段。检索命中时会以片段为单位返回，所以这里的边界就是检索的最小单位。
          </p>
          <div className="col" style={{ gap: 10, maxHeight: '60vh', overflow: 'auto' }}>
            {(d.data?.chunks ?? []).map((c) => (
              <div key={c.id} className="check-main">
                <div className="check-title">
                  片段 {c.seq}
                  {c.heading ? <span className="muted small"> · {c.heading}</span> : null}

                </div>
                <div className="check-detail" style={{ whiteSpace: 'pre-wrap' }}>
                  {c.content}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function KnowledgeOverview({onTemplates,onPolicies}:{onTemplates:()=>void;onPolicies:()=>void}){
 const docs=useApi<{items:KbDoc[]}>('/api/kb/documents'),templates=useApi<{items:{id:number;name:string;description?:string;file_format:string}[]}>('/api/templates');
 const [query,setQuery]=useState(''),[preview,setPreview]=useState<number|null>(null);
 const rows=[...(docs.data?.items??[]).map(d=>({key:'d'+d.id,title:d.title,kind:'制度 / 参考',detail:d.chunk_count+' 个索引片段',source:d.source_rel??'来源待核实',date:fmtTime(d.created_at),open:()=>d.artifact_id?setPreview(d.artifact_id):onPolicies()})),...(templates.data?.items??[]).map(t=>({key:'t'+t.id,title:t.name,kind:'模板',detail:t.description||t.file_format.toUpperCase()+' 模板',source:'模板库 · 同一模板对象',date:'版本请在模板详情核对',open:onTemplates}))].filter(r=>!query||[r.title,r.detail,r.source].some(s=>s.toLowerCase().includes(query.toLowerCase())));
 return <><div className="page-toolbar"><Input value={query} onChange={setQuery} placeholder="搜索制度、模板名称与来源…"/><Button onClick={onPolicies}>导入与管理资料</Button></div>{docs.error&&<LoadError error={docs.error} retry={docs.reload}/>} {templates.error&&<LoadError error={templates.error} retry={templates.reload}/>}<p className="small muted">查阅不会开启制度引用；制度有效期与适用性需人工核实。</p>{docs.loading||templates.loading?<Loading/>:docs.error||templates.error?null:!rows.length?<Empty text={query?'未找到符合条件的资料。':'尚未导入资料，可添加制度文件或选择模板。'} action={<Button onClick={()=>query?setQuery(''):onPolicies()}>{query?'清除搜索':'导入资料'}</Button>}/>:<div className="grid grid-2">{rows.map(r=><Card key={r.key}><Tag kind={r.kind==='模板'?'warn':'info'}>{r.kind}</Tag><h3 className="mt12">{r.title}</h3><p>{r.detail}</p><p className="small muted">来源：{r.source}</p><div className="row"><span className="small muted">{r.date}</span><div className="spacer"/><Button size="sm" onClick={r.open}>{r.kind==='模板'?'查看模板':'查看资料'}</Button></div></Card>)}</div>}{preview&&<FilePreview id={preview} onClose={()=>setPreview(null)}/>}</>;
}
