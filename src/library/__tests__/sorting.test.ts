import { describe, expect, it } from 'vitest';
import { sortEntries } from '../sorting';
import type { LibraryEntry, SortKey, SortOrder } from '../types';

const entry = (name: string, isFolder: boolean, modifiedMs: number, createdMs: number): LibraryEntry => ({
  path: `/library/${name}`,
  relativePath: name,
  name,
  isFolder,
  bytes: 0,
  modifiedMs,
  createdMs,
  childCount: 0,
});

const order = (entries: readonly LibraryEntry[], key: SortKey, dir: SortOrder): string[] =>
  sortEntries(entries, key, dir).map((e) => e.name);

/**
 * These cases are the same ones `notes-sync`'s `sort_entries` is tested
 * against. The library has two backends — Rust on the desktop, memory in the
 * browser — and one that ordered itself differently from the other would be a
 * bug report waiting to happen.
 */
describe('library ordering', () => {
  const mixed = [
    entry('zebra', false, 100, 900),
    entry('Maths', true, 500, 500),
    entry('apple', false, 900, 100),
    entry('Archive', true, 100, 900),
  ];

  it('puts folders first whichever way the sort runs', () => {
    expect(order(mixed, 'name', 'ascending')).toEqual(['Archive', 'Maths', 'apple', 'zebra']);
    expect(order(mixed, 'name', 'descending')).toEqual(['Maths', 'Archive', 'zebra', 'apple']);
    expect(order(mixed, 'modified', 'descending')).toEqual(['Maths', 'Archive', 'apple', 'zebra']);
    expect(order(mixed, 'created', 'ascending')).toEqual(['Maths', 'Archive', 'apple', 'zebra']);
  });

  it('compares names without regard to case', () => {
    const entries = [entry('Zebra', false, 0, 0), entry('apple', false, 0, 0), entry('Banana', false, 0, 0)];
    expect(order(entries, 'name', 'ascending')).toEqual(['apple', 'Banana', 'Zebra']);
  });

  it('keeps the two date keys independent', () => {
    const entries = [entry('edited last', false, 900, 100), entry('made last', false, 100, 900)];
    expect(order(entries, 'modified', 'descending')).toEqual(['edited last', 'made last']);
    expect(order(entries, 'created', 'descending')).toEqual(['made last', 'edited last']);
  });

  it('falls back to the name on a timestamp tie', () => {
    // Two saves in the same millisecond, or a filesystem with second
    // resolution. Without this the grid reorders itself on every refresh.
    const entries = [entry('c', false, 500, 500), entry('a', false, 500, 500), entry('b', false, 500, 500)];
    expect(order(entries, 'modified', 'descending')).toEqual(['a', 'b', 'c']);
    expect(order(entries, 'created', 'ascending')).toEqual(['a', 'b', 'c']);
  });

  it('is stable across repeated sorts', () => {
    const once = sortEntries(mixed, 'modified', 'descending');
    const twice = sortEntries(once, 'modified', 'descending');
    expect(twice.map((e) => e.name)).toEqual(once.map((e) => e.name));
  });

  it('does not disturb the array it was given', () => {
    const entries = [entry('b', false, 0, 0), entry('a', false, 0, 0)];
    const sorted = sortEntries(entries, 'name', 'ascending');
    expect(entries.map((e) => e.name)).toEqual(['b', 'a']);
    expect(sorted.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('copes with an empty folder and a single item', () => {
    expect(sortEntries([], 'name', 'ascending')).toEqual([]);
    expect(order([entry('only', false, 1, 1)], 'created', 'descending')).toEqual(['only']);
  });
});
