import { describe, expect, it, vi } from 'vitest';
import { createPdfWords, pdfSourcesJson, pdfSourcesOf, type PdfWords } from '../notePdfs';
import { memoryPdfTextStore } from '../pdfTextStore';
import { NoteIndex, pdfSourcesFor, searchNotes, type DocumentText } from '../search';
import type { LibraryEntry } from '../types';

const b64 = (s: string) => btoa(s);
const bytesOf = (buffer: ArrayBuffer) => String.fromCharCode(...new Uint8Array(buffer));

function note(sources: Record<string, string>, extra = ''): string {
  const pdfSources = Object.fromEntries(Object.entries(sources).map(([id, data]) => [id, { name: `${id}.pdf`, pageCount: 2, data: b64(data) }]));
  return JSON.stringify({
    format: 'notex',
    version: 1,
    document: {
      title: 'Lecture {1}',
      pages: [{ id: 'p', media: [{ id: 'm', kind: 'text', text: `a "quoted" \\ "pdfSources": {not this} ${extra}` }] }],
      pdfSources,
    },
  });
}

describe('pdfSourcesJson', () => {
  it('finds the sources without being fooled by braces, quotes or the key inside text', () => {
    const json = pdfSourcesJson(note({ a: 'one', b: 'two' }));
    expect(json).not.toBeNull();
    expect(Object.keys(JSON.parse(json!))).toEqual(['a', 'b']);
  });

  it('is null for a note with no PDFs, or one cut short', () => {
    expect(pdfSourcesJson(JSON.stringify({ document: { pages: [] } }))).toBeNull();
    const whole = note({ a: 'one' });
    expect(pdfSourcesJson(whole.slice(0, whole.length - 10))).toBeNull();
  });
});

describe('pdfSourcesOf', () => {
  it('gives the bytes of the sources asked for, and only those', () => {
    const got = pdfSourcesOf(note({ a: '%PDF-a', b: '%PDF-b' }), new Set(['b', 'missing']));
    expect([...got.keys()]).toEqual(['b']);
    expect(bytesOf(got.get('b')!)).toBe('%PDF-b');
  });

  it('reads a note the slow way when the quick scan cannot, and gives up quietly on one that will not parse', () => {
    const cut = note({ a: '%PDF-a' });
    expect(pdfSourcesOf('not json', new Set(['a'])).size).toBe(0);
    expect(pdfSourcesOf(cut.slice(0, -10), new Set(['a'])).size).toBe(0);
  });
});

