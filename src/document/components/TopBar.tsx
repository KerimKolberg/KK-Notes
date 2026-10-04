import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import {
  AudioLines,
  Bookmark,
  ListTree,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Ellipsis,
  FileDown,
  FileUp,
  House,
  Layers,
  Lock,
  LockOpen,
  Mic,
  Redo2,
  Rows3,
  Scissors,
  Search,
  TextSelect,
  Square,
  Undo2,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { useRouteStore } from '../../library/routeStore';
import { usePreferencesStore } from '../../preferences/store';
import { useDesktopStore } from '../../desktop/desktopStore';
import { useSearchStore } from '../../search/searchStore';
import { useBookmarksStore } from '../bookmarksStore';
import { useContentsStore } from '../contentsStore';
import { useSnipStore } from '../../snip/snipStore';
import { useTextSelectStore } from '../../textselect/textSelectStore';
import { actionExportPdf } from '../../desktop/fileActions';
import { togglePlayer, usePlayerStore } from '../../audio/player';
import { startRecording, stopRecording, useRecorderStore } from '../../audio/recorder';
import { FileMenu } from '../../desktop/FileMenu';
import { IconButton } from '../../ui/IconButton';
import { MAX_ZOOM, MIN_ZOOM } from '../constants';
import { selectIsDirty, useDocumentStore } from '../store';
import { performRedo, performUndo, selectCanRedo, selectCanUndo } from '../undo';
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
  const searchOpen = useSearchStore((s) => s.open);
  const toggleSearch = () => {
    useBookmarksStore.getState().close();
    useSearchStore.getState().toggle();
  };
  const snipping = useSnipStore((s) => s.mode);
  const toggleSnipping = useSnipStore((s) => s.toggleMode);
  const selectingText = useTextSelectStore((s) => s.mode);
  const toggleSelectingText = useTextSelectStore((s) => s.toggleMode);
  const contentsOpen = useContentsStore((s) => s.open);
  const toggleContents = useContentsStore((s) => s.toggle);
  const hasPdf = useDocumentStore((s) => s.document.pages.some((p) => p.pdf !== undefined));
  const bookmarksOpen = useBookmarksStore((s) => s.open);
  const toggleBookmarks = useBookmarksStore((s) => s.toggle);
  const pageBookmarked = useDocumentStore((s) => s.document.pages[s.document.activePageIndex]?.bookmark !== undefined);
  const zoomStep = usePreferencesStore((s) => s.zoom.zoomStep);
  const recorderStatus = useRecorderStore((s) => s.status);
  const recording = recorderStatus !== 'idle';
  const recordingCount = useDocumentStore((s) => s.document.recordings?.length ?? 0);
  const playerOpen = usePlayerStore((s) => s.open);
  const { title, pageCount, activePageIndex, viewMode, zoom, arrangerOpen, exporting, readOnly, dirty, canUndo, canRedo } =
    useDocumentStore(
      useShallow((s) => {
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
          canUndo: selectCanUndo(s),
          canRedo: selectCanRedo(s),
        };
      }),
    );
  const { setTitle, jumpToPage, setViewMode, zoomBy, setZoom, setArrangerOpen, setImportDialogOpen, toggleReadOnly } =
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

  // Everything but Search, in order. On a narrow screen they go into the More menu: the tools once the window is
  // narrower than a tablet, the rest once it is narrower than a laptop.
  const actions: BarAction[] = [
    { id: 'view', tier: 'md', icon: mode.icon, label: mode.label, hint: `next: ${nextMode.label.toLowerCase()}`, onClick: () => setViewMode(nextMode.id), data: { 'data-view-mode-toggle': '', 'data-view-mode': viewMode } },
    { id: 'snip', tier: 'md', icon: Scissors, label: 'Snip', hint: 'cut a piece out of a page', active: snipping, onClick: toggleSnipping, data: { 'data-snip-toggle': '' } },
    ...(hasPdf
      ? ([
          { id: 'select-text', tier: 'md', icon: TextSelect, label: 'Select text', hint: "copy, highlight or reuse a PDF's words", active: selectingText, onClick: toggleSelectingText, data: { 'data-select-text-toggle': '' } },
          { id: 'contents', tier: 'md', icon: ListTree, label: 'Contents', hint: "the PDF's chapters", active: contentsOpen, onClick: toggleContents, data: { 'data-contents-toggle': '' } },
        ] satisfies BarAction[])
      : []),
    {
      id: 'record',
      tier: 'md',
      icon: Mic,
      label: recording ? 'Stop recording' : 'Record',
      hint: recording ? 'put the recording in the note' : 'record sound with your writing',
      active: recording,
      disabled: recorderStatus === 'starting' || recorderStatus === 'stopping',
      onClick: () => void (recording ? stopRecording() : startRecording()),
      data: { 'data-record-toggle': '', 'data-recording': String(recording) },
    },
    ...(recordingCount > 0
      ? ([
          { id: 'recordings', tier: 'md', icon: AudioLines, label: 'Recordings', hint: recording ? 'not while recording' : recordingCount === 1 ? 'play it with the writing' : `${recordingCount} recordings`, active: playerOpen, disabled: recording, onClick: togglePlayer, data: { 'data-recordings-toggle': '' } },
        ] satisfies BarAction[])
      : []),
    { id: 'bookmarks', tier: 'lg', icon: pageBookmarked ? BookmarkCheck : Bookmark, label: 'Bookmarks', hint: pageBookmarked ? 'this page is bookmarked' : 'Ctrl+D', active: bookmarksOpen, onClick: toggleBookmarks, data: { 'data-bookmarks-toggle': '' } },
    { id: 'lock', tier: 'lg', icon: readOnly ? Lock : LockOpen, label: 'Read-only lock', hint: readOnly ? 'on' : 'off', active: readOnly, onClick: toggleReadOnly, data: { 'data-lock-toggle': '' } },
    { id: 'import', tier: 'lg', icon: FileUp, label: 'Import PDF', disabled: readOnly, onClick: () => setImportDialogOpen(true), data: { 'data-import-pdf': '' } },
    { id: 'export', tier: 'lg', icon: FileDown, label: 'Export PDF', disabled: exporting, busy: exporting, onClick: () => void actionExportPdf(), data: { 'data-export-pdf': '' } },
  ];

  return (
    <header
      // `relative z-40` gives the bar a stacking context of its own, above the
      // page arranger (z-30) and its scrim (z-20). Without it the bar is a plain
      // static flex child, so a *fixed* drawer paints over it and swallows every
      // tap on the arranger toggle — which on a touchscreen reads as a dead
      // button, because there is no hover to tell you the bar is covered.
      className="relative z-40 flex h-14 min-h-14 shrink-0 items-center gap-1 border-b border-zinc-200 bg-white/95 px-2 dark:border-zinc-800 dark:bg-zinc-950/95"
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
          onClick={performUndo}
          tooltipSide="bottom"
          data-undo
        />
        <IconButton
          icon={Redo2}
          label="Redo"
          hint="Ctrl+Shift+Z"
          disabled={!canRedo || readOnly}
          onClick={performRedo}
          tooltipSide="bottom"
          data-redo
        />
      </div>

      {/* Group 2: what you are looking at. */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
        {/* On a phone the page counter is enough (tap it to jump); the arrows need room it does not have. */}
        <span className="hidden sm:contents">
          <IconButton
            icon={ChevronLeft}
            label="Previous page"
            size="sm"
            disabled={activePageIndex === 0}
            onClick={() => jumpToPage(activePageIndex - 1)}
            tooltipSide="bottom"
          />
        </span>
        <div className="flex min-w-0 items-center gap-1.5">
          {/* Click to rename: it reads as a title until it takes focus. A phone has no room for it beside the
              page counter (the library renames a note too). */}
          <input
            aria-label="Document title"
            className="hidden h-9 min-w-0 max-w-[16rem] flex-1 truncate sm:block rounded-lg bg-transparent px-2 text-base font-semibold text-zinc-900 outline-none hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-2 focus:outline-blue-500 read-only:hover:bg-transparent dark:text-zinc-100 dark:hover:bg-zinc-900 dark:focus:bg-zinc-900"
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
        <span className="hidden sm:contents">
          <IconButton
            icon={ChevronRight}
            label="Next page"
            size="sm"
            disabled={activePageIndex >= pageCount - 1}
            onClick={() => jumpToPage(activePageIndex + 1)}
            tooltipSide="bottom"
          />
        </span>
      </div>

      {notice && !notice.action && (
        <span className="hidden min-w-0 items-center gap-2 truncate text-xs text-zinc-600 xl:flex dark:text-zinc-300" role="status" data-notice>
          <span className="truncate">{notice.text}</span>
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
          <IconButton icon={ZoomOut} label="Zoom out" size="sm" disabled={zoom <= MIN_ZOOM} onClick={() => zoomBy(-1, zoomStep / 100)} tooltipSide="bottom" />
          <button
            type="button"
            className="h-9 w-14 rounded-lg text-xs font-medium tabular-nums text-zinc-600 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800"
            aria-label={`Zoom ${Math.round(zoom * 100)} percent, click to reset`}
            onClick={() => setZoom(1)}
            data-zoom
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton icon={ZoomIn} label="Zoom in" size="sm" disabled={zoom >= MAX_ZOOM} onClick={() => zoomBy(1, zoomStep / 100)} tooltipSide="bottom" />
        </div>

        {actions
          .filter((a) => a.id === 'view')
          .map((a) => (
            <BarButton key={a.id} action={a} />
          ))}
        <IconButton
          icon={Search}
          label="Search this note"
          hint="Ctrl+F"
          active={searchOpen}
          onClick={toggleSearch}
          tooltipSide="bottom"
          data-search-toggle
        />
        {actions
          .filter((a) => a.id !== 'view')
          .map((a) => (
            <BarButton key={a.id} action={a} />
          ))}
        <MoreMenu actions={actions} />
      </div>
    </header>
  );
}

/** A button of the top bar that a narrow screen moves into the More menu. */
interface BarAction {
  readonly id: string;
  /** The narrowest screen it stands in the bar on: `md` a tablet, `lg` a laptop. */
  readonly tier: 'md' | 'lg';
  readonly icon: LucideIcon;
  readonly label: string;
  readonly hint?: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly onClick: () => void;
  /** What the checks and styles find it by. */
  readonly data: Readonly<Record<string, string>>;
}

/** Whether the window is at least `px` wide, following it as it changes. */
function useWiderThan(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const update = (): void => setWide(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return wide;
}

/**
 * Hidden below its tier, where its row in the More menu shows instead. On a wrapper rather than the button, whose
 * own `inline-flex` would win over `hidden`; from its tier up the wrapper steps out of the layout (`contents`).
 */
const SHOWN_FROM: Record<BarAction['tier'], string> = { md: 'hidden md:contents', lg: 'hidden lg:contents' };
const ROW_UNTIL: Record<BarAction['tier'], string> = { md: 'md:hidden', lg: 'lg:hidden' };

function BarButton({ action }: { readonly action: BarAction }) {
  return (
    <span className={SHOWN_FROM[action.tier]}>
      <IconButton
        icon={action.icon}
        label={action.label}
        {...(action.hint !== undefined ? { hint: action.hint } : {})}
        active={action.active ?? false}
        disabled={action.disabled ?? false}
        {...(action.busy !== undefined ? { 'aria-busy': action.busy } : {})}
        onClick={action.onClick}
        tooltipSide="bottom"
        {...action.data}
      />
    </span>
  );
}

/**
 * The buttons a narrow screen has no room for, as a list under one button. Each row says what it is in words
 * (there is no hover on a phone to ask), shows whether it is on, and closes the menu when chosen.
 */
function MoreMenu({ actions }: { readonly actions: readonly BarAction[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  // Something in here that is switched on (snipping, selecting text) gets a dot on the button, since its own
  // button is not there to show it. From a tablet's width up, those stand in the bar themselves.
  const wide = useWiderThan(768);
  const anyOn = actions.some((a) => a.active && (a.tier === 'lg' || !wide));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
    };
    place();
    window.addEventListener('resize', place);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative lg:hidden">
      <IconButton
        icon={Ellipsis}
        label="More"
        active={open}
        hasPopover
        aria-expanded={open}
        badge={anyOn && !open ? <span className="block h-2 w-2 rounded-full bg-blue-600" data-top-bar-more-on /> : undefined}
        onClick={() => setOpen((o) => !o)}
        tooltipSide="bottom"
        data-top-bar-more
      />
      {open &&
        anchor &&
        // On the page's top layer rather than inside the bar, whose stacking would put notices and the pages'
        // own overlays above it.
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="More"
            data-top-bar-more-menu
            className="fixed z-[70] w-60 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
            style={{ top: anchor.top, right: anchor.right }}
          >
            {actions.map((a) => {
              const Icon = a.icon;
              return (
                <button
                  key={a.id}
                  type="button"
                  role={a.active === undefined ? 'menuitem' : 'menuitemcheckbox'}
                  disabled={a.disabled}
                  aria-checked={a.active}
                  data-top-bar-more-item={a.id}
                  className={`${ROW_UNTIL[a.tier]} flex w-full items-center gap-3 px-3 py-2 text-left text-sm disabled:opacity-40 ${
                    a.active ? 'bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' : 'text-zinc-800 hover:bg-zinc-100 dark:text-zinc-100 dark:hover:bg-zinc-800'
                  }`}
                  onClick={() => {
                    setOpen(false);
                    a.onClick();
                  }}
                >
                  <Icon size={16} aria-hidden="true" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{a.label}</span>
                  {a.active && <span className="text-xs">on</span>}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
