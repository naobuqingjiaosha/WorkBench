// Acceptance transport guard and evidence recorder. All business work enters /api/agent/chat.
// No consent approvals, model answers, business scope or draft flags are supplied here.
import {existsSync,readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/controlled-real-2026-10-17'),stage=join(root,'.tmp/controlled-real-2026-10-17'),results=join(out,'results');mkdirSync(results,{recursive:true});
const hash=x=>createHash('sha256').update(x).digest('hex'),save=(name,data)=>writeFileSync(join(results,name),JSON.stringify(data,null,2));
const manifest=JSON.parse(readFileSync(join(out,'version.frozen.json')));
function assertFrozen(){for(const f of manifest.files)if(hash(readFileSync(join(root,f.path)))!==f.sha256)throw Error('Frozen file changed: '+f.path);}
assertFrozen();
if(existsSync(join(results,'closed.json')))throw Error('This acceptance is closed');
const spec=JSON.parse(readFileSync(join(out,'inputs.frozen.json'))),fixture=JSON.parse(readFileSync(join(out,'fixture.json')));
Object.assign(process.env,isolationEnv(stage,{WORKBENCH_TEST_MODE:'0',HOST:'127.0.0.1',PORT:'8931',WORKBENCH_SESSION_TOKEN:randomBytes(32).toString('hex')}));
const daily=new DatabaseSync(join(root,'data/runtime/workbench.db'),{readOnly:true});
const publicConfig=JSON.parse(readFileSync(join(out,'model-config.frozen.json')));
for(const config of publicConfig){const profile=daily.prepare('SELECT * FROM ai_profile WHERE purpose=?').get(config.purpose),provider=daily.prepare('SELECT * FROM ai_provider WHERE id=?').get(profile.provider_id);
 const current={purpose:profile.purpose,provider:provider.code,base:provider.base_url,model:profile.model,maxTokens:profile.max_tokens,temperature:profile.temperature,timeoutMs:profile.timeout_ms,extraBody:profile.extra_body};
 if(JSON.stringify(current)!==JSON.stringify(config))throw Error('Existing daily model config changed');
 const key=provider.api_key_env&&process.env[provider.api_key_env]||provider.api_key;if(!key)throw Error('Existing key unavailable');process.env.CONTROLLED_EXISTING_KEY=key;
}daily.close();
const db=await import('../packages/server/src/db/index.ts');db.openDatabase(process.env.WORKBENCH_DB);
const evidence=await import('../packages/server/src/domain/business-evidence.ts'),tasks=await import('../packages/server/src/domain/evidence-task.ts');
const ledgerPath=join(out,'actual-request-ledger.jsonl'),events=()=>readFileSync(ledgerPath,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const log=x=>appendFileSync(ledgerPath,JSON.stringify({...x,at:new Date().toISOString()})+'\n');
function stop(reason){if(!existsSync(join(results,'closed.json')))save('closed.json',{reason,at:new Date().toISOString(),remainingNotTransferable:true});}
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 if(existsSync(join(results,'closed.json')))throw Error('Acceptance stopped');
 assertFrozen();
 if(String(url)!=='https://api.deepseek.com/v1/chat/completions'||init?.method!=='POST')throw Error('Unapproved outbound target');
 const rawBody=String(init.body),body=JSON.parse(rawBody),payload=JSON.parse(body.messages?.[1]?.content??'{}');
 const c=fixture.cases.find(c=>c.question===payload.question);if(!c)throw Error('Not a frozen sample');
 const n=fixture.cases.indexOf(c);
 for(let i=0;i<n;i++){const path=join(results,fixture.cases[i].id+'.agent-check.json');if(!existsSync(path)||JSON.parse(readFileSync(path)).pass!==true)throw Error('Previous sample has not passed');}
 if(n===3&&!existsSync(join(results,'source-update.json')))throw Error('Source update not verified');
 const prompt=body.messages[0].content,purpose=prompt.startsWith('你负责逐段审查来源支持关系')?'reasoning':prompt.startsWith('你是业务证据写作助手')?'writing':null;
 if(!purpose||body.model!=='deepseek-flash'||body.tools||body.max_tokens!==(purpose==='writing'?8192:4096)||body.temperature!==0||body.stream!==false||body.thinking?.type!=='disabled'||body.response_format?.type!=='json_object')throw Error('Unexpected final model parameters');
 const dispatched=events().filter(e=>e.event==='dispatch');
 if(dispatched.length>=8||dispatched.filter(e=>e.purpose===purpose).length>=4||dispatched.some(e=>e.step===c.id&&e.purpose===purpose))throw Error('No retries or transferred budget allowed');
 if(purpose==='reasoning'&&!dispatched.some(e=>e.step===c.id&&e.purpose==='writing'))throw Error('Review without writing');
 // Check current data again after the user's potentially long consent wait.
 const scope=payload.scope??payload.task?.scope;
 const sourceFile=join(results,c.id+'.sources-at-consent.json');
 if(!existsSync(sourceFile))throw Error('Request was not frozen at consent');
 const pack=JSON.parse(readFileSync(sourceFile));if(evidence.evidenceChanges(pack).length){stop('来源在外发确认期间变化');throw Error('Sources changed during consent');}
 const id=dispatched.length+1,stem=String(id).padStart(2,'0')+'-'+c.id+'-'+purpose;
 writeFileSync(join(results,stem+'.request.json'),rawBody,{flag:'wx'});
 log({event:'dispatch',id,step:c.id,purpose,url:String(url),requestSha256:hash(rawBody),model:body.model,maxTokens:body.max_tokens});
 const started=Date.now();
 try{
  const response=await nativeFetch(url,init),raw=Buffer.from(await response.arrayBuffer());writeFileSync(join(results,stem+'.response.raw.json'),raw,{flag:'wx'});
  let parsed;try{parsed=JSON.parse(raw);}catch{}
  const content=parsed?.choices?.[0]?.message?.content;if(typeof content==='string')writeFileSync(join(results,stem+'.model-original.txt'),content,{flag:'wx'});
  log({event:'response',id,step:c.id,purpose,status:response.status,latencyMs:Date.now()-started,responseSha256:hash(raw),finishReason:parsed?.choices?.[0]?.finish_reason,usage:parsed?.usage});
  if(!response.ok||parsed?.choices?.[0]?.finish_reason!=='stop')stop('请求失败或截断：'+stem);
  return new Response(raw,{status:response.status,statusText:response.statusText,headers:response.headers});
 }catch(e){log({event:'network-error',id,step:c.id,purpose,message:e.message});stop('请求失败：'+e.message);throw e;}
};
const consent=await import('../packages/server/src/ai/consent.ts');
const seen=new Set(),exported=new Set();let recording=false;
setInterval(async()=>{
 if(recording)return;recording=true;
 try{
  for(const r of consent.pendingRequests())if(!seen.has(r.id)){
   const body=JSON.parse(r.payload),payload=JSON.parse(body.messages[1].content),c=fixture.cases.find(c=>c.question===payload.question);if(!c)continue;
   let pack;
   if(payload.scope)pack=tasks.prepareEvidenceTask(await evidence.collectBusinessEvidence(payload.scope,24000),c.question,c.id.startsWith('quarter')?'report':'answer');
   else pack=JSON.parse(readFileSync(join(results,c.id+'.sources-at-consent.json')));
   if(evidence.evidenceChanges(pack).length)throw Error('Stale consent snapshot');
   save(c.id+'.sources-at-consent.json',pack);save('consent-'+r.id+'.json',{...r,step:c.id,finalRequestSha256:hash(r.payload),parametersFrozenBeforeSend:true});seen.add(r.id);
   console.log(JSON.stringify({event:'awaiting-user-confirmation',step:c.id,requestId:r.id,expires:r.expires_at}));
  }
  const business=await import('../packages/server/src/domain/business-assistant.ts'),store=await import('../packages/server/src/core/store.ts');
  for(const row of db.all('SELECT id,question FROM business_ai_run ORDER BY id'))if(!exported.has(row.id)){
   const c=fixture.cases.find(c=>c.question===row.question);if(!c)continue;
   const result=business.getBusinessRun(row.id);save(c.id+'.result.json',result);save(c.id+'.sources.json',result.evidence);writeFileSync(join(results,c.id+'.program-display.txt'),result.answer);
   if(result.artifactId){const a=store.getArtifact(result.artifactId),bytes=readFileSync(store.artifactAbsPath(a));writeFileSync(join(results,c.id+(result.writing?.output?'.model.docx':'.fallback.docx')),bytes);save(c.id+'.document.json',{artifactId:a.id,sha256:hash(bytes),revision:a.revision,isFinal:a.is_final});}
   exported.add(row.id);if(!result.writing?.output||result.changes.length)stop('阻断诊断：'+c.id+' '+result.writing?.issues.join('；'));
   console.log(JSON.stringify({event:'sample-finished',step:c.id,runId:row.id,mode:result.writing?.mode,issues:result.writing?.issues}));
  }
  save('application-call-log.json',db.all('SELECT * FROM ai_call_log'));save('consent-history.json',db.all('SELECT id,target,purpose,model,digest,state,created_at,decided_at,expires_at FROM ai_request'));
 }catch(e){console.error('Recorder: '+e.message);stop('验收记录失败：'+e.message);}finally{recording=false;}
},400).unref();
await import('../packages/server/src/index.ts');
save('runtime.json',{pid:process.pid,url:fixture.url,root:stage,frozen:true,requestCaps:{writing:4,reasoning:4,total:8,retry:0,extraRoutes:0}});
console.log('Controlled acceptance ready. Use normal chat. Every external request waits for user confirmation.');
