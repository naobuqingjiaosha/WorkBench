import {useRef, useState} from 'react';
import {useEditorGuard} from './NavigationGuard';
import {useToast} from '../ui';
export function useDirtyClose(dirty: boolean, onClose: () => void) {
  const request=useEditorGuard({dirty});
  return ()=>request(onClose);
}
/** 仅在编辑值确实变化时提示；保存成功仍直接调用 onSaved。 */
export function useUnsavedClose(value: unknown, onClose: () => void) {
  const initial = useRef(JSON.stringify(value));
  return useDirtyClose(JSON.stringify(value)!==initial.current,onClose);
}

/** The toolbar and the leave dialog await the same write. A rejected write keeps the editor open. */
export function useModalSave(dirty: boolean, persist: () => Promise<void>, onClose: () => void, otherBusy = false) {
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const save = async () => {
    if (pending.current || otherBusy) throw Error('正在处理，请稍候');
    pending.current = true;
    setSaving(true);
    try { await persist(); }
    finally { pending.current = false; setSaving(false); }
  };
  const busy = saving || otherBusy;
  const request = useEditorGuard({dirty, busy, save}, 'editor');
  return {
    busy,
    close: () => { if (!busy) request(onClose); },
    save: () => { void save().catch(e => toast((e as Error).message, 'err')); },
  };
}
