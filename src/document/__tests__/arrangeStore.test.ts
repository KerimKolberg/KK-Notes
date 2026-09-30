import { beforeEach, describe, expect, it } from 'vitest';
import { makeStroke } from '../../inking/__tests__/testUtils';
import { useClipboardStore } from '../clipboard';
import { useDocumentStore } from '../store';

const store = useDocumentStore;
const doc = () => store.getState().document;
const page = (i = 0) => doc().pages[i]!;
const strokes = (i = 0) => page(i).strokes;
const clipboard = () => useClipboardStore.getState();

/** A short bar at `x`, `y`. */
const bar = (x: number, y: number, w = 20) =>
  makeStroke([
    [x, y],
    [x + w, y],
  ]);

describe('grouping, lining up and copying a selection', () => {
  beforeEach(() => {
    store.getState().setReadOnly(false);
    store.getState().newDocument();
    clipboard().clear();
    const id = page().id;
    store.getState().commitStroke(id, bar(10, 10));
    store.getState().commitStroke(id, bar(60, 100, 40));
    store.getState().commitStroke(id, bar(200, 300, 30));
  });

  const ids = () => strokes().map((s) => s.id);

  describe('groups', () => {
    it('are made from two or more strokes, in one undo step', () => {
      const depth = page().undoStack.length;
      store.getState().groupSelection(page().id, ids().slice(0, 2));
      const [a, b, c] = strokes();
      expect(a!.groupId).toBeDefined();
      expect(a!.groupId).toBe(b!.groupId);
      expect(c!.groupId).toBeUndefined();
      expect(page().undoStack.length).toBe(depth + 1);
      store.getState().undo(page().id);
      expect(strokes().every((s) => s.groupId === undefined)).toBe(true);
    });

    it('are not made from one stroke', () => {
      const depth = page().undoStack.length;
      store.getState().groupSelection(page().id, ids().slice(0, 1));
      expect(page().undoStack.length).toBe(depth);
      expect(strokes()[0]!.groupId).toBeUndefined();
    });

    it('are taken apart again, in one undo step', () => {
      store.getState().groupSelection(page().id, ids().slice(0, 2));
      const depth = page().undoStack.length;
      store.getState().ungroupSelection(page().id, ids().slice(0, 2));
      expect(strokes().every((s) => s.groupId === undefined)).toBe(true);
      expect(page().undoStack.length).toBe(depth + 1);
      store.getState().undo(page().id);
      expect(strokes()[0]!.groupId).toBeDefined();
    });

    it('make a lasso that touches one member select them all', () => {
      const [a, b] = ids();
      store.getState().groupSelection(page().id, [a!, b!]);
      store.getState().setLassoSelection({ pageId: page().id, strokeIds: [a!] });
      expect(store.getState().lassoSelection?.strokeIds).toEqual([a, b]);
    });

    it('leave a selection of ungrouped strokes exactly as it was', () => {
      const pick = [ids()[2]!, ids()[0]!];
      store.getState().setLassoSelection({ pageId: page().id, strokeIds: pick });
      expect(store.getState().lassoSelection?.strokeIds).toEqual(pick);
    });

    it('survive a save and a reload of the page', () => {
      store.getState().groupSelection(page().id, ids().slice(0, 2));
      const copy = JSON.parse(JSON.stringify(strokes()));
      expect(copy[0].groupId).toBe(copy[1].groupId);
      expect(copy[0].groupId).toBeDefined();
    });
  });

  describe('lining up', () => {
    it('lines the left edges up as one undo step', () => {
      const depth = page().undoStack.length;
      store.getState().arrangeSelection(page().id, ids(), { kind: 'align', mode: 'left' });
      const left = Math.min(...strokes().map((s) => s.bbox.minX));
      expect(strokes().every((s) => Math.abs(s.bbox.minX - left) < 1e-6)).toBe(true);
      expect(page().undoStack.length).toBe(depth + 1);
      store.getState().undo(page().id);
      expect(strokes()[1]!.bbox.minX).toBeGreaterThan(left + 10);
    });

    it('changes nothing, and adds no undo step, when everything is already lined up', () => {
      store.getState().arrangeSelection(page().id, ids(), { kind: 'align', mode: 'left' });
      const depth = page().undoStack.length;
      store.getState().arrangeSelection(page().id, ids(), { kind: 'align', mode: 'left' });
      expect(page().undoStack.length).toBe(depth);
    });

    it('spreads three strokes evenly', () => {
      store.getState().arrangeSelection(page().id, ids(), { kind: 'distribute', axis: 'horizontal' });
      const [a, b, c] = strokes().map((s) => s.bbox);
      expect(b!.minX - a!.maxX).toBeCloseTo(c!.minX - b!.maxX, 4);
    });

    it('moves a group as one', () => {
      const [a, b, c] = ids();
      store.getState().groupSelection(page().id, [a!, b!]);
      const before = strokes().map((s) => s.bbox.minX);
      store.getState().arrangeSelection(page().id, [a!, b!, c!], { kind: 'align', mode: 'right' });
      const after = strokes().map((s) => s.bbox.minX);
      // The grouped two shifted by the same amount; their gap is as it was.
      expect(after[1]! - after[0]!).toBeCloseTo(before[1]! - before[0]!, 4);
    });
  });

  describe('copying and pasting', () => {
    it('copy puts the selection on the clipboard and changes nothing on the page', () => {
      const depth = page().undoStack.length;
      const before = strokes();
      store.getState().copySelection(page().id, ids().slice(0, 2));
      expect(clipboard().strokes).toHaveLength(2);
      expect(clipboard().sourcePageId).toBe(page().id);
      expect(strokes()).toBe(before);
      expect(page().undoStack.length).toBe(depth);
    });

    it('paste on the same page puts copies beside the originals and selects them', () => {
      store.getState().copySelection(page().id, ids().slice(0, 1));
      const original = strokes()[0]!;
      expect(store.getState().pasteSelection(page().id)).toBe(true);
      expect(strokes()).toHaveLength(4);
      const pasted = strokes()[3]!;
      expect(pasted.id).not.toBe(original.id);
      expect(pasted.bbox.minX).toBeGreaterThan(original.bbox.minX);
      expect(store.getState().lassoSelection).toEqual({ pageId: page().id, strokeIds: [pasted.id] });
    });

    it('pasting again steps the next copy further along instead of stacking it', () => {
      store.getState().copySelection(page().id, ids().slice(0, 1));
      store.getState().pasteSelection(page().id);
      store.getState().pasteSelection(page().id);
      const [, , , first, second] = strokes();
      expect(second!.bbox.minX).toBeGreaterThan(first!.bbox.minX);
    });

    it('paste is one undo step', () => {
      store.getState().copySelection(page().id, ids().slice(0, 1));
      const depth = page().undoStack.length;
      store.getState().pasteSelection(page().id);
      expect(page().undoStack.length).toBe(depth + 1);
      store.getState().undo(page().id);
      expect(strokes()).toHaveLength(3);
    });

    it('cut takes the strokes off the page and keeps them for pasting', () => {
      const [a] = strokes();
      store.getState().cutSelection(page().id, [a!.id]);
      expect(strokes()).toHaveLength(2);
      expect(clipboard().strokes.map((s) => s.id)).toEqual([a!.id]);
      store.getState().pasteSelection(page().id);
      expect(strokes()).toHaveLength(3);
    });

    it('paste on another page puts the copies in the same place', () => {
      store.getState().addPage('after');
      expect(doc().pages.length).toBeGreaterThan(1);
      const second = page(1).id;
      store.getState().copySelection(page().id, ids().slice(0, 1));
      const original = strokes()[0]!;
      store.getState().pasteSelection(second);
      const pasted = strokes(1).at(-1)!;
      expect(pasted.bbox.minX).toBeCloseTo(original.bbox.minX, 4);
      expect(pasted.bbox.minY).toBeCloseTo(original.bbox.minY, 4);
    });

    it('paste has nothing to do with an empty clipboard', () => {
      const before = strokes();
      expect(store.getState().pasteSelection(page().id)).toBe(false);
      expect(strokes()).toBe(before);
    });

    it('a pasted group is its own group', () => {
      const [a, b] = ids();
      store.getState().groupSelection(page().id, [a!, b!]);
      const original = strokes()[0]!.groupId;
      store.getState().copySelection(page().id, [a!, b!]);
      store.getState().pasteSelection(page().id);
      const [, , , p, q] = strokes();
      expect(p!.groupId).toBe(q!.groupId);
      expect(p!.groupId).not.toBe(original);
    });

    it('copy works while locked, and nothing else does', () => {
      store.getState().setReadOnly(true);
      store.getState().copySelection(page().id, ids().slice(0, 1));
      expect(clipboard().strokes).toHaveLength(1);
      const before = strokes();
      expect(store.getState().pasteSelection(page().id)).toBe(false);
      store.getState().cutSelection(page().id, ids().slice(0, 1));
      store.getState().groupSelection(page().id, ids().slice(0, 2));
      store.getState().arrangeSelection(page().id, ids(), { kind: 'align', mode: 'left' });
      expect(strokes()).toBe(before);
    });

    it('the clipboard is still there after switching to another document', () => {
      store.getState().copySelection(page().id, ids().slice(0, 2));
      store.getState().newDocument();
      expect(clipboard().strokes).toHaveLength(2);
      const target = page().id;
      expect(store.getState().pasteSelection(target)).toBe(true);
      expect(strokes()).toHaveLength(2);
    });
  });
});
