import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';

import type {EvidencePack} from '../src/domain/business-evidence.ts';
mkdirSync('.tmp',{recursive:true});const root=process.env.WORKBENCH_ISOLATION_ROOT!;
process.env.WORKBENCH_TEST_MODE='1';
const {validateWriting,writeEvidence,materialize}=await import('../src/domain/evidence-writing.ts');
(await import('../src/core/bootstrap.ts')).bootstrap();
const providers=await import('../src/ai/providers.ts');const provider=providers.upsertProvider({code:'fake-writing-contract',name:'模拟',base_url:'http://127.0.0.1:19001/v1',enabled:1});
for(const purpose of ['writing','reasoning'] as const)providers.upsertProfile({purpose,name:'模拟',provider_id:provider,model:'fake-writing',max_tokens:8192,timeout_ms:20});
const pack:EvidencePack={scope:{start:'2026-07-01',end:'2026-10-01'},acquiredAt:'',selectionDigest:'',sources:[],files:[],conflicts:[],gaps:[],metrics:{inspections:0,projects:0,duplicateRecords:0,periods:1,completedPeriods:0},coverage:{workbenches:1,periods:1,candidateFiles:0,readFiles:0,omittedFacts:0,chars:100,budget:24000},facts:[{id:'F1',text:'人工填报内容：计划于2026-09-20开展廉洁学习，目前没有实际学习记录。',certainty:'unverified',sources:['work_period:1'],kind:'record'}]};
const valid={paragraphs:[{id:'P1',field:'正文',kind:'fact',text:'填报内容显示，廉洁学习安排在2026年9月20日，目前缺少实际学习记录，尚不能确认活动已开展。',citations:[{factId:'F1',quote:'计划于2026-09-20开展廉洁学习，目前没有实际学习记录'}]}]};
pack.sources=[{id:'work_period:1',table:'work_period',recordId:1,workbenchId:1,periodId:1,title:'离线来源',status:'open',locator:'离线记录',href:'#',digest:'offline-fixture-snapshot',acquiredAt:''}];
assert.deepEqual(validateWriting(valid,pack,['正文']),valid);
for(const text of ['资料尚未提供签到记录，但已完成整改并验收通过。','资料未证明完成整改，也不能据此认定验收通过。']){
 const answer={paragraphs:[{...valid.paragraphs[0]!,text}]};
 if(text.includes('但已'))assert.throws(()=>validateWriting(answer,pack,['正文']),/无依据/);
 else assert.doesNotThrow(()=>validateWriting(answer,pack,['正文']));
}
assert.throws(()=>validateWriting({paragraphs:[{...valid.paragraphs[0]!,kind:'recommendation',text:'建议归档，因为资料已经完成整改并验收通过。'}]},pack,['正文']),/无依据/);
for(const text of ['资料记载，验收通过与否尚不明确。','资料记载，完成交付状态待核实。','资料记载，整改闭环情况不明。'])assert.doesNotThrow(()=>validateWriting({paragraphs:[{...valid.paragraphs[0]!,text}]},pack,['正文']));
for(const text of ['资料记载，验收通过，但后续情况不明。','资料记载，整改闭环情况不明，但已完成交付。','资料记载已整改闭环，其他情况不明。'])assert.throws(()=>validateWriting({paragraphs:[{...valid.paragraphs[0]!,text}]},pack,['正文']),/无依据/);
const uncertainSource={...pack,facts:[{...pack.facts[0]!,text:'资料记载：验收通过与否尚不明确。'}]};
assert.throws(()=>validateWriting({paragraphs:[{...valid.paragraphs[0]!,text:'资料记载，验收通过。',citations:[{factId:'F1',quote:uncertainSource.facts[0]!.text}]}]},uncertainSource,['正文']),/无依据/);
for(const patch of [{citations:[{factId:'F999',quote:'计划于2026-09-20开展廉洁学习'}]},{citations:[{factId:'F1',quote:'活动已经完成'}]},{text:'记录显示，在2026年9月21日完成了廉洁学习。'},{text:'记录显示已完成整改，全部验收通过。'},{field:'未授权字段'}])assert.throws(()=>validateWriting({paragraphs:[{...valid.paragraphs[0],...patch}]},pack,['正文']));
const badCount={...pack,metrics:{...pack.metrics,inspections:4,projects:2}};assert.throws(()=>validateWriting(valid,badCount,['正文']),/遗漏程序/);
const metricOnly={...pack,facts:[{...pack.facts[0]!,kind:'metric' as const,text:'统计登记资料共计四份，未自动合并。'}]};
for(const kind of ['fact','analysis','recommendation'])assert.throws(()=>validateWriting({paragraphs:[{id:'summary',field:'正文',kind,text:'从现有资料看，未记载培训成果，建议补充。',citations:[{factId:'F1',quote:metricOnly.facts[0]!.text}]}]},metricOnly,['正文']),/统计总数不能/);
assert.doesNotThrow(()=>validateWriting({paragraphs:[{id:'request',field:'正文',kind:'recommendation',text:'建议补充培训成果及对应凭证，供后续核对。',citations:[]}]},metricOnly,['正文']));
assert.equal(materialize('记录{{inspections}}条，项目{{projects}}个。',badCount),'记录4条，项目2个。');
const counts={paragraphs:[{...valid.paragraphs[0],text:'资料记载，检查记录共4条，涉及{{projects}}个登记项目。检查记录的存在不等于整改闭环。'}]};
const metric={id:'F2',text:'程序统计检查记录4条，涉及登记项目2个。',certainty:'confirmed' as const,sources:[],kind:'metric'};
badCount.facts=[...badCount.facts,metric];counts.paragraphs[0]!.citations=[...counts.paragraphs[0]!.citations!,{factId:metric.id,quote:metric.text}];
assert.match(validateWriting(counts,badCount,['正文']).paragraphs[0]!.text,/\{\{inspections\}\}/);
assert.match(counts.paragraphs[0]!.text,/共4条/); // Raw model output is immutable.
assert.throws(()=>validateWriting({paragraphs:[{...counts.paragraphs[0],text:counts.paragraphs[0]!.text.replace('共4条','共5条')}]},badCount,['正文']),/总体统计/);
const conflictPack={...pack,conflicts:[{field:'同项目检查结果',candidates:[{value:'签字页缺失',source:'inspection_record:1'},{value:'签字页齐全',source:'inspection_record:2'}]}]};
assert.throws(()=>validateWriting({paragraphs:[{...valid.paragraphs[0],text:'据此分析，检查记录不等于整改闭环，签字页存在不一致记载，仍需核对。',kind:'analysis'}]},conflictPack,['正文']),/未引用全部/);
console.log('PASS 同义段落通过；伪造ID/锚点、错误日期、完成断言、字段和统计口径拒绝');
let mode='valid',calls=0;const original=globalThis.fetch;
globalThis.fetch=async(_url,init)=>{
 calls++;const body=JSON.parse(String(init?.body));
 if(mode==='timeout')return await new Promise(()=>{});
 if(mode==='rate')return new Response(JSON.stringify({error:{message:'anonymous rate limit'}}),{status:429});
 if(mode==='context')return new Response(JSON.stringify({error:{message:'maximum context length exceeded'}}),{status:400});
 const reviewing=body.messages[0].content.includes('逐段审查');
 const content=mode==='format'?'not-json':reviewing?JSON.stringify({reviews:[{id:'P1',supported:mode!=='semantic',reason:mode==='semantic'?'所引材料不能证明该结论':'段落准确区分计划和未核实发生状态'}]}):JSON.stringify(valid);
 return new Response(JSON.stringify({model:'fake-writing',choices:[{message:{content},finish_reason:mode==='truncated'?'length':'stop'}],usage:{prompt_tokens:100,completion_tokens:100,total_tokens:200}}));
};
try{
 const passed=await writeEvidence('学习情况',pack,['正文'],8192,24000);assert.equal(passed.mode,'model');assert.match(passed.status,/模拟/);assert.equal(passed.calls.length,2);assert.ok(passed.calls.every(c=>c.rawText));
 for(mode of ['timeout','rate','context','format','truncated','semantic']){const result=await writeEvidence('学习情况',pack,['正文'],8192,24000);assert.equal(result.mode,'local-rules',mode);assert.equal(result.output,null);assert.ok(result.issues.length,mode);assert.ok(result.calls.length<=2);console.log('PASS '+mode+' 明确失败并保留调用结果，不伪装模型写作');}
 const before=calls;const small=await writeEvidence('问题'.repeat(4000),pack,['正文'],8192,4000);assert.equal(calls,before);assert.match(small.issues.join(),/未发送/);
}finally{globalThis.fetch=original;(await import('../src/db/index.ts')).closeDatabase();}
