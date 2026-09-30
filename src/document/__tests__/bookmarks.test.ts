import { beforeEach, describe, expect, it } from 'vitest';
import { bookmarkTitle, bookmarksOf, nextBookmark, withBookmark, MAX_BOOKMARK_LENGTH } from '../bookmarks';
import { clonePage, createDocument } from '../operations';
import { deserializeDocument, serializeDocument } from '../serialization';
import { useDocumentStore } from '../store';

const pagesOf = (n: number) => createDocument(n).pages;

describe('withBookmark', () => {
  it('marks a page, names it, and takes the mark away', () => {
    const [page] = pagesOf(1);
    const marked = withBookmark(page!, '');
    expect(marked.bookmark).toBe('');
    expect(withBookmark(marked, 'Chapter 2').bookmark).toBe('Chapter 2');
    const cleared = withBookmark(marked, null);
    expect('bookmark' in cleared).toBe(false);
  });

  it('gives back the same page when nothing changes', () => {
    const [page] = pagesOf(1);
    expect(withBookmark(page!, null)).toBe(page);
    const marked = withBookmark(page!, 'x');
    expect(withBookmark(marked, 'x')).toBe(marked);
  });

  it('keeps a name to a sensible length', () => {
    const [page] = pagesOf(1);
    expect(withBookmark(page!, 'x'.repeat(1000)).bookmark!.length).toBe(MAX_BOOKMARK_LENGTH);
  });
});

describe('bookmarksOf and friends', () => {
  const pages = pagesOf(5).map((p, i) => (i === 1 ? withBookmark(p, 'Intro') : i === 3 ? withBookmark(p, '') : p));

  it('lists the bookmarked pages in page order', () => {
    const list = bookmarksOf(pages);
    expect(list.map((b) => [b.pageIndex, b.label])).toEqual([
      [1, 'Intro'],
      [3, ''],
    ]);
    expect(list[0]!.pageId).toBe(pages[1]!.id);
  });

  it('names a bookmark, or falls back to its page', () => {
    expect(bookmarkTitle({ label: 'Intro', pageIndex: 1 })).toBe('Intro');
    expect(bookmarkTitle({ label: '  ', pageIndex: 3 })).toBe('Page 4');
  });

  it('goes to the next and previous bookmark, round the ends', () => {
    const list = bookmarksOf(pages);
    expect(nextBookmark(list, 0)?.pageIndex).toBe(1);
    expect(nextBookmark(list, 1)?.pageIndex).toBe(3);
    expect(nextBookmark(list, 3)?.pageIndex).toBe(1);
    expect(nextBookmark(list, 3, -1)?.pageIndex).toBe(1);
    expect(nextBookmark(list, 1, -1)?.pageIndex).toBe(3);
    expect(nextBookmark(list, 2, -1)?.pageIndex).toBe(1);
    expect(nextBookmark([], 0)).toBeNull();
    expect(nextBookmark(bookmarksOf([withBookmark(pagesOf(1)[0]!, '')]), 0)).toBeNull();
  });
});

describe('bookmarks in a saved note', () => {
  it('survive saving and opening, named or not, and stay off pages without one', () => {
    const doc = createDocument(3);
    const pages = doc.pages.map((p, i) => (i === 0 ? withBookmark(p, '') : i === 2 ? withBookmark(p, 'Last') : p));
    const back = deserializeDocument(serializeDocument({ ...doc, pages }));
    expect(back.pages.map((p) => p.bookmark)).toEqual(['', undefined, 'Last']);
  });

  it('are not copied when a page is duplicated', () => {
    const [page] = pagesOf(1);
    expect(clonePage(withBookmark(page!, 'x')).bookmark).toBeUndefined();
  });
});

describe('the store action', () => {
  beforeEach(() => useDocumentStore.getState().newDocument());

  it('bookmarks a page, marks the note as changed, and removes it', () => {
    const s = useDocumentStore.getState();
    const id = s.document.pages[0]!.id;
    const pristine = s.savedPages;
    s.setPageBookmark(id, 'Here');
    expect(useDocumentStore.getState().document.pages[0]!.bookmark).toBe('Here');
    expect(useDocumentStore.getState().document.pages).not.toBe(pristine);
    s.setPageBookmark(id, null);
    expect(useDocumentStore.getState().document.pages[0]!.bookmark).toBeUndefined();
  });

  it('does not touch a page\'s undo history', () => {
    const s = useDocumentStore.getState();
    const id = s.document.pages[0]!.id;
    s.setPageBookmark(id, '');
    expect(useDocumentStore.getState().document.pages[0]!.undoStack).toEqual([]);
  });

  it('does nothing in a locked note, or for a page that is not there', () => {
    const s = useDocumentStore.getState();
    const id = s.document.pages[0]!.id;
    s.setReadOnly(true);
    s.setPageBookmark(id, 'x');
    expect(useDocumentStore.getState().document.pages[0]!.bookmark).toBeUndefined();
    s.setReadOnly(false);
    const before = useDocumentStore.getState().document;
    s.setPageBookmark('no-such-page', 'x');
    expect(useDocumentStore.getState().document).toBe(before);
  });
});
