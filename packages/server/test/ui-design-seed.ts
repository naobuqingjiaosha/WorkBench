import ExcelJS from 'exceljs';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {bootstrap} from '../src/core/bootstrap.ts';
import {get} from '../src/db/index.ts';
import {createWorkbench,listWorkTypes} from '../src/domain/service.ts';
import {savePeriodRule,syncPeriods,listPeriods} from '../src/domain/periods.ts';
import * as ledger from '../src/domain/annual-ledger.ts';
import * as ts from '../src/domain/timesheets.ts';
bootstrap();
if(get('SELECT id FROM workbench LIMIT 1'))process.exit(0);
function work(code:string,name:string){const type=listWorkTypes().find(t=>t.code===code)!;const w=createWorkbench({name,workTypeId:type.id,templateIds:[]});savePeriodRule(w.id,{frequency:'monthly',first_period:'2026-10',requirements:[]});syncPeriods(w.id,'2026-10-24');return w;}
const checks=work('integrity-monthly-inspection','示例 · 月度监督检查'),hours=work('department-hours','示例 · 部门月度工时');
const projectType=listWorkTypes().find(t=>t.mode==='process')!;
createWorkbench({name:'示例 · 项目阶段资料准备',workTypeId:projectType.id,templateIds:[]});
const pid=listPeriods(checks.id)[0]!.id,hpid=listPeriods(hours.id)[0]!.id;
const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('示例项目');sheet.getRow(2).values=['序号','时间','监督事项','监督方式','具体内容','发现问题','整改情况','备注'];sheet.getRow(3).values=[1,'2026.9.20','历史资料核查','资料检查','历史内容供参考','历史问题','',''];
await ledger.importAnnualLedger(pid,'示例年度台账.xlsx',Buffer.from(await book.xlsx.writeBuffer()));
const w=new ExcelJS.Workbook();w.addWorksheet('工作记录').getCell('A4').value='检查内容';w.worksheets[0]!.getCell('A5').value='检查结果';
const s=new ExcelJS.Workbook();s.addWorksheet('监督情况').getCell('C5').value='廉政监督情况记录';
await ledger.setLedgerTemplate(pid,'work','工作.xlsx',Buffer.from(await w.xlsx.writeBuffer()));await ledger.setLedgerTemplate(pid,'supervision','监督.xlsx',Buffer.from(await s.xlsx.writeBuffer()));
const entry=await ledger.addLedgerEntry(pid,{project:'示例项目',subject:'资料准备核对',content:'核对项目验收资料目录及缺项',small_power:'yes'});
await ledger.addLedgerEntry(pid,{project:'示例项目',subject:'合同材料核对'});
await ledger.syncAnnualLedger(pid);await ledger.generateLedgerForms(pid,entry.id);
const template=new ExcelJS.Workbook();template.addWorksheet('封面');const table=template.addWorksheet('工时明细表（填写）');table.getRow(3).values=['','','','','','','','',...Array.from({length:31},(_,i)=>i+1)];table.getRow(5).values=[1,'研发部','示例人员甲','项目一'];table.getRow(6).values=[2,'研发部','示例人员乙','项目一'];template.addWorksheet('汇总及校验（仅查看）');
for(let n=0;n<2;n++){table.getCell(n+5,4).value='服务工时';table.getCell(n+5,5).value='项目一';table.getCell(n+5,40).value={formula:`SUM(I${n+5}:AM${n+5})`,result:0};}table.getCell(7,3).value='合计';table.getCell(7,40).value={formula:'SUM(AN5:AN6)',result:0};
const rd=new ExcelJS.Workbook(),r=rd.addWorksheet('研发'),attendance=new ExcelJS.Workbook(),a=attendance.addWorksheet('考勤');for(const sh of [r,a]){sh.getRow(1).values=['人员',...Array.from({length:31},(_,i)=>i+1)];for(let n=0;n<2;n++){sh.getCell(n+2,1).value=['示例人员甲','示例人员乙'][n]!;for(let day=1;day<=31;day++)sh.getCell(n+2,day+1).value=sh===r?(day===1?2:0):'工作';}}
const source=async(name:string,b:ExcelJS.Workbook)=>ts.storeTimesheetSource(name,Buffer.from(await b.xlsx.writeBuffer()));
const t=await source('示例模板.xlsx',template),rs=await source('示例研发.xlsx',rd),as=await source('示例考勤.xlsx',attendance);
const run=await ts.createTimesheetRun({workbenchId:hours.id,periodId:hpid,month:'2026-10',templateId:t.id,rdId:rs.id,attendanceId:as.id,rdMapping:{sheet:'研发',startRow:2,personColumn:1,dateHeaderRow:1,dateStartColumn:2},attendanceMapping:{sheet:'考勤',startRow:2,personColumn:1,dateHeaderRow:1,dateStartColumn:2},requiredPeople:['示例人员甲','示例人员乙'],projects:['项目一','项目二'],assignments:{示例人员甲:['项目一'],示例人员乙:['项目一']},rdComplete:true,payroll:{fullPay:true,workdays:[1,2,3],deductions:{}}});
writeFileSync(join(process.env.WORKBENCH_ISOLATION_ROOT!,'fixture.json'),JSON.stringify({checks:checks.id,pid,entryId:entry.id,hours:hours.id,hpid,run:run.id}));

