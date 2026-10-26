import { createHash, randomUUID } from 'node:crypto';
import { all, get, run } from '../db/index.ts';
import { ApiError } from '../api/reply.ts';
const owner = randomUUID();
export interface PendingRequest {
    id: string;
    target: string;
    purpose: string;
    model: string;
    payload: string;
    digest: string;
    state: string;
    expires_at: string;
    owner: string;
}
export function expireRequests(): void {
    run("UPDATE ai_request SET state='expired',payload='' WHERE (state IN ('pending','approved') AND expires_at<=?) OR (state IN ('pending','approved','sending') AND owner<>?)", [new Date().toISOString(), owner]);
}
export function pendingRequests(): PendingRequest[] {
    expireRequests();
    return all<PendingRequest>("SELECT * FROM ai_request WHERE owner=? AND state='pending' ORDER BY created_at", [owner]);
}
export function decideRequest(id: string, digest: string, approve: boolean): void {
    expireRequests();
    const r = run("UPDATE ai_request SET state=?,decided_at=? WHERE id=? AND digest=? AND owner=? AND state='pending'", [approve ? 'approved' : 'denied', new Date().toISOString(), id, digest, owner]);
    if (!r.changes)
        throw new ApiError('CONSENT_STALE', '请求已变更、过期或已处理，请刷新。', 409);
}
/** The caller retains its continuation: no HTTP/business-action replay after approval. */
export async function authorizeRequest(target: string, payload: string, purpose: string): Promise<string> {
    const url = new URL(target);
    if (url.username || url.password || url.search)
        throw new ApiError('UNSAFE_MODEL_URL', '模型地址不能包含密码或查询参数');
    const id = randomUUID(), digest = createHash('sha256').update(JSON.stringify([target, payload, purpose])).digest('hex');
    let model = '';
    try {
        model = String(JSON.parse(payload).model ?? '');
    }
    catch { }
    const now = Date.now();
    run('INSERT INTO ai_request(id,owner,target,purpose,model,payload,digest,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)', [id, owner, target, purpose, model, payload, digest, new Date(now).toISOString(), new Date(now + 300000).toISOString()]);
    for (;;) {
        const row = get<PendingRequest>('SELECT * FROM ai_request WHERE id=?', [id]);
        if (!row || Date.now() >= Date.parse(row.expires_at)) {
            run("UPDATE ai_request SET state='expired',payload='' WHERE id=?", [id]);
            throw new ApiError('CONSENT_EXPIRED', '外发确认已超时，内容保留在原工作中，请重新发起。', 409);
        }
        if (row.state === 'approved') {
            const consumed = run("UPDATE ai_request SET state='sending',payload='' WHERE id=? AND state='approved' AND digest=? AND owner=?", [id, digest, owner]);
            if (consumed.changes)
                return id;
        }
        if (row.state !== 'pending') {
            run("UPDATE ai_request SET payload='' WHERE id=?", [id]);
            throw new ApiError('CONSENT_DENIED', '已取消本次外发，可以继续本地编辑。', 409);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
}
export function finishRequest(id: string, success: boolean): void {
    run("UPDATE ai_request SET state=? WHERE id=? AND state='sending'", [success ? 'sent' : 'failed', id]);
}
