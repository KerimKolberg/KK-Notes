/**
 * Zustand document store. Holds the document, navigation intent and the
 * arranger's open state. The inking render loop never subscribes here; it
 * only calls `commitStroke` / `eraseStrokes` when a gesture finishes, which
 * keeps per-frame drawing independent from React state updates.
 */
import { create } from 'zustand';
import type { Stroke } from '../inking/types';
import { MAX_ZOOM, MIN_ZOOM, TEMPLATE_DEFAULT_SPACING, ZOOM_STEP } from './constants';
import {
  appendStroke,
  clampIndex,
  clearPageStrokes,
  clonePage,
  createDocument,
  createPage,
  indexOfPage,
  insertPage,
  redoPage,
  removePage,
  removeStrokes,
  reorderPages,
  undoPage,
} from './operations';
import type { Document, InsertPosition, Page, PageTarget, PageTemplate, TemplateConfig, ViewMode } from './types';

export interface DocumentStore {
  document: Document;
  /** Incremented whenever the viewer should scroll to `document.activePageIndex`. */
  scrollRequest: number;
  arrangerOpen: boolean;

  // navigation / view
  setActivePage: (index: number) => void;
  jumpToPage: (index: number) => void;
  setViewMode: (mode: ViewMode) => void;
  setZoom: (zoom: number) => void;
  zoomBy: (steps: number) => void;
  setTitle: (title: string) => void;
  setArrangerOpen: (open: boolean) => void;

  // structure
  addPage: (position: InsertPosition, referenceIndex?: number) => void;
  duplicatePage: (index: number) => void;
  deletePage: (index: number) => void;
  movePage: (from: number, to: number) => void;
  setPageTemplate: (target: PageTarget, template: PageTemplate, config?: Partial<TemplateConfig>) => void;
  setPageBackground: (target: PageTarget, color: string) => void;

  // ink (keyed by page id so a stale index can never write to the wrong page)
  commitStroke: (pageId: string, stroke: Stroke) => void;
  eraseStrokes: (pageId: string, ids: ReadonlySet<string>) => void;
  clearPage: (pageId: string) => void;
  undo: (pageId: string) => void;
  redo: (pageId: string) => void;

  loadDocument: (doc: Document) => void;
}

