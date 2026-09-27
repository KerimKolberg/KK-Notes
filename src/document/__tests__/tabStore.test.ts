import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTabStore, captureSession, openDocumentInTab, restoreSession } from '../tabStore';
import { useDocumentStore } from '../store';
import { createDocument, createPage } from '../operations';
import type { Document, PdfPageRef } from '../types';
import type { TabSession } from '../tabs';

/**
 * Tabs moving in and out of the one live document store.
 *
 * The thing under test is that no work is lost while memory is bounded, so the
 * assertions are mostly about what survived: strokes drawn in a tab you left,
 * unsaved documents that refuse to be parked, and a document store whose one
 * live document is always the tab you are looking at.
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

function sessionFor(title: string, path: string | null, over: Partial<TabSession> = {}) {
  const document = createDocument(1, title);
  return {
    document,
    filePath: path,
    savedPages: document.pages,
    savedTitle: document.title,
    savedCover: document.cover,
    readOnly: false,
    ...over,
  };
}

/** A document with a PDF-backed page, for the release assertions. */
function pdfSession(title: string, path: string | null, sourceId: string) {
  const base = createDocument(1, title);
  const document: Document = { ...base, pages: [createPage({ template: 'pdf', pdf: pdfRef(sourceId) }, 1)] };
  return { ...sessionFor(title, path), document, savedPages: document.pages };
}

const released: string[] = [];
vi.mock('../../pdf/pdfRenderer', () => ({
  releasePdfSource: (id: string) => {
    released.push(id);
  },
}));

beforeEach(() => {
  released.length = 0;
  useTabStore.setState({ tabs: [], activeId: null, clock: 1, splitId: null, splitRatio: 0.6 });
  useDocumentStore.getState().newDocument();
  // `newDocument` deliberately keeps the presenting lock, so a test that set it
  // would otherwise leave every later test unable to edit anything.
  useDocumentStore.setState({ readOnly: false });
});

describe('opening tabs', () => {
  it('adopts whatever is already open as the first tab', () => {
    const id = useTabStore.getState().adoptCurrent();
    const { tabs, activeId } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(activeId).toBe(id);
    expect(tabs[0]!.session).not.toBeNull();
  });

  it('adopting twice does not make a second tab', () => {
    const first = useTabStore.getState().adoptCurrent();
    expect(useTabStore.getState().adoptCurrent()).toBe(first);
    expect(useTabStore.getState().tabs).toHaveLength(1);
  });

  it('replaces a blank untouched tab instead of leaving it behind', () => {
    // The browser behaviour: opening a file from a fresh tab uses that tab.
    useTabStore.getState().adoptCurrent();
    useTabStore.getState().openTab(sessionFor('Week 1', '/Week 1.notex'));
    const { tabs } = useTabStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.title).toBe('Week 1');
  });

  it('adds a tab when the current one holds real work', () => {
    useTabStore.getState().adoptCurrent();
    useTabStore.getState().openTab(sessionFor('Lecture', '/Lecture.notex'));
    useTabStore.getState().openTab(sessionFor('Week 2', '/Week 2.notex'));
    expect(useTabStore.getState().tabs.map((t) => t.title)).toEqual(['Lecture', 'Week 2']);
  });

  it('makes the opened tab the live document', () => {
    useTabStore.getState().adoptCurrent();
    useTabStore.getState().openTab(sessionFor('Chemistry', '/Chemistry.notex'));
    expect(useDocumentStore.getState().document.title).toBe('Chemistry');
    expect(useDocumentStore.getState().filePath).toBe('/Chemistry.notex');
  });

  it('refuses to open past the cap rather than thrashing', () => {
    // The first open reuses the blank adopted tab, so twelve opens are twelve
    // tabs, and the thirteenth is the one that has nowhere to go.
    useTabStore.getState().adoptCurrent();
    for (let i = 0; i < 12; i++) useTabStore.getState().openTab(sessionFor(`n${i}`, `/n${i}.notex`));
    expect(useTabStore.getState().tabs).toHaveLength(12);
    expect(() => useTabStore.getState().openTab(sessionFor('one too many', '/x.notex'))).toThrow(/12 tabs/);
  });
});

