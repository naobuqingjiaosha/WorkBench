import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/directed-offline-2026-10-17');
Object.assign(process.env,isolationEnv(join(root,'.tmp/directed-offline-2026-10-17/replay')));
const {validateWriting}=await import('../packages/server/src/domain/evidence-writing.ts');
const src=join(root,'.tmp/directed-offline-2026-10-17/input/real-results');
const results=[];
for(const [name,prefix] of [['complete','01-complete'],['conflict','02-conflict'],['quarter-v1','03-quarter-v1']]){
 const result=JSON.parse(readFileSync(join(src,`${name}.result.json`)));
 const request=JSON.parse(readFileSync(join(src,`${prefix}-writing.request.json`)));
 const payload=JSON.parse(request.messages[1].content);
 const value=JSON.parse(readFileSync(join(src,`${prefix}-writing.model-original.txt`),'utf8'));
 try{const output=validateWriting(value,result.evidence,payload.templateFields);results.push({name,accepted:true,output});}
 catch(e){results.push({name,accepted:false,issues:e.issues??[{message:e.message}]});}
}
mkdirSync(out,{recursive:true});writeFileSync(join(out,`replay-${process.argv[2]??'after'}.json`),JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(({output,...rest})=>rest),null,2));
