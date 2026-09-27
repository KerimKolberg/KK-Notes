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
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

/** Runtime assets staged by the `pdfjs-assets` Vite plugin. */
export const PDFJS_ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`;

/** Render every annotation except interactive form widgets (we overlay HTML controls). */
export const ANNOTATION_MODE_FORMS: number = pdfjsLib.AnnotationMode.ENABLE_FORMS;

/**
 * The loading task that produced each open document.
 *
 * `PDFDocumentProxy` has no `destroy` of its own — the *task* owns the transport
 * and the worker that holds the parsed file — and `openPdfDocument` returns only
 * the proxy, which every caller wants. Rather than change that signature, the
 * task is kept beside its proxy here so {@link destroyPdfDocument} can reach it.
 *
 * Weak, so a document nobody released still becomes collectable; this map is a
 * way to *find* the task, not a reason to keep one alive.
 */
const tasks = new WeakMap<PDFDocumentProxy, PDFDocumentLoadingTask>();

/**
 * Open a PDF from bytes. PDF.js transfers the buffer it is given to its
 * worker, so we always hand it a copy and keep the original intact.
 */
export async function openPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(data.slice(0)),
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
    wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
    iccUrl: `${PDFJS_ASSET_BASE}iccs/`,
  });
  const doc = await task.promise;
  tasks.set(doc, task);
  return doc;
}

/**
 * Tear a document down, worker copy included.
 *
 * `cleanup()` on its own releases page resources and fonts but leaves the parsed
 * file in the worker, which is the megabytes — so the task's `destroy()` is what
 * this wants, and `cleanup()` is only the fallback for a document that arrived
 * from somewhere without one.
 */
export async function destroyPdfDocument(doc: PDFDocumentProxy): Promise<void> {
  const task = tasks.get(doc);
  tasks.delete(doc);
  if (task) {
    await task.destroy();
    return;
  }
  await doc.cleanup();
}

export { pdfjsLib };
export type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
