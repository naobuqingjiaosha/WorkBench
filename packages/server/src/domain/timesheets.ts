import {checkedOfficeBytes,readOfficeBytes} from '../core/office-package.ts';
import ExcelJS from 'exceljs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT } from '../core/config.ts';
import { get, run, tx } from '../db/index.ts';
import { prepareDepartmentBook, refreshTimesheetSummary } from './timesheet-layout.ts';
import {normalizeExcel} from '../core/office-import.ts';
import { ApiError } from '../api/reply.ts';
import { requirePeriod, requireWorkbench } from './periods.ts';
import { workbenchOutputDirAbs } from './service.ts';
import { saveArtifact, artifactAbsPath, getArtifact } from '../core/store.ts';
import { markFinal } from './versions.ts';
import { assertFinalArtifact } from './finalization.ts';
export const TIMESHEET_RULE_VERSION = '2026-10-21.5';
const ROOT = () => join(DATA_ROOT, '_工时处理');
export interface Source {
    id: string;
    name: string;
    digest: string;
}
export interface Mapping {
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
export interface DayInput {
    person: string;
    date: string;
    hours?: number;
    project?: string;
    status?: string;
    source: string;
}
export interface Allocation {
    person: string;
    date: string;
    rd: number;
    department: number;
    project: string;
    basis: string;
}
export interface Issue {
    severity?: 'warning';
    code: string;
    person: string;
    date: string;
    message: string;
}
export interface Calculation {
    days: Allocation[];
    issues: Issue[];
    personTotals: Record<string, number>;
    projectTotals: Record<string, number>;
    canFinalize: boolean;
}
export function monthDays(month: string): number {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))
        throw new ApiError('BAD_MONTH', '年月格式为 YYYY-MM（2000—2099）');
    return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
}
function sourcePath(id: string): string { if (!/^[0-9a-f-]{36}$/.test(id))
    throw new ApiError('BAD_SOURCE', '输入文件编号无效'); return join(ROOT(), 'inputs', id + '.xlsx'); }
