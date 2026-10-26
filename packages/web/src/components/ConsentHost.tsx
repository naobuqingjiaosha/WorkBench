import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Modal } from '../ui';
interface Request {
    id: string;
    target: string;
    purpose: string;
    model: string;
    payload: string;
    digest: string;
    expires_at: string;
}
export default function ConsentHost() {
    const [items, setItems] = useState<Request[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => { let live = true; const load = () => api.get<{
        items: Request[];
    }>('/api/ai/requests').then(r => { if (live)
        setItems(r.items); }).catch(() => { }); void load(); const timer = setInterval(load, 1000); return () => { live = false; clearInterval(timer); }; }, []);
    const r = items[0];
    if (!r)
        return null;
    const decide = async (approve: boolean) => { setBusy(true); setError(''); try {
        await api.post('/api/ai/consents', { id: r.id, digest: r.digest, approve });
        setItems(x => x.filter(i => i.id !== r.id));
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } };
    let preview = r.payload;
    let businessSources:{title:string;status:string}[]=[];
    const pictures: string[] = [];
    try {
        preview = JSON.stringify(JSON.parse(r.payload), (key, value) => { if (key === 'url' && typeof value === 'string' && value.startsWith('data:image/')) {
            pictures.push(value);
            return `[图片 ${pictures.length}，下方预览]`;
        } return value; }, 2);
    }
    catch { }
    try {for(const message of JSON.parse(r.payload).messages??[]){if(typeof message.content!=='string')continue;try{const data=JSON.parse(message.content);if(Array.isArray(data.sourceManifest))businessSources=data.sourceManifest;}catch{}}}catch{}
    return <div style={{ position: 'relative', zIndex: 10000 }}><Modal open wide title="本次模型外发确认" onClose={() => { if (!busy)
        void decide(false); }}>
  <p>用途：{r.purpose} · 模型：{r.model || '模型列表'}</p><p>目标：{r.target}</p>
  {businessSources.length>0&&<div className="notice notice-warn"><strong>本次涉及的业务资料</strong><p>可能包含内部工作状态、项目及供应商信息、检查结果、会议记录或合同摘录，请核对下方实际内容后决定。</p><ul>{businessSources.map((s,i)=><li key={i}>{s.title}（{s.status}）</li>)}</ul></div>}
  <p>以下是即将发送的完整请求内容。只授权本次请求，后续新增资料会再次确认。五分钟未确认自动取消。</p>
  <pre style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{preview || '无正文'}</pre>
  {pictures.map((p, i) => <img key={i} src={p} alt={`发送图片 ${i + 1}`} style={{ maxWidth: '100%', maxHeight: 250 }}/>)}
  {error && <p role="alert">{error}</p>}<div className="row"><Button disabled={busy} onClick={() => void decide(false)}>拒绝发送</Button><Button disabled={busy} onClick={() => void decide(true)}>允许本次发送</Button></div>
 </Modal></div>;
}
