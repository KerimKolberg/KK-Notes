/**
 * Zustand document store. Holds the document, navigation intent and the
 * arranger's open state. The inking render loop never subscribes here; it
 * only calls `commitStroke` / `eraseStrokes` when a gesture finishes, which
 * keeps per-frame drawing independent from React state updates.
 */
import { create } from 'zustand';
import {
  arrangeStrokes,
  createGroupId,
  expandToGroups,
  groupStrokes,
  pastedCopies,
  ungroupStrokes,
  type ArrangeOp,
} from '../inking/engine/arrange';
import {
  DUPLICATE_OFFSET,
  duplicateStrokes,
  removeStrokesById,
  reshapeStrokes,
  restyleStrokes,
  transformStroke,
  transformStrokes,
  type StrokeTransform,
  type StyleChange,
} from '../inking/engine/lasso';
import type { CurveEdit } from '../inking/engine/shapes';
import { keepStrokes, type EraseFilter } from '../inking/engine/eraseFilter';
import type { Stroke } from '../inking/types';
import { TEMPLATE_DEFAULT_SPACING, ZOOM_STEP } from './constants';
import { withBookmark } from './bookmarks';
import {
  canRedoStructure,
  depthsOf,
  pushEntry,
  pushRedo,
  undoesStructureFirst,
  type RedoEntry,
  type StructureEntry,
} from './structureHistory';
import { useClipboardStore } from './clipboard';
import { clampZoom } from './layout';
import {
  addImage as addMediaToList,
  bringToFront as bringMediaToFrontInList,
  removeImage as removeMediaFromList,
  sendToBack as sendMediaToBackInList,
  updateImage as updateMediaInList,
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
  withMedia,
  withStrokes,
} from './operations';
import type {
  InkText,
  Recording,
  Cover,
  Document,
  FormValue,
  MediaObject,
  InsertPosition,
  Page,
  PageTarget,
  PageTemplate,
  TemplateConfig,
  ViewMode,
} from './types';

export interface MediaSelection {
  readonly pageId: string;
  readonly mediaId: string;
}

/** Strokes picked by the lasso tool, all on one page. */
export interface LassoSelection {
  readonly pageId: string;
  readonly strokeIds: readonly string[];
}

export interface DocumentStore {
  document: Document;
  /** Incremented whenever the viewer should scroll to `document.activePageIndex`. */
  scrollRequest: number;
  /**
   * How far down the page (page units) the jump of request `request` goes, when it goes further than the top: a
   * chapter in a PDF's contents starts where its heading is. Tied to its request, so any other jump is to a top.
   */
  scrollWithin: { readonly request: number; readonly y: number } | null;
  arrangerOpen: boolean;
  importDialogOpen: boolean;
  /** True while a PDF export is being assembled. */
  exporting: boolean;
  selectedMedia: MediaSelection | null;
  lassoSelection: LassoSelection | null;
  /** Lock / read-only mode: navigation and form filling only, no content edits. */
  readOnly: boolean;
  /** Native path of the open `.notex` file, if any. */
  filePath: string | null;
  /** Content as of the last save / load; view state (zoom, scroll) is not part of it. */
  savedPages: readonly Page[] | null;
  savedTitle: string | null;
  savedCover: Cover | null | undefined;
  savedRecordings: readonly Recording[] | undefined;
  /** Changes to the pages (an import, a page added, moved or deleted) that Undo can take back; see `structureHistory.ts`. */
  structureUndo: readonly StructureEntry[];
  structureRedo: readonly RedoEntry[];

