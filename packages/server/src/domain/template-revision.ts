import { snapshotTemplateRevision } from './template-history.ts';
/** 以新文件提交模板修订，原件和原变量文件保留。 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, DIRS } from '../core/config.ts';
import { relFrom, safeName } from '../core/paths.ts';
import { checkTemplateHealth, scanTemplate } from '../core/template.ts';
import { templateFingerprint } from '../core/template-fields.ts';
import { getTemplate, readTemplateVars, templateAbsPath, type Template, type TemplateVarSpec, type TemplateVarsFile } from './service.ts';
import { run, tx } from '../db/index.ts';
import { ApiError } from '../api/reply.ts';

export async function commitTemplateRevision(t: Template, bytes: Buffer, hints: {name:string;type?:TemplateVarSpec['type']}[], fingerprint: string) {
  const dir = join(DATA_ROOT,DIRS.templates); mkdirSync(dir,{recursive:true});
  const stem = `${safeName(t.code)}-${randomUUID()}`;
  const path = join(dir,`${stem}.${t.file_format === 'xlsx' ? 'xlsx' : 'docx'}`);
  const varsPath = join(dir,stem+'.vars.json');
  let committed = false;
  try {
    writeFileSync(path,bytes,{flag:'wx'});
    const health = checkTemplateHealth(path);
    if (!health.ok) throw new ApiError('BAD_TEMPLATE',`转换后的文件结构异常，原模板已保留：${health.reason}`);
    const scan = await scanTemplate(path);
    const current = readTemplateVars(t,false);
    const vars: TemplateVarsFile = {...current,template:t.name,updatedAt:new Date().toISOString(),variables:scan.variables.filter(v=>!v.prefix).map(v=> {
      const prev = current.variables.find(p=>p.name===v.name);
      return prev ?? {name:v.name,label:v.name,type:hints.find(h=>h.name===v.name)?.type ?? 'text',required:true};
    })};
    writeFileSync(varsPath,JSON.stringify(vars,null,2),{encoding:'utf8',flag:'wx'});
    tx(()=>{
      const fresh = getTemplate(t.id);
      if (!fresh || fresh.file_rel !== t.file_rel || fresh.updated_at !== t.updated_at || templateFingerprint(templateAbsPath(fresh)) !== fingerprint) throw new ApiError('CONFLICT','模板已经变化，请重新识别后确认',409);
      snapshotTemplateRevision(fresh);
      run(`UPDATE template SET file_rel=?,vars_rel=?,variable_count=?,health_ok=1,health_note=NULL,health_checked_at=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,[relFrom(DATA_ROOT,path),relFrom(DATA_ROOT,varsPath),vars.variables.length,new Date().toISOString(),t.id]);
    });
    committed = true;
    return {template:getTemplate(t.id),warnings:scan.warnings};
  } finally {
    if (!committed) for (const file of [path,varsPath]) { try {rmSync(file,{force:true});} catch { /* 原件仍保留 */ } }
  }
}
