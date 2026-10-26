import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA_ROOT,DIRS} from '../core/config.ts';
import {ensureDir,resolveInside,toPosix} from '../core/paths.ts';
import {run} from '../db/index.ts';
import type {Template} from './service.ts';

/** Store immutable template and field-map copies before edits. Original business sources are read-only. */
export function snapshotTemplateRevision(t:Template):void {
 const file=resolveInside(DATA_ROOT,t.file_rel);
 if(!existsSync(file))return;
 const bytes=readFileSync(file),vars=t.vars_rel?resolveInside(DATA_ROOT,t.vars_rel):null;
 const mapping=vars&&existsSync(vars)?readFileSync(vars):null;
 const digest=createHash('sha256').update(bytes).update(mapping??'').digest('hex');
 const dir=toPosix(join(DIRS.templates,'_历史',String(t.id)));
 ensureDir(resolveInside(DATA_ROOT,dir));
 const fileRel=toPosix(join(dir,`${digest}.${t.file_format==='xlsx'?'xlsx':'docx'}`));
 const varsRel=mapping?toPosix(join(dir,`${digest}.vars.json`)):null;
 if(!existsSync(resolveInside(DATA_ROOT,fileRel)))writeFileSync(resolveInside(DATA_ROOT,fileRel),bytes,{flag:'wx'});
 if(mapping&&varsRel&&!existsSync(resolveInside(DATA_ROOT,varsRel)))writeFileSync(resolveInside(DATA_ROOT,varsRel),mapping,{flag:'wx'});
 run('INSERT OR IGNORE INTO template_revision(template_id,digest,file_rel,vars_rel,metadata) VALUES(?,?,?,?,?)',[t.id,digest,fileRel,varsRel,JSON.stringify(t)]);
}