  // navigation / view
  setActivePage: (index: number) => void;
  jumpToPage: (index: number, within?: number) => void;
  setViewMode: (mode: ViewMode) => void;
  setZoom: (zoom: number) => void;
  /** Zoom by `steps` steps of `step` (a fraction: 0.1 is ten percentage points). */
  zoomBy: (steps: number, step?: number) => void;
  setTitle: (title: string) => void;
  setArrangerOpen: (open: boolean) => void;
  setReadOnly: (readOnly: boolean) => void;
  toggleReadOnly: () => void;
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
  /** Bookmark a page with a name ('' for none), or take its bookmark away (`null`). */
  setPageBookmark: (pageId: string, label: string | null) => void;
  /**
   * What the handwriting on a page says, as a recogniser read it (`null`: nothing, take it away). Not an edit: it
   * works on a locked note, is not undone, and never marks a note as changed — it goes to disk with the next save.
   */
  setPageInkText: (pageId: string, inkText: InkText | null) => void;
  /** Add a recording to the note: an unsaved change like any other. */
  addRecording: (recording: Recording) => void;
  /** Take a recording out of the note. */
  removeRecording: (id: string) => void;
  /** Patch the template's line spacing / colour / weight. */
  setTemplateConfig: (target: PageTarget, patch: Partial<TemplateConfig>) => void;
  /** Add, replace or (with `null`) remove the notebook cover. */
  setCover: (cover: Cover | null) => void;
  updateCover: (patch: Partial<Cover>) => void;

  // ink (keyed by page id so a stale index can never write to the wrong page)
  commitStroke: (pageId: string, stroke: Stroke) => void;
  /** Several strokes at once, taken back by one Undo (a highlight over several lines of a PDF). */
  commitStrokes: (pageId: string, strokes: readonly Stroke[]) => void;
  eraseStrokes: (pageId: string, ids: ReadonlySet<string>) => void;
  clearPage: (pageId: string) => void;
  undo: (pageId: string) => void;
  /**
   * Undo whatever was done last to the note: a change to its pages, or a stroke on the page in view,
   * whichever is more recent. Resolves what the change was ("adding 12 pages"), or `null` for a stroke.
   */
  undoLast: () => string | null;
  /** The same, for Redo. */
  redoLast: () => string | null;
  redo: (pageId: string) => void;

  // forms & media
  setFormValue: (pageId: string, name: string, value: FormValue) => void;
  addMedia: (pageId: string, item: MediaObject) => void;
  /** The same, as a change Undo can take back (see `structureHistory.ts`), named for the notice that says so. */
  addMediaUndoable: (pageId: string, item: MediaObject, label: string) => void;
  updateMedia: (pageId: string, mediaId: string, patch: Partial<MediaObject>) => void;
  removeMedia: (pageId: string, mediaId: string) => void;
  bringMediaToFront: (pageId: string, mediaId: string) => void;
  sendMediaToBack: (pageId: string, mediaId: string) => void;
  selectMedia: (selection: MediaSelection | null) => void;
  /** Erase every stroke on one page, or on every page as a single undo step. */
  clearPageInk: (pageId: string, filter?: EraseFilter) => void;
  clearDocumentInk: (filter?: EraseFilter) => void;

  // lasso selection (every edit is one undo step on the page)
  setLassoSelection: (selection: LassoSelection | null) => void;
  clearLassoSelection: () => void;
  transformSelection: (pageId: string, ids: readonly string[], transform: StrokeTransform) => void;
  restyleSelection: (pageId: string, ids: readonly string[], change: StyleChange) => void;
  /**
   * Rebuild the selected lines and curves from new parameters. A committed
   * curve keeps everything it was drawn from, so this re-runs the generator
   * rather than deforming the points it left behind.
   */
  reshapeSelection: (pageId: string, ids: readonly string[], edit: CurveEdit) => void;
  /** Appends offset copies and moves the selection onto them. */
  duplicateSelection: (pageId: string, ids: readonly string[]) => void;
  deleteSelection: (pageId: string, ids: readonly string[]) => void;
  /** Make the selected strokes one group: a lasso takes them together and aligning moves them as one. */
  groupSelection: (pageId: string, ids: readonly string[]) => void;
  ungroupSelection: (pageId: string, ids: readonly string[]) => void;
  /** Line the selection up, or space it evenly, as one undo step. */
  arrangeSelection: (pageId: string, ids: readonly string[], op: ArrangeOp) => void;
  /** Put the selection on the clipboard, leaving it where it is. */
  copySelection: (pageId: string, ids: readonly string[]) => void;
  /** Copy it, then delete it. */
  cutSelection: (pageId: string, ids: readonly string[]) => void;
  /**
   * Paste what was last copied onto a page and select the copies. Beside the
   * originals if it is the page they came from, in the same place on any other.
   * Returns whether there was anything to paste.
   */
  pasteSelection: (pageId: string) => boolean;
  /**
   * Hand the selection to another page, transformed into its coordinates.
   * The strokes keep their ids, so the selection survives the move.
   */
  moveSelectionToPage: (fromPageId: string, toPageId: string, ids: readonly string[], transform: StrokeTransform) => void;

