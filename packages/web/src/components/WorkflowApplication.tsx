import { useRef, useState } from 'react';
import { api } from '../api';
import { Button, Card, Field, Input } from '../ui';
import { useEditorGuard } from './NavigationGuard';
type Preview = {
    targetVersionId: number;
    versionNo: number;
    originalVersionId: number | null;
    digest: string;
    effectiveFrom: string;
    items: {
        key: string;
        label: string;
        allowed: boolean;
        reason: string;
        before: unknown;
        after: unknown;
    }[];
    history: {
        targetVersionId: number;
        createdAt: string;
        result: {
            applied: string[];
        };
    }[];
};
export function WorkflowApplication({ workbenchId, onApplied }: {
    workbenchId: number;
    onApplied: () => void;
}) {
    const [open, setOpen] = useState(false), [preview, setPreview] = useState<Preview | null>(null), [boundary, setBoundary] = useState(''), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false), [confirmed, setConfirmed] = useState(false), [success, setSuccess] = useState('');
    const lock = useRef(false), operation = useRef<string | null>(null);
    const reset = () => { setSelected([]); setConfirmed(false); operation.current = null; };
    const requestLeave = useEditorGuard({ dirty: open && (selected.length > 0 || !!boundary), busy, discard: () => { setOpen(false); reset(); setBoundary(''); } });
    const load = async () => { if (lock.current)
        return; lock.current = true; setBusy(true); setError(''); try {
        const p = await api.post<Preview>(`/api/workbenches/${workbenchId}/config-preview`, { effectiveFrom: boundary });
        setPreview(p);
        setSelected(old => old.filter(key => p.items.some(i => i.key === key && i.allowed)));
        setConfirmed(false);
        operation.current = null;
        setStale(false);
        setOpen(true);
    }
    catch (e) {
        setError((e as Error).message);
        setStale(true);
        setOpen(true);
    }
    finally {
        lock.current = false;
        setBusy(false);
    } };
    const apply = async () => { if (lock.current || !preview || stale || !confirmed || !selected.length)
        return; lock.current = true; setBusy(true); setError(''); operation.current ??= crypto.randomUUID(); try {
        await api.post(`/api/workbenches/${workbenchId}/config-apply`, { targetVersionId: preview.targetVersionId, previewDigest: preview.digest, effectiveFrom: preview.effectiveFrom, selected, operationId: operation.current });
        reset();
        setPreview(null);
        setBoundary('');
        setSuccess('所选范围已应用。整项工作仍保留原始来源，已有期次、定稿及文件未改动。');
        onApplied();
    }
    catch (e) {
        setError((e as Error).message);
        if (['STALE_PREVIEW', 'STALE_CONFIG', 'UNSAFE_SCOPE', 'OPERATION_CONFLICT', 'SCOPE_ORDER_CONFLICT'].includes((e as {
            code?: string;
        }).code ?? ''))
            setStale(true);
    }
    finally {
        lock.current = false;
        setBusy(false);
    } };
    return <Card title="流程配置更新"><p className="muted">先只读比较当前已发布版本，再选择可安全应用的范围。新增阶段为待开始；未来周期不补历史期次；不会自动办结或改写历史定稿。</p><Button disabled={busy} onClick={() => void load()}>{busy ? '正在处理，请稍候…' : '预览配置差异'}</Button>{success && <p role="status">{success}</p>}{error && <p role="alert" className="notice notice-err">{error}。未保存选择保留，请核对后重试；冲突时先重新预览。</p>}{open && <div className="col">{preview?.items.some(i => i.key === 'future-rule') && <Field label="未来规则生效期（仅周期工作需要）"><Input disabled={busy} value={boundary} placeholder="例如 2027-01 / 2027-Q1 / 2027" onChange={v => { setBoundary(v); setStale(true); setConfirmed(false); operation.current = null; }}/></Field>}<Button disabled={busy} onClick={() => void load()}>重新预览并保留可用选择</Button>{preview && <><p>目标发布版本 v{preview.versionNo}（#{preview.targetVersionId}）；原始来源：{preview.originalVersionId ?? '未知，保持未知'}。仅记录所选范围的部分应用。</p>{preview.items.length === 0 && <p>当前没有可应用的配置差异。</p>}{preview.items.map(item => <div key={item.key} className="notice"><label><input type="checkbox" disabled={busy || stale || !item.allowed} checked={selected.includes(item.key)} onChange={e => { setSelected(old => e.target.checked ? [...old, item.key] : old.filter(k => k !== item.key)); setConfirmed(false); operation.current = null; }}/>{item.label} · {item.allowed ? '可选择' : '不可应用'}</label><p>{item.reason}</p><details><summary>查看前后配置</summary><p>当前配置</p><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(item.before, null, 2)}</pre><p>目标配置</p><pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(item.after, null, 2)}</pre></details></div>)}<label><input type="checkbox" disabled={busy || stale || !selected.length} checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>我已核对所选范围，确认仅应用这些配置；配置说明不代表业务已实施或完成。</label><Button kind="primary" disabled={busy || stale || !confirmed || !selected.length} onClick={() => void apply()}>确认应用所选范围</Button>{preview.history.length > 0 && <details><summary>已应用的部分范围</summary>{preview.history.map((h, i) => <p key={i}>{h.createdAt} · 版本 #{h.targetVersionId} · {h.result.applied.join('、')}</p>)}</details>}</>}<Button disabled={busy} onClick={() => requestLeave(() => { setOpen(false); setPreview(null); setBoundary(''); reset(); })}>取消配置选择</Button></div>}</Card>;
}
