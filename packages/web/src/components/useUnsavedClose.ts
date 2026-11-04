import {useRef} from 'react';
import {useEditorGuard} from './NavigationGuard';
export function useDirtyClose(dirty: boolean, onClose: () => void) {
  const request=useEditorGuard({dirty});
  return ()=>request(onClose);
}
/** 仅在编辑值确实变化时提示；保存成功仍直接调用 onSaved。 */
export function useUnsavedClose(value: unknown, onClose: () => void) {
  const initial = useRef(JSON.stringify(value));
  return useDirtyClose(JSON.stringify(value)!==initial.current,onClose);
}
