// Transport guard/recorder only. No model answers, scope overrides or consent approvals.
import {existsSync,readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/controlled-real-2026-10-18'),stage=join(root,'.tmp/controlled-real-2026-10-18'),results=join(out,'results');mkdirSync(results,{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex'),read=name=>JSON.parse(readFileSync(join(results,name))),save=(name,data)=>writeFileSync(join(results,name),JSON.stringify(data,null,2));
const manifest=JSON.parse(readFileSync(join(out,'version.frozen.json'))),prompts=JSON.parse(readFileSync(join(out,'prompts.frozen.json'))),fixture=JSON.parse(readFileSync(join(out,'fixture.json'))),spec=JSON.parse(readFileSync(join(out,'inputs.frozen.json')));
function assertFrozen(){for(const f of manifest.files)if(hash(readFileSync(join(root,f.path)))!==f.sha256)throw Error('Frozen file changed: '+f.path);}
assertFrozen();if(existsSync(join(results,'closed.json')))throw Error('Acceptance already closed');
Object.assign(process.env,isolationEnv(stage,{WORKBENCH_TEST_MODE:'0',HOST:'127.0.0.1',PORT:'8932',WORKBENCH_SESSION_TOKEN:randomBytes(32).toString('hex')}));
const daily=new DatabaseSync(join(root,'data/runtime/workbench.db'),{readOnly:true});
const configs=JSON.parse(readFileSync(join(out,'model-config.frozen.json')));
for(const c of configs){const p=daily.prepare('SELECT * FROM ai_profile WHERE purpose=?').get(c.purpose),v=daily.prepare('SELECT * FROM ai_provider WHERE id=?').get(p.provider_id);
 const current={purpose:p.purpose,provider:v.code,base:v.base_url,model:p.model,maxTokens:p.max_tokens,temperature:p.temperature,timeoutMs:p.timeout_ms,extraBody:p.extra_body};
 if(JSON.stringify(current)!==JSON.stringify(c))throw Error('Daily model configuration changed');
 const key=v.api_key_env&&process.env[v.api_key_env]||v.api_key;if(!key)throw Error('Existing credential unavailable');process.env.CONTROLLED_EXISTING_KEY=key;
}daily.close();
const db=await import('../packages/server/src/db/index.ts');db.openDatabase(process.env.WORKBENCH_DB);
const evidence=await import('../packages/server/src/domain/business-evidence.ts'),tasks=await import('../packages/server/src/domain/evidence-task.ts');
const ledger=join(out,'actual-request-ledger.jsonl'),events=()=>readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),log=e=>appendFileSync(ledger,JSON.stringify({...e,at:new Date().toISOString()})+'\n');
function stop(reason){if(!existsSync(join(results,'closed.json'))){save('closed.json',{reason,at:new Date().toISOString(),commonStop:true});log({event:'common-stop',reason});}}
function failStep(step,reason){if(!existsSync(join(results,step+'.transport-failure.json')))save(step+'.transport-failure.json',{step,reason,at:new Date().toISOString(),independentOthersMayContinue:true});}
const writingPrompt=prompts.writing+'\n\n【写作规范】'+prompts.style;
function identify(body){const payload=JSON.parse(body.messages?.[1]?.content??'{}'),c=fixture.cases.find(c=>c.question===payload.question),prompt=body.messages?.[0]?.content;
 const purpose=prompt===writingPrompt?'writing':prompt===prompts.review?'reasoning':null;
 if(!c||!purpose||body.messages.length!==2||body.messages[0].role!=='system'||body.messages[1].role!=='user')throw Error('Non-frozen scenario or gateway prompt');
 const keys=['model','messages','temperature','max_tokens','stream','response_format','thinking'].sort();
 if(JSON.stringify(Object.keys(body).sort())!==JSON.stringify(keys)||body.model!==configs.find(x=>x.purpose===purpose).model||body.max_tokens!==(purpose==='writing'?8192:4096)||body.temperature!==0||body.stream!==false||body.thinking?.type!=='disabled'||body.response_format?.type!=='json_object')throw Error('Final request parameters mismatch');
 return {c,purpose,payload};
}
function assertSequence(c,purpose){
 const n=fixture.cases.indexOf(c);
 for(let i=0;i<n;i++)if(!existsSync(join(results,fixture.cases[i].id+'.agent-check.json')))throw Error('Previous scenario has no terminal assessment');
 if(c.id==='quarter-v2'&&(!read('quarter-v1.agent-check.json').pass||!existsSync(join(results,'source-update.json'))))throw Error('v2 requires valid real v1 and planned source update');
 const sent=events().filter(x=>x.event==='dispatch');
 if(sent.length>=8||sent.filter(x=>x.purpose===purpose).length>=4||sent.some(x=>x.step===c.id&&x.purpose===purpose))throw Error('No retries, extras or transferred budget');
 if(purpose==='reasoning'&&!sent.some(x=>x.step===c.id&&x.purpose==='writing'))throw Error('Review without writing');
 if(existsSync(join(results,c.id+'.transport-failure.json')))throw Error('Scenario already failed');
}
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 let identified;
 try{
  if(existsSync(join(results,'closed.json')))throw Error('Acceptance closed');assertFrozen();
  if(String(url)!=='https://api.deepseek.com/v1/chat/completions'||init?.method!=='POST')throw Error('Unapproved destination');
  const rawBody=String(init.body),body=JSON.parse(rawBody);identified=identify(body);const {c,purpose,payload}=identified;assertSequence(c,purpose);
  const records=[...seen.values()].filter(x=>x.step===c.id&&x.purpose===purpose&&x.payload===rawBody);if(records.length!==1)throw Error('Exact consent payload not recorded');
  const approved=db.get('SELECT * FROM ai_request WHERE id=?',[records[0].id]);if(approved?.state!=='sending'||approved.digest!==records[0].digest)throw Error('Human consent missing or mismatched');
  // The user may approve quickly. A negative writing audit still prevents the review dispatch.
  if(purpose==='reasoning'){
   while(!existsSync(join(results,c.id+'.writing-gate.json'))){if(init.signal?.aborted)throw Error('Writing assessment wait expired');await new Promise(r=>setTimeout(r,250));}
   if(read(c.id+'.writing-gate.json').pass!==true){failStep(c.id,'原始写作核对未通过，辅助调用未发送');throw Object.assign(Error('Sample writing failed; review not sent'),{sampleOnly:true});}
  }
  const pack=read(c.id+'.sources-at-consent.json');if(evidence.evidenceChanges(pack).length)throw Error('Sources changed during consent');
  assertFrozen();assertSequence(c,purpose);
  const id=events().filter(x=>x.event==='dispatch').length+1,stem=String(id).padStart(2,'0')+'-'+c.id+'-'+purpose;
  writeFileSync(join(results,stem+'.request.json'),rawBody,{flag:'wx'});log({event:'dispatch',id,step:c.id,purpose,url:String(url),requestSha256:hash(rawBody),consentId:approved.id,model:body.model,maxTokens:body.max_tokens});
  const started=Date.now();
  try{
   const response=await nativeFetch(url,init),raw=Buffer.from(await response.arrayBuffer());writeFileSync(join(results,stem+'.response.raw.json'),raw,{flag:'wx'});
   let parsed;try{parsed=JSON.parse(raw);}catch{}
   const content=parsed?.choices?.[0]?.message?.content;if(typeof content==='string')writeFileSync(join(results,stem+'.model-original.txt'),content,{flag:'wx'});
   log({event:'response',id,step:c.id,purpose,status:response.status,latencyMs:Date.now()-started,responseSha256:hash(raw),returnedModel:parsed?.model,finishReason:parsed?.choices?.[0]?.finish_reason,usage:parsed?.usage});
   if([401,403].includes(response.status))stop('网关权限异常');
   else if(!response.ok||parsed?.choices?.[0]?.finish_reason!=='stop')failStep(c.id,'模型请求失败或截断：'+stem);
   return new Response(raw,{status:response.status,statusText:response.statusText,headers:response.headers});
  }catch(e){log({event:'network-error',id,step:c.id,purpose,message:e.message});failStep(c.id,'已计入请求额度，网络失败：'+e.message);throw Object.assign(e,{sampleOnly:true});}
 }catch(e){if(!e.sampleOnly)stop(e.message);throw e;}
};
const consent=await import('../packages/server/src/ai/consent.ts'),seen=new Map(),exported=new Set();let recording=false;
setInterval(async()=>{
 if(recording)return;recording=true;
 try{
  for(const r of consent.pendingRequests())if(!seen.has(r.id)){
   assertFrozen();const body=JSON.parse(r.payload),{c,purpose,payload}=identify(body);assertSequence(c,purpose);
   let pack;
   if(purpose==='writing'){
    pack=tasks.prepareEvidenceTask(await evidence.collectBusinessEvidence(payload.scope,24000),c.question,c.id.startsWith('quarter')?'report':'answer');
    const preview=JSON.parse(readFileSync(join(out,(c.id==='quarter-v2'?'quarter-v1':c.id)+'.preflight-sources.json')));
    for(const key of ['workbenchId','start','end','periodIds','category','domain'])if(JSON.stringify(pack.scope[key])!==JSON.stringify(preview.scope[key]))throw Error('Normal entry scope differs from frozen preview: '+key);
    if(JSON.stringify(payload.untrustedEvidence)!==JSON.stringify(tasks.writingFacts(pack)))throw Error('Final evidence differs from source snapshot');
    if(JSON.stringify(payload.sourceManifest)!==JSON.stringify(pack.sources.map(s=>({id:s.id,status:s.status}))))throw Error('Source manifest mismatch');
   }else{
    pack=read(c.id+'.sources-at-consent.json');
    for(const p of payload.paragraphs)if(JSON.stringify(p.citedEvidence)!==JSON.stringify(pack.facts.filter(f=>p.citations.some(c=>c.factId===f.id))))throw Error('Review source binding mismatch');
   }
   if(evidence.evidenceChanges(pack).length)throw Error('Source freshness/permission anomaly');
   save(c.id+'.sources-at-consent.json',pack);const record={...r,step:c.id,purpose,finalRequestSha256:hash(r.payload),parametersFrozenBeforeSend:true};save('consent-'+r.id+'.json',record);seen.set(r.id,record);
   log({event:'awaiting-human-consent',step:c.id,purpose,requestId:r.id,digest:r.digest,expires:r.expires_at});console.log(JSON.stringify({event:'awaiting-human-consent',step:c.id,purpose,requestId:r.id,expires:r.expires_at}));
  }
  const business=await import('../packages/server/src/domain/business-assistant.ts'),store=await import('../packages/server/src/core/store.ts');
  for(const row of db.all('SELECT id,question FROM business_ai_run ORDER BY id'))if(!exported.has(row.id)){
   const c=fixture.cases.find(c=>c.question===row.question);if(!c)continue;const result=business.getBusinessRun(row.id);
   save(c.id+'.result.json',result);save(c.id+'.sources.json',result.evidence);writeFileSync(join(results,c.id+'.program-display.txt'),result.answer);
   if(result.artifactId){const a=store.getArtifact(result.artifactId),bytes=readFileSync(store.artifactAbsPath(a));writeFileSync(join(results,c.id+(result.writing?.output?'.model.docx':'.fallback.docx')),bytes);save(c.id+'.document.json',{artifactId:a.id,sha256:hash(bytes),revision:a.revision,isFinal:a.is_final,fileName:a.file_name});}
   exported.add(row.id);if(result.changes.length)stop('非计划性来源变化：'+c.id);
   console.log(JSON.stringify({event:'sample-finished',step:c.id,runId:row.id,mode:result.writing?.mode,issues:result.writing?.issues}));
  }
  save('application-call-log.json',db.all('SELECT * FROM ai_call_log'));save('consent-history.json',db.all('SELECT id,target,purpose,model,digest,state,created_at,decided_at,expires_at FROM ai_request'));
 }catch(e){stop('Recorder/guard: '+e.message);console.error(e.message);}finally{recording=false;}
},300).unref();
await import('../packages/server/src/index.ts');
save('runtime.json',{pid:process.pid,url:fixture.url,root:stage,frozen:true,requestCaps:{writing:4,reasoning:4,total:8,retry:0,extraRoutes:0},perSample:{writing:1,reasoning:1},humanConsentOnly:true});
console.log('Controlled real acceptance ready. Human confirmation is required for every outbound request.');
