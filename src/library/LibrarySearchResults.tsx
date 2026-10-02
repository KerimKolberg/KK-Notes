import { memo } from 'react';
import { FileText, Folder } from 'lucide-react';
import { KIND_LABELS, type SearchHit } from '../search/text';
import type { LibrarySearch } from './useLibrarySearch';

interface Props {
  readonly search: LibrarySearch;
  readonly query: string;
  /** Open a note, at the place a match is when there is one. */
  readonly onOpen: (path: string, hit: SearchHit | null) => void;
}

/**
 * What a library-wide search found: each note once, with the first places the words are in it.
 * Choosing the note opens it at its first match; choosing one of the lines opens it there.
 */
export const LibrarySearchResults = memo(function LibrarySearchResults({ search, query, onOpen }: Props) {
  const { results, reading, searched } = search;
  return (
    <div className="mx-auto w-full max-w-3xl" data-library-search-results={results.length}>
      <p className="pb-2 text-xs text-zinc-500 dark:text-zinc-400" role="status" data-library-search-status>
        {reading
          ? reading.phase === 'notes'
            ? `Reading your notes… ${reading.done} of ${reading.total}`
            : `${results.length === 1 ? '1 note' : `${results.length} notes`} so far. Reading the PDFs in your notes… ${reading.done} of ${reading.total} (only the first time)`
          : `${results.length === 0 ? 'No notes' : results.length === 1 ? '1 note' : `${results.length} notes`} for “${query.trim()}” among ${searched}. Handwriting cannot be searched.`}
      </p>
      <ul className="flex flex-col gap-2">
        {results.map(({ note, folder, hits }) => (
          <li
            key={note.entry.path}
            className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
            data-library-search-note={note.entry.name}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
              onClick={() => onOpen(note.entry.path, hits[0] ?? null)}
            >
              <FileText size={16} className="shrink-0 text-blue-600 dark:text-blue-400" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{note.title || note.entry.name}</span>
                {folder && (
                  <span className="flex items-center gap-1 truncate text-[11px] text-zinc-400">
                    <Folder size={11} aria-hidden="true" />
                    {folder}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-[11px] text-zinc-400">{note.pageCount === 1 ? '1 page' : `${note.pageCount} pages`}</span>
            </button>
            {hits.length > 0 && (
              <ul className="border-t border-zinc-100 py-1 dark:border-zinc-800">
                {hits.map((hit, i) => (
                  <li key={`${hit.source.pageIndex}-${hit.source.mediaId ?? ''}-${hit.start}-${i}`}>
                    <button
                      type="button"
                      data-library-search-hit
                      data-library-search-hit-page={hit.source.pageIndex}
                      className="flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                      onClick={() => onOpen(note.entry.path, hit)}
                    >
                      <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">
                        p. {hit.source.pageIndex + 1} · {KIND_LABELS[hit.source.kind]}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">
                        {hit.before}
                        <mark className="rounded bg-yellow-200 px-0.5 text-zinc-900 dark:bg-yellow-500/40 dark:text-zinc-50">{hit.match}</mark>
                        {hit.after}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
});
