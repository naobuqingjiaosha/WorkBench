import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {bootstrap} from '../../src/core/bootstrap.ts';
import {closeDatabase, get, getDb} from '../../src/db/index.ts';
import {syncPeriods} from '../../src/domain/periods.ts';
import {createWorkbench} from '../../src/domain/service.ts';
import {calculateTimesheet, createTimesheetRun, editableTimesheetInput, exportTimesheet, finalizeTimesheet, getTimesheetRun, monthDays, storeTimesheetSource, type RunInput} from '../../src/domain/timesheets.ts';
import {applyTimesheetEdit, inspectTimesheetSource} from '../../src/domain/timesheet-workspace.ts';
import {syntheticTimesheets} from './timesheet-fixture.ts';

bootstrap();
try {
    assert.deepEqual(['2027-02','2028-02','2028-04','2028-07'].map(monthDays), [28,29,30,31]);
    const f = await syntheticTimesheets();
    const person = f.people[0]!;
    const [a,b,c] = f.projects;
    const t = get<{id:number; published_config_id:number}>("SELECT * FROM work_type WHERE executor='timesheet' AND published_config_id IS NOT NULL")!;
    const work = createWorkbench({name:'合成月度工作',workTypeId:t.id,publishedConfigId:t.published_config_id,firstPeriod:f.month});
    syncPeriods(work.id,'2028-02-29');
    const period = get<{id:number}>('SELECT id FROM work_period WHERE workbench_id=? AND report_period=?',[work.id,f.month])!;
    const template = await storeTimesheetSource('合成样式.xlsx',f.template);
    const rd = await storeTimesheetSource('合成研发.xlsx',f.rd);
    const att = await storeTimesheetSource('合成考勤.xlsx',f.attendance);
    const input: RunInput = {workbenchId:work.id,periodId:period.id,month:f.month,templateId:template.id,rdId:rd.id,attendanceId:att.id,
        rdMapping:(await inspectTimesheetSource(rd.id,f.month,'rd')).mapping!,
        attendanceMapping:(await inspectTimesheetSource(att.id,f.month,'attendance')).mapping!,
        projects:f.projects,requiredPeople:[person],assignments:{[person]:f.projects},rdComplete:true,
        payroll:{fullPay:true,workdays:[2,29],deductions:{[`${person}|2028-02-29`]:2}}};
    await assert.rejects(createTimesheetRun({...input,requiredPeople:[]}),/名单/);
    await assert.rejects(createTimesheetRun({...input,month:'2028-03'}),/期次/);
    const calculated = await createTimesheetRun(input);
    assert.equal(calculated.canFinalize,true,JSON.stringify(calculated.issues));
    assert.deepEqual(Object.keys(calculated.personTotals),[person]);
    assert.equal(calculated.personTotals[person],13);
    assert.deepEqual(calculated.days.filter(d=>d.date==='2028-02-02').map(d=>d.department),[3,2,2]);
    assert.equal(calculated.days.find(d=>d.date==='2028-02-29' && d.project===c)?.department,6);
    assert.ok(calculated.days.every(d=>Number.isInteger(d.department)));
    const editDay = {person,date:'2028-02-02',shares:{[a!]:1,[b!]:2,[c!]:4},reason:'合成人工核对'};
    await assert.rejects(applyTimesheetEdit(calculated.id,{allocations:[{...editDay,shares:{[a!]:1.5,[b!]:5.5}}]}),/整数/);
    const adjusted = await applyTimesheetEdit(calculated.id,{allocations:[editDay]});
    const dayOverride = {person,date:'2028-02-29',status:'project',project:b,hours:6,source:'考勤明确项目：合成人工指定'};
    const edited = await applyTimesheetEdit(adjusted.id,{overrides:[dayOverride]});
    const reopen = getTimesheetRun(edited.id);
    assert.deepEqual(editableTimesheetInput(reopen).allocations,[editDay]);
    assert.deepEqual(editableTimesheetInput(reopen).overrides,[dayOverride]);
    assert.equal(Object.hasOwn(editableTimesheetInput(reopen),'attendance'),false);
    assert.deepEqual(edited.projectTotals,{[a!]:1,[b!]:8,[c!]:4});
    assert.deepEqual(getTimesheetRun(calculated.id).result.projectTotals,{[a!]:3,[b!]:2,[c!]:8});
    const bytes = await exportTimesheet(edited.id);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as never);
    const sheet=book.getWorksheet('工时明细表（填写）')!;
    assert.equal((sheet.getCell('AK3').value as Date).toISOString().slice(0,10),'2028-02-29');
    assert.equal(sheet.getCell('AL3').value,null);
    assert.equal(sheet.getCell('AM3').value,null);
    const rows=new Map<string,number>();
    sheet.eachRow(row=>{if(row.getCell(3).text===person && row.getCell(4).text!=='研发工时')rows.set(row.getCell(5).text,row.number);});
    assert.deepEqual([...rows.keys()].sort(),[a,b,c].sort());
    for (const [project,day2,day29,total] of [[a,1,0,1],[b,2,6,8],[c,4,0,4]] as const) {
        const r=rows.get(project!)!;
        assert.equal(Number(sheet.getCell(r,10).value),day2);
        assert.equal(Number(sheet.getCell(r,37).value),day29);
        assert.equal(sheet.getCell(r,40).formula,`SUM(I${r}:AM${r})`);
        assert.equal(sheet.getCell(r,40).result,total);
    }
    const research=sheet.getRows(1,sheet.rowCount)!.filter(r=>r.getCell(4).text==='研发工时');
    assert.equal(research.length,1);assert.equal(research[0]!.getCell(3).text,person);
    assert.equal(research[0]!.getCell(5).text,'本月研发合计（不分项目）');
    assert.equal(research[0]!.getCell(6).value,null);assert.equal(research[0]!.getCell(9).value,null);
    assert.equal(research[0]!.getCell(10).value,1);assert.equal(research[0]!.getCell(40).result,1);
    const summary = book.getWorksheet('人员工时汇总')!;
    assert.equal(summary.getCell('C3').value,1);
    assert.equal(summary.getCell('D3').result,13);
    assert.equal(summary.getCell('E3').result,14);
    await assert.rejects(finalizeTimesheet(edited.id,false),/核对/);
    const countArtifacts=()=>get<{n:number}>('SELECT count(*) AS n FROM artifact')!.n;
    const before=countArtifacts();
    getDb().exec("CREATE TEMP TRIGGER fail_final BEFORE UPDATE OF status ON timesheet_run BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(finalizeTimesheet(edited.id,true),/synthetic failure/);
    assert.equal(countArtifacts(),before);
    assert.equal(getTimesheetRun(edited.id).artifact_id,null);
    getDb().exec('DROP TRIGGER fail_final');
    const final=await finalizeTimesheet(edited.id,true);
    const artifact=get<{workbench_id:number;work_period_id:number}>('SELECT * FROM artifact WHERE id=?',[final.artifactId])!;
    assert.equal(artifact.work_period_id,period.id);assert.equal(artifact.workbench_id,work.id);
    const saved=await exportTimesheet(edited.id);
    assert.deepEqual(await exportTimesheet(edited.id),saved);
    const scoped={month:f.month,people:[person],rdComplete:true,projects:f.projects,assignments:{[person]:f.projects},attendance:[{person,date:'2028-02-02',status:'work',source:'合成考勤'}]};
    const frac=calculateTimesheet({...scoped,rd:[{person,date:'2028-02-02',hours:0.5,source:'合成研发'}]});
    assert.ok(frac.issues.some(i=>i.code==='FRACTIONAL_DEPARTMENT'));
    assert.equal(frac.days.find(d=>d.date==='2028-02-02')?.rd,0.5);
    assert.ok(frac.days.every(d=>Number.isInteger(d.department)));
    console.log('工时对账通过：闰月、明确名单、研发优先、扣薪、整数份额、人工版本、来源和定稿 XLSX 关联。');
} finally { closeDatabase(); }
