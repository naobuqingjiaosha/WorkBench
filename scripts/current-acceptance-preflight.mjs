import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/current-integration-2026-10-17'),prepared=join(out,'real-prepared'),stage=join(root,'.tmp/current-real-2026-10-17');
Object.assign(process.env,isolationEnv(stage));
const db=await import('../packages/server/src/db/index.ts');db.openDatabase(process.env.WORKBENCH_DB);
const evidence=await import('../packages/server/src/domain/business-evidence.ts'),tasks=await import('../packages/server/src/domain/evidence-task.ts'),writing=await import('../packages/server/src/domain/evidence-writing.ts');
const spec=JSON.parse(readFileSync(join(out,'new-scenarios.frozen.json'))),fixture=JSON.parse(readFileSync(join(prepared,'fixture.json'))),offline=JSON.parse(readFileSync(join(out,'offline-quarter.json')));
const native=new Set(['年份','本季度','下季度','下季度年份','报告期','单位名称','部门名称']);
const results=[];
for(let n=0;n<spec.cases.length;n++){
 const c=spec.cases[n],pack=tasks.prepareEvidenceTask(JSON.parse(readFileSync(join(prepared,`source-pack-${c.id}.json`))),c.question,n===2?'report':'answer');
 const payload={question:c.question,scope:pack.scope,templateFields:n===2?Object.keys(offline.draft.values).filter(k=>!native.has(k)):['正文'],task:{mode:pack.task.mode,requiredFactIds:pack.task.requiredFactIds,metrics:pack.task.metrics},metrics:Object.fromEntries(pack.task.metrics.map(k=>[k,pack.metrics[k]])),gaps:pack.task.businessGaps,conflicts:tasks.writingConflicts(pack),untrustedEvidence:tasks.writingFacts(pack),sourceManifest:pack.sources.map(s=>({id:s.id,status:s.status}))};
 const input={model:'deepseek-flash',messages:[{role:'system',content:writing.WRITING_SYSTEM},{role:'user',content:JSON.stringify(payload)}],max_tokens:8192,temperature:0,response_format:{type:'json_object'},thinking:{type:'disabled'}};
 const json=JSON.stringify(input,null,2);writeFileSync(join(prepared,`planned-writing-${c.id}.json`),json);
 results.push({case:c.id,requestSha256:createHash('sha256').update(json).digest('hex'),chars:JSON.stringify(payload).length+writing.WRITING_SYSTEM.length,fitsExistingBudget:JSON.stringify(payload).length+writing.WRITING_SYSTEM.length<=48000,containsExpectedAnswer:false,routeChecks:[c.question,...c.variants].map(question=>{try{return {question,inferred:evidence.inferBusinessScope(question)};}catch(e){return {question,error:e.message};}})});
}
writeFileSync(join(out,'preflight.json'),JSON.stringify({status:'not sent',results},null,2));
writeFileSync(join(out,'frozen-prompts.json'),JSON.stringify({WRITING_SYSTEM:writing.WRITING_SYSTEM,REVIEW_SYSTEM:writing.REVIEW_SYSTEM},null,2));
db.closeDatabase();console.log(JSON.stringify(results.map(x=>({case:x.case,chars:x.chars,routes:x.routeChecks.map(r=>({question:r.question,routed:!!r.inferred,error:r.error}))})),null,2));
