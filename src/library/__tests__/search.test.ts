import { describe, expect, it, vi } from 'vitest';
import { NoteIndex, folderOf, listAllNotes, searchNotes, sourcesOf, type DocumentText } from '../search';
import type { LibraryEntry, LibraryListing } from '../types';

function entry(path: string, modifiedMs = 1, isFolder = false): LibraryEntry {
  const relativePath = path.replace(/^\/lib\//, '');
  return {
    path,
    relativePath,
    name: relativePath.split('/').pop()!.replace(/\.notex$/, ''),
    isFolder,
    bytes: 10,
    modifiedMs,
    createdMs: 0,
    childCount: 0,
  };
}

function text(title: string, pieces: DocumentText['pieces'] = []): DocumentText {
  return { title, pageCount: 2, pieces };
}

const piece = (pageIndex: number, kind: 'text' | 'note' | 'table', t: string, mediaId = `m${pageIndex}`) => ({
  pageIndex,
  pageId: `p${pageIndex}`,
  mediaId,
  kind,
  text: t,
});

describe('listAllNotes', () => {
  const tree: Record<string, LibraryEntry[]> = {
    '': [entry('/lib/a.notex'), entry('/lib/Work', 1, true)],
    '/lib/Work': [entry('/lib/Work/b.notex'), entry('/lib/Work/Deep', 1, true)],
    '/lib/Work/Deep': [entry('/lib/Work/Deep/c.notex')],
  };
  const list = async (path: string | null): Promise<LibraryListing> => ({
    path: path ?? '/lib',
    relativePath: '',
    parentPath: null,
    entries: tree[path ?? ''] ?? [],
  });

  it('finds documents in every folder, and leaves the folders out', async () => {
    const notes = await listAllNotes(list);
    expect(notes.map((n) => n.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips a folder that cannot be read instead of failing', async () => {
    const notes = await listAllNotes(async (path) => {
      if (path === '/lib/Work') throw new Error('denied');
      return list(path);
    });
    expect(notes.map((n) => n.name)).toEqual(['a']);
  });
});

describe('sourcesOf', () => {
  it('puts the title first, on no page, and skips an empty one', () => {
    expect(sourcesOf(text('Chem', [piece(0, 'text', 'hello')])).map((s) => [s.kind, s.pageIndex])).toEqual([
      ['title', -1],
      ['text', 0],
    ]);
    expect(sourcesOf(text('  ', [])).length).toBe(0);
  });
});

describe('NoteIndex', () => {
  it('reads each note once and again only when it has changed', async () => {
    const read = vi.fn(async (path: string) => text(path));
    const index = new NoteIndex(read);
    const a = entry('/lib/a.notex', 1);
    const b = entry('/lib/b.notex', 1);
    await index.update([a, b]);
    expect(read).toHaveBeenCalledTimes(2);
    await index.update([a, b]);
    expect(read).toHaveBeenCalledTimes(2);
    await index.update([entry('/lib/a.notex', 2), b]);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('forgets notes that are gone', async () => {
    const index = new NoteIndex(async (p) => text(p));
    const a = entry('/lib/a.notex');
    const b = entry('/lib/b.notex');
    await index.update([a, b]);
    await index.update([a]);
    expect(index.notes([a, b]).map((n) => n.entry.path)).toEqual(['/lib/a.notex']);
  });

  it('counts how many are current, and reports progress', async () => {
    const index = new NoteIndex(async (p) => text(p));
    const all = [entry('/lib/a.notex'), entry('/lib/b.notex'), entry('/lib/c.notex')];
    const progress: [number, number][] = [];
    await index.update(all, (d, t) => progress.push([d, t]));
    expect(index.current(all)).toBe(3);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it('gives an unreadable note no words instead of failing the rest', async () => {
    const index = new NoteIndex(async (p) => {
      if (p.includes('bad')) throw new Error('not a note');
      return text('Fine', [piece(0, 'text', 'lemon')]);
    });
    const good = entry('/lib/good.notex');
    const bad = entry('/lib/bad.notex');
    await index.update([good, bad]);
    const found = searchNotes(index.notes([good, bad]), 'lemon');
    expect(found.map((r) => r.note.entry.name)).toEqual(['good']);
  });

  it('stops reading when told to', async () => {
    const read = vi.fn(async (p: string) => text(p));
    const index = new NoteIndex(read);
    const all = Array.from({ length: 20 }, (_, i) => entry(`/lib/${i}.notex`));
    let stop = false;
    await index.update(all, (done) => {
      if (done >= 4) stop = true;
    }, () => stop);
    expect(read.mock.calls.length).toBeLessThan(20);
  });
});

describe('searchNotes', () => {
  const indexed = async (notes: [LibraryEntry, DocumentText][]) => {
    const byPath = new Map(notes.map(([e, t]) => [e.path, t]));
    const index = new NoteIndex(async (p) => byPath.get(p)!);
    const entries = notes.map(([e]) => e);
    await index.update(entries);
    return index.notes(entries);
  };

  it('finds notes by what is written in them, with where', async () => {
    const notes = await indexed([
      [entry('/lib/a.notex'), text('Shopping', [piece(0, 'text', 'Buy a Lemon'), piece(1, 'table', 'lemon tart')])],
      [entry('/lib/b.notex'), text('Travel', [piece(0, 'note', 'Passport')])],
    ]);
    const results = searchNotes(notes, 'LEMON');
    expect(results.map((r) => r.note.title)).toEqual(['Shopping']);
    expect(results[0]!.hits.map((h) => [h.source.pageIndex, h.source.kind])).toEqual([
      [0, 'text'],
      [1, 'table'],
    ]);
    expect(results[0]!.inTitle).toBe(false);
  });

  it('finds notes by title or file name, and lists those first', async () => {
    const notes = await indexed([
      [entry('/lib/a.notex'), text('Shopping', [piece(0, 'text', 'lemon')])],
      [entry('/lib/Lemon cake.notex'), text('Recipe')],
    ]);
    const results = searchNotes(notes, 'lemon');
    expect(results.map((r) => r.note.entry.name)).toEqual(['Lemon cake', 'a']);
    expect(results[0]!.inTitle).toBe(true);
    expect(results[0]!.hits).toEqual([]);
  });

  it('ignores case and accents', async () => {
    const notes = await indexed([[entry('/lib/a.notex'), text('Menu', [piece(0, 'text', 'Café crème')])]]);
    expect(searchNotes(notes, 'CAFE').length).toBe(1);
  });

  it('shows only the first few places in a note', async () => {
    const notes = await indexed([
      [entry('/lib/a.notex'), text('Many', Array.from({ length: 9 }, (_, i) => piece(0, 'text', `word ${i}`, `m${i}`)))],
    ]);
    expect(searchNotes(notes, 'word')[0]!.hits.length).toBe(3);
  });

  it('finds nothing for an empty query, and for a word that is not there', async () => {
    const notes = await indexed([[entry('/lib/a.notex'), text('T', [piece(0, 'text', 'hello')])]]);
    expect(searchNotes(notes, '  ')).toEqual([]);
    expect(searchNotes(notes, 'zzz')).toEqual([]);
  });

  it('says which folder a note is in', () => {
    expect(folderOf(entry('/lib/Work/Deep/c.notex'))).toBe('Work/Deep');
    expect(folderOf(entry('/lib/a.notex'))).toBe('');
  });
});
