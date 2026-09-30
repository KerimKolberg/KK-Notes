/**
 * Favourites and tags for the notes in the library.
 *
 * Kept on this device, in `localStorage`, keyed by a note's path: the notes are files that sync carries
 * between devices, and putting a tag inside one would mean rewriting (and re-syncing) a whole notebook,
 * PDF and all, to change a word. The cost is that tags do not follow a note to another device. Moving or
 * deleting a note in the library moves or drops its entry; one changed from outside leaves a harmless
 * orphan.
 *
 * The functions here are pure, over a plain map, so they are tested without a store; `useNoteMetaStore`
 * is the thin persisted shell.
 */
import { create } from 'zustand';

export interface NoteMeta {
  readonly favourite?: boolean;
  readonly tags?: readonly string[];
}

export type MetaMap = Readonly<Record<string, NoteMeta>>;

export const MAX_TAG_LENGTH = 24;
export const MAX_TAGS = 8;

/** A tag as it is kept: trimmed, single-spaced, without a leading `#`, no longer than is sensible. */
export function cleanTag(text: string): string {
  return text.replace(/^[#\s]+/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH).trim();
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The tags in a comma-separated entry, cleaned, without empties or repeats (case aside). */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const piece of input.split(/[,;\n]/)) {
    const tag = cleanTag(piece);
    if (tag && !out.some((t) => same(t, tag))) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** An entry with nothing in it is left out of the map. */
function tidy(meta: NoteMeta): NoteMeta | null {
  const tags = meta.tags?.length ? meta.tags : undefined;
  if (!meta.favourite && !tags) return null;
  return { ...(meta.favourite ? { favourite: true } : {}), ...(tags ? { tags } : {}) };
}

function withEntry(map: MetaMap, path: string, meta: NoteMeta): MetaMap {
  const tidied = tidy(meta);
  if (!tidied) {
    if (!(path in map)) return map;
    const { [path]: gone, ...rest } = map;
    void gone;
    return rest;
  }
  return { ...map, [path]: tidied };
}

export function toggleFavourite(map: MetaMap, path: string): MetaMap {
  const meta = map[path] ?? {};
  return withEntry(map, path, { ...meta, favourite: !meta.favourite });
}

export function setTags(map: MetaMap, path: string, tags: readonly string[]): MetaMap {
  return withEntry(map, path, { ...(map[path] ?? {}), tags });
}

const SEPARATORS = ['/', '\\'];

function isUnder(path: string, folder: string): boolean {
  return SEPARATORS.some((sep) => path.startsWith(folder + sep));
}

/** After a note or folder is moved: its entry, and those of everything inside a folder, follow it. */
export function movePath(map: MetaMap, from: string, to: string): MetaMap {
  if (from === to) return map;
  let changed = false;
  const next: Record<string, NoteMeta> = {};
  for (const [path, meta] of Object.entries(map)) {
    if (path === from) {
      next[to] = meta;
      changed = true;
    } else if (isUnder(path, from)) {
      next[to + path.slice(from.length)] = meta;
      changed = true;
    } else {
      next[path] = meta;
    }
  }
  return changed ? next : map;
}

/** After a note or folder is deleted. */
export function removePath(map: MetaMap, path: string): MetaMap {
  const keep = Object.entries(map).filter(([p]) => p !== path && !isUnder(p, path));
  return keep.length === Object.keys(map).length ? map : Object.fromEntries(keep);
}

export interface TagCount {
  readonly tag: string;
  readonly count: number;
}

/** Every tag in use and how many notes carry it, most used first. Two spellings of one tag are one tag. */
export function tagCounts(map: MetaMap): TagCount[] {
  const seen = new Map<string, { tag: string; count: number }>();
  for (const meta of Object.values(map)) {
    for (const tag of meta.tags ?? []) {
      const key = tag.toLowerCase();
      const entry = seen.get(key);
      if (entry) entry.count += 1;
      else seen.set(key, { tag, count: 1 });
    }
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export function favouriteCount(map: MetaMap): number {
  return Object.values(map).filter((m) => m.favourite).length;
}

export type LibraryFilter = { readonly kind: 'all' } | { readonly kind: 'favourites' } | { readonly kind: 'tag'; readonly tag: string };

export const ALL_NOTES: LibraryFilter = { kind: 'all' };

export function matchesFilter(meta: NoteMeta | undefined, filter: LibraryFilter): boolean {
  switch (filter.kind) {
    case 'all':
      return true;
    case 'favourites':
      return meta?.favourite === true;
    case 'tag':
      return (meta?.tags ?? []).some((t) => same(t, filter.tag));
  }
}

// ---------------------------------------------------------------------------
// The persisted store
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'notes.library.meta.v1';

function read(): MetaMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, NoteMeta> = {};
    for (const [path, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as { favourite?: unknown; tags?: unknown };
      const tags = Array.isArray(v.tags)
        ? v.tags.filter((t): t is string => typeof t === 'string').map(cleanTag).filter(Boolean).slice(0, MAX_TAGS)
        : [];
      const tidied = tidy({ favourite: v.favourite === true, tags });
      if (tidied) out[path] = tidied;
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: MetaMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* private mode: they last until the app is closed */
  }
}

export interface NoteMetaStore {
  readonly map: MetaMap;
  toggleFavourite: (path: string) => void;
  setTags: (path: string, tags: readonly string[]) => void;
  moved: (from: string, to: string) => void;
  removed: (path: string) => void;
}

export const useNoteMetaStore = create<NoteMetaStore>()((set, get) => {
  const apply = (next: MetaMap): void => {
    if (next === get().map) return;
    write(next);
    set({ map: next });
  };
  return {
    map: read(),
    toggleFavourite: (path) => apply(toggleFavourite(get().map, path)),
    setTags: (path, tags) => apply(setTags(get().map, path, tags)),
    moved: (from, to) => apply(movePath(get().map, from, to)),
    removed: (path) => apply(removePath(get().map, path)),
  };
});
