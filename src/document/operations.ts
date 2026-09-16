/**
 * Pure, immutable document operations. Every function returns new arrays /
 * objects and never mutates its input, so the store can hand them straight
 * to React and history can share stroke references between snapshots.
 */
import { createStrokeId } from '../inking/engine/ids';
import type { Stroke } from '../inking/types';
import { A4_DIMENSIONS, DEFAULT_TEMPLATE_CONFIG, DEFAULT_ZOOM, LIGHT_PAGE_BACKGROUND, PAGE_HISTORY_DEPTH } from './constants';
import type { Document, Page, PageTemplate, TemplateConfig } from './types';

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
}

export function createPage(init: PageInit = {}, pageNumber = 1): Page {
  return {
    id: createPageId(),
    pageNumber,
    dimensions: init.dimensions ?? A4_DIMENSIONS,
    template: init.template ?? 'blank',
    templateConfig: init.templateConfig ?? DEFAULT_TEMPLATE_CONFIG,
    backgroundColor: init.backgroundColor ?? LIGHT_PAGE_BACKGROUND,
    strokes: init.strokes ?? [],
    undoStack: [],
    redoStack: [],
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
    viewMode: 'continuous',
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

/** Duplicate a page: new id, cloned strokes and template settings, empty history. */
export function clonePage(page: Page): Page {
  return {
    ...page,
    id: createPageId(),
    dimensions: { ...page.dimensions },
    templateConfig: { ...page.templateConfig },
    strokes: page.strokes.map(cloneStroke),
    undoStack: [],
    redoStack: [],
  };
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

export function appendStroke(page: Page, stroke: Stroke): Page {
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
