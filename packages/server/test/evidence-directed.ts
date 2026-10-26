import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateWriting,writeEvidence,type EvidenceWriting} from '../src/domain/evidence-writing.ts';
import type {EvidencePack} from '../src/domain/business-evidence.ts';
import {prepareEvidenceTask} from '../src/domain/evidence-task.ts';
const samples=JSON.parse(readFileSync(new URL('./fixtures/directed-evidence.json',import.meta.url),'utf8')) as Record<string,{pack:EvidencePack;value:EvidenceWriting}>;
const check=(name:string,edit?:(v:EvidenceWriting)=>void)=>{const s=samples[name]!,v=structuredClone(s.value);edit?.(v);return validateWriting(v,s.pack,[...new Set(v.paragraphs.map(p=>p.field))]);};
check('complete');check('conflict');
// Change subjects, names and quantities together, preserving only the evidence
// relationship. No identifier or historical sample wording is an allow-list.
const renamed=JSON.parse(JSON.stringify(samples.complete).replaceAll('澄湖组','岚溪队').replaceAll('培训','专题会议').replaceAll('集中授课','集中研讨').replaceAll('授课','研讨').replaceAll('18人','23人').replaceAll('18名','23名'));
validateWriting(renamed.value,renamed.pack,['正文']);
const differentDispute=JSON.parse(JSON.stringify(samples.conflict).replaceAll('望岑点位','云川站').replaceAll('备用照明','消防报警').replaceAll('西侧灯具','北侧警报器').replaceAll('断电测试','联动测试').replaceAll('仍不亮','仍未鸣响').replaceAll('可持续点亮','可持续发声'));
differentDispute.value.paragraphs.reverse();validateWriting(differentDispute.value,differentDispute.pack,['正文']);
assert.throws(()=>check('complete',v=>{v.paragraphs.reverse();}),e=>(e as any).issues.some((i:any)=>i.code==='semantic_pending'));
assert.throws(()=>check('complete',v=>{v.paragraphs[1]!.text=v.paragraphs[1]!.text.replace('18','19');}),/数字/);
assert.throws(()=>check('complete',v=>{v.paragraphs[1]!.text=v.paragraphs[1]!.text.replace('3月12日','3月13日');}),/核对或登记日期/);
assert.throws(()=>check('complete',v=>{v.paragraphs[0]!.text=v.paragraphs[0]!.text.replace('3月12日','3月13日');}),/核对或登记日期/);
for(const suffix of ['但已经整改闭环。','且已恢复正常。','然而已经全部整改。'])assert.throws(()=>check('conflict',v=>{v.paragraphs[0]!.text='资料尚未齐全'+suffix;}));
for(const text of ['资料不足以证明恢复正常或整改闭环，双方记载不一致，仍待核对。','资料不能据此认定整改闭环，双方记载不一致。'])check('conflict',v=>{v.paragraphs[0]!.text=text;});
assert.throws(()=>check('conflict',v=>{v.paragraphs[0]!.citations.pop();}),/冲突/);
// The same disputed unit can span adjacent paragraphs, both binding their sources.
check('conflict',v=>{const first=v.paragraphs[0]!;first.text=first.text.split('上述分歧')[0]!;v.paragraphs.splice(1,0,{...structuredClone(first),id:'judgment',text:'上述不同记载尚未解决，现有资料不足以支持恢复正常或整改闭环的结论。'});});
assert.throws(()=>check('conflict',v=>{v.paragraphs[0]!.text='资料记载，备用照明已恢复正常。';v.paragraphs.push({...structuredClone(v.paragraphs[1]!),id:'far',text:'建议核对双方不同记载，不应认定已闭环。'});}));
for(const text of ['建议由陈明负责完成复查。','建议已安排下月15日复查。','建议于2026年5月14日完成复查。','建议责任人为王华。','建议继续归档，已经整改闭环。'])assert.throws(()=>check('conflict',v=>{v.paragraphs[1]!.text=text;}));
try{check('quarter');assert.fail('missing suggestions must fail');}catch(e){assert.ok((e as any).issues.every((i:any)=>i.code==='task_incomplete'));}
const quarter=samples.quarter!;const approved=structuredClone(quarter.pack);approved.task!.question='请复述已批准计划，缺少原计划必须待补';validateWriting(quarter.value,approved,[...new Set(quarter.value.paragraphs.map(p=>p.field))]);
const repeat=structuredClone(samples.complete!.value);repeat.paragraphs.push({...structuredClone(repeat.paragraphs[0]!),id:'repeat'});const notes:any[]=[];validateWriting(repeat,samples.complete!.pack,['正文'],w=>notes.push(...w));assert.ok(notes.some(w=>w.code==='writing_quality'));
const semantic=structuredClone(samples.complete!.value);semantic.paragraphs[1]!.text='完成日期为2026年3月12日，参训人数为18人。';assert.throws(()=>validateWriting(semantic,samples.complete!.pack,['正文']),e=>(e as any).issues.some((i:any)=>i.code==='semantic_pending'));
for(const [name,questions,noise] of [['complete',['培训完成了吗？','集中授课办完了吗，多少人参加？'],'桌椅'],['conflict',['检查结论一致吗？','两份记录分别怎么写，目前该作何判断？'],'饮水机']] as const)for(const question of questions){const pack=prepareEvidenceTask(samples[name]!.pack,question,'answer');assert.ok(!pack.facts.some(f=>pack.task!.requiredFactIds.includes(f.id)&&f.text.includes(noise)));}
(await import('../src/core/bootstrap.ts')).bootstrap();
const providers=await import('../src/ai/providers.ts'),cfg=await import('../src/core/config.ts');const provider=providers.upsertProvider({code:'fake-directed-unit',name:'离线测试',base_url:'http://127.0.0.1:19027/v1',enabled:1});
for(const purpose of ['writing','reasoning'] as const)providers.upsertProfile({purpose,name:'模拟',provider_id:provider,model:'fake-directed',max_tokens:8192});
const oldStyle='简洁准确；资料中没有的信息一律写成【待补：XXX】';cfg.setSetting('ai.writing_style',oldStyle);
const captured:any[]=[];const original=globalThis.fetch;let response:unknown=repeat,reviewMode='supported',httpStatus=200;
globalThis.fetch=async(_url,init)=>{const req=JSON.parse(String(init?.body));captured.push(req);if(httpStatus!==200)return new Response('{"error":{"message":"mock denied"}}',{status:httpStatus});const payload=JSON.parse(req.messages[1].content);const content=req.messages[0].content.includes('逐段审查')?{reviews:reviewMode==='missing'?[]:payload.paragraphs.map((p:any)=>({id:p.id,supported:reviewMode==='supported',reason:'离线模拟支持关系',qualityNote:'离线表达质量提示'}))}:response;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)},finish_reason:'stop'}]}));};
try{
 const r=await writeEvidence('培训完成了吗',samples.complete!.pack,['正文'],8192,24000);assert.equal(r.mode,'model');assert.ok(r.output);assert.ok(r.findings?.some(i=>i.code==='writing_quality'));assert.equal(r.calls[0]!.rawText,JSON.stringify(repeat));
 assert.ok(!captured[0].messages[0].content.includes('资料中没有的信息一律'));assert.match(captured[0].messages[0].content,/已批准计划/);
 // Other writing purposes still receive the user's style setting unchanged.
 await (await import('../src/ai/gateway.ts')).chat({purpose:'writing',messages:[{role:'system',content:'ordinary writing'},{role:'user',content:'{}'}]});assert.ok(captured.at(-1).messages[0].content.includes(oldStyle));
 response=quarter.value;const failed=await writeEvidence(quarter.pack.task!.question,quarter.pack,[...new Set(quarter.value.paragraphs.map(p=>p.field))],8192,24000);assert.equal(failed.output,null);assert.ok(failed.candidate);assert.deepEqual(failed.candidate,quarter.value);assert.equal(failed.calls.length,1);assert.ok(failed.findings?.some(i=>i.code==='task_incomplete'));
 // Semantic-only candidates reach the actual review call; the strict standalone validator still rejects them.
 response=semantic;
 const supported=await writeEvidence('培训完成了吗',samples.complete!.pack,['正文'],8192,24000);
 assert.equal(supported.calls.length,2);assert.ok(supported.output);assert.deepEqual(supported.candidate,semantic);
 assert.ok(supported.findings?.some(i=>i.code==='semantic_pending'));
 assert.ok(JSON.parse(captured.at(-1).messages[1].content).pendingIssues.length);
 assert.ok(supported.checks.some(s=>s.includes('人工逐项核对')));
 for(reviewMode of ['unsupported','missing']){
  const rejected=await writeEvidence('培训完成了吗',samples.complete!.pack,['正文'],8192,24000);
  assert.equal(rejected.calls.length,2);assert.equal(rejected.output,null);assert.deepEqual(rejected.candidate,semantic);
 }
 reviewMode='supported';
 for(const edit of [
  (v:EvidenceWriting)=>{v.paragraphs[1]!.text=v.paragraphs[1]!.text.replace('18','19');},
  (v:EvidenceWriting)=>{v.paragraphs[1]!.citations[0]!.quote='不存在的伪造引用原文';},
  (v:EvidenceWriting)=>{v.paragraphs[1]!.field='无权限字段';},
  (v:EvidenceWriting)=>{v.paragraphs[1]!.text='全部资料没有记载培训情况。';},
  (v:EvidenceWriting)=>{v.paragraphs.push({id:'owner',field:'正文',kind:'recommendation',text:'建议责任人为王华。',citations:[]});},
 ]){
  const bad=structuredClone(semantic);edit(bad);response=bad;
  const blocked=await writeEvidence('培训完成了吗',samples.complete!.pack,['正文'],8192,24000);
  assert.equal(blocked.calls.length,1);assert.equal(blocked.output,null);assert.deepEqual(blocked.candidate,bad);
 }
 response=semantic;httpStatus=403;
 const denied=await writeEvidence('培训完成了吗',samples.complete!.pack,['正文'],8192,24000);assert.equal(denied.calls.length,1);assert.equal(denied.output,null);httpStatus=200;
 for(const staleAt of [1,2,3,4]){
  let checks=0;
  const stale=await writeEvidence('培训完成了吗',samples.complete!.pack,['正文'],8192,24000,()=>{if(++checks===staleAt)throw Error('EVIDENCE_STALE mock 来源已变化');});
  assert.equal(stale.calls.length,[0,1,1,2][staleAt-1]);assert.equal(stale.output,null);assert.match(stale.issues.join(),/EVIDENCE_STALE/);
 }
 console.log('PASS semantic_pending 实际分流：支持/否定/缺段、混合硬错、403及三个新鲜度关口；未绕过硬校验或人工核对');
}finally{globalThis.fetch=original;(await import('../src/db/index.ts')).closeDatabase();}
console.log('PASS 定向回归：原稿承接、数字日期、否定/转折/并列、连续争议、建议部署、任务不足、质量警告、最终请求及原稿保留（仅离线模拟）');
