/**
 * File menu actions. Plain async functions over the stores so the menu,
 * keyboard shortcuts and startup logic share one implementation.
 */
import { documentOfPages } from '../document/operations';
import { selectIsDirty, useDocumentStore } from '../document/store';
import { usePreferencesStore } from '../preferences/store';
import { useDesktopStore } from './desktopStore';
import {
  addRecent,
  clearDraft,
  confirmDiscard,
  downloadDocument,
  exportPdf,
  isPdfPath,
  listRecent,
  openDocumentFromPath,
  openDocumentWithPicker,
  pickDocumentSavePath,
  removeRecent,
  saveDocumentToPath,
  savePdfToPath,
  toggleFullscreen,
} from './fileService';
import { titleFromFileName } from './notex';
import { isTauri } from './tauri';
import { errorMessage } from '../lib/errors';

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
    if (isPdfPath(path)) {
      // A PDF from the recent list, or saved as one: opened as a PDF is anywhere else (`boot.ts`).
      const { importPdfAsDocument } = await import('./boot');
      await importPdfAsDocument(path);
    } else {
      const opened = await openDocumentFromPath(path);
      const doc = opened.document.title ? opened.document : { ...opened.document, title: titleFromFileName(path) };
      useDocumentStore.getState().loadDocument(doc, path);
    }
    const doc = useDocumentStore.getState().document;
    await clearDraft();
    useDesktopStore.getState().setRecent(await addRecent(path, doc.title));
    desktop.setNotice(null);
  } catch (err) {
    notify(`Could not open ${path}: ${errorMessage(err)}`);
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
    notify(`Could not open the document: ${errorMessage(err)}`);
  } finally {
    useDesktopStore.getState().setBusy(null);
  }
}

/**
 * Write the note to `path` in the file's own format: a `.notex`, or a PDF with what was written on it (and the note
 * inside it, so it opens here again editable). The note is then that file's.
 */
async function writeTo(path: string): Promise<void> {
  const doc = useDocumentStore.getState().document;
  if (isPdfPath(path)) {
    useDesktopStore.getState().setBusy('export');
    useDocumentStore.getState().setExporting(true);
    try {
      await savePdfToPath(doc, path);
    } finally {
      useDocumentStore.getState().setExporting(false);
    }
  } else {
    await saveDocumentToPath(doc, path);
  }
  // What was written, not what is on screen now: a stroke drawn while a PDF was being made is not in it.
  useDocumentStore.getState().markSaved(path, doc);
  await clearDraft();
  useDesktopStore.getState().setRecent(await addRecent(path, doc.title));
}

/**
 * Save to the note's file, as it is and where it is — a PDF opened here is written back as that PDF — or, for a note
 * with no file yet, Save As, which asks where, what name and which format. Resolves true when saved.
 */
export async function actionSave(): Promise<boolean> {
  const { filePath } = useDocumentStore.getState();
  if (!filePath || !isTauri()) return actionSaveAs();
  // A save already under way (a large PDF takes a moment) is the save: a second Ctrl+S must not start another
  // write of the same file beside it.
  if (useDesktopStore.getState().busy) return false;
  const failure = await saveToOwnFile();
  if (failure === null) return true;
  // A file that cannot be written back (on Android, one another app only lent to read) is saved somewhere else.
  notify(`Could not save to ${filePath}: ${failure}. Choose where to save it.`);
  return actionSaveAs();
}

/**
 * Write the note to the file it already has and nothing else: no dialog. `null` when it is saved, or why it is not
 * (no file, or the write failed), for the caller to decide what follows: Save offers Save As, leaving the note asks.
 */
export async function saveToOwnFile(): Promise<string | null> {
  const { filePath } = useDocumentStore.getState();
  if (!filePath) return 'This note has no file yet';
  useDesktopStore.getState().setBusy('save');
  try {
    await writeTo(filePath);
    return null;
  } catch (err) {
    return errorMessage(err);
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
    const path = await pickDocumentSavePath(doc.title, useDocumentStore.getState().filePath);
    if (!path) return false;
    // Either format becomes the note's file: a note saved as a PDF is saved there again by Save.
    await writeTo(path);
    return true;
  } catch (err) {
    notify(`Save failed: ${errorMessage(err)}`);
    return false;
  } finally {
    useDesktopStore.getState().setBusy(null);
  }
}

/** Export the note as a PDF, or only the pages at `pageIndices` (the arranger's picked pages). */
export async function actionExportPdf(pageIndices?: readonly number[]): Promise<void> {
  const desktop = useDesktopStore.getState();
  if (desktop.busy) return;
  desktop.setBusy('export');
  useDocumentStore.getState().setExporting(true);
  try {
    const doc = useDocumentStore.getState().document;
    const path = await exportPdf(pageIndices && pageIndices.length > 0 ? documentOfPages(doc, pageIndices) : doc);
    if (path) notify(`Exported PDF to ${path}`);
  } catch (err) {
    notify(`Export failed: ${errorMessage(err)}`);
  } finally {
    useDocumentStore.getState().setExporting(false);
    useDesktopStore.getState().setBusy(null);
  }
}

export async function actionToggleFullscreen(): Promise<void> {
  try {
    const state = await toggleFullscreen(usePreferencesStore.getState().fullscreenStyle);
    if (state !== null) useDesktopStore.getState().setFullscreen(state);
  } catch {
    /* unsupported */
  }
}

/** The fullscreen style changed while fullscreen was on: out of the one that is on, into the one chosen. */
export async function actionRestyleFullscreen(): Promise<void> {
  if (!useDesktopStore.getState().fullscreen) return;
  await actionToggleFullscreen();
  await actionToggleFullscreen();
}
