import {useWorkbenchCollection} from '../components/useWorkbenchCollection';
import {useNavigationGuard} from '../components/NavigationGuard';
import {ReferenceFolder} from '../components/ReferenceFolder';
import { TYPE_GROUPS } from '../work-type-navigation';
import {WorkDocuments} from '../components/WorkDocuments';
import { WorkExecution } from '../components/WorkExecution';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  folderApi,
  useApi,
  type Artifact,
  type BoundFolderInfo,
  type ChecklistItem,
  type PositionDocSummary,
  type PositionInstance,
  type PositionRule,
  type Template,
  type WorkType,
  type Workbench,
  type WorkbenchDetail,
} from '../api';
import { Bar, Button, Card, Empty, Field, Input, Loading, Modal, Select, Tag, Textarea, fmtSize, fmtTime, scheduleKind, scheduleText, statusKind, STATUS_TEXT, useAction, useToast } from '../ui';
import { ProjectInfoTab } from './ProjectInfo';
import { PeriodPanel as BusinessPeriodPanel } from './Periods';
import { ProjectReadiness } from '../components/WorkflowPanels';
import { GenerateModal } from './GenerateModal';
import { DocVersionsModal } from './DocVersions';
// B4-12 真·预览：文件行上的「预览」入口（组件自带弹窗状态，不改既有下载按钮）
import { FilePreviewButton } from '../components/FilePreview';
import type { RouteKey } from '../App';
import TimesheetsPage from './Timesheets';

export default function WorkbenchPage({ go, params }: { go: (k: RouteKey, p?: Record<string, string>) => void; params: Record<string, string> }) {
  if (params.task === 'timesheets') return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row">
        <Button onClick={() => go('workbench',params.id?{id:params.id,...params.periodId?{periodId:params.periodId}:{}}:undefined)}>← 返回所属工作</Button>
        <strong>部门工时</strong>
      </div>
      <TimesheetsPage workbenchId={params.id?Number(params.id):undefined} periodId={params.periodId?Number(params.periodId):undefined} runId={params.runId?Number(params.runId):undefined} initialMonth={params.month}/>
    </div>
  );
  const id = params.id ? Number(params.id) : undefined;
  return id ? <WorkbenchDetailView key={id} id={id} go={go} initialPeriodId={params.periodId}/> : <WorkbenchList go={go} autoCreate={params.create === '1'} />;
}

/* ============================== 列表 ============================== */

function WorkbenchList({ go, autoCreate }: { go: (k: RouteKey, p?: Record<string, string>) => void; autoCreate?: boolean }) {
  const toast=useToast(),types=useApi<{items:WorkType[]}>('/api/work-types');
  const [keyword,setKeyword]=useState(''),[group,setGroup]=useState(''),[filterType,setFilterType]=useState(''),[view,setView]=useState('active'),[page,setPage]=useState(0),[creating,setCreating]=useState(Boolean(autoCreate));
  const list=useWorkbenchCollection(view==='archived');
  useEffect(()=>{setPage(0);},[keyword,group,filterType,view]);
  const all=list.data?.items??[],byStatus=all.filter(w=>view==='archived'||(view==='done'?w.status==='done':!['done','archived'].includes(w.status)));
  const filtered=byStatus.filter(w=>(!group||types.data?.items.find(t=>t.id===w.work_type_id)?.navigation_group===group)&&(!filterType||w.work_type_id===Number(filterType))&&(!keyword||[w.name,w.code,w.counterpart].some(s=>s?.toLowerCase().includes(keyword.toLowerCase()))));
  const rows=filtered.slice(page*20,(page+1)*20);
  return <div className="section-content"><div className="page-toolbar"><div className="view-tabs">{[['active','在办'],['done','已结束'],['archived','已归档']].map(([v,label])=><button className={view===v?'selected':''} key={v} onClick={()=>setView(v)}>{label}</button>)}</div><Button kind="primary" onClick={()=>setCreating(true)}>＋ 新建工作</Button></div>
    <div className="row"><div className="view-tabs">{[{value:'',label:'全部'},...TYPE_GROUPS].map(g=><button key={g.value} className={group===g.value?'selected':''} onClick={()=>{setGroup(g.value);setFilterType('');}}>{g.label}</button>)}</div><div className="spacer"/><Input value={keyword} onChange={setKeyword} placeholder="搜索工作名称、编号、单位"/><Select value={filterType} onChange={setFilterType} placeholder="全部工作类型" options={(types.data?.items??[]).filter(t=>!group||t.navigation_group===group).map(t=>({value:String(t.id),label:t.name}))}/></div>
    <Card title={'工作列表 · '+filtered.length+' 项'}>
      {list.error?<div className="notice notice-err" role="alert">{list.error.message}<Button onClick={list.reload}>重试</Button></div>:list.loading?<Loading/>:!rows.length?<Empty text={keyword||group||filterType?'没有符合筛选条件的工作。':'当前视图还没有工作。'} action={<Button onClick={()=>{if(keyword||group||filterType){setKeyword('');setGroup('');setFilterType('');}else setCreating(true);}}>{keyword||group||filterType?'清除筛选':'新建工作'}</Button>}/>:<table className="table"><thead><tr><th>工作</th><th>分类 / 办理范围</th><th>下一步</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(w=><tr key={w.id}><td><a href={'#/workbench?id='+w.id}><strong>{w.name}</strong></a><div className="small muted">{w.code} · 更新 {fmtTime(w.updated_at)}</div></td><td>{TYPE_GROUPS.find(g=>g.value===types.data?.items.find(t=>t.id===w.work_type_id)?.navigation_group)?.label??'待确认分类'}<div className="small muted">{w.work_type_name} · {w.work_type_mode==='process'?'阶段 '+(w.position_done??0)+' / '+(w.position_total??0):w.period_frequency?'独立期次':'单次办理'}</div></td><td className="small">{w.period_due?'待办期次截止 '+w.period_due:'打开工作查看'}</td><td><Tag kind={statusKind(w.status)}>{w.status==='done'?'已结束':STATUS_TEXT[w.status]??w.status}</Tag></td><td><Button size="sm" onClick={()=>go('workbench',{id:String(w.id)})}>{view==='active'?'继续办理':'查看工作'}</Button></td></tr>)}</tbody></table>}
      <div className="row mt16"><span className="muted small">第 {page+1} 页 · 每页 20 项</span><div className="spacer"/><Button size="sm" disabled={!page} onClick={()=>setPage(p=>p-1)}>上一页</Button><Button size="sm" disabled={(page+1)*20>=filtered.length} onClick={()=>setPage(p=>p+1)}>下一页</Button></div>
    </Card>
    <CreateWorkbenchModal open={creating} types={types.data?.items??[]} onClose={()=>setCreating(false)} onCreated={wb=>{setCreating(false);toast('工作已创建','ok');go('workbench',{id:String(wb.id)});}}/>
  </div>;
}

/**
 * 模板多选清单。
 *
 * 建工作时先选好这份工作用哪几份模板 —— 因为一个工作类型下模板可能很多
 * （行政管理下既有清廉工程的表，也可能有别的），全列出来容易拿错。
 * 选定后「出文书」页只显示这几份；一份都不选则回退到该类型的全部模板。
 */
