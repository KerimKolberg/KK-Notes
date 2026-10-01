/**
 * Opening a PDF dropped on the note being written, to read it alongside.
 *
 * Dropping a PDF where nothing is open (or only a blank new note) makes it the document to write on, as any open
 * does. Dropping one on a note that has work in it opens it as **another tab**, and nothing else: the pen stays on
 * the note, and putting the PDF beside it is the split-screen button on its tab (or the notice's button). Showing it
 * at once would decide the layout for someone who may only have wanted it to hand.
 */
import { useDesktopStore } from '../desktop/desktopStore';
import { useDocumentStore } from './store';
import { MIN_SPLIT_WIDTH, captureSession, openDocumentInTab, restoreSession, useTabStore } from './tabStore';
import { MAX_TABS, isPristine, type TabSession } from './tabs';

export interface TabOutcome {
  /** The tab the document is in. */
  readonly tabId: string;
  /** The tab that was being written in, when the document did not replace it; the editor stays on it. */
  readonly noteId: string | null;
}

/** Whether the window is wide enough to show two documents side by side. */
export function roomToSplit(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= MIN_SPLIT_WIDTH;
}

/** A note with nothing in it: one empty page, no cover, no bookmark. */
export function isBlankNote(session: TabSession): boolean {
  const { pages, cover } = session.document;
  const [page] = pages;
  return (
    pages.length === 1 &&
    !cover &&
    !!page &&
    !page.pdf &&
    page.strokes.length === 0 &&
    page.media.length === 0 &&
    page.bookmark === undefined
  );
}

/**
 * A note made in the library is a file from the moment it is made, so it is never "unsaved and untouched" — but with
 * nothing in it, a PDF dropped on it is plainly the thing to write on. The PDF's pages become its pages, and it stays
 * the same note: same file, same place in the library, the name it was given if it was given one, and marked unsaved
 * until Save writes the pages into it. (Opening the PDF in a tab beside it would leave a blank note behind.)
 */
async function fillBlankNote(before: TabSession, load: () => Promise<boolean>): Promise<boolean> {
  let loaded = false;
  try {
    loaded = await load();
  } finally {
    if (!loaded) restoreSession(before);
  }
  if (!loaded) return false;
  const doc = useDocumentStore.getState().document;
  const named = before.document.title.trim() !== '' && before.document.title !== 'Untitled note';
  useDocumentStore.setState({
    document: named ? { ...doc, title: before.document.title } : doc,
    filePath: before.filePath,
    // What is on disk is the blank note, so the pages differ from it and the note shows as unsaved.
    savedPages: before.savedPages,
    savedTitle: before.savedTitle,
    savedCover: before.savedCover,
  });
  return true;
}

/**
 * Run a loader that opens a document, and land the result in a new tab behind the one being written in, which stays
 * the editor. A note that is blank and untouched is simply replaced, as with any open, and then there is no other tab.
 */
export async function openBesideNote(load: () => Promise<boolean>): Promise<TabOutcome | null> {
  const tabs = useTabStore.getState();
  if (tabs.tabs.length >= MAX_TABS) {
    useDesktopStore.getState().setNotice({ text: `Only ${MAX_TABS} tabs can be open at once. Close one first.` });
    return null;
  }
  const noteId = tabs.activeId ?? tabs.adoptCurrent();
  const before = captureSession();
  if (isBlankNote(before) && !isPristine(before)) {
    if (!(await fillBlankNote(before, load))) return null;
    return { tabId: noteId, noteId: null };
  }
  if (!(await openDocumentInTab(load))) return null;
  const tabId = useTabStore.getState().activeId;
  if (!tabId) return null;
  // Took the place of a blank note: it is the document to write on, and there is nothing to go back to.
  if (tabId === noteId) return { tabId, noteId: null };
  await useTabStore.getState().activate(noteId);
  return { tabId, noteId };
}

/**
 * A PDF dropped on an open note: another tab, with the notice offering to put it beside the note (or, on a window
 * too narrow for two columns, to open it).
 */
export async function openDroppedPdf(file: File): Promise<void> {
  const setNotice = useDesktopStore.getState().setNotice;
  const { openBrowserFile } = await import('../library/openFile');
  const outcome = await openBesideNote(async () => (await openBrowserFile(file)) !== null);
  if (!outcome) return;
  if (!outcome.noteId) {
    setNotice({ text: `Opened ${file.name}.` });
    return;
  }
  const { tabId } = outcome;
  const wide = roomToSplit();
  setNotice({
    text: `Opened ${file.name} in a new tab.`,
    action: {
      label: wide ? 'Split screen' : 'Open it',
      run: () => {
        const tabsNow = useTabStore.getState();
        void (wide ? tabsNow.showInSplit(tabId) : tabsNow.activate(tabId));
        setNotice(null);
      },
    },
  });
}
