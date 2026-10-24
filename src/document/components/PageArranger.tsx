import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  COVER_COLOR_SWATCHES,
  MAX_TEMPLATE_SPACING,
  MIN_TEMPLATE_SPACING,
  PAGE_BACKGROUND_SWATCHES,
  PAGE_TEMPLATES,
  SPACED_TEMPLATES,
  SPACING_PRESETS_MM,
  defaultCover,
  mmToPx,
  pxToMm,
} from '../constants';
import { usePointerReorder, type SelectModifiers } from '../hooks/usePointerReorder';
import { formatPageList, groupDropStart, parsePageList } from '../operations';
import { useDocumentStore } from '../store';
import { usePreferencesStore } from '../../preferences/store';
import type { PageTemplate } from '../types';
import { actionExportPdf } from '../../desktop/fileActions';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { PageThumbnail } from './PageThumbnail';

const opButton =
  'inline-flex h-9 touch-manipulation items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors ' +
  'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 disabled:opacity-40 disabled:hover:bg-zinc-100 ' +
  'dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 dark:disabled:hover:bg-zinc-800 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500';

/**
 * How long the drawer takes to slide in or out. It stays mounted for this long
 * after closing so the exit half of the transition has something to animate.
 * Keep in step with the `duration-200` classes below.
 */
export const ARRANGER_SLIDE_MS = 200;

/**
 * Samsung Notes-style slide-over: thumbnail grid with drag-to-reorder, page
 * operations and per-page (or document-wide) template / background pickers.
 */
