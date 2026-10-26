import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {isolationEnv} from './isolation-env.mjs';
const root=resolve(import.meta.dirname,'..'),stage=join(root,'.tmp/current-integration-2026-10-17'),out=join(root,'outputs/current-integration-2026-10-17');
Object.assign(process.env,isolationEnv(stage));
const db=new DatabaseSync(join(stage,'runtime/workbench.db'),{readOnly:true});
const save=(n,v)=>writeFileSync(join(out,n),JSON.stringify(v,null,2));
const hash=b=>createHash('sha256').update(b).digest('hex');
const rows=db.prepare('SELECT * FROM business_ai_run ORDER BY id').all();
const docs=[];mkdirSync(join(out,'offline-only'),{recursive:true});
for(const r of rows){
 if(!r.artifact_id)continue;
 const a=db.prepare('SELECT * FROM artifact WHERE id=?').get(r.artifact_id),path=join(stage,'files',a.file_rel);
 const bytes=readFileSync(path),name=r.id===3?'offline-rule-original.docx':r.parent_id?'offline-agent-edit.docx':'offline-rule-source-updated.docx';
 cpSync(path,join(out,'offline-only',name));
 const bundle={...r,snapshot:JSON.parse(r.snapshot),draft:JSON.parse(r.draft),writing:JSON.parse(r.writing),validation:JSON.parse(r.validation)};
 save(`offline-only/run-${r.id}.json`,bundle);
 docs.push({runId:r.id,artifactId:a.id,file:name,parentId:r.parent_id,writingMode:bundle.writing.mode,reviewNote:r.review_note,reviewedDigest:r.reviewed_digest,sha256:hash(bytes),originalStoredSha256:a.sha256,bytesUnchanged:hash(bytes)===a.sha256,isFinal:a.is_final});
}
const selected=JSON.parse(readFileSync(join(out,'selection-checks.json'))),checks=[];
for(const x of selected){
 const text=x.selectedFacts.map(f=>f.text).join('\n');
 const hasNoise=/桌椅|饮水机/.test(text);
 const needed=x.case==='complete'?['2026-03-12','2026-03-13','18','90']:x.case==='conflict'?['仍不亮','可持续点亮']:['2026-08-19','2026-07-16','2026-09-08','验收附件尚未补齐','采购监督支持资料待补'];
 checks.push({case:x.case,question:x.question,requiredPresent:needed.every(t=>text.includes(t)),missing:needed.filter(t=>!text.includes(t)),unrelatedIncluded:hasNoise,crossQuarterIncluded:x.case==='quarter'&&/2026-06-28|2026-10-06/.test(text),result:hasNoise?'failed-selection-contamination':'passed-selection-only'});
}
const old=rows.find(x=>x.id===3),edited=rows.find(x=>x.parent_id===3),fresh=rows.at(-1);
const newDraft=JSON.parse(fresh.draft),text=Object.values(newDraft.values).join('\n'),pack=JSON.parse(fresh.snapshot);
const result={externalRequests:db.prepare("SELECT COUNT(*) n FROM ai_request WHERE state IN ('sending','sent','failed')").get().n,aiCallLogs:db.prepare('SELECT provider_code,model,purpose,ok,error_message,is_test FROM ai_call_log').all(),docs,selectionChecks:checks,workflow:{newFactInBody:text.includes('2026-09-24')&&text.includes('已紧固'),unresolvedContractRetained:text.includes('验收附件尚未补齐'),unresolvedProcurementRetained:text.includes('采购监督支持资料待补'),talkRetainedInEvidence:pack.facts.some(f=>f.text.includes('2026-07-16')),talkInOfflineWord:text.includes('2026-07-16'),oldReviewRecorded:!!old.review_note,editedReviewNotInherited:!edited.review_note&&!edited.reviewed_digest,recollectedReviewNotInherited:!fresh.review_note&&!fresh.reviewed_digest,oldDocumentBytesPreserved:docs.every(d=>d.bytesUnchanged),allDrafts:docs.every(d=>d.isFinal===0)}};
save('offline-verification.json',result);
const source=JSON.parse(readFileSync(join(out,'offline-source-change.json')));save('source-comparison.json',{status:'offline only; real-model sequence pending authorization',before:source.before,after:source.after,expectedRealSequence:JSON.parse(readFileSync(join(out,'new-scenarios.frozen.json'))).cases[2].change});
save('actual-request-ledger.json',{authorized:false,actualExternalRequests:0,calls:[],localNotSentAttempts:result.aiCallLogs,explanation:'Browser recollect encountered missing key before network dispatch; not an external request.'});
console.log(JSON.stringify({documents:docs.map(d=>({run:d.runId,file:d.file,unchanged:d.bytesUnchanged})),workflow:result.workflow,selectionFailures:checks.filter(x=>x.result.startsWith('failed')).length,externalRequests:result.externalRequests},null,2));
db.close();
