import {resolve,join} from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';
import {bootstrap} from '../core/bootstrap.ts';
import {get} from '../db/index.ts';
import {createWorkbench,listWorkTypes} from '../domain/service.ts';
import {savePeriodRule,syncPeriods,listPeriods} from '../domain/periods.ts';
import {storeTimesheetSource,createTimesheetRun} from '../domain/timesheets.ts';
import {inspectTimesheetSource} from '../domain/timesheet-workspace.ts';
import {importAnnualLedger,setLedgerTemplate} from '../domain/annual-ledger.ts';
bootstrap();
if(get('SELECT id FROM workbench LIMIT 1')){console.log('开发数据已存在，保留当前编辑，不重复导入。');process.exit(0);}
function create(code:string,name:string){const type=listWorkTypes().find(t=>t.code===code)!;const w=createWorkbench({name,workTypeId:type.id,templateIds:[]});savePeriodRule(w.id,{frequency:'monthly',first_period:'2026-01',requirements:[]});syncPeriods(w.id,'2026-10-21');return w;}
const h=create('department-hours','月度工时（真实资料副本验收）'),l=create('integrity-monthly-inspection','清廉月检（真实台账副本验收）');
const source=resolve('.tmp/monthly-upgrade/sources'),dir=join(source,'工时表需求调研交接','01_案例_2026年09月');
const find=(prefix:string)=>join(dir,readdirSync(dir).find(n=>n.startsWith(prefix))!);
const t=await storeTimesheetSource('部门9月参考.xlsx',readFileSync(find('05_'))),r=await storeTimesheetSource('研发9月.xlsx',readFileSync(find('01_'))),a=await storeTimesheetSource('员工9月.xlsx',readFileSync(resolve('.tmp/monthly-upgrade/real-inputs/员工-normalized.xlsx'))),x=await storeTimesheetSource('外包9月.xlsx',readFileSync(resolve('.tmp/monthly-upgrade/real-inputs/外包-normalized.xlsx')));
const template=await inspectTimesheetSource(t.id,'2026-09','template'),rd=await inspectTimesheetSource(r.id,'2026-09','rd'),att=await inspectTimesheetSource(a.id,'2026-09','attendance'),ext=await inspectTimesheetSource(x.id,'2026-09','attendance');
const period=listPeriods(h.id).find(p=>p.report_period==='2026-09')!;
const result=await createTimesheetRun({workbenchId:h.id,periodId:period.id,month:'2026-09',templateId:t.id,rdId:r.id,attendanceId:a.id,attendanceSources:[{id:x.id,mapping:ext.mapping!}],rdMapping:rd.mapping!,attendanceMapping:att.mapping!,requiredPeople:template.people,projects:template.projects!,assignments:template.assignments!,rdComplete:true,payroll:{fullPay:true,workdays:rd.workdays!,deductions:{}}});
const p=listPeriods(l.id).find(p=>p.report_period==='2026-09')!,base=join(source,'清廉工程需求调研交接','01_月度-监督检查与表册报送');
await importAnnualLedger(p.id,'年度台账.xlsx',readFileSync(join(base,'年度台账','2026年廉政监督员日常监督工作台账.xlsx')));
await setLedgerTemplate(p.id,'work','工作记录表.xlsx',readFileSync(join(base,'空白模板','附件1：清廉工程监督检查工作记录表.xlsx')));
await setLedgerTemplate(p.id,'supervision','监督情况表.xlsx',readFileSync(join(base,'空白模板','附件3：“清廉工程”廉政监督情况表（数科公司）.xlsx')));
console.log(`工时入口 #/workbench?task=timesheets&id=${h.id}&periodId=${period.id}&runId=${result.id}`);
console.log(`月检工作 #/workbench?id=${l.id}&periodId=${p.id}`);
