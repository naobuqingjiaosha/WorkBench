import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const temporary=process.env.WORKBENCH_ISOLATION_ROOT!;
const source=join(temporary,'checkout'), remote=join(temporary,'synthetic.git');
mkdirSync(join(source,'scripts'),{recursive:true});
for (const file of ['check-repository.mjs','repository-policy.mjs']) cpSync(join('scripts',file),join(source,'scripts',file));
const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(temporary,'gitconfig')};
const git=(...args:string[])=>execFileSync('git',args,{cwd:source,env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
git('init','-b','main'); git('config','user.name','Synthetic'); git('config','user.email','synthetic@example.invalid');
git('init','--bare',remote);
const zeros='0'.repeat(40);
function check(options:string[], input='') {
  const result=spawnSync(process.execPath,['scripts/check-repository.mjs',...options],{env,cwd:source,input,encoding:'utf8'});
  assert.ok([0,1].includes(result.status??-1),result.stderr);
  return JSON.parse(result.stdout);
}
writeFileSync(join(source,'private.txt'),'synthetic test only');
git('add','.'); assert.equal(check(['--staged']).ok,false);
git('commit','-m','synthetic existing history');
git('push',remote,'main'); // Only a temporary bare repository; establish the known common ancestor.
git('rm','private.txt'); git('commit','-m','safe source only');
const branch=()=> 'refs/heads/review '+git('rev-parse','HEAD')+' refs/heads/review '+zeros+'\n';
assert.equal(check(['--pre-push',remote],branch()).ok,true);
assert.equal(check(['--pre-push'],branch()).ok,false);
writeFileSync(join(source,'intermediate.txt'),'synthetic intermediate');git('add','.');git('commit','-m','synthetic new private file');
git('rm','intermediate.txt');git('commit','-m','synthetic later deletion');
assert.equal(check(['--pre-push',remote],branch()).ok,false);
console.log('源码边界：暂存、新分支共同历史、空远端、已删除的中间提交分别核查');
