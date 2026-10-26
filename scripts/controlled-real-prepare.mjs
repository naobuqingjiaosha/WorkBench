// New anonymous inputs only. This script cannot send model requests.
import {mkdirSync,readFileSync,writeFileSync,cpSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/controlled-real-2026-10-17'),stage=join(root,'.tmp/controlled-real-2026-10-17');
const save=(name,data)=>writeFileSync(join(out,name),JSON.stringify(data,null,2));
const hash=x=>createHash('sha256').update(x).digest('hex');
const tree=p=>existsSync(p)?readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?tree(join(p,e.name)):[{path:relative(root,join(p,e.name)),sha256:hash(readFileSync(join(p,e.name)))}]):[];
mkdirSync(out,{recursive:true});mkdirSync(stage,{recursive:true});
Object.assign(process.env,isolationEnv(stage));
globalThis.fetch=async()=>{throw Error('Preparation forbids all network');};
if(process.argv[2]==='seed'){
 if(existsSync(process.env.WORKBENCH_DB))throw Error('Fresh database required');
 save('daily-before.json',{dist:tree(join(root,'packages/web/dist')),files:['workbench.config.json','data/runtime/workbench.db','data/runtime/server.lock'].filter(p=>existsSync(join(root,p))).map(path=>({path,sha256:hash(readFileSync(join(root,path)))}))});
 (await import('../packages/server/src/core/bootstrap.ts')).bootstrap();
 const db=await import('../packages/server/src/db/index.ts'),s=await import('../packages/server/src/domain/service.ts'),p=await import('../packages/server/src/domain/periods.ts'),ins=await import('../packages/server/src/domain/inspections.ts'),store=await import('../packages/server/src/core/store.ts');
 const work=(name,code,frequency,first)=>{const w=s.createWorkbench({name,workTypeId:s.listWorkTypes().find(t=>t.code===code).id,templateIds:[]});if(first){p.savePeriodRule(w.id,{frequency,first_period:first,requirements:[]});p.syncPeriods(w.id,'2026-10-01');}return w;};
 const period=(w,key)=>p.listPeriods(w.id).find(x=>x.report_period===key);
 const inputs=[];
 async function source(w,pid,title,text,date){inputs.push({work:w.name,title,text,date});const a=(await store.saveArtifact({data:text,dirAbs:s.workbenchOutputDirAbs(w,'source'),fileName:title,title,kind:'source',workbenchId:w.id})).artifact;db.run('UPDATE artifact SET work_period_id=?,doc_date=? WHERE id=?',[pid,date,a.id]);return a;}
 const training=work('匿名槐序学习小组','integrity-study','quarterly','2026-Q1'),tp=period(training,'2026-Q1');
 await source(training,tp.id,'课程执行纪要.txt','2026-02-24，槐序学习小组举行廉洁风险专题培训。课程采用案例推演和现场讨论，集中授课已完成。签到页列有21名实际参训人员的签名。','2026-02-24');
 await source(training,tp.id,'签到复核备注.txt','核对日期为2026年2月27日。经逐人核对，2026年2月24日培训签到页所列21人均为实际参加人员；本备注的核对日期不是授课日期。','2026-02-27');
 await source(training,tp.id,'打印耗材登记.txt','2026-02-26，办公打印耗材申领记录已经登记，待领取。','2026-02-26');
 const conflict=work('匿名砚桥检查点','integrity-monthly-inspection','monthly','2026-04'),cp=period(conflict,'2026-04');
 const conflictRows=[{project:'砚桥站',inspection_date:'2026-04-22',subject:'疏散门检查',content:'核查南侧疏散门开启情况',result:'南侧疏散门无法从内侧开启',rectification:'巡查手记记录门锁卡滞，待复查确认'},{project:'砚桥站',inspection_date:'2026-04-22',subject:'疏散门检查',content:'核查南侧疏散门开启情况',result:'南侧疏散门能够从内侧开启',rectification:'值守交接单记录开门顺畅，尚无共同复核结论'}];
 for(const row of conflictRows)ins.saveInspection(cp.id,row);inputs.push(...conflictRows);
 await source(conflict,cp.id,'资料移交说明.txt','2026-04-23，移交了砚桥站两份疏散门检查记载。记录形成时的门锁状态尚待核实，双方尚未共同复查，不能据此认定已消除问题。','2026-04-23');
 const iw=work('匿名秋期监督','integrity-monthly-inspection','monthly','2026-07'),ip=period(iw,'2026-08');
 const inspectionRow={project:'汀石项目',inspection_date:'2026-08-11',subject:'安全检查',content:'查看临时通道盖板与边缘防护',result:'临时通道盖板移位，边缘防护警示缺失',rectification:'已记录两项问题，尚无复查结果。'};
 const rec=ins.saveInspection(ip.id,inspectionRow);inputs.push(inspectionRow);
 const talk=work('匿名廉洁谈话台账','integrity-talk');
 await source(talk,null,'年度谈话摘录.txt','2026-05-08，上半年岗位廉洁谈话记录：采购岗位回避事项提示。\n2026-07-16，围绕合同验收岗位开展廉洁谈话，讨论验收凭证留存与职责边界，谈话记录已归档。\n2026-10-09，下季度岗位交流记录：资料移交提醒。','2026-01-01');
 const temp=work('匿名清廉临时协调','temporary-task'),temporary='2026-09-09，清廉合同资料核对：补充协议已收齐，设备验收附件仍缺签字页，暂不能据此确认合同验收条件齐备。';
 db.run('UPDATE workbench SET business_content=? WHERE id=?',[temporary,temp.id]);inputs.push({work:temp.name,text:temporary});
 const report=work('匿名第三季度清廉汇报','integrity-quarter-summary','quarterly','2026-Q3'),rp=period(report,'2026-Q3');
 const procurement='2026-09-28，采购监督资料整理时仅找到目录，相关凭证待补，本季度采购监督是否适用尚待确认。';p.updatePeriod(rp.id,{content:procurement});inputs.push({work:report.name,text:procurement});
 const template=join(stage,'existing-template.docx');cpSync(join(root,'.tmp/current-integration-2026-10-17/template-copy.docx'),template);
 const t=s.registerTemplate({absSourcePath:template,name:'本领域监督工作推进情况报告（清廉季度）',workTypeId:report.work_type_id});await s.rescanTemplate(t.id);s.setBoundTemplateIds(report.id,[t.id]);const snapshot=JSON.parse(rp.snapshot);snapshot.templates=p.periodTemplates(report.id);db.run('UPDATE work_period SET snapshot=? WHERE id=?',[JSON.stringify(snapshot),rp.id]);
 const cases=[
 {id:'training',question:'这次专题培训实际办完了没有？请说明授课日、参加人数，并区分后来的核对日期。',workbenchId:training.id,periodId:tp.id,expected:['授课完成：2026-02-24','实际参训21人','2026-02-27是核对日期','不混入打印耗材']},
 {id:'conflict',question:'两份疏散门检查记载为何不能直接合并为已解决？请交代双方说法和目前能作出的判断。',workbenchId:conflict.id,periodId:cp.id,expected:['2026-04-22同一对象的两份记载相互矛盾','无法开启与能够开启均须归属来源','尚未共同复查，不能认定消除问题']},
 {id:'quarter-v1',question:'请起草2026年第三季度清廉工程汇报，涵盖安全检查、岗位谈话、临时合同事项和采购资料缺口，并针对各项问题提出下季度建议。',workbenchId:report.id,periodId:rp.id,expected:['盖板移位与警示缺失均未复查','仅7月16日谈话属于本季度','补充协议收齐、验收附件缺签字页','采购凭证待补、适用性未确认','各主题有切题建议，不能虚构责任人期限或部署']},
 {id:'quarter-v2',question:'请依据更新后的资料重新起草2026年第三季度清廉工程汇报，保留安全检查、岗位谈话、临时合同事项、采购资料缺口以及下季度建议，并区分局部进展与尚未解决事项。',workbenchId:report.id,periodId:rp.id,expected:['盖板已复位是局部复查进展','警示缺失仍未解决','合同与采购缺口仍保留','不扩大为整体闭环','旧稿字节不变，旧人工审核不继承']}
 ];
 save('inputs.frozen.json',{anonymous:true,newSamples:true,inputs,cases,sourceUpdate:{inspectionId:rec.id,periodId:ip.id,before:inspectionRow.rectification,after:'2026-09-25复查记录：临时通道盖板已复位，边缘防护警示仍缺失；本次仅确认盖板处理进展，其他问题尚未解决。'},templateSha256:hash(readFileSync(template))});
 save('fixture.json',{stage,url:'http://127.0.0.1:8931/#/agent',cases:cases.map(({expected,...c})=>c),quarter:{workbench:report.id,period:rp.id,template:t.id,inspection:rec.id,inspectionPeriod:ip.id}});
 const daily=new DatabaseSync(join(root,'data/runtime/workbench.db'),{readOnly:true}),providers=await import('../packages/server/src/ai/providers.ts');const publicConfig=[];
 for(const profile of daily.prepare("SELECT * FROM ai_profile WHERE purpose IN ('writing','reasoning') ORDER BY purpose").all()){
  const provider=daily.prepare('SELECT * FROM ai_provider WHERE id=?').get(profile.provider_id);
  if(provider.code!=='deepseek'||provider.base_url!=='https://api.deepseek.com/v1'||profile.model!=='deepseek-flash')throw Error('Current provider/model differs from existing acceptance target');
  const id=providers.upsertProvider({...provider,api_key:'',api_key_env:'CONTROLLED_EXISTING_KEY'});providers.upsertProfile({...profile,provider_id:id});
  publicConfig.push({purpose:profile.purpose,provider:provider.code,base:provider.base_url,model:profile.model,maxTokens:profile.max_tokens,temperature:profile.temperature,timeoutMs:profile.timeout_ms,extraBody:profile.extra_body});
 }
 save('model-config.frozen.json',publicConfig);daily.close();
 const evidence=await import('../packages/server/src/domain/business-evidence.ts'),tasks=await import('../packages/server/src/domain/evidence-task.ts');
 const routes=[];
 for(const c of cases.slice(0,3)){
  const inferred=evidence.inferBusinessScope(c.question,c.workbenchId,c.periodId);let scope=inferred.scope;
  if(c.id.startsWith('quarter'))scope={...scope,workbenchId:undefined,periodIds:undefined,category:'清廉工程',domain:'admin'};
  const pack=tasks.prepareEvidenceTask(await evidence.collectBusinessEvidence(scope,24000),c.question,inferred.draft?'report':'answer');
  save(c.id+'.preflight-sources.json',pack);routes.push({input:{message:c.question,workbenchId:c.workbenchId,periodId:c.periodId},inferred,actualScope:scope,required:pack.task.requiredFactIds,omitted:pack.coverage.omittedFacts});
 }
 save('entry-preflight.json',routes);db.closeDatabase();console.log('Fresh anonymous sources prepared without network');
}
if(process.argv[2]==='freeze'){
 if(existsSync(join(out,'version.frozen.json')))throw Error('Version already frozen');
 const writing=await import('../packages/server/src/domain/evidence-writing.ts');save('prompts.frozen.json',{writing:writing.WRITING_SYSTEM,review:writing.REVIEW_SYSTEM,style:'公文体，简洁准确，段落清晰；保留事实、分析、建议及待补内容的不同身份。',parameters:{temperature:0,writingMaxTokens:8192,reviewMaxTokens:4096,stream:false,response_format:{type:'json_object'},thinking:{type:'disabled'},retry:0,extraRoutes:0}});
 save('authorization.json',{source:'User message in current chat 2026-10-17',newBudget:true,total:8,writing:4,reasoning:4,retry:0,extraRoutes:0,perRequestUserConfirmation:true,stopOnAnyBlockingFailure:true,order:['training','conflict','quarter-v1','quarter-v2'],dailyPublish:false});
 const files=[...tree(join(root,'packages/server/src')),...tree(join(root,'packages/web/src')),...tree(join(root,'packages/server/test')),...tree(join(stage,'web')), ...['package.json','package-lock.json','scripts/controlled-real-prepare.mjs','scripts/controlled-real-serve.mjs'].map(path=>({path,sha256:hash(readFileSync(join(root,path)))})),...['inputs.frozen.json','fixture.json','model-config.frozen.json','prompts.frozen.json','authorization.json'].map(n=>({path:relative(root,join(out,n)),sha256:hash(readFileSync(join(out,n)))}))];
 cpSync(join(root,'packages/server/src'),join(stage,'frozen-source'),{recursive:true});save('version.frozen.json',{at:new Date().toISOString(),files});
 writeFileSync(join(out,'actual-request-ledger.jsonl'),'');console.log('Code, prompts, sources, expected facts and parameters frozen');
}
