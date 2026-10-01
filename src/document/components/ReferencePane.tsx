/**
 * A second document beside the editor, to read from.
 *
 * The case this exists for is reading one thing while writing another: a lecture
 * PDF and your summary of it, the exercises and your answers. In both, one side
 * is reference and the other is where the pen goes — so this pane is deliberately
 * **read-only**, and that is what keeps it free.
 *
 * It renders through {@link PageSnapshot}, the same cached rasteriser the page
 * overview uses: one texture per visible page, no event handlers, no live
 * canvases, no pointer pipeline and no animation frame of its own. An idle
 * reference pane costs nothing per frame, so the editor's latency is untouched —
 * which is the whole reason it is not a second editor. Two editable panes would
 * mean pane-scoping every place that reads the document store, and two of
 * everything that makes drawing fast.
 *
 * Only whole pages are drawn, top to bottom, and only the ones near the viewport:
 * a 200-page PDF in here is 200 `<div>`s and a handful of textures.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Minus, PenLine, Plus, Scissors, X } from 'lucide-react';
import { useSnipStore } from '../../snip/snipStore';
import { PageSnapshot } from './PageSnapshot';
import { useTabStore } from '../tabStore';
import type { Page } from '../types';

/** Pages kept rendered above and below the visible run. */
const OVERSCAN = 2;

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;

/** Space kept clear on each side of the pages, so a page is not flush against the divider. */
const GUTTER = 16;

