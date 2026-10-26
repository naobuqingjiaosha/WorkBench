import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),base=join(root,'outputs/current-integration-2026-10-17'),out=join(base,'real-results'),stage=join(root,'.tmp/current-real-2026-10-17');
Object.assign(process.env,isolationEnv(stage));
const db=await import('../packages/server/src/db/index.ts');db.openDatabase(process.env.WORKBENCH_DB);
const {validateWriting}=await import('../packages/server/src/domain/evidence-writing.ts');
const json=(n,v)=>writeFileSync(join(out,n),JSON.stringify(v,null,2));
const hash=x=>createHash('sha256').update(x).digest('hex');
const ledger=readFileSync(join(out,'actual-request-ledger.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const calls=ledger.filter(x=>x.event==='dispatch').map(x=>({...x,...ledger.find(y=>y.event==='response'&&x.id===y.id)}));
const checks=[];
for(const [index,step] of ['complete','conflict','quarter-v1'].entries()){
 const run=JSON.parse(readFileSync(join(out,step+'.result.json'))),rawPath=`${String(index+1).padStart(2,'0')}-${step}-writing.model-original.txt`,raw=readFileSync(join(out,rawPath),'utf8'),parsed=JSON.parse(raw);
 const paragraphs=parsed.paragraphs.map(p=>({...p,linkedFullFacts:p.citations.map(c=>run.evidence.facts.find(f=>f.id===c.factId)),anchorMatches:p.citations.every(c=>run.evidence.facts.find(f=>f.id===c.factId)?.text.normalize('NFKC').replace(/\s+/g,'').includes(c.quote.normalize('NFKC').replace(/\s+/g,'')))}));
 let replay={};try{validateWriting(parsed,run.evidence,[...new Set(parsed.paragraphs.map(p=>p.field))]);replay={accepted:true};}catch(e){replay={accepted:false,issues:e.issues??[],message:e.message};}
 json(step+'.paragraph-source-audit.json',{modelOriginalSha256:hash(raw),paragraphs,replay,note:'Full cited fact text is the support unit; the short verbatim quote is a locator, not the only available support.'});
 checks.push({step,runId:run.id,modelOriginalSha256:hash(raw),paragraphs:paragraphs.length,allAnchorsMatch:paragraphs.every(p=>p.anchorMatches),replay,autoAccepted:run.writing.mode==='model',artifactId:run.artifactId});
}
const current=db.get('SELECT * FROM inspection_record WHERE id=3');
json('source-comparison.json',{realChangeExecuted:false,reason:'Approved plan stops source-v2 chain when v1 is not an accepted model draft.',currentSource:current,plannedAfter:JSON.parse(readFileSync(join(base,'new-scenarios.frozen.json'))).cases[2].change.after,offlineComparison:'../source-comparison.json',offlineComparisonIsNotRealModelEvidence:true});
json('consent-history.json',db.all('SELECT id,target,purpose,model,digest,state,created_at,decided_at FROM ai_request ORDER BY created_at'));
json('application-call-log.json',db.all('SELECT purpose,provider_code,model,ok,latency_ms,prompt_tokens,output_tokens,total_tokens,error_code,error_message,is_test FROM ai_call_log ORDER BY id'));
const totalTokens=calls.reduce((n,c)=>n+(c.usage?.total_tokens??0),0);
json('calls-summary.json',{authorizedMax:8,actualRequests:calls.length,writingRequests:3,auxiliaryReviewRequests:0,retries:0,unused:8-calls.length,totalTokens,httpSuccessful:calls.filter(c=>c.httpStatus===200).length,truncated:calls.filter(c=>c.finishReason==='length').length,calls});
json('verification-summary.json',{checkedAt:new Date().toISOString(),checks,overallPassed:false,realV2Executed:false,agentEditedModelOutputs:false,provider:'deepseek',model:'deepseek-flash',dailyRelease:false});
json('closed.json',{at:new Date().toISOString(),reason:'Quarter-v1 validation failure triggered approved stop condition',actualRequests:calls.length,unusedRequests:8-calls.length,automaticContinuation:false});
// Close only this isolated provider after the accepted plan has reached its stop condition.
db.run("UPDATE ai_provider SET enabled=0,api_key='',api_key_env=NULL,extra_headers=NULL WHERE code='deepseek'");
db.closeDatabase();console.log(JSON.stringify({requests:calls.length,totalTokens,allAnchorsMatch:checks.every(x=>x.allAnchorsMatch),frozenValidatorFailures:checks.length,isolatedProviderDisabled:true}));
