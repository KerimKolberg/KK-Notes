import { useEffect } from 'react';
import { selectIsDirty, useDocumentStore } from '../document/store';
import { actionExportPdf, actionNew, actionOpen, actionSave, actionSaveAs, actionToggleFullscreen, refreshRecent } from './fileActions';
import { isPenNearby } from '../inking/engine/gestureState';
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_RECHECK_MS, nextAutosaveStep } from './autosave';
import { saveDraft, setWindowTitle } from './fileService';
import { isTauri } from './tauri';
import { isEditableTarget } from '../lib/dom';

export { AUTOSAVE_DEBOUNCE_MS };

/**
 * Desktop shell glue for an *open document*: debounced autosave, window title
 * with dirty marker, File shortcuts, and WebView context-menu suppression
 * (Windows Ink press-and-hold would otherwise open it mid-stroke).
 *
 * Mounted with the document, so none of it is armed while the library is on
 * screen — there is nothing to autosave and no title to mark dirty.
 */
export function useDesktopIntegration(): void {
  // Startup — the file association and the draft restore — happens above the
  // router now (`useBoot`), because it decides *which view opens*: with the
  // library as the home screen this component is not even mounted at boot.
  useEffect(() => {
    void refreshRecent();
  }, []);

  // Debounced autosave of dirty content, put off while the pen is on the page.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let firstDueAt: number | null = null;
    const attempt = (): void => {
      timer = null;
      const now = performance.now();
      firstDueAt ??= now;
      const step = nextAutosaveStep({ penNearby: isPenNearby(now), deferredMs: now - firstDueAt });
      if (step === 'wait') {
        timer = setTimeout(attempt, AUTOSAVE_RECHECK_MS);
        return;
      }
      firstDueAt = null;
      const current = useDocumentStore.getState();
      if (selectIsDirty(current)) void saveDraft(current.document);
    };
    const unsubscribe = useDocumentStore.subscribe((state, previous) => {
      if (state.document.pages === previous.document.pages && state.document.title === previous.document.title) return;
      if (!selectIsDirty(state)) return;
      if (timer) clearTimeout(timer);
      // A new edit starts the wait, and the put-off, over.
      firstDueAt = null;
      timer = setTimeout(attempt, AUTOSAVE_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Window title: "Title • — Notes". Only when it changes: this runs for every change
  // to the document store — a page turned, a selection made — and each call is a trip
  // to the shell and a repaint of the caption, for a title that is nearly always the
  // one it already has.
  useEffect(() => {
    let last: string | null = null;
    const apply = (): void => {
      const state = useDocumentStore.getState();
      const title = `${state.document.title || 'Untitled note'}${selectIsDirty(state) ? ' •' : ''} — Notes`;
      if (title === last) return;
      last = title;
      void setWindowTitle(title);
    };
    apply();
    return useDocumentStore.subscribe(apply);
  }, []);

  // File shortcuts and (desktop) fullscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'F11') {
        e.preventDefault();
        void actionToggleFullscreen();
        return;
      }
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void (e.shiftKey ? actionSaveAs() : actionSave());
      } else if (key === 'o') {
        e.preventDefault();
        void actionOpen();
      } else if (key === 'n' && !e.shiftKey) {
        e.preventDefault();
        void actionNew();
      } else if (key === 'e' && !e.shiftKey) {
        e.preventDefault();
        void actionExportPdf();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Desktop: no default WebView context menu outside text fields.
  useEffect(() => {
    if (!isTauri()) return;
    const onContextMenu = (e: MouseEvent): void => {
      if (!isEditableTarget(e.target)) e.preventDefault();
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);
}