export function ReferencePane(): React.JSX.Element | null {
  const splitId = useTabStore((s) => s.splitId);
  const tabs = useTabStore((s) => s.tabs);
  const closeSplit = useTabStore((s) => s.closeSplit);
  const swapSides = useTabStore((s) => s.swapSides);
  const swapRoles = useTabStore((s) => s.swapRoles);
  const side = useTabStore((s) => s.splitSide);
  const snipping = useSnipStore((s) => s.mode);
  const toggleSnipping = useSnipStore((s) => s.toggleMode);
  const tab = useMemo(() => tabs.find((t) => t.id === splitId) ?? null, [tabs, splitId]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  /** Where the middle of the view was, as fractions of the content, when the zoom last changed. */
  const anchor = useRef<{ readonly x: number; readonly y: number } | null>(null);

  // Width drives the page size, so it is measured rather than assumed: the
  // divider can be dragged at any moment.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
      setViewportHeight(element.clientHeight);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [splitId]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element) setScrollTop(element.scrollTop);
  }, []);

  const pages: readonly Page[] = tab?.session?.document.pages ?? [];

  /** Page boxes at the current width, and where each one sits in the column. */
  const layout = useMemo(() => {
    const available = Math.max(80, width - GUTTER * 2);
    let top = 8;
    return pages.map((page) => {
      const scale = (available / page.dimensions.width) * zoom;
      const cssWidth = page.dimensions.width * scale;
      const cssHeight = page.dimensions.height * scale;
      const box = { page, cssWidth, cssHeight, top };
      top += cssHeight + 12;
      return box;
    });
  }, [pages, width, zoom]);

  const totalHeight = layout.length === 0 ? 0 : (layout[layout.length - 1]!.top ?? 0) + (layout[layout.length - 1]!.cssHeight ?? 0) + 8;
  // The column is as wide as the widest page and its gutters, and never narrower than the pane. A page
  // centred in a column that is narrower than itself would overflow to the left of it, where no scrolling
  // reaches; here the overflow is on the right, which scrolling does.
  const totalWidth = Math.max(width, layout.reduce((widest, box) => Math.max(widest, box.cssWidth), 0) + GUTTER * 2);

  /** Zoom around the middle of what is on screen, not the top left of the document. */
  const changeZoom = useCallback((next: (zoom: number) => number) => {
    const element = scrollRef.current;
    if (element && element.scrollWidth > 0 && element.scrollHeight > 0) {
      anchor.current = {
        x: (element.scrollLeft + element.clientWidth / 2) / element.scrollWidth,
        y: (element.scrollTop + element.clientHeight / 2) / element.scrollHeight,
      };
    }
    setZoom(next);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const at = anchor.current;
    anchor.current = null;
    if (!element || !at) return;
    element.scrollLeft = Math.max(0, at.x * element.scrollWidth - element.clientWidth / 2);
    element.scrollTop = Math.max(0, at.y * element.scrollHeight - element.clientHeight / 2);
  }, [zoom]);

  /** Only the pages near the viewport are handed to the rasteriser. */
  const visible = useMemo(() => {
    if (viewportHeight === 0) return layout.slice(0, 2);
    const from = scrollTop - viewportHeight;
    const to = scrollTop + viewportHeight * 2;
    const near = layout.filter((box) => box.top + box.cssHeight >= from && box.top <= to);
    if (near.length > 0) return near;
    return layout.slice(0, OVERSCAN);
  }, [layout, scrollTop, viewportHeight]);

  const currentPage = useMemo(() => {
    const index = layout.findIndex((box) => box.top + box.cssHeight > scrollTop + 4);
    return index === -1 ? layout.length : index + 1;
  }, [layout, scrollTop]);

  if (!tab) return null;

  return (
    <div className={`flex min-w-0 flex-1 flex-col bg-zinc-200/60 dark:bg-zinc-900 ${side === 'right' ? 'border-l' : 'border-r'} border-zinc-300 dark:border-zinc-700`} data-reference-pane data-reference-side={side}>
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-zinc-300 px-2 dark:border-zinc-700">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-700 dark:text-zinc-300" data-reference-title>
          {tab.title}
        </span>
        <span className="shrink-0 tabular-nums text-[10px] text-zinc-500 dark:text-zinc-400" data-reference-page>
          {pages.length === 0 ? '—' : `${currentPage} / ${pages.length}`}
        </span>
        <button
          type="button"
          aria-label="Edit this one instead; the note you were writing in goes here to be read"
          title="Edit this one instead — what you were writing in comes here to be read"
          data-reference-swap-roles
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-300 dark:hover:bg-zinc-700"
          onClick={() => void swapRoles()}
        >
          <PenLine size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Swap the two sides"
          title="Swap sides — this pane to the other side of the screen"
          data-reference-swap-sides
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-300 dark:hover:bg-zinc-700"
          onClick={swapSides}
        >
          <ArrowLeftRight size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Snip a piece of this document"
          title="Snip a piece of this document"
          aria-pressed={snipping}
          data-reference-snip
          className={`flex h-7 w-7 items-center justify-center rounded ${
            snipping ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-300 dark:hover:bg-zinc-700'
          }`}
          onClick={toggleSnipping}
        >
          <Scissors size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-300 dark:hover:bg-zinc-700"
          onClick={() => changeZoom((z) => Math.max(MIN_ZOOM, Math.round((z - 0.1) * 10) / 10))}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-300 dark:hover:bg-zinc-700"
          onClick={() => changeZoom((z) => Math.min(MAX_ZOOM, Math.round((z + 0.1) * 10) / 10))}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Close reference pane"
          data-reference-close
          className="flex h-7 w-7 items-center justify-center rounded text-zinc-500 hover:bg-zinc-300 hover:text-zinc-800 dark:hover:bg-zinc-700 dark:hover:text-zinc-100"
          onClick={closeSplit}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" data-reference-scroll onScroll={onScroll}>
        {pages.length === 0 ? (
          <p className="p-4 text-xs text-zinc-500 dark:text-zinc-400">This document has no pages.</p>
        ) : (
          <div style={{ position: 'relative', height: totalHeight, width: totalWidth }}>
            {visible.map((box) => (
              <div
                key={box.page.id}
                style={{
                  position: 'absolute',
                  top: box.top,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: box.cssWidth,
                  height: box.cssHeight,
                }}
                className="overflow-hidden rounded bg-white shadow-sm dark:bg-zinc-100"
                data-reference-page-frame
                data-reference-page-id={box.page.id}
              >
                <PageSnapshot page={box.page} cssWidth={box.cssWidth} cssHeight={box.cssHeight} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(ReferencePane);