export async function storeTimesheetSource(name: string, bytes: Buffer) {
    if (!/\.xlsx?$/i.test(name) || bytes.length > 20 * 1024 * 1024)
        throw new ApiError('BAD_FILE', '请提供不超过 20MB 的 XLSX 文件；PDF 考勤需先人工核对为表格');
    bytes=await normalizeExcel(bytes);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(checkedOfficeBytes(bytes) as never);
    if (!book.worksheets.length) throw new ApiError('EMPTY_WORKBOOK','文件缺少工作簿或工作表数据，请在 Excel 中打开原件并另存为有效 XLSX；不能使用只有主题的文件');
    if (book.worksheets.some(s => s.rowCount > 10000 || s.columnCount > 400))
        throw new ApiError('TOO_LARGE', '表格超过 10000 行或 400 列，请拆分后导入');
    const id = randomUUID(), digest = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(join(ROOT(), 'inputs'), { recursive: true });
    writeFileSync(sourcePath(id), bytes, { flag: 'wx' });
    run('INSERT INTO timesheet_source(id,name,digest) VALUES(?,?,?)', [id, name, digest]);
    return { id, name, digest, sheets: book.worksheets.map(s => ({ name: s.name, rows: s.rowCount, preview: Array.from({ length: Math.min(s.rowCount, 12) }, (_, i) => Array.from({ length: Math.min(s.columnCount, 45) }, (_, j) => s.getCell(i + 1, j + 1).text)) })) };
}
export async function readSource(id: string) {
    const source = get<Source>('SELECT * FROM timesheet_source WHERE id=?', [id]);
    if (!source)
        throw new ApiError('SOURCE_MISSING', '输入文件不存在', 404);
    const bytes = readFileSync(sourcePath(id));
    if (createHash('sha256').update(bytes).digest('hex') !== source.digest)
        throw new ApiError('SOURCE_CHANGED', '输入副本已被修改，请重新导入');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(checkedOfficeBytes(bytes) as never);
    return { source, book };
}
function dateValue(value: unknown, month: string): string {
    if (value instanceof Date)
        return value.toISOString().slice(0, 10);
    const text = String(value ?? '').trim();
    if (/^\d{1,2}$/.test(text)) {
        const day = Number(text);
        if (day >= 1 && day <= monthDays(month))
            return `${month}-${String(day).padStart(2, '0')}`;
    }
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(text)) {
        const a = text.split(/[-/]/);
        return `${a[0]}-${a[1]!.padStart(2, '0')}-${a[2]!.padStart(2, '0')}`;
    }
    throw new ApiError('BAD_CELL_DATE', `不能识别日期：${text}`);
}
function scalar(c: ExcelJS.Cell): unknown {
    const v = c.value;
    if (v && typeof v === 'object' && 'formula' in v) {
        if (v.result === undefined)
            throw new ApiError('FORMULA_NOT_CALCULATED', `${c.address} 公式没有计算结果，请在 Excel 中计算并保存`);
        return v.result;
    }
    return v instanceof Date ? v : c.text;
}
export async function readMapped(id: string, m: Mapping, month: string, kind: 'rd' | 'attendance'): Promise<DayInput[]> {
    monthDays(month);
    const { book, source } = await readSource(id), s = book.getWorksheet(m.sheet);
    if (!s)
        throw new ApiError('BAD_SHEET', '请选择实际存在的工作表');
    const cover=book.getWorksheet('封面');
    if(cover&&Number(cover.getCell('C8').value)&&Number(cover.getCell('E8').value)&&`${cover.getCell('C8').value}-${String(cover.getCell('E8').value).padStart(2,'0')}`!==month)throw new ApiError('WRONG_MONTH',`${source.name} 封面年月与 ${month} 不一致`);
    for(let r=1;r<=Math.min(10,s.rowCount);r++){const match=s.getRow(r).values?.toString().match(/统计日期[:：]\s*(20\d{2})[/-](\d{1,2})/);if(match&&`${match[1]}-${match[2]!.padStart(2,'0')}`!==month)throw new ApiError('WRONG_MONTH',`${source.name} 考勤统计月份与 ${month} 不一致`);}
    for (const n of [m.startRow, m.personColumn, ...[m.dateColumn, m.hoursColumn, m.projectColumn, m.statusColumn, m.dateHeaderRow, m.dateStartColumn].filter(x => x !== undefined)])
        if (!Number.isInteger(n) || n! <= 0 || n! > 10000)
            throw new ApiError('BAD_MAPPING', '行列编号必须为正整数');
    const wide = m.dateHeaderRow && m.dateStartColumn;
    if (!wide && (!m.dateColumn || (kind === 'rd' ? !m.hoursColumn : !m.statusColumn)))
        throw new ApiError('BAD_MAPPING', '请补齐日期、工时或考勤状态列');
    const rows: DayInput[] = [];
    for (let r = m.startRow; r <= s.rowCount; r++) {
        const person = s.getCell(r, m.personColumn).text.trim();
        if (!person || /^(合计|总计|小计)$/.test(person.replace(/\s/g,'')))
            continue;
        const project = m.projectColumn ? s.getCell(r, m.projectColumn).text.trim() : '';
        const push = (date: string, hours: unknown, status: string, cell: string) => {
            if (!date.startsWith(month + '-') || Number(date.slice(8)) < 1 || Number(date.slice(8)) > monthDays(month))
                throw new ApiError('WRONG_MONTH', `${source.name} ${cell} 不属于目标月份`);
            const num = hours === '' || hours == null ? 0 : Number(hours);
            if (kind === 'rd' && (!Number.isFinite(num) || num < 0))
                throw new ApiError('BAD_HOURS', `${source.name} ${cell} 工时必须为非负数`);
            rows.push({ person, date, hours: kind === 'rd' ? num : undefined, status: kind === 'attendance' ? status : undefined, project, source: `${source.name} / ${s.name} / ${cell}` });
        };
        if (wide) {
            for (let d = 0; d < monthDays(month); d++) {
                const col = m.dateStartColumn! + d;
                const cell=s.getCell(r,col);
                push(dateValue(scalar(s.getCell(m.dateHeaderRow!, col)), month), kind==='rd'?scalar(cell):0,kind==='attendance'?(cell.text.trim()||'未注明考勤状态'):'',cell.address);
            }
        }
        else {
            const dateCell = s.getCell(r, m.dateColumn!);
            if (!dateCell.text.trim())
                continue;
            push(dateValue(scalar(dateCell), month), kind === 'rd' ? scalar(s.getCell(r, m.hoursColumn!)) : 0, kind === 'attendance' ? s.getCell(r, m.statusColumn!).text.trim() : '', dateCell.address);
        }
    }
    if (!rows.length)
        throw new ApiError('EMPTY_INPUT', '映射未读到任何数据，请检查起始行和列编号');
    return rows;
}
const attendanceCodes: Record<string, string> = { '工作': 'work', '正常': 'work', '项目外出': 'project', '出差': 'project', '请假': 'leave', '调休': 'leave', '考试': 'leave', '休息': 'rest', '承揽业务': 'excluded', '技术交流': 'excluded', '洽谈项目': 'excluded', '半天': 'unknown' };
export function calculateTimesheet(input: {
    month: string;
    rd: DayInput[];
    attendance: DayInput[];
    people: string[];
    projects: string[];
    assignments: Record<string, string|string[]>;
    requiredPeople?: string[];
    rdComplete: boolean;
    aliases?: Record<string, string>;
    exclusions?: Record<string, string>;
    overrides?: DayInput[];
}): Calculation {
    const count = monthDays(input.month), issues: Issue[] = [], days: Allocation[] = [], personTotals: Record<string, number> = Object.create(null), projectTotals: Record<string, number> = Object.create(null);
    const issue = (code: string, person: string, date: string, message: string) => issues.push({ code, person, date, message });
    const rd = new Map<string, number>(), att = new Map<string, DayInput>(), people = new Set(input.people), projects = new Set(input.projects);
    if(input.requiredPeople){
      if(!input.requiredPeople.length||new Set(input.requiredPeople).size!==input.requiredPeople.length||input.requiredPeople.some(p=>typeof p!=='string'||!p.trim()))issue('ROSTER_INVALID','','','全体应填报人员名单为空、重复或无效');
      for(const p of input.requiredPeople)if(!people.has(p))issue('PERSON_ROW_MISSING',p,'','应填报人员未出现在部门模板，请补齐模板副本');
      for(const p of people)if(!input.requiredPeople.includes(p))issue('ROSTER_MISMATCH',p,'','模板人员未列入已确认的应填报名单，请核对');
    }
    if (!input.rdComplete)
        issue('RD_UNCONFIRMED', '', '', '请确认研发文件完整，缺失人员 / 日期代表零研发工时');
    const aliases = input.aliases ?? {}, exclusions = input.exclusions ?? {};
    for (const [alias, target] of Object.entries(aliases)) {
        if (!alias.trim() || !people.has(target) || (people.has(alias) && alias !== target) || Object.hasOwn(exclusions, alias))
            issue('ALIAS_INVALID', alias, '', '别名必须指向模板中的人员，且不能与正式姓名或排除规则冲突');
    }
    for (const [person, reason] of Object.entries(exclusions)) {
        if (people.has(person) || !reason.trim() || Object.hasOwn(aliases, person))
            issue('EXCLUSION_INVALID', person, '', '只能排除模板以外的人员，须填写依据且不能同时映射');
    }
    const resolvePerson = (row: DayInput): DayInput | null => {
        if (Object.hasOwn(exclusions, row.person) && exclusions[row.person]!.trim() && !people.has(row.person)) return null;
        const person = Object.hasOwn(aliases, row.person) ? aliases[row.person]! : row.person;
        if (!people.has(person)) {
            issue('PERSON_UNKNOWN', row.person, row.date, `人员未匹配模板：${row.source}；请确认别名或注明不属于本部门的排除依据`);
            return null;
        }
        return { ...row, person, source: row.source + (person !== row.person ? `；确认别名：${row.person} → ${person}` : '') };
    };
    for (const sourceRow of input.rd) {
        const row = resolvePerson(sourceRow);
        if (!row) continue;
        const k = `${row.person}|${row.date}`;
        if (!row.date.startsWith(input.month + '-') || Number(row.date.slice(8)) < 1 || Number(row.date.slice(8)) > count || !Number.isFinite(row.hours) || row.hours! < 0) {
            issue('RD_INVALID', row.person, row.date, '研发数据日期或工时无效');
            continue;
        }
        rd.set(k, (rd.get(k) ?? 0) + row.hours!);
    }
    for (const sourceRow of input.attendance) {
        const row = resolvePerson(sourceRow);
        if (!row) continue;
        const k = `${row.person}|${row.date}`;
        if (att.has(k))
            issue('ATT_DUPLICATE', row.person, row.date, '同人同日有多条考勤，请修正输入');
        else
            att.set(k, row);
    }
    const overrideKeys = new Set<string>();
    for (const row of input.overrides ?? []) {
        const k = `${row.person}|${row.date}`;
        if (!people.has(row.person) || !row.date.startsWith(input.month + '-') || Number(row.date.slice(8)) < 1 || Number(row.date.slice(8)) > count || !row.source.trim() || overrideKeys.has(k)) {
            issue('OVERRIDE_INVALID', row.person, row.date, '人工调整须属于目标人日、填写原因且不可重复');
            continue;
        }
        overrideKeys.add(k);
        att.set(k, { ...row, source: '人工确认：' + row.source });
    }
    for (const [key, h] of rd)
        if (h > 8) {
            const [person, date] = key.split('|');
            issue('RD_OVER_8', person!, date!, '研发工时自身超过 8 小时，必须修正输入');
        }
    for (const person of people) {
        personTotals[person] = 0;
        for (let d = 1; d <= count; d++) {
            const date = `${input.month}-${String(d).padStart(2, '0')}`, key = `${person}|${date}`, hours = rd.get(key) ?? 0, a = att.get(key);
            let department = 0, project = '', basis = a?.source ?? '';
            const status = a ? (attendanceCodes[a.status ?? ''] ?? a.status) : undefined;
            if (!a)
                issue('ATT_MISSING', person, date, '缺少已确认的考勤 / 排班，不能按星期猜测');
            else if (['leave', 'rest', 'excluded'].includes(status ?? '')) {
                if(hours>0)issue('RD_ATT_CONFLICT',person,date,'研发工时与明确休息、缺勤或不计工时的考勤冲突，请核对来源；不得自动视为满勤');
                basis += `；${a.status} 不分配部门工时`;
            }
            else if (status === 'work' || status === 'project') {
                const assignment=input.assignments[person];
                const candidates=a.project?[a.project]:typeof assignment==='string'?[assignment]:Array.isArray(assignment)?assignment:[];
                const targets=[...new Set(candidates)];
                project = targets[0] || '';
                const available = Math.max(0, 8 - hours);
                if (available > 0 && (!targets.length || targets.some(p=>typeof p!=='string'||!projects.has(p))))
                    issue('PROJECT_UNKNOWN', person, date, '可分配工时的项目归属未明确，或项目未列入已成立项目清单');
                else if (input.rdComplete && hours <= 8) {
                    const requested = overrideKeys.has(key) && a.hours !== undefined ? a.hours : available;
                    if (!Number.isFinite(requested) || requested < 0 || requested > available)
                        issue('OVERRIDE_HOURS', person, date, '人工确认部门工时必须在研发扣除后的可用上限内');
                    else
                        department = requested;
                }
                basis += `；研发优先：8 - ${hours}；项目依据：${a.project ? '考勤项目' : '本次确认分配'}`;
                if(department>0&&targets.length>1){
                    // Split hundredths deterministically; the final total is exactly the available department time.
                    const units=Math.floor((department+1e-9)*100),base=Math.floor(units/targets.length),remainder=units%targets.length;
                    department=units/100;
                    targets.forEach((target,i)=>{const share=(base+(i<remainder?1:0))/100;days.push({person,date,rd:i===0?hours:0,department:share,project:target,basis:basis+`；本日研发合计 ${hours}；按当期参与的 ${targets.length} 个项目均分（0.01小时，余数依清单顺序）`});projectTotals[target]=(projectTotals[target]??0)+share;});
                    personTotals[person]+=department;
                    continue;
                }
            }
            else
                issue('ATT_UNKNOWN', person, date, `考勤“${a.status ?? ''}”待确认（半天或混合活动不可自动推断）`);
            days.push({ person, date, rd: hours, department, project, basis });
            personTotals[person] += department;
            if (project)
                projectTotals[project] = (projectTotals[project] ?? 0) + department;
        }
    }
    for(const totals of [personTotals,projectTotals])for(const key of Object.keys(totals))totals[key]=Number(totals[key]!.toFixed(10));
    return { days, issues, personTotals, projectTotals, canFinalize: issues.length === 0 };
}
interface Layout {
    sheet: ExcelJS.Worksheet;
    headerRow: number;
    totalCol: number;
    rows: {
        row: number;
        person: string;
        project: string;
    }[];
}
export function departmentLayout(book: ExcelJS.Workbook, month: string): Layout {
    const sheet = book.getWorksheet('工时明细表（填写）');
    if (!sheet)
        throw new ApiError('BAD_TEMPLATE', '部门模板缺少“工时明细表（填写）”');
    monthDays(month);
    let headerRow = 0;
    for (let r = 1; r <= Math.min(20, sheet.rowCount); r++) {
        try {
            let matches = true;
            for (let d = 1; d <= 28; d++) {
                if (Number(dateValue(scalar(sheet.getCell(r, 8 + d)), month).slice(8)) !== d) {
                    matches = false;
                    break;
                }
            }
            if (matches) {
                headerRow = r;
                break;
            }
        }
        catch { }
    }
    if (!headerRow)
        throw new ApiError('BAD_TEMPLATE', '无法在 I 列开始识别完整日期表头；请使用对应月份模板或调整表格');
    let totalCol = 0;
    for(let r=headerRow+1;r<=sheet.rowCount&&!totalCol;r++)for(let c=37;c<=40;c++){
        const formula=sheet.getCell(r,c).formula?.replace(/\$/g,'').toUpperCase();
        if(formula===`SUM(I${r}:${sheet.getColumn(c-1).letter}${r})`){totalCol=c;break;}
    }
    if(!totalCol)throw new ApiError('BAD_TOTAL','无法识别行合计公式，请核对部门模板');
    const rows: Layout['rows'] = [];
    for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
        const person = sheet.getCell(r, 3).text.trim(), project = sheet.getCell(r, 5).text.trim();
        if (!person || !project || /合计|总计|小计/.test(person.replace(/\s/g,'')))
            continue;
        if(/[{}]/.test(person+project))throw new ApiError('ROSTER_REQUIRED','部门模板仍含人员或项目占位符，请先在模板副本中填写真实人员和正式项目名称后导入');
        const kind = sheet.getCell(r, 4).text.trim();
        if(person==='人员'&&kind==='工时类型')continue; // Merged two-row date headers repeat these labels.
        if (kind === '研发工时') continue;
        if (!['部门工时','服务工时'].includes(kind)) throw new ApiError('UNKNOWN_ROW_TYPE', `模板第 ${r} 行 D 列工时类型“${kind}”未确认；仅填写“部门工时”或“服务工时”，保留“研发工时”`);
        const formula = sheet.getCell(r, totalCol).formula ?? '';
        const last = sheet.getColumn(totalCol - 1).letter;
        if (formula.replace(/\$/g, '').toUpperCase() !== `SUM(I${r}:${last}${r})`)
            throw new ApiError('BAD_TOTAL', `模板第 ${r} 行月合计应为 SUM(I${r}:${last}${r})，请核对映射`);
        if (rows.some(x => x.person === person && x.project === project))
            throw new ApiError('DUPLICATE_ROW', `模板“${person} / ${project}”存在重复行，请明确拆分规则`);
        rows.push({ row: r, person, project });
    }
    if (!rows.length)
        throw new ApiError('EMPTY_TEMPLATE', '模板没有识别到人员项目行');
    return { sheet, headerRow, totalCol, rows };
}
export interface RunInput {
    workbenchId?: number;
    periodId?: number;
    month: string;
    templateId: string;
    rdId: string;
    attendanceId: string;
    rdMapping: Mapping;
    attendanceMapping: Mapping;
    projects: string[];
    assignments: Record<string, string|string[]>;
    requiredPeople?: string[];
    rdComplete: boolean;
    aliases?: Record<string, string>;
    exclusions?: Record<string, string>;
    overrides?: DayInput[];
    attendanceSources?: {id:string;mapping:Mapping}[];
    payroll?: {workdays:number[];fullPay:boolean;deductions:Record<string,number>};
    allocations?: {person:string;date:string;shares:Record<string,number>;reason:string}[];
    projectAliases?: Record<string,string>;
}
export async function createTimesheetRun(input: RunInput) {
    input=structuredClone(input);
    // Rebuild source-derived decisions on every run; retain only explicit user edits.
    input.overrides=(input.overrides??[]).filter(o=>!o.source.startsWith('考勤明确项目：')&&!o.source.startsWith('用户确认扣薪工时：'));
    assertTimesheetScope(input);
    if (!Array.isArray(input.projects) || input.projects.some(p => typeof p !== 'string' || !p.trim()) || !input.assignments || typeof input.assignments !== 'object')
        throw new ApiError('BAD_INPUT', '请填写成立项目清单和人员分配');
    if(Array.isArray(input.assignments)||Object.values(input.assignments).some(v=>typeof v!=='string'&&(!Array.isArray(v)||v.some(p=>typeof p!=='string'||!p.trim())||!v.length)))throw new ApiError('BAD_INPUT','每人参与项目须为正式项目名或非空项目数组');
    if(input.requiredPeople!==undefined&&!Array.isArray(input.requiredPeople))throw new ApiError('BAD_INPUT','应填报人员名单须为数组');
    if(Object.entries(input.projectAliases??{}).some(([alias,p])=>alias.trim().length<2||!input.projects.includes(p)))throw new ApiError('BAD_PROJECT_ALIAS','项目简称须至少两个字，并对应本月已确认项目');
    const { book, source } = await readSource(input.templateId);
    await prepareDepartmentBook(book,input);
    let layout = departmentLayout(book, input.month);
    const rd = await readMapped(input.rdId, input.rdMapping, input.month, 'rd');
    let attendance = (await Promise.all([{id:input.attendanceId,mapping:input.attendanceMapping},...(input.attendanceSources??[])].map(s=>readMapped(s.id,s.mapping,input.month,'attendance')))).flat();
    const projectIssues:Issue[]=[];
    for(const a of attendance){
        if(!input.requiredPeople?.includes(a.person))continue;
        const text=a.status??'',explicit=input.overrides?.some(o=>o.person===a.person&&o.date===a.date);
        const matches=[...new Set([...input.projects.filter(p=>text.includes(p)),...Object.entries(input.projectAliases??{}).filter(([alias,p])=>alias.length>=2&&text.includes(alias)&&input.projects.includes(p)).map(([,p])=>p)])];
        if(matches.length===1&&!explicit&&(!input.payroll?.fullPay||input.payroll.workdays.includes(Number(a.date.slice(8))))){a.project=matches[0];input.overrides=[...(input.overrides??[]),{...a,status:'project',source:'考勤明确项目：'+text}];}
        else if(!explicit&&matches.length!==1&&/现场|驻场|出差|送货|安装|调试|项目实施|项目对接|北干|新二坝|小浪底|东山|平台建设|软件开发费/.test(text)&&rd.filter(r=>r.person===a.person&&r.date===a.date).reduce((s,r)=>s+(r.hours??0),0)<8)
            projectIssues.push({severity:'warning',code:'PROJECT_REMARK',person:a.person,date:a.date,message:`考勤项目线索“${text}”；暂按本月参与项目分配，可调整归属，个人总工时不变`});
        a.source+='；原始考勤：'+(text||'空白');
    }
    if(input.requiredPeople){const names=new Set(input.requiredPeople);for(const r of [...rd,...attendance])if(!names.has(input.aliases?.[r.person]??r.person))input.exclusions={...input.exclusions,[r.person]:'不在用户确认的人员范围内'};}
    if(input.payroll?.fullPay){
        const {workdays,deductions}=input.payroll;
        if(!workdays.length||new Set(workdays).size!==workdays.length||workdays.some(d=>!Number.isInteger(d)||d<1||d>monthDays(input.month)))throw new ApiError('BAD_CALENDAR','请确认本月实际应计薪日期，不可用星期自动代替');
        attendance=attendance.map(a=>({...a,status:workdays.includes(Number(a.date.slice(8)))?'work':'rest'}));
        for(const [key,h] of Object.entries(deductions)){
            const [person,date]=key.split('|');if(!input.requiredPeople?.includes(person!)||!date?.startsWith(input.month+'-')||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!workdays.includes(Number(date.slice(8)))||!Number.isFinite(h)||h<0||h>8)throw new ApiError('BAD_DEDUCTION','扣薪工时须为本月名单内应计薪人日及0—8小时');
        }
        // Preserve explicit manual edits. Deductions affect the paid daily cap, never just a project share.
        const custom=input.overrides??[];
        for(const a of attendance){const key=`${a.person}|${a.date}`,deduct=deductions[key];if(deduct===undefined)continue;
            const hours=rd.filter(r=>r.person===a.person&&r.date===a.date).reduce((s,r)=>s+(r.hours??0),0);
            if(hours>8-deduct)throw new ApiError('DEDUCTION_RD_CONFLICT',`${a.person} ${a.date} 研发工时超过扣薪后的可计工时，请核对`);
            const override=custom.find(o=>o.person===a.person&&o.date===a.date);
            if(override?.source.startsWith('考勤明确项目：'))override.hours=Math.max(0,8-deduct-hours);
            else if(!override)custom.push({...a,hours:Math.max(0,8-deduct-hours),source:'用户确认扣薪工时：'+deduct});
        }
        input.overrides=custom;
    }
    const result = calculateTimesheet({ ...input, rd, attendance, people: input.requiredPeople??[...new Set(layout.rows.map(r => r.person))] });
    if(input.payroll?.fullPay)for(const person of input.requiredPeople??[])for(let day=1;day<=monthDays(input.month);day++){
        const date=`${input.month}-${String(day).padStart(2,'0')}`,expected=input.payroll.workdays.includes(day)?8-(input.payroll.deductions[`${person}|${date}`]??0):0;
        const total=result.days.filter(d=>d.person===person&&d.date===date).reduce((sum,d)=>sum+d.rd+d.department,0);
        if(Math.abs(total-expected)>0.00001)result.issues.push({code:'PAID_DAY_TOTAL',person,date,message:`本日研发和部门工时合计${total}小时，应为${expected}小时；如确有扣薪请填写扣薪例外`});
    }
    result.issues.push(...projectIssues);
    const rebuilt=await readSource(input.templateId);await prepareDepartmentBook(rebuilt.book,input);layout=departmentLayout(rebuilt.book,input.month);
    for(const person of input.requiredPeople??[])if(!layout.rows.some(r=>r.person===person))result.issues.push({code:'PERSON_ROW_MISSING',person,date:'',message:'人员已加入计算范围，请补充其参与项目后自动建立导出行'});
    for(const edit of input.allocations??[]){
        const previous=result.days.filter(d=>d.person===edit.person&&d.date===edit.date),total=previous.reduce((s,d)=>s+d.department,0),shares=Object.entries(edit.shares);
        if(!previous.length||!edit.reason.trim()||!shares.length||shares.some(([p,h])=>!input.projects.includes(p)||!Number.isFinite(h)||h<0)||Math.abs(shares.reduce((s,[,h])=>s+h,0)-total)>0.00001)throw new ApiError('ALLOCATION_TOTAL','项目调整必须保留该人当日总工时；改变总工时请使用明确的逐日调整');
        result.days=result.days.filter(d=>d.person!==edit.person||d.date!==edit.date);
        shares.forEach(([project,department],n)=>result.days.push({person:edit.person,date:edit.date,project,department,rd:n===0?previous.reduce((s,d)=>s+d.rd,0):0,basis:'已确认项目调整：'+edit.reason}));
    }
    result.projectTotals={};for(const d of result.days)if(d.project)result.projectTotals[d.project]=Number(((result.projectTotals[d.project]??0)+d.department).toFixed(10));
    if(!input.requiredPeople)result.issues.push({code:'ROSTER_UNCONFIRMED',person:'',date:'',message:'尚未提供部门全体应填报人员名单；不能仅凭模板人员认定没有漏填'});
    for (const d of result.days)
        if (d.department > 0 && !layout.rows.some(r => r.person === d.person && r.project === d.project))
            result.issues.push({ code: 'ROW_MISSING', person: d.person, date: d.date, message: `模板没有项目“${d.project}”行，请在模板副本新增行后导入` });
    result.canFinalize = result.issues.every(i=>i.severity==='warning');
    const snapshot = { ...input, rd, attendance, templateDigest: source.digest, sourceFiles: [source, ...[input.rdId,input.attendanceId,...(input.attendanceSources??[]).map(s=>s.id)].map(id=>get<Source>('SELECT * FROM timesheet_source WHERE id=?',[id]))] };
    assertTimesheetScope(input);
    const id = run('INSERT INTO timesheet_run(month,input,result,rule_version,workbench_id,period_id) VALUES(?,?,?,?,?,?)', [input.month, JSON.stringify(snapshot), JSON.stringify(result), TIMESHEET_RULE_VERSION,input.workbenchId??null,input.periodId??null]).lastInsertRowid;
    return { id, ...result };
}
export function getTimesheetRun(id: number) { const row = get<{
    workbench_id: number|null;
    period_id: number|null;
    artifact_id: number|null;
    id: number;
    month: string;
    input: string;
    result: string;
    rule_version: string;
    status: string;
}>('SELECT * FROM timesheet_run WHERE id=?', [id]); if (!row)
    throw new ApiError('NOT_FOUND', '工时记录不存在', 404); return { ...row, input: JSON.parse(row.input) as RunInput, result: JSON.parse(row.result) as Calculation }; }

