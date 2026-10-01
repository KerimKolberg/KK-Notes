import { beforeEach, describe, expect, it } from 'vitest';
import { makeStroke } from '../../inking/__tests__/testUtils';
import { createPage } from '../operations';
import { useDocumentStore } from '../store';
import { captureSession, restoreSession } from '../tabStore';
import { selectCanRedo, selectCanUndo } from '../undo';

const store = useDocumentStore;
const s = () => store.getState();
const doc = () => s().document;
const bar = () => makeStroke([[10, 10], [40, 10]]);
const incoming = (n: number) => Array.from({ length: n }, () => createPage({}, 1));

describe('undoing a change to a note\'s pages', () => {
  beforeEach(() => {
    s().setReadOnly(false);
    s().newDocument();
  });

  it('takes an import back, names it, and puts it back on Redo', () => {
    s().appendPages(incoming(3));
    expect(doc().pages.length).toBe(4);
    expect(s().undoLast()).toBe('adding 3 pages');
    expect(doc().pages.length).toBe(1);
    expect(s().redoLast()).toBe('adding 3 pages');
    expect(doc().pages.length).toBe(4);
  });

  it('names a single page by its number', () => {
    s().appendPages(incoming(1));
    expect(s().undoLast()).toBe('adding a page');
  });

  it('is also what undoes adding, duplicating, deleting and moving a page', () => {
    s().addPage('after', 0);
    expect(doc().pages.length).toBe(2);
    expect(s().undoLast()).toBe('adding a page');
    expect(doc().pages.length).toBe(1);

    s().duplicatePage(0);
    expect(s().undoLast()).toBe('duplicating a page');
    expect(doc().pages.length).toBe(1);

    s().appendPages(incoming(2));
    const ids = doc().pages.map((p) => p.id);
    s().deletePage(1);
    expect(doc().pages.length).toBe(2);
    expect(s().undoLast()).toBe('deleting a page');
    expect(doc().pages.map((p) => p.id)).toEqual(ids);

    s().movePage(0, 2);
    expect(doc().pages.map((p) => p.id)).not.toEqual(ids);
    expect(s().undoLast()).toBe('moving a page');
    expect(doc().pages.map((p) => p.id)).toEqual(ids);
  });

  it('puts the reader back on the page they were on', () => {
    s().appendPages(incoming(2));
    expect(doc().activePageIndex).toBe(1);
    s().undoLast();
    expect(doc().activePageIndex).toBe(0);
  });

  it('leaves the note saved when it goes back to what was saved', () => {
    const saved = doc().pages;
    s().markSaved();
    s().appendPages(incoming(1));
    expect(store.getState().savedPages).not.toBe(doc().pages);
    s().undoLast();
    expect(doc().pages).toBe(saved);
    expect(store.getState().savedPages).toBe(doc().pages);
  });

  describe('against strokes, whichever came last', () => {
    it('a stroke drawn before the import is undone after the import is', () => {
      s().commitStroke(doc().pages[0]!.id, bar());
      s().appendPages(incoming(2));
      expect(s().undoLast()).toBe('adding 2 pages');
      expect(doc().pages[0]!.strokes.length).toBe(1);
      expect(s().undoLast()).toBeNull();
      expect(doc().pages[0]!.strokes.length).toBe(0);
    });

    it('a stroke drawn after the import is undone before it', () => {
      s().appendPages(incoming(1));
      s().commitStroke(doc().pages[1]!.id, bar());
      expect(s().undoLast()).toBeNull();
      expect(doc().pages[1]!.strokes.length).toBe(0);
      expect(doc().pages.length).toBe(2);
      expect(s().undoLast()).toBe('adding a page');
      expect(doc().pages.length).toBe(1);
    });

    it('going back to an older page and undoing takes back the import, not that page\'s old stroke', () => {
      s().commitStroke(doc().pages[0]!.id, bar());
      s().appendPages(incoming(1));
      s().setActivePage(0);
      expect(s().undoLast()).toBe('adding a page');
      expect(doc().pages[0]!.strokes.length).toBe(1);
    });

    it('redo goes the other way round, newest first', () => {
      s().commitStroke(doc().pages[0]!.id, bar());
      s().appendPages(incoming(1));
      s().undoLast();
      s().undoLast();
      expect(doc().pages[0]!.strokes.length).toBe(0);
      expect(s().redoLast()).toBeNull();
      expect(doc().pages[0]!.strokes.length).toBe(1);
      expect(s().redoLast()).toBe('adding a page');
      expect(doc().pages.length).toBe(2);
    });
  });

  describe('Redo', () => {
    it('is gone once something new is done', () => {
      s().appendPages(incoming(2));
      s().undoLast();
      s().addPage('after', 0);
      expect(s().structureRedo.length).toBe(0);
      s().undoLast();
      // What can be redone is the page just added, not the import that was undone before it.
      expect(s().redoLast()).toBe('adding a page');
      expect(doc().pages.length).toBe(2);
      expect(s().redoLast()).toBeNull();
    });

    it('is not applied to a note that has moved on', () => {
      s().appendPages(incoming(2));
      s().undoLast();
      s().commitStroke(doc().pages[0]!.id, bar());
      expect(selectCanRedo(s())).toBe(false);
      expect(s().redoLast()).toBeNull();
      expect(doc().pages.length).toBe(1);
    });
  });

  it('does nothing in a locked note', () => {
    s().appendPages(incoming(1));
    s().setReadOnly(true);
    expect(s().undoLast()).toBeNull();
    expect(doc().pages.length).toBe(2);
  });

  it('does not run past what there is', () => {
    expect(s().undoLast()).toBeNull();
    expect(s().redoLast()).toBeNull();
    expect(doc().pages.length).toBe(1);
  });

  it('is offered by the buttons exactly when there is something to take back or put back', () => {
    expect(selectCanUndo(s())).toBe(false);
    expect(selectCanRedo(s())).toBe(false);
    s().appendPages(incoming(1));
    expect(selectCanUndo(s())).toBe(true);
    s().undoLast();
    expect(selectCanUndo(s())).toBe(false);
    expect(selectCanRedo(s())).toBe(true);
    s().redoLast();
    expect(selectCanRedo(s())).toBe(false);
  });

  it('starts afresh with each note opened, and stays with a note across tabs', () => {
    s().appendPages(incoming(1));
    const session = captureSession();
    s().newDocument();
    expect(selectCanUndo(s())).toBe(false);
    restoreSession(session);
    expect(selectCanUndo(s())).toBe(true);
    expect(s().undoLast()).toBe('adding a page');
    s().appendPages(incoming(1));
    s().loadDocument(doc(), null);
    expect(selectCanUndo(s())).toBe(false);
  });

  it('keeps only the most recent changes', () => {
    for (let i = 0; i < 40; i++) s().addPage('after', doc().pages.length - 1);
    expect(s().structureUndo.length).toBe(30);
  });
});

