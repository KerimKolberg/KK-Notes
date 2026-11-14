/**
 * Loading a document the library picked, into the document store.
 *
 * Separate from the view so the view holds no document logic, and so the two
 * backends stay behind one call: a real file on the desktop, a `localStorage`
 * entry in the browser.
 */
import { rememberFileVersion } from '../desktop/fileService';
import { isTauri, tauriInvoke } from '../desktop/tauri';
import { parseNotex } from '../desktop/notex';
import { useDocumentStore } from '../document/store';
import { readBrowserDocument } from './browserLibrary';

interface OpenedPayload {
  readonly path: string;
  readonly contents: string;
  readonly info?: { readonly path: string; readonly modifiedMs: number | null };
}

export async function openDocumentFromLibrary(path: string): Promise<void> {
  let contents: string | null;
  if (isTauri()) {
    const opened = await tauriInvoke<OpenedPayload>('open_document', { path });
    contents = opened.contents;
    // Which version of the file this note is, so a save can tell if something else has changed it since.
    rememberFileVersion(opened.info);
  } else {
    contents = readBrowserDocument(path);
  }
  if (contents === null) throw new Error('That document is no longer in the library.');
  const { document } = parseNotex(contents);
  useDocumentStore.getState().loadDocument(document, path);
}
