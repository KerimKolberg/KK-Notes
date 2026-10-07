import { Suspense, lazy, useCallback, useEffect, useRef } from 'react';
import { Zap } from 'lucide-react';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import { useUndoRedoShortcuts } from '../../inking/hooks/useUndoRedoShortcuts';
import { ToolPalette } from '../../inking/palette/ToolPalette';
import { ToolConfigRow } from '../../inking/palette/parts';
import { useDesktopIntegration } from '../../desktop/useDesktopIntegration';
import { useDesktopStore } from '../../desktop/desktopStore';
import { DebugOverlay } from '../../debug/DebugOverlay';
import { useMediaInput } from '../hooks/useMediaInput';
import { createStickyNote, createTable, createTextBox, nextZIndex, type NoteInit, type TableInit } from '../media';
import { usePageDefaultsSource } from '../../preferences/usePageDefaultsSource';
import type { MediaObject, Page } from '../types';
import { InsertMenu } from './InsertMenu';

/** PDF.js only loads when the import dialog is actually opened. */
const ImportPdfDialog = lazy(() => import('../../pdf/ImportPdfDialog').then((m) => ({ default: m.ImportPdfDialog })));
/**
 * The tab strip is not loaded at all while one document is open.
 *
 * Which is most of the time, and it is the case the drawing experience is judged
 * on: no strip code parsed, no document-store selectors, nothing. The count comes
 * from the tab store, which only changes when a tab does.
 */
const TabStrip = lazy(() => import('./TabStrip').then((m) => ({ default: m.TabStrip })));
/** The reference pane is not loaded until a document is actually put in it. */
const ReferencePane = lazy(() => import('./ReferencePane').then((m) => ({ default: m.ReferencePane })));
/** The zoom window is a second drawing surface, so it is not loaded until one is opened. */
const ZoomWindow = lazy(() => import('./ZoomWindow').then((m) => ({ default: m.ZoomWindow })));
/** The search panel, likewise, and for the same reason. */
const VersionHistory = lazy(() => import('./VersionHistory').then((m) => ({ default: m.VersionHistory })));
const BookmarksPanel = lazy(() => import('./BookmarksPanel').then((m) => ({ default: m.BookmarksPanel })));
const ContentsPanel = lazy(() => import('./ContentsPanel').then((m) => ({ default: m.ContentsPanel })));
const SearchPanel = lazy(() => import('./SearchPanel').then((m) => ({ default: m.SearchPanel })));
import { useDocumentStore } from '../store';
import { useZoomWindowStore } from '../zoomWindow';
import { useSearchStore } from '../../search/searchStore';
import { useVersionsStore } from '../../desktop/versionsStore';
import { useBookmarksStore } from '../bookmarksStore';
import { useContentsStore } from '../contentsStore';
import { performRedo, performUndo } from '../undo';
import { NoticeToast } from './NoticeToast';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import { SnipTray } from '../../snip/SnipTray';
import { useSnipStore } from '../../snip/snipStore';
import { useSnipping } from '../../snip/useSnipping';
import { useTextSelecting } from '../../textselect/useTextSelecting';
import { useHandwritingReader } from '../../handwriting/useHandwritingReader';
import { RecordingBar } from '../../audio/RecordingBar';
import { closePlayer } from '../../audio/player';
import { useTapToSeek } from '../../audio/useTapToSeek';
import { TextSelectionToolbar } from '../../textselect/TextSelectionToolbar';
import { useTextSelectStore } from '../../textselect/textSelectStore';
import { useToolStore } from '../toolStore';
import { DocumentViewer } from './DocumentViewer';
import { PageArranger } from './PageArranger';
import { TopBar } from './TopBar';
import { useTabStore } from '../tabStore';
import { errorMessage } from '../../lib/errors';
import { isEditableTarget } from '../../lib/dom';
import { FormatBar } from '../../typing/FormatBar';
import { typeOnPage } from '../../typing/flow/engine';
import { ShortcutSheet } from '../../typing/ShortcutSheet';
import { requestFocus, showWordCount } from '../../typing/typingStore';
import { WordCountDialog } from '../../typing/WordCountDialog';

/**
 * A panel that failed to draw is put away and the reason given, instead of taking the screen with it. Deferred a tick:
 * it is called while React is still rendering the failure.
 */
function panelFailed(name: string, error: Error, putAway: () => void): void {
  queueMicrotask(() => {
    putAway();
    useDesktopStore.getState().setNotice({ text: `${name} ran into a problem and was closed: ${error.message}` });
  });
}

