import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDesktopStore } from '../../desktop/desktopStore';
import { actionExportPdf } from '../../desktop/fileActions';
import { FileMenu } from '../../desktop/FileMenu';
import { MAX_ZOOM, MIN_ZOOM } from '../constants';
import { selectIsDirty, useDocumentStore } from '../store';

const button =
  'inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-2.5 text-sm font-medium transition-colors ' +
  'text-zinc-700 hover:bg-zinc-200 disabled:opacity-40 disabled:hover:bg-transparent ' +
  'dark:text-zinc-200 dark:hover:bg-zinc-800 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500';
const pressed = 'bg-zinc-900 text-white hover:bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-100';

/** Title, page indicator, jump-to-page, view mode, zoom and the arranger toggle. */
export function TopBar() {
  const { title, pageCount, activePageIndex, viewMode, zoom, arrangerOpen, exporting, dirty } = useDocumentStore(
    useShallow((s) => ({
      title: s.document.title,
      pageCount: s.document.pages.length,
      activePageIndex: s.document.activePageIndex,
      viewMode: s.document.viewMode,
      zoom: s.document.zoom,
      arrangerOpen: s.arrangerOpen,
      exporting: s.exporting,
      dirty: selectIsDirty(s),
    })),
  );
  const { setTitle, jumpToPage, setViewMode, zoomBy, setZoom, setArrangerOpen, setImportDialogOpen } = useDocumentStore(
    useShallow((s) => ({
      setTitle: s.setTitle,
      jumpToPage: s.jumpToPage,
      setViewMode: s.setViewMode,
      zoomBy: s.zoomBy,
      setZoom: s.setZoom,
      setArrangerOpen: s.setArrangerOpen,
      setImportDialogOpen: s.setImportDialogOpen,
    })),
  );
  const { notice, setNotice } = useDesktopStore(useShallow((s) => ({ notice: s.notice, setNotice: s.setNotice })));

  const [jumpDraft, setJumpDraft] = useState(String(activePageIndex + 1));
  useEffect(() => setJumpDraft(String(activePageIndex + 1)), [activePageIndex]);

  const commitJump = (): void => {
    const n = Math.round(Number(jumpDraft));
    if (Number.isFinite(n) && n >= 1 && n <= pageCount) jumpToPage(n - 1);
    else setJumpDraft(String(activePageIndex + 1));
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white/90 px-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
      <FileMenu />
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <input
          aria-label="Document title"
          className="h-9 min-w-0 flex-1 rounded-lg bg-transparent px-2 text-base font-semibold text-zinc-900 outline-none placeholder:text-zinc-400 focus:bg-zinc-100 dark:text-zinc-100 dark:focus:bg-zinc-900"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled note"
        />
        {dirty && (
          <span className="shrink-0 text-lg leading-none text-amber-500" title="Unsaved changes" aria-label="Unsaved changes" data-dirty>
            •
          </span>
        )}
        {notice && (
          <span className="hidden min-w-0 items-center gap-2 truncate text-xs text-zinc-600 lg:flex dark:text-zinc-300" role="status" data-notice>
            <span className="truncate">{notice.text}</span>
            {notice.action && (
              <button type="button" className="rounded px-1.5 py-0.5 font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950" onClick={notice.action.run}>
                {notice.action.label}
              </button>
            )}
            <button type="button" className="rounded px-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="Dismiss" onClick={() => setNotice(null)}>
              ×
            </button>
          </span>
        )}
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Page navigation">
        <button type="button" className={button} onClick={() => jumpToPage(activePageIndex - 1)} disabled={activePageIndex === 0} title="Previous page" aria-label="Previous page">
          ‹
        </button>
        <span className="rounded-lg bg-zinc-100 px-2.5 py-1.5 text-sm tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200" data-page-badge>
          Page {activePageIndex + 1} / {pageCount}
        </span>
        <label className="flex items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="sr-only">Jump to page</span>
          <input
            type="number"
            aria-label="Jump to page"
            className="h-9 w-16 rounded-lg border border-zinc-300 bg-white px-2 text-center text-sm tabular-nums text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            min={1}
            max={pageCount}
            value={jumpDraft}
            onChange={(e) => setJumpDraft(e.target.value)}
            onBlur={commitJump}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitJump();
            }}
          />
        </label>
        <button type="button" className={button} onClick={() => jumpToPage(activePageIndex + 1)} disabled={activePageIndex >= pageCount - 1} title="Next page" aria-label="Next page">
          ›
        </button>
      </div>

      <div className="hidden items-center gap-1 sm:flex" role="group" aria-label="View mode">
        <button type="button" className={`${button} ${viewMode === 'continuous' ? pressed : ''}`} aria-pressed={viewMode === 'continuous'} onClick={() => setViewMode('continuous')}>
          Continuous
        </button>
        <button type="button" className={`${button} ${viewMode === 'single' ? pressed : ''}`} aria-pressed={viewMode === 'single'} onClick={() => setViewMode('single')}>
          Single
        </button>
      </div>

      <div className="hidden items-center gap-1 md:flex" role="group" aria-label="Zoom">
        <button type="button" className={button} onClick={() => zoomBy(-1)} disabled={zoom <= MIN_ZOOM} title="Zoom out" aria-label="Zoom out">
          −
        </button>
        <button type="button" className={`${button} w-16 tabular-nums`} onClick={() => setZoom(1)} title="Reset zoom" aria-label={`Zoom ${Math.round(zoom * 100)}%, reset`} data-zoom>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className={button} onClick={() => zoomBy(1)} disabled={zoom >= MAX_ZOOM} title="Zoom in" aria-label="Zoom in">
          +
        </button>
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Import and export">
        <button type="button" className={button} onClick={() => setImportDialogOpen(true)} title="Import pages from a PDF">
          Import PDF
        </button>
        <button
          type="button"
          className={button}
          onClick={() => void actionExportPdf()}
          disabled={exporting}
          aria-busy={exporting}
          title="Export the document as a vector PDF"
          data-export-pdf
        >
          {exporting ? 'Exporting…' : 'Export PDF'}
        </button>
      </div>

      <button
        type="button"
        className={`${button} ${arrangerOpen ? pressed : ''}`}
        aria-pressed={arrangerOpen}
        aria-controls="page-arranger"
        onClick={() => setArrangerOpen(!arrangerOpen)}
        title="Page arranger"
      >
        Pages
      </button>
    </header>
  );
}
