import type { FastifyInstance } from 'fastify';
import { all } from '../db/index.ts';
import { decideRequest, pendingRequests } from '../ai/consent.ts';
import { ApiError, body, fail, ok, requireStr } from './reply.ts';
export function registerConsentRoutes(app: FastifyInstance): void {
    app.get('/api/ai/requests', async (_req, reply) => ok(reply, { items: pendingRequests() }));
    app.get('/api/ai/requests/history', async (_req, reply) => ok(reply, { items: all('SELECT id,target,purpose,model,digest,state,created_at,decided_at FROM ai_request ORDER BY created_at DESC LIMIT 100') }));
    app.post('/api/ai/consents', async (req, reply) => {
        try {
            const b = body(req);
            if (typeof b.approve !== 'boolean')
                throw new ApiError('BAD_FIELD', '需要明确选择允许或拒绝');
            decideRequest(requireStr(b, 'id'), requireStr(b, 'digest'), b.approve);
            return ok(reply, { decided: true });
        }
        catch (e) {
            return fail(reply, e);
        }
    });
}
