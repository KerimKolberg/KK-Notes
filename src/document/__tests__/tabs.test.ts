import { describe, expect, it } from 'vitest';
import {
  MAX_LIVE_TABS,
  isParkable,
  isPristine,
  liveTabs,
  parkTab,
  pdfSourceIds,
  releasableSources,
  tabTitle,
  tabsToPark,
  type Tab,
  type TabSession,
} from '../tabs';
import { createDocument, createPage } from '../operations';
import type { Document, PdfPageRef } from '../types';

/**
 * The tab rules, tested as arithmetic rather than through a store.
 *
 * Every case below is about the one question the design turns on: what may be
 * thrown out of memory. Getting that wrong in the generous direction wastes a
 * tablet's RAM; getting it wrong in the other direction deletes somebody's
 * unsaved notes, which is why most of these tests are about what must *not* be
 * parked.
 */

const pdfRef = (sourceId: string): PdfPageRef => ({
  sourceId,
  sourceName: `${sourceId}.pdf`,
  data: new ArrayBuffer(8),
  pageCount: 1,
  pageIndex: 0,
  viewBox: [0, 0, 595, 842],
  rotation: 0,
  scale: 1,
});

/** A document with one PDF-backed page per source id. */
function docWithPdfs(...sourceIds: string[]): Document {
  const base = createDocument(1, 'Lecture');
  const pages = sourceIds.map((id, i) => createPage({ template: 'pdf', pdf: pdfRef(id) }, i + 1));
  return { ...base, pages };
}

function session(over: Partial<TabSession> = {}): TabSession {
  const document = over.document ?? createDocument(1, 'Week 1');
  return {
    document,
    filePath: '/notes/Week 1.notex',
    savedPages: document.pages,
    savedTitle: document.title,
    savedCover: document.cover,
    readOnly: false,
    ...over,
  };
}

function tab(over: Partial<Tab> = {}): Tab {
  const s = over.session === undefined ? session() : over.session;
  return {
    id: 't1',
    title: 'Week 1',
    path: s?.filePath ?? '/notes/Week 1.notex',
    session: s,
    dirty: false,
    usedAt: 1,
    ...over,
  };
}

describe('what may be parked', () => {
  it('parks a saved document that lives on disk', () => {
    expect(isParkable(tab())).toBe(true);
  });

  it('never parks unsaved work, however old the tab', () => {
    // There is nowhere to read it back from. This is the rule the whole design
    // exists to protect.
    expect(isParkable(tab({ dirty: true, usedAt: 0 }))).toBe(false);
  });

  it('never parks a document that was never saved anywhere', () => {
    // An imported PDF or notebook: clean, because nothing has been drawn on it
    // yet, but with no file behind it either.
    const imported = session({ filePath: null });
    expect(isParkable(tab({ session: imported, path: null }))).toBe(false);
  });

  it('does not park what is already parked', () => {
    const parked = tab({ session: null });
    expect(isParkable(parked)).toBe(false);
    expect(parkTab(parked)).toBe(parked);
  });

  it('drops the document but keeps the label and the path', () => {
    const parked = parkTab(tab({ title: 'Week 1', path: '/notes/Week 1.notex' }));
    expect(parked.session).toBeNull();
    expect(parked.title).toBe('Week 1');
    expect(parked.path).toBe('/notes/Week 1.notex');
  });

  it('refuses to park a dirty tab even when asked directly', () => {
    const dirty = tab({ dirty: true });
    expect(parkTab(dirty)).toBe(dirty);
    expect(parkTab(dirty).session).not.toBeNull();
  });
});

