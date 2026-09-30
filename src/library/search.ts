/**
 * Searching every note in the library.
 *
 * The words of each note are read once and kept, keyed by the file's modified time, so a second
 * search (or the next keystroke) costs nothing and a note that was edited is read again. Matching is
 * the in-note search's own `searchSources`, so the two always agree about what a query finds.
 *
 * Only typed text is indexed: a note's title, its text boxes, sticky notes and table cells.
 * Handwriting is ink, and the words of an imported PDF live in the PDF, not in the note's file.
 */
import { searchSources, type SearchHit, type TextKind, type TextSource } from '../search/text';
import type { LibraryEntry, LibraryListing, SortKey, SortOrder } from './types';

/** What a backend can tell about the text of one document. */
export interface DocumentText {
  readonly title: string;
  readonly pageCount: number;
  readonly pieces: readonly {
    readonly pageIndex: number;
    readonly pageId: string;
    readonly mediaId: string | null;
    readonly kind: Exclude<TextKind, 'title' | 'pdf'>;
    readonly text: string;
  }[];
}

/** One note, read. */
export interface IndexedNote {
  readonly entry: LibraryEntry;
  readonly title: string;
  readonly pageCount: number;
  readonly sources: readonly TextSource[];
}

export interface NoteResult {
  readonly note: IndexedNote;
  /** The folder it is in, as a relative path; empty at the top. */
  readonly folder: string;
  readonly hits: readonly SearchHit[];
  /** The query is in the note's title (or file name). */
  readonly inTitle: boolean;
}

/** Notes looked at in a search at most; a library is not expected to be larger than this. */
const MAX_NOTES = 2000;
/** Notes read at the same time. */
const READERS = 4;
/** Matches shown per note. */
export const HITS_PER_NOTE = 3;

/** Every document in the library, folders descended into. */
export async function listAllNotes(
  list: (path: string | null, sort: { key: SortKey; order: SortOrder }) => Promise<LibraryListing>,
): Promise<LibraryEntry[]> {
  const notes: LibraryEntry[] = [];
  const seen = new Set<string>();
  const queue: (string | null)[] = [null];
  while (queue.length > 0 && notes.length < MAX_NOTES) {
    const at = queue.shift() ?? null;
    const key = at ?? '';
    if (seen.has(key)) continue;
    seen.add(key);
    let listing: LibraryListing;
    try {
      listing = await list(at, { key: 'modified', order: 'descending' });
    } catch {
      // A folder that cannot be read is skipped, not fatal to the whole search.
      continue;
    }
    for (const entry of listing.entries) {
      if (entry.isFolder) queue.push(entry.path);
      else notes.push(entry);
    }
  }
  return notes.slice(0, MAX_NOTES);
}

/** A note's words as sources, the title first. */
export function sourcesOf(text: DocumentText): TextSource[] {
  const out: TextSource[] = [];
  if (text.title.trim()) out.push({ pageIndex: -1, pageId: '', mediaId: null, kind: 'title', text: text.title });
  for (const piece of text.pieces) {
    out.push({ pageIndex: piece.pageIndex, pageId: piece.pageId, mediaId: piece.mediaId, kind: piece.kind, text: piece.text });
  }
  return out;
}

/**
 * Keeps each note's words until the note changes.
 *
 * `read` is the backend; it is handed in so the index can be tested without one.
 */
export class NoteIndex {
  private readonly cache = new Map<string, { readonly modifiedMs: number; readonly note: IndexedNote }>();

  constructor(private readonly read: (path: string) => Promise<DocumentText>) {}

  /** How many of `entries` are read and current. */
  current(entries: readonly LibraryEntry[]): number {
    return entries.filter((e) => this.cache.get(e.path)?.modifiedMs === e.modifiedMs).length;
  }

  /**
   * Read whatever is new or changed, a few notes at a time, and forget notes that are gone.
   * `onProgress` hears after each note; `shouldStop` lets a newer search end this one early.
   */
  async update(
    entries: readonly LibraryEntry[],
    onProgress?: (done: number, total: number) => void,
    shouldStop: () => boolean = () => false,
  ): Promise<void> {
    const live = new Set(entries.map((e) => e.path));
    for (const path of [...this.cache.keys()]) if (!live.has(path)) this.cache.delete(path);

    const todo = entries.filter((e) => this.cache.get(e.path)?.modifiedMs !== e.modifiedMs);
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (!shouldStop()) {
        const entry = todo[next++];
        if (!entry) return;
        try {
          const text = await this.read(entry.path);
          this.cache.set(entry.path, {
            modifiedMs: entry.modifiedMs,
            note: { entry, title: text.title, pageCount: text.pageCount, sources: sourcesOf(text) },
          });
        } catch {
          // A file that will not read (a PDF left in the folder, a half-synced file) has no words.
          this.cache.set(entry.path, { modifiedMs: entry.modifiedMs, note: { entry, title: entry.name, pageCount: 0, sources: [] } });
        }
        done += 1;
        onProgress?.(done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READERS, todo.length) }, worker));
  }

  /** The notes among `entries` that have been read, in the order given. */
  notes(entries: readonly LibraryEntry[]): IndexedNote[] {
    const out: IndexedNote[] = [];
    for (const entry of entries) {
      const cached = this.cache.get(entry.path);
      if (cached && cached.modifiedMs === entry.modifiedMs) out.push(cached.note);
    }
    return out;
  }
}

/** The folder a note sits in, from its relative path. */
export function folderOf(entry: LibraryEntry): string {
  const at = entry.relativePath.lastIndexOf('/');
  return at < 0 ? '' : entry.relativePath.slice(0, at);
}

/**
 * The notes that contain every word of the query, those named for it first and then in the order
 * given (the library hands them newest first), each with the first few places it is found.
 */
export function searchNotes(notes: readonly IndexedNote[], query: string, limit = 60): NoteResult[] {
  if (query.trim().length === 0) return [];
  const results: NoteResult[] = [];
  for (const note of notes) {
    // The title is matched against the file's name too: a note called "Chemistry" has a file of that
    // name whatever its title says, and the library shows the name.
    const named = searchSources(
      [{ pageIndex: -1, pageId: '', mediaId: null, kind: 'title', text: `${note.entry.name} ${note.title}` }],
      query,
      1,
    ).length > 0;
    const hits = searchSources(
      note.sources.filter((s) => s.kind !== 'title'),
      query,
      HITS_PER_NOTE,
    );
    if (!named && hits.length === 0) continue;
    results.push({ note, folder: folderOf(note.entry), hits, inTitle: named });
  }
  // Stable: Array.prototype.sort keeps the given order among equals.
  results.sort((a, b) => Number(b.inTitle) - Number(a.inTitle));
  return results.slice(0, limit);
}
