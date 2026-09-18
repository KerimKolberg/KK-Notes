import { useEffect } from 'react';
import { selectIsDirty, useDocumentStore } from '../document/store';
import { actionExportPdf, actionNew, actionOpen, actionSave, actionSaveAs, actionToggleFullscreen, refreshRecent } from './fileActions';
import { saveDraft, setWindowTitle } from './fileService';
import { isTauri } from './tauri';

export const AUTOSAVE_DEBOUNCE_MS = 1500;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

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

  // Debounced autosave of dirty content.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useDocumentStore.subscribe((state, previous) => {
      if (state.document.pages === previous.document.pages && state.document.title === previous.document.title) return;
      if (!selectIsDirty(state)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const current = useDocumentStore.getState();
        if (selectIsDirty(current)) void saveDraft(current.document);
      }, AUTOSAVE_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Window title: "Title • — Notes".
  useEffect(() => {
    const apply = (): void => {
      const state = useDocumentStore.getState();
      const title = `${state.document.title || 'Untitled note'}${selectIsDirty(state) ? ' •' : ''} — Notes`;
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
