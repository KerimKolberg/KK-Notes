import { Suspense, lazy, useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import { useUndoRedoShortcuts } from '../../inking/hooks/useUndoRedoShortcuts';
import { InkingToolbar } from '../../inking/InkingToolbar';
import { useDesktopIntegration } from '../../desktop/useDesktopIntegration';
import { useMediaInput } from '../hooks/useMediaInput';

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

  const { activePageId, canUndo, canRedo } = useDocumentStore(
    useShallow((s) => {
      const page = s.document.pages[s.document.activePageIndex];
      return {
        activePageId: page?.id ?? '',
        canUndo: (page?.undoStack.length ?? 0) > 0,
        canRedo: (page?.redoStack.length ?? 0) > 0,
      };
    }),
  );
  const readOnly = useDocumentStore((s) => s.readOnly);
  const { undo, redo, clearPage } = useDocumentStore(
    useShallow((s) => ({ undo: s.undo, redo: s.redo, clearPage: s.clearPage })),
  );

  const undoActive = useCallback(() => undo(activePageId), [undo, activePageId]);
  const redoActive = useCallback(() => redo(activePageId), [redo, activePageId]);
  const clearActive = useCallback(() => clearPage(activePageId), [clearPage, activePageId]);
  useUndoRedoShortcuts(undoActive, redoActive, !readOnly);
  useDesktopIntegration();

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
  const { onDragOver, onDrop } = useMediaInput(importDroppedPdf);

  // A lasso selection only lives while the lasso / select tools are active.
  useEffect(() => {
    if (settings.tool !== 'lasso' && settings.tool !== 'select') useDocumentStore.getState().clearLassoSelection();
  }, [settings.tool]);

  // Delete / Backspace removes the lasso selection or the selected image; Escape deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { selectedImage, lassoSelection, removeImage, selectImage, deleteSelection, clearLassoSelection, readOnly: locked } =
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
      if (!selectedImage) return;
      if (isDelete) {
        e.preventDefault();
        removeImage(selectedImage.pageId, selectedImage.imageId);
      } else if (e.key === 'Escape') {
        selectImage(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <TopBar />
      <div className="relative min-h-0 flex-1" onDragOver={onDragOver} onDrop={onDrop}>
        <DocumentViewer settingsRef={settingsRef} currentTool={settings.tool} />
        {readOnly ? (
          <p
            className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-zinc-900/85 px-4 py-2 text-sm font-medium text-white shadow-lg backdrop-blur dark:bg-zinc-100/90 dark:text-zinc-900"
            role="status"
            data-read-only-banner
          >
            Read-only — unlock to edit
          </p>
        ) : (
          <InkingToolbar
            settings={settings}
            onSettingsChange={updateSettings}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undoActive}
            onRedo={redoActive}
            onClear={clearActive}
          />
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
