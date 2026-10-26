// Normal-entry preview only. No network, no synthetic model answer, separate disposable database.
import {readFileSync,writeFileSync,cpSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/controlled-real-2026-10-18'),stage=join(root,'.tmp/controlled-real-2026-10-18'),preview=join(root,'.tmp/controlled-real-preflight-2026-10-18');
if(existsSync(preview))throw Error('Preflight already exists; do not silently recreate it');
mkdirSync(join(preview,'runtime'),{recursive:true});cpSync(join(stage,'runtime/workbench.db'),join(preview,'runtime/workbench.db'));cpSync(join(stage,'files'),join(preview,'files'),{recursive:true});
Object.assign(process.env,isolationEnv(preview));globalThis.fetch=async()=>{throw Error('Preparation forbids network');};
(await import('../packages/server/src/core/bootstrap.ts')).bootstrap();
const db=await import('../packages/server/src/db/index.ts');
// No key is copied; target resolution still selects the existing configuration.
process.env.CONTROLLED_EXISTING_KEY='offline-preflight-placeholder';
const app=(await import('fastify')).default();(await import('../packages/server/src/api/routes-agent.ts')).registerAgentRoutes(app);
const fixture=JSON.parse(readFileSync(join(out,'fixture.json'))),records=[];
try{for(const c of fixture.cases.slice(0,3)){
 const input={message:c.question,workbenchId:c.workbenchId,periodId:c.periodId};
 const response=await app.inject({method:'POST',url:'/api/agent/chat',payload:input});if(response.statusCode!==201)throw Error(response.body);
 const result=response.json().data.business;if(!result)throw Error('Normal entry did not select business evidence');
 if(result.changes.length||result.evidence.coverage.omittedFacts)throw Error('Preflight source mismatch/omission');
 if(!result.writing.calls.every(c=>!c.ok))throw Error('Preflight must not obtain a model answer');
 writeFileSync(join(out,c.id+'.preflight-sources.json'),JSON.stringify(result.evidence,null,2));
 records.push({id:c.id,input,scope:result.evidence.scope,mode:result.evidence.task.mode,requiredFactIds:result.evidence.task.requiredFactIds,templateFields:result.draft?Object.keys(result.draft.values):['正文'],preflightOnly:true,externalCalls:0});
 }
 if(db.all('SELECT * FROM ai_request').length)throw Error('Unexpected consent or request in preflight');
 writeFileSync(join(out,'entry-preflight.json'),JSON.stringify(records,null,2));
 console.log(JSON.stringify(records));
}finally{await app.close();db.closeDatabase();}