function assertTimesheetScope(input:RunInput):void {
 if(input.periodId&&!input.workbenchId)throw new ApiError('WORK_REQUIRED','工时期次必须指定所属工作');
 if(!input.workbenchId)return;
 const w=requireWorkbench(input.workbenchId);
 if(get<{executor:string}>('SELECT executor FROM work_type WHERE id=?',[w.work_type_id])?.executor!=='timesheet')throw new ApiError('WRONG_WORK_TYPE','工时只能关联部门工时工作，请从对应月度期次进入',409);
 if(w.archived_at)throw new ApiError('ARCHIVED','请先恢复归档工作');
 if(input.periodId){const p=requirePeriod(input.periodId,w.id);if(p.status==='done')throw new ApiError('PERIOD_DONE','请先重新打开期次');if(p.report_period!==input.month)throw new ApiError('WRONG_MONTH','工时年月必须与所属月度期次一致');}
 else if(get('SELECT workbench_id FROM work_period_rule WHERE workbench_id=?',[w.id]))throw new ApiError('PERIOD_REQUIRED','请从所属月度期次进入工时处理');
}

const finalizingRuns = new Map<number, Promise<{finalized:boolean;artifactId:number|null}>>();
export async function finalizeTimesheet(id:number,reviewed:boolean) {
 if(!reviewed)throw new ApiError('REVIEW_REQUIRED','需要确认已核对工时及导出文件');
 const pending=finalizingRuns.get(id);
 if(pending)return pending;
 const task=finalizeTimesheetOnce(id,reviewed);
 finalizingRuns.set(id,task);
 try{return await task;}finally{if(finalizingRuns.get(id)===task)finalizingRuns.delete(id);}
}

