import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import { useUndoRedoShortcuts } from '../../inking/hooks/useUndoRedoShortcuts';
import { InkingToolbar } from '../../inking/InkingToolbar';
import { useDocumentStore } from '../store';
import { useToolStore } from '../toolStore';
import { DocumentViewer } from './DocumentViewer';
import { PageArranger } from './PageArranger';
import { TopBar } from './TopBar';

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
  const { undo, redo, clearPage } = useDocumentStore(
    useShallow((s) => ({ undo: s.undo, redo: s.redo, clearPage: s.clearPage })),
  );

  const undoActive = useCallback(() => undo(activePageId), [undo, activePageId]);
  const redoActive = useCallback(() => redo(activePageId), [redo, activePageId]);
  const clearActive = useCallback(() => clearPage(activePageId), [clearPage, activePageId]);
  useUndoRedoShortcuts(undoActive, redoActive);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <TopBar />
      <div className="relative min-h-0 flex-1">
        <DocumentViewer settingsRef={settingsRef} currentTool={settings.tool} />
        <InkingToolbar
          settings={settings}
          onSettingsChange={updateSettings}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={undoActive}
          onRedo={redoActive}
          onClear={clearActive}
        />
      </div>
      <PageArranger />
    </div>
  );
}
