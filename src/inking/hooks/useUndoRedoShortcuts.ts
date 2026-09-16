import { useEffect } from 'react';
import { useLatestRef } from './useLatestRef';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

/** Ctrl/⌘+Z → undo, Ctrl/⌘+Shift+Z or Ctrl+Y → redo. */
export function useUndoRedoShortcuts(undo: () => void, redo: () => void, enabled = true): void {
  const undoRef = useLatestRef(undo);
  const redoRef = useLatestRef(redo);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (isTextEntryTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoRef.current();
        else undoRef.current();
      } else if (key === 'y' && e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        redoRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, undoRef, redoRef]);
}
