/**
 * Searching every note in the library.
 *
 * The words of each note are read once and kept, keyed by the file's modified time, so a second
 * search (or the next keystroke) costs nothing and a note that was edited is read again. Matching is
 * the in-note search's own `searchSources`, so the two always agree about what a query finds.
 *
 * What is indexed is text: a note's title, its text boxes, sticky notes and table cells, read first because that
 * is quick, and then the words of the PDFs its pages were made from, which means reading each PDF once (they are
 * kept, see `notePdfs.ts`). Handwriting is ink, and cannot be searched.
 */
import { searchSources, type SearchHit, type TextKind, type TextSource } from '../search/text';
import type { PdfWords } from './notePdfs';
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
  /** The note's pages made from a page of an embedded PDF. */
  readonly pdfPages?: readonly PdfPagePiece[];
}

export interface PdfPagePiece {
  readonly pageIndex: number;
  readonly pageId: string;
  readonly sourceId: string;
  readonly pdfPageIndex: number;
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
/** PDFs read at the same time: each is a whole PDF parsed, so fewer. */
const PDF_READERS = 2;
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

/** What is being read: the notes' own text, then the PDFs in them. */
export type IndexPhase = 'notes' | 'pdfs';

/** The words of a note's PDF pages as sources, from each source's pages' words. */
export function pdfSourcesFor(pages: readonly PdfPagePiece[], words: ReadonlyMap<string, readonly string[]>): TextSource[] {
  const out: TextSource[] = [];
  for (const page of pages) {
    const text = words.get(page.sourceId)?.[page.pdfPageIndex];
    if (text && text.trim()) out.push({ pageIndex: page.pageIndex, pageId: page.pageId, mediaId: null, kind: 'pdf', text });
  }
  return out;
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

interface Cached {
  readonly modifiedMs: number;
  readonly note: IndexedNote;
  readonly pdfPages: readonly PdfPagePiece[];
  /** The words of its PDF pages are in `note` (or it has none). */
  readonly pdfDone: boolean;
}

/**
 * Keeps each note's words until the note changes.
 *
 * `read` is the backend and `pdfWords` reads the PDFs in a note; both are handed in so the index can be tested
 * without either. Without `pdfWords`, only typed text is indexed.
 */
export class NoteIndex {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly read: (path: string) => Promise<DocumentText>,
    private readonly pdfWords?: PdfWords,
  ) {}

  private isCurrent(entry: LibraryEntry): boolean {
    const cached = this.cache.get(entry.path);
    return cached?.modifiedMs === entry.modifiedMs && cached.pdfDone;
  }

  /** How many of `entries` are read through and current. */
  current(entries: readonly LibraryEntry[]): number {
    return entries.filter((e) => this.isCurrent(e)).length;
  }

  /**
   * Read whatever is new or changed, a few notes at a time, then the PDFs in them, and forget notes that are gone.
   * `onProgress` hears after each note (and then each note's PDFs); `shouldStop` lets a newer search end this one.
   */
  async update(
    entries: readonly LibraryEntry[],
    onProgress?: (done: number, total: number, phase: IndexPhase) => void,
    shouldStop: () => boolean = () => false,
  ): Promise<void> {
    const live = new Set(entries.map((e) => e.path));
    for (const path of [...this.cache.keys()]) if (!live.has(path)) this.cache.delete(path);
    let failed = false;

    // The notes' own text: quick, and enough for most searches.
    const todo = entries.filter((e) => this.cache.get(e.path)?.modifiedMs !== e.modifiedMs);
    await this.pool(todo, READERS, shouldStop, async (entry) => {
      try {
        const text = await this.read(entry.path);
        const pdfPages = this.pdfWords ? (text.pdfPages ?? []) : [];
        this.cache.set(entry.path, {
          modifiedMs: entry.modifiedMs,
          note: { entry, title: text.title, pageCount: text.pageCount, sources: sourcesOf(text) },
          pdfPages,
          pdfDone: pdfPages.length === 0,
        });
      } catch {
        // A file that will not read (a PDF left in the folder, a half-synced file) has no words.
        failed = true;
        this.cache.set(entry.path, { modifiedMs: entry.modifiedMs, note: { entry, title: entry.name, pageCount: 0, sources: [] }, pdfPages: [], pdfDone: true });
      }
    }, (done) => onProgress?.(done, todo.length, 'notes'));
    if (shouldStop()) return;

    // Then the PDFs in them: slow the first time, kept after that.
    const words = this.pdfWords;
    if (!words) return;
    const pdfTodo = entries.filter((e) => {
      const cached = this.cache.get(e.path);
      return cached?.modifiedMs === e.modifiedMs && !cached.pdfDone;
    });
    await this.pool(pdfTodo, PDF_READERS, shouldStop, async (entry) => {
      const cached = this.cache.get(entry.path);
      if (!cached) return;
      let extra: TextSource[] = [];
      try {
        const found = await words.read(entry.path, cached.pdfPages.map((p) => p.sourceId));
        extra = pdfSourcesFor(cached.pdfPages, found);
      } catch {
        failed = true;
      }
      // Only if the note did not change while its PDFs were read.
      const now = this.cache.get(entry.path);
      if (now !== cached) return;
      this.cache.set(entry.path, { ...cached, note: { ...cached.note, sources: [...cached.note.sources, ...extra] }, pdfDone: true });
    }, (done) => onProgress?.(done, pdfTodo.length, 'pdfs'));
    if (shouldStop() || failed) return;

    // Everything was read: the PDFs kept for notes that no longer have them can go.
    const sources = new Set<string>();
    for (const cached of this.cache.values()) for (const page of cached.pdfPages) sources.add(page.sourceId);
    await words.prune(sources).catch(() => undefined);
  }

  /** Run `work` over `items`, `width` at a time, telling `progress` after each. */
  private async pool<T>(
    items: readonly T[],
    width: number,
    shouldStop: () => boolean,
    work: (item: T) => Promise<void>,
    progress: (done: number) => void,
  ): Promise<void> {
    let next = 0;
    let done = 0;
    const worker = async (): Promise<void> => {
      while (!shouldStop()) {
        const item = items[next++];
        if (item === undefined) return;
        await work(item);
        done += 1;
        progress(done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker));
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
