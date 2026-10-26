/** 后端接口客户端 —— 所有请求的唯一出口，统一错误处理 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ApiErrorShape {
  code: string;
  message: string;
  detail?: unknown;
}

const BASE = '';
let sessionToken:Promise<string>|undefined;
/** 丢掉缓存的 token：后端每次启动都会换 token，旧的一直是 403 */
function forgetSession():void { sessionToken=undefined; }
async function writeHeaders():Promise<Record<string,string>> {
 sessionToken ??=fetch('/api/session').then(async r=>{if(!r.ok)throw new Error('无法建立本机会话');return ((await r.json()) as {data:{token:string}}).data.token;}).catch(e=>{sessionToken=undefined;throw e;});
 return {'x-workbench-token':await sessionToken};
}

/** 只负责发出去，不解析响应体 */
async function send(path:string,init?:RequestInit,withSession=false):Promise<Response>{
  const security=withSession ? await writeHeaders() : {};
  const isForm = init?.body instanceof FormData;
  /**
   * 只有真有请求体时才声明 `Content-Type: application/json`。
   *
   * 原来对所有非 FormData 请求一律带上这个头，而 `api.del` 是不带 body 的 ——
   * Fastify 认为"声明了 JSON 却没有 body"是格式错误，直接 400
   * `FST_ERR_CTP_EMPTY_JSON_BODY`，请求根本到不了处理函数。
   * 后果是界面上所有删除按钮（删工作台、删文件、删阶段、删规则、清空日志、删记忆…）
   * 点了都没反应，只在控制台里留一条 400。实测：带这个头 → 400，不带 → 正常。
   */
  const hasBody = init?.body !== undefined && init?.body !== null;
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: isForm
      ? {...security,...(init?.headers ?? {})}
      : {...(hasBody ? {'Content-Type':'application/json'} : {}), ...security, ...(init?.headers ?? {})},
  });
}

/**
 * 需要 token 的请求（非 GET/HEAD）。
 * 唯一会自动重试的情形：403 且错误码是 BAD_SESSION（服务重启后缓存 token 失效）——
 * 清掉缓存 → 重新取一次 /api/session → 用新 token 原样重试「一次」。
 * 其余状态码/错误码原样返回；重试后仍失败也原样返回，由上层把后端提示抛给用户。
 */
async function sendWithSession(path:string,init?:RequestInit):Promise<Response>{
  const res=await send(path,init,true);
  if(res.status!==403)return res;
  let code:string|undefined;
  try{code=((await res.clone().json()) as {error?:{code?:string}}).error?.code;}catch{code=undefined;}
  if(code!=='BAD_SESSION')return res;
  forgetSession();
  return send(path,init,true);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method=init?.method;
  const withSession=Boolean(method)&&!['GET','HEAD'].includes(method as string);
  let res:Response,text:string;
  try{res=withSession ? await sendWithSession(path, init) : await send(path, init);text=await res.text();}
  catch(e){
    if((e as Error).name==='AbortError')throw e;
    throw {code:'SERVICE_UNAVAILABLE',message:withSession?'服务连接中断，尚未确认保存结果。请启动工作台后先查看记录，再决定是否重试。':'无法连接工作台服务。请运行“启动工作台.cmd”，服务恢复后点击重试或刷新。'} as ApiErrorShape;
  }
  let json: { ok?: boolean; data?: T; error?: ApiErrorShape } | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw { code: 'BAD_RESPONSE', message: `服务返回了非 JSON 内容：${text.slice(0, 200)}` } as ApiErrorShape;
  }
  if (!res.ok || json?.ok === false) {
    throw (
      json?.error ?? ({ code: `HTTP_${res.status}`, message: `请求失败（${res.status}）` } as ApiErrorShape)
    );
  }
  return json?.data as T;
}

