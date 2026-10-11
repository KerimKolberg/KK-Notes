/**
 * Going back to the library from a note, without losing what was written in it.
 *
 * The Home button used to drop the open document: only the crash draft kept it, and that is not the note. Now a note
 * from the library (or any file) is saved to its file on the way out, as a notes app is expected to; one that has
 * never been saved anywhere — a blank note, a PDF just opened — is asked about: saved into the library, left, or
 * stayed with.
 */
import { selectIsDirty, useDocumentStore } from '../document/store';
import { actionSave } from '../desktop/fileActions';
import { clearDraft } from '../desktop/fileService';
import { isTauri } from '../desktop/tauri';
import { useDesktopStore } from '../desktop/desktopStore';
import { errorMessage } from '../lib/errors';
import { BROWSER_ROOT, addDocumentToLibrary, updateBrowserLibraryDocument } from './libraryService';

/** What leaving needs: nothing, a save to the note's own file, or a question. */
export type LeaveStep = 'go' | 'save' | 'ask';

export function leaveStep(dirty: boolean, filePath: string | null): LeaveStep {
  if (!dirty) return 'go';
  return filePath ? 'save' : 'ask';
}

/** Save the open note to its own file. False (with a notice) when that failed: then the note stays open. */
export async function saveToItsFile(): Promise<boolean> {
  const { filePath, document } = useDocumentStore.getState();
  if (!filePath) return false;
  if (isTauri()) return actionSave();
  if (!filePath.startsWith(`${BROWSER_ROOT}/`)) return actionSave();
  try {
    updateBrowserLibraryDocument(document, filePath);
    useDocumentStore.getState().markSaved(filePath);
    await clearDraft().catch(() => {});
    return true;
  } catch (error) {
    useDesktopStore.getState().setNotice({ text: `Could not save: ${errorMessage(error)}` });
    return false;
  }
}

/** Save a note that has no file into the library, under its title. */
export async function saveIntoLibrary(): Promise<boolean> {
  try {
    const path = await addDocumentToLibrary(useDocumentStore.getState().document);
    useDocumentStore.getState().markSaved(path);
    await clearDraft().catch(() => {});
    return true;
  } catch (error) {
    useDesktopStore.getState().setNotice({ text: `Could not save to the library: ${errorMessage(error)}` });
    return false;
  }
}

/** Leaving without saving: the crash draft goes too, or the next start would bring back what was let go. */
export async function forgetDraft(): Promise<void> {
  await clearDraft().catch(() => {});
}

/** The step for the note open now. */
export function currentLeaveStep(): LeaveStep {
  const state = useDocumentStore.getState();
  return leaveStep(selectIsDirty(state), state.filePath);
}
