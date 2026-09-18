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
