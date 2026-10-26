import {readFileSync,writeFileSync,mkdirSync,cpSync,mkdtempSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/directed-offline-2026-10-17/request-comparison'),src=join(root,'.tmp/directed-offline-2026-10-17/input/real-results');
const runtime=mkdtempSync(join(root,'.tmp/directed-request-'));
Object.assign(process.env,isolationEnv(runtime));mkdirSync(out,{recursive:true});
(await import('../packages/server/src/core/bootstrap.ts')).bootstrap();
const {configureMock}=await import('./directed-mock.mjs');await configureMock();
const {writeEvidence}=await import('../packages/server/src/domain/evidence-writing.ts');
const original=globalThis.fetch;const records=[];
try{for(const [name,prefix] of [['complete','01-complete'],['conflict','02-conflict'],['quarter-v1','03-quarter-v1']]){
 const oldPath=join(src,`${prefix}-writing.request.json`),before=JSON.parse(readFileSync(oldPath));const payload=JSON.parse(before.messages[1].content);
 const raw=readFileSync(join(src,`${prefix}-writing.model-original.txt`),'utf8'),run=JSON.parse(readFileSync(join(src,`${name}.result.json`)));
 let count=0;
 globalThis.fetch=async(url,init)=>{if(!String(url).startsWith('http://127.0.0.1:19027/'))throw Error('Unexpected offline URL');const request=JSON.parse(String(init?.body));const review=count++>0;
  writeFileSync(join(out,`${name}.${review?'review':'after'}.request.json`),JSON.stringify(request,null,2));
  const content=review?JSON.stringify({reviews:JSON.parse(raw).paragraphs.map(p=>({id:p.id,supported:true,reason:'离线模拟复核，不是新的真实模型判断'}))}):raw;
  return new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}));};
 const result=await writeEvidence(payload.question,run.evidence,payload.templateFields,8192,24000);
 if(result.calls[0]?.rawText!==raw)throw Error('Original text changed');
 cpSync(oldPath,join(out,`${name}.before.request.json`));
 writeFileSync(join(out,`${name}.replayed-audit.json`),JSON.stringify(result,null,2));
 records.push({name,identity:'saved original bytes replayed through mock transport',mockCalls:count,realCalls:0,mode:result.mode,issues:result.findings??[],originalBytesPreserved:true});
 }
}finally{globalThis.fetch=original;(await import('../packages/server/src/db/index.ts')).closeDatabase();}
writeFileSync(join(out,'index.json'),JSON.stringify(records,null,2));console.log(JSON.stringify(records));
