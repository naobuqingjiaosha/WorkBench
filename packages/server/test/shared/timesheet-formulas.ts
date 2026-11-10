import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import {bootstrap} from '../../src/core/bootstrap.ts';
import {closeDatabase, get, run as execute} from '../../src/db/index.ts';
import {syncPeriods} from '../../src/domain/periods.ts';
import {createWorkbench} from '../../src/domain/service.ts';
import {createTimesheetRun, exportTimesheet, finalizeTimesheet, getTimesheetRun, storeTimesheetSource} from '../../src/domain/timesheets.ts';
import {inspectTimesheetSource} from '../../src/domain/timesheet-workspace.ts';
import {syntheticTimesheets} from './timesheet-fixture.ts';

bootstrap();
try {
    const f=await syntheticTimesheets(), person=f.people[0]!;
    const t=get<{id:number;published_config_id:number}>("SELECT * FROM work_type WHERE executor='timesheet' AND published_config_id IS NOT NULL")!;
    const work=createWorkbench({name:'合成模板公式核对',workTypeId:t.id,publishedConfigId:t.published_config_id,firstPeriod:f.month});
    syncPeriods(work.id,'2028-02-29');
    const period=get<{id:number}>('SELECT id FROM work_period WHERE workbench_id=? AND report_period=?',[work.id,f.month])!;
    const rd=await storeTimesheetSource('合成研发.xlsx',f.rd),att=await storeTimesheetSource('合成考勤.xlsx',f.attendance);
    const common={workbenchId:work.id,periodId:period.id,month:f.month,rdId:rd.id,attendanceId:att.id,
        rdMapping:(await inspectTimesheetSource(rd.id,f.month,'rd')).mapping!,
        attendanceMapping:(await inspectTimesheetSource(att.id,f.month,'attendance')).mapping!,
        requiredPeople:[person],rdComplete:true,payroll:{fullPay:true,workdays:[2,29],deductions:{[`${person}|2028-02-29`]:2}}};
    const results=[];
    for(const mode of ['rows','columns','both','unsupported','special']){
        const source=new ExcelJS.Workbook();await source.xlsx.load(f.template as never);
        const s=source.getWorksheet('工时明细表（填写）')!;
        const total=mode==='rows'?'AN':'AM';
        if(mode==='rows'){
            s.getCell('AM3').value=31;
            for(let r=5;r<=8;r++){
                s.getCell('AM'+r).value=null;
                s.getCell('AN'+r).value={formula:`SUM(I${r}:AM${r})`,result:99};
            }
        }
        s.getCell('C9').value='模板全员工时总计';
        s.getCell(total+'9').value={formula:mode==='unsupported'?`SUM(INDIRECT("${total}5:${total}8"))`:`SUM(${total}5:${total}8)`,result:396};
        const audit=source.addWorksheet('核对副页');
        audit.getCell('B2').value={formula:`'工时明细表（填写）'!$${total}$9`,result:396};
        audit.getCell('B3').value={formula:`SUM('工时明细表（填写）'!$${total}$5:$${total}$6)`,result:198};
        audit.getCell('B4').value={formula:`'工时明细表（填写）'!$${total}$6`,result:99};
        audit.getCell('B5').value={formula:`SUM('工时明细表（填写）'!$I5:$${mode==='rows'?'AM':'AL'}5)`,result:99};
        const neutral=source.addWorksheet('单独计算');
        neutral.getCell('A1').value=7;neutral.getCell('A2').value={formula:'ROUND(A1/3,2)',result:2.33};
        // A custom summary occupies the first sheet bearing this prefix. Its
        // original formulas remain in place; the application supplies its own tab.
        const extra=source.getWorksheet('人员工时汇总')!;
        extra.getCell('A7').value='模板另行核对';
        extra.getCell('C7').value={formula:`'工时明细表（填写）'!${total}9`,result:396};
        if(mode==='special'){
            audit.mergeCells('G1:H1');audit.getCell('G1').value=7;
            audit.getCell('B6').value={formula:'SUM(G1:H1)',result:7};
            audit.getCell('B7').value={formula:'H1',result:0};
            audit.getCell('B8').value={formula:"SUM('工时明细表（填写）'!I3:I3)",result:0};
            audit.getCell('B9').value={formula:`SUM('工时明细表（填写）'!${total}8:${total}5)`,result:396};
            s.getCell('H7').value={formula:'SUM(I7:AL7)',result:99};
            audit.getCell('B10').value={formula:`SUM('工时明细表（填写）'!${total}6:${total}6)`,result:99};
            // This wide range used to contain only empty space below the data.
            audit.getCell('B11').value={formula:`SUM('工时明细表（填写）'!${total}10:${total}35)`,result:0};
        }
        const bytes=Buffer.from(await source.xlsx.writeBuffer());
        const template=await storeTimesheetSource(mode+'.xlsx',bytes);
        const projects=mode==='columns'?[f.projects[0]!]:f.projects;
        const run=await createTimesheetRun({...common,...(mode==='unsupported'?{workbenchId:undefined,periodId:undefined}:{}),projects,assignments:{[person]:projects},templateId:template.id});
        const file=await exportTimesheet(run.id);
        const dir=process.env.TIMESHEET_FORMULA_SAMPLE_DIR;
        if(dir){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,mode+'-source.xlsx'),bytes);writeFileSync(join(dir,mode+'-export.xlsx'),file);}
        const output=new ExcelJS.Workbook();await output.xlsx.load(file as never);
        const data=output.getWorksheet(s.name)!;
        const own=data.getRows(1,data.rowCount)!.find(r=>r.getCell(3).text==='模板全员工时总计')!;
        const detail=data.getRows(1,data.rowCount)!.filter(r=>r.getCell(3).text===person);
        const independent=detail.reduce((sum,r)=>sum+Array.from({length:29},(_,d)=>Number(r.getCell(9+d).value??0)).reduce((a,b)=>a+b,0),0);
        assert.equal(independent,14,'独立逐日合计');
        // Exact row identities, hours and positions reported in the supplied
        // row_insert / column_insert counterexamples.
        if(mode==='rows'||mode==='columns'){
            const visible=detail.map(r=>[r.number,r.getCell(4).text,r.getCell('AN').result,r.getCell('AM').value]);
            assert.deepEqual(visible,mode==='rows'?[[5,'部门工时',3,null],[7,'服务工时',2,null],[8,'服务工时',8,null],[9,'研发工时',1,null]]
                :[[5,'部门工时',13,null],[7,'研发工时',1,null]]);
            assert.equal(own.getCell('AN').address,mode==='rows'?'AN11':'AN9');
        }

        const cell=own.getCell('AN'),external=output.getWorksheet(audit.name)!.getCell('B2');
        console.log(mode,cell.address,cell.formula,cell.result,'跨表',external.formula,external.result,'可定稿',run.canFinalize);
        results.push({mode,run,cell,external,footer:own.number,output});
    }
    for(const {mode,run,cell,external,footer,output} of results){
        assert.equal(output.getWorksheet('单独计算')!.getCell('A2').formula,'ROUND(A1/3,2)');
        assert.equal(output.getWorksheet('单独计算')!.getCell('A2').result,2.33);
        const audit=output.getWorksheet('核对副页')!;
        if(mode==='special'){
            assert.equal(run.canFinalize,false);
            assert.equal(audit.getCell('B6').result,7);
            assert.equal(audit.getCell('B7').result,0);
            for(const reason of ['日期','倒序','必须按本次输入重填','局部小计','覆盖新增部门合计行'])
                assert.ok(run.issues.some(i=>i.message.includes(reason)),reason);
            await assert.rejects(finalizeTimesheet(run.id,true),/公式/);
            continue;
        }
        if(mode==='unsupported'){
            assert.equal(run.canFinalize,false);
            assert.ok(run.issues.some(i=>i.code==='TEMPLATE_FORMULA'&&i.message.includes('INDIRECT')));
            await assert.rejects(finalizeTimesheet(run.id,true),/公式|阻断/);
            // Legacy/tampered green drafts must still pass the final file check,
            // including a standalone run which would not otherwise create an artifact.
            execute("UPDATE timesheet_run SET result=json_set(result,'$.canFinalize',json('true'),'$.issues',json('[]')) WHERE id=?",[run.id]);
            await assert.rejects(finalizeTimesheet(run.id,true),/INDIRECT/);
            execute("UPDATE timesheet_run SET result=json_remove(result,'$.templateFormulasChecked') WHERE id=?",[run.id]);
            assert.equal(getTimesheetRun(run.id).result.canFinalize,false);
            await assert.rejects(finalizeTimesheet(run.id,true),/重新计算并保存/);
            assert.notEqual(getTimesheetRun(run.id).status,'final');
            continue;
        }
        assert.equal(run.canFinalize,true,JSON.stringify(run.issues));
        assert.equal(cell.formula,`SUM(AN5:AN${footer-1})`);
        assert.equal(cell.result,14);
        assert.equal(external.formula,`'工时明细表（填写）'!$AN$${footer}`);
        assert.equal(external.result,14);
        assert.equal(output.getWorksheet('人员工时汇总')!.getCell('C7').result,14);
        assert.equal(output.getWorksheet('人员工时汇总（本次）')!.getCell('E3').result,14);
        assert.equal(audit.getCell('B3').result,13,'全范围的部门小计包含新增项目');
        assert.equal(audit.getCell('B4').result,0,'单点只引用原人行');
        assert.equal(audit.getCell('B3').formula,`SUM('工时明细表（填写）'!$AN$5:$AN$${mode==='columns'?6:8})`);
        assert.equal(audit.getCell('B4').formula,"'工时明细表（填写）'!$AN$6");
        assert.equal(audit.getCell('B5').formula,"SUM('工时明细表（填写）'!$I5:$AM5)");
        assert.equal(audit.getCell('B5').result,mode==='columns'?13:3);
        assert.equal((await finalizeTimesheet(run.id,true)).finalized,true);
    }

    // Do not mistake a superficially similar user subtotal or a manually edited
    // summary for an application-owned output range.
    const manual=new ExcelJS.Workbook();await manual.xlsx.load(f.template as never);
    const manualSummary=manual.getWorksheet('人员工时汇总')!;
    manualSummary.getCell('A1').value='人员工时汇总及校验';
    manualSummary.getCell('E2').value='个人总工时';
    manualSummary.getCell('B3').value='各方确认的基线';
    manualSummary.getCell('B4').value='合计';manualSummary.getCell('E4').value=986;
    manualSummary.getCell('F4').value='上一版确认，保留对照';
    const calcWith=async(book:ExcelJS.Workbook,names:string[])=>{
        const template=await storeTimesheetSource('核对模板.xlsx',Buffer.from(await book.xlsx.writeBuffer()));
        const run=await createTimesheetRun({...common,requiredPeople:names,projects:f.projects,
            payroll:{...common.payroll,deductions:names.includes(person)?common.payroll.deductions:{}},
            assignments:Object.fromEntries(names.map(n=>[n,f.projects])),templateId:template.id});
        const file=new ExcelJS.Workbook();await file.xlsx.load(await exportTimesheet(run.id) as never);
        return {run,file};
    };
    const kept=await calcWith(manual,[person]);
    assert.equal(kept.run.canFinalize,true);
    assert.equal(kept.file.getWorksheet('人员工时汇总')!.getCell('E4').value,986);
    assert.equal(kept.file.getWorksheet('人员工时汇总')!.getCell('F4').text,'上一版确认，保留对照');
    assert.equal(kept.file.getWorksheet('人员工时汇总（本次）')!.getCell('E3').result,14);
    const detail=manual.getWorksheet('工时明细表（填写）')!;
    detail.getCell('C9').value='总计';detail.getCell('B9').value='仅原第5行项目';
    const userSubtotal='SUMIF($D$5:$D$5,"部门工时",AM5:AM5)+SUMIF($D$5:$D$5,"服务工时",AM5:AM5)';
    detail.getCell('AM9').value={formula:userSubtotal,result:99};
    const partial=await calcWith(manual,[person]);
    assert.equal(partial.run.canFinalize,false);
    assert.equal(partial.file.getWorksheet(detail.name)!.getCell('AN11').formula,userSubtotal);
    await assert.rejects(finalizeTimesheet(partial.run.id,true),/模板公式/);

    // A prior generated personnel total used to sit in E4. When a second
    // person is added first in the list, both the total and original person move.
    const plain=new ExcelJS.Workbook();await plain.xlsx.load(f.template as never);
    const previous=await calcWith(plain,[person]);
    assert.equal(previous.run.canFinalize,true);
    const audit=previous.file.addWorksheet('历史汇总引用');
    audit.getCell('B1').value={formula:"'人员工时汇总'!$E$4",result:14};
    audit.getCell('B2').value={formula:"'人员工时汇总'!E3",result:14};
    const expanded=await calcWith(previous.file,[f.people[1]!,person]);
    assert.equal(expanded.run.canFinalize,true,JSON.stringify(expanded.run.issues));
    const linked=expanded.file.getWorksheet(audit.name)!;
    assert.equal(linked.getCell('B1').formula,"'人员工时汇总'!$E$5");
    assert.equal(linked.getCell('B1').result,30);
    assert.equal(linked.getCell('B2').formula,"'人员工时汇总'!E4");
    assert.equal(linked.getCell('B2').result,14);
    const removed=await calcWith(previous.file,[f.people[1]!]);
    assert.equal(removed.run.canFinalize,false);
    assert.ok(removed.run.issues.some(i=>i.message.includes('原汇总人员不在')));
}finally{closeDatabase();}
