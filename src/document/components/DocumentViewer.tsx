import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import type { ToolSettings } from '../../inking/types';
import { ACTIVE_OVERSCAN_PX, PAGE_GAP, RENDER_OVERSCAN_PX, VIEWER_PADDING } from '../constants';
import { scrollForAnchor } from '../gestures';
import { useTouchGestures, type TouchGestureCommit } from '../hooks/useTouchGestures';
import {
  currentPageIndex,
  inRange,
  layoutPages,
  scrollOffsetForPage,
  visibleRange,
  type LayoutAxis,
  type PageLayout,
} from '../layout';
import { useDocumentStore } from '../store';
import { useToolStore } from '../toolStore';
import { CoverSheet } from './CoverSheet';
import { PageFrame } from './PageFrame';

export interface DocumentViewerProps {
  settingsRef: RefObject<ToolSettings>;
  currentTool: ToolSettings['tool'];
}

interface Viewport {
  width: number;
  height: number;
  scrollTop: number;
  scrollLeft: number;
}

/** Ignore scroll-driven active-page updates briefly after a programmatic jump. */
const JUMP_SETTLE_MS = 350;

/**
 * Scrollable page strip with canvas virtualisation. Pages near the viewport
 * mount live canvases, pages a bit farther get raster snapshots, and pages
 * beyond that render nothing at all (their space is still reserved so the
 * scrollbar stays truthful).
 *
 * The strip runs down the page in `vertical-continuous` and across it in
 * `horizontal-continuous`; everything scroll-related is expressed along that
 * main axis, so both modes share one code path.
 */
