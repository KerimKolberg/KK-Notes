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
import { TRASH_KEEP_DAYS, type LibraryEntry, type LibraryListing, type SortKey, type SortOrder, type TrashItem } from './types';

const INDEX_KEY = 'notes.library.index.v1';
const DOCUMENT_PREFIX = 'notes.library.doc.';
const TRASH_KEY = 'notes.library.trash.v1';
/** A document in the bin is kept under its own key, so a note made meanwhile at its old path cannot overwrite it. */
const TRASHED_PREFIX = 'notes.library.trashed.';
export const BROWSER_ROOT = '/library';
const DAY_MS = 24 * 60 * 60 * 1000;

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

// ---------------------------------------------------------------------------
// The recycle bin, and copies
// ---------------------------------------------------------------------------

/** Something in the bin: the path it had, and the index entries it took with it (a folder's, everything in it). */
interface TrashedStored extends TrashItem {
  readonly from: string;
  readonly entries: readonly StoredEntry[];
}

function readTrash(): TrashedStored[] {
  try {
    const raw = localStorage.getItem(TRASH_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as TrashedStored[]) : [];
  } catch {
    return [];
  }
}

function writeTrash(items: readonly TrashedStored[]): void {
  try {
    localStorage.setItem(TRASH_KEY, JSON.stringify(items));
  } catch {
    throw new Error('This browser has run out of local storage for the library.');
  }
}

function inside(entry: StoredEntry, path: string): boolean {
  return entry.path === path || entry.path.startsWith(`${path}/`);
}

function toItem({ entries: _entries, from: _from, ...item }: TrashedStored): TrashItem {
  void _entries;
  void _from;
  return item;
}

/**
 * Copy documents from one set of keys to another, all or none: when storage runs out part way, the copies made
 * are taken back and the error goes on, so nothing is half moved. The caller removes the old keys once what
 * points at the new ones is written.
 */
function copyKeys(pairs: readonly (readonly [from: string, to: string])[]): void {
  const made: string[] = [];
  try {
    for (const [from, to] of pairs) {
      const contents = localStorage.getItem(from);
      if (contents === null) continue;
      localStorage.setItem(to, contents);
      made.push(to);
    }
  } catch {
    for (const key of made) localStorage.removeItem(key);
    throw new Error('This browser has run out of local storage for the library.');
  }
}

/** Notes and folders to the bin: out of the library's index, their documents kept aside. */
export function trashBrowserEntries(paths: readonly string[], now = Date.now()): TrashItem[] {
  let index = readIndex();
  const trash = readTrash();
  // Checked before anything is touched, so a bad one leaves everything as it was.
  for (const path of paths) {
    if (!index.some((e) => e.path === path)) throw new Error('That is no longer in the library.');
    if (paths.some((other) => other !== path && path.startsWith(`${other}/`))) throw new Error('A folder and something in it cannot both be deleted.');
  }
  const added: TrashedStored[] = [];
  const moves: [string, string][] = [];
  for (const path of paths) {
    const top = index.find((e) => e.path === path);
    if (!top) throw new Error('That is no longer in the library.');
    const taken = index.filter((e) => inside(e, path));
    let id = String(now);
    for (let n = 1; trash.some((t) => t.id === id) || added.some((t) => t.id === id); n++) id = `${now}-${n}`;
    for (const entry of taken) {
      if (!entry.isFolder) moves.push([DOCUMENT_PREFIX + entry.path, `${TRASHED_PREFIX}${id}:${entry.path}`]);
    }
    const notes = taken.filter((e) => !e.isFolder);
    added.push({
      id,
      from: path,
      name: top.name,
      isFolder: top.isFolder,
      original: path.startsWith(`${BROWSER_ROOT}/`) ? path.slice(BROWSER_ROOT.length + 1) : path,
      deletedMs: now,
      bytes: notes.reduce((n, e) => n + e.bytes, 0),
      count: notes.length,
      entries: taken,
    });
    index = index.filter((e) => !inside(e, path));
  }
  copyKeys(moves);
  writeTrash([...trash, ...added]);
  writeIndex(index);
  for (const [from] of moves) localStorage.removeItem(from);
  return added.map(toItem);
}

