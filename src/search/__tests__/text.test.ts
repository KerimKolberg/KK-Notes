import { describe, expect, it } from 'vitest';
import { documentSources, fold, originAt, queryWords, searchSources, type TextSource } from '../text';

const source = (text: string, over: Partial<TextSource> = {}): TextSource => ({
  pageIndex: 0,
  pageId: 'p1',
  mediaId: 'm1',
  kind: 'text',
  text,
  ...over,
});

describe('folding text for comparison', () => {
  it('ignores case and accents', () => {
    expect(fold('Café Noël').text).toBe('cafe noel');
    expect(fold('ÀÉÎÕÜ').text).toBe('aeiou');
  });

  it('keeps a map back to where each character was typed, through letters that fold to several', () => {
    const folded = fold('áb'); // a + combining acute, then b
    expect(folded.text).toBe('ab');
    expect(originAt(folded, folded.text.indexOf('b'))).toBe(2);
    // A precomposed letter that decomposes keeps its place too.
    const composed = fold('éb');
    expect(composed.text).toBe('eb');
    expect(originAt(composed, 1)).toBe(1);
  });

  it('ends its map at the end of the original', () => {
    const f = fold('abc');
    expect([0, 1, 2, 3].map((k) => originAt(f, k))).toEqual([0, 1, 2, 3]);
    // Nothing changed length, so no map is kept at all.
    expect(f.origin).toBeNull();
    const accented = fold('Noël!');
    expect(originAt(accented, accented.text.length)).toBe(5);
  });

  it('copes with characters outside the basic plane', () => {
    const f = fold('😀x');
    expect(f.text).toBe('😀x');
    expect(originAt(f, f.text.indexOf('x'))).toBe(2);
  });

  it('turns a query into words', () => {
    expect(queryWords('  Hello   WORLD ')).toEqual(['hello', 'world']);
    expect(queryWords('   ')).toEqual([]);
    expect(queryWords('')).toEqual([]);
  });
});

describe('the text in a note', () => {
  const doc = {
    title: 'Physics 101',
    pages: [
      { id: 'p1', media: [{ kind: 'text' as const, id: 'a', text: 'Newton\'s laws' }, { kind: 'image' as const, id: 'i' }] },
      { id: 'p2' },
      {
        id: 'p3',
        media: [
          { kind: 'note' as const, id: 'n', text: 'Remember the exam' },
          { kind: 'table' as const, id: 't', cells: ['Force', '', 'Mass', '  '] },
          { kind: 'text' as const, id: 'empty', text: '   ' },
        ],
      },
    ],
  };

  it('is the title, then the typed text, notes and table cells, with where each is', () => {
    const sources = documentSources(doc);
    expect(sources.map((s) => [s.kind, s.pageIndex, s.mediaId, s.text])).toEqual([
      ['title', -1, null, 'Physics 101'],
      ['text', 0, 'a', "Newton's laws"],
      ['note', 2, 'n', 'Remember the exam'],
      ['table', 2, 't', 'Force'],
      ['table', 2, 't', 'Mass'],
    ]);
    expect(sources[2]!.pageId).toBe('p3');
  });

  it('leaves out pictures, blank text and blank cells', () => {
    const sources = documentSources(doc);
    expect(sources.some((s) => s.mediaId === 'i' || s.mediaId === 'empty')).toBe(false);
  });

  it('has nothing from an untitled, empty note', () => {
    expect(documentSources({ title: '  ', pages: [{ id: 'x' }] })).toEqual([]);
  });
});

describe('searching', () => {
  const sources = [
    source('The Café opens at nine', { mediaId: 'a' }),
    source('Quiet night', { mediaId: 'b', pageIndex: 1 }),
    source('Strasse and cafe and more', { mediaId: 'c', pageIndex: 2 }),
    source('Line one\nline two with café', { mediaId: 'd', pageIndex: 3 }),
  ];

  it('finds a word whatever its case or accents', () => {
    const hits = searchSources(sources, 'CAFE');
    expect(hits.map((h) => h.source.mediaId)).toEqual(['a', 'c', 'd']);
  });

  it('returns the match as it was typed, with some of what is either side', () => {
    const [hit] = searchSources(sources, 'cafe');
    expect(hit!.match).toBe('Café');
    expect(hit!.before).toBe('The ');
    expect(hit!.after).toBe(' opens at nine');
    expect(hit!.start).toBe(4);
    expect(hit!.end).toBe(8);
  });

  it('wants every word of a longer query in the same piece of text', () => {
    expect(searchSources(sources, 'cafe strasse').map((h) => h.source.mediaId)).toEqual(['c']);
    expect(searchSources(sources, 'cafe nonsense')).toEqual([]);
  });

  it('matches on whichever of the words comes first in the text', () => {
    const [hit] = searchSources(sources, 'more strasse');
    expect(hit!.match).toBe('Strasse');
  });

  it('shows a line break as a space, and marks where the text goes on', () => {
    const hit = searchSources(sources, 'two')[0]!;
    expect(hit.before).not.toContain('\n');
    const long = searchSources([source('x'.repeat(300) + ' needle ' + 'y'.repeat(300))], 'needle')[0]!;
    expect(long.before.startsWith('…')).toBe(true);
    expect(long.after.endsWith('…')).toBe(true);
  });

  it('finds nothing for nothing, and for a word that is not there', () => {
    expect(searchSources(sources, '')).toEqual([]);
    expect(searchSources(sources, '   ')).toEqual([]);
    expect(searchSources(sources, 'zebra')).toEqual([]);
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => source('match ' + i, { mediaId: String(i) }));
    expect(searchSources(many, 'match', 10)).toHaveLength(10);
  });

  it('keeps the order of the note', () => {
    const order = searchSources(sources, 'a').map((h) => h.source.pageIndex);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it('places a match correctly after a letter that folds to two', () => {
    const [hit] = searchSources([source('école normale')], 'normale');
    expect(hit!.match).toBe('normale');
  });
});
