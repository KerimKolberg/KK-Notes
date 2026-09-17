import { describe, expect, it } from 'vitest';
import {
  PX_PER_POINT,
  displaySizePoints,
  importedPageGeometry,
  normalizeRotation,
  pagePointToPdf,
  pdfPointToPage,
  pdfRectToPageBox,
  pdfRectToPageBoxScaled,
} from '../pdfCoords';
import type { PdfViewBox } from '../../document/types';

const LETTER: PdfViewBox = [0, 0, 612, 792];

describe('pdfRectToPageBox (spec formula)', () => {
  it('maps a bottom-left PDF rect to a top-left page box with scale = width / viewBox width', () => {
    const page = { width: 794, height: Math.round(792 * (794 / 612)) };
    const scale = 794 / 612;
    // Field 100pt wide, 20pt tall, lower-left at (72, 700).
    const box = pdfRectToPageBox([72, 700, 172, 720], LETTER, page);
    expect(box.x).toBeCloseTo(72 * scale, 6);
    expect(box.y).toBeCloseTo((792 - 720) * scale, 6);
    expect(box.width).toBeCloseTo(100 * scale, 6);
    expect(box.height).toBeCloseTo(20 * scale, 6);
  });

  it('accounts for a view box that does not start at the origin', () => {
    const shifted: PdfViewBox = [20, 30, 632, 822];
    const box = pdfRectToPageBox([20, 802, 120, 822], shifted, { width: 612, height: 792 });
    expect(box).toEqual({ x: 0, y: 0, width: 100, height: 20 });
  });

  it('normalises reversed rect corners', () => {
    const a = pdfRectToPageBox([172, 720, 72, 700], LETTER, { width: 612, height: 792 });
    const b = pdfRectToPageBox([72, 700, 172, 720], LETTER, { width: 612, height: 792 });
    expect(a).toEqual(b);
  });

  it('rotates: with a 90° page the PDF bottom-left corner lands at the display top-left', () => {
    const box = pdfRectToPageBoxScaled([0, 0, 100, 20], LETTER, 90, 1);
    expect(box.x).toBeCloseTo(0);
    expect(box.y).toBeCloseTo(0);
    expect(box.width).toBeCloseTo(20);
    expect(box.height).toBeCloseTo(100);
    const display = displaySizePoints(LETTER, 90);
    expect(display).toEqual({ width: 792, height: 612 });
  });
});

describe('point projection', () => {
  it('round-trips through pdfPointToPage / pagePointToPdf for every rotation', () => {
    const viewBox: PdfViewBox = [10, 20, 622, 812];
    const scale = 1.3;
    for (const rotation of [0, 90, 180, 270]) {
      for (const p of [
        { x: 10, y: 20 },
        { x: 622, y: 812 },
        { x: 300.5, y: 400.25 },
      ]) {
        const page = pdfPointToPage(p.x, p.y, viewBox, rotation, scale);
        const back = pagePointToPdf(page.x, page.y, viewBox, rotation, scale);
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
        // Every projected point lies inside the rotated page.
        const size = displaySizePoints(viewBox, rotation);
        expect(page.x).toBeGreaterThanOrEqual(-1e-9);
        expect(page.x).toBeLessThanOrEqual(size.width * scale + 1e-9);
        expect(page.y).toBeGreaterThanOrEqual(-1e-9);
        expect(page.y).toBeLessThanOrEqual(size.height * scale + 1e-9);
      }
    }
  });

  it('flips y for unrotated pages', () => {
    expect(pdfPointToPage(0, 792, LETTER, 0, 1)).toEqual({ x: 0, y: 0 });
    expect(pdfPointToPage(612, 0, LETTER, 0, 1)).toEqual({ x: 612, y: 792 });
  });

  it('normalises rotation values', () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(0)).toBe(0);
  });
});

describe('importedPageGeometry', () => {
  it('preserve: 72 → 96 DPI', () => {
    const g = importedPageGeometry(LETTER, 0, 'preserve');
    expect(g.dimensions).toEqual({ width: 816, height: 1056 });
    expect(g.scale).toBe(PX_PER_POINT);
  });

  it('a4: uniform fit inside A4 with one scale for everything', () => {
    const g = importedPageGeometry(LETTER, 0, 'a4');
    expect(g.dimensions).toEqual({ width: 794, height: 1123 });
    expect(g.scale).toBeCloseTo(Math.min(794 / 612, 1123 / 792), 9);
    const landscape = importedPageGeometry([0, 0, 792, 612], 0, 'a4');
    expect(landscape.scale).toBeCloseTo(794 / 792, 9);
  });
});
