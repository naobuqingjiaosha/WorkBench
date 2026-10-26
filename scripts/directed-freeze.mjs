import {readFileSync,writeFileSync,mkdirSync,cpSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),out=join(root,'outputs/directed-offline-2026-10-17'),stage=join(root,'.tmp/directed-offline-2026-10-17');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const tree=p=>!existsSync(p)?[]:readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?tree(join(p,e.name)):[{path:relative(root,join(p,e.name)),sha256:hash(join(p,e.name))}]);
mkdirSync(out,{recursive:true});mkdirSync(stage,{recursive:true});
const daily=()=>({dist:tree(join(root,'packages/web/dist')),files:['workbench.config.json','data/runtime/workbench.db','data/runtime/server.lock'].filter(p=>existsSync(join(root,p))).map(path=>({path,sha256:hash(join(root,path))}))});
if(process.argv[2]==='freeze'){
 if(existsSync(join(out,'baseline.json')))throw Error('Already frozen');
 for(const p of ['packages/server/src','packages/web/src','packages/server/test','scripts'])cpSync(join(root,p),join(stage,'baseline',p),{recursive:true});
 const evidence=join(root,'outputs/current-integration-2026-10-17');
 for(const p of ['真实模型验收报告.txt','真实模型验收证据包_未通过.zip','real-results','preflight.json','selection-checks.json','offline-verification.json','new-scenarios.frozen.json'])cpSync(join(evidence,p),join(stage,'input',p),{recursive:true});
 cpSync('C:/Users/Fangnan/Desktop/AI证据写作链路复核与定向修正指令_2026-10-17.md',join(stage,'input/review.md'));
 writeFileSync(join(out,'baseline.json'),JSON.stringify({head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),status:execFileSync('git',['status','--short'],{encoding:'utf8'}),code:tree(join(stage,'baseline')),input:tree(join(stage,'input')),daily:daily()},null,2));
}else if(process.argv[2]==='check'){
 const before=JSON.parse(readFileSync(join(out,'baseline.json')));const after=daily();
 writeFileSync(join(out,'daily-check.json'),JSON.stringify({unchanged:JSON.stringify(before.daily)===JSON.stringify(after),before:before.daily,after},null,2));
}
console.log(out);
