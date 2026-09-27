/**
 * Cached PDF.js page rasters. Documents are parsed once per source and page
 * backgrounds are cached per (source, page, width) as ImageBitmaps.
 */
import { RasterCache } from '../document/raster/rasterCache';
import type { PdfPageRef } from '../document/types';
import { displaySizePoints } from './pdfCoords';

export { backgroundWidthBucket } from './pdfCoords';
import { ANNOTATION_MODE_FORMS, destroyPdfDocument, openPdfDocument, type PDFDocumentProxy } from './pdfjs';

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

/**
 * Forget everything cached for one PDF source.
 *
 * Nothing used to call this, and nothing needed to: a document stayed open for
 * the life of the process, so a parsed PDF that was still cached was still
 * wanted. With several documents open at once that stops being true — every PDF
 * ever opened would stay parsed, and PDF.js holds the whole file plus its
 * structures, so a handful of lecture PDFs is a hundred megabytes nobody is
 * looking at.
 *
 * Three things go: the parsed document (destroyed, not merely dropped — PDF.js
 * owns a worker and buffers that a lost reference does not free), the page
 * rasters, and any render still in flight, whose result would otherwise
 * repopulate the cache moments after it was cleared.
 *
 * Safe to call for a source that was never opened. The caller decides *when* it
 * is safe, which is when no open document still refers to it.
 */
export function releasePdfSource(sourceId: string): void {
  const pending = documents.get(sourceId);
  documents.delete(sourceId);
  // Destroyed asynchronously and without waiting: the map entry is already gone,
  // so a later request re-opens from the bytes rather than racing this.
  pending?.then(destroyPdfDocument).catch(() => undefined);

  const prefix = `${sourceId}:`;
  backgrounds.deleteWithPrefix(prefix);
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) inflight.delete(key);
  }
}

/** How many page rasters are cached. For the tests and the profiler. */
export function cachedPdfBackgrounds(): number {
  return backgrounds.size;
}
