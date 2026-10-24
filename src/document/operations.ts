/**
 * Pure, immutable document operations. Every function returns new arrays /
 * objects and never mutates its input, so the store can hand them straight
 * to React and history can share stroke references between snapshots.
 */
import { isEphemeralTool } from '../inking/engine/pointerPolicy';
import { createStrokeId } from '../inking/engine/ids';
import type { Stroke } from '../inking/types';
import { A4_DIMENSIONS, DEFAULT_TEMPLATE_CONFIG, DEFAULT_ZOOM, LIGHT_PAGE_BACKGROUND, PAGE_HISTORY_DEPTH } from './constants';
import type { Document, FormValue, FormValues, MediaObject, Page, PageTemplate, PdfPageRef, TemplateConfig, FormField } from './types';

export function createPageId(): string {
  return `page_${createStrokeId()}`;
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, Math.trunc(index)), length - 1);
}

export interface PageInit {
  readonly template?: PageTemplate;
  readonly templateConfig?: TemplateConfig;
  readonly backgroundColor?: string;
  readonly dimensions?: Page['dimensions'];
  readonly strokes?: readonly Stroke[];
  readonly pdf?: PdfPageRef;
  readonly formFields?: readonly FormField[];
  readonly formValues?: FormValues;
  readonly media?: readonly MediaObject[];
}

/**
 * The layout a page starts with when the caller does not say.
 *
 * Injected rather than imported so `operations.ts` stays a pure module the
 * tests can use without a store behind it; `DocumentApp` installs the real
 * one from the preferences store on startup.
 */
let pageDefaults: (() => PageInit | null) | null = null;

export function setPageDefaultsSource(source: (() => PageInit | null) | null): void {
  pageDefaults = source;
}

export function createPage(init: PageInit = {}, pageNumber = 1): Page {
  // The user's "Set as default" fills in only what this call left open, so an
  // explicit template — a PDF import, a duplicated page — always wins.
  const preferred = pageDefaults?.() ?? null;
  return {
    id: createPageId(),
    pageNumber,
    dimensions: init.dimensions ?? A4_DIMENSIONS,
    template: init.template ?? preferred?.template ?? 'blank',
    templateConfig: init.templateConfig ?? preferred?.templateConfig ?? DEFAULT_TEMPLATE_CONFIG,
    backgroundColor: init.backgroundColor ?? preferred?.backgroundColor ?? LIGHT_PAGE_BACKGROUND,
    strokes: init.strokes ?? [],
    undoStack: [],
    redoStack: [],
    ...(init.pdf ? { pdf: init.pdf } : {}),
    formFields: init.formFields ?? [],
    formValues: init.formValues ?? {},
    media: init.media ?? [],
  };
}

export function createDocument(pageCount = 1, title = 'Untitled note', pageInit: PageInit = {}): Document {
  const pages: Page[] = [];
  for (let i = 0; i < Math.max(1, pageCount); i++) pages.push(createPage(pageInit, i + 1));
  return {
    id: `doc_${createStrokeId()}`,
    title,
    pages,
    activePageIndex: 0,
    viewMode: 'vertical-continuous',
    zoom: DEFAULT_ZOOM,
  };
}

/** Fix `pageNumber` to index + 1, reusing page objects that are already correct. */
export function renumber(pages: readonly Page[]): Page[] {
  return pages.map((page, i) => (page.pageNumber === i + 1 ? page : { ...page, pageNumber: i + 1 }));
}

/** Move the page at `from` so it ends up at index `to`. */
export function reorderPages(pages: readonly Page[], from: number, to: number): Page[] {
  const n = pages.length;
  if (n === 0) return [];
  const f = clampIndex(from, n);
  const t = clampIndex(to, n);
  if (f === t) return renumber(pages);
  const next = [...pages];
  const [moved] = next.splice(f, 1);
  if (!moved) return renumber(pages);
  next.splice(t, 0, moved);
  return renumber(next);
}

