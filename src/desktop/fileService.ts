/**
 * File persistence with two backends: Tauri commands + native dialogs on the
 * desktop, downloads / file inputs / localStorage in a plain browser.
 */
import { downloadBytes, safeFilename } from '../pdf/download';
import type { Document } from '../document/types';
import type { FullscreenStyle } from '../preferences/types';
import { borderlessFrame, placementCorrection, type BorderlessFrame } from './borderless';
import { NOTEX_EXTENSION, NOTEX_MIME, encodeNotex, encodeNotexBytes, parseNotex, type ParsedNotex } from './notex';
import { isTauri, tauriDialog, tauriInvoke, tauriWindow } from './tauri';
import { errorMessage } from '../lib/errors';

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

const NOTEX_FILTERS = [{ name: 'KK-Notes document', extensions: [NOTEX_EXTENSION, 'json'] }];
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

/**
 * Native "Save As" picker; `null` when cancelled or in a browser. A note or a PDF, from the type list; a note whose file
 * is a PDF is offered as a PDF first.
 */
export async function pickDocumentSavePath(title: string, currentPath: string | null = null): Promise<string | null> {
  if (!isTauri()) return null;
  const { save } = await tauriDialog();
  const pdf = currentPath !== null && isPdfPath(currentPath);
  const path = await save({
    defaultPath: safeFilename(title, pdf ? 'pdf' : NOTEX_EXTENSION),
    filters: pdf ? [...PDF_FILTERS, ...NOTEX_FILTERS] : [...NOTEX_FILTERS, ...PDF_FILTERS],
  });
  if (path === null) return null;
  // A content URI with no name in it says nothing of the kind chosen: it is the kind that was offered first, which
  // is what Android made the file as (from the suggested name's extension).
  if (pdf && isContentUri(path) && !/\.(notex|json)$/i.test(path.split(/[?#]/)[0] ?? path)) rememberPdfPath(path);
  return withExtension(path, pdf ? 'pdf' : NOTEX_EXTENSION, [NOTEX_EXTENSION, 'json', 'pdf']);
}

/**
 * The path with `extension` put on if it has none of `known`. A name typed without one into a save dialog comes back
 * as typed on some platforms, and the shell writes only the app's own kinds of file (`ensure_kind`). A content URI
 * (Android) is no file name and is left as it is.
 */
export function withExtension(path: string, extension: string, known: readonly string[]): string {
  if (isContentUri(path)) return path;
  const name = path.split(/[\\/]/).pop() ?? path;
  const has = known.some((ext) => name.toLowerCase().endsWith(`.${ext.toLowerCase()}`));
  return has ? path : `${path}.${extension}`;
}

/**
 * Files known to be PDFs whatever their address looks like. On Android a file arrives as a `content://` URI that
 * often has no name in it at all (`…/document/1234`), and a PDF opened from one was taken for a note by its missing
 * extension: Save then wrote the note's JSON over the PDF. What a file *is* was known when it was opened or made, so
 * it is remembered here, for as long as the app runs, and the extension is only the answer for a path never seen.
 */
const knownPdfPaths = new Set<string>();

/** This path (or content URI) holds a PDF: it was opened as one, or is being saved as one. */
export function rememberPdfPath(path: string): void {
  knownPdfPaths.add(path);
}

/** Whether a note's file is a PDF rather than a `.notex`: one remembered as a PDF, or named as one. */
export function isPdfPath(path: string): boolean {
  return knownPdfPaths.has(path) || /\.pdf$/i.test(path.split(/[?#]/)[0] ?? path);
}

/**
 * Which version of each file the open notes came from: when the file was last changed, as of reading it or last
 * saving it. Sent with a save, so the shell can refuse to write over a file that something else has changed since
 * (sync bringing in what was written on another device while this note sat open; another app). By path, for as long
 * as the app runs: every tab's note is covered without each carrying it.
 */
const knownVersions = new Map<string, number>();

/** The file at `path` is, as of now, what the open note holds: it was just read into it or written from it. */
export function rememberFileVersion(info: Pick<FileInfo, 'path' | 'modifiedMs'> | null | undefined): void {
  if (info && typeof info.modifiedMs === 'number') knownVersions.set(info.path, info.modifiedMs);
}

/** A save refused because the file was changed by something else since the note was read from it. */
export class FileChangedError extends Error {
  constructor(readonly path: string) {
    super('The file was changed by something else since this note was opened');
    this.name = 'FileChangedError';
  }
}

/** How the shell's refusal begins (`commands.rs`, `CHANGED_ON_DISK`). */
const CHANGED_ON_DISK = 'changed-on-disk';

export interface SaveOptions {
  /** Write over a file changed by something else since it was read; what is replaced goes into the version history. */
  readonly replace?: boolean;
}

/** Write a note's file through the shell, saying which version of it the note came from. */
async function writeNoteFile(path: string, bytes: Uint8Array, { replace = false }: SaveOptions): Promise<FileInfo> {
  const expected = knownVersions.get(path);
  const headers: Record<string, string> = { 'x-path': encodeURIComponent(path) };
  if (replace) headers['x-replace'] = '1';
  else if (expected !== undefined) headers['x-expected-modified'] = String(expected);
  let info: FileInfo;
  try {
    info = await tauriInvoke<FileInfo>('save_document', bytes, { headers });
  } catch (error) {
    if (String(errorMessage(error)).startsWith(CHANGED_ON_DISK)) throw new FileChangedError(path);
    throw error;
  }
  rememberFileVersion(info);
  return info;
}

/**
 * Save the note as the PDF at `path`: its pages as any reader shows them, and the note inside, so it opens here again
 * with its ink editable (`pdf/embeddedNote.ts`). What was at `path` is kept in the version history first, as a note's
 * file is.
 */
export async function savePdfToPath(doc: Document, path: string, options: SaveOptions = {}): Promise<FileInfo> {
  const { exportDocumentToPdf } = await import('../pdf/export');
  const bytes = await exportDocumentToPdf(doc, { note: encodeNotexBytes(doc) });
  if (isContentUri(path)) {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, bytes);
    return { path, bytes: bytes.byteLength, modifiedMs: Date.now() };
  }
  return writeNoteFile(path, bytes, options);
}

/**
 * Write the document to a known native path (atomic on the Rust side).
 *
 * The file goes over as bytes, the IPC body, as an exported PDF does (`writeBinary`): sent as a JSON string it
 * would be escaped and copied again on its way, which for a note with a textbook or a lecture recording in it is
 * hundreds of milliseconds on every save. A SAF content URI takes the fs plugin: it is not a path, and the native
 * writer cannot open one.
 */
export async function saveDocumentToPath(doc: Document, path: string, options: SaveOptions = {}): Promise<FileInfo> {
  const bytes = encodeNotexBytes(doc);
  if (isContentUri(path)) {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, bytes);
    return { path, bytes: bytes.byteLength, modifiedMs: Date.now() };
  }
  return writeNoteFile(path, bytes, options);
}

/** Browser fallback: download the `.notex`. */
export function downloadDocument(doc: Document): void {
  downloadText(encodeNotex(doc), safeFilename(doc.title, NOTEX_EXTENSION), NOTEX_MIME);
}

export async function openDocumentFromPath(path: string): Promise<OpenedDocument> {
  const payload = await tauriInvoke<OpenedDocumentPayload>('open_document', { path });
  rememberFileVersion(payload.info);
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
/**
 * A path handed back by Android's Storage Access Framework.
 *
 * On Android the save dialog does not return a filesystem path at all: it
 * returns a `content://` URI for a document the user picked, whose bytes are
 * reachable only through the platform's ContentResolver. Everything that
 * treats it as a path — `std::fs`, and the temp-file-plus-rename the native
 * writer uses — either fails or, worse, quietly creates a file *named* after
 * the URI, which is what made every exported PDF unopenable.
 */
export function isContentUri(path: string): boolean {
  return /^content:\/\//i.test(path);
}

/**
 * Write raw bytes to wherever the save dialog pointed.
 *
 * Two routes, because there are two kinds of destination. A real filesystem
 * path goes to the native command, which sends the bytes as the IPC body —
 * no base64, no array-of-numbers JSON — and writes them atomically. A SAF
 * content URI goes through the fs plugin, which is the only thing on Android
 * that knows how to open one; `writeFile` takes a `Uint8Array` directly, so
 * the bytes stay bytes there too.
 */
export async function writeBinary(path: string, bytes: Uint8Array): Promise<void> {
  if (isContentUri(path)) {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(path, bytes);
    return;
  }
  await tauriInvoke<FileInfo>('write_binary_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
}

export async function exportPdf(doc: Document): Promise<string | null> {
  const { exportDocumentToPdf } = await import('../pdf/export');
  if (isTauri()) {
    const { save } = await tauriDialog();
    // The `.pdf` extension on both the suggested name and the filter is what
    // Android turns into the `application/pdf` MIME of the CREATE_DOCUMENT
    // intent; without it the file is created as `application/octet-stream`
    // and nothing on the device offers to open it.
    const picked = await save({ defaultPath: safeFilename(doc.title, 'pdf'), filters: PDF_FILTERS });
    if (!picked) return null;
    const path = withExtension(picked, 'pdf', ['pdf']);
    const bytes = await exportDocumentToPdf(doc);
    await writeBinary(path, bytes);
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
  if (isTauri()) {
    await tauriInvoke<FileInfo>('save_draft', encodeNotexBytes(doc));
    return;
  }
  try {
    localStorage.setItem(DRAFT_KEY, encodeNotex(doc));
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

/** What to put back when leaving the borderless window. */
interface BorderlessRestore {
  readonly wasMaximized: boolean;
  readonly position: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
}

let borderless: BorderlessRestore | null = null;

async function enterBorderless(win: Awaited<ReturnType<typeof tauriWindow>>): Promise<BorderlessRestore | null> {
  const { currentMonitor } = await import('@tauri-apps/api/window');
  const monitor = await currentMonitor();
  const frame = monitor ? borderlessFrame(monitor) : null;
  if (!frame) return null;
  // The inside's size, since that is what `setSize` sets: the outside's would grow the window by its frame each time.
  const [wasMaximized, position, size] = await Promise.all([win.isMaximized(), win.outerPosition(), win.innerSize()]);
  // A maximised window ignores being placed, so it stops being one first.
  if (wasMaximized) await win.unmaximize();
  await win.setDecorations(false);
  // Without it Windows 11 gives the window a thin border and rounded corners, as a window rather than a screen.
  await win.setShadow(false).catch(() => {});
  await place(win, frame);
  return { wasMaximized, position: { x: position.x, y: position.y }, size: { width: size.width, height: size.height } };
}

/**
 * Put the window's inside exactly on `frame`: placed, read back, and moved by what it came out off by
 * (`placementCorrection` — Windows counts an invisible frame round the window in its position). A few rounds at most,
 * a moment apart, since the title bar going takes effect on the window's own time.
 */
async function place(win: Awaited<ReturnType<typeof tauriWindow>>, frame: BorderlessFrame): Promise<void> {
  const { PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/dpi');
  await win.setPosition(new PhysicalPosition(frame.x, frame.y));
  await win.setSize(new PhysicalSize(frame.width, frame.height));
  for (let round = 0; round < 3; round++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const [outer, inner, innerSize] = await Promise.all([win.outerPosition(), win.innerPosition(), win.innerSize()]);
    const fix = placementCorrection(frame, { outer, inner, innerSize });
    if (!fix) return;
    if (fix.size) await win.setSize(new PhysicalSize(frame.width, frame.height));
    if (fix.position) await win.setPosition(new PhysicalPosition(fix.position.x, fix.position.y));
  }
}

async function leaveBorderless(win: Awaited<ReturnType<typeof tauriWindow>>, restore: BorderlessRestore): Promise<void> {
  const { PhysicalPosition, PhysicalSize } = await import('@tauri-apps/api/dpi');
  await win.setDecorations(true);
  await win.setShadow(true).catch(() => {});
  if (restore.wasMaximized) {
    await win.maximize();
    return;
  }
  await win.setSize(new PhysicalSize(restore.size.width, restore.size.height));
  await win.setPosition(new PhysicalPosition(restore.position.x, restore.position.y));
}

/**
 * Toggle fullscreen; resolves the new state, or `null` when unsupported.
 *
 * On the desktop the `style` decides how: `window` takes the title bar off and fills the work area
 * (see `borderless.ts`), the taskbar staying; `screen` is the platform's fullscreen, over the taskbar
 * too, in which the mouse pointer lags on some PCs. The platform's is also the fallback for a monitor
 * that reports nothing about itself. Whichever is on is the one turned off, whatever the setting says
 * by then.
 */
export async function toggleFullscreen(style: FullscreenStyle = 'window'): Promise<boolean | null> {
  if (isTauri()) {
    const win = await tauriWindow();
    if (borderless) {
      const restore = borderless;
      borderless = null;
      await leaveBorderless(win, restore);
      return false;
    }
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
      return false;
    }
    if (style === 'window') {
      const restore = await enterBorderless(win);
      if (restore) {
        borderless = restore;
        return true;
      }
      // A monitor that tells us nothing about itself: the platform's fullscreen it is.
    }
    await win.setFullscreen(true);
    return true;
  }
  if (typeof document === 'undefined' || !document.fullscreenEnabled) return null;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return false;
  }
  await document.documentElement.requestFullscreen();
  return true;
}

/** Ask whether to write over a file that something else changed while its note was open. */
export async function confirmReplaceChangedFile(path: string): Promise<boolean> {
  const message =
    `"${path.split(/[\\/]/).pop() ?? path}" was changed by something else since you opened it ` +
    '(sync from another device, or another app). Saving now replaces that version with what is on screen. ' +
    'The replaced version is kept in the version history. To keep both, cancel and use Save As.';
  if (isTauri()) {
    const { ask } = await tauriDialog();
    return ask(message, { title: 'This note changed on disk', kind: 'warning', okLabel: 'Replace it', cancelLabel: 'Cancel' });
  }
  return window.confirm(message);
}

export async function confirmDiscard(message: string): Promise<boolean> {
  if (isTauri()) {
    const { ask } = await tauriDialog();
    return ask(message, { title: 'Unsaved changes', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Cancel' });
  }
  return window.confirm(message);
}
