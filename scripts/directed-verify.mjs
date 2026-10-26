import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,cpSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {isolationEnv} from './isolation-env.mjs';
import {installMock,configureMock,captures,state} from './directed-mock.mjs';
const tag=process.env.DIRECTED_RUN??'';if(tag&&!/^[a-z0-9-]+$/.test(tag))throw Error('Invalid run tag');
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/directed-offline-2026-10-17',tag),src=join(root,'.tmp/directed-offline-2026-10-17/input/real-results');
const fixture=JSON.parse(readFileSync(join(out,'fixture.json')));
Object.assign(process.env,isolationEnv(fixture.root));
const db=await import('../packages/server/src/db/index.ts');db.openDatabase(process.env.WORKBENCH_DB);
const {validateWriting}=await import('../packages/server/src/domain/evidence-writing.ts');
const {prepareEvidenceTask}=await import('../packages/server/src/domain/evidence-task.ts');
const {extractDocx}=await import('../packages/server/src/core/extract.ts');
const store=await import('../packages/server/src/core/store.ts');
const results=[];const test=(name,fn)=>{fn();results.push({name,pass:true});};
const samples={};
for(const [name,prefix] of [['complete','01-complete'],['conflict','02-conflict'],['quarter-v1','03-quarter-v1']])samples[name]={value:JSON.parse(readFileSync(join(src,`${prefix}-writing.model-original.txt`))),pack:JSON.parse(readFileSync(join(src,`${name}.result.json`))).evidence};
const check=(sample,edit)=>{const v=structuredClone(sample.value);edit?.(v);return validateWriting(v,sample.pack,[...new Set(v.paragraphs.map(p=>p.field))]);};
test('T01 original source continuity',()=>check(samples.complete));
test('T01 number 18 to 19',()=>assert.throws(()=>check(samples.complete,v=>v.paragraphs[1].text=v.paragraphs[1].text.replace('18','19')),/数字/));
test('T01 bookkeeping date not occurrence',()=>assert.throws(()=>check(samples.complete,v=>v.paragraphs[1].text=v.paragraphs[1].text.replace('3月12日','3月13日')),/核对或登记日期/));
test('T02 original negative conclusion',()=>check(samples.conflict));
for(const text of ['资料不足，但已经全部整改并恢复正常。','资料记载，目前已恢复正常并已整改闭环。','资料不足以支持此前判断，然而已经整改闭环。'])test('T02 reject '+text,()=>assert.throws(()=>check(samples.conflict,v=>v.paragraphs[0].text=text)));
for(const text of ['现有资料不足以证明整改闭环，双方记载不一致，仍待核对。','资料不能据此认定恢复正常或整改闭环，双方记载不一致。'])test('T02 negative scope '+text,()=>check(samples.conflict,v=>v.paragraphs[0].text=text));
test('T03 one-sided citation',()=>assert.throws(()=>check(samples.conflict,v=>v.paragraphs[0].citations.pop()),/冲突/));
test('T03 distant disclaimer cannot support assertion',()=>assert.throws(()=>check(samples.conflict,v=>{v.paragraphs[0].text='资料记载，备用照明已经恢复正常。';v.paragraphs.push({...v.paragraphs[1],id:'far',text:'建议核对双方不一致记载，目前不能认定整改闭环。'});}))); 
test('T03 unrelated citations cannot inherit context',()=>assert.throws(()=>check(samples.complete,v=>v.paragraphs[1].citations=[{factId:'F3',quote:samples.complete.pack.facts.find(f=>f.id==='F3').text}])));
test('T05 placeholders have incomplete-task only',()=>{try{check(samples['quarter-v1']);assert.fail('must reject');}catch(e){assert.ok(e.issues?.every(i=>i.code==='task_incomplete'));}});
test('T06 grounded recommendation',()=>check(samples.conflict));
for(const text of ['建议由陈明负责完成复查。','建议已安排下月15日完成复查。','建议继续归档，资料已经整改闭环。'])test('T06 reject '+text,()=>assert.throws(()=>check(samples.conflict,v=>v.paragraphs[1].text=text)));
test('T01 renamed sources and paragraph IDs',()=>{const s=structuredClone(samples.complete);for(const f of s.pack.facts){const old=f.id;f.id='E'+old;for(const p of s.value.paragraphs){p.id='changed-'+p.id;for(const c of p.citations)if(c.factId===old)c.factId=f.id;}}s.pack.task.factIds=s.pack.task.factIds.map(id=>'E'+id);s.pack.task.requiredFactIds=s.pack.task.requiredFactIds.map(id=>'E'+id);check(s);});
test('T05 expression repetition is warning',()=>{const s=structuredClone(samples.complete);s.value.paragraphs.push({...s.value.paragraphs[0],id:'repeat'});const warnings=[];validateWriting(s.value,s.pack,['正文'],w=>warnings.push(...w));assert.ok(warnings.some(w=>w.code==='writing_quality'));});
const restore=installMock();await configureMock();
const app=(await import('fastify')).default();(await import('../packages/server/src/api/routes-agent.ts')).registerAgentRoutes(app);
const routes=[];
const cases=[['complete',['培训完成了吗？','这次集中授课办完了吗，哪天办的，有多少人参加？','请说明课程的开展情况与参训人数。']],['conflict',['检查结论一致吗？','两份记录分别怎么写，目前该作何判断？','备用照明检查目前能得出什么结论？']],['quarter',['帮我起草季度汇报','请据第三季度材料写清廉工程季度汇报','请编写本期监督工作报告，说明检查、谈话、临时事项和下阶段建议。']]];
try{
 for(const [name,questions] of cases)for(const message of questions){
  const payload={message,workbenchId:fixture[name].workbench,periodId:fixture[name].period};
  const res=await app.inject({method:'POST',url:'/api/agent/chat',payload});assert.equal(res.statusCode,201,res.body);const r=res.json().data.business;assert.ok(r,'normal chat must use evidence path');
  assert.equal(r.evidence.task.mode,name==='quarter'?'report':'answer');
  const required=r.evidence.facts.filter(f=>r.evidence.task.requiredFactIds.includes(f.id));assert.ok(required.length);assert.ok(!required.some(f=>/桌椅|饮水机/.test(f.text)));
  if(name==='quarter'){assert.ok(r.artifactId,JSON.stringify(r.validation));assert.equal(r.writing.mode,'local-rules');assert.ok(r.writing.candidate);assert.ok(Object.values(r.draft.values).join().includes('谈话'));assert.ok(!Object.values(r.draft.values).join().includes('模型写作未通过'));}
  routes.push({input:payload,runId:r.id,scope:r.evidence.scope,task:r.evidence.task,required,writing:r.writing.status,artifactId:r.artifactId});
 }
 // Also exercise automatic context from the sole substantive period, without explicit scope/draft/template parameters.
 for(const name of ['complete','conflict','quarter']){const message=cases.find(c=>c[0]===name)[1][0];const res=await app.inject({method:'POST',url:'/api/agent/chat',payload:{message,workbenchId:fixture[name].workbench}});assert.equal(res.statusCode,201,res.body);routes.push({automatic:true,input:message,scope:res.json().data.business.evidence.scope,task:res.json().data.business.evidence.task});}
 const fallbackId=routes.filter(r=>r.artifactId).at(-1).runId;
 const b=await import('../packages/server/src/domain/business-assistant.ts');const fallback=b.getBusinessRun(fallbackId);
 const a=store.getArtifact(fallback.artifactId);const bytes=readFileSync(store.artifactAbsPath(a));const text=extractDocx(bytes);
 for(const phrase of ['固定件松动','岗位廉洁谈话','验收附件尚未补齐','采购监督支持资料待补'])assert.ok(text.includes(phrase),phrase);
 assert.ok(!/模型写作未通过|建议逐项核对/.test(text));assert.match(a.file_name,/未核验/);
 cpSync(store.artifactAbsPath(a),join(out,'quarter-fallback-待整理未核验.docx'));
 writeFileSync(join(out,'fallback-result.json'),JSON.stringify(fallback,null,2));
 state.mode='success';const normal=await app.inject({method:'POST',url:'/api/agent/chat',payload:{message:'请起草第三季度清廉工程汇报，说明各项工作和下阶段建议。',workbenchId:fixture.quarter.workbench,periodId:fixture.quarter.period}});assert.equal(normal.statusCode,201,normal.body);const r=normal.json().data.business;assert.equal(r.writing.mode,'model',JSON.stringify(r.writing));assert.match(r.writing.status,/模拟/);
 cpSync(store.artifactAbsPath(store.getArtifact(r.artifactId)),join(out,'quarter-simulated-model.docx'));writeFileSync(join(out,'simulated-result.json'),JSON.stringify(r,null,2));
 const writingRequests=captures.filter(c=>!c.messages[0].content.includes('逐段审查'));
 assert.ok(writingRequests.length);for(const req of writingRequests){assert.ok(!req.messages[0].content.includes('资料中没有的信息一律'));assert.match(req.messages[0].content,/已批准计划/);assert.match(req.messages[0].content,/资料未逐字记载/);}
 writeFileSync(join(out,'final-requests.mock.json'),JSON.stringify(captures,null,2));
 results.push({name:'T04 final gateway capture; T07 12 normal chat routes; T08/T09 both Word paths',pass:true});
}finally{restore();await app.close();db.closeDatabase();writeFileSync(join(out,'directed-tests.json'),JSON.stringify(results,null,2));writeFileSync(join(out,'normal-entry-routes.json'),JSON.stringify(routes,null,2));}
console.log(JSON.stringify({passed:results.length,routes:routes.length,externalRequests:0}));
