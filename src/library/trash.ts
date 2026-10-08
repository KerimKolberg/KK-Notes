/**
 * The recycle bin as the library uses it: notes going into it and coming back with their stars and tags, and copies
 * made with theirs.
 *
 * Stars and tags are kept on this device by a note's path (`noteMeta.ts`). A note in the bin has no path in the
 * library — and the tag chips would count it if its entry stayed — so its entries go into the bin with it, kept here
 * by the bin's id for it, and are given back at wherever it is restored to.
 */
import { entriesUnder, isUnder, useNoteMetaStore, type NoteMeta } from './noteMeta';
import { copyEntries, deleteTrash, emptyTrash, listTrash, restoreTrash, trashEntries } from './libraryService';
import type { TrashItem } from './types';

const STASH_KEY = 'notes.library.trashMeta.v1';

type Stash = Record<string, Record<string, NoteMeta>>;

function readStash(): Stash {
  try {
    const raw = localStorage.getItem(STASH_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Stash) : {};
  } catch {
    return {};
  }
}

function writeStash(stash: Stash): void {
  try {
    localStorage.setItem(STASH_KEY, JSON.stringify(stash));
  } catch {
    /* private mode: stars and tags of what is in the bin last until the app closes */
  }
}

/**
 * The paths that are not inside another of them, each once: a note in a folder that is going too goes with the
 * folder, and asked for again on its own it would be found gone.
 */
export function outermost(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((path) => !unique.some((other) => isUnder(path, other)));
}

/** Notes and folders to the recycle bin, their stars and tags with them. */
export async function moveToTrash(chosen: readonly string[]): Promise<TrashItem[]> {
  const paths = outermost(chosen);
  const meta = useNoteMetaStore.getState();
  const kept = paths.map((path) => entriesUnder(meta.map, path));
  const items = await trashEntries(paths);
  const stash = readStash();
  items.forEach((item, i) => {
    const path = paths[i];
    const entries = kept[i];
    if (!path) return;
    if (entries && Object.keys(entries).length > 0) stash[item.id] = entries;
    useNoteMetaStore.getState().removed(path);
  });
  writeStash(stash);
  return items;
}

/** Put things back where they were, their stars and tags with them; returns where each went. */
export async function restoreFromTrash(ids: readonly string[]): Promise<string[]> {
  const paths = await restoreTrash(ids);
  const stash = readStash();
  ids.forEach((id, i) => {
    const entries = stash[id];
    const path = paths[i];
    if (entries && path) useNoteMetaStore.getState().put(path, entries);
    delete stash[id];
  });
  writeStash(stash);
  return paths;
}

export async function deleteForever(ids: readonly string[]): Promise<void> {
  await deleteTrash(ids);
  const stash = readStash();
  for (const id of ids) delete stash[id];
  writeStash(stash);
}

export async function emptyRecycleBin(): Promise<void> {
  await emptyTrash();
  writeStash({});
}

/** What is in the bin. The stars and tags of what has gone from it for good go too. */
export async function listRecycleBin(): Promise<TrashItem[]> {
  const items = await listTrash();
  const stash = readStash();
  const live = new Set(items.map((item) => item.id));
  const stale = Object.keys(stash).filter((id) => !live.has(id));
  if (stale.length > 0) {
    for (const id of stale) delete stash[id];
    writeStash(stash);
  }
  return items;
}

/** Copies of notes and folders beside them, each with the star and tags of what it copies. */
export async function copyNotes(paths: readonly string[]): Promise<string[]> {
  const meta = useNoteMetaStore.getState();
  const kept = paths.map((path) => entriesUnder(meta.map, path));
  const copies = await copyEntries(paths);
  copies.forEach((copy, i) => {
    const entries = kept[i];
    if (entries) useNoteMetaStore.getState().put(copy, entries);
  });
  return copies;
}