describe('createPdfWords', () => {
  it('reads a PDF once, keeps its words, and reads the note again only for sources it has not seen', async () => {
    const store = memoryPdfTextStore();
    const contents = vi.fn(async () => note({ a: 'A', b: 'B' }));
    const extract = vi.fn(async (data: ArrayBuffer) => [`page one of ${bytesOf(data)}`, `page two of ${bytesOf(data)}`]);
    const words = createPdfWords(store, contents, extract);

    const first = await words.read('/n', ['a', 'a']);
    expect(first.get('a')).toEqual(['page one of A', 'page two of A']);
    expect(extract).toHaveBeenCalledTimes(1);

    await words.read('/n', ['a']);
    expect(contents).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);

    await words.read('/n', ['a', 'b']);
    expect(contents).toHaveBeenCalledTimes(2);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it('remembers a PDF that will not read as having no words', async () => {
    const store = memoryPdfTextStore();
    const extract = vi.fn(async () => {
      throw new Error('broken');
    });
    const words = createPdfWords(store, async () => note({ a: 'A' }), extract);
    expect((await words.read('/n', ['a'])).get('a')).toEqual([]);
    await words.read('/n', ['a']);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('forgets what no note has any more', async () => {
    const store = memoryPdfTextStore();
    await store.put('keep', ['x']);
    await store.put('gone', ['y']);
    await createPdfWords(store, async () => '').prune(new Set(['keep']));
    expect(await store.keys()).toEqual(['keep']);
  });
});

function entry(path: string, modifiedMs = 1): LibraryEntry {
  const relativePath = path.replace(/^\/lib\//, '');
  return { path, relativePath, name: relativePath.replace(/\.notex$/, ''), isFolder: false, bytes: 10, modifiedMs, createdMs: 0, childCount: 0 };
}

const pdfPage = (pageIndex: number, sourceId: string, pdfPageIndex: number) => ({ pageIndex, pageId: `p${pageIndex}`, sourceId, pdfPageIndex });

describe('pdfSourcesFor', () => {
  it('gives each PDF page its words, and skips pages with none', () => {
    const words = new Map([['s', ['Eigenvalues', '  ', 'Proofs']]]);
    const sources = pdfSourcesFor([pdfPage(0, 's', 0), pdfPage(1, 's', 1), pdfPage(3, 's', 2), pdfPage(4, 'other', 0)], words);
    expect(sources.map((s) => [s.pageIndex, s.kind, s.text])).toEqual([
      [0, 'pdf', 'Eigenvalues'],
      [3, 'pdf', 'Proofs'],
    ]);
  });
});

describe('NoteIndex with PDFs', () => {
  const doc = (title: string, typed: string, pdfPages: DocumentText['pdfPages'] = []): DocumentText => ({
    title,
    pageCount: 3,
    pieces: typed ? [{ pageIndex: 1, pageId: 'p1', mediaId: 'm', kind: 'text', text: typed }] : [],
    pdfPages,
  });

  it('reads the notes first, then the PDFs in them, and finds words only a PDF has', async () => {
    const phases: string[] = [];
    const words: PdfWords = {
      read: vi.fn(async () => new Map([['s', ['Fourier transforms', 'Laplace']]])),
      prune: vi.fn(async () => {}),
    };
    const index = new NoteIndex(async (path) => (path === '/lib/a.notex' ? doc('Signals', 'my notes', [pdfPage(0, 's', 0), pdfPage(2, 's', 1)]) : doc('Other', 'nothing')), words);
    const entries = [entry('/lib/a.notex'), entry('/lib/b.notex')];
    await index.update(entries, (_d, _t, phase) => phases.push(phase));
    expect(phases).toEqual(['notes', 'notes', 'pdfs']);
    const results = searchNotes(index.notes(entries), 'laplace');
    expect(results.map((r) => r.note.entry.name)).toEqual(['a']);
    expect(results[0]!.hits[0]!.source).toMatchObject({ kind: 'pdf', pageIndex: 2 });
    // Typed words come before a PDF's in a note's hits.
    const both = searchNotes(index.notes(entries), 'notes');
    expect(both[0]!.hits[0]!.source.kind).toBe('text');
    expect(index.current(entries)).toBe(2);
    expect(words.prune).toHaveBeenCalledWith(new Set(['s']));
  });

  it('counts a note whose PDFs are not read yet as not current, and reads only them next time', async () => {
    const words: PdfWords = { read: vi.fn(async () => new Map([['s', ['Words']]])), prune: vi.fn(async () => {}) };
    const read = vi.fn(async () => doc('A', '', [pdfPage(0, 's', 0)]));
    const index = new NoteIndex(read, words);
    const entries = [entry('/lib/a.notex')];
    // A newer search ends this one as soon as the notes themselves are read.
    let stop = false;
    await index.update(entries, (done, total, phase) => {
      if (phase === 'notes' && done === total) stop = true;
    }, () => stop);
    expect(words.read).not.toHaveBeenCalled();
    expect(index.current(entries)).toBe(0);
    expect(index.notes(entries)).toHaveLength(1);

    await index.update(entries);
    expect(read).toHaveBeenCalledTimes(1);
    expect(words.read).toHaveBeenCalledTimes(1);
    expect(index.current(entries)).toBe(1);
    expect(searchNotes(index.notes(entries), 'words')).toHaveLength(1);
  });

  it('does not forget kept PDFs after a pass where something failed to read', async () => {
    const words: PdfWords = { read: vi.fn(async () => { throw new Error('io'); }), prune: vi.fn(async () => {}) };
    const index = new NoteIndex(async () => doc('A', '', [pdfPage(0, 's', 0)]), words);
    await index.update([entry('/lib/a.notex')]);
    expect(words.prune).not.toHaveBeenCalled();
  });

  it('indexes typed text only when it has no way to read PDFs', async () => {
    const index = new NoteIndex(async () => doc('A', 'typed', [pdfPage(0, 's', 0)]));
    const entries = [entry('/lib/a.notex')];
    await index.update(entries);
    expect(index.current(entries)).toBe(1);
    expect(searchNotes(index.notes(entries), 'typed')).toHaveLength(1);
  });
});