export const api = {
  get: <T,>(path: string,signal?:AbortSignal) => request<T>(path,{signal}),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
  put: <T,>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: <T,>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T,>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
  /** 下载文件（POST 后拿二进制流） */
  postBlob: async (path: string, body: unknown): Promise<{ blob: Blob; missing: string[] }> => {
    // 同样走带会话的口子，会话过期时能自动恢复一次
    const res = await sendWithSession(path, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) {
      const t = await res.text();
      let msg = `下载失败（${res.status}）`;
      try {
        msg = (JSON.parse(t) as { error?: { message: string } }).error?.message ?? msg;
      } catch {
        /* 保持默认 */
      }
      throw { code: 'DOWNLOAD_FAILED', message: msg } as ApiErrorShape;
    }
    const missingRaw = res.headers.get('X-Missing-Vars');
    let missing: string[] = [];
    if (missingRaw) {
      try {
        missing = JSON.parse(decodeURIComponent(missingRaw)) as string[];
      } catch {
        missing = [];
      }
    }
    return { blob: await res.blob(), missing };
  },
  /** 直接下载文件到本地 */
  download: (url: string, fileName?: string) => {
    const a = document.createElement('a');
    a.href = url.startsWith('http') ? url : `${BASE}${url}`;
    if (fileName) a.download = fileName;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },
  saveBlob: (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
};

/** 通用数据加载 hook */
export function useApi<T>(path: string | null, deps: unknown[] = []): {
  data: T | undefined;
  loading: boolean;
  error: ApiErrorShape | undefined;
  reload: () => void;
} {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState<ApiErrorShape>();
  const [tick, setTick] = useState(0);
  const [completedPath,setCompletedPath]=useState<string|null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let current=true;const controller=new AbortController();
    if (!path) {
      setData(undefined);
      setLoading(false);
      return;
    }
    setError(undefined);setLoading(true);
    api
      .get<T>(path,controller.signal)
      .then((d) => {
        if (alive.current && current) {
          setCompletedPath(path);
          setData(d);
          setError(undefined);
        }
      })
      .catch((e: ApiErrorShape) => {
        if (alive.current && current) {setCompletedPath(path);setError(e);}
      })
      .finally(() => {
        if (alive.current && current) setLoading(false);
      });
    return ()=>{current=false;controller.abort();};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data:completedPath===path?data:undefined, loading:Boolean(path)&&(loading||completedPath!==path), error:completedPath===path?error:undefined, reload };
}

/* ------------------------------- 类型定义 ------------------------------- */

export interface WorkType {
  navigation_group: 'information'|'engineering'|'administration'|null;
  display_name: string;
  usage_hint: string;
  archived_at: string|null;
  domain: 'admin'|'project';
  executor: 'general'|'timesheet';
  period_defaults: string|null;
  rule_version: number;
  id: number;
  code: string;
  name: string;
  category: string;
  description: string | null;
  color: string | null;
  /** process 流程驱动（项目类）| document 文书驱动（行政管理） */
  mode: string;
  position_count: number;
  template_count: number;
  workbench_count: number;
}

/** 周期性工作的排期状态（后端算好的，不在库里） */
export interface ScheduleState {
  recurring: boolean;
  /** 下一次该做的日期 YYYY-MM-DD */
  nextDue: string | null;
  daysUntil: number | null;
  shouldRemind: boolean;
  overdueDays: number;
  doneThisPeriod: boolean;
  /** 给人看的排期说明，如「每月 5 号」 */
  label: string;
}

export interface PositionRule {
  id: number;
  code: string;
  name: string;
  seq: number;
  /** 阶段目录名（用户从资料目录里挑的精确名字；空 = 回退「序号_阶段名」） */
  folder_name: string | null;
  /**
   * 期次目录规则（契约 §5 / §12，迁移 011）：
   * NULL/'' = 不按期次分目录；也可以是格式串，A 型默认 `{yyyy}\{mm}月` → `2026\10月`。
   * 老库（还没跑迁移 011）里这一列不存在，返回 undefined —— 与 NULL 同义。
   */
  period_dir?: string | null;
  description: string | null;
  duration_hint: string | null;
  materials: MaterialRule[];
  evidences: EvidenceRule[];
}

export interface MaterialRule {
  id: number;
  name: string;
  category: string;
  template_id: number | null;
  required: number;
  retention: string | null;
  hint: string | null;
}

export interface EvidenceRule {
  id: number;
  title: string;
  min_count: number;
  max_count: number | null;
  shooting_points: string | null;
  angles: string | null;
  required: number;
  hint: string | null;
}

/**
 * 阶段↔文书模板绑定（B2-7，迁移 018）。
 *
 * 优先级定死：**阶段绑定 > 工作台绑定 > 工作类型全部**。
 * 这是最高的一层 —— 「出文书」入口默认只列这里绑过的模板。
 */
