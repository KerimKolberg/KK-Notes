import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ChevronLeft,
  ChevronRight,
  Columns3,
  FileDown,
  FileUp,
  House,
  Layers,
  Lock,
  LockOpen,
  Redo2,
  Rows3,
  Square,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { useRouteStore } from '../../library/routeStore';
import { useDesktopStore } from '../../desktop/desktopStore';
import { actionExportPdf } from '../../desktop/fileActions';
import { FileMenu } from '../../desktop/FileMenu';
import { IconButton } from '../../ui/IconButton';
import { MAX_ZOOM, MIN_ZOOM } from '../constants';
import { selectIsDirty, useDocumentStore } from '../store';
import type { ViewMode } from '../types';

interface ViewModeDescriptor {
  readonly id: ViewMode;
  readonly label: string;
  readonly icon: LucideIcon;
}

/** The toggle rotates through these in order. */
const VIEW_MODES: readonly ViewModeDescriptor[] = [
  { id: 'vertical-continuous', label: 'Vertical scrolling', icon: Rows3 },
  { id: 'horizontal-continuous', label: 'Horizontal scrolling', icon: Columns3 },
  { id: 'single-page', label: 'Single page', icon: Square },
];

/**
 * Document context bar: file and history on the left, what you are looking at
 * in the middle, how you are looking at it on the right. Every control is an
 * icon with a tooltip; text (the zoom read-out, the page counter) drops away
 * as the window narrows, and the icons stay.
 */