function clampZoom(zoom: number): number {
  const z = Math.round(zoom * 100) / 100;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function updatePageById(doc: Document, pageId: string, fn: (page: Page) => Page): Document {
  const index = doc.pages.findIndex((p) => p.id === pageId);
  const page = doc.pages[index];
  if (!page) return doc;
  const next = fn(page);
  if (next === page) return doc;
  const pages = [...doc.pages];
  pages[index] = next;
  return { ...doc, pages };
}

function updateTargets(doc: Document, target: PageTarget, fn: (page: Page) => Page): Document {
  if (target === 'all') return { ...doc, pages: doc.pages.map(fn) };
  const index = clampIndex(target, doc.pages.length);
  const page = doc.pages[index];
  if (!page) return doc;
  const pages = [...doc.pages];
  pages[index] = fn(page);
  return { ...doc, pages };
}

export const useDocumentStore = create<DocumentStore>()((set) => ({
  document: createDocument(1),
  scrollRequest: 0,
  arrangerOpen: false,

  setActivePage: (index) =>
    set((s) => {
      const i = clampIndex(index, s.document.pages.length);
      return i === s.document.activePageIndex ? s : { document: { ...s.document, activePageIndex: i } };
    }),

  jumpToPage: (index) =>
    set((s) => ({
      document: { ...s.document, activePageIndex: clampIndex(index, s.document.pages.length) },
      scrollRequest: s.scrollRequest + 1,
    })),

  setViewMode: (mode) =>
    set((s) =>
      mode === s.document.viewMode
        ? s
        : { document: { ...s.document, viewMode: mode }, scrollRequest: s.scrollRequest + 1 },
    ),

  setZoom: (zoom) => set((s) => ({ document: { ...s.document, zoom: clampZoom(zoom) } })),

  zoomBy: (steps) => set((s) => ({ document: { ...s.document, zoom: clampZoom(s.document.zoom + steps * ZOOM_STEP) } })),

  setTitle: (title) => set((s) => ({ document: { ...s.document, title } })),

  setArrangerOpen: (open) => set({ arrangerOpen: open }),

  addPage: (position, referenceIndex) =>
    set((s) => {
      const doc = s.document;
      const ref = clampIndex(referenceIndex ?? doc.activePageIndex, doc.pages.length);
      const reference = doc.pages[ref];
      const page = createPage(
        reference
          ? {
              template: reference.template,
              templateConfig: reference.templateConfig,
              backgroundColor: reference.backgroundColor,
              dimensions: reference.dimensions,
            }
          : {},
      );
      const at = position === 'before' ? ref : ref + 1;
      return {
        document: { ...doc, pages: insertPage(doc.pages, at, page), activePageIndex: at },
        scrollRequest: s.scrollRequest + 1,
      };
    }),

  duplicatePage: (index) =>
    set((s) => {
      const doc = s.document;
      const i = clampIndex(index, doc.pages.length);
      const source = doc.pages[i];
      if (!source) return s;
      return {
        document: { ...doc, pages: insertPage(doc.pages, i + 1, clonePage(source)), activePageIndex: i + 1 },
        scrollRequest: s.scrollRequest + 1,
      };
    }),

  deletePage: (index) =>
    set((s) => {
      const doc = s.document;
      if (doc.pages.length <= 1) return s;
      const i = clampIndex(index, doc.pages.length);
      const activeId = doc.pages[doc.activePageIndex]?.id ?? '';
      const pages = removePage(doc.pages, i);
      // Keep following the same page; if it was the one deleted, stay at its slot.
      const activePageIndex = i === doc.activePageIndex ? clampIndex(i, pages.length) : indexOfPage(pages, activeId, i);
      return { document: { ...doc, pages, activePageIndex } };
    }),

  movePage: (from, to) =>
    set((s) => {
      const doc = s.document;
      const activeId = doc.pages[doc.activePageIndex]?.id ?? '';
      const pages = reorderPages(doc.pages, from, to);
      if (pages.every((p, i) => p === doc.pages[i])) return s;
      // The viewer keeps following the page the reader was on.
      return {
        document: { ...doc, pages, activePageIndex: indexOfPage(pages, activeId, doc.activePageIndex) },
        scrollRequest: s.scrollRequest + 1,
      };
    }),

  setPageTemplate: (target, template, config) =>
    set((s) => ({
      document: updateTargets(s.document, target, (page) => ({
        ...page,
        template,
        templateConfig: {
          ...page.templateConfig,
          ...(page.template === template ? {} : { spacing: TEMPLATE_DEFAULT_SPACING[template] }),
          ...config,
        },
      })),
    })),

  setPageBackground: (target, color) =>
    set((s) => ({ document: updateTargets(s.document, target, (page) => ({ ...page, backgroundColor: color })) })),

  commitStroke: (pageId, stroke) =>
    set((s) => ({ document: updatePageById(s.document, pageId, (page) => appendStroke(page, stroke)) })),

  eraseStrokes: (pageId, ids) =>
    set((s) => ({ document: updatePageById(s.document, pageId, (page) => removeStrokes(page, ids)) })),

  clearPage: (pageId) => set((s) => ({ document: updatePageById(s.document, pageId, clearPageStrokes) })),

  undo: (pageId) => set((s) => ({ document: updatePageById(s.document, pageId, undoPage) })),

  redo: (pageId) => set((s) => ({ document: updatePageById(s.document, pageId, redoPage) })),

  loadDocument: (doc) => set({ document: doc, scrollRequest: 0 }),
}));

/** Convenience selector for the active page. */
export function selectActivePage(s: DocumentStore): Page | undefined {
  return s.document.pages[s.document.activePageIndex];
}
