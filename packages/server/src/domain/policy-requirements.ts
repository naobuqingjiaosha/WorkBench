import { all, get, run } from '../db/index.ts';
import { ApiError } from '../api/reply.ts';
import { parseCitations, resolveCitation } from './kb-cite.ts';
import PizZip from '../core/office-package.ts';

export interface PolicyRequirement {
  mode: 'off' | 'reference' | 'required';
  documentIds: number[];
}

export function getPolicyRequirement(templateId: number): PolicyRequirement {
  const row = get<{ mode: PolicyRequirement['mode']; document_ids: string }>(
    'SELECT mode,document_ids FROM template_policy_requirement WHERE template_id=?', [templateId]);
  return row ? { mode: row.mode, documentIds: JSON.parse(row.document_ids) } : { mode: 'off', documentIds: [] };
}

/** 不凭标题猜有效性；仅使用入库且没有被标为历史版本的制度。 */
export function policyDocuments() {
  return all<{ id: number; title: string; docNo: string | null; scopeLayer: string | null }>(
    `SELECT d.id,d.title,d.doc_no AS docNo,d.scope_layer AS scopeLayer FROM kb_document d
     WHERE (d.decision IS NULL OR d.decision='active')
       AND (d.version_status IS NULL OR d.version_status IN ('final','current'))
       AND EXISTS(SELECT 1 FROM kb_chunk c WHERE c.document_id=d.id)
     ORDER BY d.title,d.id`);
}

export function setPolicyRequirement(templateId: number, input: unknown): PolicyRequirement {
  if (!get('SELECT id FROM template WHERE id=?', [templateId])) throw new ApiError('NOT_FOUND', '模板不存在', 404);
  const value = input as Partial<PolicyRequirement> | null;
  if (!value || !['off', 'reference', 'required'].includes(String(value.mode)) || !Array.isArray(value.documentIds)
    || value.documentIds.length > 20 || value.documentIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ApiError('BAD_PARAM', '制度设置需要有效模式及最多 20 个制度编号');
  }
  const ids = [...new Set(value.documentIds)];
  const available = policyDocuments();
  for (const id of ids) {
    const doc = available.find(d => d.id === id);
    if (!doc) throw new ApiError('POLICY_UNAVAILABLE', `制度 #${id} 尚未抽取、已失效或属于历史版本`);
    if (value.mode === 'required' && doc.scopeLayer === 'reference') {
      throw new ApiError('REFERENCE_POLICY', `《${doc.title}》是外单位参考制度，不能设为必查依据`);
    }
  }
  if (value.mode === 'off' && ids.length) throw new ApiError('BAD_PARAM', '仅填模板模式不能同时指定制度');
  const requirement: PolicyRequirement = { mode: value.mode as PolicyRequirement['mode'], documentIds: ids };
  run(`INSERT INTO template_policy_requirement(template_id,mode,document_ids) VALUES(?,?,?)
       ON CONFLICT(template_id) DO UPDATE SET mode=excluded.mode,document_ids=excluded.document_ids`,
    [templateId, requirement.mode, JSON.stringify(ids)]);
  return requirement;
}

/** 在实际成品中核对条款，不能用客户端的“已检索”标志代替。 */
export function assertPolicyCitations(requirement: PolicyRequirement, text: string): void {
  if (requirement.mode !== 'required') return;
  const citations = parseCitations(text, { kind: 'template' }).map(c => resolveCitation(c));
  const valid = citations.filter(c => c.status === 'resolved' && c.hit
    && c.hit.scopeLayer !== 'reference'
    && (!c.hit.versionStatus || ['current', 'final'].includes(c.hit.versionStatus)));
  if (!valid.length) throw new ApiError('POLICY_REQUIRED', '此模板必须参考制度：请在正文或依据字段插入可核对的《制度名》第N条引用后再定稿', 409);
  if (citations.some(c => c.status !== 'resolved' || c.hit?.versionStatus === 'superseded')) {
    throw new ApiError('POLICY_CITATION_INVALID', '制度引用存在缺失、歧义或失效版本，请核对全部条款后再定稿', 409);
  }
  const missing = requirement.documentIds.filter(id => !valid.some(c => c.hit!.documentId === id));
  if (missing.length) {
    const names = missing.map(id => get<{ title: string }>('SELECT title FROM kb_document WHERE id=?', [id])?.title ?? `已移除的制度 #${id}`);
    throw new ApiError('POLICY_REQUIRED', `尚未引用必查制度的有效条款：${names.join('、')}`, 409);
  }
}

function xmlText(xml: string): string {
  return xml.replace(/<\/(?:w:p|si|c)>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function policyTextFromBytes(bytes: Buffer, extension: string): string {
  if (!['.docx', '.xlsx', '.xlsm'].includes(extension.toLowerCase())) return bytes.toString('utf8');
  const zip = new PizZip(bytes);
  if (extension.toLowerCase() === '.docx') {
    const pattern = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
    return Object.keys(zip.files).filter(name => pattern.test(name)).map(name => xmlText(zip.file(name)!.asText())).join('\n');
  }
  // sharedStrings 可能残留已删单元格的文字，只有工作表实际引用的字符串才算文书内容。
  const shared = [...(zip.file('xl/sharedStrings.xml')?.asText() ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map(m => xmlText(m[1]!));
  const cells: string[] = [];
  for (const name of Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    for (const m of zip.file(name)!.asText().matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (/\bt=["']s["']/.test(m[1]!)) {
        const index = m[2]!.match(/<v>(\d+)<\/v>/)?.[1];
        if (index !== undefined && shared[Number(index)] !== undefined) cells.push(shared[Number(index)]!);
      } else cells.push(xmlText(m[2]!));
    }
  }
  return cells.join('\n');
}
