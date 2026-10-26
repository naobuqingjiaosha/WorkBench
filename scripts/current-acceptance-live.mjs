// Acceptance-only runner: existing application code/prompt/validation remains frozen.
import {existsSync,mkdirSync,readFileSync,writeFileSync,appendFileSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/current-integration-2026-10-17'),live=join(out,'real-results'),stage=join(root,'.tmp/current-real-2026-10-17');
const hash=x=>createHash('sha256').update(x).digest('hex');
const save=(name,value)=>writeFileSync(join(live,name),JSON.stringify(value,null,2));
mkdirSync(live,{recursive:true});
const manifest=JSON.parse(readFileSync(join(out,'frozen-manifest.json')));
if(manifest.files.some(x=>!existsSync(join(root,x.path))||hash(readFileSync(join(root,x.path)))!==x.sha256))throw Error('Frozen code changed');
const authFile=join(live,'authorization.json');
if(!existsSync(authFile))throw Error('No authorization record');
const auth=JSON.parse(readFileSync(authFile));
if(auth.userResponse!=='允许'||auth.totalMax!==8||auth.writingMax!==4||auth.reviewMax!==4||auth.retryMax!==0)throw Error('Authorization mismatch');
Object.assign(process.env,isolationEnv(stage,{WORKBENCH_TEST_MODE:'0',PORT:'8918',HOST:'127.0.0.1',WORKBENCH_SESSION_TOKEN:randomBytes(32).toString('hex')}));
cpSync(join(root,'.tmp/current-integration-2026-10-17/web'),join(stage,'web'),{recursive:true});
const db=await import('../packages/server/src/db/index.ts');db.openDatabase(process.env.WORKBENCH_DB);
const providers=await import('../packages/server/src/ai/providers.ts');
const daily=new DatabaseSync(join(root,'data/runtime/workbench.db'),{readOnly:true});
const configured=daily.prepare("SELECT * FROM ai_profile WHERE purpose IN ('writing','reasoning') ORDER BY purpose").all();
for(const profile of configured){
 const provider=daily.prepare('SELECT * FROM ai_provider WHERE id=?').get(profile.provider_id);
 if(provider.code!=='deepseek'||provider.base_url!=='https://api.deepseek.com/v1'||profile.model!=='deepseek-flash')throw Error('Existing target changed');
 const key=provider.api_key_env&&process.env[provider.api_key_env]||provider.api_key;
 if(!key)throw Error('Existing key is unavailable');
 process.env.ACCEPTANCE_DEEPSEEK_KEY=key;
 const id=providers.upsertProvider({...provider,api_key:'',api_key_env:'ACCEPTANCE_DEEPSEEK_KEY'});
 providers.upsertProfile({...profile,provider_id:id});
}
daily.close();
let activeStep=null,busy=false;
const ledgerPath=join(live,'actual-request-ledger.jsonl');
const ledger=()=>existsSync(ledgerPath)?readFileSync(ledgerPath,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 if(String(url)!=='https://api.deepseek.com/v1/chat/completions')throw Error('Acceptance outbound target not authorized');
 if(!['complete','conflict','quarter-v1','quarter-v2'].includes(activeStep))throw Error('No authorized active sample');
 const body=String(init?.body??''),request=JSON.parse(body),system=request.messages?.[0]?.content??'';
 const purpose=system.startsWith('你负责逐段审查来源支持关系')?'reasoning':system.startsWith('你是业务证据写作助手')?'writing':null;
 if(!purpose||request.model!=='deepseek-flash'||init?.method!=='POST'||request.tools)throw Error('Request is outside approved writing/review scope');
 if(request.max_tokens>(purpose==='writing'?8192:4096))throw Error('Output limit exceeded');
 const previous=ledger().filter(x=>x.event==='dispatch');
 if(previous.length>=8||previous.filter(x=>x.purpose===purpose).length>=4||previous.some(x=>x.step===activeStep&&x.purpose===purpose))throw Error('Request budget exceeded or retry forbidden');
 const id=previous.length+1,stem=`${String(id).padStart(2,'0')}-${activeStep}-${purpose}`,start=Date.now();
 writeFileSync(join(live,stem+'.request.json'),body,{flag:'wx'});
 appendFileSync(ledgerPath,JSON.stringify({event:'dispatch',id,step:activeStep,purpose,target:String(url),model:request.model,maxTokens:request.max_tokens,requestSha256:hash(body),at:new Date().toISOString()})+'\n');
 try{
  const response=await nativeFetch(url,init),raw=Buffer.from(await response.arrayBuffer());
  writeFileSync(join(live,stem+'.response.raw.json'),raw,{flag:'wx'});
  let parsed;try{parsed=JSON.parse(raw.toString());}catch{}
  if(typeof parsed?.choices?.[0]?.message?.content==='string')writeFileSync(join(live,stem+'.model-original.txt'),parsed.choices[0].message.content,{flag:'wx'});
  appendFileSync(ledgerPath,JSON.stringify({event:'response',id,httpStatus:response.status,latencyMs:Date.now()-start,responseSha256:hash(raw),usage:parsed?.usage??null,finishReason:parsed?.choices?.[0]?.finish_reason??null,at:new Date().toISOString()})+'\n');
  return new Response(raw,{status:response.status,statusText:response.statusText,headers:response.headers});
 }catch(error){appendFileSync(ledgerPath,JSON.stringify({event:'network-error',id,name:error.name,message:error.message,latencyMs:Date.now()-start,at:new Date().toISOString()})+'\n');throw error;}
};
await import('../packages/server/src/index.ts');
const business=await import('../packages/server/src/domain/business-assistant.ts'),store=await import('../packages/server/src/core/store.ts'),inspection=await import('../packages/server/src/domain/inspections.ts');
const spec=JSON.parse(readFileSync(join(out,'new-scenarios.frozen.json'))),fixture=JSON.parse(readFileSync(join(out,'real-prepared/fixture.json')));
const pending=await import('../packages/server/src/ai/consent.ts');
const alreadyPending=new Set();
const seenCommands=new Set();
setInterval(async()=>{
 for(const r of pending.pendingRequests())if(!alreadyPending.has(r.id)){
  alreadyPending.add(r.id);save(`consent-${r.id}.json`,{...r,step:activeStep});
  console.log(JSON.stringify({event:'awaiting-user-click',step:activeStep,id:r.id,digest:r.digest,expires:r.expires_at}));
 }
 const commandPath=join(stage,'acceptance-command.json');
 if(busy||!existsSync(commandPath))return;
 const command=JSON.parse(readFileSync(commandPath));if(seenCommands.has(command.id))return;
 seenCommands.add(command.id);busy=true;activeStep=command.step;
 try{
  if(!['complete','conflict','quarter-v1','quarter-v2'].includes(activeStep))throw Error('Unknown step');
  if(existsSync(join(live,`${activeStep}.result.json`))||ledger().some(x=>x.event==='dispatch'&&x.step===activeStep))throw Error('Already attempted; retry prohibited');
  const n=activeStep==='complete'?0:activeStep==='conflict'?1:2;
  if(activeStep==='quarter-v2'){
   const first=JSON.parse(readFileSync(join(live,'quarter-v1.result.json')));
   const agentCheck=JSON.parse(readFileSync(join(live,'quarter-v1.agent-check.json')));
   if(first.writing?.mode!=='model'||!first.artifactId||agentCheck.pass!==true)throw Error('Quarter v1 is not an accepted untouched model draft');
   const before=inspection.requireInspection(fixture.quarter.inspection,fixture.quarter.inspectionPeriod);
   const after=inspection.saveInspection(fixture.quarter.inspectionPeriod,{...before,rectification:spec.cases[2].change.after},before.id);
   save('source-comparison.json',{before,after,oldArtifactId:first.artifactId,oldRunId:first.id,oldDraftChanges:business.getBusinessRun(first.id).changes});
  }
  const result=await business.runBusinessAssistant({question:spec.cases[n].question,scope:fixture.scopes[n],draft:n===2,targetWorkbenchId:n===2?fixture.quarter.workbench:undefined});
  save(`${activeStep}.result.json`,result);
  writeFileSync(join(live,`${activeStep}.program-display.txt`),result.answer);
  save(`${activeStep}.sources.json`,result.evidence);
  if(result.artifactId){const a=store.getArtifact(result.artifactId),bytes=readFileSync(store.artifactAbsPath(a));writeFileSync(join(live,`${activeStep}.${result.writing.mode==='model'?'model':'fallback'}.docx`),bytes);save(`${activeStep}.document.json`,{artifactId:a.id,sha256:hash(bytes),isFinal:a.is_final,revision:a.revision,mode:result.writing.mode});}
  save(`${activeStep}.state.json`,{status:'completed',runId:result.id,artifactId:result.artifactId,mode:result.writing.mode,issues:result.writing.issues,externalRequests:ledger().filter(x=>x.event==='dispatch').length});
  console.log(JSON.stringify({event:'step-completed',step:activeStep,runId:result.id,mode:result.writing.mode,issues:result.writing.issues}));
 }catch(error){save(`${activeStep}.state.json`,{status:'failed',message:error.message});console.log(JSON.stringify({event:'step-failed',step:activeStep,message:error.message}));}
 finally{busy=false;activeStep=null;}
},500).unref();
save('runtime.json',{pid:process.pid,url:'http://127.0.0.1:8918/#/agent',root:stage,authorization:auth,totalMax:8,retryMax:0});
console.log('Acceptance server ready; external requests require the existing per-request user confirmation.');
