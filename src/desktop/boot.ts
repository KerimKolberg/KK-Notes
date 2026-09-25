/**
 * What the app opens on.
 *
 * With a library as the home screen this decision has to be made *above* the
 * router: a `.notex` opened through the file association, or an autosaved
 * draft from a session that ended badly, should land the user in that document
 * rather than in a file list with no hint that either exists. Everything else
 * starts at the library.
 */
import { createDocument, renumber as renumberPages } from '../document/operations';
import { selectIsDirty, useDocumentStore } from '../document/store';
import { fileBaseName, titleFromFileName } from './notex';
import { classifyOpenWith, takeAndroidOpenWith, type OpenWithRequest } from './openWith';
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
 * Open whatever a launch pointed at, whichever kind of document it is.
 *
 * A `.notex` opens as itself. A PDF becomes a *new* document with the PDF's
 * pages imported into it — the app does not edit PDFs in place, and someone
 * who tapped "open with" on a PDF wants to write on it, not to be shown a
 * file list. Returns `null` when the file is neither, or could not be read,
 * so the caller falls through to the library rather than showing nothing.
 */
export async function openRequested(request: OpenWithRequest): Promise<BootTarget | null> {
  const kind = classifyOpenWith(request);
  try {
    if (kind === 'notex') {
      await actionOpenPath(request.uri);
      return { view: 'document', path: request.uri };
    }
    if (kind === 'pdf') {
      await importPdfAsDocument(request.uri);
      // A new, unsaved document: it has no path of its own yet.
      return { view: 'document', path: null };
    }
    if (kind === 'goodnotes') {
      await importGoodNotesAsDocument(request.uri);
      return { view: 'document', path: null };
    }
  } catch (error) {
    useDesktopStore.getState().setNotice({
      text: `Could not open that file: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return null;
}

/**
 * Turn a PDF into a fresh document with its pages imported.
 *
 * The bytes are read through the fs plugin rather than a native command,
 * because on Android the launch hands over a `content://` URI and only the
 * platform's content resolver can open one.
 */
async function importPdfAsDocument(uri: string): Promise<void> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(uri);
  const { loadPdfData } = await import('../pdf/import');
  const name = fileBaseName(uri.split(/[?#]/)[0] ?? uri) || 'Imported PDF';
  const copy = bytes.slice();
  await adoptPdf(await loadPdfData(copy.buffer as ArrayBuffer, name), name);
}

/**
 * Turn a GoodNotes notebook into a fresh document.
 *
 * Read the same way a PDF is, for the same reason: on Android the launch hands
 * over a `content://` URI and only the content resolver can open one.
 *
 * The import is inference — GoodNotes publishes no format — so the notice it
 * raises afterwards is part of the feature rather than decoration. Someone who
 * is told "11 pages, 1,430 strokes, everything came in as pen" can judge the
 * result; someone shown a silently half-empty notebook cannot.
 */
async function importGoodNotesAsDocument(uri: string): Promise<void> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(uri);
  await adoptGoodNotes(bytes, uri.split(/[?#]/)[0] ?? uri);
}

/**
 * The same thing from a `File`, which is all a browser can offer.
 *
 * Kept beside its sibling rather than reimplemented next to the picker: the
 * interesting part is what a PDF *becomes*, and having two copies of that is
 * how a document opened one way ends up subtly different from the same
 * document opened the other.
 */
export async function importPdfFileAsDocument(file: File): Promise<void> {
  const { loadPdfFile } = await import('../pdf/import');
  const name = fileBaseName(file.name) || 'Imported PDF';
  await adoptPdf(await loadPdfFile(file), name);
}

/** The same, from a `File`. */
export async function importGoodNotesFileAsDocument(file: File): Promise<void> {
  await adoptGoodNotes(new Uint8Array(await file.arrayBuffer()), file.name);
}

/**
 * Turn recovered ink into the open document, and say what was recovered.
 *
 * The one place that decides what an import *becomes*, so a notebook opened
 * through an intent, a file association and the library picker are the same
 * document with the same notice — the drift the PDF path already avoids this way.
 */
async function adoptGoodNotes(bytes: Uint8Array, fileName: string): Promise<void> {
  const { GoodNotesImportError, describeGoodNotesArchive, importGoodNotes } = await import('../goodnotes/import');
  const { useImportReportStore } = await import('../goodnotes/reportStore');
  let result;
  try {
    result = await importGoodNotes(bytes, { fileName });
  } catch (error) {
    // A failure is reported through the same dialog as a success. It is the only
    // surface that can carry the archive listing and the advice to export a PDF
    // instead — a one-line notice truncates both away.
    useImportReportStore.getState().setOutcome({
      kind: 'failed',
      fileName,
      message: error instanceof Error ? error.message : String(error),
      entries: error instanceof GoodNotesImportError ? error.entries : describeGoodNotesArchive(bytes),
    });
    throw error;
  }
  useDocumentStore.getState().loadDocument(result.document, null);
  // Imported but not saved anywhere: keep Save and autosave armed.
  useDocumentStore.setState({ savedPages: null, savedTitle: null });
  useImportReportStore.getState().setOutcome({ kind: 'imported', report: result.report });
  // A one-line notice as well, for the desktop top bar; the detail is in the
  // dialog, which is the only one of the two a phone shows.
  useDesktopStore.getState().setNotice({
    text: `Imported ${result.report.pages} page${result.report.pages === 1 ? '' : 's'} and ${result.report.strokes.toLocaleString()} stroke${result.report.strokes === 1 ? '' : 's'} from GoodNotes.`,
  });
}

/** Turn a loaded PDF into the open document. */
async function adoptPdf(loaded: Awaited<ReturnType<typeof import('../pdf/import')['loadPdfData']>>, name: string): Promise<void> {
  const { buildPdfPages } = await import('../pdf/import');
  const pages = await buildPdfPages(
    loaded,
    loaded.pages.map((_, index) => index),
    // The PDF's own page size, not A4: someone opening a PDF to annotate it
    // wants it the shape it is.
    { sizeMode: 'preserve' },
  );
  if (pages.length === 0) throw new Error('That PDF has no pages');
  const store = useDocumentStore.getState();
  store.loadDocument(
    { ...createDocument(1), title: titleFromFileName(name), pages: renumberPages(pages) },
    null,
  );
  // Imported but not saved anywhere: keep Save and autosave armed.
  useDocumentStore.setState({ savedPages: null, savedTitle: null });
}

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
    // An Android intent first: it is the most explicit thing a user can do —
    // they picked this app to open that file — and unlike a draft there is
    // nothing to weigh it against.
    const intent = takeAndroidOpenWith();
    if (intent) {
      const opened = await openRequested(intent);
      if (opened) return opened;
    }

    const startup = await getStartupFile();
    if (startup) {
      // The desktop file association can hand over a PDF too.
      const opened = await openRequested({ uri: startup, mime: '' });
      if (opened) return opened;
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
