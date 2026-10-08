import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyBrowserEntries,
  createBrowserFolder,
  deleteBrowserTrash,
  emptyBrowserTrash,
  listBrowserLibrary,
  listBrowserTrash,
  readBrowserDocument,
  restoreBrowserTrash,
  trashBrowserEntries,
  writeBrowserDocument,
} from '../browserLibrary';
import { useNoteMetaStore } from '../noteMeta';
import { daysLeft, deletedAgo } from '../RecycleBin';
import { describeEntries, selectionRange } from '../selection';
import { copyNotes, listRecycleBin, moveToTrash, outermost, restoreFromTrash } from '../trash';
import { TRASH_KEEP_DAYS } from '../types';

/** `localStorage` for node, with a size past which writing fails as a full one does. */
class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  limit = Number.POSITIVE_INFINITY;
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    let size = key.length + value.length;
    for (const [k, v] of this.data) if (k !== key) size += k.length + v.length;
    if (size > this.limit) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.data.set(key, String(value));
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.data);
  }
}

const DAY = 24 * 60 * 60 * 1000;
let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  useNoteMetaStore.setState({ map: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Folders first, as the library lists them. */
const names = (folder: string | null = null): string[] => listBrowserLibrary(folder, 'name', 'ascending').entries.map((e) => e.name);

describe('the browser recycle bin', () => {
  it('takes a note out of the library and puts it back where it was, as it was', () => {
    const path = writeBrowserDocument(null, 'Physics', '{"physics":1}');
    writeBrowserDocument(null, 'Maths', '{}');
    const [item] = trashBrowserEntries([path], 1_000);
    expect(names()).toEqual(['Maths']);
    expect(readBrowserDocument(path)).toBeNull();
    expect(item).toEqual({ id: '1000', name: 'Physics', isFolder: false, original: 'Physics.notex', deletedMs: 1_000, bytes: 13, count: 1 });
    expect(listBrowserTrash(2_000)).toEqual([item]);

    expect(restoreBrowserTrash(['1000'])).toEqual([path]);
    expect(names()).toEqual(['Maths', 'Physics']);
    expect(readBrowserDocument(path)).toBe('{"physics":1}');
    expect(listBrowserTrash(2_000)).toEqual([]);
  });

  it('takes a folder with everything in it, and brings it all back', () => {
    const folder = createBrowserFolder(null, 'Week 1');
    const a = writeBrowserDocument(folder, 'A', 'a');
    const inner = createBrowserFolder(folder, 'Labs');
    const b = writeBrowserDocument(inner, 'B', 'bb');
    const [item] = trashBrowserEntries([folder], 5);
    expect(item).toMatchObject({ name: 'Week 1', isFolder: true, original: 'Week 1', count: 2, bytes: 3 });
    expect(names()).toEqual([]);

    restoreBrowserTrash([item!.id]);
    expect(names()).toEqual(['Week 1']);
    expect(names(folder)).toEqual(['Labs', 'A']);
    expect(readBrowserDocument(a)).toBe('a');
    expect(readBrowserDocument(b)).toBe('bb');
  });

  it('numbers a note put back where another has been made since, and writes over nothing', () => {
    const path = writeBrowserDocument(null, 'Untitled note', 'old');
    const [item] = trashBrowserEntries([path], 1);
    writeBrowserDocument(null, 'Untitled note', 'new');
    expect(restoreBrowserTrash([item!.id])).toEqual(['/library/Untitled note (2).notex']);
    expect(readBrowserDocument(path)).toBe('new');
    expect(readBrowserDocument('/library/Untitled note (2).notex')).toBe('old');
  });

  it('makes again the folders a note was in when they have gone since', () => {
    const folder = createBrowserFolder(null, 'Term');
    const note = writeBrowserDocument(folder, 'Essay', 'e');
    const [first] = trashBrowserEntries([note], 1);
    trashBrowserEntries([folder], 2);
    restoreBrowserTrash([first!.id]);
    expect(names()).toEqual(['Term']);
    expect(names(folder)).toEqual(['Essay']);
    expect(readBrowserDocument(note)).toBe('e');
  });

  it('lists the newest first and lets what is older than a month go for good', () => {
    const old = writeBrowserDocument(null, 'Old', 'o');
    const recent = writeBrowserDocument(null, 'Recent', 'r');
    trashBrowserEntries([old], 0);
    trashBrowserEntries([recent], 10 * DAY);
    expect(listBrowserTrash(20 * DAY).map((t) => t.name)).toEqual(['Recent', 'Old']);
    expect(listBrowserTrash((TRASH_KEEP_DAYS + 1) * DAY).map((t) => t.name)).toEqual(['Recent']);
    expect(Object.keys(storage.snapshot()).some((k) => k.includes('/library/Old.notex'))).toBe(false);
  });

  it('deletes for good, one or all, the documents with them', () => {
    const a = writeBrowserDocument(null, 'A', 'a');
    const b = writeBrowserDocument(null, 'B', 'b');
    const [ta, tb] = trashBrowserEntries([a, b], 7);
    deleteBrowserTrash([ta!.id]);
    expect(listBrowserTrash(8).map((t) => t.id)).toEqual([tb!.id]);
    emptyBrowserTrash();
    expect(listBrowserTrash(8)).toEqual([]);
    expect(Object.keys(storage.snapshot()).filter((k) => k.startsWith('notes.library.trashed.'))).toEqual([]);
  });

  it('refuses what is not there, or a folder with something in it as well, before it changes anything', () => {
    const folder = createBrowserFolder(null, 'F');
    const inside = writeBrowserDocument(folder, 'In', 'i');
    const before = storage.snapshot();
    expect(() => trashBrowserEntries([folder, inside], 1)).toThrow();
    expect(() => trashBrowserEntries(['/library/Gone.notex'], 1)).toThrow();
    expect(storage.snapshot()).toEqual(before);
    expect(() => restoreBrowserTrash(['nothing'])).toThrow();
    expect(storage.snapshot()).toEqual(before);
  });

  it('leaves everything as it was when storage runs out on the way into the bin or out of it', () => {
    const a = writeBrowserDocument(null, 'A', 'x'.repeat(400));
    const b = writeBrowserDocument(null, 'B', 'y'.repeat(400));
    const before = storage.snapshot();
    storage.limit = JSON.stringify(before).length + 500;
    expect(() => trashBrowserEntries([a, b], 1)).toThrow(/run out/);
    expect(storage.snapshot()).toEqual(before);

    storage.limit = Number.POSITIVE_INFINITY;
    const items = trashBrowserEntries([a, b], 1);
    const inBin = storage.snapshot();
    storage.limit = JSON.stringify(inBin).length + 500;
    expect(() => restoreBrowserTrash(items.map((t) => t.id))).toThrow(/run out/);
    expect(storage.snapshot()).toEqual(inBin);
  });

  it('copies a note, or a folder with what is in it, beside itself', () => {
    const note = writeBrowserDocument(null, 'Physics', 'p');
    const folder = createBrowserFolder(null, 'Week 1');
    writeBrowserDocument(folder, 'Lab', 'l');
    expect(copyBrowserEntries([note, folder], 9)).toEqual(['/library/Physics (2).notex', '/library/Week 1 (2)']);
    expect(names()).toEqual(['Week 1', 'Week 1 (2)', 'Physics', 'Physics (2)']);
    expect(readBrowserDocument('/library/Physics (2).notex')).toBe('p');
    expect(readBrowserDocument('/library/Week 1 (2)/Lab.notex')).toBe('l');
  });
});

describe('the recycle bin as the library uses it', () => {
  it('takes a note only once, and not again inside a folder going too', () => {
    expect(outermost(['/l/a', '/l/F', '/l/F/b', '/l/a', '/l/Fx/c', 'C:\\l\\G', 'C:\\l\\G\\d'])).toEqual(['/l/a', '/l/F', '/l/Fx/c', 'C:\\l\\G']);
  });

  it('keeps the stars and tags of what is in it, and gives them back with it', async () => {
    const folder = createBrowserFolder(null, 'Week 1');
    const note = writeBrowserDocument(folder, 'Lab', 'l');
    const loose = writeBrowserDocument(null, 'Loose', 'x');
    const meta = useNoteMetaStore.getState();
    meta.toggleFavourite(note);
    meta.setTags(note, ['lab']);
    meta.setTags(loose, ['misc']);

    const items = await moveToTrash([folder, note, loose]);
    expect(items.map((t) => t.name)).toEqual(['Week 1', 'Loose']);
    expect(useNoteMetaStore.getState().map).toEqual({});

    const back = await restoreFromTrash(items.map((t) => t.id));
    expect(back).toEqual([folder, loose]);
    expect(useNoteMetaStore.getState().map).toEqual({ [note]: { favourite: true, tags: ['lab'] }, [loose]: { tags: ['misc'] } });
    expect(await listRecycleBin()).toEqual([]);
  });

  it('gives a copy the star and tags of what it copies', async () => {
    const note = writeBrowserDocument(null, 'Physics', 'p');
    useNoteMetaStore.getState().setTags(note, ['exam']);
    const [copy] = await copyNotes([note]);
    expect(useNoteMetaStore.getState().map[copy!]).toEqual({ tags: ['exam'] });
  });
});

describe('selecting', () => {
  it('says what a selection is', () => {
    expect(describeEntries([{ name: 'Physics', isFolder: false }])).toBe('“Physics”');
    expect(describeEntries([{ name: 'A', isFolder: false }, { name: 'B', isFolder: false }])).toBe('2 notes');
    expect(describeEntries([{ name: 'A', isFolder: true }, { name: 'B', isFolder: true }])).toBe('2 folders');
    expect(describeEntries([{ name: 'A', isFolder: false }, { name: 'F', isFolder: true }])).toBe('a note and a folder');
    expect(describeEntries([{ name: 'A', isFolder: false }, { name: 'B', isFolder: false }, { name: 'F', isFolder: true }])).toBe('2 notes and a folder');
  });

  it('selects from the card selected last to the one Shift-clicked, either way round', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(selectionRange(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(selectionRange(order, 'd', 'a')).toEqual(['a', 'b', 'c', 'd']);
    expect(selectionRange(order, null, 'c')).toEqual(['c']);
    expect(selectionRange(order, 'gone', 'c')).toEqual(['c']);
  });

  it('says how long ago something was deleted, and how long it has left', () => {
    const now = 100 * DAY;
    expect(deletedAgo(now - 1000, now)).toBe('today');
    expect(deletedAgo(now - DAY - 1, now)).toBe('yesterday');
    expect(deletedAgo(now - 3 * DAY, now)).toBe('3 days ago');
    expect(daysLeft(now, now)).toBe(TRASH_KEEP_DAYS);
    expect(daysLeft(now - 29.5 * DAY, now)).toBe(1);
    expect(daysLeft(now - 40 * DAY, now)).toBe(1);
  });
});
