import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join,relative} from 'node:path';
import {INSTALL_ROOT,WEB_DIST,RUNTIME_LAYOUT} from './config.ts';
import {sourceBuildScope} from './runtime-layout.ts';
function digestTree(root:string):string {
 const hash=createHash('sha256');
 const walk=(dir:string):void=>{for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,e.name);if(e.isDirectory())walk(p);else{hash.update(relative(root,p).replaceAll('\\','/'));hash.update(readFileSync(p));}}};
 if(existsSync(root))walk(root);return hash.digest('hex');
}
// Capture once on module evaluation: later disk edits cannot masquerade as a restart.
const manifest = join(INSTALL_ROOT,'SOURCE_BUILD.json');
const build = existsSync(manifest) ? JSON.parse(readFileSync(manifest,'utf8')) : null;
if (build && build.scope !== sourceBuildScope(RUNTIME_LAYOUT)) {
 throw Error('运行副本不属于当前源码和数据库，请从源码目录启动工作台。');
}
export const loadedBuild = Object.freeze({
 startedAt:new Date().toISOString(),pid:process.pid,
 sourceBuildId:build?.id ?? null, scope:build?.scope ?? null,
 sourceSha256:digestTree(join(INSTALL_ROOT,'packages/server/src')),
 dependenciesSha256:createHash('sha256').update(readFileSync(join(INSTALL_ROOT,'package-lock.json'))).digest('hex'),
 frontendSha256:digestTree(WEB_DIST),
});
