/**
 * File menu actions. Plain async functions over the stores so the menu,
 * keyboard shortcuts and startup logic share one implementation.
 */
import { selectIsDirty, useDocumentStore } from '../document/store';
import { useDesktopStore } from './desktopStore';
import {
  addRecent,
  clearDraft,
  confirmDiscard,
  downloadDocument,
  exportPdf,
  listRecent,
  openDocumentFromPath,
  openDocumentWithPicker,
  pickDocumentSavePath,
  removeRecent,
  saveDocumentToPath,
  toggleFullscreen,
} from './fileService';
import { titleFromFileName } from './notex';
import { isTauri } from './tauri';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notify(text: string, action?: { label: string; run: () => void }): void {
  useDesktopStore.getState().setNotice(action ? { text, action } : { text });
}

/**
 * True when it is safe to replace what is on screen.
 *
 * Exported because "open with" needs the same guard: an intent from a file
 * manager is explicit, but so is the unsaved page already in front of the
 * user.
 */
export async function confirmDiscardIfDirty(): Promise<boolean> {
  if (!selectIsDirty(useDocumentStore.getState())) return true;
  return confirmDiscard('This document has unsaved changes. Discard them?');
}

const guardDirty = confirmDiscardIfDirty;

export async function refreshRecent(): Promise<void> {
  if (!isTauri()) return;
  try {
    useDesktopStore.getState().setRecent(await listRecent());
  } catch {
    /* recents are best-effort */
  }
}

export async function actionNew(): Promise<void> {
  if (!(await guardDirty())) return;
  useDocumentStore.getState().newDocument();
  await clearDraft();
  useDesktopStore.getState().setNotice(null);
}

export async function actionOpenPath(path: string): Promise<void> {
  const desktop = useDesktopStore.getState();
  desktop.setBusy('open');
  try {
    const opened = await openDocumentFromPath(path);
    const doc = opened.document.title ? opened.document : { ...opened.document, title: titleFromFileName(path) };
    useDocumentStore.getState().loadDocument(doc, path);
    await clearDraft();
    useDesktopStore.getState().setRecent(await addRecent(path, doc.title));
    desktop.setNotice(null);
  } catch (err) {
    notify(`Could not open ${path}: ${describeError(err)}`);
    try {
      useDesktopStore.getState().setRecent(await removeRecent(path));
    } catch {
      /* ignore */
    }
  } finally {
    useDesktopStore.getState().setBusy(null);
  }
}

export async function actionOpen(): Promise<void> {
  if (!(await guardDirty())) return;
  const desktop = useDesktopStore.getState();
  desktop.setBusy('open');
  try {
    const opened = await openDocumentWithPicker();
    if (!opened) return;
    useDocumentStore.getState().loadDocument(opened.document, opened.path);
    await clearDraft();
    if (opened.path) useDesktopStore.getState().setRecent(await addRecent(opened.path, opened.document.title));
    desktop.setNotice(null);
  } catch (err) {
    notify(`Could not open the document: ${describeError(err)}`);
  } finally {
    useDesktopStore.getState().setBusy(null);
  }
}

/** Save to the current path, or fall through to Save As. Resolves true when saved. */
export async function actionSave(): Promise<boolean> {
  const { filePath } = useDocumentStore.getState();
  if (!filePath || !isTauri()) return actionSaveAs();
  const desktop = useDesktopStore.getState();
  desktop.setBusy('save');
  try {
    const doc = useDocumentStore.getState().document;
    await saveDocumentToPath(doc, filePath);
    useDocumentStore.getState().markSaved(filePath);
    await clearDraft();
    useDesktopStore.getState().setRecent(await addRecent(filePath, doc.title));
    return true;
  } catch (err) {
    notify(`Save failed: ${describeError(err)}`);
    return false;
  } finally {
    useDesktopStore.getState().setBusy(null);
  }
}

export async function actionSaveAs(): Promise<boolean> {
  const desktop = useDesktopStore.getState();
  desktop.setBusy('save');
  try {
    const doc = useDocumentStore.getState().document;
    if (!isTauri()) {
      // Browser: a download is the only "save"; the in-memory state stays authoritative.
      downloadDocument(doc);
      useDocumentStore.getState().markSaved();
      return true;
    }
    const path = await pickDocumentSavePath(doc.title);
    if (!path) return false;
    await saveDocumentToPath(doc, path);
    useDocumentStore.getState().markSaved(path);
    await clearDraft();
    useDesktopStore.getState().setRecent(await addRecent(path, doc.title));
    return true;
  } catch (err) {
    notify(`Save failed: ${describeError(err)}`);
    return false;
  } finally {
    useDesktopStore.getState().setBusy(null);
  }
}

export async function actionExportPdf(): Promise<void> {
  const desktop = useDesktopStore.getState();
  if (desktop.busy) return;
  desktop.setBusy('export');
  useDocumentStore.getState().setExporting(true);
  try {
    const path = await exportPdf(useDocumentStore.getState().document);
    if (path) notify(`Exported PDF to ${path}`);
  } catch (err) {
    notify(`Export failed: ${describeError(err)}`);
  } finally {
    useDocumentStore.getState().setExporting(false);
    useDesktopStore.getState().setBusy(null);
  }
}

export async function actionToggleFullscreen(): Promise<void> {
  try {
    const state = await toggleFullscreen();
    if (state !== null) useDesktopStore.getState().setFullscreen(state);
  } catch {
    /* unsupported */
  }
}
