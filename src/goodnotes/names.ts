/**
 * Recognising a GoodNotes notebook by name.
 *
 * Its own module so that asking "is this a notebook?" does not pull in the
 * importer. Everything behind `import.ts` — a ZIP reader, an LZ4 decoder, a
 * protobuf walker — is needed only once somebody actually opens one, and the
 * library's file picker asks the question on every file it lists. A static
 * import of the importer for these two lines put all of it on the critical
 * path, which the bundle check exists to notice.
 */

/** The extension, and the only thing that identifies one of these from outside. */
export const GOODNOTES_EXTENSION = 'goodnotes';

/** Is this name a GoodNotes notebook? */
export function isGoodNotesName(name: string): boolean {
  const path = name.toLowerCase().split(/[?#]/)[0] ?? '';
  return path.endsWith(`.${GOODNOTES_EXTENSION}`);
}
