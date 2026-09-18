/**
 * The library's ordering, mirroring `notes-sync`'s `sort_entries` exactly.
 *
 * Both exist because the library has two backends: the Rust one sorts on disk
 * for the desktop, and the browser fallback sorts in memory. A library that
 * ordered itself differently depending on which build you opened it in would
 * be a bug report waiting to happen, so this is the same rule twice — and
 * both are tested against the same cases.
 */
import type { LibraryEntry, SortKey, SortOrder } from './types';

/** Folder or not, then the chosen key, then the name as a tiebreak. */
export function compareEntries(a: LibraryEntry, b: LibraryEntry, key: SortKey, order: SortOrder): number {
  // Folders lead whichever direction the sort runs: they are the structure of
  // the library rather than items in it, and a "newest first" order that
  // scatters them through the documents makes the place harder to navigate.
  if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;

  const byName = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  let result: number;
  switch (key) {
    case 'name':
      result = byName;
      break;
    case 'modified':
      result = a.modifiedMs - b.modifiedMs;
      break;
    case 'created':
      result = a.createdMs - b.createdMs;
      break;
  }
  if (order === 'descending') result = -result;
  // Timestamp ties are common — two saves in the same millisecond, or a
  // filesystem with second resolution — and an unstable order would reshuffle
  // the grid on every refresh.
  return result !== 0 ? result : byName;
}

export function sortEntries(entries: readonly LibraryEntry[], key: SortKey, order: SortOrder): LibraryEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, key, order));
}
