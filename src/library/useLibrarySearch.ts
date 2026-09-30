import { useEffect, useMemo, useState } from 'react';
import { listLibrary, readDocumentText } from './libraryService';
import { NoteIndex, listAllNotes, searchNotes, type IndexedNote, type NoteResult } from './search';

/**
 * One index for the life of the page: what was read for one search is there for the next, and a note
 * is read again only when its modified time says it has changed.
 */
const index = new NoteIndex(readDocumentText);

/** The most often the results are redrawn while notes are still being read. */
const PUBLISH_EVERY_MS = 120;

export interface LibrarySearch {
  readonly results: readonly NoteResult[];
  /** While notes are still being read: how many of how many. */
  readonly reading: { readonly done: number; readonly total: number } | null;
  /** How many notes were searched. */
  readonly searched: number;
}

/**
 * Searching every note in the library for `query`.
 *
 * The notes are read when a search *starts* (the box going from empty to something), not on every
 * letter: listing the folders and reading what changed is the slow part, and matching what has been
 * read is instant. `refreshKey` should change when the library does, so a synced-in note is found.
 */
export function useLibrarySearch(query: string, refreshKey: unknown): LibrarySearch {
  const active = query.trim().length > 0;
  const [notes, setNotes] = useState<readonly IndexedNote[]>([]);
  const [reading, setReading] = useState<LibrarySearch['reading']>(null);

  useEffect(() => {
    if (!active) {
      setReading(null);
      return;
    }
    let stop = false;
    void (async () => {
      const entries = await listAllNotes(listLibrary);
      if (stop) return;
      const waiting = entries.length - index.current(entries);
      setNotes(index.notes(entries));
      if (waiting === 0) {
        setReading(null);
        return;
      }
      setReading({ done: 0, total: waiting });
      let published = 0;
      await index.update(
        entries,
        (done, total) => {
          if (stop) return;
          setReading({ done, total });
          const now = performance.now();
          if (now - published >= PUBLISH_EVERY_MS) {
            published = now;
            setNotes(index.notes(entries));
          }
        },
        () => stop,
      );
      if (stop) return;
      setNotes(index.notes(entries));
      setReading(null);
    })();
    return () => {
      stop = true;
    };
  }, [active, refreshKey]);

  const results = useMemo(() => (active ? searchNotes(notes, query) : []), [active, notes, query]);
  return { results, reading, searched: notes.length };
}
