/**
 * 让模型看图 —— 影像证据初检
 *
 * 两件事要分清楚：
 *   ① **看图的是视觉模型**（用途 `vision`，如 qwen3-vl-flash）。
 *      写作模型（DeepSeek）收不了图片，所以照片永远不直接进写文书的提示词，
 *      而是先由视觉模型看懂、说成人话，再把这段文字给写作模型用。
 *   ② 模型给的是**初检意见**，不是验收结论。它会看错，所以：
 *      · 结论存下来供人核对（`evidence_review` 表）；
 *      · 核销清单仍然是人的动作（或经人确认的助手动作）；
 *      · 提示词里明确要求"看不清就说看不清"，不许猜。
 */
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { all, get, run } from '../db/index.ts';
import { chat, type ChatContentPart } from '../ai/gateway.ts';
import { artifactAbsPath, getArtifact, type Artifact } from '../core/store.ts';
import { aiReadiness } from '../ai/gateway.ts';

export type Verdict = 'ok' | 'issue' | 'unclear';

export interface ReviewResult {
  ok: boolean;
  verdict: Verdict;
  summary: string;
  issues: string[];
  suggestion: string;
  seen: string;
  model: string;
  error?: string;
  reviewId?: number;
}

export interface EvidenceRequirement {
  title: string;
  detail?: string | null;
  minCount?: number;
  shootingPoints?: string | null;
  angles?: string | null;
}

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

export function isReviewableImage(a: Artifact): boolean {
  return Boolean(IMAGE_MIME[extname(a.file_name).toLowerCase()]);
}

