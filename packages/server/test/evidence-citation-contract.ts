import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectWriting,validateWriting,writeEvidence,WRITING_SYSTEM,type EvidenceWriting} from '../src/domain/evidence-writing.ts';
import {isWritingWarning} from '../src/domain/evidence-checks.ts';
import {prepareEvidenceTask} from '../src/domain/evidence-task.ts';
import type {EvidencePack} from '../src/domain/business-evidence.ts';
import type {BusinessResult} from '../src/domain/business-assistant.ts';
const frozen=JSON.parse(readFileSync(new URL('./fixtures/training-frozen.json',import.meta.url),'utf8'));
const pack=frozen.pack as EvidencePack,rawText=frozen.rawText as string,value=JSON.parse(rawText) as EvidenceWriting;
assert.equal(createHash('sha256').update(rawText).digest('hex'),frozen.rawSha256);
const results:{name:string;pass:boolean}[]=[];
const test=(name:string,fn:()=>void)=>{fn();results.push({name,pass:true});};
const inspect=(edit?:(v:EvidenceWriting,p:EvidencePack)=>void)=>{const v=structuredClone(value),p=structuredClone(pack);edit?.(v,p);return inspectWriting(v,p,['正文']);};
const hard=(r:ReturnType<typeof inspect>)=>r.findings.filter(f=>!isWritingWarning(f)&&f.code!=='semantic_pending');
const replay=inspect();
test('原始training逐字回放，无输入改写；定位与事实检查分开',()=>{
 assert.deepEqual(replay.output,value);assert.equal(hard(replay).length,0,JSON.stringify(replay.findings));
 assert.ok(replay.findings.some(f=>f.code==='citation_quality'));
 assert.ok(replay.findings.some(f=>f.category==='quality'&&f.paragraphId==='p3'));
 const loc=replay.citationLocations.find(c=>c.paragraphId==='p3'&&c.factId==='F3')!;
 assert.equal(loc.originalQuote,'经逐人核对');assert.equal(pack.facts.find(f=>f.id==='F3')!.text.slice(loc.start,loc.end),loc.originalQuote);
 assert.equal(loc.context,pack.facts.find(f=>f.id==='F3')!.text.slice(loc.contextStart,loc.contextEnd));
});
for(const quote of ['逐人核对','经逐人核对','均为实际参加','核对日期为2026年2月27日'])test(`唯一同源锚点 ${quote.length} 字`,()=>{
 const r=inspect(v=>v.paragraphs[2]!.citations[1]!.quote=quote);assert.equal(hard(r).length,0,JSON.stringify(r.findings));
});
for(const [name,code,edit] of [
 ['伪造长引文','citation_quote_not_found',(v:EvidenceWriting)=>{v.paragraphs[2]!.citations[1]!.quote='并不存在的逐人核对记录';}],
 ['错误ID','citation_id_missing',(v:EvidenceWriting)=>{v.paragraphs[2]!.citations[1]!.factId='F999';}],
 ['从其他文件取短语不能修换来源','citation_quote_not_found',(v:EvidenceWriting)=>{v.paragraphs[2]!.citations[1]!.factId='F4';}],
 ['重复位置不明','citation_ambiguous',(_v:EvidenceWriting,p:EvidencePack)=>{p.facts.find(f=>f.id==='F3')!.text+='经逐人核对';}],
 ['空引文','citation_quote_missing',(v:EvidenceWriting)=>{v.paragraphs[2]!.citations[1]!.quote='';}],
 ['越出任务范围','citation_out_of_scope',(_v:EvidenceWriting,p:EvidencePack)=>{p.task!.factIds=p.task!.factIds.filter(id=>id!=='F3');}],
 ['跨期次来源','citation_out_of_scope',(_v:EvidenceWriting,p:EvidencePack)=>{p.sources.find(s=>s.id==='artifact:2')!.periodId=99;}],
 ['跨工作来源','citation_out_of_scope',(_v:EvidenceWriting,p:EvidencePack)=>{p.sources.find(s=>s.id==='artifact:2')!.workbenchId=99;}],
 ['来源快照缺失','source_integrity',(_v:EvidenceWriting,p:EvidencePack)=>{p.sources=p.sources.filter(s=>s.id!=='artifact:2');}],
 ] as const)test(name,()=>assert.ok(hard(inspect(edit)).some(f=>f.code===code)));
