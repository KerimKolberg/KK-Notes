import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { FileText, Search, Table2, Type, StickyNote, X, type LucideIcon } from 'lucide-react';
import { pdfPageText } from '../../pdf/pdfText';
import { revealText } from '../../search/reveal';
import { useSearchStore } from '../../search/searchStore';
import { KIND_LABELS, documentSources, searchSources, type SearchHit, type TextKind, type TextSource } from '../../search/text';
import { useDocumentStore } from '../store';

const KIND_ICONS: Readonly<Record<TextKind, LucideIcon>> = {
  title: Type,
  text: Type,
  note: StickyNote,
  table: Table2,
  pdf: FileText,
};

/** How many PDF pages are read at once while the panel is open. */
const PDF_READERS = 2;

/**
 * Search inside the open note: its title, text boxes, sticky notes, table cells and, for a PDF, the
 * words of its pages. Handwriting is ink and is not searched, which the panel says rather than leaving
 * someone to wonder why a word they wrote is not found.
 *
 * Choosing a result goes to its page, and for something on a page selects it there.
 */
export const SearchPanel = memo(function SearchPanel() {
  const { query, focusRequest } = useSearchStore(useShallow((s) => ({ query: s.query, focusRequest: s.focusRequest })));
  const setQuery = useSearchStore((s) => s.setQuery);
  const close = useSearchStore((s) => s.close);
  const inputRef = useRef<HTMLInputElement>(null);

  const title = useDocumentStore((s) => s.document.title);
  // The text objects only: a stroke committed every few seconds must not re-run the search, and these
  // arrays keep their identity until something on the page is actually edited.
  const pageMedia = useDocumentStore(useShallow((s) => s.document.pages.map((p) => p.media)));
  const pageIds = useDocumentStore(useShallow((s) => s.document.pages.map((p) => p.id)));
  const pdfPages = useDocumentStore(useShallow((s) => s.document.pages.map((p) => p.pdf)));

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  // The typed text, available at once.
  const typed = useMemo(
    () => documentSources({ title, pages: pageIds.map((id, i) => ({ id, media: pageMedia[i] ?? [] })) }),
    [title, pageIds, pageMedia],
  );

  // A PDF's words arrive a page at a time.
  const [pdfSources, setPdfSources] = useState<readonly TextSource[]>([]);
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    const todo = pdfPages.map((ref, index) => ({ ref, index })).filter((p) => p.ref !== undefined);
    setPdfSources([]);
    if (todo.length === 0) {
      setReading(null);
      return;
    }
    let cancelled = false;
    let next = 0;
    let done = 0;
    setReading({ done: 0, total: todo.length });
    const worker = async (): Promise<void> => {
      while (!cancelled) {
        const job = todo[next++];
        if (!job || !job.ref) return;
        try {
          const text = await pdfPageText(job.ref);
          if (cancelled) return;
          if (text) {
            setPdfSources((all) => [...all, { pageIndex: job.index, pageId: pageIds[job.index] ?? '', mediaId: null, kind: 'pdf', text }]);
          }
        } catch {
          /* a page that will not read simply has no words to find */
        }
        done += 1;
        if (!cancelled) setReading({ done, total: todo.length });
      }
    };
    void Promise.all(Array.from({ length: PDF_READERS }, worker)).then(() => {
      if (!cancelled) setReading(null);
    });
    return () => {
      cancelled = true;
    };
    // Only when the set of PDF pages changes, not with every edit.
  }, [pdfPages, pageIds]);

  const sources = useMemo(
    () => [...typed, ...[...pdfSources].sort((a, b) => a.pageIndex - b.pageIndex)],
    [typed, pdfSources],
  );
  const hits = useMemo(() => searchSources(sources, query), [sources, query]);

  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  const activeRef = useRef<HTMLLIElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // Keep the chosen result in view by moving the list itself. `scrollIntoView` scrolls every ancestor that can scroll,
  // including the ones that are hidden, which can shift the whole app out of the window.
  useEffect(() => {
    const list = listRef.current;
    const item = activeRef.current;
    if (!list || !item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [active, hits]);

  const go = useCallback((hit: SearchHit | undefined) => {
    if (!hit) return;
    try {
      revealText(hit.source);
    } catch (error) {
      console.error('KK-Notes: could not go to that search result', error);
    }
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = e.shiftKey ? (active - 1 + hits.length) % Math.max(1, hits.length) : active;
      const next = e.shiftKey ? target : active;
      go(hits[next]);
      // Enter again goes to the one after, which is how a person steps through the matches.
      if (hits.length > 1) setActive(e.shiftKey ? next : (active + 1) % hits.length);
    }
  };

  const searching = query.trim().length > 0;
  return (
    <div
      role="search"
      aria-label="Search this note"
      data-search-panel
      className="absolute right-3 top-3 z-40 flex max-h-[70%] w-[min(26rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
        <Search size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search this note"
          aria-label="Search this note"
          data-search-input
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 [&::-webkit-search-cancel-button]:hidden"
        />
        {searching && (
          <span className="shrink-0 text-xs tabular-nums text-zinc-500 dark:text-zinc-400" data-search-count>
            {hits.length === 0 ? 'No matches' : `${Math.min(active + 1, hits.length)} of ${hits.length}`}
          </span>
        )}
        <button
          type="button"
          aria-label="Close the search"
          title="Close (Esc)"
          data-search-close
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          onClick={close}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      {searching && hits.length > 0 && (
        <ul ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto py-1" data-search-results>
          {hits.map((hit, i) => {
            const Icon = KIND_ICONS[hit.source.kind];
            const isActive = i === active;
            return (
              <li key={`${hit.source.kind}-${hit.source.pageIndex}-${hit.source.mediaId ?? ''}-${hit.start}-${i}`} ref={isActive ? activeRef : undefined}>
                <button
                  type="button"
                  data-search-hit
                  data-search-hit-kind={hit.source.kind}
                  data-search-hit-page={hit.source.pageIndex}
                  aria-current={isActive ? 'true' : undefined}
                  className={`flex w-full items-start gap-2.5 px-3 py-1.5 text-left text-sm ${
                    isActive ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                  }`}
                  onClick={() => {
                    setActive(i);
                    go(hit);
                  }}
                >
                  <Icon size={15} className="mt-0.5 shrink-0 text-zinc-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-zinc-600 dark:text-zinc-300">
                      {hit.before}
                      <mark className="rounded bg-yellow-200 px-0.5 text-zinc-900 dark:bg-yellow-500/40 dark:text-zinc-50">{hit.match}</mark>
                      {hit.after}
                    </span>
                    <span className="block text-[11px] text-zinc-400">
                      {hit.source.pageIndex < 0 ? KIND_LABELS.title : `Page ${hit.source.pageIndex + 1} · ${KIND_LABELS[hit.source.kind]}`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="border-t border-zinc-100 px-3 py-1.5 text-[11px] text-zinc-400 dark:border-zinc-800" data-search-note>
        {reading
          ? `Reading the PDF… ${reading.done} of ${reading.total} pages`
          : 'Finds typed text, sticky notes, tables and PDF text. Handwriting cannot be searched.'}
      </p>
    </div>
  );
});