export function TopBar() {
  const backToLibrary = useRouteStore((s) => s.backToLibrary);
  const { title, pageCount, activePageIndex, viewMode, zoom, arrangerOpen, exporting, readOnly, dirty, canUndo, canRedo, activePageId } =
    useDocumentStore(
      useShallow((s) => {
        const page = s.document.pages[s.document.activePageIndex];
        return {
          title: s.document.title,
          pageCount: s.document.pages.length,
          activePageIndex: s.document.activePageIndex,
          viewMode: s.document.viewMode,
          zoom: s.document.zoom,
          arrangerOpen: s.arrangerOpen,
          exporting: s.exporting,
          readOnly: s.readOnly,
          dirty: selectIsDirty(s),
          canUndo: (page?.undoStack.length ?? 0) > 0,
          canRedo: (page?.redoStack.length ?? 0) > 0,
          activePageId: page?.id ?? '',
        };
      }),
    );
  const { setTitle, jumpToPage, setViewMode, zoomBy, setZoom, setArrangerOpen, setImportDialogOpen, toggleReadOnly, undo, redo } =
    useDocumentStore(
      useShallow((s) => ({
        setTitle: s.setTitle,
        jumpToPage: s.jumpToPage,
        setViewMode: s.setViewMode,
        zoomBy: s.zoomBy,
        setZoom: s.setZoom,
        setArrangerOpen: s.setArrangerOpen,
        setImportDialogOpen: s.setImportDialogOpen,
        toggleReadOnly: s.toggleReadOnly,
        undo: s.undo,
        redo: s.redo,
      })),
    );
  const { notice, setNotice } = useDesktopStore(useShallow((s) => ({ notice: s.notice, setNotice: s.setNotice })));

  const [jumping, setJumping] = useState(false);
  const [jumpDraft, setJumpDraft] = useState(String(activePageIndex + 1));
  const jumpRef = useRef<HTMLInputElement>(null);
  useEffect(() => setJumpDraft(String(activePageIndex + 1)), [activePageIndex]);
  useEffect(() => {
    if (jumping) jumpRef.current?.select();
  }, [jumping]);

  const commitJump = (): void => {
    const n = Math.round(Number(jumpDraft));
    if (Number.isFinite(n) && n >= 1 && n <= pageCount) jumpToPage(n - 1);
    else setJumpDraft(String(activePageIndex + 1));
    setJumping(false);
  };

  const mode = VIEW_MODES.find((m) => m.id === viewMode) ?? VIEW_MODES[0]!;
  const nextMode = VIEW_MODES[(VIEW_MODES.indexOf(mode) + 1) % VIEW_MODES.length]!;

  return (
    <header
      // `relative z-40` gives the bar a stacking context of its own, above the
      // page arranger (z-30) and its scrim (z-20). Without it the bar is a plain
      // static flex child, so a *fixed* drawer paints over it and swallows every
      // tap on the arranger toggle — which on a touchscreen reads as a dead
      // button, because there is no hover to tell you the bar is covered.
      className="relative z-40 flex h-14 min-h-14 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white/85 px-2 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/85"
      style={{
        // Android draws the app edge to edge, so the bar owns the status-bar strip.
        height: 'var(--topbar-h)',
        paddingTop: 'var(--safe-top)',
        paddingLeft: 'max(0.5rem, var(--safe-left))',
        paddingRight: 'max(0.5rem, var(--safe-right))',
      }}
      data-top-bar
    >
      {/* Group 1: document and history. */}
      <div className="flex items-center gap-0.5" role="group" aria-label="Document and history">
        {/* Out of the document and back to the library. Leftmost, because it
            is the way back up and that is where a back control belongs. */}
        <IconButton
          icon={House}
          label="Back to library"
          hint="closes this document"
          onClick={backToLibrary}
          tooltipSide="bottom"
          data-back-to-library
        />
        <FileMenu />
        <IconButton
          icon={Layers}
          label="Page arranger"
          active={arrangerOpen}
          aria-controls="page-arranger"
          onClick={() => setArrangerOpen(!arrangerOpen)}
          tooltipSide="bottom"
          data-arranger-toggle
        />
        <IconButton
          icon={Undo2}
          label="Undo"
          hint="Ctrl+Z"
          disabled={!canUndo || readOnly}
          onClick={() => undo(activePageId)}
          tooltipSide="bottom"
          data-undo
        />
        <IconButton
          icon={Redo2}
          label="Redo"
          hint="Ctrl+Shift+Z"
          disabled={!canRedo || readOnly}
          onClick={() => redo(activePageId)}
          tooltipSide="bottom"
          data-redo
        />
      </div>

      {/* Group 2: what you are looking at. */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
        <IconButton
          icon={ChevronLeft}
          label="Previous page"
          size="sm"
          disabled={activePageIndex === 0}
          onClick={() => jumpToPage(activePageIndex - 1)}
          tooltipSide="bottom"
        />
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Click to rename: it reads as a title until it takes focus. */}
          <input
            aria-label="Document title"
            className="h-9 min-w-0 max-w-[16rem] flex-1 truncate rounded-lg bg-transparent px-2 text-base font-semibold text-zinc-900 outline-none hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-2 focus:outline-blue-500 read-only:hover:bg-transparent dark:text-zinc-100 dark:hover:bg-zinc-900 dark:focus:bg-zinc-900"
            value={title}
            readOnly={readOnly}
            placeholder="Untitled note"
            onChange={(e) => setTitle(e.target.value)}
            data-title
          />
          {dirty && (
            <span className="shrink-0 text-lg leading-none text-amber-500" title="Unsaved changes" aria-label="Unsaved changes" data-dirty>
              •
            </span>
          )}
          {jumping ? (
            <input
              ref={jumpRef}
              type="number"
              aria-label="Jump to page"
              className="h-8 w-16 shrink-0 rounded-full border border-zinc-300 bg-white px-2 text-center text-xs tabular-nums text-zinc-900 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
              min={1}
              max={pageCount}
              value={jumpDraft}
              onChange={(e) => setJumpDraft(e.target.value)}
              onBlur={commitJump}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitJump();
                if (e.key === 'Escape') setJumping(false);
              }}
            />
          ) : (
            <button
              type="button"
              className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium tabular-nums text-zinc-600 hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-blue-500 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              aria-label={`Page ${activePageIndex + 1} of ${pageCount}. Click to jump to a page`}
              onClick={() => setJumping(true)}
              data-page-badge
            >
              <span className="hidden sm:inline">Page </span>
              {activePageIndex + 1}
              <span className="opacity-50"> / </span>
              {pageCount}
            </button>
          )}
        </div>
        <IconButton
          icon={ChevronRight}
          label="Next page"
          size="sm"
          disabled={activePageIndex >= pageCount - 1}
          onClick={() => jumpToPage(activePageIndex + 1)}
          tooltipSide="bottom"
        />
      </div>

      {notice && (
        <span className="hidden min-w-0 items-center gap-2 truncate text-xs text-zinc-600 xl:flex dark:text-zinc-300" role="status" data-notice>
          <span className="truncate">{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              className="rounded px-1.5 py-0.5 font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950"
              onClick={notice.action.run}
            >
              {notice.action.label}
            </button>
          )}
          <button
            type="button"
            className="rounded px-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </span>
      )}

      {/* Group 3: how you are looking at it. */}
      <div className="flex items-center gap-0.5" role="group" aria-label="View">
        <div className="hidden items-center gap-0.5 md:flex">
          <IconButton icon={ZoomOut} label="Zoom out" size="sm" disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(-1)} tooltipSide="bottom" />
          <button
            type="button"
            className="h-9 w-14 rounded-lg text-xs font-medium tabular-nums text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
            aria-label={`Zoom ${Math.round(zoom * 100)} percent, click to reset`}
            onClick={() => setZoom(1)}
            data-zoom
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton icon={ZoomIn} label="Zoom in" size="sm" disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(1)} tooltipSide="bottom" />
        </div>

        <IconButton
          icon={mode.icon}
          label={mode.label}
          hint={`next: ${nextMode.label.toLowerCase()}`}
          onClick={() => setViewMode(nextMode.id)}
          tooltipSide="bottom"
          data-view-mode-toggle
          data-view-mode={viewMode}
        />
        <IconButton
          icon={readOnly ? Lock : LockOpen}
          label="Read-only lock"
          hint={readOnly ? 'on' : 'off'}
          active={readOnly}
          onClick={toggleReadOnly}
          tooltipSide="bottom"
          data-lock-toggle
        />
        <IconButton
          icon={FileUp}
          label="Import PDF"
          disabled={readOnly}
          onClick={() => setImportDialogOpen(true)}
          tooltipSide="bottom"
          data-import-pdf
        />
        <IconButton
          icon={FileDown}
          label="Export PDF"
          disabled={exporting}
          aria-busy={exporting}
          onClick={() => void actionExportPdf()}
          tooltipSide="bottom"
          data-export-pdf
        />
      </div>
    </header>
  );
}
