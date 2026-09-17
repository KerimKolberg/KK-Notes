/**
 * Cached PDF.js page rasters. Documents are parsed once per source and page
 * backgrounds are cached per (source, page, width) as ImageBitmaps.
 */
import { RasterCache } from '../document/raster/rasterCache';
import type { PdfPageRef } from '../document/types';
import { displaySizePoints } from './pdfCoords';

export { backgroundWidthBucket } from './pdfCoords';
import { ANNOTATION_MODE_FORMS, openPdfDocument, type PDFDocumentProxy } from './pdfjs';

const documents = new Map<string, Promise<PDFDocumentProxy>>();
const backgrounds = new RasterCache(24);
const inflight = new Map<string, Promise<ImageBitmap>>();

/** Reuse a document the importer already parsed. */
export function registerPdfDocument(sourceId: string, doc: PDFDocumentProxy): void {
  documents.set(sourceId, Promise.resolve(doc));
}

export function getPdfDocument(ref: Pick<PdfPageRef, 'sourceId' | 'data'>): Promise<PDFDocumentProxy> {
  let pending = documents.get(ref.sourceId);
  if (!pending) {
    pending = openPdfDocument(ref.data);
    pending.catch(() => documents.delete(ref.sourceId));
    documents.set(ref.sourceId, pending);
  }
  return pending;
}

export function pdfBackgroundKey(ref: PdfPageRef, targetWidth: number): string {
  return `${ref.sourceId}:${ref.pageIndex}:${Math.round(targetWidth)}`;
}

/** Cached raster of a PDF page (without form widgets) at `targetWidth` device px. */
export function renderPdfPageBitmap(ref: PdfPageRef, targetWidth: number): Promise<ImageBitmap> {
  const key = pdfBackgroundKey(ref, targetWidth);
  const cached = backgrounds.get(key);
  if (cached) return Promise.resolve(cached);
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const doc = await getPdfDocument(ref);
      const page = await doc.getPage(ref.pageIndex + 1);
      const display = displaySizePoints(ref.viewBox, ref.rotation);
      const viewport = page.getViewport({ scale: targetWidth / display.width, rotation: ref.rotation });
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
      await page.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
        annotationMode: ANNOTATION_MODE_FORMS,
      }).promise;
      const bitmap = canvas.transferToImageBitmap();
      backgrounds.set(key, bitmap);
      return bitmap;
    })();
    inflight.set(key, pending);
    pending.finally(() => inflight.delete(key)).catch(() => undefined);
  }
  return pending;
}
