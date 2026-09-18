import { describe, expect, it } from 'vitest';
import type { Stroke } from '../../inking/types';
import { PAGE_HISTORY_DEPTH } from '../constants';
import {
  appendStroke,
  clonePage,
  cloneStroke,
  createDocument,
  createPage,
  indexOfPage,
  insertPage,
  redoPage,
  removePage,
  removeStrokes,
  reorderPages,
  undoPage,
  withStrokes,
} from '../operations';
import type { Page } from '../types';

const freehand: Stroke = {
  kind: 'freehand',
  id: 'f1',
  tool: 'pen',
  points: [
    { x: 0, y: 0, pressure: 0.5 },
    { x: 10, y: 5, pressure: 0.7 },
  ],
  style: {
    color: '#000',
    size: 4,
    opacity: 1,
    compositeOperation: 'source-over',
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: false,
    taperStart: 0,
    taperEnd: 0,
    pattern: 'solid',
    arrowheads: 'none',
  },
  bbox: { minX: -4, minY: -4, maxX: 14, maxY: 9 },
  pointerType: 'pen',
  createdAt: 0,
};

const geometric: Stroke = {
  kind: 'geometric',
  id: 'g1',
  tool: 'line',
  shape: { type: 'line', from: { x: 0, y: 0 }, to: { x: 100, y: 50 } },
  style: { ...freehand.style, pattern: 'dashed', arrowheads: 'end' },
  bbox: { minX: -20, minY: -20, maxX: 120, maxY: 70 },
  pointerType: 'pen',
  createdAt: 0,
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function threePages(): readonly Page[] {
  return deepFreeze(createDocument(3).pages);
}

describe('reorderPages', () => {
  it('moves a page without mutating the input and renumbers', () => {
    const pages = threePages();
    const ids = pages.map((p) => p.id);
    const next = reorderPages(pages, 0, 2);
    expect(next).not.toBe(pages);
    expect(pages.map((p) => p.id)).toEqual(ids);
    expect(next.map((p) => p.id)).toEqual([ids[1], ids[2], ids[0]]);
    expect(next.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    // The moved page keeps its identity apart from the number.
    expect(next[2]?.strokes).toBe(pages[0]?.strokes);
  });

  it('is a renumbering no-op for equal indices and clamps out-of-range ones', () => {
    const pages = threePages();
    expect(reorderPages(pages, 1, 1).map((p) => p.id)).toEqual(pages.map((p) => p.id));
    expect(reorderPages(pages, 0, 99).map((p) => p.id)).toEqual([pages[1]?.id, pages[2]?.id, pages[0]?.id]);
    expect(reorderPages([], 0, 1)).toEqual([]);
  });
});

describe('insertPage / removePage', () => {
  it('inserts at an index and renumbers', () => {
    const pages = threePages();
    const extra = createPage();
    const next = insertPage(pages, 1, extra);
    expect(next).toHaveLength(4);
    expect(next[1]).toMatchObject({ id: extra.id, pageNumber: 2 });
    expect(next[3]?.pageNumber).toBe(4);
    expect(pages).toHaveLength(3);
  });

  it('never removes the last page', () => {
    const one = deepFreeze(createDocument(1).pages);
    const next = removePage(one, 0);
    expect(next).toHaveLength(1);
    expect(next[0]).toBe(one[0]);
    const pages = threePages();
    expect(removePage(pages, 1).map((p) => p.id)).toEqual([pages[0]?.id, pages[2]?.id]);
    expect(removePage(pages, 1).map((p) => p.pageNumber)).toEqual([1, 2]);
  });

  it('indexOfPage follows a page by id', () => {
    const pages = threePages();
    const moved = reorderPages(pages, 0, 2);
    expect(indexOfPage(moved, pages[0]?.id ?? '', 0)).toBe(2);
    expect(indexOfPage(moved, 'missing', 7)).toBe(2);
  });
});

describe('clonePage / cloneStroke', () => {
  it('deep-clones strokes with fresh ids and copies template settings', () => {
    const source = deepFreeze(withStrokes(createPage({ template: 'grid' }), [freehand, geometric]));
    const copy = clonePage(source);
    expect(copy.id).not.toBe(source.id);
    expect(copy.template).toBe('grid');
    expect(copy.templateConfig).toEqual(source.templateConfig);
    expect(copy.templateConfig).not.toBe(source.templateConfig);
    expect(copy.strokes).toHaveLength(2);
    copy.strokes.forEach((s, i) => {
      const original = source.strokes[i];
      expect(s).not.toBe(original);
      expect(s.id).not.toBe(original?.id);
    });
    const f = copy.strokes[0];
    const g = copy.strokes[1];
    if (f?.kind !== 'freehand' || g?.kind !== 'geometric') throw new Error('kinds');
    expect(f.points).toEqual(freehand.points);
    expect(f.points).not.toBe(freehand.points);
    expect(g.shape).toEqual(geometric.shape);
    expect(g.shape).not.toBe(geometric.shape);
    expect(copy.undoStack).toEqual([]);
    expect(copy.redoStack).toEqual([]);
  });

  it('clonePage copies images with fresh ids and form values by value', () => {
    const image = { kind: 'image' as const, id: 'img', src: 'data:,', mime: 'image/png', x: 0, y: 0, width: 10, height: 10, rotation: 0, zIndex: 1, naturalWidth: 10, naturalHeight: 10 };
    const source = createPage({ media: [image], formValues: { a: 'x' } });
    const copy = clonePage(source);
    expect(copy.media[0]?.id).not.toBe('img');
    expect(copy.media[0]).toMatchObject({ src: 'data:,', width: 10 });
    expect(copy.formValues).toEqual({ a: 'x' });
    expect(copy.formValues).not.toBe(source.formValues);
  });

  it('cloneStroke keeps style but never shares nested objects', () => {
    const c = cloneStroke(geometric);
    expect(c.style).toEqual(geometric.style);
    expect(c.style).not.toBe(geometric.style);
    expect(c.bbox).not.toBe(geometric.bbox);
  });
});

describe('page history', () => {
  it('records snapshots, undoes and redoes', () => {
    let page = createPage();
    page = appendStroke(page, freehand);
    page = appendStroke(page, geometric);
    expect(page.strokes.map((s) => s.id)).toEqual(['f1', 'g1']);
    expect(page.undoStack).toHaveLength(2);

    page = undoPage(page);
    expect(page.strokes.map((s) => s.id)).toEqual(['f1']);
    expect(page.redoStack).toHaveLength(1);
    page = redoPage(page);
    expect(page.strokes.map((s) => s.id)).toEqual(['f1', 'g1']);
    expect(page.redoStack).toHaveLength(0);
  });

  it('a new edit clears redo, and no-op edits are identity', () => {
    let page = appendStroke(createPage(), freehand);
    page = undoPage(page);
    expect(page.redoStack).toHaveLength(1);
    page = appendStroke(page, geometric);
    expect(page.redoStack).toHaveLength(0);
    expect(removeStrokes(page, new Set(['nope']))).toBe(page);
    const empty = createPage();
    expect(undoPage(empty)).toBe(empty);
    expect(redoPage(empty)).toBe(empty);
    const removed = removeStrokes(page, new Set(['g1']));
    expect(removed.strokes).toEqual([]);
    expect(removed.undoStack[removed.undoStack.length - 1]).toBe(page.strokes);
  });

  it('caps the undo depth', () => {
    let page = createPage();
    for (let i = 0; i < PAGE_HISTORY_DEPTH + 10; i++) {
      page = appendStroke(page, { ...freehand, id: `s${i}` });
    }
    expect(page.undoStack).toHaveLength(PAGE_HISTORY_DEPTH);
    expect(page.strokes).toHaveLength(PAGE_HISTORY_DEPTH + 10);
  });
});
