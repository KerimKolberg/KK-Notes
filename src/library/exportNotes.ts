/**
 * Exporting notes chosen in the library: as PDFs, to open and share anywhere, or as KK-Notes files (`.notex`), to
 * keep or to open in the app on another device.
 *
 * One note is saved where a save dialog says. Several go into a folder chosen once, each under its own name, a name
 * taken there given a number rather than written over; Android has no folder to choose, so there each note gets a
 * save dialog of its own. A browser downloads them.
 */
import { NOTEX_EXTENSION, NOTEX_MIME, parseNotex } from '../desktop/notex';
import { writeBinary } from '../desktop/fileService';
import { isTauri, tauriDialog, tauriInvoke } from '../desktop/tauri';
import { downloadBytes, safeFilename } from '../pdf/download';
import { readDocumentContents } from './libraryService';

export type ExportFormat = 'pdf' | 'notex';

export interface ExportedNotes {
  readonly written: number;
  /** The folder they went to, or the one file; `null` for downloads. */
  readonly where: string | null;
}

function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

async function bytesOf(path: string, format: ExportFormat): Promise<Uint8Array> {
  const contents = await readDocumentContents(path);
  if (format === 'notex') return new TextEncoder().encode(contents);
  const { exportDocumentToPdf } = await import('../pdf/export');
  return exportDocumentToPdf(parseNotex(contents).document);
}

/** Export the notes; `null` when the dialog was closed before anything was written. */
export async function exportNotes(notes: readonly { readonly path: string; readonly name: string }[], format: ExportFormat): Promise<ExportedNotes | null> {
  if (notes.length === 0) return null;
  const extension = format === 'pdf' ? 'pdf' : NOTEX_EXTENSION;
  if (!isTauri()) {
    for (const note of notes) {
      downloadBytes(await bytesOf(note.path, format), safeFilename(note.name, extension), format === 'pdf' ? 'application/pdf' : NOTEX_MIME);
    }
    return { written: notes.length, where: null };
  }
  const { open, save } = await tauriDialog();
  // The extension on the name and in the filter is what Android makes the file's type from (see `exportPdf`).
  const filters = format === 'pdf' ? [{ name: 'PDF document', extensions: ['pdf'] }] : [{ name: 'KK-Notes document', extensions: [NOTEX_EXTENSION] }];
  if (notes.length === 1 || isAndroid()) {
    let written = 0;
    let where: string | null = null;
    for (const note of notes) {
      const path = await save({ defaultPath: safeFilename(note.name, extension), filters });
      // Closing one dialog stops the rest: it is how a long list is called off.
      if (!path) break;
      await writeBinary(path, await bytesOf(note.path, format));
      written += 1;
      where = path;
    }
    return written === 0 ? null : { written, where };
  }
  const folder = await open({ directory: true, multiple: false, title: `Export ${notes.length} notes to a folder` });
  if (typeof folder !== 'string') return null;
  for (const note of notes) {
    const path = await tauriInvoke<string>('free_file_path', { dir: folder, name: safeFilename(note.name, extension) });
    await writeBinary(path, await bytesOf(note.path, format));
  }
  return { written: notes.length, where: folder };
}
