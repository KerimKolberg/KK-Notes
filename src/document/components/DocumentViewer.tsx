import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import type { ToolSettings } from '../../inking/types';
import { ACTIVE_OVERSCAN_PX, PAGE_GAP, RENDER_OVERSCAN_PX, VIEWER_PADDING } from '../constants';
import { currentPageIndex, inRange, layoutPages, scrollTopForPage, visibleRange } from '../layout';
import { useDocumentStore } from '../store';
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

  const scrollRef = useRef<HTMLDivElement>(null);
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
      data-viewer
      data-view-mode={viewMode}
    >
      <div className="relative" style={{ height: layout.totalHeight, minWidth: layout.totalWidth }}>
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
  );
}
