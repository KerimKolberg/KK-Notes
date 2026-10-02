/**
 * A PDF's own table of contents (its "outline", or bookmarks in most readers), for jumping to a chapter.
 *
 * Read with PDF.js, which already holds the file parsed for drawing it, and kept per source: an outline does not
 * change, and the contents list asks for it every time it opens. Each entry is resolved to the page it points at
 * (and how far down that page, when the PDF says), so the list can be drawn without waiting on PDF.js again.
 */
import type { PdfPageRef } from '../document/types';

/** One entry, its page resolved. */
export interface OutlineItem {
  readonly title: string;
  /** 0-based page of the PDF, or `null` for an entry that points nowhere in it (a web link, a broken target). */
  readonly pdfPageIndex: number | null;
  /** How far down the page, as a PDF user-space y (points, origin at the bottom); `null` for the page's top. */
  readonly top: number | null;
  readonly items: readonly OutlineItem[];
}

/** What of PDF.js's outline entries is read here. */
interface RawOutlineItem {
  readonly title?: unknown;
  readonly dest?: unknown;
  readonly items?: readonly RawOutlineItem[] | null;
}

/** The part of a PDF.js document an outline is read from; small, so the tests can stand one up. */
export interface OutlineDocument {
  getOutline(): Promise<readonly RawOutlineItem[] | null>;
  getDestination(id: string): Promise<readonly unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
  readonly numPages: number;
}

/** Entries looked at in one outline, at most: a PDF with more is not a table of contents anyone reads. */
const MAX_ITEMS = 2000;
const MAX_DEPTH = 8;

function isRef(value: unknown): value is { num: number; gen: number } {
  return typeof value === 'object' && value !== null && typeof (value as { num?: unknown }).num === 'number';
}

/**
 * Where a destination points: the page, and the y it scrolls to when the destination names one. A destination is
 * either a name, looked up in the document, or an explicit array `[page, {name: kind}, ...args]`, where `page` is a
 * reference to a page object (or, in some files, its 0-based number) and `kind` says what the numbers after it are.
 */
export async function resolveDestination(
  doc: OutlineDocument,
  dest: unknown,
): Promise<{ pdfPageIndex: number | null; top: number | null }> {
  const none = { pdfPageIndex: null, top: null };
  let explicit: readonly unknown[] | null = null;
  try {
    if (typeof dest === 'string') explicit = await doc.getDestination(dest);
    else if (Array.isArray(dest)) explicit = dest;
  } catch {
    return none;
  }
  if (!explicit || explicit.length === 0) return none;
  const target = explicit[0];
  let pdfPageIndex: number | null = null;
  try {
    if (isRef(target)) pdfPageIndex = await doc.getPageIndex(target);
    else if (typeof target === 'number' && Number.isInteger(target)) pdfPageIndex = target;
  } catch {
    return none;
  }
  if (pdfPageIndex === null || pdfPageIndex < 0 || pdfPageIndex >= doc.numPages) return none;

  const kind = (explicit[1] as { name?: unknown } | undefined)?.name;
  // `[page, /XYZ, left, top, zoom]` and `[page, /FitH, top]` (and their bounding-box twins) say how far down.
  const raw = kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : null;
  const top = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  return { pdfPageIndex, top };
}

/** A document's outline with every entry resolved; empty when it has none. */
export async function resolveOutline(doc: OutlineDocument): Promise<OutlineItem[]> {
  const raw = await doc.getOutline();
  if (!raw || raw.length === 0) return [];
  let budget = MAX_ITEMS;
  const walk = async (items: readonly RawOutlineItem[], depth: number): Promise<OutlineItem[]> => {
    const out: OutlineItem[] = [];
    for (const item of items) {
      if (budget-- <= 0) break;
      const title = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '';
      const where = await resolveDestination(doc, item.dest);
      const children = depth < MAX_DEPTH && item.items && item.items.length > 0 ? await walk(item.items, depth + 1) : [];
      if (!title && children.length === 0) continue;
      out.push({ title: title || 'Untitled', ...where, items: children });
    }
    return out;
  };
  return walk(raw, 0);
}

const MAX_CACHED = 32;
const cache = new Map<string, Promise<OutlineItem[]>>();

/** The outline of the PDF a page came from, read once per source. */
export function pdfOutline(ref: Pick<PdfPageRef, 'sourceId' | 'data'>): Promise<OutlineItem[]> {
  const cached = cache.get(ref.sourceId);
  if (cached) return cached;
  const pending = (async () => {
    const { getPdfDocument } = await import('./pdfRenderer');
    const doc = await getPdfDocument(ref);
    return resolveOutline(doc as unknown as OutlineDocument);
  })();
  cache.set(ref.sourceId, pending);
  // A failed read is not remembered: opening the list again tries again.
  pending.catch(() => cache.delete(ref.sourceId));
  if (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}

/** How many outlines are held, for tests. */
export function cachedOutlines(): number {
  return cache.size;
}