describe('choosing what to park', () => {
  const saved = (id: string, usedAt: number): Tab =>
    tab({ id, usedAt, title: id, path: `/${id}.notex`, session: session({ filePath: `/${id}.notex` }) });

  it('leaves everything alone while the live count is within the budget', () => {
    const tabs = [saved('a', 1), saved('b', 2), saved('c', 3)];
    expect(tabsToPark(tabs, 'c')).toEqual([]);
    expect(liveTabs(tabs)).toHaveLength(3);
  });

  it('parks the least recently used first', () => {
    const tabs = [saved('a', 1), saved('b', 2), saved('c', 3), saved('d', 4), saved('e', 5)];
    expect(tabsToPark(tabs, 'e')).toEqual(['a', 'b']);
  });

  it('never parks the tab being drawn on, even if it is the oldest', () => {
    // `a` is the least recently used *and* the active one, which happens when
    // you come back to an old tab and keep working in it.
    const tabs = [saved('a', 1), saved('b', 5), saved('c', 6), saved('d', 7)];
    const park = tabsToPark(tabs, 'a');
    expect(park).not.toContain('a');
    expect(park).toEqual(['b']);
  });

  it('gives up rather than parking work it cannot restore', () => {
    // Four unsaved imports. Nothing here may be parked, so the budget is simply
    // exceeded — a bounded memory target is best-effort, keeping work is not.
    const unsaved = (id: string, usedAt: number): Tab =>
      tab({ id, usedAt, path: null, dirty: true, session: session({ filePath: null }) });
    const tabs = [unsaved('a', 1), unsaved('b', 2), unsaved('c', 3), unsaved('d', 4)];
    expect(tabsToPark(tabs, 'd')).toEqual([]);
    expect(liveTabs(tabs)).toHaveLength(4);
  });

  it('parks what it can and leaves the rest live', () => {
    const tabs = [
      tab({ id: 'dirty', usedAt: 1, dirty: true }),
      saved('b', 2),
      saved('c', 3),
      saved('d', 4),
      saved('e', 5),
    ];
    // Five live, budget three: two must go, and `dirty` is not eligible even
    // though it is the oldest.
    expect(tabsToPark(tabs, 'e')).toEqual(['b', 'c']);
  });

  it('counts only live tabs against the budget', () => {
    const tabs = [
      tab({ id: 'parked1', usedAt: 1, session: null }),
      tab({ id: 'parked2', usedAt: 2, session: null }),
      saved('c', 3),
      saved('d', 4),
    ];
    expect(tabsToPark(tabs, 'd')).toEqual([]);
  });

  it('keeps at least the active tab however small the budget', () => {
    const tabs = [saved('a', 1), saved('b', 2)];
    expect(tabsToPark(tabs, 'b', 0)).toEqual(['a']);
    expect(tabsToPark([saved('a', 1)], 'a', 0)).toEqual([]);
  });

  it('defaults to a budget of three', () => {
    const tabs = [saved('a', 1), saved('b', 2), saved('c', 3), saved('d', 4)];
    expect(tabsToPark(tabs, 'd')).toEqual(tabsToPark(tabs, 'd', MAX_LIVE_TABS));
    expect(MAX_LIVE_TABS).toBe(3);
  });
});

describe('releasing a PDF that nothing is looking at any more', () => {
  it('finds every source a document holds bytes for', () => {
    expect([...pdfSourceIds(docWithPdfs('one', 'two', 'one'))].sort()).toEqual(['one', 'two']);
    expect(pdfSourceIds(createDocument(1)).size).toBe(0);
  });

  it('releases the sources no other live tab still needs', () => {
    const leaving = session({ document: docWithPdfs('lecture', 'appendix') });
    const others = [tab({ id: 'x', session: session({ document: docWithPdfs('appendix') }) })];
    expect(releasableSources(leaving, others)).toEqual(['lecture']);
  });

  it('holds on to a source a second tab shares', () => {
    // The same PDF open in two tabs. Destroying the parsed document because one
    // of them closed would blank the other's pages.
    const leaving = session({ document: docWithPdfs('shared') });
    const others = [tab({ id: 'x', session: session({ document: docWithPdfs('shared') }) })];
    expect(releasableSources(leaving, others)).toEqual([]);
  });

  it('does not count parked tabs as holders', () => {
    // A parked tab has no bytes in memory; it re-opens the PDF from the file it
    // reads back. Counting it would keep every PDF ever opened parsed forever,
    // which is the leak this exists to close.
    const leaving = session({ document: docWithPdfs('lecture') });
    const parked = [tab({ id: 'x', session: null, path: '/x.notex' })];
    expect(releasableSources(leaving, parked)).toEqual(['lecture']);
  });

  it('releases everything when the last tab goes', () => {
    const leaving = session({ document: docWithPdfs('a', 'b') });
    expect([...releasableSources(leaving, [])].sort()).toEqual(['a', 'b']);
  });
});

describe('an untouched tab', () => {
  it('recognises a blank new document', () => {
    expect(isPristine(session({ filePath: null, document: createDocument(1) }))).toBe(true);
  });

  it('is not pristine once it has a file, a stroke, media or a cover', () => {
    expect(isPristine(session({ filePath: '/a.notex' }))).toBe(false);

    const withCover = createDocument(1);
    expect(
      isPristine(
        session({
          filePath: null,
          document: { ...withCover, cover: { title: 'T', description: '', coverColor: '#fff', textColor: '#000' } },
        }),
      ),
    ).toBe(false);

    const drawn = createDocument(1);
    const page = drawn.pages[0]!;
    expect(
      isPristine(
        session({
          filePath: null,
          document: { ...drawn, pages: [{ ...page, media: [{ kind: 'note', id: 'n', x: 0, y: 0, width: 10, height: 10, rotation: 0, zIndex: 0, text: 'hi', color: '#ff0' }] }] },
        }),
      ),
    ).toBe(false);
  });

  it('is not pristine with more than one page', () => {
    expect(isPristine(session({ filePath: null, document: createDocument(3) }))).toBe(false);
  });

  it('says no when there is no session at all', () => {
    expect(isPristine(null)).toBe(false);
  });
});

describe('labelling a tab', () => {
  it('uses the document title', () => {
    expect(tabTitle(session({ document: createDocument(1, 'Chemistry') }))).toBe('Chemistry');
  });

  it('falls back rather than showing an empty tab', () => {
    expect(tabTitle(session({ document: { ...createDocument(1), title: '   ' } }))).toBe('Untitled note');
  });
});
