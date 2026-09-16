import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { PAGE_BACKGROUND_SWATCHES, PAGE_TEMPLATES } from '../constants';
import { usePointerReorder } from '../hooks/usePointerReorder';
import { useDocumentStore } from '../store';
import type { PageTemplate } from '../types';
import { PageThumbnail } from './PageThumbnail';

const opButton =
  'inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors ' +
  'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 disabled:opacity-40 disabled:hover:bg-zinc-100 ' +
  'dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 dark:disabled:hover:bg-zinc-800 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500';

/**
 * Samsung Notes-style slide-over: thumbnail grid with drag-to-reorder, page
 * operations and per-page (or document-wide) template / background pickers.
 */
export function PageArranger() {
  const open = useDocumentStore((s) => s.arrangerOpen);
  const { pages, activePageIndex } = useDocumentStore(
    useShallow((s) => ({ pages: s.document.pages, activePageIndex: s.document.activePageIndex })),
  );
  const { setArrangerOpen, jumpToPage, movePage, addPage, duplicatePage, deletePage, setPageTemplate, setPageBackground } =
    useDocumentStore(
      useShallow((s) => ({
        setArrangerOpen: s.setArrangerOpen,
        jumpToPage: s.jumpToPage,
        movePage: s.movePage,
        addPage: s.addPage,
        duplicatePage: s.duplicatePage,
        deletePage: s.deletePage,
        setPageTemplate: s.setPageTemplate,
        setPageBackground: s.setPageBackground,
      })),
    );
  const [applyToAll, setApplyToAll] = useState(false);
  const target = applyToAll ? ('all' as const) : activePageIndex;
  const selected = pages[activePageIndex];

  const onSelect = useCallback((index: number) => jumpToPage(index), [jumpToPage]);
  const { drag, getItemProps } = usePointerReorder({ count: pages.length, onMove: movePage, onSelect });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setArrangerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setArrangerOpen]);

  if (!open) return null;

  return (
    <aside
      id="page-arranger"
      role="dialog"
      aria-label="Page arranger"
      className="fixed inset-y-0 right-0 z-30 flex w-full max-w-[440px] flex-col border-l border-zinc-200 bg-white/95 shadow-2xl backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/95"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          Pages <span className="ml-1 text-sm font-normal text-zinc-500 dark:text-zinc-400" data-arranger-count>{pages.length}</span>
        </h2>
        <button type="button" className={opButton} onClick={() => setArrangerOpen(false)} aria-label="Close page arranger">
          Close
        </button>
      </header>

      <div className="flex flex-wrap gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800" role="group" aria-label="Page operations">
        <button type="button" className={opButton} onClick={() => addPage('before', activePageIndex)}>
          Add before
        </button>
        <button type="button" className={opButton} onClick={() => addPage('after', activePageIndex)}>
          Add after
        </button>
        <button type="button" className={opButton} onClick={() => duplicatePage(activePageIndex)}>
          Duplicate
        </button>
        <button
          type="button"
          className={`${opButton} text-rose-700 dark:text-rose-300`}
          onClick={() => deletePage(activePageIndex)}
          disabled={pages.length <= 1}
          title={pages.length <= 1 ? 'A document needs at least one page' : 'Delete page'}
        >
          Delete
        </button>
      </div>

      <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800" role="group" aria-label="Page appearance">
        <div className="flex items-center gap-2">
          <label htmlFor="arranger-template" className="w-20 text-zinc-600 dark:text-zinc-300">
            Template
          </label>
          <select
            id="arranger-template"
            className="h-9 flex-1 rounded-lg border border-zinc-300 bg-white px-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            value={selected?.template ?? 'blank'}
            onChange={(e) => setPageTemplate(target, e.target.value as PageTemplate)}
          >
            {PAGE_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-20 text-zinc-600 dark:text-zinc-300">Background</span>
          <div className="flex flex-1 items-center gap-1.5" role="group" aria-label="Background colour">
            {PAGE_BACKGROUND_SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Background ${color}`}
                aria-pressed={selected?.backgroundColor.toLowerCase() === color}
                className={`h-7 w-7 rounded-full ring-1 ring-black/15 dark:ring-white/20 ${
                  selected?.backgroundColor.toLowerCase() === color ? 'outline-2 outline-offset-2 outline-blue-500' : ''
                }`}
                style={{ backgroundColor: color }}
                onClick={() => setPageBackground(target, color)}
              />
            ))}
            <input
              type="color"
              aria-label="Custom background colour"
              className="h-8 w-8 cursor-pointer rounded-md border-0 bg-transparent p-0"
              value={selected?.backgroundColor ?? '#ffffff'}
              onChange={(e) => setPageBackground(target, e.target.value)}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-zinc-700 dark:text-zinc-200">
          <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
          Apply to all pages
        </label>
      </div>

      <ol className="grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto p-3" aria-label="Page thumbnails (drag to reorder, Alt+arrows to move)">
        {pages.map((page, index) => (
          <PageThumbnail
            key={page.id}
            page={page}
            index={index}
            selected={index === activePageIndex}
            dragging={drag?.from === index}
            dropTarget={drag !== null && drag.over === index && drag.from !== index}
            itemProps={getItemProps(index)}
          />
        ))}
      </ol>
    </aside>
  );
}
