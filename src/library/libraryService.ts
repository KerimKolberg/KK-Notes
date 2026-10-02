/**
 * The library, over whichever backend is present.
 *
 * On the desktop every call is an IPC command answered by the `notes-sync`
 * crate; in a plain browser the same calls fall through to a `localStorage`
 * library. Callers never branch on which — that is the whole point of the
 * layer — except for sync, which is honestly unavailable in a browser and
 * reports `offline` rather than pretending.
 */
import { isTauri, tauriInvoke } from '../desktop/tauri';
import { encodeNotex } from '../desktop/notex';
import { createDocument } from '../document/operations';
import {
  BROWSER_ROOT,
  createBrowserFolder,
  deleteBrowserEntry,
  listBrowserLibrary,
  moveBrowserEntry,
  readBrowserDocument,
  writeBrowserDocument,
} from './browserLibrary';
import type { DocumentText, PdfPagePiece } from './search';
import { OFFLINE_STATUS, type ConflictResolution, type LibraryListing, type LibrarySort, type SyncStatus, type ThumbnailSource } from './types';

export async function listLibrary(path: string | null, sort: LibrarySort): Promise<LibraryListing> {
  if (!isTauri()) return listBrowserLibrary(path, sort.key, sort.order);
  return tauriInvoke<LibraryListing>('list_library', {
    path,
    sortKey: sort.key,
    sortOrder: sort.order,
  });
}

export async function createFolder(parent: string | null, name: string): Promise<string> {
  if (!isTauri()) return createBrowserFolder(parent, name);
  return tauriInvoke<string>('create_library_folder', { parent, name });
}

/** Put a fresh, empty document in the library and return its path. */
export async function createDocumentInLibrary(parent: string | null, name: string): Promise<string> {
  const contents = encodeNotex({ ...createDocument(1), title: name });
  if (!isTauri()) return writeBrowserDocument(parent, name, contents);
  return tauriInvoke<string>('create_library_document', { parent, name, contents });
}

export async function moveEntry(from: string, into: string | null): Promise<string> {
  if (!isTauri()) return moveBrowserEntry(from, into);
  return tauriInvoke<string>('move_library_entry', { from, into });
}

export async function deleteEntry(path: string): Promise<void> {
  if (!isTauri()) {
    deleteBrowserEntry(path);
    return;
  }
  await tauriInvoke<void>('delete_library_entry', { path });
}

/**
 * A document's title, page count and *first page* — never the document.
 *
 * On the desktop this is read by a streaming parser that keeps page one and
 * walks past everything else, so drawing a hundred cards does not mean
 * holding a hundred notebooks. The browser fallback has to parse what it
 * stored, but it only keeps the first page from the result for the same
 * reason.
 */
export async function readThumbnailSource(path: string): Promise<ThumbnailSource> {
  if (!isTauri()) {
    const text = readBrowserDocument(path);
    if (text === null) throw new Error('That document is no longer in the library.');
    const parsed: unknown = JSON.parse(text);
    const envelope = parsed as { savedAt?: string; document?: { title?: string; pages?: unknown[] } };
    const document = envelope.document ?? (parsed as { title?: string; pages?: unknown[] });
    const pages = Array.isArray(document.pages) ? document.pages : [];
    return {
      title: document.title?.trim() || 'Untitled note',
      pageCount: pages.length,
      page: pages[0] ?? null,
      savedAt: envelope.savedAt ?? null,
    };
  }
  return tauriInvoke<ThumbnailSource>('read_document_thumbnail', { path });
}

/**
 * A document's title and the typed text in it, for searching the whole library.
 *
 * On the desktop the Rust side reads only the words out of the file (ink, images and imported PDFs
 * are walked past, not held), and which of its pages are made from which page of which PDF; the words of
 * those are read separately, once. The browser fallback has to parse what it stored and keeps just the text.
 */
export async function readDocumentText(path: string): Promise<DocumentText> {
  if (isTauri()) return tauriInvoke<DocumentText>('read_document_text', { path });
  const text = readBrowserDocument(path);
  if (text === null) throw new Error('That document is no longer in the library.');
  const parsed: unknown = JSON.parse(text);
  const envelope = parsed as { document?: SerializedText };
  const document = envelope.document ?? (parsed as SerializedText);
  const pages = Array.isArray(document.pages) ? document.pages : [];
  const pieces: Mutable<DocumentText['pieces']> = [];
  const pdfPages: PdfPagePiece[] = [];
  pages.forEach((page, pageIndex) => {
    if (page.pdf && typeof page.pdf.sourceId === 'string' && page.pdf.sourceId) {
      pdfPages.push({ pageIndex, pageId: page.id ?? '', sourceId: page.pdf.sourceId, pdfPageIndex: Number(page.pdf.pageIndex) || 0 });
    }
    for (const item of page.media ?? []) {
      const base = { pageIndex, pageId: page.id ?? '', mediaId: item.id ?? null };
      if ((item.kind === 'text' || item.kind === 'note') && typeof item.text === 'string' && item.text.trim()) {
        pieces.push({ ...base, kind: item.kind, text: item.text });
      } else if (item.kind === 'table' && Array.isArray(item.cells)) {
        for (const cell of item.cells) if (typeof cell === 'string' && cell.trim()) pieces.push({ ...base, kind: 'table', text: cell });
      }
    }
  });
  return { title: document.title?.trim() || '', pageCount: pages.length, pieces, pdfPages };
}

/**
 * A saved document's contents as they are on disk, for reading the PDFs in it. Only the library search wants this,
 * and only for a note whose PDFs it has not read before.
 */
export async function readDocumentContents(path: string): Promise<string> {
  if (isTauri()) return (await tauriInvoke<{ contents: string }>('open_document', { path })).contents;
  const text = readBrowserDocument(path);
  if (text === null) throw new Error('That document is no longer in the library.');
  return text;
}

type Mutable<T extends readonly unknown[]> = T[number][];

interface SerializedText {
  title?: string;
  pages?: {
    id?: string;
    media?: { id?: string; kind?: string; text?: unknown; cells?: unknown }[];
    pdf?: { sourceId?: unknown; pageIndex?: unknown };
  }[];
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncStatus(): Promise<SyncStatus> {
  if (!isTauri()) return OFFLINE_STATUS;
  return tauriInvoke<SyncStatus>('sync_status');
}

/**
 * Run a pass now.
 *
 * Also the reconciliation the filesystem watcher cannot promise: every
 * platform has a window where a file written into a directory created moments
 * earlier is missed, so the library asks for a pass when it opens rather than
 * trusting events alone.
 */
export async function syncNow(): Promise<SyncStatus> {
  if (!isTauri()) return OFFLINE_STATUS;
  return tauriInvoke<SyncStatus>('sync_now');
}

export async function resolveConflict(path: string, choice: ConflictResolution): Promise<SyncStatus> {
  if (!isTauri()) return OFFLINE_STATUS;
  return tauriInvoke<SyncStatus>('resolve_conflict', { path, choice });
}

/** Listen for status pushed by the watcher. Returns an unsubscribe function. */
export async function watchSyncStatus(onStatus: (status: SyncStatus) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<SyncStatus>('sync://status', (event) => onStatus(event.payload));
  return unlisten;
}

export { BROWSER_ROOT };
