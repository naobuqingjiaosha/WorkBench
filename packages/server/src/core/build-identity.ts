import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,relative} from 'node:path';
import {INSTALL_ROOT,WEB_DIST} from './config.ts';
function digestTree(root:string):string {
 const hash=createHash('sha256');
 const walk=(dir:string):void=>{for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,e.name);if(e.isDirectory())walk(p);else{hash.update(relative(root,p).replaceAll('\\','/'));hash.update(readFileSync(p));}}};
 if(existsSync(root))walk(root);return hash.digest('hex');
}
// Capture once on module evaluation: later disk edits cannot masquerade as a restart.
export const loadedBuild = Object.freeze({
 startedAt:new Date().toISOString(),pid:process.pid,
 sourceBuildId:existsSync(join(INSTALL_ROOT,'SOURCE_BUILD.json'))?JSON.parse(readFileSync(join(INSTALL_ROOT,'SOURCE_BUILD.json'),'utf8')).id:null,
 sourceSha256:digestTree(join(INSTALL_ROOT,'packages/server/src')),
 dependenciesSha256:createHash('sha256').update(readFileSync(join(INSTALL_ROOT,'package-lock.json'))).digest('hex'),
 frontendSha256:digestTree(WEB_DIST),
});