test('同一引用根因合并日期及月日关联影响；不隐藏独立人数错误',()=>{
 const r=inspect(v=>{v.paragraphs[2]!.citations[1]!.quote='不存在的引用';v.paragraphs[2]!.text=v.paragraphs[2]!.text.replace('21人','22人');});
 const root=r.findings.find(f=>f.code==='citation_quote_not_found')!;
 assert.equal(root.related?.length,2,JSON.stringify(r.findings));
 assert.ok(root.related!.every(f=>/2026-2-27|2-27/.test(f.message)));
 assert.ok(r.findings.some(f=>f.code==='unsupported_claim'&&f.message.includes('22')));
});
for(const text of ['资料记载，参训人数为22人。','资料记载，授课日为2026年2月27日。','资料记载，2月27日举行了本次培训。','资料记载，培训已经完成正式报送。','资料记载，正式报送已完成。','资料记载，主讲人为赵海。'])test(`analysis硬错误仍拒绝：${text}`,()=>{
 const r=inspect(v=>v.paragraphs[2]!.text=text);assert.ok(hard(r).some(f=>f.code==='unsupported_claim'),JSON.stringify(r.findings));
});
for(const text of ['其记载支持该次课程已有开展记录，报送是否完成仍不能确认。','现有记载不足以支持报送完成。'])test(`analysis无固定提示词且未夸大：${text}`,()=>assert.equal(hard(inspect(v=>v.paragraphs[2]!.text=text)).length,0));
test('匿名名称、日期、人数变更不改变支持边界',()=>{
 const renamed=JSON.parse(JSON.stringify({value,pack}).replaceAll('槐序','杉川').replaceAll('2026年2月24日','2027年5月11日').replaceAll('2026-02-24','2027-05-11').replaceAll('2026年2月27日','2027年5月14日').replaceAll('2026-02-27','2027-05-14').replaceAll('21人','29人').replaceAll('21名','29名'));
 assert.equal(hard(inspectWriting(renamed.value,renamed.pack,['正文'])).length,0);
 renamed.value.paragraphs[2].text='资料记载，授课日为2027年5月14日，参加人数为30人。';
 const bad=inspectWriting(renamed.value,renamed.pack,['正文']);assert.ok(bad.findings.some(f=>/核对或登记日期/.test(f.message)));assert.ok(bad.findings.some(f=>f.code==='unsupported_claim'&&/30/.test(f.message)));
});
test('非任务状态空值保留在来源说明，不形成问答待补任务',()=>{
 const p=structuredClone(pack);p.gaps.push('培训实际报送日期未登记');
 assert.ok(!prepareEvidenceTask(p,pack.task!.question,'answer').task!.businessGaps.length);
});
// All network is replaced before normal entry. Fixture replay is development regression, not acceptance.
(await import('../src/core/bootstrap.ts')).bootstrap();
const providers=await import('../src/ai/providers.ts'),db=await import('../src/db/index.ts');
const provider=providers.upsertProvider({code:'fake-citation-contract',name:'引用契约离线测试',base_url:'http://127.0.0.1:19027/v1',enabled:1});
for(const purpose of ['writing','reasoning'] as const)providers.upsertProfile({purpose,name:'离线',provider_id:provider,model:'fake-contract',max_tokens:8192});
const captures:any[]=[];let response=rawText,reviewSupported=true;
const original=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 assert.ok(String(url).startsWith('http://127.0.0.1:19027/'),'禁止外发');
 const req=JSON.parse(String(init?.body));captures.push(req);const payload=JSON.parse(req.messages[1].content);
 const content=req.messages[0].content.includes('逐段审查')?JSON.stringify({reviews:payload.paragraphs.map((p:any)=>({id:p.id,supported:reviewSupported,reason:reviewSupported?'离线流程模拟支持，不是真实语义验收':'离线模拟语义不支持'}))}):response;
 return new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}));
};
let replayAudit,entryResult:BusinessResult;
try{
 replayAudit=await writeEvidence(pack.task!.question,pack,['正文'],8192,24000);
 test('原始rawText、candidate完整保留且未跳过逐段辅助复核',()=>{assert.equal(replayAudit!.calls[0]!.rawText,rawText);assert.deepEqual(replayAudit!.candidate,value);assert.ok(replayAudit!.output);assert.equal(replayAudit!.calls.length,2);assert.ok(replayAudit!.citationLocations?.length);});
 reviewSupported=false;const pending=await writeEvidence(pack.task!.question,pack,['正文'],8192,24000);reviewSupported=true;
 test('定位成功不替代语义支持，复核否定仍保留全文待核',()=>{assert.equal(pending.output,null);assert.deepEqual(pending.candidate,value);assert.ok(pending.findings!.some(f=>f.code==='semantic_pending'));});
 const bad=structuredClone(value);bad.paragraphs[2]!.text='参加人数为22人，报送已经完成。';response=JSON.stringify(bad);
 const blocked=await writeEvidence(pack.task!.question,pack,['正文'],8192,24000);
 test('混合硬错误不得进入辅助复核可放行路径',()=>{assert.equal(blocked.calls.length,1);assert.equal(blocked.output,null);});response=rawText;
 const badQuote=structuredClone(value);badQuote.paragraphs[2]!.citations[1]!.quote='不存在的引用';response=JSON.stringify(badQuote);
 const grouped=await writeEvidence(pack.task!.question,pack,['正文'],8192,24000);response=rawText;
 test('完整调用路径保留单一引用根因和两项关联日期影响',()=>{const roots=grouped.findings!.filter(f=>f.code==='citation_quote_not_found');assert.equal(roots.length,1);assert.equal(roots[0]!.related?.length,2);assert.equal(grouped.calls.length,1);assert.equal(grouped.output,null);});
 for(const at of [1,2,3,4]){let n=0;const stale=await writeEvidence(pack.task!.question,pack,['正文'],8192,24000,()=>{if(++n===at)throw Object.assign(Error('来源版本已变化'),{code:'EVIDENCE_STALE'});});test(`新鲜度关口${at}`,()=>{assert.equal(stale.output,null);assert.equal(stale.calls.length,[0,1,1,2][at-1]);assert.ok(stale.findings!.some(f=>f.code==='source_stale'));});}
 const denied=await writeEvidence(pack.task!.question,pack,['正文'],8192,24000,()=>{throw Object.assign(Error('来源访问被拒绝'),{code:'EVIDENCE_PERMISSION'});});
 test('权限拒绝独立诊断且无调用',()=>{assert.equal(denied.calls.length,0);assert.equal(denied.findings![0]!.category,'source');});
 const s=await import('../src/domain/service.ts'),periods=await import('../src/domain/periods.ts'),store=await import('../src/core/store.ts');
 const w=s.createWorkbench({name:'匿名槐序学习小组',workTypeId:s.listWorkTypes().find(t=>t.code==='integrity-study')!.id,templateIds:[]});
 periods.savePeriodRule(w.id,{frequency:'quarterly',first_period:'2026-Q1',requirements:[]});periods.syncPeriods(w.id,'2026-04-01');
 const period=periods.listPeriods(w.id).find(p=>p.report_period==='2026-Q1')!;
 for(const id of ['F4','F3','F5']){const f=pack.facts.find(f=>f.id===id)!,source=pack.sources.find(s=>s.id===f.sources[0])!;const a=(await store.saveArtifact({data:f.bodyText!,dirAbs:s.workbenchOutputDirAbs(w,'source'),fileName:source.title,title:source.title,kind:'source',workbenchId:w.id})).artifact;db.run('UPDATE artifact SET work_period_id=?,doc_date=? WHERE id=?',[period.id,id==='F3'?'2026-02-27':'2026-02-24',a.id]);}
 const app=(await import('fastify')).default();(await import('../src/api/routes-agent.ts')).registerAgentRoutes(app);
 try{const res=await app.inject({method:'POST',url:'/api/agent/chat',payload:{message:pack.task!.question,workbenchId:w.id,periodId:period.id}});assert.equal(res.statusCode,201,res.body);entryResult=res.json().data.business;
 test('正常聊天入口最终请求、契约、原稿和展示记录一致',()=>{assert.ok(entryResult.writing!.output,JSON.stringify(entryResult.writing));assert.equal(entryResult.writing!.calls[0]!.rawText,rawText);assert.deepEqual(entryResult.writing!.candidate,value);assert.ok(entryResult.writing!.citationLocations!.some(c=>c.originalQuote==='经逐人核对'&&c.status==='located'));assert.equal(entryResult.artifactId,null);assert.equal(periods.requirePeriod(period.id).status,'open');assert.equal(db.all('SELECT * FROM agent_action').length,0);});
 }finally{await app.close();}
 test('截获实际网关请求，无最低长度旧口径，复核仅收到同段绑定事实',()=>{
 for(const req of captures){const system=req.messages[0].content,payload=JSON.parse(req.messages[1].content);if(!system.includes('逐段审查')){assert.ok(system.includes(WRITING_SYSTEM));assert.ok(!system.includes('至少6字'));}else for(const p of payload.paragraphs)assert.ok(p.citedEvidence.every((f:any)=>p.citations.some((c:any)=>c.factId===f.id)));}
 });
 if(process.env.CITATION_EVIDENCE_DIR){mkdirSync(process.env.CITATION_EVIDENCE_DIR,{recursive:true});for(const [name,data] of Object.entries({tests:results,replay:{originalSha256:frozen.rawSha256,originalContract:'旧轮未通过，保持不变',inspection:replay,audit:replayAudit},'normal-entry':entryResult,'final-requests.mock':captures,'semantic-rejected':pending,'hard-rejected':blocked,'grouped-rejected':grouped}))writeFileSync(join(process.env.CITATION_EVIDENCE_DIR,name+'.json'),JSON.stringify(data,null,2));}
}finally{globalThis.fetch=original;db.closeDatabase();}
console.log(`PASS ${results.length} 引用契约/原稿回放/分层/正常入口检查；仅离线模拟，真实外发0次`);
