/**
 * PDF ↔ page coordinate math.
 *
 * PDF user space has its origin at the bottom-left of the page in points
 * (72 per inch); pages here use CSS px (96 per inch) with the origin at the
 * top-left. A PDF page may additionally carry a display rotation.
 */
import type { Point } from '../inking/types';
import { A4_DIMENSIONS } from '../document/constants';
import type { PageBox, PageDimensions, PdfViewBox } from '../document/types';

export const PDF_POINTS_PER_INCH = 72;
export const CSS_PX_PER_INCH = 96;
/** CSS px per PDF point when the physical size is preserved. */
export const PX_PER_POINT = CSS_PX_PER_INCH / PDF_POINTS_PER_INCH;

export type PdfRotation = 0 | 90 | 180 | 270;

export function normalizeRotation(deg: number): PdfRotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as PdfRotation;
}

/** Page size in points as displayed (after rotation). */
export function displaySizePoints(viewBox: PdfViewBox, rotation: number): { width: number; height: number } {
  const w = viewBox[2] - viewBox[0];
  const h = viewBox[3] - viewBox[1];
  const r = normalizeRotation(rotation);
  return r === 90 || r === 270 ? { width: h, height: w } : { width: w, height: h };
}

export type ImportSizeMode = 'preserve' | 'a4';

export interface ImportedPageGeometry {
  readonly dimensions: PageDimensions;
  /** Page px per PDF point. */
  readonly scale: number;
}

/**
 * Page dimensions for an imported PDF page. `preserve` keeps the physical
 * size (72 → 96 DPI); `a4` fits the page uniformly inside A4, anchored at the
 * top-left, so annotations and rasters share one scale factor.
 */
export function importedPageGeometry(viewBox: PdfViewBox, rotation: number, mode: ImportSizeMode): ImportedPageGeometry {
  const size = displaySizePoints(viewBox, rotation);
  if (mode === 'a4') {
    const scale = Math.min(A4_DIMENSIONS.width / size.width, A4_DIMENSIONS.height / size.height);
    return { dimensions: A4_DIMENSIONS, scale };
  }
  return {
    dimensions: { width: Math.round(size.width * PX_PER_POINT), height: Math.round(size.height * PX_PER_POINT) },
    scale: PX_PER_POINT,
  };
}

/** PDF user-space point → page-local px, honouring the display rotation. */
export function pdfPointToPage(x: number, y: number, viewBox: PdfViewBox, rotation: number, scale: number): Point {
  const [x0, y0, x1, y1] = viewBox;
  switch (normalizeRotation(rotation)) {
    case 0:
      return { x: (x - x0) * scale, y: (y1 - y) * scale };
    case 90:
      return { x: (y - y0) * scale, y: (x - x0) * scale };
    case 180:
      return { x: (x1 - x) * scale, y: (y - y0) * scale };
    case 270:
      return { x: (y1 - y) * scale, y: (x1 - x) * scale };
  }
}

/** Page-local px → PDF user-space point (inverse of `pdfPointToPage`). */
export function pagePointToPdf(px: number, py: number, viewBox: PdfViewBox, rotation: number, scale: number): Point {
  const [x0, y0, x1, y1] = viewBox;
  switch (normalizeRotation(rotation)) {
    case 0:
      return { x: x0 + px / scale, y: y1 - py / scale };
    case 90:
      return { x: x0 + py / scale, y: y0 + px / scale };
    case 180:
      return { x: x1 - px / scale, y: y0 + py / scale };
    case 270:
      return { x: x1 - py / scale, y: y1 - px / scale };
  }
}

/** Annotation rect `[llx, lly, urx, ury]` → page-local box at an explicit scale. */
export function pdfRectToPageBoxScaled(rect: readonly number[], viewBox: PdfViewBox, rotation: number, scale: number): PageBox {
  const [ax = 0, ay = 0, bx = 0, by = 0] = rect;
  const llx = Math.min(ax, bx);
  const urx = Math.max(ax, bx);
  const lly = Math.min(ay, by);
  const ury = Math.max(ay, by);
  const corners = [
    pdfPointToPage(llx, lly, viewBox, rotation, scale),
    pdfPointToPage(urx, lly, viewBox, rotation, scale),
    pdfPointToPage(urx, ury, viewBox, rotation, scale),
    pdfPointToPage(llx, ury, viewBox, rotation, scale),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * Annotation rect → page-local box for a page whose width spans the view box:
 *
 *     scale  = pageDimensions.width / viewBoxWidth
 *     x      = (rect[0] - x0) * scale
 *     y      = (y1 - rect[3]) * scale
 *     width  = (rect[2] - rect[0]) * scale
 *     height = (rect[3] - rect[1]) * scale
 *
 * Rotated pages go through the same corner mapping as the rest of the engine.
 */
export function pdfRectToPageBox(rect: readonly number[], viewBox: PdfViewBox, pageDimensions: PageDimensions, rotation = 0): PageBox {
  const scale = pageDimensions.width / displaySizePoints(viewBox, rotation).width;
  return pdfRectToPageBoxScaled(rect, viewBox, rotation, scale);
}

/** Quantise raster widths so zooming doesn't re-render a PDF page on every step. */
export function backgroundWidthBucket(cssWidth: number, dpr: number): number {
  return Math.min(4096, Math.max(128, Math.ceil((cssWidth * dpr) / 128) * 128));
}