/** 图片文件 → data URI。超过 4MB 的直接拒绝：base64 之后会更胖，接口多半也不收 */
function toDataUri(abs: string, fileName: string): string {
  const buf = readFileSync(abs);
  if (buf.byteLength > 4 * 1024 * 1024) {
    throw new Error(`照片太大（${Math.round(buf.byteLength / 1024 / 1024)}MB），先压缩到 4MB 以内再交给模型`);
  }
  const mime = IMAGE_MIME[extname(fileName).toLowerCase()] ?? 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** 这条清单要求的拍摄要点，从规则表里取（清单项自身也带了 detail） */
export function requirementOf(checklistItemId: number | null | undefined): EvidenceRequirement | null {
  if (!checklistItemId) return null;
  const row = get<{ title: string; detail: string | null; min_count: number; source_id: number | null }>(
    'SELECT title, detail, min_count, source_id FROM checklist_item WHERE id = ?',
    [checklistItemId],
  );
  if (!row) return null;
  const rule = row.source_id
    ? get<{ shooting_points: string | null; angles: string | null }>(
        'SELECT shooting_points, angles FROM evidence_rule WHERE id = ?',
        [row.source_id],
      )
    : undefined;
  return {
    title: row.title,
    detail: row.detail,
    minCount: row.min_count,
    shootingPoints: rule?.shooting_points ?? null,
    angles: rule?.angles ?? null,
  };
}

function buildPrompt(req: EvidenceRequirement | null, extraNote?: string): string {
  return [
    '你是工程与行政影像资料的审核助手。请判断这张照片能不能作为该项工作的影像证据。',
    '',
    req ? `【这条影像要证明什么】${req.title}` : '【说明】调用方没有给出具体要求，请按"能否清楚证明现场情况"来判断。',
    req?.detail ? `【补充说明】${req.detail}` : '',
    req?.shootingPoints ? `【拍摄要点】${req.shootingPoints}` : '',
    req?.angles ? `【建议角度】${req.angles}` : '',
    req && req.minCount && req.minCount > 1 ? `【至少需要】${req.minCount} 张` : '',
    extraNote ? `【本次特别要求】${extraNote}` : '',
    '',
    '【怎么判断】',
    '1. 先客观描述你在照片里看到了什么（主体、文字、标识、角度、清晰度）。',
    '2. 再对照拍摄要点，看有没有拍到该拍的东西、够不够清楚。',
    '3. 看不清或信息不足时，判 unclear，不要猜。**绝对不要编造照片里没有的内容。**',
    '',
    '【输出】只输出一个 JSON 对象，不要解释、不要代码围栏：',
    '{"seen":"照片里实际能看到什么","verdict":"ok|issue|unclear","summary":"一句话结论",',
    ' "issues":["具体问题1","具体问题2"],"suggestion":"需要补拍什么（没有就留空）"}',
    'verdict 取 ok（满足要求）/ issue（明确不满足，如没拍到关键信息、模糊、角度不对）/ unclear（看不清或无法判断）。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 解析模型返回；容错处理让它不至于因为多一句话就整条失败 */
function parseReview(text: string): { seen: string; verdict: Verdict; summary: string; issues: string[]; suggestion: string } | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const verdictRaw = String(o.verdict ?? '').toLowerCase();
    const verdict: Verdict = verdictRaw === 'ok' || verdictRaw === 'issue' || verdictRaw === 'unclear' ? verdictRaw : 'unclear';
    const issues = Array.isArray(o.issues) ? o.issues.map((x) => String(x)).filter(Boolean) : o.issues ? [String(o.issues)] : [];
    return {
      seen: String(o.seen ?? '').trim(),
      verdict,
      summary: String(o.summary ?? '').trim() || (verdict === 'ok' ? '看起来满足要求' : '需要人工确认'),
      issues,
      suggestion: String(o.suggestion ?? '').trim(),
    };
  } catch {
    return null;
  }
}

/**
 * 审一张照片。
 *
 * 走 `vision` 用途；没配视觉模型时**直接说清楚**，而不是拿写作模型硬试
 * （写作模型收图片会报错，错误信息还很难懂）。
 */
export async function reviewArtifact(
  artifactId: number,
  opts: { checklistItemId?: number | null; extraNote?: string; silentNote?: boolean } = {},
): Promise<ReviewResult> {
  const empty = (error: string): ReviewResult => ({
    ok: false,
    verdict: 'unclear',
    summary: '',
    issues: [],
    suggestion: '',
    seen: '',
    model: '',
    error,
  });

  const a = getArtifact(artifactId);
  if (!a) return empty('照片不存在');
  if (!isReviewableImage(a)) return empty(`${a.file_name} 不是图片，只有照片能交给模型看`);

  const ready = aiReadiness('vision');
  if (!ready.ready) {
    return empty(
      `还没有可用的图像识别模型（${ready.reason ?? '未配置'}）。到「系统配置 → 模型接入 → 图像识别」选一个能看图的模型，例如 qwen3-vl-flash。`,
    );
  }

  const checklistItemId = opts.checklistItemId ?? a.checklist_item_id ?? null;
  const req = requirementOf(checklistItemId);
  let dataUri: string;
  try {
    dataUri = toDataUri(artifactAbsPath(a), a.file_name);
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e));
  }

  const content: ChatContentPart[] = [
    { type: 'text', text: buildPrompt(req, opts.extraNote) },
    { type: 'image_url', image_url: { url: dataUri, detail: 'high' } },
  ];

  const res = await chat({
    purpose: 'vision',
    messages: [
      { role: 'system', content: '你是严谨的影像资料审核助手，只根据照片本身判断，看不清就说不清，绝不编造。' },
      { role: 'user', content },
    ],
    maxTokens: 2048,
    ref: { type: 'evidence-review', id: artifactId },
  });
  if (!res.ok) return { ...empty(res.error ?? '模型调用失败'), model: res.model };

  const parsed = parseReview(res.text);
  if (!parsed) {
    return {
      ok: false,
      verdict: 'unclear',
      summary: res.text.slice(0, 200),
      issues: [],
      suggestion: '',
      seen: '',
      model: res.model,
      error: '模型返回的不是预期格式，原文见上（可重试）',
    };
  }

  const reviewId = run(
    `INSERT INTO evidence_review (artifact_id, checklist_item_id, workbench_id, verdict, summary, issues, suggestion, seen, model)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      a.id,
      checklistItemId,
      a.workbench_id ?? null,
      parsed.verdict,
      parsed.summary,
      JSON.stringify(parsed.issues),
      parsed.suggestion || null,
      parsed.seen || null,
      res.model,
    ],
  ).lastInsertRowid;

  return { ok: true, ...parsed, model: res.model, reviewId };
}

/** 某条清单下所有照片的初检结果（最新的那条为准） */
export function listReviews(filter: { artifactId?: number; checklistItemId?: number; workbenchId?: number }): {
  id: number;
  artifact_id: number;
  checklist_item_id: number | null;
  verdict: Verdict;
  summary: string;
  issues: string[];
  suggestion: string | null;
  seen: string | null;
  model: string | null;
  created_at: string;
}[] {
  const where: string[] = [];
  const params: number[] = [];
  if (filter.artifactId) {
    where.push('artifact_id = ?');
    params.push(filter.artifactId);
  }
  if (filter.checklistItemId) {
    where.push('checklist_item_id = ?');
    params.push(filter.checklistItemId);
  }
  if (filter.workbenchId) {
    where.push('workbench_id = ?');
    params.push(filter.workbenchId);
  }
  const rows = all<{
    id: number;
    artifact_id: number;
    checklist_item_id: number | null;
    verdict: Verdict;
    summary: string;
    issues: string | null;
    suggestion: string | null;
    seen: string | null;
    model: string | null;
    created_at: string;
  }>(
    `SELECT id, artifact_id, checklist_item_id, verdict, summary, issues, suggestion, seen, model, created_at
       FROM evidence_review ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 200`,
    params,
  );
  return rows.map((r) => ({
    ...r,
    issues: r.issues ? (JSON.parse(r.issues) as string[]) : [],
  }));
}

/**
 * 审一条清单下的全部照片，并给出总体结论。
 * 为什么要有"总体"：拍摄要点常写"全景 + 特写"这种组合，单看一张永远不合格。
 */
export async function reviewChecklistItem(
  checklistItemId: number,
  opts: { extraNote?: string } = {},
): Promise<{
  ok: boolean;
  item: EvidenceRequirement | null;
  minCount: number;
  photoCount: number;
  verdict: Verdict;
  summary: string;
  issues: string[];
  photos: { artifactId: number; file_name: string; verdict: Verdict; summary: string; issues: string[]; suggestion: string }[];
  error?: string;
}> {
  const item = requirementOf(checklistItemId);
  if (!item) {
    return { ok: false, item: null, minCount: 0, photoCount: 0, verdict: 'unclear', summary: '', issues: [], photos: [], error: '找不到这条清单' };
  }
  // 回收站里的照片不参与检查：`deleted_at IS NULL` 与 evidenceCount 的口径一致，
  // 否则"删了照片，视觉模型还在评它"
  const photos = all<{ id: number; file_name: string }>(
    'SELECT id, file_name FROM artifact WHERE checklist_item_id = ? AND deleted_at IS NULL ORDER BY id',
    [checklistItemId],
  );
  if (!photos.length) {
    return {
      ok: false,
      item,
      minCount: item.minCount ?? 1,
      photoCount: 0,
      verdict: 'issue',
      summary: '这条还没有照片',
      issues: ['没有可检查的照片'],
      photos: [],
      error: '这条清单下还没有照片',
    };
  }

  const results: { artifactId: number; file_name: string; verdict: Verdict; summary: string; issues: string[]; suggestion: string }[] = [];
  let firstError: string | undefined;
  for (const p of photos) {
    const r = await reviewArtifact(p.id, { checklistItemId, extraNote: opts.extraNote });
    if (!r.ok && r.error) firstError = firstError ?? r.error;
    results.push({
      artifactId: p.id,
      file_name: p.file_name,
      verdict: r.verdict,
      summary: r.summary,
      issues: r.issues,
      suggestion: r.suggestion,
    });
  }

  const need = item.minCount ?? 1;
  const issueCount = results.filter((r) => r.verdict === 'issue').length;
  const unclearCount = results.filter((r) => r.verdict === 'unclear').length;
  const shortCount = results.length < need;

  let verdict: Verdict = 'ok';
  if (issueCount > 0 || shortCount) verdict = 'issue';
  else if (unclearCount > 0) verdict = 'unclear';

  const issues = [
    ...(shortCount ? [`数量不够：要求至少 ${need} 张，现在 ${results.length} 张`] : []),
    ...results.flatMap((r) => r.issues.map((x) => `${r.file_name}：${x}`)),
  ];
  const summary =
    verdict === 'ok'
      ? `${results.length} 张照片看起来满足要求`
      : verdict === 'issue'
        ? `有 ${issues.length} 处问题需要处理`
        : '照片看不清，需要人工确认';

  return { ok: true, item, minCount: need, photoCount: results.length, verdict, summary, issues, photos: results, error: firstError };
}

/**
 * 给写作模型用的照片说明。
 *
 * 出文书时把现场照片"翻译"成一段文字塞进提示词 —— 写作模型（DeepSeek）看不了图，
 * 但它能读懂"照片里拍到了什么"。这就是「分析完图片，再做到相应的工作」那一步。
 */
export async function evidenceContextFor(artifacts: Artifact[]): Promise<string> {
  const images = artifacts.filter(isReviewableImage);
  if (!images.length) return '';
  const ready = aiReadiness('vision');
  if (!ready.ready) {
    return `（有 ${images.length} 张现场照片，但图像识别模型不可用：${ready.reason ?? '未配置'}）`;
  }
  const parts: string[] = [];
  for (const a of images) {
    const r = await reviewArtifact(a.id, {});
    parts.push(
      r.ok
        ? `【照片：${a.title || a.file_name}】${r.seen ? `看到：${r.seen}。` : ''}判断：${r.summary}${
            r.issues.length ? `；问题：${r.issues.join('；')}` : ''
          }`
        : `【照片：${a.title || a.file_name}】未能分析（${r.error ?? '未知原因'}）`,
    );
  }
  return parts.join('\n');
}