export function insertPage(pages: readonly Page[], index: number, page: Page): Page[] {
  const i = Math.min(Math.max(0, Math.trunc(index)), pages.length);
  return renumber([...pages.slice(0, i), page, ...pages.slice(i)]);
}

/** Remove a page; a document always keeps at least one page. */
export function removePage(pages: readonly Page[], index: number): Page[] {
  if (pages.length <= 1) return [...pages];
  const i = clampIndex(index, pages.length);
  return renumber([...pages.slice(0, i), ...pages.slice(i + 1)]);
}

/** Deep-copy a stroke with a fresh id (points / shapes are copied, not shared). */
export function cloneStroke(stroke: Stroke): Stroke {
  const id = createStrokeId();
  if (stroke.kind === 'freehand') {
    return { ...stroke, id, points: stroke.points.map((p) => ({ ...p })), style: { ...stroke.style }, bbox: { ...stroke.bbox } };
  }
  return {
    ...stroke,
    id,
    shape: structuredClone(stroke.shape),
    style: { ...stroke.style },
    bbox: { ...stroke.bbox },
  };
}

/** Duplicate a page: new id, cloned strokes / media / form values, shared PDF bytes, empty history. */
export function clonePage(page: Page): Page {
  // A copy is not bookmarked: two pages answering to one bookmark would be a puzzle in the list.
  const { bookmark, ...rest } = page;
  void bookmark;
  return {
    ...rest,
    id: createPageId(),
    dimensions: { ...page.dimensions },
    templateConfig: { ...page.templateConfig },
    strokes: page.strokes.map(cloneStroke),
    undoStack: [],
    redoStack: [],
    formValues: { ...page.formValues },
    media: page.media.map((item) => ({ ...item, id: `${item.kind}_${createStrokeId()}` })),
  };
}

export function withFormValue(page: Page, name: string, value: FormValue): Page {
  if (page.formValues[name] === value) return page;
  return { ...page, formValues: { ...page.formValues, [name]: value } };
}

export function withMedia(page: Page, media: readonly MediaObject[]): Page {
  return media === page.media ? page : { ...page, media };
}

/** Replace a page's strokes, recording the previous list for undo. */
export function withStrokes(page: Page, strokes: readonly Stroke[], maxDepth = PAGE_HISTORY_DEPTH): Page {
  if (strokes === page.strokes) return page;
  const undoStack = [...page.undoStack, page.strokes];
  const overflow = undoStack.length - maxDepth;
  return {
    ...page,
    strokes,
    undoStack: overflow > 0 ? undoStack.slice(overflow) : undoStack,
    redoStack: [],
  };
}

export function undoPage(page: Page): Page {
  const previous = page.undoStack[page.undoStack.length - 1];
  if (!previous) return page;
  return {
    ...page,
    strokes: previous,
    undoStack: page.undoStack.slice(0, -1),
    redoStack: [...page.redoStack, page.strokes],
  };
}

export function redoPage(page: Page): Page {
  const next = page.redoStack[page.redoStack.length - 1];
  if (!next) return page;
  return {
    ...page,
    strokes: next,
    undoStack: [...page.undoStack, page.strokes],
    redoStack: page.redoStack.slice(0, -1),
  };
}

/**
 * Append a stroke, recording an undo entry. Ephemeral tools (the laser
 * pointer) are live-only: their marks never enter the stroke array, so they
 * can never reach the undo stack, a save file or an export either.
 */
export function appendStroke(page: Page, stroke: Stroke): Page {
  if (isEphemeralTool(stroke.tool)) return page;
  return withStrokes(page, [...page.strokes, stroke]);
}

export function removeStrokes(page: Page, ids: ReadonlySet<string>): Page {
  const next = page.strokes.filter((s) => !ids.has(s.id));
  return next.length === page.strokes.length ? page : withStrokes(page, next);
}

export function clearPageStrokes(page: Page): Page {
  return page.strokes.length === 0 ? page : withStrokes(page, []);
}

