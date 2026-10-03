/**
 * JSON wire format. Strokes are already plain data (points, styles, shapes),
 * so a page serialises as-is minus its undo/redo stacks.
 */
import { DEFAULT_TEMPLATE_CONFIG, DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from './constants';
import { normalizeInkText } from '../handwriting/inkText';
import { base64Ascii, decodeBase64, encodeBase64 } from '../lib/base64';
import { clampIndex, renumber } from './operations';
import type {
  Document,
  InkText,
  MediaObject,
  Recording,
  RecordingMark,
  Page,
  ViewMode,
  PdfPageRef,
  SerializedDocument,
  SerializedPage,
  SerializedPdfSource,
} from './types';

/** The base64 of a buffer. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return encodeBase64(new Uint8Array(buffer));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const bytes = decodeBase64(base64);
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
}

/**
 * The base64 of an embedded file's bytes (a PDF, a recording), worked out once per buffer, as text or as the bytes
 * that are written to disk.
 *
 * An autosave used to re-encode every PDF in the document each time it ran, which for a textbook is megabytes of work
 * on the main thread — to write out bytes that had not changed since the last save. The buffers are never modified
 * (they are the bytes the file was opened with, or a finished recording), so identity is the key.
 */
const base64Text = new WeakMap<ArrayBuffer, string>();
function cachedBase64(buffer: ArrayBuffer): string {
  let text = base64Text.get(buffer);
  if (text === undefined) {
    text = arrayBufferToBase64(buffer);
    base64Text.set(buffer, text);
  }
  return text;
}
const base64Bytes = new WeakMap<ArrayBuffer, Uint8Array>();
function cachedBase64Bytes(buffer: ArrayBuffer): Uint8Array {
  let bytes = base64Bytes.get(buffer);
  if (bytes === undefined) {
    bytes = base64Ascii(new Uint8Array(buffer));
    base64Bytes.set(buffer, bytes);
  }
  return bytes;
}

/**
 * Media as this version models it. Files written before notes and tables
 * existed carry an `images` array whose entries have no `kind`, so they are
 * tagged on the way in; nothing else about them changed.
 */
function mediaOf(page: SerializedPage): MediaObject[] {
  if (page.media) return [...page.media];
  return (page.images ?? []).map((image) => ({ ...image, kind: 'image' }) as MediaObject);
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
    ...(page.media.length > 0 ? { media: page.media } : {}),
    ...(page.bookmark !== undefined ? { bookmark: page.bookmark } : {}),
    ...(page.inkText ? { inkText: page.inkText } : {}),
  };
}

export function toSerializable(doc: Document): SerializedDocument {
  const pdfSources: Record<string, SerializedPdfSource> = {};
  for (const page of doc.pages) {
    const ref = page.pdf;
    if (ref && !pdfSources[ref.sourceId]) {
      pdfSources[ref.sourceId] = { name: ref.sourceName, pageCount: ref.pageCount, data: cachedBase64(ref.data) };
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
    ...(doc.recordings && doc.recordings.length > 0
      ? {
          recordings: doc.recordings.map((r) => ({
            id: r.id,
            startedAt: r.startedAt,
            duration: r.duration,
            mime: r.mime,
            data: cachedBase64(r.data),
            marks: r.marks,
          })),
        }
      : {}),
  };
}

/** Recordings as a file has them, checked; one that is not a recording is left out rather than failing the note. */
function recordingsOf(raw: unknown): Recording[] {
  if (!Array.isArray(raw)) return [];
  const out: Recording[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.data !== 'string' || typeof r.mime !== 'string') continue;
    let data: ArrayBuffer;
    try {
      data = base64ToArrayBuffer(r.data);
    } catch {
      continue;
    }
    const marks: RecordingMark[] = [];
    if (Array.isArray(r.marks)) {
      for (const m of r.marks) {
        const mark = m as { strokeId?: unknown; t?: unknown } | null;
        if (mark && typeof mark.strokeId === 'string' && typeof mark.t === 'number' && Number.isFinite(mark.t) && mark.t >= 0) {
          marks.push({ strokeId: mark.strokeId, t: mark.t });
        }
      }
    }
    out.push({
      id: r.id,
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : new Date(0).toISOString(),
      duration: typeof r.duration === 'number' && Number.isFinite(r.duration) && r.duration >= 0 ? r.duration : 0,
      mime: r.mime,
      data,
      marks,
    });
  }
  return out;
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
    media: mediaOf(page),
    ...(typeof page.bookmark === 'string' ? { bookmark: page.bookmark.slice(0, 200) } : {}),
    ...withInkText(page.inkText),
  };
}

/** A page's handwritten words as the file has them, checked: a file from elsewhere is not trusted to be right. */
function withInkText(raw: unknown): { inkText?: InkText } {
  const inkText = normalizeInkText(raw);
  return inkText ? { inkText } : {};
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
    ...withRecordings(recordingsOf(data.recordings)),
  };
}

function withRecordings(recordings: Recording[]): { recordings?: readonly Recording[] } {
  return recordings.length > 0 ? { recordings } : {};
}

// ---------------------------------------------------------------------------
// Writing: the JSON assembled from pieces
// ---------------------------------------------------------------------------