describe('a snip placed on a page', () => {
  beforeEach(() => {
    store.getState().setReadOnly(false);
    store.getState().newDocument();
  });

  it('is one thing to undo, and to redo', () => {
    const pageId = doc().pages[0]!.id;
    const image = {
      kind: 'image' as const,
      id: 'img_1',
      src: 'data:image/png;base64,AA',
      mime: 'image/png',
      x: 10,
      y: 10,
      width: 50,
      height: 50,
      rotation: 0,
      zIndex: 1,
      naturalWidth: 10,
      naturalHeight: 10,
    };
    s().addMediaUndoable(pageId, image, 'placing a snip');
    expect(doc().pages[0]!.media.length).toBe(1);
    expect(s().undoLast()).toBe('placing a snip');
    expect(doc().pages[0]!.media.length).toBe(0);
    expect(s().redoLast()).toBe('placing a snip');
    expect(doc().pages[0]!.media.length).toBe(1);
  });

  it('is not placed on a page that is not there, or in a locked note', () => {
    const before = doc();
    s().addMediaUndoable('nope', { kind: 'image', id: 'x', src: '', mime: '', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 1, naturalWidth: 1, naturalHeight: 1 }, 'x');
    expect(doc()).toBe(before);
    expect(s().structureUndo.length).toBe(0);
  });
});
