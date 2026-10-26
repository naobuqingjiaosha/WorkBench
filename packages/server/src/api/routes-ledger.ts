import type {FastifyInstance} from 'fastify';
import {readFileSync} from 'node:fs';
import {dirname,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {body,fail,ok,intParam,ApiError} from './reply.ts';
import {loadBook,readForm} from '../domain/ledger-office.ts';
import {readParts,cleanupTemp} from './upload.ts';
import {ledgerView,importAnnualLedger,setLedgerTemplate,addLedgerEntry,patchLedgerEntry,inspectLedgerChanges,syncAnnualLedger,generateLedgerForms,ledgerDocument,freezeLedgerDocument,annualLedgerFile,suggestLedgerEntry,ledgerPath} from '../domain/annual-ledger.ts';
export function registerLedgerRoutes(app:FastifyInstance){
 const route=(method:'get'|'post'|'put',path:string,fn:(req:any)=>unknown)=>app[method]('/api/periods/:id/ledger'+path,async(req,reply)=>{try{return ok(reply,await fn(req));}catch(e){return fail(reply,e);}});
 route('get','',req=>ledgerView(intParam(req,'id')));
 route('get','/changes',req=>inspectLedgerChanges(intParam(req,'id')));
 route('get','/documents/:doc/preview',async req=>{const d=ledgerDocument(intParam(req,'id'),req.params.doc);return {fields:readForm(await loadBook(d.path),d.kind,d.id,d.entry_id)};});
 route('post','/sync',req=>{const b=body(req);if(b.resolutions!==undefined&&(!b.resolutions||typeof b.resolutions!=='object'||Array.isArray(b.resolutions)))throw new ApiError('BAD_RESOLUTION','冲突选择无效');return syncAnnualLedger(intParam(req,'id'),b.resolutions as Record<string,string>??{},typeof b.token==='string'?b.token:undefined);});
 route('post','/entries',req=>addLedgerEntry(intParam(req,'id'),body(req).fields));
 route('put','/entries/:entry',req=>patchLedgerEntry(intParam(req,'id'),req.params.entry,Number(body(req).revision),body(req).fields,body(req).confirm===true));
 route('post','/entries/:entry/suggest',req=>{const b=body(req);return suggestLedgerEntry(intParam(req,'id'),req.params.entry,Number(b.revision),String(b.instruction??''),{fields:b.fields,allowedFields:b.allowedFields,includeHistory:b.includeHistory!==false});});
 route('post','/entries/:entry/generate',req=>{const b=body(req);if(b.kinds!==undefined&&(!Array.isArray(b.kinds)||b.kinds.some(k=>typeof k!=='string')))throw new ApiError('BAD_KIND','文件类型无效');return generateLedgerForms(intParam(req,'id'),req.params.entry,{kinds:b.kinds as string[]|undefined,revision:b.revision===undefined?undefined:Number(b.revision)});});
 route('post','/documents/:doc/freeze',req=>freezeLedgerDocument(intParam(req,'id'),req.params.doc,String(body(req).state)));
 route('post','/bind',req=>{const path=ledgerPath(intParam(req,'id'),String(body(req).path??''));return importAnnualLedger(intParam(req,'id'),basename(path),readFileSync(path),path);});
 app.post('/api/periods/:id/ledger/upload',async(req,reply)=>{
  let files:{tempPath:string}[]=[];try{const parts=await readParts(req);files=parts.files;if(files.length!==1)throw new ApiError('ONE_FILE','每次上传一个文件');const f=parts.files[0]!;const kind=String(parts.fields.kind??'ledger');return ok(reply,kind==='ledger'?await importAnnualLedger(intParam(req,'id'),f.fileName,readFileSync(f.tempPath)):await setLedgerTemplate(intParam(req,'id'),kind,f.fileName,readFileSync(f.tempPath)));}catch(e){return fail(reply,e);}finally{files.forEach(f=>cleanupTemp(f.tempPath));}
 });
 for(const kind of ['file','documents/:doc/file'])app.get('/api/periods/:id/ledger/'+kind,async(req,reply)=>{try{const path=kind==='file'?annualLedgerFile(intParam(req,'id')):ledgerDocument(intParam(req,'id'),(req.params as {doc:string}).doc).path;return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`).send(readFileSync(path));}catch(e){return fail(reply,e);}});
 route('post','/open',req=>{
  const b=body(req),path=typeof b.docId==='string'?ledgerDocument(intParam(req,'id'),b.docId).path:annualLedgerFile(intParam(req,'id'));
  if(process.platform!=='win32')throw new ApiError('UNSUPPORTED','请下载后在本地编辑，再使用绑定目录同步');
  const target=b.folder===true?dirname(path):path;const child=spawn('explorer.exe',[target],{windowsHide:false,detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();return {requested:true,path};
 });
}