export interface PositionDocBinding {
  templateId: number;
  code: string;
  name: string;
  file_format: string;
  /** null 未校验 / 1 好 / 0 坏（模板库页与出文书的口径一致） */
  health_ok: number | null;
  health_note: string | null;
  /** 1 = 本阶段必须出具 */
  required: number;
  seq: number;
  note: string | null;
  /** 引用不到可用的模板了（被真删 / 被归档）—— 界面要提示「请重新选择」，不静默消失 */
  missing: boolean;
  missingReason: string | null;
}

/** 「出文书」候选模板：带健康状态与能不能绑 */
export interface PositionDocCandidate extends Template {
  work_type_name?: string | null;
  health_ok?: number | null;
  health_note?: string | null;
  bindable: boolean;
  unbindableReason: string | null;
}

/**
 * 某个阶段「该出哪些文书、已出几份」（B2-7）。
 * `source` 说明这份清单来自哪一层优先级，界面据此把「为什么是这几个」讲清楚。
 */
export interface PositionDocSummary {
  positionId: number;
  positionCode: string;
  positionTemplateId: number | null;
  source: 'position' | 'workbench' | 'work_type';
  total: number;
  done: number;
  requiredTotal: number;
  requiredDone: number;
  /** 必须出具却没出的份数（>0 显示「缺文书」） */
  shortfall: number;
  boundAtPosition: boolean;
  boundAtWorkbench: boolean;
  items: { templateId: number; name: string; required: number; seq: number; generated: boolean }[];
}

export interface Workbench {
  business_content: string;
  id: number;
  code: string;
  name: string;
  work_type_id: number;
  work_type_name?: string;
  work_type_mode?: string;
  work_type_domain?: string;
  period_frequency?:string|null;
  period_total?:number;
  period_done?:number;
  period_due?:string|null;
  historical?: number;
  status: string;
  priority: string;
  owner: string | null;
  counterpart: string | null;
  contract_no: string | null;
  start_date: string | null;
  plan_end_date: string | null;
  folder_path: string;
  /** 绑定的资料目录（绝对路径）；null = 文件仍放在平台自己的目录里（契约 §2） */
  external_root?: string | null;
  /**
   * 输出位置模式（契约 §4）：`inline`（默认，就地）/ `subdir`（平台子目录）
   * / `custom`（自定义目录）；NULL 与缺列都视作 inline。老库没有这一列时是 undefined。
   */
  output_mode?: string | null;
  /** `custom` 模式的自定义输出目录（必须在本工作台根之内） */
  custom_output_dir?: string | null;
  summary: string | null;
  progress: number;
  position_done?: number;
  position_total?: number;
  artifact_count?: number;
  /** 周期性工作：once | monthly | quarterly | yearly */
  recurrence?: string;
  recur_day?: number | null;
  recur_month?: number | null;
  last_done_at?: string | null;
  remind_days?: number;
  /** 排期状态，后端算出来的 */
  schedule?: ScheduleState;
  updated_at: string;
}

export interface ChecklistItem {
  review_status:string;
  review_note:string;
  id: number;
  kind: 'material' | 'evidence';
  title: string;
  detail: string | null;
  required: number;
  min_count: number;
  status: string;
  done_count: number;
  done_at: string | null;
  done_by: string | null;
  note: string | null;
  artifact_count: number;
}

export interface PositionInstance {
  id: number;
  code: string;
  name: string;
  seq: number;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  owner: string | null;
  note: string | null;
  folder_rel: string | null;
  /**
   * 以下四项只有「工作台详情」接口会带（契约 §10.5：界面要能直接告诉用户文件到底落在哪），
   * 其它地方拿到的阶段实例没有它们。
   */
  /** 该阶段配置的期次规则；null/'' = 不按期次分目录 */
  period_dir?: string | null;
  /** 当前期次目录名（如 `2026\10月`）；不启用期次时为 null */
  period_dir_name?: string | null;
  /** 阶段目录绝对路径（不含期次） */
  stage_abs?: string;
  /** 阶段目录 + 期次的绝对路径（文件实际落点） */
  folder_abs?: string;
  /** 相对当前根的标识路径，与库里的 folder_rel 同口径 */
  folder_rel_current?: string;
  /**
   * 本阶段该出哪些文书、已出几份（B2-7）。只有「工作台详情」接口会带。
   * `null`/缺 = 没有这一项（老库缺迁移 018 之类），界面按"不显示"处理。
   */
  docSummary?: PositionDocSummary | null;
  checklist: ChecklistItem[];
}

