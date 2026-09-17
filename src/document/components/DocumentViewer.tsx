import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import type { ToolSettings } from '../../inking/types';
import { ACTIVE_OVERSCAN_PX, PAGE_GAP, RENDER_OVERSCAN_PX, VIEWER_PADDING } from '../constants';
import { scrollForAnchor } from '../gestures';
import { useTouchGestures, type TouchGestureCommit } from '../hooks/useTouchGestures';
import { currentPageIndex, inRange, layoutPages, scrollTopForPage, visibleRange, type PageLayout } from '../layout';
import { useDocumentStore } from '../store';
import { useToolStore } from '../toolStore';
import { PageFrame } from './PageFrame';

export interface DocumentViewerProps {
  settingsRef: RefObject<ToolSettings>;
  currentTool: ToolSettings['tool'];
}

interface Viewport {
  width: number;
  height: number;
  scrollTop: number;
}

/** Ignore scroll-driven active-page updates briefly after a programmatic jump. */
const JUMP_SETTLE_MS = 350;

/**
 * Scrollable page column with canvas virtualisation. Pages near the viewport
 * mount live canvases, pages a bit farther get raster snapshots, and pages
 * beyond that render nothing at all (their space is still reserved so the
 * scrollbar stays truthful).
 */
export function DocumentViewer({ settingsRef, currentTool }: DocumentViewerProps) {
  const { pages, viewMode, zoom, activePageIndex } = useDocumentStore(
    useShallow((s) => ({
      pages: s.document.pages,
      viewMode: s.document.viewMode,
      zoom: s.document.zoom,
      activePageIndex: s.document.activePageIndex,
    })),
  );
  const scrollRequest = useDocumentStore((s) => s.scrollRequest);
  const setActivePage = useDocumentStore((s) => s.setActivePage);
  const setZoom = useDocumentStore((s) => s.setZoom);
  const touchDraw = useToolStore((s) => s.settings.touchDraw);
  const readOnly = useDocumentStore((s) => s.readOnly);

  const scrollRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0, scrollTop: 0 });
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

  const singlePage = viewMode === 'single' ? pages[activePageIndex] : undefined;
  const layoutInput = singlePage ? [singlePage] : pages;
  const layout = useMemo(
    () => layoutPages(layoutInput, { zoom, gap: PAGE_GAP, padding: VIEWER_PADDING, containerWidth: viewport.width }),
    [layoutInput, zoom, viewport.width],
  );
  const layoutRef = useLatestRef(layout);
  const singlePageRef = useLatestRef(Boolean(singlePage));
  const zoomRef = useLatestRef(zoom);
  // A locked document never inks, so one finger always pans it.
  const oneFingerInksRef = useLatestRef(touchDraw && !readOnly);

  // rAF-throttled scroll tracking. The active page is derived here, from real
  // scroll events only: deriving it in an effect keyed on layout changes would
  // run with a stale scrollTop right after a page is added and undo the jump.
  const onScroll = useCallback(() => {
    if (frameRef.current !== 0) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const scrollTop = el.scrollTop;
      setViewport((v) => (v.scrollTop === scrollTop ? v : { ...v, scrollTop }));
      if (singlePageRef.current) return;
      if (performance.now() - lastJumpRef.current < JUMP_SETTLE_MS) return;
      setActivePage(currentPageIndex(layoutRef.current.items, scrollTop, el.clientHeight));
    });
  }, [setActivePage, layoutRef, singlePageRef]);
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
    setViewport((v) => (v.scrollTop === el.scrollTop ? v : { ...v, scrollTop: el.scrollTop }));
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

  const activeRange = visibleRange(layout.items, viewport.scrollTop, viewport.height, ACTIVE_OVERSCAN_PX);
  const renderRange = visibleRange(layout.items, viewport.scrollTop, viewport.height, RENDER_OVERSCAN_PX);

  // Jump requests → scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    lastJumpRef.current = performance.now();
    const top = singlePage ? 0 : scrollTopForPage(layout.items, activePageIndex, VIEWER_PADDING);
    el.scrollTo({ top, behavior: 'auto' });
    setViewport((v) => (v.scrollTop === el.scrollTop ? v : { ...v, scrollTop: el.scrollTop }));
    // Only re-run when a jump is requested (or the layout changes underneath one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest, singlePage]);

  return (
    <div
      ref={scrollRef}
      className="relative h-full w-full overflow-auto bg-zinc-200 dark:bg-zinc-900"
      onScroll={onScroll}
      {...gestureHandlers}
      style={{ touchAction: 'none' }}
      data-viewer
      data-view-mode={viewMode}
      data-read-only={readOnly ? 'true' : undefined}
    >
      <div className="relative" style={{ height: layout.totalHeight, minWidth: layout.totalWidth }}>
        {/* Pinch previews transform this wrapper; the sized parent keeps the scroll range stable meanwhile. */}
        <div ref={previewRef} className="absolute inset-0" style={{ transformOrigin: '0 0' }} data-viewer-content>
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
