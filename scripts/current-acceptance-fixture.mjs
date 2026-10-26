import {mkdirSync,readFileSync,writeFileSync,cpSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),freshReal=process.argv.includes('--fresh-real'),stage=join(root,freshReal?'.tmp/current-real-2026-10-17':'.tmp/current-integration-2026-10-17'),out=join(root,'outputs/current-integration-2026-10-17',freshReal?'real-prepared':'');
const env=isolationEnv(stage,{PORT:'8917',HOST:'127.0.0.1',WORKBENCH_SESSION_TOKEN:randomBytes(32).toString('hex')});
Object.assign(process.env,env);
const json=(name,data)=>writeFileSync(join(out,name),JSON.stringify(data,null,2));
const spec={createdAt:new Date().toISOString(),identity:'new held-out anonymous scenarios; no previous answers reused',modelInputPolicy:'Only question, original anonymous sources and frozen application prompts; expectations are evaluation-only',cases:[
 {id:'complete',question:'澄湖组第一季度培训是否已经完成？请说明完成日期和参训人数。',variants:['澄湖组培训的实际开展情况怎样，完成依据是什么？','澄湖组这次集中授课办完了吗，哪天办的，有多少人参加？'],sources:[
 {key:'course-record',title:'澄湖组培训实施记录.txt',text:'2026-03-12 澄湖组岗位廉洁培训实施记录：集中授课已按安排完成，参训人员18人，授课时长90分钟。签到表与课程记录已由匿名经办员和复核员核对。'},
 {key:'course-proof',title:'澄湖组培训核对凭证.txt',text:'2026-03-13 澄湖组培训核对单：逐人核对2026-03-12签到表，18名参训人员签名齐全；对应课程记录载明当日授课90分钟并已完成。此核对仅针对本次培训，不涉及其他季度工作。'},
 {key:'unrelated',title:'澄湖组场地预约.txt',text:'2026-03-18 场地预约记录：计划于2026-03-25调换值班室桌椅，尚未实施，与本次集中授课无关。'}],expected:['资料支持本次培训已完成，不能一概回答无法判断','实际培训日期2026-03-12，凭证核对日期2026-03-13；不能混淆','18名参训人员，90分钟仅在有必要时提及'],requiredSources:['course-record','course-proof'],forbidden:['仅凭期次状态认定培训完成','全部季度任务已完成或已报送','夹入值班室桌椅预约','把核对日期当培训日期']},
 {id:'conflict',question:'望岑点位第二季度检查中，备用照明现在能否认定恢复正常？请把两方记载说明白。',variants:['望岑点位备用照明的检查结论一致吗，能否认定整改完成？','关于望岑点位备用照明，两份记录分别怎么写，目前该作何判断？'],sources:[
 {key:'side-a',title:'匿名检查方甲',text:'2026-05-14 望岑点位备用照明检查，断电测试后西侧灯具仍不亮。未收到复查凭证，待复核。'},
 {key:'side-b',title:'匿名检查方乙',text:'2026-05-14 望岑点位备用照明检查，断电测试后西侧灯具可持续点亮。填报为现场恢复，未附测试影像。'},
 {key:'unrelated',title:'望岑点位饮水机登记.txt',text:'2026-05-16 饮水机更换滤芯的预约尚待确认，与备用照明事项无关。'}],expected:['同一日期同一点位有仍不亮与可持续点亮两方记载','不能择一认定恢复正常，需核对对应凭证和复查情况','两条登记不等于两次独立实际检查'],requiredSources:['side-a','side-b'],forbidden:['已整改闭环或已验收通过','只引一方却下总体结论','用记录条数证明实际检查次数','混入饮水机预约']},
 {id:'quarter',question:'请起草2026年第三季度清廉工程监督工作推进情况汇报，说明检查、谈话、临时事项的实际记载、未解决问题和下阶段建议。',variants:['请据第三季度材料写清廉工程季度汇报，把现场核查、岗位交流和临时交办事项一并交代，缺资料的地方保留。'],sources:[
 {key:'inspection',title:'栖原项目检查记录',text:'2026-08-19 栖原项目安全检查：东侧防护栏固定件松动，已通知维护组处理，尚待复查。'},
 {key:'talk',title:'匿名年度谈话台账.txt',text:'2026-06-28 上季度岗位交流，不属于本期。\n2026-07-16 岗位廉洁谈话：围绕礼品收受边界作交流，提出登记提醒；记录未提供参加人数。\n2026-10-06 下季度岗位交流，不属于本期。'},
 {key:'temporary',title:'匿名清廉临时事项',text:'2026-09-08 临时交办：汇集栖原合同材料目录，已收到合同正文和交付清单；验收附件尚未补齐，不能认定合同已验收。'},
 {key:'missing',title:'待补采购支持资料',text:'采购监督支持资料待补，尚未确认本期是否适用。'}],expected:['保留8月19日防护栏问题与待复查状态','保留7月16日谈话，不编造人数或效果','保留9月8日临时事项与验收附件缺口','采购栏目明确待补或适用性待确认，不写未开展','跨季度条目不得混入；技术核验说明留来源区'],requiredSources:['inspection','talk','temporary','missing'],forbidden:['全面整改闭环','合同验收通过','谈话次数或人数凭空补齐','采购实际为零','把读取数量、独立记录ID、来源摘要写入业务正文'],change:{source:'inspection',before:'已通知维护组处理，尚待复查。',after:'2026-09-24复查记录：东侧防护栏固定件已紧固，本项复查确认稳固。仅证明该固定件处置，未对其他事项作结论。',expected:['承认9月24日该项复查进展','8月19日问题作为历史状态，不继续写为当前未处理','合同验收附件与采购支持资料仍待补','旧稿字节不变，新稿无旧人工审核']}}
]};
if(process.argv[2]==='seed'){
 if(existsSync(env.WORKBENCH_DB))throw Error('Fixture DB already exists; no reseed');
 mkdirSync(out,{recursive:true});
 if(freshReal)Object.assign(spec,JSON.parse(readFileSync(join(root,'outputs/current-integration-2026-10-17/new-scenarios.frozen.json'))));
 json('new-scenarios.frozen.json',spec);json('new-scenarios.sha256.json',{sha256:createHash('sha256').update(readFileSync(join(out,'new-scenarios.frozen.json'))).digest('hex')});
 (await import('../packages/server/src/core/bootstrap.ts')).bootstrap();
 const db=await import('../packages/server/src/db/index.ts'),s=await import('../packages/server/src/domain/service.ts'),p=await import('../packages/server/src/domain/periods.ts'),ins=await import('../packages/server/src/domain/inspections.ts'),store=await import('../packages/server/src/core/store.ts');
 const e=await import('../packages/server/src/domain/business-evidence.ts'),task=await import('../packages/server/src/domain/evidence-task.ts'),b=await import('../packages/server/src/domain/business-assistant.ts');
 const type=code=>s.listWorkTypes().find(x=>x.code===code);
 function work(name,code,frequency,first){const w=s.createWorkbench({name,workTypeId:type(code).id,templateIds:[]});if(first){p.savePeriodRule(w.id,{frequency,first_period:first,requirements:[]});p.syncPeriods(w.id,'2026-10-01');}return w;}
 const period=(w,key)=>p.listPeriods(w.id).find(x=>x.report_period===key);
 async function source(w,pid,entry,date){const a=(await store.saveArtifact({data:entry.text,dirAbs:s.workbenchOutputDirAbs(w,'source'),fileName:entry.title,title:entry.title,kind:'source',workbenchId:w.id})).artifact;db.run('UPDATE artifact SET work_period_id=?,doc_date=? WHERE id=?',[pid,date,a.id]);return a;}
 const complete=work('澄湖组','integrity-study','quarterly','2026-Q1'),cp=period(complete,'2026-Q1');
 const sourceIds={};for(const x of spec.cases[0].sources)sourceIds[x.key]=(await source(complete,cp.id,x,'2026-03-12')).id;
 const conflict=work('望岑点位','integrity-monthly-inspection','monthly','2026-05'),cfp=period(conflict,'2026-05');
 const sideA=ins.saveInspection(cfp.id,{project:'望岑点位',inspection_date:'2026-05-14',subject:'备用照明检查',content:'断电测试西侧灯具',result:'检查方甲记载：西侧灯具仍不亮',rectification:'未收到复查凭证，待复核'});
 const sideB=ins.saveInspection(cfp.id,{project:'望岑点位',inspection_date:'2026-05-14',subject:'备用照明检查',content:'断电测试西侧灯具',result:'检查方乙记载：西侧灯具可持续点亮',rectification:'填报为现场恢复，未附测试影像'});
 const unrelated=await source(conflict,cfp.id,spec.cases[1].sources[2],'2026-05-16');
 const iw=work('匿名栖原月度监督','integrity-monthly-inspection','monthly','2026-07'),ip=period(iw,'2026-08');
 const rec=ins.saveInspection(ip.id,{project:'栖原项目',inspection_date:'2026-08-19',subject:'安全检查',content:'检查东侧防护栏固定件',result:'东侧防护栏固定件松动',rectification:'已通知维护组处理，尚待复查。'});
 const talk=work('匿名年度谈话','integrity-talk');const ta=await source(talk,null,spec.cases[2].sources[1],'2026-01-01');
 const temp=work('匿名清廉临时事项','temporary-task');db.run('UPDATE workbench SET business_content=? WHERE id=?',[spec.cases[2].sources[2].text,temp.id]);
 const report=work('匿名季度验收汇报','integrity-quarter-summary','quarterly','2026-Q3'),rp=period(report,'2026-Q3');
 p.updatePeriod(rp.id,{content:'2026-09-30 采购监督支持资料待补，尚未确认本期是否适用。'});
 const daily=new DatabaseSync(join(root,'data/runtime/workbench.db'),{readOnly:true});
 const template=daily.prepare("SELECT t.name,t.file_rel FROM template t JOIN work_type w ON w.id=t.work_type_id WHERE w.code='integrity-quarter-summary' AND t.archived_at IS NULL").get();
 json('existing-model-public-config.json',daily.prepare("SELECT p.purpose,p.model,p.max_tokens,v.code,v.base_url FROM ai_profile p JOIN ai_provider v ON v.id=p.provider_id WHERE p.purpose IN ('writing','reasoning')").all());daily.close();
 const templateCopy=join(stage,'template-copy.docx');cpSync(join(root,'data/files',template.file_rel),templateCopy);
 const t=s.registerTemplate({absSourcePath:templateCopy,name:template.name,workTypeId:report.work_type_id});await s.rescanTemplate(t.id);s.setBoundTemplateIds(report.id,[t.id]);
 const snap=JSON.parse(p.requirePeriod(rp.id).snapshot);snap.templates=p.periodTemplates(report.id);db.run('UPDATE work_period SET snapshot=? WHERE id=?',[JSON.stringify(snap),rp.id]);
 const scopes=[{workbenchId:complete.id,start:'2026-01-01',end:'2026-04-01'},{workbenchId:conflict.id,start:'2026-04-01',end:'2026-07-01'},{domain:'admin',category:'清廉工程',start:'2026-07-01',end:'2026-10-01'}];
 const selection=[];const runs=[];
 for(let n=0;n<3;n++){
  const c=spec.cases[n],pack=await e.collectBusinessEvidence(scopes[n]);
  for(const question of [c.question,...c.variants]){const selected=task.prepareEvidenceTask(pack,question,n===2?'report':'answer');selection.push({case:c.id,question,scope:scopes[n],task:selected.task,selectedFacts:task.writingFacts(selected)});}
  if(!freshReal){const result=await b.runBusinessAssistant({question:c.question,scope:scopes[n],draft:n===2,targetWorkbenchId:n===2?report.id:undefined,useModel:false});json(`offline-${c.id}.json`,result);runs.push(result.id);}
  else json(`source-pack-${c.id}.json`,pack);
 }
 json('selection-checks.json',selection);
 json('fixture.json',{root:stage,url:'http://127.0.0.1:8917/#/agent',runs,scopes,complete:{workbench:complete.id,period:cp.id,sources:sourceIds},conflict:{workbench:conflict.id,period:cfp.id,sideA:sideA.id,sideB:sideB.id,unrelated:unrelated.id},quarter:{workbench:report.id,period:rp.id,inspection:rec.id,inspectionPeriod:ip.id,talkArtifact:ta.id,temporary:temp.id,template:t.id},externalRequests:0,mode:'offline rules only'});
 json('actual-request-ledger.json',{authorized:false,actualExternalRequests:0,calls:[]});db.closeDatabase();console.log(JSON.stringify({runs,report:report.id,period:rp.id,externalRequests:0}));
}
if(process.argv[2]==='serve'){
 // All profiles in this isolated DB are empty defaults. TEST_MODE also rejects cloud requests.
 await import('../packages/server/src/index.ts');
}
if(process.argv[2]==='change-source'){
 const ids=JSON.parse(readFileSync(join(out,'fixture.json'))),i=await import('../packages/server/src/domain/inspections.ts'),db=await import('../packages/server/src/db/index.ts');
 db.openDatabase(env.WORKBENCH_DB);
 const old=i.requireInspection(ids.quarter.inspection,ids.quarter.inspectionPeriod);
 const changed=i.saveInspection(ids.quarter.inspectionPeriod,{...old,rectification:spec.cases[2].change.after},old.id);
 json('offline-source-change.json',{label:'offline process test; not real-model v1/v2',before:old,after:changed});db.closeDatabase();console.log('anonymous source changed in isolated DB');
}