/**
 * A stretch of a document's JSON: text, the base64 of an embedded file's bytes, or a page.
 *
 * A note's JSON is mostly things that have not changed since the last save — every page but the one written on, and
 * the PDFs and recordings, which never change — so it is put together from pieces that are each worked out once and
 * kept: a page's JSON once per page object (pages are immutable; every edit makes a new one and shares the rest), an
 * embedded file's base64 once per buffer. Autosave runs a second and a half after every burst of writing; serialising
 * the whole note each time cost about a tenth of a second per hundred thousand points, and escaping a textbook's
 * base64 again cost more than that, stalls that landed in the middle of the next stroke. Now a save costs the page
 * that changed, and the bytes are copied, not re-encoded.
 */
export type JsonPiece = string | { readonly base64: ArrayBuffer } | { readonly page: Page };

/** A recording's JSON either side of its audio, once per recording. */
const recordingJson = new WeakMap<Recording, readonly [string, string]>();
function recordingPieces(r: Recording): readonly [string, string] {
  let pieces = recordingJson.get(r);
  if (!pieces) {
    const head = `{"id":${JSON.stringify(r.id)},"startedAt":${JSON.stringify(r.startedAt)},"duration":${JSON.stringify(r.duration)},"mime":${JSON.stringify(r.mime)},"data":"`;
    pieces = [head, `","marks":${JSON.stringify(r.marks)}}`];
    recordingJson.set(r, pieces);
  }
  return pieces;
}

/** The document's JSON as pieces: what `JSON.stringify(toSerializable(doc))` gives, with the pages last. */
export function documentPieces(doc: Document): JsonPiece[] {
  const head = JSON.stringify({
    version: 1,
    id: doc.id,
    title: doc.title,
    ...(doc.cover ? { cover: doc.cover } : {}),
    viewMode: doc.viewMode,
    zoom: doc.zoom,
    activePageIndex: doc.activePageIndex,
  });
  const out: JsonPiece[] = [head.slice(0, -1)];
  const sources = new Set<string>();
  for (const page of doc.pages) {
    const ref = page.pdf;
    if (!ref || sources.has(ref.sourceId)) continue;
    out.push(
      `${sources.size === 0 ? ',"pdfSources":{' : ','}${JSON.stringify(ref.sourceId)}:{"name":${JSON.stringify(ref.sourceName)},"pageCount":${JSON.stringify(ref.pageCount)},"data":"`,
      { base64: ref.data },
      '"}',
    );
    sources.add(ref.sourceId);
  }
  if (sources.size > 0) out.push('}');
  if (doc.recordings && doc.recordings.length > 0) {
    out.push(',"recordings":[');
    doc.recordings.forEach((r, i) => {
      const [before, after] = recordingPieces(r);
      out.push(i === 0 ? before : `,${before}`, { base64: r.data }, after);
    });
    out.push(']');
  }
  out.push(',"pages":[');
  doc.pages.forEach((page, i) => {
    if (i > 0) out.push(',');
    out.push({ page });
  });
  out.push(']}');
  return out;
}

/** A page as JSON text, worked out once per page object (see `JsonPiece`). */
const pageJson = new WeakMap<Page, string>();
export function serializePageJson(page: Page): string {
  let json = pageJson.get(page);
  if (json === undefined) {
    json = JSON.stringify(toSerializablePage(page));
    pageJson.set(page, json);
  }
  return json;
}

const utf8 = new TextEncoder();

/** A page as UTF-8 JSON, worked out once per page object; kept apart from the text so only one is ever held. */
const pageBytes = new WeakMap<Page, Uint8Array>();
function serializePageBytes(page: Page): Uint8Array {
  let bytes = pageBytes.get(page);
  if (bytes === undefined) {
    bytes = utf8.encode(pageJson.get(page) ?? JSON.stringify(toSerializablePage(page)));
    pageBytes.set(page, bytes);
  }
  return bytes;
}

/** The pieces as text. */
export function piecesToText(pieces: readonly JsonPiece[]): string {
  let out = '';
  for (const piece of pieces) {
    out += typeof piece === 'string' ? piece : 'page' in piece ? serializePageJson(piece.page) : cachedBase64(piece.base64);
  }
  return out;
}

/** The pieces as the UTF-8 bytes of that text: what is written to disk, without the text ever being made. */
export function piecesToBytes(pieces: readonly JsonPiece[]): Uint8Array {
  const parts = pieces.map((piece) =>
    typeof piece === 'string' ? utf8.encode(piece) : 'page' in piece ? serializePageBytes(piece.page) : cachedBase64Bytes(piece.base64),
  );
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * The document as JSON text, byte-for-byte what `JSON.stringify(toSerializable(doc))` gives apart from where the
 * pages come (last), assembled from pieces that are reused when they have not changed.
 */
export function serializeDocumentJson(doc: Document): string {
  return piecesToText(documentPieces(doc));
}

export function serializeDocument(doc: Document): string {
  return serializeDocumentJson(doc);
}

export function deserializeDocument(json: string): Document {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid document JSON');
  return fromSerializable(parsed as SerializedDocument);
}
