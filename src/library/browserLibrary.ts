/**
 * A library for the browser build.
 *
 * The desktop keeps documents as real files and syncs them; a plain browser
 * has neither a filesystem nor the Rust engine, and a home screen that is
 * simply blank there would make `npm run dev` useless for working on the
 * library itself. So this keeps an index and the documents in `localStorage`
 * behind the same interface, with paths as virtual `/`-separated strings.
 *
 * It is a fallback, not a second implementation of the product: there is no
 * sync (the status stays `offline`, truthfully), and `localStorage` caps out
 * around five megabytes, so a quota failure is surfaced rather than swallowed.
 */
import { sortEntries } from './sorting';
import type { LibraryEntry, LibraryListing, SortKey, SortOrder } from './types';

const INDEX_KEY = 'notes.library.index.v1';
const DOCUMENT_PREFIX = 'notes.library.doc.';
export const BROWSER_ROOT = '/library';

interface StoredEntry {
  path: string;
  name: string;
  isFolder: boolean;
  bytes: number;
  modifiedMs: number;
  createdMs: number;
}

function readIndex(): StoredEntry[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : [];
  } catch {
    return [];
  }
}

function writeIndex(entries: readonly StoredEntry[]): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
  } catch {
    throw new Error('This browser has run out of local storage for the library.');
  }
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index <= 0 ? BROWSER_ROOT : path.slice(0, index);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** `Week 1`, or `Week 1 (2)` — whichever is free in `parent`. */
function uniquePath(parent: string, name: string, extension: string): string {
  const taken = new Set(readIndex().map((e) => e.path));
  let candidate = `${parent}/${name}${extension}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${parent}/${name} (${n})${extension}`;
  return candidate;
}

function toEntry(stored: StoredEntry, all: readonly StoredEntry[]): LibraryEntry {
  return {
    path: stored.path,
    relativePath: stored.path.startsWith(`${BROWSER_ROOT}/`) ? stored.path.slice(BROWSER_ROOT.length + 1) : stored.path,
    name: stored.name,
    isFolder: stored.isFolder,
    bytes: stored.bytes,
    modifiedMs: stored.modifiedMs,
    createdMs: stored.createdMs,
    childCount: stored.isFolder ? all.filter((e) => parentOf(e.path) === stored.path).length : 0,
  };
}

export function listBrowserLibrary(path: string | null, key: SortKey, order: SortOrder): LibraryListing {
  const dir = path ?? BROWSER_ROOT;
  const all = readIndex();
  const entries = sortEntries(
    all.filter((e) => parentOf(e.path) === dir).map((e) => toEntry(e, all)),
    key,
    order,
  );
  return {
    path: dir,
    relativePath: dir === BROWSER_ROOT ? '' : dir.slice(BROWSER_ROOT.length + 1),
    parentPath: dir === BROWSER_ROOT ? null : parentOf(dir),
    entries,
  };
}

export function createBrowserFolder(parent: string | null, name: string): string {
  const now = Date.now();
  const path = uniquePath(parent ?? BROWSER_ROOT, name.trim() || 'Untitled folder', '');
  writeIndex([
    ...readIndex(),
    { path, name: nameOf(path), isFolder: true, bytes: 0, modifiedMs: now, createdMs: now },
  ]);
  return path;
}

export function writeBrowserDocument(parent: string | null, name: string, contents: string): string {
  const now = Date.now();
  const path = uniquePath(parent ?? BROWSER_ROOT, name.trim() || 'Untitled note', '.notex');
  try {
    localStorage.setItem(DOCUMENT_PREFIX + path, contents);
  } catch {
    throw new Error('This browser has run out of local storage for the library.');
  }
  writeIndex([
    ...readIndex(),
    { path, name: nameOf(path).replace(/\.notex$/, ''), isFolder: false, bytes: contents.length, modifiedMs: now, createdMs: now },
  ]);
  return path;
}

/** Overwrite an existing document, keeping its creation time. */
export function saveBrowserDocument(path: string, contents: string): void {
  try {
    localStorage.setItem(DOCUMENT_PREFIX + path, contents);
  } catch {
    throw new Error('This browser has run out of local storage for the library.');
  }
  const index = readIndex();
  const existing = index.find((e) => e.path === path);
  if (existing) {
    existing.bytes = contents.length;
    existing.modifiedMs = Date.now();
    writeIndex(index);
  }
}

export function readBrowserDocument(path: string): string | null {
  return localStorage.getItem(DOCUMENT_PREFIX + path);
}

export function moveBrowserEntry(from: string, into: string | null): string {
  const destination = into ?? BROWSER_ROOT;
  if (destination === from || destination.startsWith(`${from}/`)) {
    throw new Error('A folder cannot be moved inside itself.');
  }
  const index = readIndex();
  const entry = index.find((e) => e.path === from);
  if (!entry) throw new Error('That item is no longer in the library.');
  const extension = entry.isFolder ? '' : '.notex';
  const base = entry.isFolder ? entry.name : entry.name;
  const target = uniquePath(destination, base, extension);

  // Folders carry their contents with them.
  for (const item of index) {
    if (item.path === from) {
      relocate(item, target);
    } else if (item.path.startsWith(`${from}/`)) {
      relocate(item, target + item.path.slice(from.length));
    }
  }
  writeIndex(index);
  return target;
}

function relocate(entry: StoredEntry, to: string): void {
  if (!entry.isFolder) {
    const contents = localStorage.getItem(DOCUMENT_PREFIX + entry.path);
    if (contents !== null) {
      localStorage.setItem(DOCUMENT_PREFIX + to, contents);
      localStorage.removeItem(DOCUMENT_PREFIX + entry.path);
    }
  }
  entry.path = to;
  entry.name = entry.isFolder ? nameOf(to) : nameOf(to).replace(/\.notex$/, '');
}

export function deleteBrowserEntry(path: string): void {
  const index = readIndex();
  const kept = index.filter((entry) => {
    const inside = entry.path === path || entry.path.startsWith(`${path}/`);
    if (inside && !entry.isFolder) localStorage.removeItem(DOCUMENT_PREFIX + entry.path);
    return !inside;
  });
  writeIndex(kept);
}
