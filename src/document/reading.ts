/**
 * Opening a PDF to *read*, beside the note being written.
 *
 * A PDF dropped on a note you are working in used to be added to it page by page, which is the Import PDF button
 * by another route. What someone dropping a lecture or an exercise sheet next to their notes means is "let me look
 * at this while I write", so it now opens as a document of its own — in a new tab, and, where the window is wide
 * enough, in the reference pane beside the note, with the pen still on the note. The pages-into-this-note
 * behaviour is still there, one click away, and Undo takes it back.
 */
import { useDesktopStore } from '../desktop/desktopStore';
import { useDocumentStore } from './store';
import { MIN_SPLIT_WIDTH, openDocumentInTab, useTabStore } from './tabStore';
import { MAX_TABS } from './tabs';

export interface ReadingOutcome {
  /** The tab the PDF is in. */
  readonly tabId: string;
  /** Whether it is showing in the pane beside the note. */
  readonly beside: boolean;
  /** The tab that was being written in, when the PDF did not replace it. */
  readonly noteId: string | null;
}

/** Whether the window is wide enough to show two documents side by side. */
export function roomToSplit(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= MIN_SPLIT_WIDTH;
}

/**
 * Run a loader that opens a document, and show the result for reading: a new tab, and beside the note if there is
 * room, leaving the editor where it was. A note that is blank and untouched is simply replaced, as with any open.
 */
export async function openForReading(load: () => Promise<boolean>): Promise<ReadingOutcome | null> {
  const tabs = useTabStore.getState();
  if (tabs.tabs.length >= MAX_TABS) {
    useDesktopStore.getState().setNotice({ text: `Only ${MAX_TABS} tabs can be open at once. Close one first.` });
    return null;
  }
  const noteId = tabs.activeId ?? tabs.adoptCurrent();
  if (!(await openDocumentInTab(load))) return null;
  const tabId = useTabStore.getState().activeId;
  if (!tabId) return null;
  // The PDF took the place of a blank note: nothing to put back, nothing beside.
  if (tabId === noteId) return { tabId, beside: false, noteId: null };
  if (!roomToSplit()) return { tabId, beside: false, noteId };
  await useTabStore.getState().activate(noteId);
  await useTabStore.getState().showInSplit(tabId);
  return { tabId, beside: useTabStore.getState().splitId === tabId, noteId };
}

/** Add every page of a PDF to the note that is open, after its last page. */
export async function importPdfPagesInto(file: File): Promise<number> {
  const { loadPdfFile, buildPdfPages } = await import('../pdf/import');
  const loaded = await loadPdfFile(file);
  const pages = await buildPdfPages(loaded, loaded.pages.map((p) => p.index), { sizeMode: 'preserve' });
  useDocumentStore.getState().appendPages(pages);
  return pages.length;
}

/**
 * A PDF dropped on an open note. It opens for reading (see above), and the notice offers the other thing it could
 * have meant.
 */
export async function openDroppedPdf(file: File): Promise<void> {
  const setNotice = useDesktopStore.getState().setNotice;
  const { openBrowserFile } = await import('../library/openFile');
  const outcome = await openForReading(async () => (await openBrowserFile(file)) !== null);
  if (!outcome) return;

  const where = outcome.beside ? 'beside your note' : outcome.noteId ? 'in a new tab' : 'for reading';
  setNotice({
    text: `Opened ${file.name} ${where}.`,
    ...(outcome.noteId
      ? {
          action: {
            label: 'Add its pages to my note instead',
            run: () => {
              void (async () => {
                try {
                  const tabs = useTabStore.getState();
                  const noteId = outcome.noteId;
                  if (!noteId) return;
                  tabs.closeSplit();
                  await tabs.activate(noteId);
                  await useTabStore.getState().close(outcome.tabId);
                  const n = await importPdfPagesInto(file);
                  setNotice({ text: `Added ${n} page${n === 1 ? '' : 's'} from ${file.name}. Undo takes them out again.` });
                } catch (error) {
                  setNotice({ text: `Could not add ${file.name}: ${error instanceof Error ? error.message : String(error)}` });
                }
              })();
            },
          },
        }
      : {}),
  });
}