export function DocumentViewer({ settingsRef, currentTool }: DocumentViewerProps) {
  const { pages, viewMode, zoom, activePageIndex, cover } = useDocumentStore(
    useShallow((s) => ({
      pages: s.document.pages,
      viewMode: s.document.viewMode,
      zoom: s.document.zoom,
      activePageIndex: s.document.activePageIndex,
      cover: s.document.cover,
    })),
  );
  const scrollRequest = useDocumentStore((s) => s.scrollRequest);
  const setActivePage = useDocumentStore((s) => s.setActivePage);
  const setZoom = useDocumentStore((s) => s.setZoom);
  const touchDraw = useToolStore((s) => s.settings.touchDraw);
  const readOnly = useDocumentStore((s) => s.readOnly);

  const scrollRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0, scrollTop: 0, scrollLeft: 0 });
  const frameRef = useRef(0);
  const lastJumpRef = useRef(0);

  // Track container size.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void =>
      setViewport((v) => {
        const width = el.clientWidth;
        const height = el.clientHeight;
        return v.width === width && v.height === height ? v : { ...v, width, height };
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const singlePage = viewMode === 'single-page' ? pages[activePageIndex] : undefined;
  const axis: LayoutAxis = viewMode === 'horizontal-continuous' ? 'x' : 'y';
  const layoutInput = singlePage ? [singlePage] : pages;
  // The cover belongs to the continuous modes; single-page shows only pages.
  const coverDimensions = !singlePage && cover ? (pages[0]?.dimensions ?? null) : null;
  const layout = useMemo(
    () =>
      layoutPages(layoutInput, {
        zoom,
        gap: PAGE_GAP,
        padding: VIEWER_PADDING,
        containerWidth: viewport.width,
        containerHeight: viewport.height,
        axis,
        cover: coverDimensions,
      }),
    [layoutInput, zoom, viewport.width, viewport.height, axis, coverDimensions],
  );
  const layoutRef = useLatestRef(layout);
  const singlePageRef = useLatestRef(Boolean(singlePage));
  const zoomRef = useLatestRef(zoom);
  const axisRef = useLatestRef(axis);
  // A locked document never inks, so one finger always pans it.
  const oneFingerInksRef = useLatestRef(touchDraw && !readOnly);

  const scrollMain = axis === 'y' ? viewport.scrollTop : viewport.scrollLeft;
  const viewportMain = axis === 'y' ? viewport.height : viewport.width;

  // rAF-throttled scroll tracking. The active page is derived here, from real
  // scroll events only: deriving it in an effect keyed on layout changes would
  // run with a stale scroll offset right after a page is added and undo the jump.
  const onScroll = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const { scrollTop, scrollLeft } = el;
      setViewport((v) => (v.scrollTop === scrollTop && v.scrollLeft === scrollLeft ? v : { ...v, scrollTop, scrollLeft }));
      if (singlePageRef.current) return;
      if (performance.now() - lastJumpRef.current < JUMP_SETTLE_MS) return;
      const currentAxis = axisRef.current;
      setActivePage(
        currentPageIndex(
          layoutRef.current.items,
          currentAxis === 'y' ? scrollTop : scrollLeft,
          currentAxis === 'y' ? el.clientHeight : el.clientWidth,
          currentAxis,
        ),
      );
    });
  }, [setActivePage, layoutRef, singlePageRef, axisRef]);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  // Two-finger pan / pinch. A pinch is previewed with a CSS transform and
  // committed here: same zoom → re-scroll now; new zoom → wait for the layout
  // at that zoom, then re-scroll so the anchored page point stays put.
  const pendingCommitRef = useRef<TouchGestureCommit | null>(null);
  const applyGestureCommit = useCallback((commit: TouchGestureCommit, items: readonly PageLayout[], z: number) => {
    const el = scrollRef.current;
    if (previewRef.current) previewRef.current.style.transform = '';
    if (!el) return;
    const scroll = scrollForAnchor(items, commit.anchor, z);
    if (scroll) {
      el.scrollLeft = scroll.x;
      el.scrollTop = scroll.y;
    }
    setViewport((v) =>
      v.scrollTop === el.scrollTop && v.scrollLeft === el.scrollLeft
        ? v
        : { ...v, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft },
    );
  }, []);
  const onGestureCommit = useCallback(
    (commit: TouchGestureCommit) => {
      if (commit.zoom === zoomRef.current) {
        applyGestureCommit(commit, layoutRef.current.items, commit.zoom);
        return;
      }
      pendingCommitRef.current = commit;
      setZoom(commit.zoom);
    },
    [applyGestureCommit, layoutRef, zoomRef, setZoom],
  );
  useLayoutEffect(() => {
    const pending = pendingCommitRef.current;
    if (!pending || pending.zoom !== zoom) return;
    pendingCommitRef.current = null;
    applyGestureCommit(pending, layout.items, zoom);
  }, [layout, zoom, applyGestureCommit]);
  const gestureHandlers = useTouchGestures({ scrollRef, previewRef, layoutRef, zoomRef, oneFingerInksRef, onCommit: onGestureCommit });

  const activeRange = visibleRange(layout.items, scrollMain, viewportMain, ACTIVE_OVERSCAN_PX, axis);
  const renderRange = visibleRange(layout.items, scrollMain, viewportMain, RENDER_OVERSCAN_PX, axis);

  // Jump requests → scroll. Also re-runs when the axis changes, so switching
  // between vertical and horizontal keeps the reader on the same page.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastJumpRef.current = performance.now();
    const offset = singlePage ? 0 : scrollOffsetForPage(layout.items, activePageIndex, VIEWER_PADDING, axis);
    el.scrollTo(axis === 'y' ? { top: offset, left: 0, behavior: 'auto' } : { left: offset, top: 0, behavior: 'auto' });
    setViewport((v) =>
      v.scrollTop === el.scrollTop && v.scrollLeft === el.scrollLeft
        ? v
        : { ...v, scrollTop: el.scrollTop, scrollLeft: el.scrollLeft },
    );
    // Only re-run when a jump is requested (or the layout changes underneath one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest, singlePage, axis]);

  return (
    <div
      ref={scrollRef}
      className="relative h-full w-full overflow-auto bg-zinc-200 dark:bg-zinc-900"
      onScroll={onScroll}
      {...gestureHandlers}
      style={{ touchAction: 'none' }}
      data-viewer
      data-view-mode={viewMode}
      data-axis={axis}
      data-read-only={readOnly ? 'true' : undefined}
    >
      <div className="relative" style={{ height: layout.totalHeight, width: layout.totalWidth, minWidth: '100%' }}>
        {/* Pinch previews transform this wrapper; the sized parent keeps the scroll range stable meanwhile. */}
        <div ref={previewRef} className="absolute inset-0" style={{ transformOrigin: '0 0' }} data-viewer-content>
          {cover && layout.cover && <CoverSheet cover={cover} layout={layout.cover} pageCount={pages.length} />}
          {layout.items.map((item) => {
            if (!inRange(renderRange, item.index)) return null;
            const page = layoutInput[item.index];
            if (!page) return null;
            const documentIndex = singlePage ? activePageIndex : item.index;
            return (
              <PageFrame
                key={page.id}
                page={page}
                index={documentIndex}
                layout={item}
                mode={inRange(activeRange, item.index) ? 'active' : 'snapshot'}
                zoom={zoom}
                isCurrent={documentIndex === activePageIndex}
                settingsRef={settingsRef}
                currentTool={currentTool}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