function TemplatePicker({
  templates,
  selected,
  onToggle,
  loading,
}: {
  templates: Template[];
  selected: number[];
  onToggle: (id: number) => void;
  loading?: boolean;
}) {
  const [q, setQ] = useState('');
  const kw = q.trim().toLowerCase();
  const shown = kw ? templates.filter((t) => t.name.toLowerCase().includes(kw)) : templates;

  if (loading) return <Loading text="读取模板…" />;

  return (
    <>
      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <Input value={q} onChange={setQ} placeholder="搜模板名…" />
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => shown.forEach((t) => { if (!selected.includes(t.id)) onToggle(t.id); })}
        >
          全选{kw ? '（筛选中）' : ''}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => shown.forEach((t) => { if (selected.includes(t.id)) onToggle(t.id); })}
        >
          清空
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="notice notice-warn">这个工作类型下还没有模板。可以先去「知识库 → 模板库」上传，之后再回来绑定。</div>
      ) : shown.length === 0 ? (
        <div className="muted small">没有匹配「{q}」的模板。</div>
      ) : (
        <div className="tpl-picker">
          {shown.map((t) => {
            const on = selected.includes(t.id);
            return (
              <label key={t.id} className={`tpl-pick${on ? ' on' : ''}`}>
                <input type="checkbox" className="check-box" checked={on} onChange={() => onToggle(t.id)} />
                <span className="tpl-pick-main">
                  <span className="tpl-pick-name">{t.name}</span>
                  <span className="muted small">
                    {t.file_format} · {t.variable_count} 个变量
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      )}

      <div className="small muted" style={{ marginTop: 8 }}>
        已选 <strong>{selected.length}</strong> 份
        {selected.length === 0 && '　（可暂不选择，进入工作后再添加）'}
      </div>
    </>
  );
}

/**
 * 新建工作。
 *
 * 先选择行政管理或项目入口；项目在同一窗口中按导航分类选择具体类型。
 * 阶段、周期和办理方式均由具体类型决定。
 *
 * 第二步里还要选模板：这份工作到底用哪几份单据。选好之后「出文书」页只列这些，
 * 免得一个工作类型下模板一多就分不清该用哪个。
 */
function CreateWorkbenchModal({
  open,
  types,
  onClose,
  onCreated,
}: {
  open: boolean;
  types: WorkType[];
  onClose: () => void;
  onCreated: (wb: Workbench) => void;
}) {
  /** 第一段：先定这是哪一类工作 */
  const [kind, setKind] = useState<'admin' | 'project' | null>(null);
  /** 第二段：项目类再选具体类型 */
  const [workTypeId, setWorkTypeId] = useState('');
  const [projectGroup, setProjectGroup] = useState('');
  const [pendingSwitch,setPendingSwitch] = useState<{id:string;group:string;back?:boolean}|null>(null);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [counterpart, setCounterpart] = useState('');
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [planEndDate, setPlanEndDate] = useState('');
  const [summary, setSummary] = useState('');
  const [historical,setHistorical]=useState(false),[actualEndDate,setActualEndDate]=useState('');
  /** 行政管理工作专属：周期 */
  const [recurrence, setRecurrence] = useState<'once' | 'monthly' | 'quarterly' | 'yearly'>('monthly');
  const [recurDay, setRecurDay] = useState('5');
  const [recurMonth, setRecurMonth] = useState('1');
  const [remindDays, setRemindDays] = useState('3');
  /** 这份工作要用哪几份模板 */
  const [pickedTemplates, setPickedTemplates] = useState<number[]>([]);
  const { busy, run } = useAction();

  const adminTypes = types.filter((t) => t.domain === 'admin' && t.navigation_group === 'administration' && !t.archived_at && !['temporary-task','integrity-temporary'].includes(t.code));
  const projectTypes = types.filter((t) => t.domain === 'project' && !t.archived_at);
  const adminType = adminTypes[0];
  const availableTypes = kind==='admin'?adminTypes:kind==='project'?projectTypes.filter(t=>t.navigation_group===projectGroup):[];
  const firstTypeId=availableTypes[0]?.id;
  useEffect(()=>{if(open && !availableTypes.some(t=>String(t.id)===workTypeId)){setWorkTypeId(firstTypeId && (kind==='admin'||availableTypes.length===1)?String(firstTypeId):'');setPickedTemplates([]);}},[open,kind,projectGroup,workTypeId,firstTypeId,availableTypes.length]);
  const effectiveTypeId = availableTypes.some(t=>String(t.id)===workTypeId)?Number(workTypeId):null;
  const selected = types.find((t) => t.id === effectiveTypeId);
  const isRecurring = kind === 'admin' && selected?.mode!=='process' && recurrence !== 'once';

  // 选定工作类型后，拉该类型下的模板供勾选
  const tplList = useApi<{ items: Template[] }>(
    effectiveTypeId ? `/api/templates?workTypeId=${effectiveTypeId}` : null,
    [effectiveTypeId],
  );
  const applyType = (id: string, group: string, back = false) => {
    setProjectGroup(group); setWorkTypeId(id); setPickedTemplates([]);
    setRecurrence('monthly'); setRecurDay('5'); setRecurMonth('1'); setRemindDays('3');
    setPendingSwitch(null); if(back)setKind(null);
  };
  const changeType = (id: string, group = projectGroup, back = false) => {
    if ((id !== workTypeId || group !== projectGroup || back) && pickedTemplates.length) {setPendingSwitch({id,group,back});return;}
    applyType(id,group,back);
  };

  const reset = () => {
    setKind(null); setProjectGroup(''); setWorkTypeId(''); setName(''); setCode('');setHistorical(false);setActualEndDate('');
    setCounterpart(''); setPlanEndDate(''); setSummary('');
    setRecurrence('monthly'); setRecurDay('5'); setRecurMonth('1'); setRemindDays('3');
    setPickedTemplates([]);
    setPendingSwitch(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const toggleTemplate = (id: number) =>
    setPickedTemplates((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = () => {
    if (!effectiveTypeId || !canSubmit) return;
    void run(async () => {
      const wb = await api.post<Workbench>('/api/workbenches', {
        domain: kind, navigationGroup: kind==='project'?projectGroup:'administration',
        name: name.trim(),
        historical: kind==='project'&&historical, actualEndDate: historical?actualEndDate:undefined,
        workTypeId: effectiveTypeId,
        code: code.trim() || undefined,
        counterpart: kind === 'project' ? counterpart.trim() || undefined : undefined,
        startDate,
        planEndDate: kind === 'project' && planEndDate ? planEndDate : undefined,
        summary: summary.trim() || undefined,
        recurrence: 'once',
        periodRule: isRecurring && !selected?.period_defaults ? {frequency:recurrence,due_day:Number(recurDay),due_month_offset:0,remind_days:Number(remindDays),requirements:[]} : undefined,
        recurDay: isRecurring ? Number(recurDay) : undefined,
        recurMonth: recurrence === 'yearly' ? Number(recurMonth) : undefined,
        remindDays: isRecurring ? Number(remindDays) : undefined,
        templateIds: pickedTemplates,
      });
      reset();
      onCreated(wb);
    });
  };

  const canSubmit = Boolean(effectiveTypeId) && name.trim().length > 0 && kind !== null && !pendingSwitch && !tplList.loading && !tplList.error && pickedTemplates.every(id=>tplList.data?.items.some(t=>t.id===id));

  return (
    <Modal
      open={open}
      wide
      title={kind === null ? '新建工作 —— 先选工作性质' : kind === 'admin' ? '新建行政管理工作' : '新建项目工作'}
      onClose={close}
      footer={
        <>
          {kind !== null && (
            <Button onClick={() => changeType('','',true)} style={{ marginRight: 'auto' }}>
              上一步
            </Button>
          )}
          <Button onClick={close}>取消</Button>
          <Button kind="primary" onClick={submit} disabled={busy || !canSubmit}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </>
      }
    >
      {pendingSwitch && <div className="notice notice-warn"><p>切换将清除已选的 {pickedTemplates.length} 份模板。名称、甲方等基础信息会保留。</p><div className="row"><Button onClick={()=>setPendingSwitch(null)}>保留当前选择</Button><Button kind="primary" onClick={()=>applyType(pendingSwitch.id,pendingSwitch.group,!!pendingSwitch.back)}>确认切换</Button></div></div>}
      {tplList.error && kind && <div className="notice notice-warn">模板加载失败：{tplList.error.message} <Button size="sm" onClick={tplList.reload}>重试</Button></div>}
      {/* ---------------- 第一段：选性质 ---------------- */}
      {kind === null && (
        <div className="col" style={{ gap: 12 }}>
          <p className="muted small" style={{ margin: 0 }}>
            周期和专项工作在此新建。普通单次事项请使用“工作记录”，旧工作及文件继续保留。
          </p>
          <button
            className="pick-card"
            onClick={() => {setKind('admin');setWorkTypeId('');setPickedTemplates([]);}}
            disabled={!adminType}
            type="button"
          >
            <div className="pick-title">行政管理工作</div>
            <div className="pick-desc">
              办理安全例会、清廉工程、部门工时及临时事务。
              {!adminType && <span style={{ color: 'var(--err)' }}>（还没有行政管理工作类型）</span>}
            </div>
          </button>
          <button
            className="pick-card"
            onClick={() => {setKind('project');setWorkTypeId('');setPickedTemplates([]);}}
            disabled={projectTypes.length === 0}
            type="button"
          >
            <div className="pick-title">项目工作</div>
            <div className="pick-desc">
              管理信息化项目或工程项目，按具体类型加载适用流程。
              {projectTypes.length === 0 && <span style={{ color: 'var(--err)' }}>（还没有项目类型）</span>}
            </div>
          </button>
        </div>
      )}

      {/* ---------------- 第二段：行政管理工作 ---------------- */}
      {kind === 'admin' && (
        <>
          <Field label="工作类型" required><Select value={workTypeId} onChange={v=>changeType(v)} options={adminTypes.map(t=>({value:String(t.id),label:`${t.category} · ${t.display_name}（${t.mode==='process'?'阶段办理':'文书 / 事务'}）`}))}/></Field>
          {selected?.mode==='process' && <p>将按此类型创建阶段及材料要求。本工作不使用独立期次。</p>}
          <Field label="工作名称" required hint="例如「清廉工程月度监督检查」「工时表」">
            <Input value={name} onChange={setName} placeholder="例如：清廉工程月度监督检查" />
          </Field>

          {selected?.mode!=='process' && !selected?.period_defaults && <Field
            label="频率"
            required
            hint={
              recurrence === 'once'
                ? '单次工作：做完后直接归档结束'
                : '持续工作：每到这个时间就会在首页提醒你填一份'
            }
          >
            <Select
              value={recurrence}
              onChange={(v) => setRecurrence(v as typeof recurrence)}
              options={[
                { value: 'monthly', label: '每月一次' },
                { value: 'quarterly', label: '每季度一次' },
                { value: 'yearly', label: '每年一次' },
              ]}
            />
          </Field>}

          {selected?.period_defaults && <p>将继承类型的周期、材料与提醒默认设置，可在工作中调整后续期次。</p>}
          {isRecurring && !selected?.period_defaults && (
            <div className="inline-fields">
              {recurrence === 'yearly' && (
                <Field label="月份">
                  <Select
                    value={recurMonth}
                    onChange={setRecurMonth}
                    options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 月` }))}
                  />
                </Field>
              )}
              <Field label="日号" hint="1–31；当月没有该日期时，按当月最后一天到期">
                <Select
                  value={recurDay}
                  onChange={setRecurDay}
                  options={Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: `${i + 1} 号` }))}
                />
              </Field>
              <Field label="提前几天提醒" hint="到点前几天开始在首页提醒">
                <Select
                  value={remindDays}
                  onChange={setRemindDays}
                  options={[0, 1, 2, 3, 5, 7, 10].map((n) => ({ value: String(n), label: n === 0 ? '当天才提醒' : `提前 ${n} 天` }))}
                />
              </Field>
            </div>
          )}

          <Field label="编号" hint="留空自动生成">
            <Input value={code} onChange={setCode} placeholder="自动" />
          </Field>

          <Field
            label="这份工作用哪些模板"
            hint="选好后「出文书」页只列这几份，不会和同类型下别的模板混在一起。可多选。"
          >
            <TemplatePicker
              templates={tplList.data?.items ?? []}
              selected={pickedTemplates}
              onToggle={toggleTemplate}
              loading={tplList.loading}
            />
          </Field>

          <Field label="说明">
            <Textarea value={summary} onChange={setSummary} rows={2} placeholder="这项工作的内容、依据、注意事项…" />
          </Field>

          <div className="notice notice-info">
            {selected?.mode==='process'?'将创建阶段和材料清单，按实际办理进度推进。':selected?.period_defaults?'将按类型默认周期创建独立期次；各期资料与成果分别保存。':recurrence === 'once'
              ? '单次工作不会有周期提醒。做完后在详情页点「完成归档」即可结束。'
              : `创建后，每到${
                  recurrence === 'monthly' ? '每月' : recurrence === 'quarterly' ? '每季度首月' : `每年 ${recurMonth} 月`
                } ${recurDay} 号前 ${remindDays} 天，首页会提醒你填这一期的内容。`}
          </div>
        </>
      )}

      {kind === 'project' && (
        <>
          <Field label="项目分类" required>
            <Select value={projectGroup} placeholder="请选择项目分类" options={TYPE_GROUPS.filter(g=>g.value!=='administration')} onChange={v=>changeType('',v)} />
          </Field>
          <Field label="具体项目类型" required hint={!projectGroup?'请先选择项目分类':availableTypes.length===1?'该分类仅有一个可选类型，已自动选中。':'按用途选择，阶段数量仅供参考。'}>
            <Select
              value={workTypeId}
              disabled={!projectGroup || !availableTypes.length}
              placeholder={projectGroup && !availableTypes.length?'该分类暂无可用类型':'请选择具体项目类型'}
              onChange={v=>changeType(v)}
              options={availableTypes.map((t) => ({
                value: String(t.id),
                label: t.display_name,
              }))}
            />
          </Field>
          {projectTypes.some(t=>!t.navigation_group) && <p className="small muted">有类型尚待确认归属，可在「流程规范」中查看和确认。</p>}
          {selected && <>
          <div className="notice notice-info"><strong>已选：{selected.display_name}</strong><div>{selected.usage_hint}</div><span className="small muted">{selected.position_count} 个阶段 · 保留此类型原有流程与适用模板</span></div>
          <label><input type="checkbox" checked={historical} onChange={e=>setHistorical(e.target.checked)}/> 补录已结束项目，后续整理历史资料</label>
          {historical && <Field label="实际结束日期（不确定可留空待核对）"><Input type="date" value={actualEndDate} onChange={setActualEndDate}/></Field>}
          <Field label="项目名称" required>
            <Input value={name} onChange={setName} placeholder="例如：某局机房设备改造项目" />
          </Field>
          <div className="inline-fields">
            <Field label="编号" hint="留空自动生成">
              <Input value={code} onChange={setCode} placeholder="自动" />
            </Field>
            <Field label="对接单位 / 甲方">
              <Input value={counterpart} onChange={setCounterpart} />
            </Field>
          </div>
          <div className="inline-fields">
            <Field label="开始日期">
              <Input value={startDate} onChange={setStartDate} type="date" />
            </Field>
            <Field label="计划完工">
              <Input value={planEndDate} onChange={setPlanEndDate} type="date" />
            </Field>
          </div>
          <Field
            label="额外挂哪些模板（可选）"
            hint="项目的单据已经按阶段绑好了，不选也能用。只有需要额外挂几份通用件（合同、汇报、通知）时才勾。"
          >
            <TemplatePicker
              templates={tplList.data?.items ?? []}
              selected={pickedTemplates}
              onToggle={toggleTemplate}
              loading={tplList.loading}
            />
          </Field>
          <Field label="备注">
            <Textarea value={summary} onChange={setSummary} rows={2} />
          </Field>
          <div className="notice notice-info">
            创建后会按「{selected?.display_name}」的流程模板，自动建好 {selected?.position_count ?? 0} 个阶段目录，
            并把每阶段的材料清单、影像清单生成为可勾选的待办。
          </div>
          </>}
        </>
      )}
    </Modal>
  );
}

/* ============================== 详情 ============================== */

type TabKey = 'flow' | 'materials' | 'evidence' | 'files' | 'info' | 'templates';

function WorkbenchDetailView({ id, go,initialPeriodId }: { id: number; go: (k: RouteKey, p?: Record<string, string>) => void;initialPeriodId?:string }) {
  const navigation=useNavigationGuard();
  const toast = useToast();
  const { busy, run } = useAction();
  const detail = useApi<WorkbenchDetail>(`/api/workbenches/${id}`);
  const periods = useApi<{ rule: unknown | null; items: {status:string}[] }>(`/api/workbenches/${id}/periods`);
  const periodEnabled = !!periods.data?.rule;
  const [selectedPeriod,setSelectedPeriod]=useState(initialPeriodId);
  useEffect(()=>setSelectedPeriod(initialPeriodId),[id,initialPeriodId]);
  /** 文书驱动（行政管理）默认落在「出文书」页；流程驱动默认落在「流程与清单」 */
  const [tab, setTab] = useState<TabKey | null>(null);
  const [businessContent,setBusinessContent]=useState('');
  const workTemplates=useApi<{items:(Template&{required?:boolean})[]}>(`/api/workbenches/${id}/templates`);
  useEffect(()=>{if(detail.data)setBusinessContent((detail.data.workbench as Workbench&{business_content:string}).business_content??'');},[detail.data?.workbench.id]);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** 正在出的那份文书 —— 出文书是这个工作里的一个动作，不是独立页面 */
  const [generating, setGenerating] = useState<{ templateId: number; templateName?: string; positionCode?: string | null } | null>(null);

  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error) return <div className="notice notice-err">加载失败：{detail.error.message}</div>;
  const d = detail.data;
  if (!d) return null;

  const { workbench: wb, stats } = d;
  const isDocMode = d.workType?.mode === 'document';
  /**
   * 当前页签。行政管理工作只有「出文书 / 文件」两个页签，
   * 所以用户若停在别处（如项目特有的「项目信息」）要落回默认页，否则会显示空白。
   */
  const allowedTabs: TabKey[] = isDocMode ? ['templates', 'files'] : d.workType?.domain==='project'?['flow', 'materials', 'evidence', 'files', 'info']:['flow','materials','evidence','files'];
  const activeTab: TabKey =
    tab && allowedTabs.includes(tab) ? tab : isDocMode ? 'templates' : 'flow';
  const allItems = d.positions.flatMap((p) => p.checklist);
  const materials = allItems.filter((c) => c.kind === 'material');
  const evidences = allItems.filter((c) => c.kind === 'evidence');
  const sched = wb.schedule;
  const openGenerate = (templateId: number, templateName?: string, positionCode?: string | null) =>
    setGenerating({ templateId, templateName, positionCode });

  /** 周期工作完成的是「这一期」，单次/项目工作完成的是整件事 —— 按钮文案要分开 */
  const recurring = Boolean(sched?.recurring);
  const doneLabel = recurring ? '完成本期' : '完成工作';

  const doComplete = () =>
    run(async () => {
      const r = await api.post<{ status: string; nextDue: string | null }>(`/api/workbenches/${wb.id}/complete`);
      detail.reload();
      toast(
        r.nextDue ? `本期已完成，下一期 ${r.nextDue}` : '已完成，这份工作结束了',
        'ok',
      );
    });

  /**
   * 归档 / 取消归档。
   *
   * 删除对话框里一直写着"如果只是想让它从列表里消失、以后还能查，用「归档」而不是删除"，
   * 但界面上**根本没有归档按钮**（后端接口也一直没人调用）。这条把话说圆：
   * 归档会写 archived_at，列表按它过滤，所以点完就从列表消失、数据都还在。
   */
  const doArchive = (next: boolean) =>
    run(async () => {
      await api.post(`/api/workbenches/${wb.id}/archive${next ? '' : '?undo=1'}`);
      detail.reload();
      toast(next ? '已归档：从列表里收起来了，数据都还在' : '已取消归档，回到列表', 'ok');
    });

  return (
    <div className="col" style={{ gap: 14 }}>
      <Card className={`work-detail-heading${periodEnabled?' periodic-heading':''}`} title={<span><a onClick={()=>go('workbench')}>我的工作台</a> / {wb.name}</span>} extra={<><Tag>{d.workType?.name}</Tag><Tag kind={statusKind(wb.status)}>{STATUS_TEXT[wb.status]??wb.status}</Tag></>}>
        <p>{periodEnabled?'选择期次，填写本期内容并生成文书':isDocMode?'填写业务内容，选择模板生成文书':`当前阶段：${d.positions.find(p=>p.status==='doing')?.name??d.positions.find(p=>p.status!=='done')?.name??'阶段已完成'}`}</p>
        <div className="row small muted"><span>{wb.code}</span><span>已有文件 {stats.artifactCount} 份</span></div>
      </Card>
      {periodEnabled ? <BusinessPeriodPanel timesheet={d.workType?.executor==='timesheet'} workTypeId={wb.work_type_id} workTypeCode={d.workType?.code} workbenchId={id} initialPeriodId={selectedPeriod} onPeriodSelected={setSelectedPeriod} onRuleChanged={()=>{periods.reload();detail.reload();}}/> : !periods.loading && <details open={isDocMode} className="work-documents-panel"><summary>通用业务内容与文书</summary><WorkDocuments workbenchId={id} workTypeId={wb.work_type_id} content={businessContent} onContentChange={setBusinessContent} onSaveContent={async()=>{await api.put(`/api/workbenches/${id}`,{businessContent});}} templates={workTemplates.data?.items??[]} disabled={wb.status==='archived'} onChanged={()=>{workTemplates.reload();detail.reload();}}/></details>}
      {/*
        行政管理是「文书驱动」：这份工作的内容就是填那几张表，
        所以不设页签、不加「出文书」这一层 —— 要交什么、填了几项，直接铺在页面上。
        项目工作是「流程驱动」，阶段/材料/影像/文件是四件不同的事，保留页签。
      */}
      {!isDocMode && (
        <>
          <div className="row" style={{ gap: 8 }}>
            {(
              [
                ['flow', `流程与清单（${d.positions.length} 阶段）`],
                ['materials', `材料清单（${stats.materialDone}/${stats.materialTotal}）`],
                ['evidence', `影像证据（${stats.evidenceDone}/${stats.evidenceTotal}）`],
                ['files', `文件（${stats.artifactCount}）`],
                ...(d.workType?.domain==='project'?[["info","项目信息"] as [TabKey,string]]:[]),
              ] as [TabKey, string][]
            ).map(([k, label]) => (
              <button key={k} className={`btn${activeTab === k ? ' btn-primary' : ''}`} onClick={() => navigation.request(()=>setTab(k))}>
                {label}
              </button>
            ))}
          </div>

          {activeTab === 'flow' && <FlowTab detail={d} onChanged={detail.reload} onGenerate={openGenerate} />}
          {activeTab === 'materials' && <MaterialsTab materials={materials} detail={d} onChanged={detail.reload} go={go} />}
          {activeTab === 'evidence' && <EvidenceTab evidences={evidences} detail={d} onChanged={detail.reload} />}
          {activeTab === 'files' && <FilesTab workbenchId={id} positions={d.positions} onChanged={detail.reload} />}
          {activeTab === 'info' && <ProjectInfoTab key={id} workbenchId={id} workTypeId={wb.work_type_id} />}
        </>
      )}

      <details className="secondary-panel"><summary>工作设置与归档</summary>
        <div className="col mt12">
          <div className="row">
            <Button size="sm" onClick={()=>setEditing(true)}>编辑工作资料</Button>
            {!periodEnabled&&<Button size="sm" disabled={busy||wb.status==='done'} onClick={doComplete}>完成工作</Button>}
            {periodEnabled&&<Button size="sm" disabled={busy||wb.status==='done'} onClick={()=>void run(async()=>{await api.post(`/api/workbenches/${id}/close-series`);periods.reload();detail.reload();})}>结束整个周期工作</Button>}
            <Button size="sm" disabled={busy} onClick={()=>doArchive(wb.status!=='archived')}>{wb.status==='archived'?'取消归档':'收起 / 归档'}</Button>
            <Button size="sm" kind="danger" onClick={()=>setDeleting(true)}>移入回收站</Button>
          </div>
          <ReferenceFolder id={id}/><details><summary>高级输出目录（写入位置）</summary><BoundFolderCard detail={d} onChanged={detail.reload}/></details>
          <WorkExecution id={id} positions={d.positions} project={d.workType?.domain==='project'} onChanged={detail.reload}/>
          {isDocMode&&!periodEnabled&&<FilesTab workbenchId={id} positions={d.positions} onChanged={detail.reload}/>}
          {d.positions.length>0&&<ProjectReadiness workbenchId={id} onChanged={detail.reload}/>}
        </div>
      </details>
      {generating && (
        <GenerateModal
          templateId={generating.templateId}
          templateName={generating.templateName}
          workbenchId={id}
          positionCode={generating.positionCode ?? null}
          onClose={() => setGenerating(null)}
          onSaved={() => detail.reload()}
        />
      )}

      {editing && (
        <EditWorkbenchModal
          wb={wb}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            detail.reload();
            toast('已保存', 'ok');
          }}
        />
      )}

      {deleting && (
        <DeleteWorkbenchModal
          wb={wb}
          onClose={() => setDeleting(false)}
          onDeleted={() => {
            // 成功提示由弹窗根据后端返回的 message 统一给出（含"移到回收站/彻底删除"两种口径与各项计数），
            // 这里不再叠一条，否则一次删除会弹两条 ok。
            go('workbench');
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ 资料目录（目录绑定 S5） ------------------------------ */

/**
 * 「资料目录」卡片（契约 §8 第一步）。
 *
 * 解决的问题是「文件到底在哪」：绑定之前文件放在平台自己的数据目录里，用户根本找不到；
 * 绑定之后，生成与上传的文件直接落到他自己的文件夹，和他手工整理的文件放在一起（契约 §4）。
 *
 * 四种状态各有各的说法：
 *   ① 未绑定        —— 说明文件现在在哪 + 输入框 + 「绑定文件夹」
 *   ② 已绑定且可达  —— 完整路径（可复制）+ 文件数/子目录数/总大小 + 统计/打开/解绑
 *   ③ 已绑定不可达  —— 明说「绑定的目录不在了：<路径>」，并把改绑入口放在旁边
 *   ④ 解绑确认      —— 二次确认，文案写明「只解除绑定，不会删除或移动任何文件」
 *
 * 这里**没有任何文件操作**：绑定/解绑都只调后端的 /bind-folder 接口（后端只写
 * `workbench.external_root` 这一列）；「在资源管理器中打开」是把路径交给后端去唤起
 * 资源管理器，平台自己不读、不写、不搬。
 */

/**
 * 「平台文件放哪里」的三个选项（契约 §4）—— 取值与后端 `setWorkbenchOutputMode` 的白名单一一对应，
 * 界面不自己编值，也不自己判断合法性（合法的判断只有后端一处）。
 */
const OUTPUT_MODE_CHOICES: { value: string; label: string; desc: string }[] = [
  {
    value: 'inline',
    label: '就地（推荐）',
    desc: '文件直接放在阶段目录里（如 1.安全生产例会\\2026\\10月\\）',
  },
  {
    value: 'subdir',
    label: '平台子目录',
    desc: '放在阶段目录下的 _生成文书 / _影像证据 / _原始资料 里',
  },
  {
    value: 'custom',
    label: '自定义目录',
    desc: '三类文件都放进指定的那个目录里',
  },
];

/** 保存成功后的提示文案：把后端归一后的模式翻成中文，不认识的值就原样显示 */
const OUTPUT_MODE_TEXT: Record<string, string> = {
  inline: '就地（文件直接放在阶段目录里）',
  subdir: '平台子目录（_生成文书 / _影像证据 / _原始资料）',
  custom: '自定义目录',
};

function BoundFolderCard({ detail, onChanged }: { detail: WorkbenchDetail; onChanged: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const wb = detail.workbench;
  /** 文件数这类统计只有 /bound-folder 给；「刷新统计」就是重新拉一次它 */
  const info = useApi<BoundFolderInfo>(`/api/workbenches/${wb.id}/bound-folder`, [wb.external_root]);
  const [path, setPath] = useState('');
  const [confirming, setConfirming] = useState(false);

  const bound = (info.data?.externalRoot ?? wb.external_root ?? '').trim() || null;
  const reachable = Boolean(bound) && info.data?.exists === true && info.data?.isDir === true;
  /** 统计回来了才敢下「目录不在了」这个结论 —— 否则刚打开会先闪一下红标签 */
  const checked = Boolean(info.data);
  const broken = Boolean(bound) && checked && !reachable;
  /** 单次工作没有期次概念，「本期文件将落在」只对周期工作显示 */
  const recurring = Boolean(wb.recurrence && wb.recurrence !== 'once');
  /** 输出位置模式（契约 §4）：NULL / 缺列都视作 inline（就地） */
  const outputMode = (wb.output_mode ?? 'inline').trim() || 'inline';
  const periodStages = detail.positions.filter((p) => (p.period_dir_name ?? '').trim());
  /**
   * 输出位置控件的草稿：用户点了但还没保存时显示草稿值；保存成功后父层 `detail.reload()`
   * 会把 wb 换成后端真实值，下面这个 effect 再把草稿对齐回去（失败时草稿保留，方便改了重试）。
   */
  const [modeDraft, setModeDraft] = useState(outputMode);
  const [customDraft, setCustomDraft] = useState((wb.custom_output_dir ?? '').trim());
  useEffect(() => {
    setModeDraft(outputMode);
    setCustomDraft((wb.custom_output_dir ?? '').trim());
  }, [outputMode, wb.custom_output_dir]);

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      toast('路径已复制', 'ok');
    } catch {
      toast('复制失败：请手动选中路径复制', 'err');
    }
  };

  /**
   * 阶段目录是懒创建的 —— 还没写进过文件，目录就不存在，后端会回
   * 「400 目录不存在：<path>」。这属于正常状态而不是故障，转成 info 提示；
   * 其余错误（权限、盘符不可达等）仍然原样抛出，由 run() 统一 toast。
   */
  const openFolderInExplorer = (abs: string) =>
    run(async () => {
      try {
        await folderApi.open(abs);
      } catch (e) {
        const msg = (e as { message?: string })?.message ?? '';
        if (msg.includes('目录不存在')) {
          toast('该阶段还没写过文件，目录还没创建；写一次文件后就能打开', 'info');
          return;
        }
        throw e;
      }
      toast('已在资源管理器中打开', 'ok');
    });

  const doBind = () =>
    run(async () => {
      const p = path.trim();
      if (!p) {
        toast('请先填入要绑定的文件夹完整路径（如 D:\\工作\\2.安全）', 'err');
        return;
      }
      /**
       * 只预检「看起来就不是绝对路径」这一种，省掉一次白跑的请求；
       * 其余校验（存不存在、是不是盘根、是不是平台自己的目录、有没有绑给别的工作台）
       * 全部交给后端 —— 后端的中文提示写得很具体，原样抛给用户即可。
       */
      if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('\\\\') && !p.startsWith('/')) {
        toast(`路径必须是绝对路径（如 D:\\工作\\2.安全）：${p}`, 'err');
        return;
      }
      const r = await folderApi.bind(wb.id, p);
      setPath('');
      info.reload();
      onChanged();
      toast(`已绑定资料目录：${r.externalRoot ?? p}`, 'ok');
    });

  const doUnbind = () =>
    run(async () => {
      await folderApi.unbind(wb.id);
      setConfirming(false);
      info.reload();
      onChanged();
      toast('已解除绑定：文件一个都没动，仍在原来的文件夹里', 'ok');
    });

  /**
   * 保存输出位置模式：PUT /api/workbenches/:id/output-mode。
   *
   * 校验全在后端（模式白名单 + 自定义目录必须是绝对路径 + **必须在本工作台根之内**），
   * 这里不做本地预判：后端的中文提示写得很具体，失败时由 run() 原样 toast 出来。
   */
  const doSaveOutputMode = () =>
    run(async () => {
      /**
       * 只有选「自定义目录」时才带 customDir；其余两种模式不传 = 后端保留原来填的目录，
       * 这样在三种模式之间来回切换不会把已经填好的路径冲掉（后端 customDir 就是这个语义）。
       */
      const payload: { mode: string; customDir?: string } = { mode: modeDraft };
      if (modeDraft === 'custom') payload.customDir = customDraft.trim();
      const r = await api.put<{ output_mode: string; custom_output_dir: string | null }>(
        `/api/workbenches/${wb.id}/output-mode`,
        payload,
      );
      // onChanged 就是父层的 detail.reload()：重新拉详情，让控件显示后端归一后的真实值
      onChanged();
      toast(`输出位置已改为「${OUTPUT_MODE_TEXT[r.output_mode] ?? r.output_mode}」`, 'ok');
    });

  /** 模式改了没保存 —— 提示一下，避免用户以为点了就生效 */
  const outputModeDirty =
    modeDraft !== outputMode || (modeDraft === 'custom' && customDraft.trim() !== (wb.custom_output_dir ?? '').trim());

  return (
    <Card
      title="资料目录"
      collapsible defaultOpen={false}
      extra={
        bound ? (
          <>
            <Tag kind={!checked ? 'default' : reachable ? 'ok' : 'err'}>
              {!checked ? '检查中…' : reachable ? '可达' : '目录不在了'}
            </Tag>
            <Button size="sm" disabled={info.loading} onClick={() => info.reload()} title="重新数一遍文件数、子目录数与总大小">
              刷新统计
            </Button>
            <Button size="sm" disabled={busy || !reachable} onClick={() => openFolderInExplorer(bound)}>
              在资源管理器中打开
            </Button>
            <Button size="sm" kind="danger" onClick={() => setConfirming(true)}>
              解绑
            </Button>
          </>
        ) : (
          <span className="small muted">文件现在放在平台自己的目录里</span>
        )
      }
    >
      {!info.data && info.loading ? (
        <Loading />
      ) : !info.data && info.error ? (
        <div className="notice notice-err">读取资料目录状态失败：{info.error.message}</div>
      ) : !bound ? (
        /* ---------- ① 未绑定 ---------- */
        <>
          <div className="notice notice-info">
            这个工作台还没绑定资料目录，<strong>文件现在放在平台自己的目录里</strong>：
            <div className="mono small mt4 ellipsis" title={wb.root_abs}>
              {wb.root_abs}
            </div>
            绑一个你自己的文件夹（例如 D:\工作\2.安全）之后，生成与上传的文件会直接落在那里，
            和你手工整理的文件放在一起，不用再往外搬。
          </div>
          <Field
            label="要绑定的文件夹（完整路径）"
            hint="例如 D:\工作\2.安全。平台只在这个文件夹里读写本工作台的文件，你原有的文件不会被动。"
          >
            <Input value={path} onChange={setPath} placeholder="D:\工作\2.安全" onEnter={doBind} />
          </Field>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <Button kind="primary" disabled={busy} onClick={doBind}>
              绑定文件夹
            </Button>
            <span className="small muted">
              非绝对路径 / 不存在 / 盘根 / 平台自己的目录 / 已绑给别的工作台，都会被拒绝并说明原因。
            </span>
          </div>
        </>
      ) : (
        /* ---------- ②③ 已绑定（可达 / 不可达） ---------- */
        <>
          <dl className="kv">
            <dt>绑定的文件夹</dt>
            <dd>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span className="mono small ellipsis" style={{ flex: 1 }} title={bound}>
                  {bound}
                </span>
                <Button size="sm" kind="ghost" onClick={() => void copyText(bound)}>
                  复制
                </Button>
              </div>
            </dd>
            <dt>状态</dt>
            <dd>
              {!checked ? (
                <Tag>检查中…</Tag>
              ) : reachable ? (
                <Tag kind="ok">可达</Tag>
              ) : (
                <Tag kind="err">绑定目录不在了</Tag>
              )}
            </dd>
            <dt>里面的内容</dt>
            <dd className="small">
              {reachable
                ? `${info.data?.fileCount ?? 0} 个文件 · ${info.data?.dirCount ?? 0} 个子目录 · ${
                    (info.data?.totalBytes ?? 0) > 0 ? fmtSize(info.data?.totalBytes) : '0 B'
                  }`
                : '路径访问不到，统计不到（不代表文件没了）'}
            </dd>
          </dl>

          {broken && (
            <>
              <div className="notice notice-err mt12">
                <strong>{info.data?.message ?? `绑定的目录不在了：${bound}`}</strong>
                <div className="small mt4">
                  常见原因是文件夹被改名、被移走，或者移动硬盘 / 网盘还没挂上。这只是「这个路径现在访问不到」，
                  不是平台删了东西 —— 平台从不删除、也不移动绑定目录里已有的文件。
                </div>
              </div>
              <Field
                label="改绑到新的位置"
                hint="填文件夹的完整路径。绑定后新的文件落到新位置；旧目录里的文件原样留在原处。"
              >
                <Input value={path} onChange={setPath} placeholder="D:\工作\2.安全" onEnter={doBind} />
              </Field>
              <Button kind="primary" disabled={busy} onClick={doBind}>
                绑定文件夹
              </Button>
            </>
          )}
        </>
      )}

      {/* 平台文件放哪里（契约 §4）：三种输出位置模式，从界面直接切换 */}
      <div className="mt12">
        <div className="small muted">平台文件放哪里</div>
        {!bound && (
          <div className="notice notice-info mt4">
            绑定资料目录后才能切换（未绑定时平台文件仍放在平台自己的目录里）。
          </div>
        )}
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {OUTPUT_MODE_CHOICES.map((o) => (
            <Button
              key={o.value}
              size="sm"
              kind={modeDraft === o.value ? 'primary' : 'default'}
              disabled={!bound || busy}
              title={bound ? o.desc : '先绑定资料目录'}
              onClick={() => setModeDraft(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
        <div className="small muted mt4">{OUTPUT_MODE_CHOICES.find((o) => o.value === modeDraft)?.desc}</div>
        {modeDraft === 'custom' && (
          <div className="mt4">
            <Field
              label="自定义目录（完整路径）"
              hint={
                bound
                  ? '必须位于这个工作台的资料目录之内（例如 D:\\工作\\2.安全\\_outputs）—— 落在它外面的目录，文件入库后就定位不到了。'
                  : '先绑定资料目录：自定义目录必须在这个工作台的资料目录之内。'
              }
            >
              <Input
                value={customDraft}
                onChange={setCustomDraft}
                placeholder={bound ? `${bound}\\_outputs` : '先绑定资料目录'}
                disabled={!bound || busy}
                onEnter={doSaveOutputMode}
              />
            </Field>
          </div>
        )}
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <Button kind="primary" size="sm" disabled={!bound || busy} onClick={doSaveOutputMode}>
            保存输出位置
          </Button>
          <span className="small muted">
            {!bound
              ? '未绑定资料目录时不能改：这三种落点都是相对你自己的资料目录算的。'
              : outputModeDirty
                ? '改了还没保存 —— 点「保存输出位置」生效。'
                : '只影响以后落盘的文件；已经生成/上传的文件仍在原处，不会被搬动。'}
          </span>
        </div>
      </div>

      {/* 当前期次目录：用户必须能一眼看到"这一期的文件落在哪"（契约 §5 / §10.5） */}
      {recurring && (
        <div className="mt12">
          <div className="small muted">本期（{wb.due_period ?? '当期'}）文件将落在</div>
          {periodStages.length === 0 ? (
            <>
              <div className="mono small ellipsis" title={wb.root_abs}>
                {wb.root_abs}
              </div>
              <div className="small muted">
                {detail.positions.length === 0
                  ? '这份工作没有阶段（文书类工作），文件放在这个目录里。'
                  : '还没有阶段开启「按期次分目录」，文件按各阶段目录直接放在这个目录下。'}
                {!bound && '（还没绑定资料目录，这里是平台自己的数据目录；_生成文书 / _影像证据 / _原始资料 子目录也在其中。）'}
              </div>
            </>
          ) : (
            periodStages.map((p) => {
              const abs = p.folder_abs ?? p.stage_abs ?? wb.root_abs;
              return (
                <div key={p.id} className="row small" style={{ gap: 8, alignItems: 'center' }}>
                  <span className="muted nowrap">
                    {p.seq}. {p.name}
                  </span>
                  <span className="mono ellipsis" style={{ flex: 1 }} title={abs}>
                    {abs}
                  </span>
                  <Button size="sm" kind="ghost" disabled={busy} onClick={() => openFolderInExplorer(abs)}>
                    打开
                  </Button>
                </div>
              );
            })
          )}
          {/*
            输出位置模式（契约 §4）：按当前模式说清「实际落点」。
            这三个判断与后端 `workbenchOutputDirAbs` 的三条分支一一对应：
              inline —— 文书/资料就地放在上面的期次目录，影像多一层「照片」；
              subdir —— 三类各自进平台的下划线子目录；
              custom —— 三类都进那一个自定义目录（不分层）。
          */}
          {outputMode === 'inline' && (
            <div className="small muted">
              输出位置是「就地」：文书与资料直接放在上面列出的期次目录里（不开期次就是阶段目录本身），
              影像放在其下的「照片」子目录里。
            </div>
          )}
          {outputMode === 'subdir' && (
            <div className="small muted">
              输出位置是「平台子目录」：上面每个期次目录下再分三层 —— 文书 → _生成文书、影像 → _影像证据、
              资料 → _原始资料。
            </div>
          )}
          {outputMode === 'custom' && (
            <div className="small muted">
              输出位置是自定义目录（三类文件都直接落在这里，不再分层）：
              <span className="mono"> {wb.custom_output_dir ?? '（还没配置，保存时补上）'}</span>
            </div>
          )}
        </div>
      )}

      {/* ---------- ④ 解绑二次确认 ---------- */}
      {confirming && bound && (
        <Modal
          open
          title="解除资料目录绑定？"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <Button onClick={() => setConfirming(false)}>取消</Button>
              <Button kind="danger" disabled={busy} onClick={doUnbind}>
                {busy ? '解绑中…' : '确认解绑'}
              </Button>
            </>
          }
        >
          <div className="notice notice-warn">
            <strong>只解除绑定，不会删除或移动任何文件。</strong>
            <div className="small mt4">
              <span className="mono">{bound}</span> 里的文件和子文件夹一个都不会动；平台只是不再把新生成的文件
              放到那里，这个工作台回到「文件放在平台自己的目录里」的状态。
            </div>
          </div>
          <div className="small muted mt12">
            以后想继续用这个文件夹，再绑一次即可；已经生成、上传的文件仍在原处，不会丢。
          </div>
        </Modal>
      )}
    </Card>
  );
}

/* ------------------------------ 流程 ------------------------------ */

function FlowTab({
  detail,
  onChanged,
  onGenerate,
}: {
  detail: WorkbenchDetail;
  onChanged: () => void;
  onGenerate: (templateId: number, templateName?: string, positionCode?: string | null) => void;
}) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [openPos, setOpenPos] = useState<number | null>(detail.positions.find((p) => p.status === 'doing')?.id ?? detail.positions[0]?.id ?? null);

  const setStatus = (pos: PositionInstance, status: string) =>
    run(async () => {
      const note=status==='skipped'?window.prompt('请填写此阶段不适用的业务依据',pos.note??''):undefined;
      if(status==='skipped'&&!note?.trim())return;
      await api.put(`/api/positions/${pos.id}`, { status, note });
      onChanged();
      toast(`阶段「${pos.name}」→ ${STATUS_TEXT[status]}`, 'ok');
    });

  const toggle = (item: ChecklistItem) =>
    run(async () => {
      await api.put(`/api/checklist/${item.id}`, { status: item.status === 'done' ? 'todo' : 'done' });
      onChanged();
    });

  return (
    <Card title="项目阶段办理" extra={<span className="small muted">文件生成与阶段完成分别确认</span>}>
      <div className="stage-layout"><nav className="section-nav" aria-label="项目阶段">{detail.positions.map((p,i)=><button key={p.id} className={openPos===p.id?'selected':''} onClick={()=>setOpenPos(p.id)}><span>{i+1}. {p.name}</span><Tag kind={statusKind(p.status)}>{STATUS_TEXT[p.status]??p.status}</Tag></button>)}</nav>
      <div className="timeline">
        {detail.positions.filter(p=>p.id===openPos).map((p, idx) => {
          const done = p.checklist.filter((c) => isItemDone(c)).length;
          const open = openPos === p.id;
          return (
            <div className="step" key={p.id}>
              <div className="step-line">
                <div className={`step-dot ${p.status}`}>{p.status === 'done' ? '✓' : idx + 1}</div>
                {idx < detail.positions.length - 1 && <div className="step-connector" />}
              </div>
              <div className="step-main">
                <div className="row" style={{ gap: 10 }}>
                  <strong className="clickable" onClick={() => setOpenPos(p.id)}>
                    {p.name}
                  </strong>
                  <Tag kind={statusKind(p.status)}>{STATUS_TEXT[p.status] ?? p.status}</Tag>
                  <span className="small muted">
                    清单 {done}/{p.checklist.length}
                  </span>
                  {p.started_at && <span className="small muted">开始 {p.started_at.slice(0, 10)}</span>}
                  <div className="spacer" />
                  <StageGenerateButton
                    position={p}
                    workTypeId={detail.workbench.work_type_id}
                    workbenchId={detail.workbench.id}
                    doc={p.docSummary}
                    onGenerate={onGenerate}
                  />
                  <Select
                    value={p.status}
                    onChange={(v) => setStatus(p, v)}
                    options={[
                      { value: 'pending', label: '未开始' },
                      { value: 'doing', label: '进行中' },
                      { value: 'blocked', label: '受阻' },
                      { value: 'done', label: '已完成' },
                      { value: 'skipped', label: '不适用' },
                    ]}
                  />
                </div>
                {open && (
                  <div className="mt8 col" style={{ gap: 10 }}>
                    {/* 这个阶段的文件到底在哪（契约 §10.5：路径显示比任何日志都管用） */}
                    <div className="row small" style={{ gap: 8, alignItems: 'center' }}>
                      <span className="muted nowrap">{p.period_dir_name ? `本期文件落在（${p.period_dir_name}）` : '这个阶段的文件放在'}</span>
                      <span className="mono ellipsis" style={{ flex: 1 }} title={p.folder_abs ?? p.stage_abs}>
                        {p.folder_abs ?? p.stage_abs ?? '—'}
                      </span>
                      <Button
                        size="sm"
                        kind="ghost"
                        disabled={busy}
                        title="在资源管理器中打开这个目录"
                        onClick={() => {
                          const abs = p.folder_abs ?? p.stage_abs;
                          if (!abs) {
                            toast('这个阶段还没有目录信息', 'err');
                            return;
                          }
                          void run(async () => {
                            try {
                              await folderApi.open(abs);
                            } catch (e) {
                              const msg = (e as { message?: string })?.message ?? '';
                              if (msg.includes('目录不存在')) {
                                toast('该阶段还没写过文件，目录还没创建；写一次文件后就能打开', 'info');
                                return;
                              }
                              throw e;
                            }
                            toast('已在资源管理器中打开', 'ok');
                          });
                        }}
                      >
                        打开
                      </Button>
                    </div>
                    {p.checklist.length === 0 ? (
                      <div className="small muted">该阶段没有配置清单项。</div>
                    ) : (
                      <>
                        {p.checklist.filter((c) => c.kind === 'material').length > 0 && (
                          <div>
                            <div className="small muted mb8">需要准备 / 留存的材料</div>
                            <div className="check-list">
                              {p.checklist
                                .filter((c) => c.kind === 'material')
                                .map((c) => (
                                  <CheckRow key={c.id} item={c} onToggle={toggle} busy={busy} />
                                ))}
                            </div>
                          </div>
                        )}
                        {p.checklist.filter((c) => c.kind === 'evidence').length > 0 && (
                          <div>
                            <div className="small muted mb8">需要留存的影像证据（到「影像证据」页上传）</div>
                            <div className="check-list">
                              {p.checklist
                                .filter((c) => c.kind === 'evidence')
                                .map((c) => (
                                  <CheckRow key={c.id} item={c} onToggle={toggle} busy={busy} />
                                ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div></div>
    </Card>
  );
}

function isItemDone(c: ChecklistItem): boolean {
  return c.review_status==='verified' || (c.review_status==='na'&&!!c.review_note?.trim());
}

function CheckRow({ item, onToggle, busy }: { item: ChecklistItem; onToggle: (i: ChecklistItem) => void; busy: boolean }) {
  const done = isItemDone(item);
  return (
    <div className={`check-item${done ? ' done' : ''}${item.status === 'na' ? ' na' : ''}`}>
      <Tag kind={done?'ok':'warn'}>{done?'已核对':item.artifact_count?'待核对':'待提供'}</Tag>
      <div className="check-main">
        <div className="check-title">
          {item.title}
          {!item.required && <span className="small muted"> （非必需）</span>}
          {item.kind === 'evidence' && (
            <span className="small muted">
              {' '}
              需 {item.min_count} 张，已 {item.done_count} 张
            </span>
          )}
        </div>
        {item.detail && <div className="check-detail">{item.detail}</div>}
      </div>
      {item.kind === 'evidence' && !done && <Tag kind="err">缺 {Math.max(0, item.min_count - item.done_count)} 张</Tag>}
    </div>
  );
}

/* ------------------------------ 材料 ------------------------------ */

function MaterialsTab({
  materials,
  detail,
  onChanged,
  go,
}: {
  materials: ChecklistItem[];
  detail: WorkbenchDetail;
  onChanged: () => void;
  go: (k: RouteKey, p?: Record<string, string>) => void;
}) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [uploadFor, setUploadFor] = useState<ChecklistItem | null>(null);

  const posName = (itemId: number) => {
    for (const p of detail.positions) if (p.checklist.some((c) => c.id === itemId)) return p;
    return undefined;
  };

  return (
    <Card
      title="材料清单"
      extra={<span className="small muted">上传后在下方材料核对中确认；只有核对完成才计入办理进度</span>}
    >
      {materials.length === 0 ? (
        <Empty text="该工作类型没有配置材料清单，可到「流程规范」里添加。" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 46 }}>状态</th>
              <th>材料</th>
              <th>所属阶段</th>
              <th>说明 / 留存要求</th>
              <th>附件</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {materials.map((m) => {
              const pos = posName(m.id);
              const done = isItemDone(m);
              return (
                <tr key={m.id}>
                  <td>
                    <Tag kind={done?'ok':'warn'}>{done?'已核对':m.artifact_count?'待核对':'待提供'}</Tag>
                  </td>
                  <td>
                    <div style={{ fontWeight: done ? 400 : 500 }}>{m.title}</div>
                    {!m.required && <span className="small muted">非必需</span>}
                  </td>
                  <td className="small nowrap">
                    {pos ? `${pos.seq}. ${pos.name}` : '—'}
                  </td>
                  <td className="small muted">{m.detail ?? '—'}</td>
                  <td className="small nowrap">{m.artifact_count > 0 ? <Tag kind="ok">{m.artifact_count} 个</Tag> : <span className="muted">—</span>}</td>
                  <td className="nowrap">
                    <Button size="sm" onClick={() => setUploadFor(m)}>
                      上传
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {uploadFor && (
        <UploadModal
          title={`上传材料：${uploadFor.title}`}
          workbenchId={detail.workbench.id}
          positionCode={posName(uploadFor.id)?.code}
          checklistItemId={uploadFor.id}
          kind="source"
          onClose={() => setUploadFor(null)}
          onDone={() => {
            setUploadFor(null);
            onChanged();
            toast('已上传并归档', 'ok');
          }}
        />
      )}
      <div className="mt12">
        <Button size="sm" onClick={() => go('files', { workbenchId: String(detail.workbench.id) })}>
          查看该工作台全部文件
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------ 影像证据 ------------------------------ */

function EvidenceTab({ evidences, detail, onChanged }: { evidences: ChecklistItem[]; detail: WorkbenchDetail; onChanged: () => void }) {
  const toast = useToast();
  const files = useApi<{ items: Artifact[] }>(`/api/artifacts?workbenchId=${detail.workbench.id}&kind=evidence&limit=500`);
  const [uploadFor, setUploadFor] = useState<ChecklistItem | null>(null);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [reviews, setReviews] = useState<
    Map<number, { verdict: string; summary: string; issues: string[]; detail: { file_name: string; summary: string; suggestion: string }[] }>
  >(new Map());
  const inputRef = useRef<HTMLInputElement>(null);

  /** 让视觉模型看这条清单下的照片。结论只是初检，核销还是人工点。 */
  const reviewItem = async (itemId: number): Promise<void> => {
    setReviewing(itemId);
    try {
      const r = await api.post<{
        verdict: string;
        summary: string;
        issues: string[];
        photos: { file_name: string; summary: string; suggestion: string }[];
      }>(`/api/evidence/review-checklist/${itemId}`, {});
      setReviews((prev) => {
        const next = new Map(prev);
        next.set(itemId, { verdict: r.verdict, summary: r.summary, issues: r.issues, detail: r.photos ?? [] });
        return next;
      });
      toast(r.verdict === 'ok' ? `模型认为合格：${r.summary}` : `模型发现问题：${r.summary}`, r.verdict === 'ok' ? 'ok' : 'info');
    } catch (e) {
      toast((e as { message: string }).message, 'err');
    } finally {
      setReviewing(null);
    }
  };

  const byItem = useMemo(() => {
    const map = new Map<number, Artifact[]>();
    for (const a of files.data?.items ?? []) {
      if (!a.checklist_item_id) continue;
      const arr = map.get(a.checklist_item_id) ?? [];
      arr.push(a);
      map.set(a.checklist_item_id, arr);
    }
    return map;
  }, [files.data]);

  const posOf = (itemId: number) => {
    for (const p of detail.positions) if (p.checklist.some((c) => c.id === itemId)) return p;
    return undefined;
  };

  return (
    <Card
      title="影像证据清单"
      extra={
        <span className="small muted">对着清单拍，缺张数的会标红；照片自动按规范命名并记录拍摄时间</span>
      }
    >
      {evidences.length === 0 ? (
        <Empty text="该工作类型没有配置影像清单。到「流程规范」里可以给每个阶段加上必拍项（例如开箱、到货、铭牌特写）。" />
      ) : (
        <div className="evi-grid">
          {evidences.map((e) => {
            const need = e.min_count;
            const has = e.done_count;
            const ok = has >= need || e.status === 'na';
            const shots = byItem.get(e.id) ?? [];
            const pos = posOf(e.id);
            return (
              <div key={e.id} className={`evi-card ${ok ? 'ok' : 'miss'}`}>
                <div className="evi-head">
                  <strong className="check-main">{e.title}</strong>
                  <Tag kind={ok ? 'ok' : 'err'}>
                    {has}/{need} 张
                  </Tag>
                </div>
                <div className="evi-body">
                  <div className="small muted">{pos ? `${pos.seq}. ${pos.name}` : ''}</div>
                  {e.detail && <div className="mt8">{e.detail}</div>}
                </div>
                {shots.length > 0 && (
                  <div className="evi-shots">
                    {shots.slice(0, 6).map((s) => (
                      <img key={s.id} src={`/api/artifacts/${s.id}/file`} className="evi-shot" title={s.file_name} />
                    ))}
                  </div>
                )}
                <div className="row" style={{ padding: '0 12px 12px', gap: 8 }}>
                  <Button size="sm" kind={ok ? 'default' : 'primary'} onClick={() => setUploadFor(e)}>
                    {ok ? '补拍' : '上传照片'}
                  </Button>
                  {shots.length > 0 && (
                    <Button
                      size="sm"
                      disabled={reviewing === e.id}
                      onClick={() => void reviewItem(e.id)}
                      title="让视觉模型看这批照片：拍到了什么、是否符合拍摄要求、要不要补拍"
                    >
                      {reviewing === e.id ? '模型在看…' : '让模型看看'}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    kind="ghost"
                    onClick={() =>
                      api
                        .put(`/api/checklist/${e.id}`, { status: 'na' })
                        .then(() => {
                          onChanged();
                          files.reload();
                        })
                        .catch((err: { message: string }) => toast(err.message, 'err'))
                    }
                  >
                    不适用
                  </Button>
                </div>

                {/* 模型初检结论：贴在照片下面，人就近核对 */}
                {reviews.get(e.id) && (
                  <div className={`evi-review evi-review-${reviews.get(e.id)?.verdict}`}>
                    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                      <Tag kind={reviews.get(e.id)?.verdict === 'ok' ? 'ok' : reviews.get(e.id)?.verdict === 'issue' ? 'err' : 'warn'}>
                        模型初检
                      </Tag>
                      <strong className="small">{reviews.get(e.id)?.summary}</strong>
                    </div>
                    {(reviews.get(e.id)?.issues.length ?? 0) > 0 && (
                      <ul className="small" style={{ margin: '6px 0 0 18px', padding: 0 }}>
                        {reviews.get(e.id)?.issues.map((x, i) => (
                          <li key={i}>{x}</li>
                        ))}
                      </ul>
                    )}
                    {reviews.get(e.id)?.detail?.some((d) => d.suggestion) && (
                      <div className="small muted mt4">
                        建议：{reviews.get(e.id)?.detail.filter((d) => d.suggestion).map((d) => d.suggestion).join('；')}
                      </div>
                    )}
                    <div className="small muted mt4">
                      只是初检意见，可能看错；核销由你来定。
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <input ref={inputRef} type="file" multiple accept="image/*" style={{ display: 'none' }} />

      {uploadFor && (
        <UploadModal
          title={`上传照片：${uploadFor.title}`}
          workbenchId={detail.workbench.id}
          positionCode={posOf(uploadFor.id)?.code}
          phase={posOf(uploadFor.id)?.name}
          checklistItemId={uploadFor.id}
          kind="evidence"
          accept="image/*"
          capture
          onClose={() => setUploadFor(null)}
          onDone={() => {
            setUploadFor(null);
            onChanged();
            files.reload();
            toast('照片已归档', 'ok');
          }}
        />
      )}
    </Card>
  );
}

/**
 * 出该阶段的文书（B2-7 改造后）。
 *
 * 【候选从哪来，按优先级一层层退】
 *   ① **阶段绑定**（`position_template_doc`，B2-7 / 迁移 018）—— 最高优先级，
 *      也是「流程规范」页现在配的那一层；
 *   ② 阶段所用**材料清单里挂的模板**（`material_check.template_id`，老数据的口径）——
 *      保留是为了**不回归**：改造前用户就是这么配的，一刀切掉他们的按钮就废了；
 *   ③ **工作台绑定**（`workbench.template_ids`）；
 *   ④ 该工作类型的**全部模板**（最后的兜底，与改造前一致）。
 * ①② 一起构成"默认只列当前阶段的模板"，③④ 只有在前面几层都空时才出现。
 *
 * 绑了 1 份就直接开（19 个阶段每个只对应一份单据时不该每次都问「用哪个模板」）；
 * 多份才让你挑；一份都没有就明说，并给「流程规范」的入口。
 *
 * `positionCode` 只在 ①②（真属于这个阶段的模板）上带：③④ 是"显示全部模板"那条路，
 * 出的是通用的文书，硬挂上阶段编码会让工作台详情把它算成"本阶段已出"（那是假的）。
 */
function StageGenerateButton({
  position,
  workTypeId,
  workbenchId,
  doc,
  onGenerate,
}: {
  position: PositionInstance;
  workTypeId: number;
  workbenchId: number;
  /** 后端算好的「本阶段应出哪些文书、已出几份」（B2-7）；老库缺 018 时为 null/undefined */
  doc?: PositionDocSummary | null;
  onGenerate: (templateId: number, templateName?: string, positionCode?: string | null) => void;
}) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [picking, setPicking] = useState<{ name: string; templateId: number; required: number; positionCode: string | null }[] | null>(null);
  const [showAll, setShowAll] = useState(false);

  /**
   * 阶段绑定的那层（①）：后端随工作台详情一起算好了，直接用，不再单独请求。
   * `source === 'position'` 说明这份清单确实来自阶段绑定 —— 只有这种情况才标「缺文书」，
   * 回退到工作台/工作类型时不能发假提醒（用户没绑过，怪不到他头上）。
   */
  const stageBound = doc && doc.source === 'position' ? doc.items : [];
  const shortfall = doc?.source === 'position' ? doc.shortfall : 0;

  const click = () =>
    run(async () => {
      // ① 阶段绑定优先
      if (stageBound.length === 1) {
        onGenerate(stageBound[0]!.templateId, stageBound[0]!.name, position.code);
        return;
      }
      if (stageBound.length > 1) {
        setShowAll(false);
        setPicking(stageBound.map((d) => ({ name: d.name, templateId: d.templateId, required: d.required, positionCode: position.code })));
        return;
      }
      // ② 材料清单里挂的模板（老口径）
      const r = await api.get<{ items: PositionRule[] }>(`/api/position-templates?workTypeId=${workTypeId}`);
      const rule = r.items.find((x) => x.code === position.code);
      const bound = (rule?.materials ?? []).filter((m) => m.template_id);
      if (bound.length === 1) {
        onGenerate(bound[0]!.template_id as number, bound[0]!.name, position.code);
        return;
      }
      if (bound.length > 1) {
        setShowAll(false);
        setPicking(bound.map((m) => ({ name: m.name, templateId: m.template_id as number, required: m.required, positionCode: position.code })));
        return;
      }
      // ③④ 都没有 → 明说，并给「流程规范」的入口与"显示全部模板"的退路
      /**
       * 这里不直接开通用列表：那会让人以为"这个阶段没有专门的文书"。
       * 先把话说明白（去绑一份），同时把「显示全部模板」这条路留着 ——
       * 用户确实只是想随手出一份通用文书时，不该被拦住。
       */
      const all = await api.get<{ items: Template[]; boundIds: number[] }>(`/api/workbenches/${workbenchId}/templates`);
      if ((all.items ?? []).length === 0) {
        toast(`阶段「${position.name}」还没绑定模板，这个工作类型下也还没有模板 —— 先到「模板库」上传，再到「流程规范」里给它挂一份`, 'err');
        return;
      }
      setShowAll(true);
      setPicking(
        (all.items ?? []).map((t) => ({ name: t.name, templateId: t.id, required: 0, positionCode: null })),
      );
    });

  return (
    <>
      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
        {/*
          「本阶段应出 3 份 / 已出 1 份」——与缺材料/缺照片同一套提示语言（docs/11 B2-7）。
          只在阶段绑定这一层显示：回退到工作台/工作类型时"应出"没有意义。
        */}
        {doc?.source === 'position' && (
          <span className="small muted nowrap" title={doc.items.map((i) => `${i.generated ? '已出' : '未出'}：${i.name}${i.required ? '（必须出具）' : ''}`).join('\n')}>
            应出 {doc.total} 份 / 已出 {doc.done} 份
          </span>
        )}
        {shortfall > 0 && <Tag kind="err">缺文书 {shortfall} 份</Tag>}
        <Button size="sm" disabled={busy} onClick={click} title="按这个阶段绑定的模板出文书">
          {busy ? '查找模板…' : '出该阶段文书'}
        </Button>
      </span>
      {picking && (
        <Modal open title={`${position.name} —— 选要出哪份文书`} onClose={() => setPicking(null)}>
          {showAll && (
            <div className="notice notice-info">
              这个阶段<strong>还没有绑定模板</strong>。下面是该工作类型下的全部模板 ——
              想固定下来，到「流程规范」页给这个阶段勾几份，以后这里就只列它们。
            </div>
          )}
          {shortfall > 0 && !showAll && (
            <div className="notice">
              有 {shortfall} 份标了「必须出具」的文书还没出。
            </div>
          )}
          <div className="col" style={{ gap: 8 }}>
            {picking.map((m) => (
              <Button
                key={`${m.templateId}-${m.positionCode ?? 'all'}`}
                block
                onClick={() => {
                  onGenerate(m.templateId, m.name, m.positionCode);
                  setPicking(null);
                }}
              >
                {m.name}
                {m.required ? '（必须出具）' : ''}
              </Button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------ 删除确认 ------------------------------ */

/**
 * `DELETE /api/workbenches/:id` 的返回。
 *
 * 后端按 URL 上有没有 `purge=1` 分成两条语义**相反**的路（routes-work.ts）：
 *   · 不带 `purge`  → 软删除：工作台/阶段实例/文件记录一起进回收站，磁盘一个字节都不动，
 *     一定带回 `message`（"已移到回收站（阶段 N 个、文件记录 M 条）…可在「回收站」页恢复"）
 *     与逐项计数 `trashedDetail`；
 *   · 带 `purge=1`  → 彻底删除（不可恢复）：带 `filesRemoved` 与"不可恢复"的 `message`。
 * 两条路都**可能**给 `message`（都给了），界面优先原样转述，只在没有时才自己拼兜底。
 * （本弹窗现在只走软删除那一条，见 `DeleteWorkbenchModal` 的说明；彻底删除在「回收站」页。）
 *
 * `deleted` / `filesUnlocatable` 是两条路共有的形状（领域层恒返回）；
 * `dirsRecycled` 在软删除那条路上恒为 0（软删除不回收目录）。
 */
interface DeleteWorkbenchResult {
  deleted: { artifacts: number; positions: number; files: number; dirRemoved: boolean; dirsRecycled: number };
  /** 定位不到磁盘位置、因而没动磁盘的附件数（解绑后 root_kind='external' 的老记录） */
  filesUnlocatable: number;
  message: string | null;
  /** 软删除那条路的标记：这次只是"移到回收站" */
  trashed?: boolean;
  /** 软删除那条路的逐项计数（阶段/文件记录/清单各进了多少条） */
  trashedDetail?: { workbench: number; positions: number; artifacts: number; checklist: number };
  /** 彻底删除那条路的标记 */
  purged?: boolean;
  /** 彻底删除那条路真的删掉了几个磁盘文件 */
  filesRemoved?: number;
}

/**
 * 删除确认 —— **单一动作：移到回收站**。
 *
 * 【为什么这里不再有「删除方式」二选一】
 * 这个弹窗只打 `DELETE /api/workbenches/:id`（不带 `purge`），后端走的就是软删除分支：
 * 记录进回收站、磁盘一个字节都不动、能恢复。以前那个「一并请求删掉平台登记的文件」选项
 * 是在 URL 上加 `withFile=1` 实现的，而 `withFile` **只被后端 `?purge=1` 的彻底删除分支读**
 * （见 `routes-work.ts`）—— 也就是说那是一个点了没有任何效果的选项，只能靠一行"当前不生效"
 * 的说明打补丁。界面不该提供一个无效选项，所以这里改成单一动作、把这一步说死。
 *
 * 「连磁盘文件一起删」本来就属于回收站里的**彻底删除**那一步（那里已实现、且有二次确认），
 * 所以弹窗里给一句指路：「要彻底删除（含磁盘文件），请到「回收站」页操作」。
 * 强确认（这份工作里已有数据时要输入「删除」二字）保留，误删门槛不降。
 */
function DeleteWorkbenchModal({
  wb,
  onClose,
  onDeleted,
}: {
  wb: Workbench;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { busy, run } = useAction();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const positions = wb.position_total ?? 0;
  const files = wb.artifact_count ?? 0;
  /** 这份工作里已经有数据时才要求输入确认词（空工作台不额外拦一道） */
  const needType = files > 0 || positions > 0;
  /** 绑定型：文件在用户自己的资料目录里；未绑定：在平台自己的工作台目录里 */
  const bound = Boolean((wb.external_root ?? '').trim());
  const fileRoot = (wb.external_root ?? '').trim() || wb.folder_path;

  const doDelete = () =>
    run(async () => {
      /**
       * URL 上**只有这一条路**：不带 `purge`、也不带 `withFile`。
       * `withFile` 只对后端 `purge=1` 的彻底删除分支有意义（"连磁盘文件一起删"只发生在
       * 回收站里那一步），跟着软删除请求发出去不会有任何磁盘动作 ——
       * 界面既然不再提供那个选项，这里也就不拼它。
       */
      const r = await api.del<DeleteWorkbenchResult>(`/api/workbenches/${wb.id}`);
      /**
       * 后端把「移到了哪、动了没动磁盘、能不能恢复」说得很准，优先原样转述 `message`
       * （软删除这条路一定给 `message`）；万一为空，兜底也必须说"进回收站、磁盘没动"，
       * 不能像以前那样写"已删除平台记录"（那是真删的口气，与软删除正相反）。
       */
      toast(r?.message || '已移到回收站，磁盘上的文件一个都没动；可在「回收站」页恢复', 'ok');
      onDeleted();
    });

  return (
    <Modal
      open
      title="删除这份工作？"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button kind="danger" disabled={busy || (needType && typed.trim() !== '删除')} onClick={doDelete}>
            {/* 按钮上写明这一步的结果：只看按钮就知道它只是"移到回收站" */}
            {busy ? '删除中…' : '确认删除（移到回收站）'}
          </Button>
        </>
      }
    >
      <div className="notice notice-err">
        <strong>这份工作会移到回收站。</strong>
        记录和磁盘文件都还在，之后可以在「回收站」页恢复；只有彻底删除才不可恢复。
        如果只是想让它从列表里消失、以后还能查，用「归档」而不是删除。
      </div>

      {/* 只有一个动作，所以这段不再是"选哪项"的条件分支，而是把这一步说死 */}
      <div className="notice notice-info">
        <strong>这一步只做一件事：移到回收站。</strong>工作记录、{positions} 个阶段、
        {files} 个文件记录会进回收站，<strong>磁盘上的文件一个都不动</strong>
        {bound ? '（包括你绑定的资料目录）' : ''}，之后可以在「回收站」页原样恢复。
        <br />
        <strong>要彻底删除（含磁盘文件），请到「回收站」页操作</strong>
        —— 那一步才会真的删掉平台登记的磁盘文件，并且不可恢复。
      </div>

      <div className="mt12 small">
        将要移到回收站的内容：
        <ul style={{ margin: '6px 0 0 18px', lineHeight: 1.9 }}>
          <li>
            工作记录本身：<strong>{wb.code} {wb.name}</strong>
          </li>
          <li>
            阶段进度与清单勾选记录：<strong>{positions} 个阶段</strong>
          </li>
          <li>
            文件记录与全文索引：<strong>{files} 个文件</strong>
          </li>
          <li>
            磁盘上的文件：<strong>全部保留，一个都不动</strong>
            {bound ? '；绑定的资料目录本身也不动' : ''}
            <div className="mono small mt8">{fileRoot}</div>
          </li>
        </ul>
      </div>

      {needType && (
        <div className="mt16">
          <Field label="确认操作" required hint="这份工作里已有数据，请输入「删除」二字确认">
            <Input value={typed} onChange={setTyped} placeholder="删除" />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------ 本期面板（文书驱动） ------------------------------ */

/**
 * 行政管理工作打开后看到的东西。
 *
 * 没有页签、没有「出文书」这一层 —— 因为这份工作的内容就是填那几张表，
 * 「做这份工作」和「出这份文件」本来就是一回事。所以直接把
 * 「这一期要交什么、每项要填几项、本期已经出了哪些文件」摊开在页面上。
 */
function PeriodPanel({
  workTypeId,
  workbenchId,
  go,
  onGenerate,
  onChanged,
  configurationOnly = false,
}: {
  configurationOnly?: boolean;
  workTypeId: number;
  workbenchId: number;
  go: (k: RouteKey, p?: Record<string, string>) => void;
  onGenerate: (templateId: number, templateName?: string) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { busy, run } = useAction();
  const tpls = useApi<{ items: Template[]; boundIds: number[] }>(`/api/workbenches/${workbenchId}/templates`);
  const arts = useApi<{ items: Artifact[] }>(`/api/artifacts?workbenchId=${workbenchId}&limit=50`);
  /** 模板 id → 自动/待填 统计 */
  const [fieldStats, setFieldStats] = useState<Record<number, { auto: number; todo: number; total: number }>>({});
  const [rebinding, setRebinding] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [requiredPicked,setRequiredPicked]=useState<number[]>([]);
  /** 改绑定时要看该工作类型下的全部模板，所以单独拉一次 */
  const allOfType = useApi<{ items: Template[] }>(
    rebinding && workTypeId ? `/api/templates?workTypeId=${workTypeId}` : null,
    [rebinding, workTypeId],
  );

  const items = tpls.data?.items ?? [];
  const boundIds = tpls.data?.boundIds ?? [];

  // 一进来就把每份模板「要填几项」拉出来 —— 这正是页面上要显示的信息，不能等鼠标划过
  useEffect(() => {
    if (configurationOnly) return;
    let alive = true;
    for (const t of items) {
      void api
        .get<{ summary: { auto: number; todo: number; total: number } }>(
          `/api/generate/fields/${t.id}?workbenchId=${workbenchId}`,
        )
        .then((r) => {
          if (alive) setFieldStats((s) => ({ ...s, [t.id]: r.summary }));
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpls.data, configurationOnly]);

  const saveBinding = () =>
    run(async () => {
      await api.put(`/api/workbenches/${workbenchId}/templates`, { templateIds: picked, requiredIds: requiredPicked.filter(id=>picked.includes(id)) });
      setRebinding(false);
      tpls.reload();
      onChanged();
      toast(picked.length ? `已设为这份工作要交的 ${picked.length} 份` : '已清空，将显示该类型的全部模板', 'ok');
    });

  return (
    <>
      <Card
        title={configurationOnly ? "后续期次模板配置" : "这一期要交的内容"}
        extra={
          <Button
            size="sm"
            onClick={() => {
              setPicked(boundIds);setRequiredPicked((tpls.data?.items??[]).filter(t=>(t as Template & {required?:boolean}).required).map(t=>t.id));
              setRebinding((r) => !r);
            }}
          >
            {rebinding ? '取消' : '设置要交哪几份'}
          </Button>
        }
      >
        {rebinding && (
          <div className="notice notice-info" style={{ marginBottom: 12 }}>
            <div style={{ marginBottom: 8 }}>
              勾选这份工作每期要交哪几份。选好后这里只列这些；一份都不选则列出该工作类型的全部模板。
            </div>
            <TemplatePicker
              templates={allOfType.data?.items ?? []}
              selected={picked}
              onToggle={(id) => setPicked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
              loading={allOfType.loading}
            />
            {picked.map(id=><label key={id}><input type="checkbox" checked={requiredPicked.includes(id)} onChange={e=>setRequiredPicked(v=>e.target.checked?[...v,id]:v.filter(x=>x!==id))}/> {allOfType.data?.items.find(t=>t.id===id)?.name??id} 为必备成果</label>)}
            <div className="row mt12" style={{ gap: 8 }}>
              <Button kind="primary" size="sm" disabled={busy} onClick={saveBinding}>
                保存
              </Button>
            </div>
          </div>
        )}

        {configurationOnly ? <p>模板配置供新期次使用；请在下方所选报告期内填写、生成和办理。已有期次需预览差异后单独更新模板。</p> : tpls.loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty
            text="这份工作还没有要交的表。点右上角「设置要交哪几份」选，或先去「知识库 → 模板」上传。"
            action={
              <Button kind="primary" onClick={() => go('knowledge')}>
                去知识库
              </Button>
            }
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>要交的东西</th>
                <th style={{ width: 220 }}>需要填写</th>
                <th style={{ width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => {
                const s = fieldStats[t.id];
                return (
                  <tr key={t.id}>
                    <td>
                      <strong>{t.name}</strong>{rebinding && picked.includes(t.id) && <label><input type="checkbox" checked={requiredPicked.includes(t.id)} onChange={e=>setRequiredPicked(v=>e.target.checked?[...v,t.id]:v.filter(id=>id!==t.id))}/> 必备成果</label>}
                      {t.description && <div className="muted small">{t.description}</div>}
                    </td>
                    <td className="small">
                      {!s ? (
                        <span className="muted">…</span>
                      ) : s.total === 0 ? (
                        <span className="muted">无需填写（固定内容）</span>
                      ) : s.todo === 0 ? (
                        <span style={{ color: 'var(--ok)' }}>全部自动带出，可直接生成</span>
                      ) : (
                        <>
                          <span style={{ color: 'var(--warn)' }}>需填 {s.todo} 项</span>
                          {s.auto > 0 && <span className="muted">　·　自动带出 {s.auto}</span>}
                        </>
                      )}
                    </td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      <Button size="sm" kind="primary" onClick={() => onGenerate(t.id, t.name)}>
                        填写生成
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {!configurationOnly && <Card title={`本工作文件（${arts.data?.items.length ?? 0}）`}>
        {arts.loading ? (
          <Loading />
        ) : (arts.data?.items.length ?? 0) === 0 ? (
          <Empty text="本工作尚无文件。" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>文件</th>
                <th style={{ width: 160 }}>生成时间</th>
                <th style={{ width: 90 }}>大小</th>
                <th style={{ width: 100 }} />
              </tr>
            </thead>
            <tbody>
              {arts.data?.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.title}</strong>
                    <div className="muted small mono">{a.file_name}</div>
                  </td>
                  <td className="small muted">{fmtTime(a.created_at)}</td>
                  <td className="small muted">{fmtSize(a.size_bytes)}</td>
                  <td className="nowrap" style={{ textAlign: 'right' }}>
                    <FilePreviewButton artifact={a} />
                    <Button size="sm" onClick={() => api.download(`/api/artifacts/${a.id}/file`, a.file_name)}>
                      下载
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>}
    </>
  );
}

/* ------------------------------ 出文书（文书驱动） ------------------------------ */

/* ------------------------------ 文件 ------------------------------ */

function FilesTab({ workbenchId, positions, onChanged }: { workbenchId: number; positions: PositionInstance[]; onChanged: () => void }) {
  const toast = useToast();
  const files = useApi<{ items: Artifact[] }>(`/api/artifacts?workbenchId=${workbenchId}&limit=300`);
  const [uploading, setUploading] = useState(false);
  /**
   * 正在看版本的那份文书（B1-4）。放在「出文书」这条线上：生成 → 看版本 → 定稿/回滚，
   * 是同一件事的三个连续动作，不该跳到别的页面去找。
   */
  const [versionsOf, setVersionsOf] = useState<number | null>(null);
  // B3-10：这份工作台里每份文书的「制度依据」（一次请求取全，避免文件行一行一个请求）
  const cites = useApi<{ byArtifact: Record<string, CiteBundle>; total: number }>(`/api/citations?workbenchId=${workbenchId}`);

  const posName = (code: string | null) => positions.find((p) => p.code === code)?.name ?? code ?? '—';

  return (
    <Card
      title="文件"
      extra={
        <>
          <Button size="sm" onClick={() => files.reload()}>
            刷新
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              try {
                const r = await api.post<{ added: number }>('/api/files/import-folder', { workbenchId });
                toast(r.added > 0 ? `新纳入 ${r.added} 个文件` : '没有发现新文件', r.added > 0 ? 'ok' : 'info');
                files.reload();
                onChanged();
              } catch (e) {
                toast((e as { message: string }).message, 'err');
              }
            }}
            title="把你自己复制进项目文件夹的文件纳入系统管理"
          >
            扫描文件夹
          </Button>
          <Button size="sm" kind="primary" onClick={() => setUploading(true)}>
            上传文件
          </Button>
        </>
      }
    >
      {files.loading ? (
        <Loading />
      ) : (files.data?.items.length ?? 0) === 0 ? (
        <Empty text="还没有文件。生成的文书、上传的证据和资料都会列在这里。" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>文件</th>
              <th>类别</th>
              <th>阶段</th>
              <th>大小</th>
              <th>时间</th>
              <th>制度依据</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {files.data?.items.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="row" style={{ gap: 9 }}>
                    {isImg(a) ? (
                      <img src={`/api/artifacts/${a.id}/file`} style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 5 }} />
                    ) : (
                      <span className={`file-ico ${a.file_ext?.includes('xls') ? 'xls' : a.file_ext?.includes('doc') ? 'doc' : 'pdf'}`}>
                        {(a.file_ext ?? '').replace('.', '').slice(0, 4).toUpperCase()}
                      </span>
                    )}
                    <div className="check-main">
                      <div className="check-title ellipsis">{a.title}</div>
                      <div className="check-detail mono ellipsis" title={a.file_rel}>
                        {a.file_rel}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="small nowrap">{a.kind==='generated'?'生成成果':a.file_role==='external'?'外部证明材料':KIND_TEXT[a.kind]??a.kind}</td>
                <td className="small nowrap">{posName(a.position_code)}</td>
                <td className="small nowrap muted">{fmtSize(a.size_bytes)}</td>
                <td className="small nowrap muted">{fmtTime(a.captured_at ?? a.created_at)}</td>
                <td className="small">
                  {/* B3-10：依据哪份制度哪一条 + 加/取消链接（只在这一行新增，不改既有按钮与逻辑） */}
                  <CiteChips artifactId={a.id} data={cites.data?.byArtifact[String(a.id)]} onChanged={() => cites.reload()} />
                </td>
                <td className="nowrap">
                  {/* 生成文书才有版本链（上传的影像/资料没有"第几版"这回事） */}
                  {a.kind === 'generated' && (
                    <Button
                      size="sm"
                      onClick={() => setVersionsOf(a.id)}
                      title="看这条文书的版本链：哪一版是当前、哪一版是定稿，还能按版本对比与回滚"
                    >
                      {Number(a.is_final ?? 0) === 1 ? `🔒 v${Number(a.revision ?? 1)}` : `版本${Number(a.revision ?? 0) > 1 ? ` v${a.revision}` : ''}`}
                    </Button>
                  )}
                  <FilePreviewButton artifact={a} />
                  <Button size="sm" onClick={() => api.download(`/api/artifacts/${a.id}/file`, a.file_name)}>
                    下载
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {versionsOf !== null && (
        <DocVersionsModal
          id={versionsOf}
          onClose={() => setVersionsOf(null)}
          onChanged={() => {
            files.reload();
            onChanged();
          }}
        />
      )}

      {uploading && (
        <UploadModal
          title="上传文件到该工作台"
          workbenchId={workbenchId}
          kind="source"
          onClose={() => setUploading(false)}
          onDone={() => {
            setUploading(false);
            files.reload();
            onChanged();
            toast('已上传并归档', 'ok');
          }}
        />
      )}
    </Card>
  );
}

export const KIND_TEXT: Record<string, string> = {
  generated: '生成文书',
  evidence: '影像证据',
  source: '来源资料',
  scan: '扫描件',
  template: '模板',
  other: '其它',
};

function isImg(a: Artifact): boolean {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(a.file_name);
}

/* ------------------------------ 通用上传 ------------------------------ */

export function UploadModal({
  title,
  workbenchId,
  positionCode,
  phase,
  checklistItemId,
  kind,
  accept,
  capture,
  onClose,
  onDone,
}: {
  title: string;
  workbenchId: number;
  positionCode?: string;
  phase?: string;
  checklistItemId?: number;
  kind: 'source' | 'evidence' | 'scan';
  accept?: string;
  capture?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const [fileRole,setFileRole]=useState(checklistItemId?'external':'source');
  const [over, setOver] = useState(false);
  const { busy, run } = useAction();

  const submit = () =>
    run(async () => {
      if (!files.length) {
        toast('请先选择文件', 'err');
        return;
      }
      const form = new FormData();
      files.forEach((f) => form.append('file', f, f.name));
      form.append('workbenchId', String(workbenchId));
      form.append('fileRole',fileRole);
      if (positionCode) form.append('positionCode', positionCode);
      if (phase) form.append('phase', phase);
      if (checklistItemId) form.append('checklistItemId', String(checklistItemId));
      if (note) form.append('note', note);
      const path = kind === 'evidence' ? '/api/artifacts/evidence' : '/api/artifacts/upload';
      await api.upload(path, form);
      onDone();
    });

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button kind="primary" onClick={submit} disabled={busy || !files.length}>
            {busy ? '上传中…' : `上传 ${files.length || ''} 个文件`}
          </Button>
        </>
      }
    >
      <div
        className={`drop${over ? ' over' : ''}`}
        onClick={() => (document.getElementById('up-input') as HTMLInputElement | null)?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          setFiles((prev) => [...prev, ...Array.from(e.dataTransfer.files)]);
        }}
      >
        点击选择，或把文件拖到这里
        <div className="small mt8">
          {kind === 'evidence' ? '拍照建议：光线充足、关键信息（型号/序列号/日期）清晰可读' : '支持 Word / Excel / PDF / 图片 / 压缩包'}
        </div>
      </div>
      <input
        id="up-input"
        type="file"
        multiple
        accept={accept}
        {...(capture ? { capture: 'environment' as const } : {})}
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
              <span className="muted nowrap">{fmtSize(f.size)}</span>
              <button className="icon-btn" onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {kind!=='evidence'&&<Field label="文件用途"><Select value={fileRole} onChange={setFileRole} options={[{value:'source',label:'来源资料 · 业务记录 / 参考依据'},{value:'external',label:'外部证明 · 合同 / 签章件 / 交付资料'}]}/></Field>}
      <Field label="说明 / 备注" hint="会写进文件名和标题，方便以后检索">
        <Input value={note} onChange={setNote} placeholder={kind === 'evidence' ? '例如：开箱外包装' : '例如：合同扫描件'} />
      </Field>
    </Modal>
  );
}

/* ------------------------------ 编辑资料 ------------------------------ */

function EditWorkbenchModal({ wb, onClose, onSaved }: { wb: Workbench; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: wb.name,
    owner: wb.owner ?? '',
    counterpart: wb.counterpart ?? '',
    contractNo: wb.contract_no ?? '',
    startDate: wb.start_date ?? '',
    planEndDate: wb.plan_end_date ?? '',
    status: wb.status,
    summary: wb.summary ?? '',
  });
  const { busy, run } = useAction();
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Modal
      open
      title="编辑工作台资料"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            kind="primary"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.put(`/api/workbenches/${wb.id}`, form);
                onSaved();
              })
            }
          >
            保存
          </Button>
        </>
      }
    >
      <Field label="名称" required>
        <Input value={form.name} onChange={set('name')} />
      </Field>
      <div className="inline-fields">
        <Field label="对接单位">
          <Input value={form.counterpart} onChange={set('counterpart')} />
        </Field>
        <Field label="合同编号">
          <Input value={form.contractNo} onChange={set('contractNo')} />
        </Field>
      </div>
      <div className="inline-fields">
        <Field label="开始日期">
          <Input value={form.startDate} onChange={set('startDate')} type="date" />
        </Field>
        <Field label="计划完工">
          <Input value={form.planEndDate} onChange={set('planEndDate')} type="date" />
        </Field>
        <Field label="状态">
          <Select
            value={form.status}
            onChange={set('status')}
            options={[
              { value: 'active', label: '进行中' },
              { value: 'paused', label: '暂停' },
              { value: 'done', label: '已完成' },
              { value: 'archived', label: '已归档' },
            ]}
          />
        </Field>
      </div>
      <Field label="备注">
        <Textarea value={form.summary} onChange={set('summary')} rows={3} />
      </Field>
      <div className="notice small">
        这些信息会在生成文书时自动带入模板变量（项目名称、建设单位、合同编号、开工日期等）。
        更细的字段到「项目信息」页维护。
      </div>
    </Modal>
  );
}

/* ============================================================================
 * 文书 ↔ 制度双链（B3-10）—— 本文件末尾追加的一段，既有渲染逻辑一行都没动。
 *
 * 界面上做三件事：
 *   ① 文件行多一列「制度依据」：`《XX办法》第五条` 这种小标签，来源分「正文引用 / 人工添加」；
 *   ② 点开能看**依据的那一条原文**（B3-9 的 /api/kb/clauses/lookup）、能看**该条被几份文书引用**
 *      （B3-10 的 /api/kb/documents/:id/usages）、能**人工加**一条、能**取消**一条（软删）；
 *   ③ 制度内容变了（文件哈希不一致）的行标「⚠制度已变」，提醒复核。
 *
 * 【已知限制，如实写在这里】「跳到知识库」只能跳到知识库页（`#/knowledge`），因为
 * `pages/Knowledge.tsx` 本轮不在改动范围内、它也不读任何路由参数；条款原文与"被 N 份文书引用"
 * 两个数字都在本卡片里直接显示了，所以即使跳过去也不会看不着东西。
 * ==========================================================================*/

export interface CiteLink {
  id: number;
  linkKind: 'explicit' | 'manual' | 'suggested';
  clausePath: string | null;
  clauseLabel: string | null;
  quote: string | null;
  rawCite: string | null;
  documentId: number | null;
  documentTitle: string | null;
  docNo: string | null;
  documentLive: boolean;
  recovered: boolean;
  removed: boolean;
  documentChanged: boolean | null;
  createdAt: string;
  createdBy: string | null;
}

export interface CiteCounts {
  total: number;
  explicit: number;
  manual: number;
  suggested: number;
  stale: number;
  changed: number;
}

export interface CiteBundle {
  artifactId: number;
  items: CiteLink[];
  counts: CiteCounts;
}

const CITE_KIND_TEXT: Record<string, string> = { explicit: '正文引用', manual: '人工添加', suggested: '未确认建议' };

/** 条款可读标签：`第二章 到货验收 > 第五条 检查频次` → `第五条 检查频次` */
function citeLabel(l: CiteLink): string {
  if (l.clauseLabel) return l.clauseLabel;
  if (l.clausePath) return l.clausePath.split('>').map((s) => s.trim()).pop() ?? l.clausePath;
  return '（未记条款）';
}

function citeTitle(l: CiteLink): string {
  return `${l.documentTitle ? `《${l.documentTitle}》` : '（制度已不在知识库）'}${l.docNo ? `（${l.docNo}）` : ''} ${citeLabel(l)}`;
}

/* ------------------------------ 文件行里的一格 ------------------------------ */

function CiteChips({ artifactId, data, onChanged }: { artifactId: number; data?: CiteBundle; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const items = data?.items ?? [];
  const stale = data?.counts.stale ?? 0;
  const changed = data?.counts.changed ?? 0;
  return (
    <>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {items.length === 0 && stale === 0 && <span className="muted">—</span>}
        {items.slice(0, 2).map((l) => (
          <Tag key={l.id} kind={l.documentChanged ? 'warn' : l.linkKind === 'manual' ? 'info' : 'default'}>
            <span title={`${CITE_KIND_TEXT[l.linkKind] ?? l.linkKind}${l.documentChanged ? '；制度内容已变，建议复核' : ''}\n${citeTitle(l)}`}>
              《{l.documentTitle ?? '已移除'}》{citeLabel(l)}
            </span>
          </Tag>
        ))}
        {items.length > 2 && <span className="muted">+{items.length - 2}</span>}
        {changed > 0 && <span style={{ color: 'var(--warn, #b8860b)' }} title="制度文件内容与建链时不一致">⚠{changed} 条制度已变</span>}
        {stale > 0 && <span style={{ color: 'var(--err)' }} title="引用的制度已不在知识库里（链接行保留）">{stale} 条制度已移除</span>}
        <Button size="sm" onClick={() => setOpen(true)} title="看这份文书依据了哪些制度条款，可以人工加/取消">
          依据{items.length ? `(${items.length})` : ''}
        </Button>
      </div>
      {open && <ArtifactCitationsModal artifactId={artifactId} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </>
  );
}

/* ------------------------------ 一份文书的制度依据 ------------------------------ */

function ArtifactCitationsModal({ artifactId, onClose, onChanged }: { artifactId: number; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const detail = useApi<{
    artifactTitle: string | null;
    artifactInTrash: boolean;
    items: CiteLink[];
    stale: CiteLink[];
    counts: CiteCounts;
  }>(`/api/artifacts/${artifactId}/citations?includeRemoved=1`);
  const docs = useApi<{ items: { id: number; title: string; doc_no: string | null; clause_count: number }[] }>('/api/kb/clauses/documents');
  const [docId, setDocId] = useState('');
  const [clause, setClause] = useState('');

  const add = () =>
    run(async () => {
      if (!docId) throw new Error('先选一份制度（没入库的制度先去知识库入库并抽取）');
      if (!clause.trim()) throw new Error('写清是哪一条：如「第五条」或条款名「检查频次」');
      const r = await api.post<{ link: { id: number } }>(`/api/artifacts/${artifactId}/citations`, { kbDocumentId: Number(docId), clause });
      toast(`已加人工链接 #${r.link.id}`, 'ok');
      setClause('');
      detail.reload();
      onChanged();
    });

  const remove = (l: CiteLink) =>
    run(async () => {
      await api.del(`/api/citations/${l.id}`);
      toast('已取消这条链接（软删，可重新引用回来）', 'ok');
      detail.reload();
      onChanged();
    });

  const counts = detail.data?.counts;
  return (
    <Modal
      open
      wide
      title={`制度依据：${detail.data?.artifactTitle ?? `文书 #${artifactId}`}`}
      onClose={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {detail.loading ? (
        <Loading />
      ) : (
        <>
          {detail.data?.artifactInTrash && <div className="notice small">这份文书在回收站里 —— 依据清单仍可查看（链接行不会因进回收站而丢）。</div>}
          <div className="small muted">
            依据 {counts?.total ?? 0} 条（正文引用 {counts?.explicit ?? 0} / 人工添加 {counts?.manual ?? 0}）
            {counts?.stale ? `，另有 ${counts.stale} 条引用的制度已不在知识库里` : ''}
          </div>
          {(detail.data?.items.length ?? 0) === 0 && <Empty text="这份文书还没有制度依据。正文里写「《制度名》第五条」，保存时会自动记下来；也可以在这里手工加。" />}
          <table className="table">
            <thead>
              <tr>
                <th>依据</th>
                <th>来源</th>
                <th>原文片段</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(detail.data?.items ?? []).map((l) => (
                <CiteRow key={l.id} link={l} onRemove={() => remove(l)} busy={busy} />
              ))}
              {(detail.data?.stale ?? []).map((l) => (
                <CiteRow key={l.id} link={l} onRemove={() => remove(l)} busy={busy} />
              ))}
            </tbody>
          </table>

          <Field label="人工加一条依据" hint="自动解析会漏（正文没写条号）也会误，这里人工补齐；核不到条款会直接报错，不会记一条空链接">
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <Select
                value={docId}
                onChange={setDocId}
                placeholder={docs.loading ? '正在读制度清单…' : '选一份制度'}
                options={(docs.data?.items ?? []).map((d) => ({ value: String(d.id), label: `《${d.title}》${d.doc_no ? `（${d.doc_no}）` : ''} · ${d.clause_count} 条` }))}
              />
              <Input value={clause} onChange={setClause} placeholder="第五条 / 检查频次" onEnter={add} />
              <Button kind="primary" onClick={add} disabled={busy}>
                加链接
              </Button>
            </div>
          </Field>
        </>
      )}
    </Modal>
  );
}

function CiteRow({ link, onRemove, busy }: { link: CiteLink; onRemove: () => void; busy: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [showUses, setShowUses] = useState(false);
  /** 知识库侧：这一条被几份文书引用（制度 → 文书的反查） */
  const usages = useApi<{
    total: number;
    inTrash: number;
    byKind: { explicit: number; manual: number; suggested: number };
    items: { linkId: number; artifactId: number; artifactTitle: string; workbenchCode: string | null; workbenchName: string | null }[];
  }>(link.documentId ? `/api/kb/documents/${link.documentId}/usages${link.clausePath ? `?clause=${encodeURIComponent(link.clausePath)}` : ''}` : null);

  const loadText = async () => {
    if (!link.documentId || !link.clausePath) return;
    try {
      const r = await api.get<{ citation: { content: string } }>(`/api/kb/clauses/lookup?doc=${encodeURIComponent(link.documentTitle ?? '')}&clause=${encodeURIComponent(link.clausePath)}`);
      setText(r.citation.content);
    } catch (e) {
      setText(`读不到这条原文：${(e as { message?: string }).message ?? ''}`);
    }
  };

  return (
    <>
      <tr>
        <td>
          <div className="check-main">
            <div className="check-title">{link.documentTitle ? `《${link.documentTitle}》` : '（制度已移除）'}{link.docNo ? `（${link.docNo}）` : ''}</div>
            <div className="check-detail">{citeLabel(link)}</div>
          </div>
        </td>
        <td className="small nowrap">
          <Tag kind={link.linkKind === 'manual' ? 'info' : 'default'}>{CITE_KIND_TEXT[link.linkKind] ?? link.linkKind}</Tag>
          {link.documentChanged && <Tag kind="warn">制度已变</Tag>}
          {link.removed && <Tag kind="err">制度已移除</Tag>}
          {link.recovered && <Tag kind="ok">已认回</Tag>}
        </td>
        <td className="small muted" style={{ maxWidth: 380 }}>
          {link.quote ?? '（没记原文片段）'}
        </td>
        <td className="nowrap">
          <Button size="sm" onClick={loadText} disabled={!link.documentId || !link.clausePath} title="看这条的当前原文（制度改了就是改后的）">
            看原文
          </Button>
          <Button size="sm" onClick={() => setShowUses((v) => !v)} title="哪些文书也引用了这一条（制度 → 文书反查）">
            被引 {usages.data ? usages.data.total : '—'}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              // 知识库页本轮不读路由参数，所以这里只跳到知识库，条款原文与引用数在上面已直接显示
              window.location.hash = `#/knowledge?doc=${link.documentId ?? ''}&clause=${encodeURIComponent(link.clausePath ?? '')}`;
            }}
            title="去知识库（当前版本只跳转到知识库页，不能定位到具体条款）"
          >
            知识库
          </Button>
          <Button size="sm" kind="danger" onClick={onRemove} disabled={busy} title="取消这条链接（软删，留痕）">
            取消
          </Button>
        </td>
      </tr>
      {(text !== null || showUses) && (
        <tr>
          <td colSpan={4} className="small">
            {text !== null && (
              <div className="notice" style={{ whiteSpace: 'pre-wrap' }}>
                <div className="small muted">这条现在的原文：</div>
                {text.slice(0, 1200)}
              </div>
            )}
            {showUses && (
              <div className="small">
                引用这一条的文书 {usages.data?.total ?? 0} 份
                {usages.data?.inTrash ? `（另有 ${usages.data.inTrash} 条来自回收站里的文书，不计入）` : ''}：
                {usages.data?.items.length ? (
                  <ul>
                    {usages.data.items.map((u) => (
                      <li key={u.linkId}>
                        {u.workbenchCode ? `${u.workbenchCode} · ` : ''}
                        {u.artifactTitle}
                        {u.workbenchName ? `（${u.workbenchName}）` : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted">还没有别的文书引用这一条</span>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