async function finalizeTimesheetOnce(id:number,reviewed:boolean) {
 const r=getTimesheetRun(id);
 if(!reviewed)throw new ApiError('REVIEW_REQUIRED','需要确认已核对工时及导出文件');
 if(r.rule_version!==TIMESHEET_RULE_VERSION)throw new ApiError('RULE_CHANGED','计算规则已修正，请重新计算并核对新文件后定稿',409);
 if(!r.result.canFinalize)throw new ApiError('UNRESOLVED','仍有阻断异常，不能定稿',409);
 if(r.status==='final') {if(r.artifact_id)assertFinalArtifact(getArtifact(r.artifact_id)!);return {finalized:true,artifactId:r.artifact_id};}
 assertTimesheetScope(r.input);
 for(const sourceId of [r.input.templateId,r.input.rdId,r.input.attendanceId,...(r.input.attendanceSources??[]).map(s=>s.id)])await readSource(sourceId);
 let artifactId:number|null=null;
 if(r.workbench_id){
   const bytes=await exportTimesheet(id),w=requireWorkbench(r.workbench_id);
   assertTimesheetScope(r.input);
   const dir=join(workbenchOutputDirAbs(w,'generated'),...(r.period_id?[requirePeriod(r.period_id,w.id).report_period]:[]));
   const saved=await saveArtifact({data:bytes,dirAbs:dir,fileName:`部门工时-${r.month}-定稿-${id}.xlsx`,kind:'generated',title:`部门工时 ${r.month}`,workbenchId:w.id,dedupe:false});
   artifactId=saved.artifact.id;
   tx(()=>{assertTimesheetScope(r.input);run('UPDATE artifact SET work_period_id=? WHERE id=?',[r.period_id,artifactId]);markFinal(artifactId!,true);run("UPDATE timesheet_run SET status='final',artifact_id=? WHERE id=?",[artifactId,id]);});
 }else run("UPDATE timesheet_run SET status='final' WHERE id=?",[id]);
 return {finalized:true,artifactId};
}

