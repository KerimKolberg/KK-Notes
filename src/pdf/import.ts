/**
 * PDF ingestion: parse a file, describe its pages, and turn selected pages
 * into document pages that keep a reference to the source bytes.
 */
import { createStrokeId } from '../inking/engine/ids';
import { createPage } from '../document/operations';
import type { Page, PdfPageRef, PdfViewBox } from '../document/types';
import { extractFormFields, initialFormValues, type PdfAnnotationData } from './forms';
import { displaySizePoints, importedPageGeometry, normalizeRotation, type ImportSizeMode } from './pdfCoords';
import { openPdfDocument, type PDFDocumentProxy } from './pdfjs';
import { registerPdfDocument, renderPdfPageBitmap } from './pdfRenderer';

export interface PdfPageInfo {
  readonly index: number;
  readonly viewBox: PdfViewBox;
  readonly rotation: number;
  /** Display size in points. */
  readonly widthPt: number;
  readonly heightPt: number;
}

export interface LoadedPdf {
  readonly sourceId: string;
  readonly name: string;
  readonly data: ArrayBuffer;
  readonly doc: PDFDocumentProxy;
  readonly pages: readonly PdfPageInfo[];
}

export async function loadPdfData(data: ArrayBuffer, name: string): Promise<LoadedPdf> {
  const sourceId = `pdf_${createStrokeId()}`;
  const doc = await openPdfDocument(data);
  registerPdfDocument(sourceId, doc);
  const pages: PdfPageInfo[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
    const viewBox: PdfViewBox = [x0, y0, x1, y1];
    const rotation = normalizeRotation(page.rotate);
    const display = displaySizePoints(viewBox, rotation);
    pages.push({ index: i - 1, viewBox, rotation, widthPt: display.width, heightPt: display.height });
  }
  return { sourceId, name, data, doc, pages };
}

export async function loadPdfFile(file: File): Promise<LoadedPdf> {
  return loadPdfData(await file.arrayBuffer(), file.name);
}

export interface BuildPagesOptions {
  readonly sizeMode: ImportSizeMode;
  readonly backgroundColor?: string;
}

/** Build document pages for the given 0-based source page indices, in order. */
export async function buildPdfPages(loaded: LoadedPdf, indices: readonly number[], options: BuildPagesOptions): Promise<Page[]> {
  const pages: Page[] = [];
  for (const index of indices) {
    const info = loaded.pages[index];
    if (!info) continue;
    const page = await loaded.doc.getPage(index + 1);
    const annotations = (await page.getAnnotations({ intent: 'display' })) as PdfAnnotationData[];
    const geometry = importedPageGeometry(info.viewBox, info.rotation, options.sizeMode);
    const ref: PdfPageRef = {
      sourceId: loaded.sourceId,
      sourceName: loaded.name,
      data: loaded.data,
      pageCount: loaded.pages.length,
      pageIndex: index,
      viewBox: info.viewBox,
      rotation: info.rotation,
      scale: geometry.scale,
    };
    const formFields = extractFormFields(annotations, { viewBox: info.viewBox, rotation: info.rotation, scale: geometry.scale });
    pages.push(
      createPage({
        template: 'pdf',
        dimensions: geometry.dimensions,
        backgroundColor: options.backgroundColor ?? '#ffffff',
        pdf: ref,
        formFields,
        formValues: initialFormValues(formFields, annotations),
      }),
    );
  }
  return pages;
}

/** Thumbnail for the import dialog (goes through the shared background cache). */
export function renderPdfThumbnail(loaded: LoadedPdf, index: number, width: number): Promise<ImageBitmap> {
  const info = loaded.pages[index];
  if (!info) return Promise.reject(new Error(`No page ${index}`));
  const ref: PdfPageRef = {
    sourceId: loaded.sourceId,
    sourceName: loaded.name,
    data: loaded.data,
    pageCount: loaded.pages.length,
    pageIndex: index,
    viewBox: info.viewBox,
    rotation: info.rotation,
    scale: 1,
  };
  return renderPdfPageBitmap(ref, width);
}
