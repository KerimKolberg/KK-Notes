/**
 * JSON wire format. Strokes are already plain data (points, styles, shapes),
 * so a page serialises as-is minus its undo/redo stacks.
 */
import { DEFAULT_TEMPLATE_CONFIG, DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from './constants';
import { clampIndex, renumber } from './operations';
import type {
  Document,
  Page,
  ViewMode,
  PdfPageRef,
  SerializedDocument,
  SerializedPage,
  SerializedPdfSource,
} from './types';

/** Chunked base64 so multi-megabyte PDFs don't blow the argument limit of `String.fromCharCode`. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function toSerializablePage(page: Page): SerializedPage {
  return {
    id: page.id,
    dimensions: page.dimensions,
    template: page.template,
    templateConfig: page.templateConfig,
    backgroundColor: page.backgroundColor,
    strokes: page.strokes,
    ...(page.pdf
      ? {
          pdf: {
            sourceId: page.pdf.sourceId,
            pageIndex: page.pdf.pageIndex,
            viewBox: page.pdf.viewBox,
            rotation: page.pdf.rotation,
            scale: page.pdf.scale,
          },
        }
      : {}),
    ...(page.formFields.length > 0 ? { formFields: page.formFields } : {}),
    ...(Object.keys(page.formValues).length > 0 ? { formValues: page.formValues } : {}),
    ...(page.images.length > 0 ? { images: page.images } : {}),
  };
}

export function toSerializable(doc: Document): SerializedDocument {
  const pdfSources: Record<string, SerializedPdfSource> = {};
  for (const page of doc.pages) {
    const ref = page.pdf;
    if (ref && !pdfSources[ref.sourceId]) {
      pdfSources[ref.sourceId] = { name: ref.sourceName, pageCount: ref.pageCount, data: arrayBufferToBase64(ref.data) };
    }
  }
  return {
    version: 1,
    id: doc.id,
    title: doc.title,
    ...(doc.cover ? { cover: doc.cover } : {}),
    viewMode: doc.viewMode,
    zoom: doc.zoom,
    activePageIndex: doc.activePageIndex,
    pages: doc.pages.map(toSerializablePage),
    ...(Object.keys(pdfSources).length > 0 ? { pdfSources } : {}),
  };
}

export function fromSerializablePage(
  page: SerializedPage,
  index: number,
  sources: Readonly<Record<string, { name: string; pageCount: number; data: ArrayBuffer }>> = {},
): Page {
  let pdf: PdfPageRef | undefined;
  if (page.pdf) {
    const source = sources[page.pdf.sourceId];
    if (!source) throw new Error(`Missing PDF source ${page.pdf.sourceId}`);
    pdf = {
      sourceId: page.pdf.sourceId,
      sourceName: source.name,
      data: source.data,
      pageCount: source.pageCount,
      pageIndex: page.pdf.pageIndex,
      viewBox: page.pdf.viewBox,
      rotation: page.pdf.rotation,
      scale: page.pdf.scale,
    };
  }
  return {
    id: page.id,
    pageNumber: index + 1,
    dimensions: page.dimensions,
    template: page.template,
    templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, ...page.templateConfig },
    backgroundColor: page.backgroundColor,
    strokes: page.strokes,
    undoStack: [],
    redoStack: [],
    ...(pdf ? { pdf } : {}),
    formFields: page.formFields ?? [],
    formValues: page.formValues ?? {},
    images: page.images ?? [],
  };
}

/** Accept the legacy two-mode values written before horizontal scrolling. */
export function normalizeViewMode(value: unknown): ViewMode {
  switch (value) {
    case 'horizontal-continuous':
      return 'horizontal-continuous';
    case 'single-page':
    case 'single':
      return 'single-page';
    default:
      return 'vertical-continuous';
  }
}

export function fromSerializable(data: SerializedDocument): Document {
  if (data.version !== 1) throw new Error(`Unsupported document version ${String(data.version)}`);
  if (!Array.isArray(data.pages) || data.pages.length === 0) throw new Error('A document needs at least one page');
  const sources: Record<string, { name: string; pageCount: number; data: ArrayBuffer }> = {};
  for (const [id, source] of Object.entries(data.pdfSources ?? {})) {
    sources[id] = { name: source.name, pageCount: source.pageCount, data: base64ToArrayBuffer(source.data) };
  }
  const pages = renumber(data.pages.map((page, index) => fromSerializablePage(page, index, sources)));
  const zoom = Number.isFinite(data.zoom) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, data.zoom)) : DEFAULT_ZOOM;
  return {
    id: data.id,
    title: data.title,
    ...(data.cover ? { cover: data.cover } : {}),
    pages,
    activePageIndex: clampIndex(data.activePageIndex, pages.length),
    viewMode: normalizeViewMode(data.viewMode),
    zoom,
  };
}

export function serializeDocument(doc: Document): string {
  return JSON.stringify(toSerializable(doc));
}

export function deserializeDocument(json: string): Document {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid document JSON');
  return fromSerializable(parsed as SerializedDocument);
}
