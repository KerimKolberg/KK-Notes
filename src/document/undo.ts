import { useDesktopStore } from '../desktop/desktopStore';
import { canRedoStructure } from './structureHistory';
import { useDocumentStore, type DocumentStore } from './store';

/**
 * Undo and Redo for the note as a whole: a stroke on the page in view or a change to the pages, whichever came last
 * (see `structureHistory.ts`). A page change is a big thing to have happen under your eyes, so it is named.
 */
export function performUndo(): void {
  const label = useDocumentStore.getState().undoLast();
  if (label) useDesktopStore.getState().setNotice({ text: `Undid ${label}.` });
}

export function performRedo(): void {
  const label = useDocumentStore.getState().redoLast();
  if (label) useDesktopStore.getState().setNotice({ text: `Redid ${label}.` });
}

/** Whether Undo has anything to take back: a stroke on the page in view, or a change to the pages. */
export function selectCanUndo(s: DocumentStore): boolean {
  const page = s.document.pages[s.document.activePageIndex];
  return (page?.undoStack.length ?? 0) > 0 || s.structureUndo.length > 0;
}

/** Whether Redo has anything to put back. */
export function selectCanRedo(s: DocumentStore): boolean {
  const page = s.document.pages[s.document.activePageIndex];
  if ((page?.redoStack.length ?? 0) > 0) return true;
  return canRedoStructure(s.structureRedo[s.structureRedo.length - 1], s.document.pages);
}