describe('switching tabs', () => {
  it('keeps what was drawn in the tab being left', async () => {
    // The whole point of capturing on the way out.
    useTabStore.getState().adoptCurrent();
    const first = useTabStore.getState().activeId!;
    useDocumentStore.getState().setTitle('edited in the first tab');

    useTabStore.getState().openTab(sessionFor('second', '/second.notex'));
    expect(useDocumentStore.getState().document.title).toBe('second');

    await useTabStore.getState().activate(first);
    expect(useDocumentStore.getState().document.title).toBe('edited in the first tab');
  });

  it('does nothing when the tab is already active', async () => {
    useTabStore.getState().adoptCurrent();
    const id = useTabStore.getState().activeId!;
    const before = useTabStore.getState().clock;
    await useTabStore.getState().activate(id);
    expect(useTabStore.getState().clock).toBe(before);
  });

  it('ignores a tab that is not there', async () => {
    useTabStore.getState().adoptCurrent();
    await expect(useTabStore.getState().activate('nonexistent')).resolves.toBeUndefined();
  });

  it('clears the selection rather than restoring a stale one', async () => {
    // Started from a saved document, so the first tab is real work rather than a
    // blank one the next open would reuse.
    useDocumentStore.getState().loadDocument(createDocument(1, 'first'), '/first.notex');
    const first = useTabStore.getState().adoptCurrent();
    useTabStore.getState().openTab(sessionFor('second', '/second.notex'));
    expect(useTabStore.getState().tabs).toHaveLength(2);

    useDocumentStore.setState({ selectedMedia: { pageId: 'p', mediaId: 'm' } });
    await useTabStore.getState().activate(first);
    expect(useDocumentStore.getState().selectedMedia).toBeNull();
  });
});

describe('bounding memory', () => {
  /** Four saved documents open, which is one past the live budget of three. */
  function fourSaved(): string[] {
    useTabStore.getState().adoptCurrent();
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c', 'd']) {
      ids.push(useTabStore.getState().openTab(sessionFor(name, `/${name}.notex`)));
    }
    return ids;
  }

  it('parks the oldest saved tab once past the budget', async () => {
    fourSaved();
    await useTabStore.getState().park();
    const live = useTabStore.getState().tabs.filter((t) => t.session !== null);
    expect(live).toHaveLength(3);
    // The first tab opened is the one that went.
    expect(useTabStore.getState().tabs[0]!.session).toBeNull();
  });

  it('brings a parked tab back from disk when it is activated', async () => {
    const ids = fourSaved();
    await useTabStore.getState().park();
    const parked = useTabStore.getState().tabs.find((t) => t.session === null)!;

    const reopened = createDocument(1, 'read back from disk');
    vi.doMock('../../desktop/fileService', () => ({
      openDocumentFromPath: async () => ({ document: reopened }),
    }));

    await useTabStore.getState().activate(parked.id);
    expect(useDocumentStore.getState().document.title).toBe('read back from disk');
    expect(useTabStore.getState().tabs.find((t) => t.id === parked.id)!.session).not.toBeNull();
    expect(ids).toContain(parked.id);
    vi.doUnmock('../../desktop/fileService');
  });

  it('never parks a tab with unsaved changes', async () => {
    useTabStore.getState().adoptCurrent();
    for (const name of ['a', 'b', 'c']) {
      useTabStore.getState().openTab(sessionFor(name, `/${name}.notex`));
    }
    // Dirty the oldest real tab by editing it while it is active.
    const first = useTabStore.getState().tabs[0]!.id;
    await useTabStore.getState().activate(first);
    useDocumentStore.getState().setTitle('unsaved work');
    // Then move away and open more, so it becomes the least recently used. The
    // move is what records the edit on the tab — nothing watches it in between.
    useTabStore.getState().openTab(sessionFor('d', '/d.notex'));
    useTabStore.getState().openTab(sessionFor('e', '/e.notex'));
    await useTabStore.getState().park();

    const dirty = useTabStore.getState().tabs.find((t) => t.id === first)!;
    expect(dirty.dirty).toBe(true);
    expect(dirty.session).not.toBeNull();
  });

  it('releases the PDFs a parked tab was holding', async () => {
    useTabStore.getState().adoptCurrent();
    useTabStore.getState().openTab(pdfSession('lecture', '/lecture.notex', 'src-lecture'));
    for (const name of ['b', 'c', 'd']) {
      useTabStore.getState().openTab(sessionFor(name, `/${name}.notex`));
    }
    await useTabStore.getState().park();
    // `openTab` also parks on its own, without being awaited, so the release may
    // land a microtask later than the call above.
    await vi.waitFor(() => expect(released).toContain('src-lecture'));
  });

  it('keeps a PDF that another open tab still shows', async () => {
    useTabStore.getState().adoptCurrent();
    useTabStore.getState().openTab(pdfSession('one', '/one.notex', 'shared'));
    useTabStore.getState().openTab(pdfSession('two', '/two.notex', 'shared'));
    useTabStore.getState().openTab(sessionFor('c', '/c.notex'));
    useTabStore.getState().openTab(sessionFor('d', '/d.notex'));
    await useTabStore.getState().park();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // `one` parked, but `two` still holds the same source.
    expect(released).not.toContain('shared');
  });
});

