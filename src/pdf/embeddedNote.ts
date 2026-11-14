/**
 * A note saved as a PDF, kept editable.
 *
 * Saving a note into a PDF writes the ink, text and pictures onto the pages, as every PDF reader shows them. Written
 * on, it would no longer be ink: opened again, a stroke could not be erased or undone. So the note itself, as a
 * `.notex`, goes into the PDF as well, as an attached file, and opening the PDF in this app opens that note again,
 * PDF pages and all, as it was when it was saved. Other readers show the attachment in their attachments list, if at
 * all.
 *
 * A PDF changed by another app after it was saved here (an annotation added in Acrobat, a page signed) no longer
 * matches the note inside it, and the note would bring back the file without that change. So the save is stamped:
 * the PDF's modification date, and the same date under a key of this app's own. Any app that writes the file updates
 * the first and not the second, and a PDF whose two differ opens as the PDF it now is.
 */
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { mayHoldNote, NOTE_STAMP_KEY } from './noteStamp';

/** The attachment's name. */
export const NOTE_ATTACHMENT = 'KK-Notes note.notex';
const STAMP_KEY = NOTE_STAMP_KEY;

/** Put the note into the PDF being made, and stamp it. Before `save()`, which is when pdf-lib writes attachments. */
export async function attachNote(out: PDFDocument, notex: Uint8Array, when: Date): Promise<void> {
  await out.attach(notex, NOTE_ATTACHMENT, {
    mimeType: 'application/json',
    description: 'The KK-Notes note this PDF was saved from, to open it again with its ink editable',
    creationDate: when,
    modificationDate: when,
  });
  out.setModificationDate(when);
  infoDict(out)?.set(PDFName.of(STAMP_KEY), PDFString.fromDate(when));
}

/** The document information dictionary (title, dates), through the trailer: pdf-lib keeps its own getter private. */
function infoDict(doc: PDFDocument): PDFDict | undefined {
  const ref = doc.context.trailerInfo.Info;
  return ref ? doc.context.lookupMaybe(ref, PDFDict) : undefined;
}

const text = (value: unknown): string | null =>
  value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;

/**
 * The note saved into this PDF, as `.notex` text, or `null`: none in it, or the PDF has been changed since.
 *
 * A PDF this app never saved is the common case, and loading a large one twice only to find nothing is not free, so
 * the bytes are looked through for the stamp first (callers that can, do that before fetching this module at all:
 * `noteStamp.ts`).
 */
export async function readEmbeddedNote(bytes: Uint8Array): Promise<string | null> {
  if (!mayHoldNote(bytes)) return null;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const info = infoDict(doc);
    const stamp = text(info?.lookup(PDFName.of(STAMP_KEY)));
    if (stamp === null || stamp !== text(info?.lookup(PDFName.of('ModDate')))) return null;
    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
    const list = names?.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (!list) return null;
    for (let i = 0; i + 1 < list.size(); i += 2) {
      if (text(list.lookup(i)) !== NOTE_ATTACHMENT) continue;
      const spec = list.lookupMaybe(i + 1, PDFDict);
      const stream = spec?.lookupMaybe(PDFName.of('EF'), PDFDict)?.lookup(PDFName.of('F'));
      if (!(stream instanceof PDFRawStream)) return null;
      return new TextDecoder().decode(decodePDFRawStream(stream).decode());
    }
    return null;
  } catch {
    // Not a PDF pdf-lib can read: whatever it is, it opens as a PDF the usual way, or says why it cannot.
    return null;
  }
}
