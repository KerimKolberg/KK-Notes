/**
 * PDF.js bootstrap. The worker is referenced through a Vite URL import so
 * the bundler emits it as a separate asset instead of trying to inline it.
 *
 * The *legacy* build is used on purpose: the modern build assumes very recent
 * engine built-ins (`Map.prototype.getOrInsertComputed` and friends) and
 * throws on browsers only a few releases old, while the legacy build carries
 * the polyfills for both the API and the worker.
 */
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/** Runtime assets staged by the `pdfjs-assets` Vite plugin. */
export const PDFJS_ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

/** Render every annotation except interactive form widgets (we overlay HTML controls). */
export const ANNOTATION_MODE_FORMS: number = pdfjsLib.AnnotationMode.ENABLE_FORMS;

/**
 * Open a PDF from bytes. PDF.js transfers the buffer it is given to its
 * worker, so we always hand it a copy and keep the original intact.
 */
export function openPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
    wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
    iccUrl: `${PDFJS_ASSET_BASE}iccs/`,
  });
  return task.promise;
}

export { pdfjsLib };
export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