describe('closing tabs', () => {
  it('releases the closed tab’s PDFs', async () => {
    useTabStore.getState().adoptCurrent();
    const id = useTabStore.getState().openTab(pdfSession('lecture', '/lecture.notex', 'src-1'));
    useTabStore.getState().openTab(sessionFor('other', '/other.notex'));
    await useTabStore.getState().close(id);
    await vi.waitFor(() => expect(released).toContain('src-1'));
  });

  it('moves to the neighbour on the right when the active tab closes', async () => {
    useTabStore.getState().adoptCurrent();
    useTabStore.getState().openTab(sessionFor('left', '/left.notex'));
    const middle = useTabStore.getState().openTab(sessionFor('middle', '/middle.notex'));
    useTabStore.getState().openTab(sessionFor('right', '/right.notex'));
    await useTabStore.getState().activate(middle);
    await useTabStore.getState().close(middle);
    expect(useDocumentStore.getState().document.title).toBe('right');
  });

  it('falls left when the active tab was the last one', async () => {
    useTabStore.getState().adoptCurrent();
    useTabStore.getState().openTab(sessionFor('left', '/left.notex'));
    const last = useTabStore.getState().openTab(sessionFor('right', '/right.notex'));
    await useTabStore.getState().close(last);
    expect(useDocumentStore.getState().document.title).toBe('left');
  });

  it('leaves a fresh blank tab when the last one closes', async () => {
    useTabStore.getState().adoptCurrent();
    const only = useTabStore.getState().activeId!;
    await useTabStore.getState().close(only);
    const { tabs, activeId } = useTabStore.getState();
    // Never zero tabs: the app always has a document open.
    expect(tabs).toHaveLength(1);
    expect(activeId).not.toBeNull();
    expect(useDocumentStore.getState().document.pages).toHaveLength(1);
  });

  it('ignores closing a tab that is not there', async () => {
    useTabStore.getState().adoptCurrent();
    await expect(useTabStore.getState().close('nope')).resolves.toBeUndefined();
    expect(useTabStore.getState().tabs).toHaveLength(1);
  });
});

describe('opening through a loader that writes straight into the store', () => {
  /** What every real loader does: replace the document store's contents. */
  const loadInto = (title: string, path: string | null) => async () => {
    useDocumentStore.getState().loadDocument(createDocument(1, title), path);
    return true;
  };

  it('keeps the document that was open, in its own tab', async () => {
    useDocumentStore.getState().loadDocument(createDocument(1, 'First'), '/First.notex');
    useTabStore.getState().adoptCurrent();

    await openDocumentInTab(loadInto('Second', '/Second.notex'));

    const { tabs, activeId } = useTabStore.getState();
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.title)).toEqual(['First', 'Second']);
    expect(activeId).toBe(tabs[1]!.id);
  });

  it('labels the tab it left with its own document, not the incoming one', async () => {
    // The regression. A loader overwrites the store *before* the tab is created,
    // so the label has to come from the captured session — reading it from the
    // store at that point gives the *incoming* document's name, which is how two
    // tabs both ended up called "Second" with one of them holding "First".
    useDocumentStore.getState().loadDocument(createDocument(1, 'First'), '/First.notex');
    useTabStore.getState().adoptCurrent();

    await openDocumentInTab(loadInto('Second', '/Second.notex'));

    const { tabs } = useTabStore.getState();
    expect(tabs.map((t) => t.title)).toEqual(['First', 'Second']);
    // And the tab still holds the document it is named after.
    expect(tabs[0]!.session!.document.title).toBe('First');
  });

  it('puts the document back when the loader opens nothing', async () => {
    useDocumentStore.getState().loadDocument(createDocument(1, 'First'), '/First.notex');
    useTabStore.getState().adoptCurrent();

    // A loader that overwrites the store and only then discovers it cannot
    // finish — which is how the PDF and notebook importers fail.
    const opened = await openDocumentInTab(async () => {
      useDocumentStore.getState().loadDocument(createDocument(1, 'half-open'), null);
      return false;
    });

    expect(opened).toBe(false);
    expect(useTabStore.getState().tabs).toHaveLength(1);
    expect(useDocumentStore.getState().document.title).toBe('First');
    expect(useDocumentStore.getState().filePath).toBe('/First.notex');
  });

  it('gives the open document a tab of its own when it had none', async () => {
    // Reachable only before a document view has mounted, but the alternative is
    // discarding real work to make room for the thing being opened.
    useDocumentStore.getState().loadDocument(createDocument(1, 'Unadopted'), '/Unadopted.notex');
    expect(useTabStore.getState().tabs).toHaveLength(0);

    await openDocumentInTab(loadInto('Opened', '/Opened.notex'));

    const { tabs, activeId } = useTabStore.getState();
    expect(tabs.map((t) => t.title)).toEqual(['Unadopted', 'Opened']);
    expect(tabs[0]!.session!.document.title).toBe('Unadopted');
    expect(activeId).toBe(tabs[1]!.id);
  });

  it('does not invent a tab for a blank document that had none', async () => {
    expect(useTabStore.getState().tabs).toHaveLength(0);
    await openDocumentInTab(loadInto('Opened', '/Opened.notex'));
    expect(useTabStore.getState().tabs.map((t) => t.title)).toEqual(['Opened']);
  });

  it('reuses a blank untouched tab rather than leaving it empty', async () => {
    useTabStore.getState().adoptCurrent();
    await openDocumentInTab(loadInto('Only', '/Only.notex'));
    expect(useTabStore.getState().tabs).toHaveLength(1);
    expect(useTabStore.getState().tabs[0]!.title).toBe('Only');
  });
});