export function PageArranger() {
  const open = useDocumentStore((s) => s.arrangerOpen);
  const { pages, activePageIndex, readOnly, cover, title, documentId, exporting } = useDocumentStore(
    useShallow((s) => ({
      documentId: s.document.id,
      exporting: s.exporting,
      pages: s.document.pages,
      activePageIndex: s.document.activePageIndex,
      readOnly: s.readOnly,
      cover: s.document.cover,
      title: s.document.title,
    })),
  );
  const {
    setArrangerOpen,
    jumpToPage,
    movePage,
    addPage,
    duplicatePage,
    deletePage,
    duplicatePages,
    deletePages,
    movePages,
    setPageTemplate,
    setPageBackground,
    setTemplateConfig,
    setCover,
    updateCover,
  } =
    useDocumentStore(
      useShallow((s) => ({
        setArrangerOpen: s.setArrangerOpen,
        jumpToPage: s.jumpToPage,
        movePage: s.movePage,
        addPage: s.addPage,
        duplicatePage: s.duplicatePage,
        deletePage: s.deletePage,
        duplicatePages: s.duplicatePages,
        deletePages: s.deletePages,
        movePages: s.movePages,
        setPageTemplate: s.setPageTemplate,
        setPageBackground: s.setPageBackground,
        setTemplateConfig: s.setTemplateConfig,
        setCover: s.setCover,
        updateCover: s.updateCover,
      })),
    );
  const [applyToAll, setApplyToAll] = useState(false);
  // Picking pages for a batch change: Select, Ctrl/Shift-click, or press and hold a page. Kept by page id, so a
  // picked page stays picked when pages move around it.
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pickedIndices = useMemo(
    () => (picking ? pages.flatMap((p, i) => (picked.has(p.id) ? [i] : [])) : []),
    [picking, pages, picked],
  );
  const batch = pickedIndices.length > 0;
  const target = applyToAll ? ('all' as const) : batch ? pickedIndices : activePageIndex;
  const selected = pages[batch ? pickedIndices[0]! : activePageIndex];
  const stopPicking = useCallback(() => {
    setPicking(false);
    setPicked(new Set());
    setAnchor(null);
  }, []);
  useEffect(() => {
    if (!open) stopPicking();
  }, [open, documentId, stopPicking]);
  // The layout a new note starts with, so a preferred template does not have
  // to be re-chosen for every page.
  const pageDefaults = usePreferencesStore((s) => s.pageDefaults);
  const setPageDefaults = usePreferencesStore((s) => s.setPageDefaults);
  const spacing = selected?.templateConfig.spacing ?? 20;
  const spacingApplies = selected !== undefined && SPACED_TEMPLATES.includes(selected.template);
  const spacingLabel = selected?.template === 'ruled' ? 'Line spacing' : 'Box size';

  const onSelect = useCallback(
    (index: number, { toggle, range }: SelectModifiers) => {
      const id = pages[index]?.id;
      if (!id) return;
      if (readOnly || (!picking && !toggle && !range)) {
        jumpToPage(index);
        return;
      }
      setPicking(true);
      const anchorIndex = anchor === null ? -1 : pages.findIndex((p) => p.id === anchor);
      if (range && anchorIndex !== -1) {
        const [a, b] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
        setPicked((was) => new Set([...(picking ? was : []), ...pages.slice(a, b + 1).map((p) => p.id)]));
        return;
      }
      setPicked((was) => {
        const next = new Set(picking ? was : []);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchor(id);
    },
    [anchor, jumpToPage, pages, picking, readOnly],
  );
  const onLongPress = useCallback(
    (index: number) => {
      const id = pages[index]?.id;
      if (!id) return;
      setPicked((was) => new Set([...(picking ? was : []), id]));
      setPicking(true);
      setAnchor(id);
    },
    [pages, picking],
  );
  // A picked page dragged takes the others with it.
  const groupDrag = (from: number): boolean => pickedIndices.length > 1 && pickedIndices.includes(from);
  const onMove = useCallback(
    (from: number, to: number) => {
      if (pickedIndices.length > 1 && pickedIndices.includes(from)) {
        const start = groupDropStart(pickedIndices, from, to);
        if (start !== null) movePages(pickedIndices, start);
        return;
      }
      movePage(from, to);
    },
    [movePage, movePages, pickedIndices],
  );
  // Read-only: thumbnails still navigate, but nothing reorders or edits.
  const { drag, getItemProps } = usePointerReorder({
    count: pages.length,
    onMove,
    onSelect,
    onLongPress,
    disabled: readOnly,
  });
  const [listDraft, setListDraft] = useState('');
  useEffect(() => setListDraft(formatPageList(pickedIndices)), [pickedIndices]);
  const [moveTo, setMoveTo] = useState('1');
  const pickList = (): void => {
    const indices = parsePageList(listDraft, pages.length);
    if (!indices) return;
    setPicked(new Set(indices.map((i) => pages[i]!.id)));
    setAnchor(indices.length > 0 ? pages[indices[indices.length - 1]!]!.id : null);
  };
  const moveToPage = (): void => {
    const n = Number(moveTo);
    if (!batch || !Number.isFinite(n)) return;
    movePages(pickedIndices, Math.min(Math.max(1, Math.trunc(n)), pages.length - pickedIndices.length + 1) - 1);
  };
  const duplicate = (): void => (batch ? duplicatePages(pickedIndices) : duplicatePage(activePageIndex));
  const remove = (): void => {
    if (!batch) deletePage(activePageIndex);
    else if (pickedIndices.length === 1) {
      deletePages(pickedIndices);
      stopPicking();
    } else setConfirmDelete(true);
  };
  const allPicked = batch && pickedIndices.length >= pages.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || confirmDelete) return;
      // Escape lets go of the picked pages first, and closes the arranger after.
      if (picking) stopPicking();
      else setArrangerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, picking, confirmDelete, setArrangerOpen, stopPicking]);

  // `mounted` keeps the drawer in the DOM across the closing slide; `shown` is
  // the class the transition animates to. Splitting them is what makes the
  // drawer *animate* in rather than appear: on the frame it mounts it is still
  // off-screen, and only the frame after that does it slide.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames, because one is not enough: a single rAF can be batched into
      // the same style recalculation as the mount, and the browser then sees no
      // change to interpolate.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), ARRANGER_SLIDE_MS);
    return () => clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;

  return (
    <>
      {/* Scrim. It starts *below* the top bar, so the toggle that opened the
          drawer is never behind it and always closes it again; and it is only
          drawn on narrow viewports, where the drawer covers the page anyway.
          Wider than that the arranger is a side panel and the page beside it
          stays live, so dimming and blocking it would be wrong. */}
      <div
        aria-hidden="true"
        data-arranger-scrim
        className={`fixed inset-x-0 bottom-0 z-20 bg-black/40 transition-opacity duration-200 motion-reduce:transition-none sm:hidden ${
          shown ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        style={{ top: 'var(--topbar-h)' }}
        onPointerDown={() => setArrangerOpen(false)}
      />
      <aside
        id="page-arranger"
        role="dialog"
        aria-label="Page arranger"
        data-arranger-open={open ? 'true' : 'false'}
        // Mounted-but-closing: inert takes it out of the a11y tree and stops it
        // catching taps meant for the page while it slides away.
        inert={!open}
        className={`fixed bottom-0 right-0 z-30 flex w-full max-w-[440px] flex-col border-l border-zinc-200 bg-white/95 shadow-2xl transition-transform duration-200 ease-out motion-reduce:transition-none dark:border-zinc-800 dark:bg-zinc-950/95 ${
          shown ? 'translate-x-0' : 'translate-x-full'
        }`}
        // Anchored under the top bar rather than to the top of the window: at
        // `w-full` on a phone the drawer is the whole screen, and covering the
        // bar with it is what left the arranger toggle unreachable.
        style={{ top: 'var(--topbar-h)', paddingBottom: 'var(--safe-bottom)', paddingRight: 'var(--safe-right)' }}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Pages <span className="ml-1 text-sm font-normal text-zinc-500 dark:text-zinc-400" data-arranger-count>{pages.length}</span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={opButton}
              aria-pressed={picking}
              disabled={readOnly}
              title="Pick pages to delete, move, copy or restyle together (or Ctrl/Shift-click, or press and hold a page)"
              onClick={() => (picking ? stopPicking() : setPicking(true))}
              data-arranger-select
            >
              {picking ? 'Done' : 'Select'}
            </button>
            <button type="button" className={opButton} onClick={() => setArrangerOpen(false)} aria-label="Close page arranger" data-arranger-close>
              Close
            </button>
          </div>
        </header>

        {/* One scroller for everything under the header. The settings used to
            be fixed-height siblings of a scrolling thumbnail grid, which on a
            short viewport squeezed the grid to nothing and clipped the rest
            with no way to reach it. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {picking && (
            // Sticky, so it is at hand after scrolling down to page 73 of a hundred.
            <div
              className="sticky top-0 z-10 flex flex-col gap-2 border-b border-blue-200 bg-blue-50/95 px-4 py-3 text-sm backdrop-blur dark:border-blue-900 dark:bg-blue-950/95"
              role="group"
              aria-label="Selected pages"
              data-arranger-picking
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto font-medium text-blue-900 dark:text-blue-100" data-arranger-picked-count={pickedIndices.length}>
                  {batch ? `${pickedIndices.length} of ${pages.length} selected` : 'Tap pages to select them'}
                </span>
                <button type="button" className={opButton} onClick={() => setPicked(new Set(pages.map((p) => p.id)))} data-arranger-pick-all>
                  All
                </button>
                <button
                  type="button"
                  className={opButton}
                  title="Select the pages that are not selected, and let go of those that are"
                  onClick={() => setPicked((was) => new Set(pages.filter((p) => !was.has(p.id)).map((p) => p.id)))}
                  data-arranger-pick-invert
                >
                  Invert
                </button>
                <button type="button" className={opButton} disabled={!batch} onClick={() => setPicked(new Set())} data-arranger-pick-none>
                  None
                </button>
              </div>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  pickList();
                }}
              >
                <label htmlFor="arranger-pick-list" className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300">
                  Pages
                </label>
                <input
                  id="arranger-pick-list"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  placeholder="e.g. 2, 15, 20-25, 73"
                  inputMode="numeric"
                  value={listDraft}
                  aria-invalid={listDraft.trim() !== '' && parsePageList(listDraft, pages.length) === null}
                  onChange={(e) => setListDraft(e.target.value)}
                  data-arranger-pick-list
                />
                <button type="submit" className={opButton} data-arranger-pick-list-apply>
                  Select
                </button>
              </form>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  moveToPage();
                }}
              >
                <label htmlFor="arranger-move-to" className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300">
                  Move to
                </label>
                <input
                  id="arranger-move-to"
                  type="number"
                  min={1}
                  max={Math.max(1, pages.length - pickedIndices.length + 1)}
                  className="h-9 w-20 rounded-lg border border-zinc-300 bg-white px-2 tabular-nums text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  value={moveTo}
                  aria-label="Page the selected pages move to"
                  onChange={(e) => setMoveTo(e.target.value)}
                  data-arranger-move-to
                />
                <button type="submit" className={opButton} disabled={!batch || allPicked} data-arranger-move>
                  Move
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  className={opButton}
                  disabled={!batch || exporting}
                  title="Export only the selected pages as a PDF"
                  onClick={() => void actionExportPdf(pickedIndices)}
                  data-arranger-picked-export
                >
                  Export PDF
                </button>
                <button type="button" className={opButton} disabled={!batch} onClick={duplicate} data-arranger-picked-duplicate>
                  Duplicate
                </button>
                <button
                  type="button"
                  className={`${opButton} text-rose-700 dark:text-rose-300`}
                  disabled={!batch || allPicked}
                  title={allPicked ? 'A document needs at least one page' : 'Delete the selected pages'}
                  onClick={remove}
                  data-arranger-picked-delete
                >
                  Delete
                </button>
              </form>
            </div>
          )}
          <div className="flex flex-wrap gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800" role="group" aria-label="Page operations">
            <button type="button" className={opButton} onClick={() => addPage('before', activePageIndex)} disabled={readOnly}>
              Add before
            </button>
            <button type="button" className={opButton} onClick={() => addPage('after', activePageIndex)} disabled={readOnly}>
              Add after
            </button>
            <button type="button" className={opButton} onClick={duplicate} disabled={readOnly}>
              {batch ? `Duplicate ${pickedIndices.length}` : 'Duplicate'}
            </button>
            <button
              type="button"
              className={`${opButton} text-rose-700 dark:text-rose-300`}
              onClick={remove}
              disabled={readOnly || pages.length <= 1 || allPicked}
              title={
                readOnly
                  ? 'The document is locked'
                  : pages.length <= 1 || allPicked
                    ? 'A document needs at least one page'
                    : batch
                      ? 'Delete the selected pages'
                      : 'Delete page'
              }
            >
              {batch ? `Delete ${pickedIndices.length}` : 'Delete'}
            </button>
            {readOnly && (
              <span className="inline-flex h-9 items-center text-sm text-zinc-500 dark:text-zinc-400" data-arranger-read-only>
                Locked
              </span>
            )}
          </div>

          <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800" role="group" aria-label="Page appearance">
            {batch && !applyToAll && (
              <p className="text-xs font-medium text-blue-700 dark:text-blue-300" data-arranger-appearance-target>
                Changes here go to the {pickedIndices.length === 1 ? 'selected page' : `${pickedIndices.length} selected pages`}.
              </p>
            )}
            <div className="flex items-center gap-2">
              <label htmlFor="arranger-template" className="w-20 text-zinc-600 dark:text-zinc-300">
                Template
              </label>
              <select
                id="arranger-template"
                className="h-9 flex-1 rounded-lg border border-zinc-300 bg-white px-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                value={selected?.template ?? 'blank'}
                disabled={readOnly}
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
                    disabled={readOnly}
                    onClick={() => setPageBackground(target, color)}
                  />
                ))}
                <input
                  type="color"
                  aria-label="Custom background colour"
                  className="h-8 w-8 cursor-pointer rounded-md border-0 bg-transparent p-0"
                  value={selected?.backgroundColor ?? '#ffffff'}
                  disabled={readOnly}
                  onChange={(e) => setPageBackground(target, e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300">Defaults</span>
              <div className="flex flex-1 flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={readOnly || !selected}
                  data-set-page-default
                  className="inline-flex h-8 items-center rounded-lg bg-zinc-100 px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                  onClick={() => {
                    if (!selected) return;
                    setPageDefaults({
                      template: selected.template,
                      templateConfig: selected.templateConfig,
                      backgroundColor: selected.backgroundColor,
                    });
                  }}
                >
                  Set as default
                </button>
                {pageDefaults !== null && (
                  <button
                    type="button"
                    data-clear-page-default
                    className="inline-flex h-8 items-center rounded-lg px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    onClick={() => setPageDefaults(null)}
                  >
                    Clear
                  </button>
                )}
                <span className="text-xs text-zinc-500 dark:text-zinc-400" data-page-default-note>
                  {pageDefaults === null
                    ? 'New notes start blank.'
                    : `New notes start ${PAGE_TEMPLATES.find((t) => t.id === pageDefaults.template)?.label.toLowerCase() ?? pageDefaults.template}.`}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="arranger-spacing" className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300">
                {spacingLabel}
              </label>
              <input
                id="arranger-spacing"
                type="range"
                className="h-1 min-w-0 flex-1 accent-blue-600"
                min={MIN_TEMPLATE_SPACING}
                max={MAX_TEMPLATE_SPACING}
                step={0.5}
                value={spacing}
                disabled={readOnly || !spacingApplies}
                aria-label={`${spacingLabel} in page pixels`}
                onChange={(e) => setTemplateConfig(target, { spacing: Number(e.target.value) })}
                data-spacing-range
              />
              <span className="w-16 shrink-0 text-right tabular-nums text-zinc-600 dark:text-zinc-300" data-spacing-value>
                {pxToMm(spacing)} mm
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-20 shrink-0" />
              <div className="flex flex-1 items-center gap-1.5" role="group" aria-label="Spacing presets">
                {SPACING_PRESETS_MM.map((mm) => (
                  <button
                    key={mm}
                    type="button"
                    className={opButton}
                    aria-pressed={Math.abs(spacing - mmToPx(mm)) < 0.6}
                    disabled={readOnly || !spacingApplies}
                    onClick={() => setTemplateConfig(target, { spacing: mmToPx(mm) })}
                    data-spacing-preset={mm}
                  >
                    {mm} mm
                  </button>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-zinc-700 dark:text-zinc-200">
              <input
                type="checkbox"
                className="h-4 w-4 accent-blue-600"
                checked={applyToAll}
                disabled={readOnly}
                onChange={(e) => setApplyToAll(e.target.checked)}
              />
              Apply to all pages
            </label>
          </div>

          <div className="flex flex-col gap-3 border-b border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800" role="group" aria-label="Notebook cover">
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">Cover</span>
              {cover ? (
                <button
                  type="button"
                  className={opButton}
                  onClick={() => setCover(null)}
                  disabled={readOnly}
                  data-cover-remove
                >
                  Remove
                </button>
              ) : (
                <button
                  type="button"
                  className={opButton}
                  onClick={() => setCover(defaultCover(title))}
                  disabled={readOnly}
                  data-cover-add
                >
                  Add cover
                </button>
              )}
            </div>
            {cover && (
              <>
                <div className="flex items-center gap-2">
                  <label htmlFor="cover-title" className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300">
                    Title
                  </label>
                  <input
                    id="cover-title"
                    className="h-9 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-2 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    value={cover.title}
                    disabled={readOnly}
                    onChange={(e) => updateCover({ title: e.target.value })}
                    data-cover-title-input
                  />
                </div>
                <div className="flex items-start gap-2">
                  <label htmlFor="cover-description" className="w-20 shrink-0 pt-2 text-zinc-600 dark:text-zinc-300">
                    Subtitle
                  </label>
                  <textarea
                    id="cover-description"
                    rows={2}
                    className="min-w-0 flex-1 resize-none rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    value={cover.description}
                    disabled={readOnly}
                    onChange={(e) => updateCover({ description: e.target.value })}
                    data-cover-description-input
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300">Colour</span>
                  <div className="flex flex-1 flex-wrap items-center gap-1.5" role="group" aria-label="Cover colour">
                    {COVER_COLOR_SWATCHES.map((color) => (
                      <button
                        key={color}
                        type="button"
                        aria-label={`Cover ${color}`}
                        aria-pressed={cover.coverColor.toLowerCase() === color}
                        className={`h-7 w-7 rounded-full ring-1 ring-black/15 dark:ring-white/20 ${
                          cover.coverColor.toLowerCase() === color ? 'outline-2 outline-offset-2 outline-blue-500' : ''
                        }`}
                        style={{ backgroundColor: color }}
                        disabled={readOnly}
                        onClick={() => updateCover({ coverColor: color })}
                      />
                    ))}
                    <input
                      type="color"
                      aria-label="Custom cover colour"
                      className="h-8 w-8 cursor-pointer rounded-md border-0 bg-transparent p-0"
                      value={cover.coverColor}
                      disabled={readOnly}
                      onChange={(e) => updateCover({ coverColor: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="cover-text-color" className="w-20 shrink-0 text-zinc-600 dark:text-zinc-300">
                    Text
                  </label>
                  <input
                    id="cover-text-color"
                    type="color"
                    className="h-8 w-8 cursor-pointer rounded-md border-0 bg-transparent p-0"
                    value={cover.textColor}
                    disabled={readOnly}
                    onChange={(e) => updateCover({ textColor: e.target.value })}
                  />
                </div>
              </>
            )}
          </div>

          <ol
            className="grid grid-cols-2 content-start gap-2 p-3"
            aria-label={readOnly ? 'Page thumbnails (locked: tap to jump)' : 'Page thumbnails (drag to reorder, Alt+arrows to move)'}
          >
            {pages.map((page, index) => (
              <PageThumbnail
                key={page.id}
                page={page}
                index={index}
                selected={index === activePageIndex}
                checked={picking ? picked.has(page.id) : undefined}
                dragging={drag !== null && (groupDrag(drag.from) ? picked.has(page.id) : drag.from === index)}
                dropTarget={drag !== null && drag.over === index && drag.from !== index && !(groupDrag(drag.from) && picked.has(page.id))}
                itemProps={getItemProps(index)}
              />
            ))}
          </ol>
        </div>
      </aside>
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${pickedIndices.length} pages?`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            deletePages(pickedIndices);
            stopPicking();
          }}
        >
          Pages {formatPageList(pickedIndices)}. Undo brings them back.
        </ConfirmDialog>
      )}
    </>
  );
}
