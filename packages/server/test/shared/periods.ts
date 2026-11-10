import assert from 'node:assert/strict';
import { bootstrap } from '../../src/core/bootstrap.ts';
import { closeDatabase, get } from '../../src/db/index.ts';
import { completeWorkbench, createWorkbench } from '../../src/domain/service.ts';
import { computeSchedule } from '../../src/domain/schedule.ts';
import { listWorkflowInbox } from '../../src/domain/workflow.ts';
import { listPeriods, periodNativeFields, periodDue, relatedPeriods, updatePeriod } from '../../src/domain/periods.ts';
import { createDraft, patchDraft, adoptDraft } from '../../src/domain/inspection-drafts.ts';
import { collectWorkContext } from '../../src/domain/work-context.ts';

bootstrap();
try {
  const year = new Date().getFullYear()-1;
  function work(code:string, options:Partial<Parameters<typeof createWorkbench>[0]>={}) {
    const type=get<{id:number;published_config_id:number}>('SELECT id,published_config_id FROM work_type WHERE code=?',[code])!;
    return createWorkbench({name:'合成验证 '+code,workTypeId:type.id,publishedConfigId:type.published_config_id,...options});
  }
  const monthly=work('integrity-monthly-inspection',{firstPeriod:year+'-09'});
  const summary=work('integrity-quarter-summary',{firstPeriod:year+'-Q4'});
  const safety=work('safety-report',{firstPeriod:year+'-10'});
  const month=(number:string)=>listPeriods(monthly.id).find(p=>p.report_period===year+'-'+number)!;
  const quarter=listPeriods(summary.id).find(p=>p.report_period===year+'-Q4')!;
  const meeting=listPeriods(safety.id).find(p=>p.report_period===year+'-10')!;
  const facts={project:'合成项目',subject:'核对设备',content:'核对合成设备标识',result:'两项待跟进'};
  const source=month('10'),draft=createDraft(source.id,{requestKey:'first-synthetic-check',sourceId:null});
  const partial=patchDraft(source.id,draft.id,{revision:draft.revision,fields:{subject:facts.subject}});
  assert.throws(()=>adoptDraft(source.id,draft.id,partial.revision),/项目、日期/);
  assert.equal(get<{n:number}>('SELECT count(*) n FROM inspection_record')!.n,0);
  const filled=patchDraft(source.id,draft.id,{revision:partial.revision,fields:{...facts,inspection_date:year+'-10-15'}});
  const actual=adoptDraft(source.id,draft.id,filled.revision);
  assert.equal(adoptDraft(source.id,draft.id,filled.revision).inspection_id,actual.inspection_id);
  const next=month('11'),reference=createDraft(next.id,{sourceId:actual.inspection_id,requestKey:'second-synthetic-check'});
  assert.equal(reference.fields.project,facts.project);
  assert.equal(reference.fields.inspection_date,'');
  assert.equal(reference.fields.result,'');
  const allowed=relatedPeriods(quarter.id).map(p=>p.id);
  assert.ok(allowed.includes(source.id)&&allowed.includes(next.id));
  for(const forbidden of [month('09').id,meeting.id,quarter.id]){
    assert.ok(!allowed.includes(forbidden));
    assert.throws(()=>updatePeriod(quarter.id,{source_period_ids:[forbidden]}),/同季度|本季度/);
  }
  assert.equal(periodNativeFields(quarter)['范围内已确认检查次数'],'');
  const linked=updatePeriod(quarter.id,{source_period_ids:[source.id,next.id,source.id],expected:{source_period_ids:'[]'}});
  assert.throws(()=>updatePeriod(quarter.id,{source_period_ids:[],expected:{source_period_ids:'[]'}}),/其他入口/);
  assert.deepEqual(JSON.parse(linked.source_period_ids),[source.id,next.id]);
  const fields=periodNativeFields(linked);
  assert.equal(fields['范围内已确认检查次数'],'1');
  assert.match(fields['范围内已确认检查']!,new RegExp(year+'-10-15'));
  assert.ok(fields['季度参考范围']!.includes(year+'-11'));
  assert.doesNotMatch(fields['范围内已确认检查']!,/待确认草稿/);
  assert.deepEqual((await collectWorkContext(summary.id,quarter.id)).sourcePeriodIds,[source.id,next.id]);

  assert.equal(periodDue('2024-02-01',0,31),'2024-02-29');
  assert.equal(periodDue('2025-02-01',0,31),'2025-02-28');
  const inbox=listWorkflowInbox().periods.find(p=>p.id===meeting.id)!;
  assert.ok(!inbox.nextAction?.includes('文件已生成'));
  updatePeriod(meeting.id,{content:'已保存的人工记录',expected:{content:''}});
  assert.throws(()=>updatePeriod(meeting.id,{content:'滞后编辑',expected:{content:''}}),/其他入口/);
  const schedule={recurrence:'monthly' as const,recur_day:5,remind_days:3,schedule_due_date:'2025-02-05'};
  assert.equal(computeSchedule(schedule,new Date(2025,1,1)).shouldRemind,false);
  assert.equal(computeSchedule(schedule,new Date(2025,1,2)).shouldRemind,true);
  assert.equal(computeSchedule(schedule,new Date(2025,2,1)).nextDue,'2025-02-05');
  const reminder=work('admin',{recurrence:'monthly',recurDay:5,remindDays:3});
  assert.equal(listPeriods(reminder.id).length,0);
  const completed=completeWorkbench(reminder.id);
  assert.equal(completed.status,'active');
  assert.ok(completed.nextDue!>reminder.schedule_due_date!);
  assert.throws(()=>completeWorkbench(reminder.id),/本期已完成/);
  console.log('周期验证通过：按期提醒、明确完成、例会内容冲突、检查草稿与实际事实、季度来源边界。');
} finally {
  closeDatabase();
}
