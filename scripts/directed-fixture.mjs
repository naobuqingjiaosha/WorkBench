import {mkdirSync,readFileSync,writeFileSync,cpSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {isolationEnv} from './isolation-env.mjs';
const tag=process.env.DIRECTED_RUN??'';if(tag&&!/^[a-z0-9-]+$/.test(tag))throw Error('Invalid run tag');
const root=resolve(import.meta.dirname,'..'),stage=join(root,'.tmp/directed-offline-2026-10-17',tag||'runtime-test'),out=join(root,'outputs/directed-offline-2026-10-17',tag);
Object.assign(process.env,isolationEnv(stage,{PORT:tag?'8928':'8927',HOST:'127.0.0.1',WORKBENCH_SESSION_TOKEN:randomBytes(32).toString('hex')}));
const json=(name,data)=>writeFileSync(join(out,name),JSON.stringify(data,null,2));
const spec=JSON.parse(readFileSync(join(root,'.tmp/directed-offline-2026-10-17/input/new-scenarios.frozen.json')));
if(process.argv[2]==='seed'){
 if(existsSync(process.env.WORKBENCH_DB))throw Error('No reseeding');
 mkdirSync(stage,{recursive:true});mkdirSync(out,{recursive:true});writeFileSync(join(stage,'.workbench-test-root'),'isolated test');
 (await import('../packages/server/src/core/bootstrap.ts')).bootstrap();
 const db=await import('../packages/server/src/db/index.ts'),s=await import('../packages/server/src/domain/service.ts'),p=await import('../packages/server/src/domain/periods.ts'),ins=await import('../packages/server/src/domain/inspections.ts'),store=await import('../packages/server/src/core/store.ts');
 const work=(name,code,frequency,first)=>{const w=s.createWorkbench({name,workTypeId:s.listWorkTypes().find(t=>t.code===code).id,templateIds:[]});if(first){p.savePeriodRule(w.id,{frequency,first_period:first,requirements:[]});p.syncPeriods(w.id,'2026-10-01');}return w;};
 const period=(w,key)=>p.listPeriods(w.id).find(x=>x.report_period===key);
 async function source(w,pid,entry,date){const a=(await store.saveArtifact({data:entry.text,dirAbs:s.workbenchOutputDirAbs(w,'source'),fileName:entry.title,title:entry.title,kind:'source',workbenchId:w.id})).artifact;db.run('UPDATE artifact SET work_period_id=?,doc_date=? WHERE id=?',[pid,date,a.id]);return a;}
 const complete=work('澄湖组','integrity-study','quarterly','2026-Q1'),cp=period(complete,'2026-Q1');
 for(const x of spec.cases[0].sources)await source(complete,cp.id,x,'2026-03-12');
 const conflict=work('望岑点位','integrity-monthly-inspection','monthly','2026-05'),cfp=period(conflict,'2026-05');
 ins.saveInspection(cfp.id,{project:'望岑点位',inspection_date:'2026-05-14',subject:'备用照明检查',content:'断电测试西侧灯具',result:'检查方甲记载：西侧灯具仍不亮',rectification:'未收到复查凭证，待复核'});
 ins.saveInspection(cfp.id,{project:'望岑点位',inspection_date:'2026-05-14',subject:'备用照明检查',content:'断电测试西侧灯具',result:'检查方乙记载：西侧灯具可持续点亮',rectification:'填报为现场恢复，未附测试影像'});
 await source(conflict,cfp.id,spec.cases[1].sources[2],'2026-05-16');
 const iw=work('匿名栖原月度监督','integrity-monthly-inspection','monthly','2026-07'),ip=period(iw,'2026-08');
 const rec=ins.saveInspection(ip.id,{project:'栖原项目',inspection_date:'2026-08-19',subject:'安全检查',content:'检查东侧防护栏固定件',result:'东侧防护栏固定件松动',rectification:'已通知维护组处理，尚待复查。'});
 const talk=work('匿名年度谈话','integrity-talk');await source(talk,null,spec.cases[2].sources[1],'2026-01-01');
 const temp=work('匿名清廉临时事项','temporary-task');db.run('UPDATE workbench SET business_content=? WHERE id=?',[spec.cases[2].sources[2].text,temp.id]);
 const report=work('匿名季度验收汇报','integrity-quarter-summary','quarterly','2026-Q3'),rp=period(report,'2026-Q3');p.updatePeriod(rp.id,{content:'2026-09-30 采购监督支持资料待补，尚未确认本期是否适用。'});
 const templateCopy=join(stage,'template-copy.docx');cpSync(join(root,'.tmp/current-integration-2026-10-17/template-copy.docx'),templateCopy);
 const t=s.registerTemplate({absSourcePath:templateCopy,name:'本领域监督工作推进情况报告（清廉季度）',workTypeId:report.work_type_id});await s.rescanTemplate(t.id);s.setBoundTemplateIds(report.id,[t.id]);
 const snap=JSON.parse(p.requirePeriod(rp.id).snapshot);snap.templates=p.periodTemplates(report.id);db.run('UPDATE work_period SET snapshot=? WHERE id=?',[JSON.stringify(snap),rp.id]);
 json('fixture.json',{root:stage,url:`http://127.0.0.1:${process.env.PORT}/#/agent`,complete:{workbench:complete.id,period:cp.id},conflict:{workbench:conflict.id,period:cfp.id},quarter:{workbench:report.id,period:rp.id,inspection:rec.id,inspectionPeriod:ip.id,template:t.id},externalRequests:0});
 db.closeDatabase();console.log('Anonymous isolated fixture seeded');
}
if(process.argv[2]==='serve'){
 const mock=await import('./directed-mock.mjs');mock.installMock();
 process.on('exit',()=>json('browser-requests.mock.json',mock.captures));
 await import('../packages/server/src/index.ts');
}
if(process.argv[2]==='change-source'){
 const fixture=JSON.parse(readFileSync(join(out,'fixture.json'))),db=await import('../packages/server/src/db/index.ts');db.openDatabase(process.env.WORKBENCH_DB);
 const ins=await import('../packages/server/src/domain/inspections.ts'),old=ins.requireInspection(fixture.quarter.inspection,fixture.quarter.inspectionPeriod);
 const changed=ins.saveInspection(old.period_id,{...old,rectification:spec.cases[2].change.after},old.id);json('source-change.json',{identity:'offline',before:old,after:changed});db.closeDatabase();
}
