import { memo, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bookmark, BookmarkCheck, X } from 'lucide-react';
import { bookmarkTitle, bookmarksOf, MAX_BOOKMARK_LENGTH } from '../bookmarks';
import { useBookmarksStore } from '../bookmarksStore';
import { useDocumentStore } from '../store';

/**
 * The pages marked to come back to. One button marks or unmarks the page in view; each bookmark can be
 * named (it reads as its page number until it is), jumped to, or removed.
 */
export const BookmarksPanel = memo(function BookmarksPanel() {
  const close = useBookmarksStore((s) => s.close);
  const pages = useDocumentStore(useShallow((s) => s.document.pages.map((p) => p.bookmark)));
  const ids = useDocumentStore(useShallow((s) => s.document.pages.map((p) => p.id)));
  const activeIndex = useDocumentStore((s) => s.document.activePageIndex);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const jumpToPage = useDocumentStore((s) => s.jumpToPage);
  const setPageBookmark = useDocumentStore((s) => s.setPageBookmark);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const entries = bookmarksOf(pages.map((bookmark, i) => ({ id: ids[i] ?? '', ...(bookmark !== undefined ? { bookmark } : {}) })));
  const activeId = ids[activeIndex] ?? '';
  const here = pages[activeIndex] !== undefined;

  return (
    <div
      role="region"
      aria-label="Bookmarks"
      data-bookmarks-panel
      className="absolute right-3 top-3 z-40 flex max-h-[70%] w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
        <Bookmark size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
        <h2 className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Bookmarks</h2>
        <button
          type="button"
          aria-label="Close the bookmarks"
          data-bookmarks-close
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          onClick={close}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <button
          type="button"
          data-bookmark-toggle-here
          disabled={readOnly}
          onClick={() => setPageBookmark(activeId, here ? null : '')}
          className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
            here
              ? 'border border-zinc-300 text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800'
              : 'bg-blue-600 text-white hover:bg-blue-500'
          }`}
        >
          {here ? <BookmarkCheck size={15} aria-hidden="true" /> : <Bookmark size={15} aria-hidden="true" />}
          {here ? `Remove the bookmark from page ${activeIndex + 1}` : `Bookmark page ${activeIndex + 1}`}
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="px-3 py-3 text-sm text-zinc-500 dark:text-zinc-400" data-bookmarks-empty>
          No bookmarks yet. Mark the pages you want to come back to, and they will be listed here.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1" data-bookmarks-list={entries.length}>
          {entries.map((entry) => (
            <li
              key={entry.pageId}
              className={`flex items-center gap-1.5 px-2 py-1 ${entry.pageIndex === activeIndex ? 'bg-blue-50 dark:bg-blue-950/40' : ''}`}
              data-bookmark={entry.pageIndex}
            >
              <button
                type="button"
                data-bookmark-go
                className="shrink-0 rounded-md px-2 py-1 text-xs font-medium tabular-nums text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-950"
                title={`Go to page ${entry.pageIndex + 1}`}
                onClick={() => jumpToPage(entry.pageIndex)}
              >
                p. {entry.pageIndex + 1}
              </button>
              <input
                type="text"
                value={entry.label}
                maxLength={MAX_BOOKMARK_LENGTH}
                readOnly={readOnly}
                placeholder={bookmarkTitle({ label: '', pageIndex: entry.pageIndex })}
                aria-label={`Name of the bookmark on page ${entry.pageIndex + 1}`}
                data-bookmark-name
                onChange={(e) => setPageBookmark(entry.pageId, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') jumpToPage(entry.pageIndex);
                }}
                className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm text-zinc-800 outline-none placeholder:text-zinc-400 hover:bg-zinc-100 focus:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
              />
              <button
                type="button"
                data-bookmark-remove
                disabled={readOnly}
                aria-label={`Remove the bookmark on page ${entry.pageIndex + 1}`}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-40 dark:hover:bg-zinc-800"
                onClick={() => setPageBookmark(entry.pageId, null)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
