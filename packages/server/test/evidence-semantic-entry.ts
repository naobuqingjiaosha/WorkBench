import assert from 'node:assert/strict';
process.env.WORKBENCH_TEST_MODE='1';
(await import('../src/core/bootstrap.ts')).bootstrap();
const db=await import('../src/db/index.ts'),s=await import('../src/domain/service.ts'),p=await import('../src/domain/periods.ts'),store=await import('../src/core/store.ts');
const providers=await import('../src/ai/providers.ts');
const provider=providers.upsertProvider({code:'fake-semantic-entry',name:'离线分流测试',base_url:'http://127.0.0.1:19027/v1',enabled:1});
for(const purpose of ['writing','reasoning'] as const)providers.upsertProfile({purpose,name:'离线',provider_id:provider,model:'fake-semantic-entry',max_tokens:8192});
const w=s.createWorkbench({name:'离线回归培训',workTypeId:s.listWorkTypes().find(t=>t.code==='integrity-study')!.id,templateIds:[]});
p.savePeriodRule(w.id,{frequency:'quarterly',first_period:'2026-Q1',requirements:[]});p.syncPeriods(w.id,'2026-04-01');
const period=p.listPeriods(w.id).find(x=>x.report_period==='2026-Q1')!;
const a=(await store.saveArtifact({data:'专题培训于2026年2月6日举行，参加人数27人。',dirAbs:s.workbenchOutputDirAbs(w,'source'),fileName:'离线培训记录.txt',title:'离线培训记录',kind:'source',workbenchId:w.id})).artifact;
db.run('UPDATE artifact SET work_period_id=?,doc_date=? WHERE id=?',[period.id,'2026-02-06',a.id]);
const app=(await import('fastify')).default();(await import('../src/api/routes-agent.ts')).registerAgentRoutes(app);
let mode='supported',calls:string[]=[];const original=globalThis.fetch;
globalThis.fetch=async(_url,init)=>{
 const request=JSON.parse(String(init?.body)),review=request.messages[0].content.includes('逐段审查'),payload=JSON.parse(request.messages[1].content);calls.push(review?'review':'writing');
 let content;
 if(review)content={reviews:payload.paragraphs.map((x:any)=>({id:x.id,supported:mode!=='unsupported',reason:'离线测试结论'}))};
 else{
  const f=payload.untrustedEvidence.find((x:any)=>x.text.includes('参加人数27人'));
  content={paragraphs:[{id:'training',field:'正文',kind:'fact',text:mode==='number'?'专题培训于2026年2月6日举行，参加人数28人。':'专题培训于2026年2月6日举行，参加人数27人。',citations:[{factId:f.id,quote:'专题培训于2026年2月6日举行，参加人数27人。'}]}]};
  if(mode==='stale')db.run('UPDATE work_period SET content=? WHERE id=?',['处理过程中来源变动',period.id]);
 }
 return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)},finish_reason:'stop'}]}));
};
try{
 for(mode of ['supported','unsupported','number','stale']){
  calls=[];const res=await app.inject({method:'POST',url:'/api/agent/chat',payload:{message:'专题培训哪天举行，多少人参加？',workbenchId:w.id,periodId:period.id}});
  if(mode==='stale'){assert.equal(res.statusCode,409,res.body);assert.deepEqual(calls,['writing']);continue;}
  assert.equal(res.statusCode,201,res.body);const result=res.json().data.business;
  assert.ok(result.writing.candidate);assert.equal(result.writing.output!==null,mode==='supported');
  assert.deepEqual(calls,mode==='number'?['writing']:['writing','review']);
  if(mode==='supported')assert.ok(result.writing.findings.some((f:any)=>f.code==='semantic_pending'));
  assert.equal(result.artifactId,null);assert.equal(db.all('SELECT * FROM agent_action').length,0);
  assert.equal(p.requirePeriod(period.id).status,'open');
 }
 console.log('PASS 正常聊天入口 semantic_pending 正反例、硬错误不复核、来源处理中变化不复核；未定稿、未办结、无业务动作');
}finally{globalThis.fetch=original;await app.close();db.closeDatabase();}
