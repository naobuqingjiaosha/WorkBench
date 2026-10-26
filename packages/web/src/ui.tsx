/** 基础 UI 组件（不引第三方库，保持轻量可控） */
import { useRef, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/* ------------------------------- 轻提示 ------------------------------- */

interface ToastItem {
  id: number;
  text: string;
  kind: 'ok' | 'err' | 'info';
}

const ToastCtx = createContext<(text: string, kind?: ToastItem['kind']) => void>(() => {});

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), kind === 'err' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

/* ------------------------------- 基础件 ------------------------------- */

export function Button({
  children,
  onClick,
  kind = 'default',
  size = 'md',
  disabled,
  title,
  type = 'button',
  block,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  block?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled || (children==='取消' && activeActions>0)}
      onClick={onClick}
      style={style}
      className={`btn btn-${kind} btn-${size}${block ? ' btn-block' : ''}`}
    >
      {children}
    </button>
  );
}

export function Card({
  title,
  extra,
  children,
  className = '',
  collapsible,
  defaultOpen=true,
  fill,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  collapsible?: boolean;
  defaultOpen?:boolean;
  /** 撑满父容器的剩余高度（父级需是 flex 列，见 .fill-height） */
  fill?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`card ${className}${fill ? ' card-fill' : ''}`}>
      {(title || extra) && (
        <header className="card-head">
          <h3 onClick={collapsible ? () => setOpen((o) => !o) : undefined} className={collapsible ? 'clickable' : ''}>
            {collapsible && <span className={`caret${open ? ' open' : ''}`}>▸</span>}
            {title}
          </h3>
          <div className="card-extra">{extra}</div>
        </header>
      )}
      {(!collapsible || open) && <div className="card-body">{children}</div>}
    </section>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {required && <em className="req">*</em>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  onEnter?: () => void;
}) {
  return (
    <input
      className="input"
      type={type}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
        onInput={type === 'date' ? (e) => onChange(e.currentTarget.value) : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) onEnter();
      }}
    />
  );
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 4,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
}) {
  return (
    <textarea
      className="input textarea"
      rows={rows}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <select className="input select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

let activeActions=0;

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const close=()=>{if(activeActions===0)onClose();};
  const dialogRef=useRef<HTMLDivElement>(null);
  const onCloseRef=useRef(onClose);onCloseRef.current=onClose;
  useEffect(() => {
    if (!open) return;
    const previous=document.activeElement as HTMLElement|null;
    const modal=dialogRef.current;
    modal?.focus();
    const onKey = (e: KeyboardEvent) => {
      if(document.querySelectorAll('[role="dialog"]').item(document.querySelectorAll('[role="dialog"]').length-1)!==modal)return;
      if (e.key === 'Escape' && activeActions===0) {e.stopImmediatePropagation();onCloseRef.current();}
      if(e.key==='Tab'&&modal){const targets=Array.from(modal.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')).filter(el=>el.getClientRects().length);const first=targets[0],last=targets.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===modal)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
    };
    window.addEventListener('keydown', onKey);
    return () => {window.removeEventListener('keydown', onKey);if(previous?.isConnected)previous.focus();};
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-mask" onClick={close}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={typeof title==='string'?title:undefined} className={`modal${wide ? ' modal-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={close} title="关闭">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tag({ children, kind = 'default' }: { children: ReactNode; kind?: 'default' | 'ok' | 'warn' | 'err' | 'info' }) {
  return <span className={`tag tag-${kind}`}>{children}</span>;
}

export function Empty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <p>{text}</p>
      {action}
    </div>
  );
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="loading" role="status" aria-live="polite">{text}</div>;
}

export function Bar({ value, max = 100, kind = 'primary' }: { value: number; max?: number; kind?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className={`bar bar-${kind}`}>
      <div className="bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** 让一个异步动作进入 loading 状态并统一报错 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const pending=useRef(false);
  const toast = useToast();
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
      if(pending.current)return undefined;pending.current=true;activeActions++;setBusy(true);
      try {
        const r = await fn();
        if (okText) toast(okText, 'ok');
        return r;
      } catch (e) {
        const err = e as { message?: string };
        toast(err?.message ?? '操作失败', 'err');
        return undefined;
      } finally {
        pending.current=false;activeActions--;setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

export function fmtSize(bytes?: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const STATUS_TEXT: Record<string, string> = {
  pending: '未开始',
  doing: '进行中',
  blocked: '受阻',
  done: '已完成',
  skipped: '不适用',
  active: '进行中',
  paused: '暂停',
  archived: '已归档',
  todo: '待办',
  na: '不适用',
};

export function statusKind(status: string): 'default' | 'ok' | 'warn' | 'err' | 'info' {
  switch (status) {
    case 'done':
    case 'active':
      return 'ok';
    case 'doing':
      return 'info';
    case 'blocked':
      return 'err';
    case 'skipped':
    case 'na':
    case 'archived':
      return 'default';
    default:
      return 'warn';
  }
}

/* ------------------------------ 排期显示 ------------------------------ */

/** 排期状态 → 徽标配色级别（对应 styles.css 的 .sched-* ） */
export function scheduleKind(s: {
  recurring: boolean;
  overdueDays: number;
  daysUntil: number | null;
  shouldRemind: boolean;
}): 'overdue' | 'due' | 'soon' | 'ok' {
  if (!s.recurring) return 'ok';
  if (s.overdueDays > 0) return 'overdue';
  if (s.daysUntil === 0) return 'due';
  return s.shouldRemind ? 'soon' : 'ok';
}

/** 排期状态 → 一句人话 */
export function scheduleText(s: {
  recurring: boolean;
  overdueDays: number;
  daysUntil: number | null;
}): string {
  if (!s.recurring || s.daysUntil === null) return '';
  if (s.overdueDays > 0) return `已逾期 ${s.overdueDays} 天`;
  if (s.daysUntil === 0) return '今天到期';
  return `还有 ${s.daysUntil} 天`;
}

export function useDebounced<T>(value: T, delay = 350): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export function useMounted(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

export { useMemo, useState, useEffect };
