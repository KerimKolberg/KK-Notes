/**
 * Selecting in the library, the parts that are arithmetic and words rather than clicks: what a Shift-click
 * selects, and what a selection is called in the questions and notices about it.
 */
import type { LibraryEntry } from './types';

/** "“Physics”", "3 notes", "2 notes and a folder": what a list of library entries is, said. */
export function describeEntries(entries: readonly Pick<LibraryEntry, 'name' | 'isFolder'>[]): string {
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only) return `“${only.name}”`;
  const folders = entries.filter((e) => e.isFolder).length;
  const notes = entries.length - folders;
  const count = (n: number, one: string, many: string): string => (n === 1 ? `a ${one}` : `${n} ${many}`);
  if (folders === 0) return `${notes} notes`;
  if (notes === 0) return `${folders} folders`;
  return `${count(notes, 'note', 'notes')} and ${count(folders, 'folder', 'folders')}`;
}

/**
 * The library entries from `from` to `to` in the order they are shown, both ends included, for a Shift-click; the
 * one clicked alone when the other end is not there.
 */
export function selectionRange(order: readonly string[], from: string | null, to: string): string[] {
  const start = from === null ? -1 : order.indexOf(from);
  const end = order.indexOf(to);
  if (start < 0 || end < 0) return [to];
  return order.slice(Math.min(start, end), Math.max(start, end) + 1);
}
