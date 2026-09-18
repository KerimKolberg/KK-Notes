import { Suspense, lazy, useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Zap } from 'lucide-react';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import { useUndoRedoShortcuts } from '../../inking/hooks/useUndoRedoShortcuts';
import { ToolPalette } from '../../inking/palette/ToolPalette';
import { ToolConfigRow } from '../../inking/palette/parts';
import { useDesktopIntegration } from '../../desktop/useDesktopIntegration';
import { DebugOverlay } from '../../debug/DebugOverlay';
import { useMediaInput } from '../hooks/useMediaInput';
import { createStickyNote, createTable, nextZIndex, type NoteInit, type TableInit } from '../media';
import { usePageDefaultsSource } from '../../preferences/usePageDefaultsSource';
import type { MediaObject, Page } from '../types';
import { InsertMenu } from './InsertMenu';

/** PDF.js only loads when the import dialog is actually opened. */
const ImportPdfDialog = lazy(() => import('../../pdf/ImportPdfDialog').then((m) => ({ default: m.ImportPdfDialog })));
import { useDocumentStore } from '../store';
import { useToolStore } from '../toolStore';
import { DocumentViewer } from './DocumentViewer';
import { PageArranger } from './PageArranger';
import { TopBar } from './TopBar';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Root of the multi-page notes UI: top bar, virtualised viewer, floating ink toolbar, arranger. */
export function DocumentApp() {
  const settings = useToolStore((s) => s.settings);
  const updateSettings = useToolStore((s) => s.update);
  const settingsRef = useLatestRef(settings);

  // Undo / redo live in the top bar now; the app only needs the page id for
  // the keyboard shortcuts and for clearing.
  const activePageId = useDocumentStore((s) => s.document.pages[s.document.activePageIndex]?.id ?? '');
  const readOnly = useDocumentStore((s) => s.readOnly);
  const { undo, redo, clearPage } = useDocumentStore(
    useShallow((s) => ({ undo: s.undo, redo: s.redo, clearPage: s.clearPage })),
  );

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

  const undoActive = useCallback(() => undo(activePageId), [undo, activePageId]);
  const redoActive = useCallback(() => redo(activePageId), [redo, activePageId]);
  const clearActive = useCallback(() => clearPage(activePageId), [clearPage, activePageId]);
  useUndoRedoShortcuts(undoActive, redoActive, !readOnly);
  useDesktopIntegration();
  // New pages pick up whatever the user set as their default layout.
  usePageDefaultsSource();

  const importDialogOpen = useDocumentStore((s) => s.importDialogOpen);

  // Dropped PDFs import all their pages at the end of the document.
  const importDroppedPdf = useCallback((file: File) => {
    if (useDocumentStore.getState().readOnly) return;
    void (async () => {
      const { loadPdfFile, buildPdfPages } = await import('../../pdf/import');
      const loaded = await loadPdfFile(file);
      const pages = await buildPdfPages(loaded, loaded.pages.map((p) => p.index), { sizeMode: 'preserve' });
      useDocumentStore.getState().appendPages(pages);
    })().catch(() => undefined);
  }, []);
  const { onDragOver, onDrop, pickImage } = useMediaInput(importDroppedPdf);
  /** The palette floats inside this area and is clamped to it. */
  const stageRef = useRef<HTMLDivElement>(null);

  // A lasso selection only lives while the lasso / select tools are active.
  useEffect(() => {
    if (settings.tool !== 'lasso' && settings.tool !== 'select') useDocumentStore.getState().clearLassoSelection();
  }, [settings.tool]);

  // Delete / Backspace removes the lasso selection or the selected media; Escape deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { selectedMedia, lassoSelection, removeMedia, selectMedia, deleteSelection, clearLassoSelection, readOnly: locked } =
        useDocumentStore.getState();
      if (locked || isEditableTarget(e.target)) return;
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
      <div ref={stageRef} className="relative min-h-0 flex-1" onDragOver={onDragOver} onDrop={onDrop}>
        <DocumentViewer settingsRef={settingsRef} currentTool={settings.tool} />
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
            className="absolute left-1/2 z-30 w-[min(30rem,calc(100vw-1.5rem-var(--safe-left)-var(--safe-right)))] -translate-x-1/2 rounded-2xl border border-zinc-200/80 bg-white/90 p-1.5 shadow-2xl backdrop-blur-md dark:border-zinc-700/80 dark:bg-zinc-900/90"
            style={{ bottom: 'calc(4.25rem + var(--safe-bottom))' }}
            data-locked-tool-config
          >
            <ToolConfigRow settings={settings} onSettingsChange={updateSettings} />
          </div>
        )}
        {readOnly && (
          <div
            className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-zinc-900/85 py-1.5 pl-4 pr-1.5 text-sm font-medium text-white shadow-lg backdrop-blur dark:bg-zinc-100/90 dark:text-zinc-900"
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
      <PageArranger />
      {importDialogOpen && (
        <Suspense fallback={null}>
          <ImportPdfDialog />
        </Suspense>
      )}
    </div>
  );
}