describe('the reference pane', () => {
  function twoSaved(): { first: string; second: string } {
    useDocumentStore.getState().loadDocument(createDocument(1, 'Exercises'), '/Exercises.notex');
    const first = useTabStore.getState().adoptCurrent();
    const second = useTabStore.getState().openTab(sessionFor('Answers', '/Answers.notex'));
    return { first, second };
  }

  it('shows another tab beside the editor', async () => {
    const { first } = twoSaved();
    await useTabStore.getState().showInSplit(first);
    expect(useTabStore.getState().splitId).toBe(first);
    // The editor keeps its own document; the pane renders the other one.
    expect(useDocumentStore.getState().document.title).toBe('Answers');
  });

  it('refuses to show the document already being edited', async () => {
    const { second } = twoSaved();
    await useTabStore.getState().showInSplit(second);
    // `second` is active. Showing it would mean rendering a stale session beside
    // the live one.
    expect(useTabStore.getState().splitId).toBeNull();
  });

  it('closes the pane when its document becomes the one being edited', async () => {
    const { first } = twoSaved();
    await useTabStore.getState().showInSplit(first);
    await useTabStore.getState().activate(first);
    expect(useTabStore.getState().splitId).toBeNull();
  });

  it('closes the pane when its document is closed', async () => {
    const { first } = twoSaved();
    await useTabStore.getState().showInSplit(first);
    await useTabStore.getState().close(first);
    expect(useTabStore.getState().splitId).toBeNull();
  });

  it('keeps the shown document live, however old the tab', async () => {
    // The rule that makes the pane safe: parking a visible document would blank
    // it. `first` is the least recently used tab by a wide margin.
    const { first } = twoSaved();
    await useTabStore.getState().showInSplit(first);
    for (const name of ['c', 'd', 'e']) {
      useTabStore.getState().openTab(sessionFor(name, `/${name}.notex`));
    }
    await useTabStore.getState().park();

    const shown = useTabStore.getState().tabs.find((t) => t.id === first)!;
    expect(shown.session).not.toBeNull();
    expect(useTabStore.getState().splitId).toBe(first);
  });

  it('makes the shown document parkable again once the pane is closed', async () => {
    // Closing the pane does not force anything out — with three live tabs and a
    // budget of three there is nothing to do. What changes is eligibility: the
    // document is no longer pinned, so it is the first to go when the budget is
    // next exceeded, being the oldest.
    const { first } = twoSaved();
    await useTabStore.getState().showInSplit(first);
    for (const name of ['c', 'd', 'e']) {
      useTabStore.getState().openTab(sessionFor(name, `/${name}.notex`));
    }
    await useTabStore.getState().park();
    expect(useTabStore.getState().tabs.find((t) => t.id === first)!.session).not.toBeNull();

    useTabStore.getState().closeSplit();
    useTabStore.getState().openTab(sessionFor('f', '/f.notex'));
    await useTabStore.getState().park();
    expect(useTabStore.getState().tabs.find((t) => t.id === first)!.session).toBeNull();
  });

  it('reads a parked document back before showing it', async () => {
    const { first } = twoSaved();
    for (const name of ['c', 'd', 'e']) {
      useTabStore.getState().openTab(sessionFor(name, `/${name}.notex`));
    }
    await useTabStore.getState().park();
    expect(useTabStore.getState().tabs.find((t) => t.id === first)!.session).toBeNull();

    const reopened = createDocument(2, 'Exercises from disk');
    vi.doMock('../../desktop/fileService', () => ({ openDocumentFromPath: async () => ({ document: reopened }) }));
    await useTabStore.getState().showInSplit(first);
    vi.doUnmock('../../desktop/fileService');

    expect(useTabStore.getState().splitId).toBe(first);
    expect(useTabStore.getState().tabs.find((t) => t.id === first)!.session!.document.title).toBe('Exercises from disk');
    // And the editor was not disturbed.
    expect(useDocumentStore.getState().document.title).toBe('e');
  });

  it('clamps the divider to a usable range', () => {
    useTabStore.getState().setSplitRatio(0.9);
    expect(useTabStore.getState().splitRatio).toBe(0.75);
    useTabStore.getState().setSplitRatio(0.05);
    expect(useTabStore.getState().splitRatio).toBe(0.25);
    useTabStore.getState().setSplitRatio(0.5);
    expect(useTabStore.getState().splitRatio).toBe(0.5);
  });
});