  /** Replace the document; `path` is the native file it came from. Marks it clean. */
  loadDocument: (doc: Document, path?: string | null) => void;
  newDocument: () => void;
  setFilePath: (path: string | null) => void;
  /** Record the current content as saved. */
  markSaved: (path?: string | null) => void;
}

/**
 * Wrap a state updater so it becomes a no-op while the document is locked.
 * Read-only mode is an invariant of the store, not a UI convention: every
 * action that changes document content goes through this, so nothing short
 * of unlocking can edit a locked document. Navigation, view state and
 * AcroForm values are deliberately not wrapped.
 */
function edit(
  update: (s: DocumentStore) => Partial<DocumentStore> | DocumentStore,
): (s: DocumentStore) => Partial<DocumentStore> | DocumentStore {
  return (s) => (s.readOnly ? s : update(s));
}

/** True when the document content differs from the last saved / loaded state. */
export function selectIsDirty(s: DocumentStore): boolean {
  return (
    s.document.pages !== s.savedPages ||
    s.document.title !== s.savedTitle ||
    s.document.cover !== s.savedCover ||
    s.document.recordings !== s.savedRecordings
  );
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

/**
 * A change to the pages, with what it replaced kept for Undo. Any new change ends what could have been redone.
 */
function structured(s: DocumentStore, label: string, document: Document): Pick<DocumentStore, 'document' | 'structureUndo' | 'structureRedo'> {
  return {
    document,
    structureUndo: pushEntry(s.structureUndo, {
      label,
      before: { pages: s.document.pages, activePageIndex: s.document.activePageIndex },
      depths: depthsOf(document.pages),
    }),
    structureRedo: [],
  };
}

const initialDocument = createDocument(1);

export const useDocumentStore = create<DocumentStore>()((set, get) => ({
  document: initialDocument,
  scrollRequest: 0,
  scrollWithin: null,
  arrangerOpen: false,
  importDialogOpen: false,
  exporting: false,
  selectedMedia: null,
  lassoSelection: null,
  readOnly: false,
  filePath: null,
  savedPages: initialDocument.pages,
  savedTitle: initialDocument.title,
  savedCover: initialDocument.cover,
  savedRecordings: initialDocument.recordings,
  structureUndo: [],
  structureRedo: [],

  setActivePage: (index) =>
    set((s) => {
      const i = clampIndex(index, s.document.pages.length);
      return i === s.document.activePageIndex ? s : { document: { ...s.document, activePageIndex: i } };
    }),

  jumpToPage: (index, within) =>
    set((s) => ({
      document: { ...s.document, activePageIndex: clampIndex(index, s.document.pages.length) },
      scrollRequest: s.scrollRequest + 1,
      scrollWithin: within && within > 0 ? { request: s.scrollRequest + 1, y: within } : null,
    })),

  setViewMode: (mode) =>
    set((s) =>
      mode === s.document.viewMode
        ? s
        : { document: { ...s.document, viewMode: mode }, scrollRequest: s.scrollRequest + 1 },
    ),

  setZoom: (zoom) => set((s) => ({ document: { ...s.document, zoom: clampZoom(zoom) } })),

  zoomBy: (steps, step = ZOOM_STEP) => set((s) => ({ document: { ...s.document, zoom: clampZoom(s.document.zoom + steps * step) } })),

  setTitle: (title) => set(edit((s) => ({ document: { ...s.document, title } }))),

  setArrangerOpen: (open) => set({ arrangerOpen: open }),

  // Locking drops the editing selections; nothing can act on them any more.
  setReadOnly: (readOnly) =>
    set((s) => (s.readOnly === readOnly ? s : { readOnly, selectedMedia: null, lassoSelection: null })),

  toggleReadOnly: () => set((s) => ({ readOnly: !s.readOnly, selectedMedia: null, lassoSelection: null })),
  setImportDialogOpen: (open) => set({ importDialogOpen: open }),
  setExporting: (exporting) => set({ exporting }),

  appendPages: (pages, at) =>
    set(edit((s) => {
      if (pages.length === 0) return s;
      const doc = s.document;
      const index = Math.min(Math.max(0, Math.trunc(at ?? doc.pages.length)), doc.pages.length);
      let next = doc.pages;
      pages.forEach((page, i) => {
        next = insertPage(next, index + i, page);
      });
      return {
        ...structured(s, pages.length === 1 ? 'adding a page' : `adding ${pages.length} pages`, { ...doc, pages: next, activePageIndex: index }),
        scrollRequest: s.scrollRequest + 1,
      };
    })),

  addPage: (position, referenceIndex) =>
    set(edit((s) => {
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
        ...structured(s, 'adding a page', { ...doc, pages: insertPage(doc.pages, at, page), activePageIndex: at }),
        scrollRequest: s.scrollRequest + 1,
      };
    })),

  duplicatePage: (index) =>
    set(edit((s) => {
      const doc = s.document;
      const i = clampIndex(index, doc.pages.length);
      const source = doc.pages[i];
      if (!source) return s;
      return {
        ...structured(s, 'duplicating a page', { ...doc, pages: insertPage(doc.pages, i + 1, clonePage(source)), activePageIndex: i + 1 }),
        scrollRequest: s.scrollRequest + 1,
      };
    })),

  deletePage: (index) =>
    set(edit((s) => {
      const doc = s.document;
      if (doc.pages.length <= 1) return s;
      const i = clampIndex(index, doc.pages.length);
      const activeId = doc.pages[doc.activePageIndex]?.id ?? '';
      const pages = removePage(doc.pages, i);
      // Keep following the same page; if it was the one deleted, stay at its slot.
      const activePageIndex = i === doc.activePageIndex ? clampIndex(i, pages.length) : indexOfPage(pages, activeId, i);
      const deletedId = doc.pages[i]?.id;
      return {
        ...structured(s, 'deleting a page', { ...doc, pages, activePageIndex }),
        lassoSelection: s.lassoSelection?.pageId === deletedId ? null : s.lassoSelection,
        selectedMedia: s.selectedMedia?.pageId === deletedId ? null : s.selectedMedia,
      };
    })),

  movePage: (from, to) =>
    set(edit((s) => {
      const doc = s.document;
      const activeId = doc.pages[doc.activePageIndex]?.id ?? '';
      const pages = reorderPages(doc.pages, from, to);
      if (pages.every((p, i) => p === doc.pages[i])) return s;
      // The viewer keeps following the page the reader was on.
      return {
        ...structured(s, 'moving a page', { ...doc, pages, activePageIndex: indexOfPage(pages, activeId, doc.activePageIndex) }),
        scrollRequest: s.scrollRequest + 1,
      };
    })),

  setPageTemplate: (target, template, config) =>
    set(edit((s) => ({
      document: updateTargets(s.document, target, (page) => ({
        ...page,
        template,
        templateConfig: {
          ...page.templateConfig,
          ...(page.template === template ? {} : { spacing: TEMPLATE_DEFAULT_SPACING[template] }),
          ...config,
        },
      })),
    }))),

  setPageBookmark: (pageId, label) =>
    set(edit((s) => ({ document: updatePageById(s.document, pageId, (page) => withBookmark(page, label)) }))),

  setPageInkText: (pageId, inkText) =>
    set((s) => {
      const index = s.document.pages.findIndex((p) => p.id === pageId);
      const page = s.document.pages[index];
      if (!page) return s;
      if (!inkText && page.inkText === undefined) return s;
      let next: Page;
      if (inkText) next = { ...page, inkText };
      else {
        const { inkText: _gone, ...rest } = page;
        next = rest;
      }
      const pages = s.document.pages.map((p, i) => (i === index ? next : p));
      // What was saved stays saved: where the saved pages hold this very page, they take the words as well, so a
      // note whose handwriting has just been read is not shown as changed and nothing is written because of it.
      let savedPages = s.savedPages;
      if (savedPages === s.document.pages) savedPages = pages;
      else if (savedPages && savedPages[index] === page) savedPages = savedPages.map((p, i) => (i === index ? next : p));
      return { document: { ...s.document, pages }, savedPages };
    }),

  addRecording: (recording) =>
    set((s) => ({ document: { ...s.document, recordings: [...(s.document.recordings ?? []), recording] } })),

  removeRecording: (id) =>
    set((s) => {
      const kept = (s.document.recordings ?? []).filter((r) => r.id !== id);
      if (kept.length === (s.document.recordings ?? []).length) return s;
      const { recordings: _all, ...rest } = s.document;
      return { document: kept.length > 0 ? { ...rest, recordings: kept } : rest };
    }),

  setPageBackground: (target, color) =>
    set(edit((s) => ({ document: updateTargets(s.document, target, (page) => ({ ...page, backgroundColor: color })) }))),

  setTemplateConfig: (target, patch) =>
    set(edit((s) => ({
      document: updateTargets(s.document, target, (page) => ({
        ...page,
        templateConfig: { ...page.templateConfig, ...patch },
      })),
    }))),

  setCover: (cover) =>
    set(edit((s) => {
      const { cover: current, ...rest } = s.document;
      void current;
      return { document: cover ? { ...s.document, cover } : rest };
    })),

  updateCover: (patch) =>
    set(edit((s) => {
      const current = s.document.cover;
      if (!current) return s;
      return { document: { ...s.document, cover: { ...current, ...patch } } };
    })),

  commitStroke: (pageId, stroke) =>
    set(edit((s) => ({ document: updatePageById(s.document, pageId, (page) => appendStroke(page, stroke)) }))),

  commitStrokes: (pageId, strokes) =>
    set(
      edit((s) =>
        strokes.length === 0
          ? s
          : { document: updatePageById(s.document, pageId, (page) => withStrokes(page, [...page.strokes, ...strokes])) },
      ),
    ),

  eraseStrokes: (pageId, ids) =>
    set(edit((s) => ({ document: updatePageById(s.document, pageId, (page) => removeStrokes(page, ids)) }))),

  clearPage: (pageId) =>
    set(edit((s) => ({
      document: updatePageById(s.document, pageId, clearPageStrokes),
      lassoSelection: s.lassoSelection?.pageId === pageId ? null : s.lassoSelection,
    }))),

  undo: (pageId) => set(edit((s) => ({ document: updatePageById(s.document, pageId, undoPage) }))),

  redo: (pageId) => set(edit((s) => ({ document: updatePageById(s.document, pageId, redoPage) }))),

  undoLast: () => {
    const s = get();
    if (s.readOnly) return null;
    const doc = s.document;
    const page = doc.pages[doc.activePageIndex];
    const top = s.structureUndo[s.structureUndo.length - 1];
    if (top && undoesStructureFirst(top, page)) {
      const { pages, activePageIndex } = top.before;
      set({
        document: { ...doc, pages, activePageIndex: clampIndex(activePageIndex, pages.length) },
        structureUndo: s.structureUndo.slice(0, -1),
        structureRedo: pushRedo(s.structureRedo, {
          label: top.label,
          after: { pages: doc.pages, activePageIndex: doc.activePageIndex },
          restored: pages,
          depths: top.depths,
        }),
        scrollRequest: s.scrollRequest + 1,
        selectedMedia: null,
        lassoSelection: null,
      });
      return top.label;
    }
    if (page) set({ document: updatePageById(doc, page.id, undoPage) });
    return null;
  },

  redoLast: () => {
    const s = get();
    if (s.readOnly) return null;
    const doc = s.document;
    const page = doc.pages[doc.activePageIndex];
    // A stroke undone on this page is the newer thing to put back.
    if (page && page.redoStack.length > 0) {
      set({ document: updatePageById(doc, page.id, redoPage) });
      return null;
    }
    const top = s.structureRedo[s.structureRedo.length - 1];
    if (!top || !canRedoStructure(top, doc.pages)) return null;
    const { pages, activePageIndex } = top.after;
    set({
      document: { ...doc, pages, activePageIndex: clampIndex(activePageIndex, pages.length) },
      structureRedo: s.structureRedo.slice(0, -1),
      structureUndo: pushEntry(s.structureUndo, {
        label: top.label,
        before: { pages: doc.pages, activePageIndex: doc.activePageIndex },
        depths: top.depths,
      }),
      scrollRequest: s.scrollRequest + 1,
      selectedMedia: null,
      lassoSelection: null,
    });
    return top.label;
  },

  setFormValue: (pageId, name, value) =>
    set((s) => ({ document: updatePageById(s.document, pageId, (page) => withFormValue(page, name, value)) })),

  addMedia: (pageId, item) =>
    set(edit((s) => ({
      document: updatePageById(s.document, pageId, (page) => withMedia(page, addMediaToList(page.media, item))),
      selectedMedia: { pageId, mediaId: item.id },
    }))),

  addMediaUndoable: (pageId, item, label) =>
    set(edit((s) => {
      const next = updatePageById(s.document, pageId, (page) => withMedia(page, addMediaToList(page.media, item)));
      return next === s.document ? s : structured(s, label, next);
    })),

  updateMedia: (pageId, mediaId, patch) =>
    set(edit((s) => ({
      document: updatePageById(s.document, pageId, (page) => withMedia(page, updateMediaInList(page.media, mediaId, patch))),
    }))),

  removeMedia: (pageId, mediaId) =>
    set(edit((s) => ({
      document: updatePageById(s.document, pageId, (page) => withMedia(page, removeMediaFromList(page.media, mediaId))),
      selectedMedia: s.selectedMedia?.mediaId === mediaId ? null : s.selectedMedia,
    }))),

  bringMediaToFront: (pageId, mediaId) =>
    set(edit((s) => ({
      document: updatePageById(s.document, pageId, (page) => withMedia(page, bringMediaToFrontInList(page.media, mediaId))),
    }))),

  sendMediaToBack: (pageId, mediaId) =>
    set(edit((s) => ({
      document: updatePageById(s.document, pageId, (page) => withMedia(page, sendMediaToBackInList(page.media, mediaId))),
    }))),

  selectMedia: (selection) =>
    set((s) =>
      (s.selectedMedia?.pageId === selection?.pageId && s.selectedMedia?.mediaId === selection?.mediaId) ? s : { selectedMedia: selection },
    ),

  clearPageInk: (pageId, filter) =>
    set(edit((s) => ({
      document: updatePageById(s.document, pageId, (page) => withStrokes(page, keepStrokes(page.strokes, filter))),
      lassoSelection: s.lassoSelection?.pageId === pageId ? null : s.lassoSelection,
    }))),

  /**
   * One undo entry per page, pushed in a single update: undoing is per page
   * anyway, so this leaves every page exactly one step from where it was.
   * Media is untouched — an image, a note or a table is not ink.
   */
  clearDocumentInk: (filter) =>
    set(edit((s) => {
      const pages = s.document.pages.map((page) => {
        const kept = keepStrokes(page.strokes, filter);
        return kept.length === page.strokes.length ? page : withStrokes(page, kept);
      });
      if (pages.every((page, i) => page === s.document.pages[i])) return s;
      return { document: { ...s.document, pages }, lassoSelection: null };
    })),

  setLassoSelection: (selection) =>
    set(
      edit((s) => {
        if (selection === null) return s.lassoSelection === null ? s : { lassoSelection: null };
        // A group is selected whole: one stroke of it in the loop is all of it.
        const page = s.document.pages.find((p) => p.id === selection.pageId);
        if (!page) return { lassoSelection: selection };
        const strokeIds = expandToGroups(page.strokes, selection.strokeIds);
        return { lassoSelection: { pageId: selection.pageId, strokeIds } };
      }),
    ),

  clearLassoSelection: () => set((s) => (s.lassoSelection === null ? s : { lassoSelection: null })),

  transformSelection: (pageId, ids, transform) =>
    set(edit((s) => {
      const idSet = new Set(ids);
      return {
        document: updatePageById(s.document, pageId, (page) => withStrokes(page, transformStrokes(page.strokes, idSet, transform))),
      };
    })),

  restyleSelection: (pageId, ids, change) =>
    set(edit((s) => {
      const idSet = new Set(ids);
      return {
        document: updatePageById(s.document, pageId, (page) => {
          const next = restyleStrokes(page.strokes, idSet, change);
          return next.every((stroke, i) => stroke === page.strokes[i]) ? page : withStrokes(page, next);
        }),
      };
    })),

  reshapeSelection: (pageId, ids, change) =>
    set(edit((s) => {
      const idSet = new Set(ids);
      return {
        document: updatePageById(s.document, pageId, (page) => {
          const next = reshapeStrokes(page.strokes, idSet, change);
          return next.every((stroke, i) => stroke === page.strokes[i]) ? page : withStrokes(page, next);
        }),
      };
    })),

  duplicateSelection: (pageId, ids) =>
    set(edit((s) => {
      const idSet = new Set(ids);
      let copies: string[] = [];
      const document = updatePageById(s.document, pageId, (page) => {
        const result = duplicateStrokes(page.strokes, idSet);
        copies = result.ids;
        return copies.length === 0 ? page : withStrokes(page, result.strokes);
      });
      if (copies.length === 0) return s;
      return { document, lassoSelection: { pageId, strokeIds: copies } };
    })),

  deleteSelection: (pageId, ids) =>
    set(edit((s) => {
      const idSet = new Set(ids);
      return {
        document: updatePageById(s.document, pageId, (page) => {
          const next = removeStrokesById(page.strokes, idSet);
          return next.length === page.strokes.length ? page : withStrokes(page, next);
        }),
        lassoSelection: s.lassoSelection?.pageId === pageId ? null : s.lassoSelection,
      };
    })),

  groupSelection: (pageId, ids) =>
    set(edit((s) => {
      if (ids.length < 2) return s;
      const idSet = new Set(ids);
      const groupId = createGroupId();
      return {
        document: updatePageById(s.document, pageId, (page) => {
          const next = groupStrokes(page.strokes, idSet, groupId);
          return next.every((stroke, i) => stroke === page.strokes[i]) ? page : withStrokes(page, next);
        }),
      };
    })),

  ungroupSelection: (pageId, ids) =>
    set(edit((s) => {
      const idSet = new Set(ids);
      return {
        document: updatePageById(s.document, pageId, (page) => {
          const next = ungroupStrokes(page.strokes, idSet);
          return next.every((stroke, i) => stroke === page.strokes[i]) ? page : withStrokes(page, next);
        }),
      };
    })),

  arrangeSelection: (pageId, ids, op) =>
    set(edit((s) => {
      const idSet = new Set(ids);
      return {
        document: updatePageById(s.document, pageId, (page) => {
          const next = arrangeStrokes(page.strokes, idSet, op);
          return next.every((stroke, i) => stroke === page.strokes[i]) ? page : withStrokes(page, next);
        }),
      };
    })),

  // Copying changes nothing in the document, so it is allowed while it is locked too.
  copySelection: (pageId, ids) => {
    const page = get().document.pages.find((p) => p.id === pageId);
    if (!page) return;
    const idSet = new Set(ids);
    useClipboardStore.getState().copy(page.strokes.filter((stroke) => idSet.has(stroke.id)), pageId);
  },

  cutSelection: (pageId, ids) => {
    if (get().readOnly) return;
    get().copySelection(pageId, ids);
    get().deleteSelection(pageId, ids);
  },

  pasteSelection: (pageId) => {
    const clipboard = useClipboardStore.getState();
    if (get().readOnly || clipboard.strokes.length === 0) return false;
    const target = get().document.pages.find((p) => p.id === pageId);
    if (!target) return false;
    // Beside the originals on their own page (each paste a step further, so pasting twice
    // does not stack the copies), in the same spot on any other.
    const steps = clipboard.sourcePageId === pageId ? clipboard.pastes + 1 : clipboard.pastes;
    const offset = { x: DUPLICATE_OFFSET.x * steps, y: DUPLICATE_OFFSET.y * steps };
    const copies = pastedCopies(clipboard.strokes, offset, target.dimensions);
    if (copies.length === 0) return false;
    clipboard.notePasted();
    set(edit((s) => ({
      document: updatePageById(s.document, pageId, (page) => withStrokes(page, [...page.strokes, ...copies])),
      lassoSelection: { pageId, strokeIds: copies.map((c) => c.id) },
    })));
    return true;
  },

  moveSelectionToPage: (fromPageId, toPageId, ids, transform) =>
    set(edit((s) => {
      if (fromPageId === toPageId) return s;
      const idSet = new Set(ids);
      const source = s.document.pages.find((p) => p.id === fromPageId);
      const target = s.document.pages.find((p) => p.id === toPageId);
      if (!source || !target) return s;
      const moved = source.strokes.filter((stroke) => idSet.has(stroke.id)).map((stroke) => transformStroke(stroke, transform));
      if (moved.length === 0) return s;
      // Two pages change, so this is two undo entries — history is per page.
      const withoutThem = updatePageById(s.document, fromPageId, (page) =>
        withStrokes(page, removeStrokesById(page.strokes, idSet)),
      );
      return {
        document: updatePageById(withoutThem, toPageId, (page) => withStrokes(page, [...page.strokes, ...moved])),
        lassoSelection: { pageId: toPageId, strokeIds: moved.map((stroke) => stroke.id) },
      };
    })),

  loadDocument: (doc, path = null) =>
    set({
      document: doc,
      scrollRequest: 0,
      scrollWithin: null,
      selectedMedia: null,
      lassoSelection: null,
      filePath: path,
      savedPages: doc.pages,
      savedTitle: doc.title,
      savedCover: doc.cover,
      savedRecordings: doc.recordings,
      structureUndo: [],
      structureRedo: [],
    }),

  newDocument: () => {
    const doc = createDocument(1);
    set({
      document: doc,
      scrollRequest: 0,
      scrollWithin: null,
      selectedMedia: null,
      lassoSelection: null,
      filePath: null,
      savedPages: doc.pages,
      savedTitle: doc.title,
      savedCover: doc.cover,
      savedRecordings: doc.recordings,
      structureUndo: [],
      structureRedo: [],
    });
  },

  setFilePath: (path) => set({ filePath: path }),

  markSaved: (path) =>
    set((s) => ({
      savedPages: s.document.pages,
      savedTitle: s.document.title,
      savedCover: s.document.cover,
      savedRecordings: s.document.recordings,
      ...(path !== undefined ? { filePath: path } : {}),
    })),
}));

/** Convenience selector for the active page. */
export function selectActivePage(s: DocumentStore): Page | undefined {
  return s.document.pages[s.document.activePageIndex];
}
