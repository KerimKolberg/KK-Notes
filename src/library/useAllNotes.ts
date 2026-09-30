import { useEffect, useState } from 'react';
import { listLibrary } from './libraryService';
import { listAllNotes } from './search';
import type { LibraryEntry } from './types';

/**
 * Every note in the library, folders descended into, while `active`. For the favourites and tags views,
 * which are across the whole library and not just the folder in front of you. `refreshKey` should
 * change when the library does.
 */
export function useAllNotes(active: boolean, refreshKey: unknown): readonly LibraryEntry[] | null {
  const [notes, setNotes] = useState<readonly LibraryEntry[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    void listAllNotes(listLibrary).then((all) => live && setNotes(all));
    return () => {
      live = false;
    };
  }, [active, refreshKey]);
  return active ? notes : null;
}