export interface WorkbenchDetail {
  workbench: Workbench & {
    /** 排期状态，后端算好的（详情页要显示「下次应做」） */
    schedule?: ScheduleState;
    work_type_mode?: string;
    work_type_name?: string;
    /** 绑定的资料目录；null = 未绑定（文件在平台自己的目录里） */
    external_root: string | null;
    /** 文件实际所在的位置：绑定 → external_root，未绑定 → 平台数据目录下的工作台目录 */
    root_abs: string;
    /** 绑定目录是否还在（契约 §7.4：目录丢了要一眼看得出来） */
    folder_exists: boolean;
    /** 当前欠办那一期（YYYY-MM-DD）；单次工作为 null */
    due_period: string | null;
  };
  workType: WorkType | undefined;
  positions: PositionInstance[];
  stats: {
    positionTotal: number;
    positionDone: number;
    materialTotal: number;
    materialDone: number;
    evidenceTotal: number;
    evidenceDone: number;
    artifactCount: number;
  };
  /**
   * 整份工作的文书汇总（B2-7）：应出 N 份 / 已出 M 份 / 缺 K 份。
   * 老库缺迁移 018 时后端不给这个字段（`undefined`）—— 界面按"没有"处理，不显示。
   */
  docStats?: {
    total: number;
    done: number;
    requiredTotal: number;
    requiredDone: number;
    shortfall: number;
  };
}

/* ------------------------- 资料目录绑定（契约 §8） ------------------------- */

/**
 * 一个工作台当前绑定的资料目录 + 磁盘上的实际情况。
 *
 * `externalRoot === null` = 还没绑定（文件在平台自己的目录里）。
 * 目录被改名/移走/盘没挂上时后端不抛错，而是 `exists: false` + `message`
 * —— 契约 §7.4 要求"明确说一句目录不在了"，但也不能让整个详情页打不开。
 */
export interface BoundFolderInfo {
  externalRoot: string | null;
  exists: boolean;
  isDir: boolean;
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  /** 后端额外给的：绑定目录不在了 */
  missing?: boolean;
  /** 后端额外给的提示语（如「绑定的目录不在了：<路径>」），没有则为 null */
  message?: string | null;
}

/** 「阶段目录选择」下拉里的一项：某个资料目录下面的一层子目录 */
export interface FolderSubdir {
  name: string;
  /** 子目录绝对路径 */
  path: string;
  hasFiles: boolean;
  fileCount: number;
  /** 文件数到了统计上限就为 true（界面显示成「N+」） */
  countCapped: boolean;
}

/**
 * 目录绑定相关的接口封装。
 *
 * 注意 `unbind` 用的是 `api.del`（DELETE，**不带请求体**）——
 * 带上 JSON body 而声明 Content-Type 会让 Fastify 直接 400（见文件开头 send() 的注释），
 * 解绑就会"点了没反应"。后端解绑本来也只需要 id。
 */
export const folderApi = {
  /** 列某个目录下的一层子目录（只允许已绑定的资料目录内部） */
  subdirs: (path: string) =>
    api.get<{ path: string; parent: string; items: FolderSubdir[] }>(
      `/api/folders/subdirs?path=${encodeURIComponent(path)}`,
    ),
  /** 绑定资料目录（后端只写库、不动文件；失败时抛后端的中文错误原文） */
  bind: (workbenchId: number, path: string) =>
    api.post<BoundFolderInfo>(`/api/workbenches/${workbenchId}/bind-folder`, { path }),
  /** 解绑：后端只把 external_root 置空，绝不删/移动任何文件（契约 §7.2） */
  unbind: (workbenchId: number) => api.del<BoundFolderInfo>(`/api/workbenches/${workbenchId}/bind-folder`),
  /** 当前绑定 + 在不在 + 文件数 */
  bound: (workbenchId: number) => api.get<BoundFolderInfo>(`/api/workbenches/${workbenchId}/bound-folder`),
  /** 在资源管理器中打开一个目录（只负责打开，平台不读写它） */
  open: (path: string) => api.post<{ opened?: boolean; path?: string }>('/api/system/open-folder', { path }),
};

export interface TemplateVarSpec {
  name: string;
  label?: string;
  type?: 'text' | 'longtext' | 'date' | 'number' | 'table' | 'select';
  required?: boolean;
  example?: string;
  options?: string[];
  hint?: string;
  preset?: string;
}

