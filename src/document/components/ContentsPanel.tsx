import { memo, useCallback, useEffect } from 'react';
import { ListTree, X } from 'lucide-react';
import { useContentsStore } from '../contentsStore';
import { useDocumentStore } from '../store';
import { useContents } from '../useContents';
import { OutlineList } from './OutlineList';

/**
 * The table of contents of the PDFs the note was made from, beside the note: a chapter is one tap away instead of
 * a long scroll. It lists the PDF's own contents — the "bookmarks" most PDF readers show — so a PDF without one
 * has nothing to list; the note's own bookmarks are in the bookmarks panel.
 */
export const ContentsPanel = memo(function ContentsPanel() {
  const close = useContentsStore((s) => s.close);
  const pages = useDocumentStore((s) => s.document.pages);
  const activeIndex = useDocumentStore((s) => s.document.activePageIndex);
  const jumpToPage = useDocumentStore((s) => s.jumpToPage);
  const sections = useContents(pages);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const go = useCallback((pageIndex: number, within: number) => jumpToPage(pageIndex, within), [jumpToPage]);

  return (
    <div
      role="region"
      aria-label="Contents"
      data-contents-panel
      className="absolute right-[calc(0.75rem+var(--dock-right,0px))] top-[calc(0.75rem+var(--dock-top,0px))] z-40 flex max-h-[75%] w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
        <ListTree size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
        <h2 className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Contents</h2>
        <button
          type="button"
          aria-label="Close the contents"
          data-contents-close
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          onClick={close}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <OutlineList sections={sections} pageIndex={activeIndex} onPick={go} />
    </div>
  );
});
