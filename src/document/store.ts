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
  addImage as addImageToList,
  bringToFront as bringImageToFrontInList,
  removeImage as removeImageFromList,
  sendToBack as sendImageToBackInList,
  updateImage as updateImageInList,
} from './media';
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
  withFormValue,
  withImages,
} from './operations';
import type {
  Document,
  FormValue,
  ImageLayer,
  InsertPosition,
  Page,
  PageTarget,
  PageTemplate,
  TemplateConfig,
  ViewMode,
} from './types';

export interface ImageSelection {
  readonly pageId: string;
  readonly imageId: string;
}

export interface DocumentStore {
  document: Document;
  /** Incremented whenever the viewer should scroll to `document.activePageIndex`. */
  scrollRequest: number;
  arrangerOpen: boolean;
  importDialogOpen: boolean;
  /** True while a PDF export is being assembled. */
  exporting: boolean;
  selectedImage: ImageSelection | null;
  /** Native path of the open `.notex` file, if any. */
  filePath: string | null;
  /** Content as of the last save / load; view state (zoom, scroll) is not part of it. */
  savedPages: readonly Page[] | null;
  savedTitle: string | null;

  // navigation / view
  setActivePage: (index: number) => void;
  jumpToPage: (index: number) => void;
  setViewMode: (mode: ViewMode) => void;
  setZoom: (zoom: number) => void;
  zoomBy: (steps: number) => void;
  setTitle: (title: string) => void;
  setArrangerOpen: (open: boolean) => void;
  setImportDialogOpen: (open: boolean) => void;
  setExporting: (exporting: boolean) => void;

  // structure
  /** Insert ready-made pages (e.g. imported PDF pages); defaults to appending. */
  appendPages: (pages: readonly Page[], at?: number) => void;
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

  // forms & media
  setFormValue: (pageId: string, name: string, value: FormValue) => void;
  addImage: (pageId: string, image: ImageLayer) => void;
  updateImage: (pageId: string, imageId: string, patch: Partial<ImageLayer>) => void;
  removeImage: (pageId: string, imageId: string) => void;
  bringImageToFront: (pageId: string, imageId: string) => void;
  sendImageToBack: (pageId: string, imageId: string) => void;
  selectImage: (selection: ImageSelection | null) => void;

  /** Replace the document; `path` is the native file it came from. Marks it clean. */
  loadDocument: (doc: Document, path?: string | null) => void;
  newDocument: () => void;
  setFilePath: (path: string | null) => void;
  /** Record the current content as saved. */
  markSaved: (path?: string | null) => void;
}

/** True when the document content differs from the last saved / loaded state. */
export function selectIsDirty(s: DocumentStore): boolean {
  return s.document.pages !== s.savedPages || s.document.title !== s.savedTitle;
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

const initialDocument = createDocument(1);

export const useDocumentStore = create<DocumentStore>()((set) => ({
  document: initialDocument,
  scrollRequest: 0,
  arrangerOpen: false,
  importDialogOpen: false,
  exporting: false,
  selectedImage: null,
  filePath: null,
  savedPages: initialDocument.pages,
  savedTitle: initialDocument.title,

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
  setImportDialogOpen: (open) => set({ importDialogOpen: open }),
  setExporting: (exporting) => set({ exporting }),

  appendPages: (pages, at) =>
    set((s) => {
      if (pages.length === 0) return s;
      const doc = s.document;
      const index = Math.min(Math.max(0, Math.trunc(at ?? doc.pages.length)), doc.pages.length);
      let next = doc.pages;
      pages.forEach((page, i) => {
        next = insertPage(next, index + i, page);
      });
      return { document: { ...doc, pages: next, activePageIndex: index }, scrollRequest: s.scrollRequest + 1 };
    }),

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

  setFormValue: (pageId, name, value) =>
    set((s) => ({ document: updatePageById(s.document, pageId, (page) => withFormValue(page, name, value)) })),

  addImage: (pageId, image) =>
    set((s) => ({
      document: updatePageById(s.document, pageId, (page) => withImages(page, addImageToList(page.images, image))),
      selectedImage: { pageId, imageId: image.id },
    })),

  updateImage: (pageId, imageId, patch) =>
    set((s) => ({
      document: updatePageById(s.document, pageId, (page) => withImages(page, updateImageInList(page.images, imageId, patch))),
    })),

  removeImage: (pageId, imageId) =>
    set((s) => ({
      document: updatePageById(s.document, pageId, (page) => withImages(page, removeImageFromList(page.images, imageId))),
      selectedImage: s.selectedImage?.imageId === imageId ? null : s.selectedImage,
    })),

  bringImageToFront: (pageId, imageId) =>
    set((s) => ({
      document: updatePageById(s.document, pageId, (page) => withImages(page, bringImageToFrontInList(page.images, imageId))),
    })),

  sendImageToBack: (pageId, imageId) =>
    set((s) => ({
      document: updatePageById(s.document, pageId, (page) => withImages(page, sendImageToBackInList(page.images, imageId))),
    })),

  selectImage: (selection) =>
    set((s) =>
      (s.selectedImage?.pageId === selection?.pageId && s.selectedImage?.imageId === selection?.imageId) ? s : { selectedImage: selection },
    ),

  loadDocument: (doc, path = null) =>
    set({ document: doc, scrollRequest: 0, selectedImage: null, filePath: path, savedPages: doc.pages, savedTitle: doc.title }),

  newDocument: () => {
    const doc = createDocument(1);
    set({ document: doc, scrollRequest: 0, selectedImage: null, filePath: null, savedPages: doc.pages, savedTitle: doc.title });
  },

  setFilePath: (path) => set({ filePath: path }),

  markSaved: (path) =>
    set((s) => ({
      savedPages: s.document.pages,
      savedTitle: s.document.title,
      ...(path !== undefined ? { filePath: path } : {}),
    })),
}));

/** Convenience selector for the active page. */
export function selectActivePage(s: DocumentStore): Page | undefined {
  return s.document.pages[s.document.activePageIndex];
}
