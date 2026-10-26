import {readFileSync,statSync} from 'node:fs';
import {artifactAbsPath,artifactBodyText,sha256,type Artifact} from './store.ts';
import {extractAny} from './extract.ts';

/** Shared fresh read for both assistants and document generation. No indexing writes. */
export async function readArtifactEvidence(a:Artifact):Promise<{text:string;digest:string;changed:boolean;warning:string}> {
 const path=artifactAbsPath(a);
 if(statSync(path).size>8*1024*1024)throw new Error('资料超过8MB本次读取上限，未读取');
 const digest=sha256(readFileSync(path)),changed=!!a.sha256&&a.sha256!==digest;
 const r=await extractAny(path);
 if(sha256(readFileSync(path))!==digest)throw new Error('读取期间资料发生变化，请重试');
 // Cached OCR is only valid for the identical source bytes.
 const text=!changed&&a.sha256===digest&&a.ocr_text?artifactBodyText({...a,extracted_text:r.text}):r.text;
 return {text,digest,changed,warning:[changed?'磁盘内容已更新，旧索引和核对不可沿用；本次读取当前正文':'',r.message??''].filter(Boolean).join('；')};
}
