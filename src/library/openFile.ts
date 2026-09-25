/**
 * Opening a file from the library, rather than from another app.
 *
 * Everything the app can open already arrives through one of two doors — a
 * file association on the desktop, an intent on Android — and both land in
 * {@link openRequested}, which decides what a file *is* and what opening it
 * means. This is the third door, and it deliberately goes through the same
 * decision rather than repeating it: a PDF picked here has to become the same
 * document a PDF tapped in a file manager becomes, or the two drift.
 *
 * The browser is the exception, and only because it has to be: there is no
 * path to hand anybody, just a `File`, so the same two outcomes are reached
 * from the bytes instead.
 */
import { importPdfFileAsDocument, openRequested, type BootTarget } from '../desktop/boot';
import { useDesktopStore } from '../desktop/desktopStore';
import { useDocumentStore } from '../document/store';
import { NOTEX_EXTENSION, NOTEX_MIME, parseNotex } from '../desktop/notex';
import { isTauri, tauriDialog } from '../desktop/tauri';
import { pickBrowserFile } from '../desktop/fileService';

/** What the picker offers. Documents first, since that is the common case. */
export const OPENABLE_EXTENSIONS: readonly string[] = [NOTEX_EXTENSION, 'json', 'pdf'];

/** The `accept` string for a browser file input. */
export const OPENABLE_ACCEPT = `.${NOTEX_EXTENSION},.json,.pdf,${NOTEX_MIME},application/json,application/pdf`;

/**
 * Is this something the app can open?
 *
 * Extension first, because a `content://` URI on Android routinely arrives
 * typed `application/octet-stream` and a browser `File` sometimes has no type
 * at all.
 */
export function isOpenable(name: string): boolean {
  const path = name.toLowerCase().split(/[?#]/)[0] ?? '';
  return OPENABLE_EXTENSIONS.some((extension) => path.endsWith(`.${extension}`));
}

/**
 * Show a picker and open what comes back.
 *
 * Resolves `null` when the user cancelled, or when the file could not be
 * opened — in which case a notice has already been raised, which the library
 * shows. The caller routes on a non-null result.
 */
export async function openFileFromLibrary(): Promise<BootTarget | null> {
  if (isTauri()) {
    const { open } = await tauriDialog();
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: 'Notes and PDFs', extensions: [...OPENABLE_EXTENSIONS] },
        { name: 'KK-Notes document', extensions: [NOTEX_EXTENSION, 'json'] },
        { name: 'PDF', extensions: ['pdf'] },
      ],
    });
    if (typeof picked !== 'string') return null;
    // The same path a file association or an intent takes.
    return openRequested({ uri: picked, mime: '' });
  }

  const file = await pickBrowserFile(OPENABLE_ACCEPT);
  if (!file) return null;
  return openBrowserFile(file);
}

/**
 * The browser's half: there is no path, so the bytes are read here.
 *
 * Exported for the tests, and because a drag-and-drop onto the library would
 * land in exactly the same place.
 */
export async function openBrowserFile(file: File): Promise<BootTarget | null> {
  try {
    if (file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf') {
      await importPdfFileAsDocument(file);
      // A PDF becomes a new, unsaved document: it has no path of its own.
      return { view: 'document', path: null };
    }
    const parsed = parseNotex(await file.text());
    useDocumentStore.getState().loadDocument(parsed.document, null);
    return { view: 'document', path: null };
  } catch (error) {
    useDesktopStore.getState().setNotice({
      text: `Could not open ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}
