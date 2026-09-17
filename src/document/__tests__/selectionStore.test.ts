import { beforeEach, describe, expect, it } from 'vitest';
import { makeLine, makeStroke } from '../../inking/__tests__/testUtils';
import { useDocumentStore } from '../store';

const store = useDocumentStore;
const pageId = (): string => store.getState().document.pages[0]!.id;
const strokes = () => store.getState().document.pages[0]!.strokes;
const page = () => store.getState().document.pages[0]!;

describe('lasso selection in the document store', () => {
  beforeEach(() => {
    store.getState().newDocument();
    const id = pageId();
    store.getState().commitStroke(id, makeStroke([[10, 10], [50, 50]]));
    store.getState().commitStroke(id, makeLine({ x: 100, y: 100 }, { x: 200, y: 100 }));
    store.getState().commitStroke(id, makeStroke([[300, 300], [320, 340]]));
  });

  it('transformSelection moves only the selected strokes and is one undo step', () => {
    const [a, b, c] = strokes();
    const ids = [a!.id, b!.id];
    store.getState().setLassoSelection({ pageId: pageId(), strokeIds: ids });
    const depth = page().undoStack.length;
    store.getState().transformSelection(pageId(), ids, { kind: 'translate', dx: 20, dy: 0 });
    const [a2, b2, c2] = strokes();
    expect(a2!.bbox.minX).toBeCloseTo(a!.bbox.minX + 20);
    expect(b2!.bbox.minX).toBeCloseTo(b!.bbox.minX + 20);
    expect(c2).toBe(c);
    expect(a2!.id).toBe(a!.id);
    expect(page().undoStack.length).toBe(depth + 1);
    // Selection survives its own edit and undo / redo.
    expect(store.getState().lassoSelection?.strokeIds).toEqual(ids);
    store.getState().undo(pageId());
    expect(strokes()[0]).toBe(a);
    expect(store.getState().lassoSelection?.strokeIds).toEqual(ids);
    store.getState().redo(pageId());
    expect(strokes()[0]!.bbox.minX).toBeCloseTo(a!.bbox.minX + 20);
  });

  it('restyleSelection changes colour / width and no-ops when nothing changes', () => {
    const ids = [strokes()[1]!.id];
    const depth = page().undoStack.length;
    store.getState().restyleSelection(pageId(), ids, { color: '#ff0000', size: 9 });
    expect(strokes()[1]!.style).toMatchObject({ color: '#ff0000', size: 9 });
    expect(strokes()[0]!.style.color).not.toBe('#ff0000');
    expect(page().undoStack.length).toBe(depth + 1);
    store.getState().restyleSelection(pageId(), ['missing-id'], { color: '#00ff00' });
    expect(page().undoStack.length).toBe(depth + 1);
  });

  it('duplicateSelection appends offset copies and selects them', () => {
    const ids = [strokes()[0]!.id, strokes()[2]!.id];
    store.getState().setLassoSelection({ pageId: pageId(), strokeIds: ids });
    store.getState().duplicateSelection(pageId(), ids);
    expect(strokes()).toHaveLength(5);
    const selection = store.getState().lassoSelection!;
    expect(selection.pageId).toBe(pageId());
    expect(selection.strokeIds).toHaveLength(2);
    expect(selection.strokeIds).not.toContain(ids[0]);
    const copy = strokes().find((s) => s.id === selection.strokeIds[0])!;
    expect(copy.bbox.minX).toBeCloseTo(strokes()[0]!.bbox.minX + 16);
    store.getState().undo(pageId());
    expect(strokes()).toHaveLength(3);
  });

  it('deleteSelection removes the strokes, clears the selection, and undo brings them back', () => {
    const ids = [strokes()[0]!.id, strokes()[1]!.id];
    store.getState().setLassoSelection({ pageId: pageId(), strokeIds: ids });
    store.getState().deleteSelection(pageId(), ids);
    expect(strokes()).toHaveLength(1);
    expect(store.getState().lassoSelection).toBeNull();
    store.getState().undo(pageId());
    expect(strokes()).toHaveLength(3);
    expect(strokes().map((s) => s.id)).toEqual(expect.arrayContaining(ids));
  });

  it('clearing the page or deleting it drops the selection; loading a document too', () => {
    store.getState().setLassoSelection({ pageId: pageId(), strokeIds: [strokes()[0]!.id] });
    store.getState().clearPage(pageId());
    expect(store.getState().lassoSelection).toBeNull();

    store.getState().addPage('after');
    const second = store.getState().document.pages[1]!;
    store.getState().commitStroke(second.id, makeStroke([[1, 1], [2, 2]]));
    store.getState().setLassoSelection({ pageId: second.id, strokeIds: [store.getState().document.pages[1]!.strokes[0]!.id] });
    store.getState().deletePage(0);
    expect(store.getState().lassoSelection?.pageId).toBe(second.id);
    store.getState().deletePage(0); // only page left: refused, selection kept
    expect(store.getState().lassoSelection?.pageId).toBe(second.id);
    store.getState().addPage('after');
    store.getState().deletePage(0);
    expect(store.getState().lassoSelection).toBeNull();

    store.getState().setLassoSelection({ pageId: pageId(), strokeIds: ['x'] });
    store.getState().newDocument();
    expect(store.getState().lassoSelection).toBeNull();
  });
});
