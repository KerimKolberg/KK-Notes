import { useEffect } from 'react';
import { selectIsDirty, useDocumentStore } from '../document/store';
import { actionExportPdf, actionNew, actionOpen, actionSave, actionSaveAs, actionToggleFullscreen, refreshRecent, saveToOwnFile } from './fileActions';
import { isPenNearby } from '../inking/engine/gestureState';
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_RECHECK_MS, hiddenSaveStep, nextAutosaveStep } from './autosave';
import { useDesktopStore } from './desktopStore';
import { isPdfPath, saveDraft, setWindowTitle } from './fileService';
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

  // The app going out of sight is the last moment it can count on. Android may end a backgrounded app without a
  // word, and a window closed to the tray may not come back before the PC is shut down. So unsaved writing is put
  // away then, not a second and a half later: into the note's own file where it has one (what going Home does, and
  // as quietly), else into the crash draft.
  useEffect(() => {
    const putAway = (): void => {
      if (document.visibilityState !== 'hidden') return;
      const state = useDocumentStore.getState();
      if (!selectIsDirty(state)) return;
      const step = hiddenSaveStep({ native: isTauri(), filePath: state.filePath, isPdf: state.filePath !== null && isPdfPath(state.filePath), busy: useDesktopStore.getState().busy !== null });
      if (step === 'file') {
        // A file that will not take it (changed by sync meanwhile, read-only) leaves the draft to hold the work.
        void saveToOwnFile().then((failure) => (failure === null ? undefined : saveDraft(state.document)));
      } else {
        void saveDraft(state.document);
      }
    };
    document.addEventListener('visibilitychange', putAway);
    return () => document.removeEventListener('visibilitychange', putAway);
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
      // Taken already: Ctrl+E in a text box centres the paragraph rather than exporting.
      if (e.defaultPrevented) return;
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