/** What is in the bin, newest first; what has been there longer than a month goes now. */
export function listBrowserTrash(now = Date.now()): TrashItem[] {
  const trash = readTrash();
  const expired = trash.filter((t) => now - t.deletedMs > TRASH_KEEP_DAYS * DAY_MS);
  if (expired.length > 0) deleteBrowserTrash(expired.map((t) => t.id));
  return readTrash()
    .map(toItem)
    .sort((a, b) => b.deletedMs - a.deletedMs || a.name.localeCompare(b.name));
}

/** Put things back where they were, folders gone since made again, a taken name numbered. Returns where each went. */
export function restoreBrowserTrash(ids: readonly string[]): string[] {
  const trash = readTrash();
  const restored: string[] = [];
  const moves: [string, string][] = [];
  let index = readIndex();
  for (const id of ids) {
    const item = trash.find((t) => t.id === id);
    const top = item?.entries.find((e) => e.path === item.from);
    if (!item || !top) throw new Error('That is no longer in the recycle bin.');
    const from = item.from;
    const parent = parentOf(from);
    // Folders on the way that have gone since.
    const taken = new Set(index.map((e) => e.path));
    const folders: StoredEntry[] = [];
    for (let dir = parent; dir !== BROWSER_ROOT && dir.startsWith(`${BROWSER_ROOT}/`); dir = parentOf(dir)) {
      if (!taken.has(dir)) folders.unshift({ path: dir, name: nameOf(dir), isFolder: true, bytes: 0, modifiedMs: item.deletedMs, createdMs: item.deletedMs });
    }
    index = [...index, ...folders];
    const all = new Set(index.map((e) => e.path));
    let to = from;
    if (all.has(to)) {
      const extension = top.isFolder ? '' : '.notex';
      const stem = to.slice(0, to.length - extension.length);
      for (let n = 2; all.has(to); n++) to = `${stem} (${n})${extension}`;
    }
    for (const entry of item.entries) {
      const path = to + entry.path.slice(from.length);
      if (!entry.isFolder) moves.push([`${TRASHED_PREFIX}${id}:${entry.path}`, DOCUMENT_PREFIX + path]);
      index.push({ ...entry, path, name: entry.isFolder ? nameOf(path) : nameOf(path).replace(/\.notex$/, '') });
    }
    restored.push(to);
  }
  copyKeys(moves);
  writeIndex(index);
  writeTrash(trash.filter((t) => !ids.includes(t.id)));
  for (const [from] of moves) localStorage.removeItem(from);
  return restored;
}

/** Delete things in the bin for good. */
export function deleteBrowserTrash(ids: readonly string[]): void {
  const trash = readTrash();
  for (const item of trash) {
    if (!ids.includes(item.id)) continue;
    for (const entry of item.entries) localStorage.removeItem(`${TRASHED_PREFIX}${item.id}:${entry.path}`);
  }
  writeTrash(trash.filter((t) => !ids.includes(t.id)));
}

export function emptyBrowserTrash(): void {
  deleteBrowserTrash(readTrash().map((t) => t.id));
}

/** Copy notes and folders beside themselves, a number on each copy's name. Returns the copies' paths. */
export function copyBrowserEntries(paths: readonly string[], now = Date.now()): string[] {
  const index = readIndex();
  const copies: string[] = [];
  for (const path of paths) {
    const top = index.find((e) => e.path === path);
    if (!top) throw new Error('That is no longer in the library.');
    const extension = top.isFolder ? '' : '.notex';
    const to = uniquePath(parentOf(path), top.isFolder ? top.name : nameOf(path).replace(/\.notex$/, ''), extension);
    const taken = index.filter((e) => inside(e, path));
    for (const entry of taken) {
      const target = to + entry.path.slice(path.length);
      if (!entry.isFolder) {
        const contents = localStorage.getItem(DOCUMENT_PREFIX + entry.path);
        if (contents !== null) localStorage.setItem(DOCUMENT_PREFIX + target, contents);
      }
      index.push({ ...entry, path: target, name: entry.isFolder ? nameOf(target) : nameOf(target).replace(/\.notex$/, ''), createdMs: now, modifiedMs: now });
    }
    writeIndex(index);
    copies.push(to);
  }
  return copies;
}
