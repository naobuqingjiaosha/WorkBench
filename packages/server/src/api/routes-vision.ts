/**
 * 影像证据初检接口
 *
 * 单张审、整条清单审、以及回看历史结论。
 * 结论只是**初检意见**：核销清单仍然要人确认（或者由 AI 助手提议、人点确认）。
 */
import type { FastifyInstance } from 'fastify';
import { listReviews, reviewArtifact, reviewChecklistItem } from '../core/vision.ts';
import { ApiError, body, fail, intParam, ok, optNum, optStr } from './reply.ts';

export function registerVisionRoutes(app: FastifyInstance): void {
  /** 审一张照片 */
  app.post('/api/evidence/review', async (req, reply) => {
    try {
      const b = body(req);
      const artifactId = optNum(b, 'artifactId');
      if (!artifactId) throw new ApiError('MISSING_FIELD', '需要 artifactId');
      const r = await reviewArtifact(artifactId, {
        checklistItemId: optNum(b, 'checklistItemId') ?? null,
        extraNote: optStr(b, 'note'),
      });
      if (!r.ok && r.error) throw new ApiError('REVIEW_FAILED', r.error);
      return ok(reply, r, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 审一条清单下的全部照片（含数量是否够） */
  app.post('/api/evidence/review-checklist/:id', async (req, reply) => {
    try {
      const id = intParam(req, 'id');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const r = await reviewChecklistItem(id, { extraNote: optStr(b, 'note') });
      if (!r.ok && r.error) throw new ApiError('REVIEW_FAILED', r.error);
      return ok(reply, r, 201);
    } catch (e) {
      return fail(reply, e);
    }
  });

  /** 回看结论：按照片 / 按清单 / 按工作台 */
  app.get('/api/evidence/reviews', async (req, reply) => {
    try {
      const q = req.query as Record<string, string>;
      const num = (k: string) => (q[k] ? Number(q[k]) : undefined);
      const items = listReviews({
        artifactId: num('artifactId'),
        checklistItemId: num('checklistItemId'),
        workbenchId: num('workbenchId'),
      });
      return ok(reply, { items });
    } catch (e) {
      return fail(reply, e);
    }
  });
}