describe('capture and restore', () => {
  it('round-trips the document store’s idea of an open document', () => {
    const doc = createDocument(2, 'Round trip');
    useDocumentStore.getState().loadDocument(doc, '/round.notex');
    const captured = captureSession();

    useDocumentStore.getState().newDocument();
    expect(useDocumentStore.getState().document.title).not.toBe('Round trip');

    restoreSession(captured);
    expect(useDocumentStore.getState().document.title).toBe('Round trip');
    expect(useDocumentStore.getState().filePath).toBe('/round.notex');
    expect(useDocumentStore.getState().savedPages).toBe(doc.pages);
  });

  it('carries the read-only lock with the tab', () => {
    useDocumentStore.getState().setReadOnly(true);
    const locked = captureSession();
    useDocumentStore.getState().setReadOnly(false);
    restoreSession(locked);
    expect(useDocumentStore.getState().readOnly).toBe(true);
  });
});

describe('a tab’s recorded label', () => {
  /**
   * Nothing watches the document store on behalf of tabs — see the note at the
   * bottom of `tabStore.ts`. A tab's label is written from the session captured
   * when it stops being active, so these assertions go through a transition
   * rather than through a sync, which is also how the app reaches them.
   */
  it('records the document’s title when the tab is left', () => {
    useDocumentStore.getState().loadDocument(createDocument(1, 'First'), '/First.notex');
    const first = useTabStore.getState().adoptCurrent();
    useDocumentStore.getState().setTitle('Renamed');

    useTabStore.getState().openTab(sessionFor('second', '/second.notex'));
    expect(useTabStore.getState().tabs.find((t) => t.id === first)!.title).toBe('Renamed');
  });

  it('records something for an untitled document', () => {
    useDocumentStore.getState().loadDocument(createDocument(1, 'First'), '/First.notex');
    const first = useTabStore.getState().adoptCurrent();
    useDocumentStore.getState().setTitle('   ');

    useTabStore.getState().openTab(sessionFor('second', '/second.notex'));
    expect(useTabStore.getState().tabs.find((t) => t.id === first)!.title).toBe('Untitled note');
  });

  it('records the tab as dirty when it is left with unsaved changes', () => {
    useDocumentStore.getState().loadDocument(createDocument(1, 'First'), '/First.notex');
    const first = useTabStore.getState().adoptCurrent();
    expect(useTabStore.getState().tabs[0]!.dirty).toBe(false);
    useDocumentStore.getState().setTitle('changed');

    useTabStore.getState().openTab(sessionFor('second', '/second.notex'));
    expect(useTabStore.getState().tabs.find((t) => t.id === first)!.dirty).toBe(true);
  });

  it('keeps an edited document out of the reuse rule', () => {
    // The live store, not the tab record, decides whether a tab is untouched —
    // so a renamed blank document is added to rather than replaced, even though
    // nothing has synced its record.
    useTabStore.getState().adoptCurrent();
    useDocumentStore.getState().setTitle('mine');
    useTabStore.getState().openTab(sessionFor('second', '/second.notex'));
    expect(useTabStore.getState().tabs.map((t) => t.title)).toEqual(['mine', 'second']);
  });
});