/** Root of the multi-page notes UI: top bar, virtualised viewer, floating ink toolbar, arranger. */
export function DocumentApp() {
  const settings = useToolStore((s) => s.settings);
  const updateSettings = useToolStore((s) => s.update);
  const settingsRef = useLatestRef(settings);
  const zoomWindowOpen = useZoomWindowStore((s) => s.open);
  const searchOpen = useSearchStore((s) => s.open);
  const versionsOpen = useVersionsStore((s) => s.open);
  const bookmarksOpen = useBookmarksStore((s) => s.open);
  const contentsOpen = useContentsStore((s) => s.open);
  // The arranger is a drawer down the right-hand side, where the search and bookmark panels also sit, so
  // each gives way to the other rather than one covering the other's controls.
  const arrangerOpen = useDocumentStore((s) => s.arrangerOpen);
  useEffect(() => {
    if (!arrangerOpen) return;
    useSearchStore.getState().close();
    useBookmarksStore.getState().close();
    useContentsStore.getState().close();
  }, [arrangerOpen]);
  useEffect(() => {
    if (searchOpen || bookmarksOpen || contentsOpen) useDocumentStore.getState().setArrangerOpen(false);
  }, [searchOpen, bookmarksOpen, contentsOpen]);

  // Undo / redo live in the top bar now; the app only needs the page id for
  // the keyboard shortcuts and for clearing.
  const activePageId = useDocumentStore((s) => s.document.pages[s.document.activePageIndex]?.id ?? '');
  const readOnly = useDocumentStore((s) => s.readOnly);
  const clearPage = useDocumentStore((s) => s.clearPage);

  /** Drop a new note or table on the page the reader is looking at. */
  const insertMedia = useCallback(
    (make: (page: Page, zIndex: number) => MediaObject) => {
      const state = useDocumentStore.getState();
      if (state.readOnly) return;
      const page = state.document.pages[state.document.activePageIndex];
      if (!page) return;
      state.addMedia(page.id, make(page, nextZIndex(page.media)));
      // Both are dragged and typed into with the select tool, so switch to it
      // rather than leaving the pen armed over something you want to edit.
      updateSettings({ tool: 'select' });
    },
    [updateSettings],
  );
  const insertNote = useCallback(
    (init: NoteInit) => insertMedia((page, z) => createStickyNote(page.dimensions, z, undefined, init)),
    [insertMedia],
  );
  const insertText = useCallback(
    () =>
      insertMedia((page, z) => {
        const box = createTextBox(page.dimensions, z);
        // Typed into straight away, as a word processor's new text box is.
        requestFocus(box.id, 'end');
        return box;
      }),
    [insertMedia],
  );
  /**
   * A dropped text file, as a text box holding its contents.
   *
   * Sized to the text rather than left at the default box, since a paragraph in a
   * 260×80 box would arrive scrolled out of sight. Capped, because a log file is
   * also a text file and a box taller than the page is no use to anybody — the
   * rest is still there, in the box, reachable by scrolling it.
   */
  const addTextFromFile = useCallback(
    (text: string) =>
      insertMedia((page, z) => {
        const lines = text.split('\n').length;
        const height = Math.min(page.dimensions.height * 0.8, Math.max(80, lines * 22 + 24));
        return createTextBox(page.dimensions, z, undefined, {
          text,
          width: Math.min(page.dimensions.width * 0.8, 420),
          height,
        });
      }),
    [insertMedia],
  );
  /** Type on the page in view, word-processor style (`typing/flow/`). */
  const typeOnActivePage = useCallback(() => {
    const state = useDocumentStore.getState();
    if (state.readOnly) return;
    updateSettings({ tool: 'select' });
    typeOnPage(state.document.activePageIndex);
  }, [updateSettings]);
  const insertTable = useCallback(
    (init: TableInit) => insertMedia((page, z) => createTable(page.dimensions, z, undefined, init)),
    [insertMedia],
  );

  const clearPageInkActive = useCallback(
    () => useDocumentStore.getState().clearPageInk(activePageId, settingsRef.current.eraseFilter),
    [activePageId, settingsRef],
  );
  const clearDocumentInkActive = useCallback(
    () => useDocumentStore.getState().clearDocumentInk(settingsRef.current.eraseFilter),
    [settingsRef],
  );

  const clearActive = useCallback(() => clearPage(activePageId), [clearPage, activePageId]);
  useUndoRedoShortcuts(performUndo, performRedo, !readOnly);
  useDesktopIntegration();
  useSnipping();
  useTextSelecting();
  useHandwritingReader();
  useTapToSeek();
  // New pages pick up whatever the user set as their default layout.
  usePageDefaultsSource();

  const importDialogOpen = useDocumentStore((s) => s.importDialogOpen);

  /**
   * A non-image file dropped on the page stage.
   *
   * A PDF opens for *reading*: in a new tab, and beside the note when there is room (see `reading.ts`). The
   * gesture is "let me look at this while I write", and adding its pages to the note is the notice's button
   * (and Import PDF), both of which Undo takes back.
   *
   * A note or a notebook is a whole document, so it opens in a tab of its own.
   */
  const openDroppedFile = useCallback((file: File) => {
    const name = file.name.toLowerCase();
    const setNotice = useDesktopStore.getState().setNotice;
    const fail = (error: unknown): void => {
      setNotice({ text: `Could not open ${file.name}: ${errorMessage(error)}` });
    };

    if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
      // Opens beside the note for reading; the pages-into-this-note behaviour is the notice's button.
      void (async () => {
        const { openDroppedPdf } = await import('../reading');
        await openDroppedPdf(file);
      })().catch(fail);
      return;
    }

    // A plain text file becomes a text box on the page, which is the same thing
    // the Insert menu's text tool does — dropping one is "add this", not "open
    // this", and there is no document in a `.txt` to open.
    if (file.type.startsWith('text/') || /\.(txt|md|markdown|text)$/i.test(name)) {
      if (useDocumentStore.getState().readOnly) {
        setNotice({ text: 'This document is locked for presenting, so text cannot be added to it.' });
        return;
      }
      void (async () => {
        const text = await file.text();
        if (text.trim() === '') {
          setNotice({ text: `${file.name} is empty.` });
          return;
        }
        addTextFromFile(text);
      })().catch(fail);
      return;
    }

    // A note or a notebook is a whole document, so it opens in its own tab
    // rather than replacing what is in front of you.
    void (async () => {
      const { isOpenable, openBrowserFile } = await import('../../library/openFile');
      if (!isOpenable(file.name)) {
        setNotice({ text: `${file.name} is not something this app can open.` });
        return;
      }
      const { openDocumentInTab } = await import('../tabStore');
      await openDocumentInTab(async () => (await openBrowserFile(file)) !== null);
    })().catch(fail);
  }, [addTextFromFile]);
  const { onDragOver, onDrop, pickImage } = useMediaInput(openDroppedFile);
  /** The palette floats inside this area and is clamped to it. */
  const stageRef = useRef<HTMLDivElement>(null);

  const tabCount = useTabStore((s) => s.tabs.length);
  const splitId = useTabStore((s) => s.splitId);
  const splitRatio = useTabStore((s) => s.splitRatio);
  const splitSide = useTabStore((s) => s.splitSide);
  /** Dragging the divider, as a fraction of the stage the editor keeps. */
  const dragDivider = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const move = (e: PointerEvent): void => {
      // The editor's share, measured from whichever edge it is against.
      const fromEdge = useTabStore.getState().splitSide === 'right' ? e.clientX - rect.left : rect.right - e.clientX;
      useTabStore.getState().setSplitRatio(fromEdge / Math.max(1, rect.width));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  // Whatever is open becomes the first tab. Idempotent, so remounting the
  // document view does not multiply tabs — and there is deliberately no
  // subscription here: see the note at the bottom of `tabStore.ts`.
  useEffect(() => {
    useTabStore.getState().adoptCurrent();
  }, []);

  // A lasso selection only lives while the lasso / select tools are active.
  useEffect(() => {
    if (settings.tool !== 'lasso' && settings.tool !== 'select') useDocumentStore.getState().clearLassoSelection();
  }, [settings.tool]);

  // Delete / Backspace removes the lasso selection or the selected media; Escape deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const {
        selectedMedia,
        lassoSelection,
        removeMedia,
        selectMedia,
        deleteSelection,
        clearLassoSelection,
        copySelection,
        cutSelection,
        pasteSelection,
        groupSelection,
        ungroupSelection,
        readOnly: locked,
      } = useDocumentStore.getState();
      // Ctrl+F is search, from anywhere — a text box included, where the browser's own find would
      // otherwise open over the page.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        useBookmarksStore.getState().close();
        useSearchStore.getState().show();
        return;
      }
      if (isEditableTarget(e.target)) return;
      // Ctrl+Shift+G (Word) or Ctrl+Shift+C (Docs): the note's word count. In a text box the editor has them.
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key.toLowerCase() === 'g' || e.key.toLowerCase() === 'c')) {
        e.preventDefault();
        showWordCount();
        return;
      }
      // Ctrl+D bookmarks the page in view, or takes its bookmark away.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (!useDocumentStore.getState().readOnly) {
          const { document: doc, setPageBookmark } = useDocumentStore.getState();
          const page = doc.pages[doc.activePageIndex];
          if (page) setPageBookmark(page.id, page.bookmark === undefined ? '' : null);
        }
        return;
      }
      // Copy, cut, paste and group, for a selection. Copying is allowed on a locked note
      // (it changes nothing), and the rest are not.
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        if (key === 'c' && lassoSelection) {
          e.preventDefault();
          copySelection(lassoSelection.pageId, lassoSelection.strokeIds);
          return;
        }
        if (locked) return;
        if (key === 'x' && lassoSelection) {
          e.preventDefault();
          cutSelection(lassoSelection.pageId, lassoSelection.strokeIds);
          return;
        }
        if (key === 'v') {
          const { document: doc } = useDocumentStore.getState();
          const target = doc.pages[doc.activePageIndex];
          if (target && pasteSelection(target.id)) {
            e.preventDefault();
            // The copies are selected, and a selection only shows under the lasso.
            if (useToolStore.getState().settings.tool !== 'lasso') useToolStore.getState().update({ tool: 'lasso' });
          }
          return;
        }
        if (key === 'g' && lassoSelection) {
          e.preventDefault();
          if (e.shiftKey) ungroupSelection(lassoSelection.pageId, lassoSelection.strokeIds);
          else groupSelection(lassoSelection.pageId, lassoSelection.strokeIds);
          return;
        }
        return;
      }
      if (locked) return;
      const isDelete = e.key === 'Delete' || e.key === 'Backspace';
      if (lassoSelection) {
        if (isDelete) {
          e.preventDefault();
          deleteSelection(lassoSelection.pageId, lassoSelection.strokeIds);
        } else if (e.key === 'Escape') {
          clearLassoSelection();
        }
        return;
      }
      if (!selectedMedia) return;
      if (isDelete) {
        e.preventDefault();
        removeMedia(selectedMedia.pageId, selectedMedia.mediaId);
      } else if (e.key === 'Escape') {
        selectMedia(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <TopBar />
      {tabCount >= 2 && (
        <Suspense fallback={null}>
          <TabStrip />
        </Suspense>
      )}
      <div ref={stageRef} className={`flex min-h-0 flex-1 ${splitId && splitSide === 'left' ? 'flex-row-reverse' : ''}`}>
        <div
          className="relative min-h-0 min-w-0 flex-1"
          data-page-stage
          style={splitId ? { flex: `0 0 ${(splitRatio * 100).toFixed(2)}%` } : undefined}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
            <DocumentViewer settingsRef={settingsRef} currentTool={settings.tool} />
          <ErrorBoundary what="the text formatting" fallback={null} onError={(e) => panelFailed('The text formatting', e, () => useDocumentStore.getState().selectMedia(null))}>
            <FormatBar />
          </ErrorBoundary>
          {searchOpen && (
            <ErrorBoundary what="the search" fallback={null} onError={(e) => panelFailed('The search', e, () => useSearchStore.getState().close())}>
              <Suspense fallback={null}>
                <SearchPanel />
              </Suspense>
            </ErrorBoundary>
          )}
          {/* Before the notices, which pass over it. */}
          <ErrorBoundary what="the recorder" fallback={null} onError={(e) => panelFailed('The recording player', e, closePlayer)}>
            <RecordingBar />
          </ErrorBoundary>
          <NoticeToast />
          <ErrorBoundary what="the text selection" fallback={null} onError={(e) => panelFailed('Selecting text', e, () => useTextSelectStore.getState().setMode(false))}>
            <TextSelectionToolbar />
          </ErrorBoundary>
          <ErrorBoundary what="the snips" fallback={null} onError={(e) => panelFailed('The snip tray', e, () => useSnipStore.getState().setMode(false))}>
            <SnipTray />
          </ErrorBoundary>
          {bookmarksOpen && (
            <ErrorBoundary what="the bookmarks" fallback={null} onError={(e) => panelFailed('The bookmarks', e, () => useBookmarksStore.getState().close())}>
              <Suspense fallback={null}>
                <BookmarksPanel />
              </Suspense>
            </ErrorBoundary>
          )}
          {contentsOpen && (
            <ErrorBoundary what="the contents" fallback={null} onError={(e) => panelFailed('The contents', e, () => useContentsStore.getState().close())}>
              <Suspense fallback={null}>
                <ContentsPanel />
              </Suspense>
            </ErrorBoundary>
          )}
          {versionsOpen && (
            <ErrorBoundary what="the version history" fallback={null} onError={(e) => panelFailed('The version history', e, () => useVersionsStore.getState().close())}>
              <Suspense fallback={null}>
                <VersionHistory />
              </Suspense>
            </ErrorBoundary>
          )}
          {/* Above everything and inert, so it can never intercept a stroke. */}
          <DebugOverlay enabled={settings.debugMode} />
          {/* Locked: the palette fades away entirely and a slim status pill takes
              its place, keeping the laser (which marks nothing) within reach. */}
          <ToolPalette
            settings={settings}
            onSettingsChange={updateSettings}
            onClear={clearActive}
            containerRef={stageRef}
            insertMenu={(onInsertDone) => (
              <InsertMenu
                onInsertImage={pickImage}
                onInsertNote={insertNote}
                onInsertText={insertText}
                onTypeOnPage={typeOnActivePage}
                onInsertTable={insertTable}
                onDone={onInsertDone}
              />
            )}
            onClearPageInk={clearPageInkActive}
            onClearDocumentInk={clearDocumentInkActive}
            hidden={readOnly}
          />
          {/* …and the laser still needs its colour and width, so the config row
              survives the lock even though the rest of the palette does not. */}
          {readOnly && settings.tool === 'laser-pointer' && (
            <div
              className="absolute left-1/2 z-30 w-[min(30rem,calc(100vw-1.5rem-var(--safe-left)-var(--safe-right)))] -translate-x-1/2 rounded-2xl border border-zinc-200/80 bg-white/90 p-1.5 shadow-2xl dark:border-zinc-700/80 dark:bg-zinc-900/90"
              style={{ bottom: 'calc(4.25rem + var(--safe-bottom))' }}
              data-locked-tool-config
            >
              <ToolConfigRow settings={settings} onSettingsChange={updateSettings} />
            </div>
          )}
          {readOnly && (
            <div
              className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900/85 py-1.5 pl-4 pr-1.5 text-sm font-medium text-white shadow-lg dark:bg-zinc-100/90 dark:text-zinc-900"
              style={{ bottom: 'calc(1rem + var(--safe-bottom))' }}
              data-read-only-banner
            >
              <span role="status">Read-only</span>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-blue-400 ${
                  settings.tool === 'laser-pointer'
                    ? 'bg-white text-zinc-900 dark:bg-zinc-900 dark:text-white'
                    : 'bg-white/15 hover:bg-white/25 dark:bg-zinc-900/10 dark:hover:bg-zinc-900/20'
                }`}
                aria-label="Laser pointer"
                aria-pressed={settings.tool === 'laser-pointer'}
                onClick={() => updateSettings({ tool: settings.tool === 'laser-pointer' ? 'pen' : 'laser-pointer' })}
                data-laser-toggle
              >
                <Zap size={15} aria-hidden="true" />
                Laser
              </button>
            </div>
          )}
        </div>
        {splitId && (
          <>
            {/* A grab strip rather than a hairline: on a tablet this is dragged
                with a finger or the pen, so it is 8px wide with a wider hit box. */}
            <div
              className="relative w-2 shrink-0 cursor-col-resize bg-zinc-300 hover:bg-blue-400 dark:bg-zinc-700 dark:hover:bg-blue-500"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the reference pane"
              data-split-divider
              onPointerDown={dragDivider}
            >
              <span className="absolute inset-y-0 -left-3 -right-3" />
            </div>
            <Suspense fallback={null}>
              <ReferencePane />
            </Suspense>
          </>
        )}
      </div>
      {zoomWindowOpen && (
        <Suspense fallback={null}>
          <ZoomWindow settingsRef={settingsRef} currentTool={settings.tool} />
        </Suspense>
      )}
      <PageArranger />
      <WordCountDialog />
      <ShortcutSheet />
      {importDialogOpen && (
        <Suspense fallback={null}>
          <ImportPdfDialog />
        </Suspense>
      )}
    </div>
  );
}
