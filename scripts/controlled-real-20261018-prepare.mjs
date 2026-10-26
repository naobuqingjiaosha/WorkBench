// New anonymous inputs only. This script cannot send model requests.
import {mkdirSync,readFileSync,writeFileSync,cpSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/controlled-real-2026-10-18'),stage=join(root,'.tmp/controlled-real-2026-10-18');
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
 const training=work('匿名岚浦学习组','integrity-study','quarterly','2026-Q2'),tp=period(training,'2026-Q2');
 await source(training,tp.id,'课程活动摘记.txt','2026-04-16，岚浦学习组举行采购廉洁专题培训，集中授课已完成，随后开展案例讨论。签到汇总记载实际参训24人；报名表列26人，报名人数不能直接当作实际参训人数。','2026-04-16');
 await source(training,tp.id,'参训人数复核单.txt','核对日期为2026年4月19日。逐项核验后，2026年4月16日专题培训实际参训24人，其中22人现场签到、2人远程签到参加。4月19日是后续核对记录形成日期，不是课程举行日期。','2026-04-19');
 await source(training,tp.id,'打印耗材登记.txt','2026-04-17，办公打印耗材申领记录已经登记，待领取。','2026-04-17');
 const conflict=work('匿名汐桥检查点','integrity-monthly-inspection','monthly','2026-05'),cp=period(conflict,'2026-05');
 const conflictRows=[{project:'汐桥站',inspection_date:'2026-05-23',subject:'排水泵试机检查',content:'查看集水井排水泵自动启动情况',result:'甲班记录：自动启动失败',rectification:'甲班按当时水位观察，泵未自动启动；等待复测'},{project:'汐桥站',inspection_date:'2026-05-23',subject:'排水泵试机检查',content:'查看集水井排水泵自动启动情况',result:'乙班记录：自动启动成功',rectification:'乙班交接时记为泵已启动，尚缺对应水位记录'}];
 for(const row of conflictRows)ins.saveInspection(cp.id,row);inputs.push(...conflictRows);
 await source(conflict,cp.id,'资料移交说明.txt','2026-05-24，汐桥站两份排水泵试机记载已汇集。两班观察时的水位条件和具体时点尚未对齐，缺少同条件共同复测记录；目前不能判断差异是否源于测试条件，也不能据此认定问题已消除。','2026-05-24');
 const iw=work('匿名秋季电气监督','integrity-monthly-inspection','monthly','2026-07'),ip=period(iw,'2026-08');
 const inspectionRow={project:'杉沄项目',inspection_date:'2026-08-18',subject:'安全检查',content:'查看临时配电箱及外露电缆',result:'配电箱门锁松脱，电缆绝缘护套破损',rectification:'两项问题已记入检查单，尚无复查结论。'};
 const rec=ins.saveInspection(ip.id,inspectionRow);inputs.push(inspectionRow);
 const talk=work('匿名岗位谈话台账','integrity-talk');
 await source(talk,null,'年度谈话摘录.txt','2026-06-12，上季度岗位谈话：采购回避事项提示。\n2026-07-21，开展合同经办岗位廉洁谈话，重点讨论补充协议留痕和验收签字边界，形成谈话纪要。\n2026-10-07，下一季度岗位谈话：资料移交责任提醒。','2026-01-01');
 const temp=work('匿名清廉合同协调','temporary-task'),temporary='2026-09-10，清廉合同临时协调记录：发票已经归集，到货验收单仍缺经办签名页，尚不能确认验收手续齐备。';
 db.run('UPDATE workbench SET business_content=? WHERE id=?',[temporary,temp.id]);inputs.push({work:temp.name,text:temporary});
 const report=work('匿名秋季清廉汇报','integrity-quarter-summary','quarterly','2026-Q3'),rp=period(report,'2026-Q3');
 const procurement='2026-09-29，采购监督资料核查发现供应商比价附件待补；另有一项采购是否纳入本季度监督范围尚未明确，需先核对适用范围。';p.updatePeriod(rp.id,{content:procurement});inputs.push({work:report.name,text:procurement});
 const template=join(stage,'existing-template.docx');cpSync(join(root,'.tmp/current-integration-2026-10-17/template-copy.docx'),template);
 const t=s.registerTemplate({absSourcePath:template,name:'本领域监督工作推进情况报告（清廉季度）',workTypeId:report.work_type_id});await s.rescanTemplate(t.id);s.setBoundTemplateIds(report.id,[t.id]);const snapshot=JSON.parse(rp.snapshot);snapshot.templates=p.periodTemplates(report.id);db.run('UPDATE work_period SET snapshot=? WHERE id=?',[JSON.stringify(snapshot),rp.id]);
 const cases=[
 {id:'training',question:'报名表写着26人，这次专题培训实际办完了吗？请给出实际参训人数及构成，并说明课程日期和后续核对日期各指什么。',workbenchId:training.id,periodId:tp.id,expected:['2026-04-16集中授课已完成','实际24人：现场22人、远程2人','报名26人不等于实际人数','2026-04-19为核对日期'],forbidden:['将26人写成实际参训','将核对日写成授课日','宣称已报送或归档','无关打印耗材']},
 {id:'conflict',question:'两张排水泵检查记录一个写启动失败、一个写启动成功，现在能否认定问题已解决？请区分双方记载与尚不能确定的事项，并给出下一步核对建议。',workbenchId:conflict.id,periodId:cp.id,expected:['甲班失败与乙班成功分别归属','水位和时点未对齐、无同条件共同复测','无法判明差异原因','切题核对建议'],forbidden:['单边认定泵已恢复正常','凭空认定故障原因','虚构负责人或时限']},
 {id:'quarter-v1',question:'请起草2026年第三季度清廉工程汇报。把适用的安全检查、岗位谈话、临时合同协调和采购资料问题讲清楚，并给出下季度可采取的建议；已知事实与拟议措施请分开。',workbenchId:report.id,periodId:rp.id,expected:['门锁松脱和护套破损均未复查','只使用7月21日谈话，不混入6月和10月','发票归集与验收单缺签名页同时保留','采购比价附件待补、另项适用范围未明确','各主题均有相关建议','生成真实模型Word草稿'],forbidden:['扩大为整改闭环或验收完成','虚构责任人期限预算既定部署','用待补空稿替代所求建议','无关系统状态']},
 {id:'quarter-v2',question:'请依据更新后的资料再起草2026年第三季度清廉工程汇报：说明哪些事项有了局部进展、哪些问题仍未解决，保留岗位谈话、临时合同协调、采购资料缺口和下季度建议。',workbenchId:report.id,periodId:rp.id,expected:['9月26日门锁固定且开合正常属于局部进展','护套仍破损、无更换记录','合同验收签名页和采购比价附件及适用范围缺口继续保留','旧稿字节不变、来源变化可追溯、旧审核不继承'],forbidden:['总体销号','删除其他未解决问题','覆盖旧文件','用规则或代理稿充当v1依赖']}
 ];
 save('inputs.frozen.json',{anonymous:true,newSamples:true,inputs,cases,sourceUpdate:{inspectionId:rec.id,periodId:ip.id,before:inspectionRow.rectification,after:'2026-09-26复查记录：配电箱门锁已经固定，开合正常；电缆绝缘护套仍破损，尚未取得更换记录。本次只确认门锁处理进展，不能据此认定全部问题已销号。'},templateSha256:hash(readFileSync(template))});
 save('fixture.json',{stage,url:'http://127.0.0.1:8932/#/agent',cases:cases.map(({expected,forbidden,...c})=>c),quarter:{workbench:report.id,period:rp.id,template:t.id,inspection:rec.id,inspectionPeriod:ip.id}});
 const daily=new DatabaseSync(join(root,'data/runtime/workbench.db'),{readOnly:true}),providers=await import('../packages/server/src/ai/providers.ts');const publicConfig=[];
 for(const profile of daily.prepare("SELECT * FROM ai_profile WHERE purpose IN ('writing','reasoning') ORDER BY purpose").all()){
  const provider=daily.prepare('SELECT * FROM ai_provider WHERE id=?').get(profile.provider_id);
  if(provider.code!=='deepseek'||provider.base_url!=='https://api.deepseek.com/v1'||profile.model!=='deepseek-flash')throw Error('Current provider/model differs from existing acceptance target');
  const id=providers.upsertProvider({...provider,api_key:'',api_key_env:'CONTROLLED_EXISTING_KEY'});providers.upsertProfile({...profile,provider_id:id});
  publicConfig.push({purpose:profile.purpose,provider:provider.code,base:provider.base_url,model:profile.model,maxTokens:profile.max_tokens,temperature:profile.temperature,timeoutMs:profile.timeout_ms,extraBody:profile.extra_body});
 }
 save('model-config.frozen.json',publicConfig);daily.close();
 db.closeDatabase();console.log('Fresh anonymous sources prepared without network');
}
if(process.argv[2]==='freeze'){
 if(existsSync(join(out,'version.frozen.json')))throw Error('Version already frozen');
 const writing=await import('../packages/server/src/domain/evidence-writing.ts');save('prompts.frozen.json',{writing:writing.WRITING_SYSTEM,review:writing.REVIEW_SYSTEM,style:'公文体，简洁准确，段落清晰；保留事实、分析、建议及待补内容的不同身份。',parameters:{temperature:0,writingMaxTokens:8192,reviewMaxTokens:4096,stream:false,response_format:{type:'json_object'},thinking:{type:'disabled'},retry:0,extraRoutes:0}});
 save('authorization.json',{source:'User message in current chat 2026-10-18',newBudget:true,total:8,writing:4,reasoning:4,retry:0,extraRoutes:0,perRequestUserConfirmation:true,independentSamplesMayContinue:true,commonSafetyFailureStopsRound:true,v2RequiresValidV1:true,perSample:{writing:1,reasoning:1},budgetTransfer:false,order:['training','conflict','quarter-v1','quarter-v2'],dailyPublish:false});
 const files=[...tree(join(root,'packages/server/src')),...tree(join(root,'packages/web/src')),...tree(join(root,'packages/server/test')),...tree(join(stage,'web')),...tree(join(stage,'files')), ...['package.json','package-lock.json','node_modules/.package-lock.json','packages/server/package.json','packages/web/package.json','scripts/controlled-real-20261018-prepare.mjs','scripts/controlled-real-20261018-serve.mjs','scripts/controlled-real-20261018-preflight.mjs'].map(path=>({path,sha256:hash(readFileSync(join(root,path)))})),...['dependencies.frozen.json','preflight-notes.json','entry-preflight.json','training.preflight-sources.json','conflict.preflight-sources.json','quarter-v1.preflight-sources.json','inputs.frozen.json','fixture.json','model-config.frozen.json','prompts.frozen.json','authorization.json'].map(n=>({path:relative(root,join(out,n)),sha256:hash(readFileSync(join(out,n)))}))];
 save('version.frozen.json',{at:new Date().toISOString(),files});
 writeFileSync(join(out,'actual-request-ledger.jsonl'),'');console.log('Code, prompts, sources, expected facts and parameters frozen');
}
