import { useEffect } from 'react';
import { selectIsDirty, useDocumentStore } from '../document/store';
import { useDesktopStore } from './desktopStore';
import { actionExportPdf, actionNew, actionOpen, actionOpenPath, actionSave, actionSaveAs, actionToggleFullscreen, refreshRecent } from './fileActions';
import { clearDraft, getStartupFile, loadDraft, saveDraft, setWindowTitle } from './fileService';
import { isTauri } from './tauri';

export const AUTOSAVE_DEBOUNCE_MS = 1500;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/**
 * Desktop shell glue: startup file / draft restore, debounced autosave,
 * window title with dirty marker, File shortcuts, and WebView context-menu
 * suppression (Windows Ink press-and-hold would otherwise open it mid-stroke).
 */
export function useDesktopIntegration(): void {
  // Startup: a file association argument wins; otherwise offer the autosaved draft.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const startup = await getStartupFile();
        if (cancelled) return;
        if (startup) {
          await actionOpenPath(startup);
          return;
        }
        const draft = await loadDraft();
        if (cancelled || !draft) return;
        const store = useDocumentStore.getState();
        if (selectIsDirty(store)) return; // the user already started working
        store.loadDocument(draft.document, null);
        // A restored draft is unsaved work: mark it dirty so Save / autosave stay armed.
        useDocumentStore.setState({ savedPages: null, savedTitle: null });
        useDesktopStore.getState().setNotice({
          text: draft.savedAt ? `Restored autosaved draft from ${new Date(draft.savedAt).toLocaleString()}` : 'Restored autosaved draft',
          action: {
            label: 'Discard',
            run: () => {
              useDocumentStore.getState().newDocument();
              void clearDraft();
              useDesktopStore.getState().setNotice(null);
            },
          },
        });
      } catch {
        /* no draft / startup file */
      }
    })();
    void refreshRecent();
    return () => {
      cancelled = true;
    };
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
