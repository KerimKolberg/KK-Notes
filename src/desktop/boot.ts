/**
 * What the app opens on.
 *
 * With a library as the home screen this decision has to be made *above* the
 * router: a `.notex` opened through the file association, or an autosaved
 * draft from a session that ended badly, should land the user in that document
 * rather than in a file list with no hint that either exists. Everything else
 * starts at the library.
 */
import { selectIsDirty, useDocumentStore } from '../document/store';
import { useDesktopStore } from './desktopStore';
import { actionOpenPath } from './fileActions';
import { clearDraft, getStartupFile, loadDraft } from './fileService';

export interface BootTarget {
  /** Where to go. */
  readonly view: 'library' | 'document';
  /** The document's path, when there is one. */
  readonly path: string | null;
}

export const START_AT_LIBRARY: BootTarget = { view: 'library', path: null };

/**
 * Load whatever the app was asked to open, and say where to go.
 *
 * A file association argument wins outright — the user double-clicked a
 * specific document. Otherwise an autosaved draft is restored and flagged as
 * unsaved work, with a notice offering to discard it, because silently
 * reopening something the user may have abandoned is worse than asking.
 */
export async function resolveBootTarget(): Promise<BootTarget> {
  try {
    const startup = await getStartupFile();
    if (startup) {
      await actionOpenPath(startup);
      return { view: 'document', path: startup };
    }

    const draft = await loadDraft();
    if (!draft) return START_AT_LIBRARY;
    const store = useDocumentStore.getState();
    if (selectIsDirty(store)) return START_AT_LIBRARY; // the user already started working
    store.loadDocument(draft.document, null);
    // A restored draft is unsaved work: mark it dirty so Save and autosave
    // stay armed rather than believing it is already on disk somewhere.
    useDocumentStore.setState({ savedPages: null, savedTitle: null });
    useDesktopStore.getState().setNotice({
      text: draft.savedAt
        ? `Restored autosaved draft from ${new Date(draft.savedAt).toLocaleString()}`
        : 'Restored autosaved draft',
      action: {
        label: 'Discard',
        run: () => {
          useDocumentStore.getState().newDocument();
          void clearDraft();
          useDesktopStore.getState().setNotice(null);
        },
      },
    });
    return { view: 'document', path: null };
  } catch {
    // No draft, no startup file, or no desktop shell at all.
    return START_AT_LIBRARY;
  }
}