export interface Template {
  id: number;
  code: string;
  name: string;
  category: string;
  work_type_id: number | null;
  work_type_name?: string | null;
  position_code: string | null;
  file_rel: string;
  file_format: string;
  variable_count: number;
  description: string | null;
  renderable?: boolean;
  file_exists?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface Artifact {
  file_role?:'source'|'external';
  id: number;
  workbench_id: number | null;
  position_code: string | null;
  kind: string;
  title: string;
  file_rel: string;
  file_name: string;
  file_ext: string | null;
  size_bytes: number | null;
  created_at: string;
  captured_at: string | null;
  checklist_item_id: number | null;
  doc_date: string | null;
  summary: string | null;
  ocr_status: string | null;
  url?: string;
  thumb?: string | null;
  /** 版本链（迁移 017 / B1-4）：老库或旧记录上没有这几个字段 */
  version_group?: string | null;
  revision?: number | null;
  supersedes_id?: number | null;
  is_final?: number | null;
  final_at?: string | null;
}

export interface AiProvider {
  id: number;
  code: string;
  name: string;
  base_url: string;
  api_key_env: string | null;
  enabled: number;
  is_builtin: number;
  remark: string | null;
  has_key: boolean;
  key_hint: string;
}

export interface AiProfile {
  id: number;
  purpose: string;
  name: string;
  provider_id: number | null;
  provider_name: string | null;
  model: string | null;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
}

/**
 * 知识库来源目录（契约 §2 / §8 + B3-8 内容抽取）。
 *
 * 列表里的 file_count / total_bytes / last_scan_at 是「数出来的」元数据；
 * 下面的 last_extract_at / extracted_docs / extracted_chunks 才是**内容真的入库了**的证据。
 * 两者分开显示是刻意的：统计不等于已入库（用户最容易误解的就是这一点）。
 */
export interface KbSource {
  id: number;
  /** 绝对路径（后端 realpath 规范化后入库） */
  path: string;
  label: string | null;
  enabled: number;
  created_at: string;
  last_scan_at: string | null;
  file_count: number;
  total_bytes: number;
  /** 最近一次内容抽取（B3-8） */
  last_extract_at?: string | null;
  extracted_docs?: number;
  extracted_chunks?: number;
  /** 最近一次抽取用的口径与结果摘要（人话） */
  extract_note?: string | null;
}

/** B3-8 抽取口径：三个设置项当前值 */
export interface KbExtractSettings {
  dedup: 'prefer_docx' | 'all' | 'by_name' | 'by_hash';
  scope: 'mark' | 'exclude' | 'plain';
  version: 'final_only' | 'all' | 'latest_only';
}

export interface KbExtractConfig {
  settings: KbExtractSettings;
  options: Record<keyof KbExtractSettings, { value: string; label: string; note: string }[]>;
  keys: Record<keyof KbExtractSettings, string>;
}

/** 抽取预览：按当前口径算出"会入库多少、哪些被跳过、为什么"（不写库） */
export interface KbExtractPreview {
  total: number;
  willExtract: number;
  bytesToRead: number;
  walk: { dirs: number; skippedEntries: number; truncated: boolean };
  byDecision: Record<string, number>;
  byLayer: Record<string, number>;
  byVersion: Record<string, number>;
  byExt: Record<string, number>;
  settings: KbExtractSettings;
  samples: {
    relPath: string;
    size: number;
    docNo: string | null;
    scopeLayer: string;
    versionStatus: string;
    decision: 'extract' | 'dedup' | 'scope' | 'version' | 'kind';
    reason: string;
  }[];
}

/** 抽取任务进度（GET /api/kb/extract/:id） */
export interface KbExtractJob {
  job: {
    id: number;
    sourceId: number;
    status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
    total: number;
    done: number;
    failed: number;
    skipped: number;
    duplicates: number;
    chunks: number;
    embedded: number;
    current: string | null;
    message: string | null;
    startedAt: string;
    finishedAt: string | null;
  };
  settings: (KbExtractSettings & { embed?: boolean; ocr?: boolean }) | null;
  running: boolean;
  recent: { rel_path: string; result: string; reason: string | null }[];
  items: { rel_path: string; file_name: string | null; result: string; reason: string | null; scope_layer: string | null; version_status: string | null; chunks: number }[];
  failures: { rel_path: string; file_name: string | null; reason: string | null; size_bytes: number | null }[];
  byDecision: { result: string; n: number }[];
  elapsedMs: number;
}

/** 抽取结果自检（GET /api/kb/sources/:id/extract/result） */
export interface KbExtractResult {
  documents: number;
  chunks: number;
  embedded: number;
  chunksWithoutVector: number;
  chunksWithClausePath: number;
  duplicateHashGroups: number;
  byLayer: { scope_layer: string | null; n: number }[];
  byVersion: { version_status: string | null; n: number }[];
  sample: { rel_path: string | null; clause_path: string | null; excerpt: string }[];
  settings: KbExtractSettings;
}

/* ------------------------- B3-9 条款级引用 + 口径校验 ------------------------- */

/** 一处引用的位置（在哪：哪个变量的值里 / 模板正文里） */
export interface KbCitationWhere {
  kind: 'variable' | 'template';
  variable?: string | null;
  variableLabel?: string | null;
  templateId?: number | null;
  templateName?: string | null;
  excerpt?: string | null;
}

/** 引用解析结论：核对到条款 / 悬空 / 未入库 / 重名 / 引的是被替换的版本 */
export interface KbCitation {
  raw: string;
  documentName: string;
  docNoText: string | null;
  clauseText: string;
  clauseNo: number | null;
  subNo: number | null;
  where: KbCitationWhere;
  status: 'resolved' | 'clause_missing' | 'document_missing' | 'ambiguous' | 'superseded';
  hit: { title: string; docNo: string | null; clausePath: string | null; content: string; quote: string; versionStatus: string | null } | null;
  candidates: { documentId: number; title: string; docNo: string | null; versionStatus: string | null; decision: string | null; scopeLayer: string | null }[];
  availableClauses: string[];
  reason: string;
}

/** 一条口径校验问题：位置 + 依据 + 怎么改（绝不是笼统的"校验失败"） */
export interface KbComplianceIssue {
  code: string;
  name: string;
  severity: 'block' | 'warn' | 'info';
  /** 本次是否真的会拦下保存 */
  enforced: boolean;
  message: string;
  where: KbCitationWhere;
  evidence: {
    documentTitle?: string | null;
    docNo?: string | null;
    clausePath?: string | null;
    quote?: string | null;
    actual?: string | null;
    expected?: string | null;
    alsoAt?: { documentTitle?: string | null; docNo?: string | null; clausePath?: string | null; quote?: string | null; actual?: string | null } | null;
  };
  fixHint: string;
  citation?: { raw: string; documentTitle: string | null; docNo: string | null; clausePath: string | null } | null;
}

export interface KbComplianceResult {
  checkedAt: string;
  templateId: number | null;
  templateName: string | null;
  strictness: 'block' | 'warn';
  blocked: boolean;
  summary: string;
  rules: { code: string; name: string; severity: 'block' | 'warn' | 'info'; enabled: boolean; hasChecker: boolean; implemented: boolean; origin: string | null }[];
  citations: KbCitation[];
  issues: KbComplianceIssue[];
  /** 未求值：既不算通过、也不算不通过（必须单独显示，否则"没核对"会被当成"核对通过"） */
  unevaluated: { code: string; reason: string }[];
  exceptions: { code: string; reason: string }[];
  engineWarnings: string[];
  counts: { citations: number; resolved: number; block: number; warn: number; info: number; unevaluated: number };
}

export interface KbComplianceRule {
  id: number;
  code: string;
  name: string;
  severity: 'block' | 'warn' | 'info';
  kind: string;
  checker: string | null;
  params: Record<string, unknown>;
  message: string;
  fix_hint: string | null;
  enabled: boolean;
  implemented: boolean;
  hasChecker: boolean;
  sort_order: number;
  origin: string | null;
}

export interface KbComplianceConfig {
  strictness: 'block' | 'warn';
  strictnessOptions: { value: string; label: string; note: string }[];
  rules: KbComplianceRule[];
  keys: { strictness: string };
  note: string;
}

/** 条款级检索条目（带可直接插进文书的规范出处串 citeText） */
export interface KbClauseSearchItem {
  documentId: number;
  title: string;
  docNo: string | null;
  clausePath: string | null;
  clauseNo: number | null;
  content: string;
  quote: string;
  chunkId: number;
  citeText: string;
}

export interface KbClauseDocument {
  id: number;
  title: string;
  doc_no: string | null;
  scope_layer: string | null;
  version_status: string | null;
  decision: string | null;
  clause_count: number;
  file_name: string | null;
}

/* ------------------------- 项目信息（原「档案」） ------------------------- */
/**
 * 界面上一律叫「项目信息」。internal 表名仍是 archive_*，
 * 那是实现细节，不暴露给用户。
 */

export type ProjectFieldType = 'text' | 'longtext' | 'date' | 'money' | 'number' | 'percent' | 'enum';

export interface ProjectField {
  id: number;
  work_type_id: number | null;
  field_key: string;
  label: string;
  type: ProjectFieldType;
  required: number;
  example: string | null;
  hint: string | null;
  seed: number;
  origin: string;
  /** 该字段在不同工作类型下的称谓，JSON 数组字符串 */
  aliases_label: string | null;
  sort_order: number;
}

export interface ProjectInfoResponse {
  values: Record<string, string>;
  fields: ProjectField[];
  completeness: {
    total: number;
    filled: number;
    missingRequired: { field_key: string; label: string }[];
  };
}

/** 解析出的变量代入情况 */
export interface ResolvedVarInfo {
  name: string;
  value: string;
  from: 'system' | 'archive' | 'native' | 'mapped-empty' | 'unmapped';
  fieldKey?: string;
  via?: string;
}

export interface TemplateFieldItem extends TemplateVarSpec {
  /** 自动带出的值，空表示要手填 */
  preset?: string;
  source?: ResolvedVarInfo['from'];
  via?: string;
  fieldKey?: string;
}

export interface AiProposal {
  id: number;
  workbench_id: number | null;
  work_type_id: number | null;
  kind: 'field' | 'alias' | 'value';
  payload: { field_key?: string; label?: string; type?: string; var_name?: string; [k: string]: unknown };
  source: string | null;
  reason: string | null;
  status: string;
  batch_id: string | null;
  created_at: string;
}

/** 从资料里抽出来的一个项目信息字段值 */
export interface ExtractedValue {
  field_key: string;
  label: string;
  /** 模型抽到的值 */
  value: string;
  /** 项目信息里已有的值（有则界面让用户选保留哪个） */
  current?: string;
  /** 出处：来自资料的哪一部分 */
  source: string;
  confidence: 'high' | 'medium' | 'low';
  type: string;
}

export interface ExtractResult {
  ok: boolean;
  items: ExtractedValue[];
  /** 模型明确说资料里没有的字段 */
  notFound: string[];
  textInfo: { method: string; chars: number; truncated: boolean; ok: boolean; message?: string };
  usage: { prompt: number; output: number };
  model: string;
  summary?: string;
  error?: string;
  rawText?: string;
}

/* ------------------------- 模板变量覆盖率 ------------------------- */
/**
 * 「模板变量覆盖率」= 模板里的 {变量} 有多少能自动带出、不必每次手填或让模型写。
 *
 * **两个口径都要看，别只报一个**（两者差别极大）：
 *   · 加权（按出现次数）：percent / totalVars / mappedVars —— 一个变量在 5 份模板里出现算 5 次。
 *     反映「出文书时到底有多少处还得人管」，是头号数字。
 *   · 去重（按变量名）：distinct* —— 同一个名字跨模板只算 1 个。
 *     反映「还有多少个不同的名字等着补别名」。
 * 口径细节见后端 `packages/server/src/core/coverage.ts`：已映射 = 在「档案字段都填了」的
 * 前提下走一遍 resolveVariable 能取到非空值（与出文书同一个判定），不含工作台原生字段兜底。
 */
export interface CoverageRow {
  workTypeId: number | null;
  workTypeName: string;
  templateId: number;
  templateName: string;
  totalVars: number;
  mappedVars: number;
  unmapped: string[];
}

export interface CoverageWorkTypeRow {
  workTypeId: number | null;
  name: string;
  templates: number;
  totalVars: number;
  mappedVars: number;
  percent: number;
  distinctTotalVars: number;
  distinctMappedVars: number;
  distinctPercent: number;
}

export interface CoverageUnmappedVar {
  name: string;
  /** 出现次数（跨模板加权） */
  count: number;
  /** 前 8 个所在模板 */
  templates: { id: number; name: string }[];
  templateCount: number;
  workTypeIds: number[];
  /** unmapped = 完全没有映射；dangling = 有映射但取不到值（映射到别的工作类型的字段/已回收的字段） */
  reason: 'unmapped' | 'dangling';
  danglingFieldKeys: string[];
}

export interface CoverageNoise {
  pureNumber: { distinct: number; occurrences: number; mappedDistinct: number; mappedOccurrences: number };
  withDigits: { distinct: number; occurrences: number; mappedDistinct: number; mappedOccurrences: number };
  percentWithoutPureNumber: number;
  distinctPercentWithoutPureNumber: number;
  percentWithoutDigits: number;
  distinctPercentWithoutDigits: number;
}

export interface CoverageSummary {
  totalVars: number;
  mappedVars: number;
  percent: number;
  templates: number;
  fullyMapped: number;
  worst: CoverageRow[];
  byWorkType: CoverageWorkTypeRow[];
  distinct: { totalVars: number; mappedVars: number; percent: number; mappedEverywhere: number; mixed: string[] };
  distinctPercent: number;
  distinctTotalVars: number;
  distinctMappedVars: number;
  unmappedTop: CoverageUnmappedVar[];
  unmappedSummary: { distinctUnmapped: number; unmappedOccurrences: number; danglingDistinct: number };
  mappedBreakdown: { viaSystem: number; viaArchive: number; viaSystemSynonym: number; viaDirectKey: number };
  noise: CoverageNoise;
  /** 没进分母的模板（读不到变量清单 / 确实没有变量）——别让"少了几份模板"没人发现 */
  skipped: {
    unreadable: { id: number; name: string; reason: string }[];
    empty: { id: number; name: string }[];
  };
  scope: { includeArchived: boolean; workTypeId: number | null };
  generatedAt: string;
}

export interface CoverageUnmappedResponse {
  items: CoverageUnmappedVar[];
  /** 去重后一共多少个未映射变量名 */
  total: number;
  occurrences: number;
  dangling: number;
  scope: { includeArchived: boolean; workTypeId: number | null };
}

/** 一条「建议别名」：source 标明是规则猜的还是模型判的，confidence 是把握 */
export interface CoverageSuggestion {
  varName: string;
  fieldKey: string;
  label: string;
  source: 'rule' | 'ai';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  /** 模型覆盖了规则建议时，规则那条也带回来给人对比 */
  rule?: { fieldKey: string; label: string; confidence: 'high' | 'medium' | 'low'; reason: string } | null;
}

export interface CoverageSuggestResponse {
  /** 恒为 true：这个接口只给建议，一个字节都不写库 */
  dryRun: true;
  workTypeId: number | null;
  suggestions: CoverageSuggestion[];
  notSuggested: string[];
  candidateFields: number;
  ai: {
    attempted: boolean;
    ok: boolean;
    purpose: string;
    model?: string;
    error?: string;
    returned?: number;
    dropped?: string[];
    usage?: { prompt: number; output: number };
  };
}

export const coverageApi = {
  /** 覆盖率总览（含两种口径、分工作类型、最差模板、未映射 Top N） */
  summary: (opts: { workTypeId?: number | null; includeArchived?: boolean; top?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.workTypeId) qs.set('workTypeId', String(opts.workTypeId));
    if (opts.includeArchived) qs.set('includeArchived', '1');
    if (opts.top) qs.set('top', String(opts.top));
    const s = qs.toString();
    return api.get<CoverageSummary>(`/api/coverage${s ? `?${s}` : ''}`);
  },
  /** 未映射变量清单（行动清单） */
  unmapped: (opts: { workTypeId?: number | null; limit?: number; sort?: 'count' | 'name'; includeArchived?: boolean } = {}) => {
    const qs = new URLSearchParams({ sort: opts.sort ?? 'count', limit: String(opts.limit ?? 50) });
    if (opts.workTypeId) qs.set('workTypeId', String(opts.workTypeId));
    if (opts.includeArchived) qs.set('includeArchived', '1');
    return api.get<CoverageUnmappedResponse>(`/api/coverage/unmapped?${qs.toString()}`);
  },
  /**
   * 为若干未映射变量生成建议别名。
   * 不落库：用户确认后再调 `saveAlias`。模型没配/失败时后端自动降级为规则建议。
   */
  suggest: (
    vars: string[],
    opts: { workTypeId?: number | null; limit?: number; ai?: boolean } = {},
  ) =>
    api.post<CoverageSuggestResponse>('/api/coverage/suggest', {
      vars,
      workTypeId: opts.workTypeId ?? null,
      limit: opts.limit ?? 20,
      ai: opts.ai === false ? 0 : 1,
    }),
  /** 确认写入一条别名映射 —— 复用既有的别名写入接口（写库必须用户确认后走这里） */
  saveAlias: (varName: string, fieldKey: string, workTypeId?: number | null) =>
    api.post<{ id: number }>('/api/archive/aliases', {
      varName,
      fieldKey,
      workTypeId: workTypeId ?? null,
      note: '覆盖率看板确认写入',
    }),
};
