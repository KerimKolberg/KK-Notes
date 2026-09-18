import { beforeEach, describe, expect, it } from 'vitest';
import { makeLine, makeStroke } from '../../inking/__tests__/testUtils';
import { createStickyNote, createTable } from '../media';
import { useDocumentStore } from '../store';

const store = useDocumentStore;
const pages = () => store.getState().document.pages;
const page = (i = 0) => pages()[i]!;

/** A page's worth of mixed ink: pen, highlighter, tape and a geometric line. */
function inkUp(pageId: string): void {
  store.getState().commitStroke(pageId, makeStroke([[10, 10], [60, 60]]));
  store.getState().commitStroke(pageId, makeStroke([[0, 30], [90, 30]], { tool: 'highlighter' }));
  store.getState().commitStroke(pageId, makeStroke([[0, 70], [90, 70]], { tool: 'washi-tape' }));
  store.getState().commitStroke(pageId, makeLine({ x: 5, y: 5 }, { x: 40, y: 80 }));
}

describe('clearing a page', () => {
  beforeEach(() => {
    store.getState().setReadOnly(false);
    store.getState().newDocument();
    inkUp(page().id);
  });

  it('removes every stroke and leaves one undo step behind', () => {
    const depth = page().undoStack.length;
    store.getState().clearPageInk(page().id);
    expect(page().strokes).toHaveLength(0);
    expect(page().undoStack.length).toBe(depth + 1);
    store.getState().undo(page().id);
    expect(page().strokes).toHaveLength(4);
  });

  it('removes only the filtered layer when the eraser is narrowed', () => {
    store.getState().clearPageInk(page().id, 'highlighter');
    expect(page().strokes.map((s) => (s.kind === 'freehand' ? s.tool : s.shape.type))).toEqual(['pen', 'washi-tape', 'line']);

    store.getState().clearPageInk(page().id, 'washi-tape');
    expect(page().strokes.map((s) => (s.kind === 'freehand' ? s.tool : s.shape.type))).toEqual(['pen', 'line']);
  });

  it('leaves images, notes and tables alone — they are not ink', () => {
    const id = page().id;
    store.getState().addMedia(id, createStickyNote(page().dimensions, 1));
    store.getState().addMedia(id, createTable(page().dimensions, 2));
    store.getState().clearPageInk(id);
    expect(page().strokes).toHaveLength(0);
    expect(page().media.map((m) => m.kind)).toEqual(['note', 'table']);
  });

  it('does nothing at all when the filter matches nothing', () => {
    store.getState().clearPageInk(page().id, 'highlighter');
    const before = store.getState().document;
    store.getState().clearPageInk(page().id, 'highlighter');
    expect(store.getState().document).toBe(before);
  });

  it('is refused while the document is locked', () => {
    store.getState().setReadOnly(true);
    store.getState().clearPageInk(page().id);
    expect(page().strokes).toHaveLength(4);
  });
});

describe('clearing the whole document', () => {
  beforeEach(() => {
    store.getState().setReadOnly(false);
    store.getState().newDocument();
    store.getState().addPage('after');
    store.getState().addPage('after');
    for (const p of pages()) inkUp(p.id);
  });

  it('empties every page, each one step from where it was', () => {
    const depths = pages().map((p) => p.undoStack.length);
    store.getState().clearDocumentInk();

    expect(pages()).toHaveLength(3);
    for (const [i, p] of pages().entries()) {
      expect(p.strokes).toHaveLength(0);
      // Per-page history, so undoing any page brings that page's ink back.
      expect(p.undoStack.length).toBe(depths[i]! + 1);
    }
    store.getState().undo(page(1).id);
    expect(page(1).strokes).toHaveLength(4);
    expect(page(0).strokes).toHaveLength(0);
  });

  it('applies the eraser filter across all of them', () => {
    store.getState().clearDocumentInk('washi-tape');
    for (const p of pages()) {
      expect(p.strokes.map((s) => (s.kind === 'freehand' ? s.tool : 'geometric'))).toEqual(['pen', 'highlighter', 'geometric']);
    }
  });

  it('skips pages the filter does not touch, so they keep their history', () => {
    // Only page 0 gets a second highlight; clearing highlighter still has to
    // leave a page with none of them completely untouched…
    store.getState().clearDocumentInk('highlighter');
    const cleared = pages();
    const depths = cleared.map((p) => p.undoStack.length);

    const before = store.getState().document;
    store.getState().clearDocumentInk('highlighter');
    // …and a second pass changes nothing anywhere, object identity included.
    expect(store.getState().document).toBe(before);
    expect(pages().map((p) => p.undoStack.length)).toEqual(depths);
  });

  it('is refused while the document is locked', () => {
    store.getState().setReadOnly(true);
    store.getState().clearDocumentInk();
    for (const p of pages()) expect(p.strokes).toHaveLength(4);
  });
});