export function assertPeriodTimesheet(periodId:number):void {
 const p=requirePeriod(periodId),w=requireWorkbench(p.workbench_id);
 if(get<{executor:string}>('SELECT executor FROM work_type WHERE id=?',[w.work_type_id])?.executor!=='timesheet')return;
 const r=get<{id:number;status:string;artifact_id:number|null}>('SELECT * FROM timesheet_run WHERE period_id=? AND workbench_id=? ORDER BY id DESC LIMIT 1',[periodId,w.id]);
 if(!r||r.status!=='final'||!r.artifact_id)throw new ApiError('TIMESHEET_MISSING','本期最新工时记录尚未核对定稿并归档 Excel 成果',409);
 const a=getArtifact(r.artifact_id);
 if(!a||(a as ArtifactPeriod).work_period_id!==periodId)throw new ApiError('FILE_MISSING','本期工时成果关联无效',409);
 assertFinalArtifact(a);
}
type ArtifactPeriod={work_period_id?:number|null};
export async function exportTimesheet(id: number): Promise<Buffer> {
    const row = getTimesheetRun(id);
    if(row.status==='final'&&row.artifact_id){
        const artifact=getArtifact(row.artifact_id);
        if(!artifact)throw new ApiError('FILE_MISSING','工时定稿成果已被删除',409);
        assertFinalArtifact(artifact);
        return readFileSync(artifactAbsPath(artifact));
    }
    const { book } = await readSource(row.input.templateId);
    await prepareDepartmentBook(book,row.input);
    const layout = departmentLayout(book, row.month), { sheet, rows, totalCol, headerRow } = layout;
    const days = monthDays(row.month), year = Number(row.month.slice(0, 4)), month = Number(row.month.slice(5));
    const cover=book.getWorksheet('封面');
    if(cover&&typeof cover.getCell('C8').value==='number'&&typeof cover.getCell('E8').value==='number'&&cover.getCell('D8').text.includes('年')&&cover.getCell('F8').text.includes('月')){cover.getCell('C8').value=year;cover.getCell('E8').value=month;}
    for (let d = 1; d <= days; d++) {
        const cell = sheet.getCell(headerRow, 8 + d);
        if (scalar(cell) instanceof Date)
            cell.value = new Date(Date.UTC(year, month - 1, d));
        else
            cell.value = d;
        const weekday = sheet.getCell(headerRow + 1, 8 + d);
        if (/^(星期|周)?[一二三四五六日天]$/.test(weekday.text))
            weekday.value = '星期' + '日一二三四五六'[new Date(Date.UTC(year, month - 1, d)).getUTCDay()];
    }
    sheet.getCell(headerRow,totalCol).value='合计';
    const totalWeekday=sheet.getCell(headerRow+1,totalCol);
    if(/^(星期|周)?[一二三四五六日天]$/.test(totalWeekday.text)||/WEEKDAY/i.test(totalWeekday.formula??''))totalWeekday.value='--';
    for (const r of rows) {
        for (let d = 1; d <= totalCol-9; d++) {
            const match = row.result.days.find(v => v.person === r.person && Number(v.date.slice(8)) === d && v.project === r.project);
            sheet.getCell(r.row, 8 + d).value = match?.department || null;
        }
        const sum = row.result.days.filter(v => v.person === r.person && v.project === r.project).reduce((s, v) => s + v.department, 0);
        sheet.getCell(r.row, totalCol).value = { formula: `SUM(I${r.row}:${sheet.getColumn(totalCol - 1).letter}${r.row})`, result: sum };
    }
    // Keep footer caches consistent as well as formulas. Readers that do not
    // recalculate must not display a historical zero beneath current hours.
    sheet.eachRow(r=>r.eachCell(c=>{
        const formula=c.formula,match=formula?.match(/^SUM\(([A-Z]+)(\d+):\1(\d+)\)$/i);
        if(!formula||!match||Number(match[3])>=r.number)return;
        let sum=0;
        for(let rowNo=Number(match[2]);rowNo<=Number(match[3]);rowNo++){
            const source=sheet.getCell(`${match[1]}${rowNo}`),value=source.formula?source.result:source.value;
            if(typeof value==='number')sum+=value;
        }
        c.value={formula,result:sum};
    }));
    for (const s of book.worksheets)
        s.eachRow(r => r.eachCell(c => { if ((s.name === '封面' || (s === sheet && r.number < headerRow)) && typeof c.value === 'string')
            c.value = c.value.replace(/20\d{2}年度\d{1,2}月/g, `${year}年度${month}月`); }));
    refreshTimesheetSummary(book,layout,row.result);
    const report = book.addWorksheet(`校验_${id}`);
    report.columns = [{ header: '人员', key: 'person', width: 18 }, { header: '日期', key: 'date', width: 14 }, { header: '研发工时', key: 'rd', width: 12 }, { header: '部门工时', key: 'department', width: 12 }, { header: '项目', key: 'project', width: 40 }, { header: '计算依据', key: 'basis', width: 80 }];
    report.addRows(row.result.days);
    report.addRow([]);
    report.addRow(['规则版本', row.rule_version]);
    for (const [person, target] of Object.entries(row.input.aliases ?? {})) report.addRow(['确认别名', person, target]);
    for (const [person, reason] of Object.entries(row.input.exclusions ?? {})) report.addRow(['确认排除', person, reason]);
    report.addRow(['结果', row.result.canFinalize ? '计算校验通过，仍需人工核对版式' : '草稿：存在阻断异常']);
    for (const i of row.result.issues)
        report.addRow([i.person, i.date, i.code, i.message]);
    book.calcProperties.fullCalcOnLoad = true;
    return Buffer.from(await book.xlsx.writeBuffer());
}
