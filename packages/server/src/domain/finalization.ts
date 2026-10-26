import { get } from '../db/index.ts';
import {documentSourceSignature} from './document-source.ts';
import { assertBusinessEvidenceFinal } from './business-evidence.ts';
import { reviewMemoryFacts, assertFactReview, type FactReview } from './memory-facts.ts';
import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';
import PizZip from '../core/office-package.ts';
import { ApiError } from '../api/reply.ts';
import { artifactAbsPath, sha256, type Artifact } from '../core/store.ts';
import { scanDocx, checkTemplateHealth } from '../core/template.ts';
import { scanPlaceholders } from '../core/placeholders.ts';
import { getPolicyRequirement, assertPolicyCitations, policyTextFromBytes, type PolicyRequirement } from './policy-requirements.ts';

/** 检查磁盘上的实际文件，覆盖生成保存、旧版定稿及完成检查。 */
export function assertFinalFile(path: string): void {
    if (!existsSync(path)) throw new ApiError('FILE_MISSING', '定稿文件丢失，请重新生成或恢复文件', 409);
    assertFinalBytes(readFileSync(path), extname(path));
}

export function assertFinalBytes(bytes: Buffer, extension: string): void {
    const ext = extension.toLowerCase();
    if (['.docx','.xlsx','.xlsm'].includes(ext)) {
        const health=checkTemplateHealth('定稿'+ext,bytes);
        if(!health.ok) throw new ApiError('BAD_DOCUMENT',(health.reason ?? '文书结构损坏，不能定稿')+'；如文件已被修改，原确认已失效，请核对当前内容。',409);
    }
    let missing: string[] = [];
    const collect=(text:string)=>{missing.push(...scanPlaceholders(text).map(v=>v.raw));missing.push(...(text.match(/【待补[^】]*】?/g)??[]));};
    if (ext === '.docx') {
        if (!new PizZip(bytes).file('word/document.xml')) throw new ApiError('BAD_DOCUMENT', '文书缺少正文，不能定稿', 409);
        const scan=scanDocx(bytes);missing=scan.variables.map(v=>v.raw);missing.push(...(scan.preview.match(/【待补[^】]*】?/g)??[]));
    }
    else if (['.xlsx', '.xlsm'].includes(ext)) {
        const zip = new PizZip(bytes);
        if (!zip.file('xl/workbook.xml')) throw new ApiError('BAD_DOCUMENT','工时或文书缺少工作簿，不能定稿',409);
        for (const name of Object.keys(zip.files).filter(n => /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(n))) {
            const xml = zip.file(name)!.asText();
            // 在单个字符串/单元格内合并富文本，不能把相邻单元格拼成变量。
            for (const match of xml.matchAll(/<(si|c)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
                const text = match[2]!.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
                collect(text);
            }
        }
    } else if (['.txt', '.md', '.csv'].includes(ext)) collect(bytes.toString('utf8'));
    if (missing.length) throw new ApiError('MISSING_FACTS', `必填内容或图片仍有占位，不能定稿：${[...new Set(missing)].join('、')}`, 409);
}

export function assertFinalArtifact(a: Artifact,options:{confirmLegacy?:boolean}={}): void {
    assertBusinessEvidenceFinal(a.id);
    assertFinalFile(artifactAbsPath(a));
    const policy = get<{snapshot:string}>('SELECT snapshot FROM artifact_policy_requirement WHERE artifact_id=?',[a.id]);
    const templateId = (a as Artifact & {template_id?:number|null}).template_id
      ?? get<{template_id:number|null}>('SELECT template_id FROM generation_log WHERE artifact_id=? ORDER BY id DESC LIMIT 1',[a.id])?.template_id;
    const requirement = policy ? JSON.parse(policy.snapshot) as PolicyRequirement
      : templateId ? getPolicyRequirement(templateId) : null;
    if (requirement?.mode === 'required') assertPolicyCitations(requirement,
      policyTextFromBytes(readFileSync(artifactAbsPath(a)), extname(a.file_name)));
    const review=get<{snapshot:string}>('SELECT snapshot FROM artifact_fact_review WHERE artifact_id=?',[a.id]);
    if(a.kind==='generated'&&a.is_final&&!options.confirmLegacy&&(!review||!JSON.parse(review.snapshot).sourceSignature))throw new ApiError('LEGACY_REVIEW_REQUIRED','旧版定稿未保存来源签名；请打开文件核对当前业务事实后重新确认定稿，历史文件保留',409);
    if(review) {
        const snapshot=JSON.parse(review.snapshot) as FactReview & {digest?:string;sourceSignature?:string;sourceArtifactIds?:number[];sourceChanged?:boolean};
        if(snapshot.sourceChanged)throw new ApiError('SOURCE_CHANGED','旧版文书的业务来源已修改，请重新生成并核对；历史文件保留',409);
        if(snapshot.sourceSignature && snapshot.sourceSignature!==documentSourceSignature(a.workbench_id,(a as Artifact&{work_period_id?:number}).work_period_id,a.template_id,snapshot.sourceArtifactIds,(a as Artifact&{inspection_id?:number}).inspection_id))throw new ApiError('SOURCE_CHANGED','业务内容、来源资料或模板已变化；历史文件保留，请重新生成并核对当前成果',409);
        assertFactReview(snapshot);
        if(snapshot.conflicts.length && sha256(readFileSync(artifactAbsPath(a)))!==snapshot.digest) throw new ApiError('FACT_REVIEW_STALE','文书内容已变化，来源冲突确认已失效，请重新生成并核对',409);
    }
    else {
        const log=get<{variables:string|null}>('SELECT variables FROM generation_log WHERE artifact_id=? ORDER BY id DESC LIMIT 1',[a.id]);
        assertFactReview(reviewMemoryFacts(a.workbench_id,(a as Artifact & {work_period_id?:number}).work_period_id,JSON.parse(log?.variables ?? '{}')));
    }
    if(a.is_final&&a.sha256&&sha256(readFileSync(artifactAbsPath(a)))!==a.sha256)throw new ApiError('FINAL_CHANGED','定稿文件已被修改，旧核对确认已失效；请先取消定稿，核对当前文件后重新确认',409);
}
