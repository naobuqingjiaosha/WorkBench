import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,cpSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
export const out=join(root,'outputs/current-integration-2026-10-17');
export const stage=join(root,'.tmp/current-integration-2026-10-17');
export function digest(path){return createHash('sha256').update(readFileSync(path)).digest('hex');}
function tree(dir){const result=[];if(!existsSync(dir))return result;for(const ent of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(dir,ent.name);if(ent.isDirectory())result.push(...tree(p));else result.push({path:relative(root,p).replaceAll('\\','/'),sha256:digest(p)});}return result;}
if(process.argv[2]==='freeze'){
 mkdirSync(out,{recursive:true});mkdirSync(stage,{recursive:true});
 if(existsSync(join(out,'frozen-manifest.json')))throw Error('Already frozen; do not overwrite');
 const paths=['packages/server/src','packages/server/test','packages/web/src','scripts','package.json','package-lock.json','tsconfig.json','packages/server/package.json','packages/web/package.json','packages/web/tsconfig.json','packages/web/vite.config.ts','packages/web/index.html'];
 const files=paths.flatMap(p=>{const full=join(root,p);return p.includes('.')&&!p.endsWith('/src')&&!p.endsWith('/test')&&p!=='scripts'?[{path:p,sha256:digest(full)}]:tree(full);});
 for(const p of paths){const target=join(stage,'candidate',p);mkdirSync(resolve(target,'..'),{recursive:true});cpSync(join(root,p),target,{recursive:true});}
 writeFileSync(join(out,'frozen-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),files},null,2));
 writeFileSync(join(out,'daily-before.json'),JSON.stringify({dist:tree(join(root,'packages/web/dist')),config:existsSync(join(root,'workbench.config.json'))?digest(join(root,'workbench.config.json')):null,db:tree(join(root,'data/runtime')).filter(x=>/workbench\.db$|server\.lock$/.test(x.path))},null,2));
 console.log(JSON.stringify({files:files.length,out,stage}));
}
if(process.argv[2]==='check'){
 const manifest=JSON.parse(readFileSync(join(out,'frozen-manifest.json')));
 const changed=manifest.files.filter(x=>!existsSync(join(root,x.path))||digest(join(root,x.path))!==x.sha256);
 const before=JSON.parse(readFileSync(join(out,'daily-before.json')));
 const after={dist:tree(join(root,'packages/web/dist')),config:existsSync(join(root,'workbench.config.json'))?digest(join(root,'workbench.config.json')):null,db:tree(join(root,'data/runtime')).filter(x=>/workbench\.db$|server\.lock$/.test(x.path))};
 const result={checkedAt:new Date().toISOString(),changed,distUnchanged:JSON.stringify(before.dist)===JSON.stringify(after.dist),configUnchanged:before.config===after.config,dbFileAndLockUnchanged:JSON.stringify(before.db)===JSON.stringify(after.db),after,stagedWeb:tree(join(stage,'web'))};
 writeFileSync(join(out,'freeze-and-daily-check.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({changed:changed.length,distUnchanged:result.distUnchanged,configUnchanged:result.configUnchanged,dbFileAndLockUnchanged:result.dbFileAndLockUnchanged}));
}
