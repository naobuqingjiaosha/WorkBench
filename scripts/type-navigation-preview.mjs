// Anonymous local preview: read only workflow configuration, never business files or AI credentials.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {isolationEnv} from './isolation-env.mjs';
import PizZip from 'pizzip';
const root=resolve(import.meta.dirname,'..'),stage=join(root,'.tmp/type-navigation-20261019');
Object.assign(process.env,isolationEnv(stage,{HOST:'127.0.0.1',PORT:'8947',WORKBENCH_SESSION_TOKEN:randomBytes(32).toString('hex')}));
await import('./test-preflight.mjs');
// No real model calls, including local endpoints.
globalThis.fetch=async()=>{throw Error('分类验收禁止模型及外部请求');};
if(!existsSync(process.env.WORKBENCH_DB)) {
  const source=new DatabaseSync(join(root,'data/runtime/workbench.db'),{readOnly:true});
  const {initDatabase}=await import('../packages/server/src/db/index.ts');
  const db=initDatabase(process.env.WORKBENCH_DB);
  const insert=(table,row)=>{const columns=Object.keys(row);db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...Object.values(row));};
  for(const table of ['work_type','position_template'])for(const row of source.prepare(`SELECT * FROM ${table}`).all())insert(table,row);
  mkdirSync(join(stage,'files/_templates'),{recursive:true});
  for(const row of source.prepare('SELECT id,code,name,category,work_type_id,position_code,archived_at,shared FROM template').all()){
    const zip=new PizZip();
    zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>匿名隔离模板 {项目名称}</w:t></w:r></w:p></w:body></w:document>');
    const file_rel=`_templates/anonymous-${row.id}.docx`;writeFileSync(join(stage,'files',file_rel),zip.generate({type:'nodebuffer'}));
    insert('template',{...row,file_rel,file_format:'docx',description:'匿名隔离占位模板，仅验证类型与关联。',health_ok:1});
  }
  for(const table of ['material_check','evidence_rule','position_template_doc'])for(const row of source.prepare(`SELECT * FROM ${table}`).all()){
    if('sample_artifact_id' in row)row.sample_artifact_id=null;
    if('deleted_by' in row)row.deleted_by=null;
    insert(table,row);
  }
  const deleted=source.prepare("SELECT * FROM app_setting WHERE key='work_types.deleted'").get();if(deleted)insert('app_setting',deleted);
  source.close();
}
await import('../packages/server/src/index.ts');
console.log('TYPE_NAVIGATION_PREVIEW http://127.0.0.1:8947');
