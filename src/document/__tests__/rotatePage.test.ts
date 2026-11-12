import { beforeEach, describe, expect, it } from 'vitest';
import { makeStroke } from '../../inking/__tests__/testUtils';
import type { FreehandStroke } from '../../inking/types';
import { DEFAULT_TEXT_STYLE } from '../media';
import { createPage } from '../operations';
import { rotatePage } from '../rotatePage';
import { useDocumentStore } from '../store';
import type { Page, PdfPageRef, StickyNote, TextBox } from '../types';

const W = 800;
const H = 1100;
const note: StickyNote = { kind: 'note', id: 'n', x: 100, y: 200, width: 220, height: 100, rotation: 0, zIndex: 1, text: 'hi', color: '#fef08a' };
const pageText: TextBox = { kind: 'text', id: 't', x: 40, y: 40, width: W - 80, height: H - 80, rotation: 0, zIndex: 0, ...DEFAULT_TEXT_STYLE, text: 'words', flow: true };
const ref: PdfPageRef = { sourceId: 's', sourceName: 's.pdf', data: new ArrayBuffer(0), pageCount: 1, pageIndex: 0, viewBox: [0, 0, 600, 825], rotation: 0, scale: 4 / 3 };

function page(): Page {
  return createPage({
    dimensions: { width: W, height: H },
    strokes: [makeStroke([[10, 20], [30, 40]])],
    media: [note, pageText],
    formFields: [{ id: 'f', name: 'name', kind: 'text', box: { x: 50, y: 60, width: 200, height: 20 }, readOnly: false }],
  });
}
const points = (p: Page) => (p.strokes[0] as FreehandStroke).points.map(({ x, y }) => [x, y]);

describe('turning a page', () => {
  it('turns it into landscape with its ink, a quarter turn to the right', () => {
    const turned = rotatePage(page(), 1);
    expect(turned.dimensions).toEqual({ width: H, height: W });
    // The top-left corner goes to the top-right: (x, y) → (H − y, x).
    expect(points(turned)).toEqual([[H - 20, 10], [H - 40, 30]]);
  });

  it('turns what is placed on it about its own centre, and keeps the page text upright inside the margins', () => {
    const turned = rotatePage(page(), 1);
    const n = turned.media.find((m) => m.id === 'n')!;
    // The note's centre (210, 250) goes to (H − 250, 210).
    expect([n.x + n.width / 2, n.y + n.height / 2, n.rotation]).toEqual([H - 250, 210, 90]);
    const t = turned.media.find((m) => m.id === 't')!;
    expect(t.rotation).toBe(0);
    expect(t.width).toBeGreaterThan(t.height);
    expect(turned.formFields[0]!.box).toEqual({ x: H - 80, y: 50, width: 20, height: 200 });
  });

  it('turns back the way it came, and four turns are no turn at all', () => {
    const before = page();
    expect(points(rotatePage(rotatePage(before, 1), -1))).toEqual(points(before));
    const round = rotatePage(before, 4);
    expect(round).toBe(before);
    const four = [1, 1, 1, 1].reduce((p, q) => rotatePage(p, q), before);
    expect(points(four)).toEqual(points(before));
    expect(four.dimensions).toEqual(before.dimensions);
    expect(four.media.find((m) => m.id === 'n')).toMatchObject({ x: note.x, y: note.y, rotation: 0 });
  });

  it('turns a PDF page underneath by its display rotation', () => {
    const pdfPage = createPage({ template: 'pdf', pdf: ref, dimensions: { width: W, height: H } });
    expect(rotatePage(pdfPage, 1).pdf!.rotation).toBe(90);
    expect(rotatePage(pdfPage, -1).pdf!.rotation).toBe(270);
    expect(rotatePage(pdfPage, 2).pdf!.rotation).toBe(180);
  });

  it('keeps the page\'s own Undo in step with its ink', () => {
    const p = { ...page(), undoStack: [[makeStroke([[0, 0], [5, 0]])]] };
    const turned = rotatePage(p, 1);
    expect((turned.undoStack[0]![0] as FreehandStroke).points.map(({ x, y }) => [x, y])).toEqual([[H, 0], [H, 5]]);
  });
});

describe('turning pages in the note', () => {
  const s = () => useDocumentStore.getState();
  beforeEach(() => {
    s().setReadOnly(false);
    s().newDocument();
    s().appendPages([createPage({}, 2), createPage({}, 3)]);
  });

  it('turns the picked pages as one step for Undo, and only those', () => {
    const before = s().document.pages.map((p) => p.dimensions);
    s().rotatePages([0, 2], 1);
    const after = s().document.pages.map((p) => p.dimensions);
    expect(after[0]).toEqual({ width: before[0]!.height, height: before[0]!.width });
    expect(after[1]).toEqual(before[1]);
    expect(after[2]).toEqual({ width: before[2]!.height, height: before[2]!.width });
    expect(s().undoLast()).toBe('turning 2 pages');
    expect(s().document.pages.map((p) => p.dimensions)).toEqual(before);
  });

  it('does nothing for a whole turn, or in a locked note', () => {
    const pages = s().document.pages;
    s().rotatePages([0], 4);
    expect(s().document.pages).toBe(pages);
    s().setReadOnly(true);
    s().rotatePages([0], 1);
    expect(s().document.pages).toBe(pages);
  });
});
