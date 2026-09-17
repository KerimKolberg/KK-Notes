/**
 * File persistence with two backends: Tauri commands + native dialogs on the
 * desktop, downloads / file inputs / localStorage in a plain browser.
 */
import { downloadBytes, safeFilename } from '../pdf/download';
import type { Document } from '../document/types';
import { NOTEX_EXTENSION, NOTEX_MIME, encodeNotex, parseNotex, type ParsedNotex } from './notex';
import { isTauri, tauriDialog, tauriInvoke, tauriWindow } from './tauri';

export interface FileInfo {
  readonly path: string;
  readonly bytes: number;
  readonly modifiedMs: number | null;
}

export interface RecentFile {
  readonly path: string;
  readonly title: string;
  readonly openedMs: number;
}

interface OpenedDocumentPayload {
  readonly path: string;
  readonly contents: string;
  readonly info: FileInfo;
}

export interface OpenedDocument extends ParsedNotex {
  /** Native path, or `null` when opened from a browser file input. */
  readonly path: string | null;
}

const NOTEX_FILTERS = [{ name: 'Notes document', extensions: [NOTEX_EXTENSION, 'json'] }];
const PDF_FILTERS = [{ name: 'PDF document', extensions: ['pdf'] }];
const DRAFT_KEY = 'notes.autosave.draft';

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

/** Open a file picker in the browser; resolves `null` when cancelled. */
export function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.onchange = () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    };
    input.oncancel = () => {
      resolve(null);
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

function downloadText(text: string, filename: string, mime: string): void {
  downloadBytes(new TextEncoder().encode(text), filename, mime);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** Native "Save As" picker; `null` when cancelled or in a browser. */
export async function pickDocumentSavePath(title: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await tauriDialog();
  return save({ defaultPath: safeFilename(title, NOTEX_EXTENSION), filters: NOTEX_FILTERS });
}

/** Write the document to a known native path (atomic on the Rust side). */
export async function saveDocumentToPath(doc: Document, path: string): Promise<FileInfo> {
  return tauriInvoke<FileInfo>('save_document', { path, contents: encodeNotex(doc) });
}

/** Browser fallback: download the `.notex`. */
export function downloadDocument(doc: Document): void {
  downloadText(encodeNotex(doc), safeFilename(doc.title, NOTEX_EXTENSION), NOTEX_MIME);
}

export async function openDocumentFromPath(path: string): Promise<OpenedDocument> {
  const payload = await tauriInvoke<OpenedDocumentPayload>('open_document', { path });
  return { ...parseNotex(payload.contents), path: payload.path };
}

/** Native open dialog, or a browser file input; `null` when cancelled. */
export async function openDocumentWithPicker(): Promise<OpenedDocument | null> {
  if (isTauri()) {
    const { open } = await tauriDialog();
    const picked = await open({ multiple: false, directory: false, filters: NOTEX_FILTERS });
    if (typeof picked !== 'string') return null;
    return openDocumentFromPath(picked);
  }
  const file = await pickBrowserFile(`.${NOTEX_EXTENSION},.json,${NOTEX_MIME},application/json`);
  if (!file) return null;
  return { ...parseNotex(await file.text()), path: null };
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

/**
 * Export to PDF. Desktop: native "Save As" then the bytes go straight to disk
 * through the raw IPC body. Browser: download. Resolves the written path, or
 * `null` (browser / cancelled).
 */
export async function exportPdf(doc: Document): Promise<string | null> {
  const { exportDocumentToPdf } = await import('../pdf/export');
  if (isTauri()) {
    const { save } = await tauriDialog();
    const path = await save({ defaultPath: safeFilename(doc.title, 'pdf'), filters: PDF_FILTERS });
    if (!path) return null;
    const bytes = await exportDocumentToPdf(doc);
    await tauriInvoke<FileInfo>('write_binary_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
    return path;
  }
  const bytes = await exportDocumentToPdf(doc);
  downloadBytes(bytes, safeFilename(doc.title, 'pdf'));
  return null;
}

// ---------------------------------------------------------------------------
// Autosave drafts
// ---------------------------------------------------------------------------

export async function saveDraft(doc: Document): Promise<void> {
  const contents = encodeNotex(doc);
  if (isTauri()) {
    await tauriInvoke<FileInfo>('save_draft', { contents });
    return;
  }
  try {
    localStorage.setItem(DRAFT_KEY, contents);
  } catch {
    /* quota exceeded or storage disabled: drafts are best-effort */
  }
}

export async function loadDraft(): Promise<ParsedNotex | null> {
  if (isTauri()) {
    const payload = await tauriInvoke<OpenedDocumentPayload | null>('load_draft');
    return payload ? parseNotex(payload.contents) : null;
  }
  try {
    const text = localStorage.getItem(DRAFT_KEY);
    return text ? parseNotex(text) : null;
  } catch {
    return null;
  }
}

export async function clearDraft(): Promise<void> {
  if (isTauri()) {
    await tauriInvoke<void>('clear_draft');
    return;
  }
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Recent files (desktop only: browser files have no reopenable path)
// ---------------------------------------------------------------------------

export async function listRecent(): Promise<RecentFile[]> {
  if (!isTauri()) return [];
  return tauriInvoke<RecentFile[]>('list_recent');
}

export async function addRecent(path: string, title: string): Promise<RecentFile[]> {
  if (!isTauri()) return [];
  return tauriInvoke<RecentFile[]>('add_recent', { path, title });
}

export async function removeRecent(path: string): Promise<RecentFile[]> {
  if (!isTauri()) return [];
  return tauriInvoke<RecentFile[]>('remove_recent', { path });
}

// ---------------------------------------------------------------------------
// Window / startup
// ---------------------------------------------------------------------------

export async function getStartupFile(): Promise<string | null> {
  if (!isTauri()) return null;
  return (await tauriInvoke<string | null>('get_startup_file')) ?? null;
}

export async function setWindowTitle(title: string): Promise<void> {
  if (isTauri()) {
    const win = await tauriWindow();
    await win.setTitle(title);
  } else if (typeof document !== 'undefined') {
    document.title = title;
  }
}

/** Toggle fullscreen; resolves the new state, or `null` when unsupported. */
export async function toggleFullscreen(): Promise<boolean | null> {
  if (isTauri()) {
    const win = await tauriWindow();
    const next = !(await win.isFullscreen());
    await win.setFullscreen(next);
    return next;
  }
  if (typeof document === 'undefined' || !document.fullscreenEnabled) return null;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return false;
  }
  await document.documentElement.requestFullscreen();
  return true;
}

export async function confirmDiscard(message: string): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await tauriDialog();
    return ask(message, { title: 'Unsaved changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' });
  }
  return window.confirm(message);
}