/** Index of `pageId` after a reorder / insert / delete, or the clamped fallback. */
export function indexOfPage(pages: readonly Page[], pageId: string, fallback: number): number {
  const i = pages.findIndex((p) => p.id === pageId);
  return i === -1 ? clampIndex(fallback, pages.length) : i;
}

/** Indices as a sorted list without repeats or anything outside `0..length-1`. */
export function normalizeIndices(indices: readonly number[], length: number): number[] {
  return [...new Set(indices.map((i) => Math.trunc(i)))].filter((i) => i >= 0 && i < length).sort((a, b) => a - b);
}

/**
 * Take the pages at `indices` out and put them back together, in their order, so the first of them ends up at
 * `start` (counted in the result, so `0` is the front and `length - indices.length` the end). Pages 2, 15 and 20
 * moved to 1 become pages 1, 2 and 3.
 */
export function movePagesTo(pages: readonly Page[], indices: readonly number[], start: number): Page[] {
  const picked = normalizeIndices(indices, pages.length);
  if (picked.length === 0) return renumber(pages);
  const set = new Set(picked);
  const moving = picked.map((i) => pages[i]!);
  const rest = pages.filter((_, i) => !set.has(i));
  const at = Math.min(Math.max(0, Math.trunc(start)), rest.length);
  return renumber([...rest.slice(0, at), ...moving, ...rest.slice(at)]);
}

/**
 * Where a group dragged by its page at `from` and dropped on the page at `over` starts (for `movePagesTo`): before
 * that page when dragged up, after it when dragged down, as one page dragged alone lands. `null` when it was dropped
 * on a page of its own.
 */
export function groupDropStart(indices: readonly number[], from: number, over: number): number | null {
  const set = new Set(indices);
  if (set.has(over)) return null;
  const before = indices.filter((i) => i < over).length;
  const rank = over - before;
  return over > from ? rank + 1 : rank;
}

/** Take out the pages at `indices`; at least one page always stays (`null` when they are all of them). */
export function removePages(pages: readonly Page[], indices: readonly number[]): Page[] | null {
  const set = new Set(normalizeIndices(indices, pages.length));
  if (set.size >= pages.length) return null;
  return renumber(pages.filter((_, i) => !set.has(i)));
}

/** A copy of each page at `indices` right after it. */
export function duplicatePagesAt(pages: readonly Page[], indices: readonly number[]): Page[] {
  const set = new Set(normalizeIndices(indices, pages.length));
  return renumber(pages.flatMap((page, i) => (set.has(i) ? [page, clonePage(page)] : [page])));
}

/**
 * Page numbers as typed — "2, 15, 20-25, 73" — as indices, sorted. Ranges may run either way and use a dash or an
 * en dash; numbers past the last page are left out. `null` when the text is not such a list.
 */
export function parsePageList(text: string, length: number): number[] | null {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const part of parts) {
    const m = /^(\d+)(?:[-–](\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    for (let n = Math.min(a, b); n <= Math.max(a, b) && n <= length; n++) if (n >= 1) out.push(n - 1);
  }
  return normalizeIndices(out, length);
}

/** Indices as page numbers the way `parsePageList` reads them, runs shortened: "2, 15, 20–25, 73". */
export function formatPageList(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const a = sorted[i]! + 1;
    const b = sorted[j]! + 1;
    parts.push(j - i >= 2 ? `${a}–${b}` : j > i ? `${a}, ${b}` : `${a}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * The note with only the pages at `indices`, numbered from 1 and named for them ("Physics (pages 2, 15, 20–25)", or
 * "Physics (12 pages)" when the list gets long), for exporting just those. The cover stays behind with the rest.
 */
export function documentOfPages(doc: Document, indices: readonly number[]): Document {
  const picked = normalizeIndices(indices, doc.pages.length);
  const list = formatPageList(picked);
  const which = picked.length === 1 ? `page ${list}` : list.length <= 30 ? `pages ${list}` : `${picked.length} pages`;
  const { cover: _cover, ...rest } = doc;
  return { ...rest, title: `${doc.title} (${which})`, pages: renumber(picked.map((i) => doc.pages[i]!)), activePageIndex: 0 };
}
