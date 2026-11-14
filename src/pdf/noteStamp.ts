/**
 * The mark of a PDF this app saved a note into (`embeddedNote.ts`), looked for without the PDF library.
 *
 * Nearly every PDF opened is one the app never saved, and reading the note out of one takes pdf-lib, which is 400 kB
 * the app otherwise fetches only to export. So the bytes are looked through for the stamp's name first, here, in a
 * module that imports nothing: only a PDF that carries it is worth fetching the library for.
 */
export const NOTE_STAMP_KEY = 'KKNotesSaved';

/** Whether `needle` (ASCII) is somewhere in `bytes`. */
export function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const first = needle.charCodeAt(0);
  outer: for (let i = bytes.indexOf(first); i !== -1 && i <= bytes.length - needle.length; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return true;
  }
  return false;
}

/** How many times `needle` (ASCII) is in `bytes`, counted no further than `limit`. */
export function countAscii(bytes: Uint8Array, needle: string, limit = 2): number {
  const first = needle.charCodeAt(0);
  let count = 0;
  outer: for (let i = bytes.indexOf(first); i !== -1 && i <= bytes.length - needle.length; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    count += 1;
    if (count >= limit) break;
  }
  return count;
}

/**
 * Whether the file has been added to since it was written in one piece. This app writes a PDF whole, with one
 * cross-reference section; a reader that saves an annotation or a signature usually *appends* a second section rather
 * than rewriting the file, and some do so without touching the modification date. A second `startxref` is that.
 */
export function wasAppendedTo(bytes: Uint8Array): boolean {
  return countAscii(bytes, 'startxref') > 1;
}

/** Whether these PDF bytes may hold a note: the stamp's name is in them. */
export function mayHoldNote(bytes: Uint8Array): boolean {
  return containsAscii(bytes, NOTE_STAMP_KEY);
}
