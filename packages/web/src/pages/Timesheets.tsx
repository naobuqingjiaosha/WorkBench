import { useState, useEffect } from 'react';
import MonthlyTimesheet from './MonthlyTimesheet';
import { api, useApi } from '../api';
import { Button, Card, Field, Input, Select, Textarea, useAction } from '../ui';
interface Source {
    id: string;
    name: string;
    sheets: {
        name: string;
        preview: string[][];
    }[];
}
interface Mapping {
    sheet: string;
    startRow: number;
    personColumn: number;
    dateColumn?: number;
    hoursColumn?: number;
    projectColumn?: number;
    statusColumn?: number;
    dateHeaderRow?: number;
    dateStartColumn?: number;
}
interface Issue {
    code: string;
    person: string;
    date: string;
    message: string;
}
interface Result {
    issues: Issue[];
    canFinalize: boolean;
    personTotals: Record<string, number>;
    projectTotals: Record<string, number>;
    days: {
        person: string;
        date: string;
        rd: number;
        department: number;
        project: string;
        basis: string;
    }[];
}
interface Override {
    hours?: number;
    person: string;
    date: string;
    status: string;
    project: string;
    source: string;
}
interface InputData {
    workbenchId?:number;
    periodId?:number;
    month: string;
    templateId: string;
    rdId: string;
    attendanceId: string;
    rdMapping: Mapping;
    attendanceMapping: Mapping;
    projects: string[];
    assignments: Record<string, string|string[]>;
    requiredPeople?:string[];
    rdComplete: boolean;
    aliases?: Record<string, string>;
    exclusions?: Record<string, string>;
    overrides: Override[];
}
const defaultMap: Mapping = { sheet: '', startRow: 2, personColumn: 1, dateColumn: 2, hoursColumn: 3, projectColumn: 4, statusColumn: 3 };
export default function TimesheetsPage(props:{workbenchId?:number;periodId?:number;runId?:number;initialMonth?:string}={}) {return <MonthlyTimesheet {...props}/>;}
export function LegacyTimesheetsPage({workbenchId,periodId,runId,initialMonth}:{workbenchId?:number;periodId?:number;runId?:number;initialMonth?:string}={}) {
    const { busy, run } = useAction(), history = useApi<{
        items: {
            id: number;
            month: string;
            status: string;
        }[];
    }>(`/api/timesheets?${new URLSearchParams({...workbenchId?{workbenchId:String(workbenchId)}:{},...periodId?{periodId:String(periodId)}:{}})}`);
    const [month, setMonth] = useState(initialMonth??''), [template, setTemplate] = useState<Source | null>(null), [rd, setRd] = useState<Source | null>(null), [attendance, setAttendance] = useState<Source | null>(null), [rdMap, setRdMap] = useState<Mapping>({ ...defaultMap }), [attMap, setAttMap] = useState<Mapping>({ ...defaultMap }), [projects, setProjects] = useState(''), [assignments, setAssignments] = useState(''), [aliases, setAliases] = useState(''), [exclusions, setExclusions] = useState(''), [rdComplete, setRdComplete] = useState(false), [overrides, setOverrides] = useState<Override[]>([]), [current, setCurrent] = useState<{
        id: number;
        result: Result;
        status: string;
        signature: string;
    } | null>(null), [reviewed, setReviewed] = useState(false);
    const [requiredPeople,setRequiredPeople]=useState('');
    const library=useApi<{items:{id:number;name:string;work_type_id:number|null}[]}>('/api/templates');
    const [libraryId,setLibraryId]=useState('');
    const [scope,setScope]=useState({workbenchId,periodId});
    const signature = JSON.stringify([month, template?.id, rd?.id, attendance?.id, rdMap, attMap, projects, assignments, rdComplete, overrides, aliases, exclusions, requiredPeople]);
    const stale = !!current && current.signature !== signature;
    useEffect(() => { setReviewed(false); }, [signature]);
    const upload = (file: File | undefined, set: (s: Source) => void, map?: Mapping, setMap?: (m: Mapping) => void) => { if (!file)
        return; void run(async () => { const form = new FormData(); form.append('file', file); const s = await api.upload<Source>('/api/timesheets/sources', form); set(s); if (map && setMap)
        setMap({ ...map, sheet: s.sheets[0]?.name ?? '' }); setCurrent(null); }); };
    const calculate = () => run(async () => { const pairs = assignments.split('\n').filter(x => x.trim()).map(line => { const parts = line.split('='); if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim())
        throw new Error('人员分配格式：人员=正式项目名'); return [parts[0].trim(), parts[1].split('|').map(p=>p.trim()).filter(Boolean)] as const; }); if (new Set(pairs.map(p => p[0])).size !== pairs.length)
        throw new Error('人员分配存在重复姓名'); const parsePairs = (text: string) => { const rows = text.split('\n').filter(x => x.trim()).map(x => { const at = x.indexOf('='); if (at < 1 || !x.slice(at + 1).trim()) throw new Error('请按 姓名=对应姓名或排除依据 填写'); return [x.slice(0, at).trim(), x.slice(at + 1).trim()]; }); if (new Set(rows.map(x => x[0])).size !== rows.length) throw new Error('同一姓名不能重复配置'); return Object.fromEntries(rows); }; const input: InputData = { ...scope,requiredPeople:requiredPeople.split('\n').map(p=>p.trim()).filter(Boolean),aliases: parsePairs(aliases), exclusions: parsePairs(exclusions), month, templateId: template?.id ?? '', rdId: rd?.id ?? '', attendanceId: attendance?.id ?? '', rdMapping: rdMap, attendanceMapping: attMap, projects: projects.split('\n').map(x => x.trim()).filter(Boolean), assignments: Object.fromEntries(pairs), rdComplete, overrides }; const r = await api.post<Result & {
        id: number;
    }>('/api/timesheets', input); setCurrent({ id: r.id, result: r, status: 'draft', signature }); setReviewed(false); history.reload(); });
    const load = (id: number) => run(async () => { const r = await api.get<{
        id: number;
        input: InputData;
        result: Result;
        status: string;
    }>(`/api/timesheets/${id}`); const i = r.input; if(workbenchId && i.workbenchId!==workbenchId || periodId && i.periodId!==periodId)throw new Error('工时记录不属于当前工作或期次');setScope({workbenchId:i.workbenchId,periodId:i.periodId});setRequiredPeople((i.requiredPeople??[]).join('\n'));setMonth(i.month); setTemplate({ id: i.templateId, name: '本次模板副本', sheets: [] }); setRd({ id: i.rdId, name: '本次研发副本', sheets: [] }); setAttendance({ id: i.attendanceId, name: '本次考勤副本', sheets: [] }); setRdMap(i.rdMapping); setAttMap(i.attendanceMapping); setProjects(i.projects.join('\n')); setAssignments(Object.entries(i.assignments).map(([p, v]) => `${p}=${Array.isArray(v)?v.join('|'):v}`).join('\n')); setAliases(Object.entries(i.aliases ?? {}).map(([p,v]) => `${p}=${Array.isArray(v)?v.join('|'):v}`).join('\n')); setExclusions(Object.entries(i.exclusions ?? {}).map(([p,v]) => `${p}=${Array.isArray(v)?v.join('|'):v}`).join('\n')); setRdComplete(i.rdComplete); setOverrides(i.overrides ?? []); setCurrent({ ...r, signature: JSON.stringify([i.month, i.templateId, i.rdId, i.attendanceId, i.rdMapping, i.attendanceMapping, i.projects.join('\n'), Object.entries(i.assignments).map(([p, v]) => `${p}=${Array.isArray(v)?v.join('|'):v}`).join('\n'), i.rdComplete, i.overrides ?? [], Object.entries(i.aliases ?? {}).map(([p,v]) => `${p}=${Array.isArray(v)?v.join('|'):v}`).join('\n'), Object.entries(i.exclusions ?? {}).map(([p,v]) => `${p}=${Array.isArray(v)?v.join('|'):v}`).join('\n'),(i.requiredPeople??[]).join('\n')]) }); setReviewed(false); });
    useEffect(()=>{if(runId)void load(runId);},[runId]);
    return <div className="col" style={{ gap: 14 }}><Card title="部门工时 · 导入与映射">
 {scope.workbenchId&&<p>所属工作 #{scope.workbenchId}{scope.periodId?` · 期次 #${scope.periodId}`:''}。重新计算会保留此归属。</p>}
 <p>研发优先，每人每天最多 8 小时。未知考勤、半天假和项目归属不明确时停止自动分配。文件只在本机保存副本。</p>
 <Field label="目标年月"><Input type="month" value={month} onChange={setMonth} disabled={!!initialMonth}/></Field>
 <Field label="复用模板库中的部门工时格式"><Select value={libraryId} onChange={setLibraryId} options={[{value:'',label:'选择与当月天数一致的模板'},...(library.data?.items??[]).filter(t=>t.name.startsWith('建设管理部月度工时明细表')).map(t=>({value:String(t.id),label:t.name}))]}/><Button disabled={busy||!libraryId} onClick={()=>void run(async()=>{setTemplate(await api.post<Source>(`/api/timesheets/library/${libraryId}`,{}));setCurrent(null);})}>使用模板副本</Button>{libraryId&&<a href={`/api/templates/${libraryId}/file`} download>下载填写人员和项目</a>}<p>先下载模板副本填写当月真实人员和正式项目，再从“部门模板”导入；保留原表公式与校验页。</p></Field>
 <div className="grid grid-3">{([{ label: '部门模板', s: template, set: setTemplate }, { label: '研发工时', s: rd, set: setRd, map: rdMap, setMap: setRdMap }, { label: '考勤记录', s: attendance, set: setAttendance, map: attMap, setMap: setAttMap }]).map(c => <Field key={c.label} label={c.label}><input type="file" accept=".xlsx" disabled={busy} onChange={e => upload(e.target.files?.[0], c.set, c.map, c.setMap)}/><span>{c.s?.name ?? '尚未导入'}</span></Field>)}</div>
 <p>模板要求：工作表“工时明细表（填写）”，C 列人员、D 列工时类型（填写“部门工时”或“服务工时”，保留“研发工时”）、E 列正式项目名、I 列起为日期，行末为 SUM 月合计。请提供与目标月份天数相符的模板。</p>
 {rd && <MappingEditor title="研发映射" source={rd} mapping={rdMap} onChange={setRdMap} wide/>}
 {attendance && <MappingEditor title="考勤映射" source={attendance} mapping={attMap} onChange={setAttMap} wide/>}
 <p>考勤可选每人每天一行或横向日期表；原始打卡时间和空白不会被猜测为正常出勤，须人工确认。状态表状态可填“工作、项目外出、请假、调休、考试、休息、承揽业务、技术交流、洽谈项目”；日期可填 YYYY-MM-DD 或当月日号。休息日也须明确列出，不根据星期推断。</p>
 <label><input type="checkbox" checked={rdComplete} onChange={e => setRdComplete(e.target.checked)}/> 我已确认研发文件完整，缺少的人员 / 日期代表零研发工时</label>
 <div className="grid grid-2"><Field label="本月已成立的正式项目（一行一个）"><Textarea value={projects} onChange={setProjects}/></Field><Field label="当期参与项目（人员=项目甲|项目乙，一行一人；普通办公日自动均分）"><Textarea value={assignments} onChange={setAssignments}/></Field></div>
 <div className="grid grid-2"><Field label="确认人员别名（输入姓名=模板姓名）"><Textarea value={aliases} onChange={setAliases}/></Field><Field label="确认排除非本部门人员（输入姓名=排除依据）"><Textarea value={exclusions} onChange={setExclusions}/></Field></div>
 <Field label="部门全体应填报人员（一行一人，独立于模板核对完整性）"><Textarea value={requiredPeople} onChange={setRequiredPeople}/></Field><p>普通办公日按当期参与项目均分研发扣除后的剩余工时，精确到0.01小时；考勤指定项目及人工逐日调整优先。未匹配人员将阻止定稿。别名和排除同时用于研发及考勤，随本次记录保留；不能排除模板内人员。</p>
 <Button disabled={busy || !template || !rd || !attendance || !month || !requiredPeople.trim()} onClick={() => void calculate()}>计算并保存新的核对记录</Button>
 </Card>
 {current && <Card title={`核对结果 #${current.id} · ${current.status === 'final' ? '已定稿' : '草稿'}`}>
 {stale && <p role="alert">输入或人工调整已改变，下方仍是原记录。请重新计算，再核对新文件并定稿。</p>}
 <p>{current.result.canFinalize ? '计算校验通过，请下载核对版式与原始资料。' : `存在 ${current.result.issues.length} 项异常，尚不能定稿。`}</p>
 <div className="grid grid-2"><div><h4>人员部门工时合计</h4>{Object.entries(current.result.personTotals).map(([k, v]) => <p key={k}>{k}：{v} 小时</p>)}</div><div><h4>项目部门工时合计</h4>{Object.entries(current.result.projectTotals).map(([k, v]) => <p key={k}>{k}：{v} 小时</p>)}</div></div>
 <div style={{ maxHeight: 350, overflow: 'auto' }}><table className="table"><thead><tr><th>人员</th><th>日期</th><th>异常</th><th>处理</th></tr></thead><tbody>{current.result.issues.map((i, n) => <tr key={n}><td>{i.person}</td><td>{i.date}</td><td>{i.message}</td><td>{['ATT_UNKNOWN', 'ATT_MISSING', 'PROJECT_UNKNOWN'].includes(i.code) && <Button disabled={busy} onClick={() => setOverrides(old => old.some(x => x.person === i.person && x.date === i.date) ? old : [...old, { person: i.person, date: i.date, status: 'work', project: '', source: '' }])}>人工确认</Button>}</td></tr>)}</tbody></table></div>
 {overrides.map((o, n) => <div className="row" key={`${o.person}-${o.date}`}><span>{o.person} {o.date}</span><Select value={o.status} onChange={v => setOverrides(a => a.map((x, i) => i === n ? { ...x, status: v } : x))} options={[{ value: 'work', label: '工作' }, { value: 'project', label: '项目外出' }, { value: 'leave', label: '不计项目工时的请假等' }, { value: 'rest', label: '休息' }, { value: 'excluded', label: '不计入的活动' }]}/><Input value={o.project} onChange={v => setOverrides(a => a.map((x, i) => i === n ? { ...x, project: v } : x))} placeholder="正式项目名"/><Input type="number" value={String(o.hours ?? '')} onChange={v => setOverrides(a => a.map((x, i) => i === n ? { ...x, hours: v ? Number(v) : undefined } : x))} placeholder="确认部门小时（可选）"/><Input value={o.source} onChange={v => setOverrides(a => a.map((x, i) => i === n ? { ...x, source: v } : x))} placeholder="必须填写确认依据"/><Button onClick={() => setOverrides(a => a.filter((_, i) => i !== n))}>撤除调整</Button></div>)}
 {overrides.length > 0 && <p>调整只在再次计算时生效，旧记录保持不变。半天或混合活动请明确填写经确认的部门工时和依据，不能默认按全天处理。</p>}
 <div className="row"><Button onClick={() => api.download(`/api/timesheets/${current.id}/export`)}>下载工时表与校验明细</Button><label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)}/> 已实际核对本次导出文件和计算依据</label><Button disabled={busy || stale || !reviewed || !current.result.canFinalize || current.status === 'final'} onClick={() => void run(async () => { await api.post(`/api/timesheets/${current.id}/finalize`, { reviewed: true }); setCurrent({ ...current, status: 'final' }); history.reload(); })}>定稿本次记录</Button></div>
 <details><summary>逐人逐日计算依据</summary><div style={{ maxHeight: 400, overflow: 'auto' }}><table className="table"><tbody>{current.result.days.map(d => <tr key={`${d.person}-${d.date}-${d.project}`}><td>{d.person}</td><td>{d.date}</td><td>研发 {d.rd}</td><td>部门 {d.department}</td><td>{d.project}</td><td>{d.basis}</td><td><Button size="sm" disabled={busy} onClick={()=>setOverrides(old=>old.some(o=>o.person===d.person&&o.date===d.date)?old:[...old,{person:d.person,date:d.date,status:'work',project:d.project,hours:d.department,source:''}])}>调整此日</Button></td></tr>)}</tbody></table></div></details>
 </Card>}
 <Card title="历史运行记录">{history.data?.items.map(r => <p key={r.id}><Button onClick={() => void load(r.id)}>#{r.id} · {r.month} · {r.status === 'final' ? '已定稿' : '草稿'}</Button></p>)}</Card></div>;
}
function MappingEditor({ title, source, mapping: m, onChange, wide = false }: {
    title: string;
    source: Source;
    mapping: Mapping;
    onChange: (m: Mapping) => void;
    wide?: boolean;
}) {
    const isWide = !!m.dateHeaderRow;
    const columns: [
        keyof Mapping,
        string
    ][] = [['startRow', '数据起始行'], ['personColumn', '人员列'], ['projectColumn', '项目列（可选）'], ...(wide && isWide ? [['dateHeaderRow', '日期表头行'], ['dateStartColumn', '日期开始列']] : wide && title.includes('研发') ? [['dateColumn', '日期列'], ['hoursColumn', '工时列']] : [['dateColumn', '日期列'], ['statusColumn', '状态列']]) as [
            keyof Mapping,
            string
        ][]];
    return <details open><summary>{title}</summary><Field label="工作表"><Input value={m.sheet} onChange={v => onChange({ ...m, sheet: v })}/></Field>{wide && <label><input type="checkbox" checked={isWide} onChange={e => onChange({ ...m, dateHeaderRow: e.target.checked ? 3 : undefined, dateStartColumn: e.target.checked ? 9 : undefined })}/> 横向日期表（日期从 I 列开始）</label>}<div className="grid grid-3">{columns.map(([key, label]) => <Field key={key} label={`${label}（A=1，C=3，I=9）`}><Input type="number" value={String(m[key] ?? '')} onChange={v => onChange({ ...m, [key]: v ? Number(v) : undefined })}/></Field>)}</div><details><summary>输入预览（前 12 行）</summary>{source.sheets.map(s => <div key={s.name} style={{ overflow: 'auto' }}><h4>{s.name}</h4><table className="table"><tbody>{s.preview.map((r, i) => <tr key={i}><th>{i + 1}</th>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>)}</details></details>;
}
