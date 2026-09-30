import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, CornerDownLeft, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { selectStrokesInLasso } from '../../inking/engine/lasso';
import { eraserRadius } from '../../inking/engine/toolStyles';
import {
  ZOOM_MAGNIFICATIONS,
  ZOOM_WINDOW_HEIGHTS,
  regionSize,
  shouldAdvance,
  type ZoomStep,
} from '../../inking/engine/zoomRegion';
import { InkSurface } from '../../inking/InkSurface';
import type { Point, Stroke, ToolSettings } from '../../inking/types';
import { backgroundWidthBucket } from '../../pdf/pdfCoords';
import { usePreferencesStore } from '../../preferences/store';
import { useAidStore } from '../aids';
import { useDocumentStore } from '../store';
import { cancelBarrelButton, consumeBarrelButton, noteBarrelButton } from '../stylusBarrel';
import { pageSnapSpacing, templateSvgDataUrl } from '../templates';
import { borrowSelectionTool } from '../toolBorrow';
import { beginTemporaryTool, useToolStore } from '../toolStore';
import type { Page } from '../types';
import { useZoomWindowStore } from '../zoomWindow';

export interface ZoomWindowProps {
  settingsRef: RefObject<ToolSettings>;
  currentTool: ToolSettings['tool'];
}

const BUTTON =
  'inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium text-zinc-700 ' +
  'hover:bg-zinc-200/80 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:text-zinc-200 dark:hover:bg-zinc-700/80';

/**
 * A strip along the bottom of the screen that shows a region of one page magnified, to
 * write in. It is a second drawing surface on the same page: what is written in it is
 * committed to the page's strokes at the page's own size, and what is on the page shows
 * in it, so the two stay the same thing seen at two scales.
 *
 * It sits below the page area in the layout rather than over it, so the page area (and
 * the toolbar docked in it) simply gets shorter while it is open.
 */
export const ZoomWindow = memo(function ZoomWindow({ settingsRef, currentTool }: ZoomWindowProps) {
  const { open, pageId, mag, height, width, origin } = useZoomWindowStore(
    useShallow((s) => ({ open: s.open, pageId: s.pageId, mag: s.mag, height: s.height, width: s.width, origin: s.origin })),
  );
  const { close, setMag, setHeight, setWidth, step, nextLine, follow } = useZoomWindowStore(
    useShallow((s) => ({
      close: s.close,
      setMag: s.setMag,
      setHeight: s.setHeight,
      setWidth: s.setWidth,
      step: s.step,
      nextLine: s.nextLine,
      follow: s.follow,
    })),
  );
  const page = useDocumentStore((s) => s.document.pages.find((p) => p.id === pageId));
  const pageIndex = useDocumentStore((s) => s.document.pages.findIndex((p) => p.id === pageId));
  const { commitStroke, eraseStrokes, setActivePage, setLassoSelection, clearLassoSelection } = useDocumentStore(
    useShallow((s) => ({
      commitStroke: s.commitStroke,
      eraseStrokes: s.eraseStrokes,
      setActivePage: s.setActivePage,
      setLassoSelection: s.setLassoSelection,
      clearLassoSelection: s.clearLassoSelection,
    })),
  );
  const readOnly = useDocumentStore((s) => s.readOnly);
  const lowLatencyInk = usePreferencesStore((s) => s.lowLatencyInk);
  const eraserSize = useToolStore((s) => s.settings.eraserSize);
  const ruler = useAidStore((s) => (s.ruler?.pageId === pageId ? s.ruler : null));
  const areaRef = useRef<HTMLDivElement>(null);

  // A locked note cannot be written in.
  useEffect(() => {
    if (readOnly && open) close();
  }, [readOnly, open, close]);
  // A page that is gone takes the window with it.
  useEffect(() => {
    if (open && !page) close();
  }, [open, page, close]);

  // The width the region is measured from is whatever the strip is given.
  useEffect(() => {
    const el = areaRef.current;
    if (!el || !page) return;
    const pageDims = page.dimensions;
    const measure = (): void => setWidth(el.clientWidth, pageDims);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, page, setWidth]);

  const region = useMemo(() => regionSize({ width, height }, mag), [width, height, mag]);
  const pageDims = page?.dimensions;
  const pageSize = useMemo(() => ({ w: pageDims?.width ?? 0, h: pageDims?.height ?? 0 }), [pageDims]);
  const backgroundImage = useMemo(
    () => (page ? templateSvgDataUrl(page) : 'none'),
    // Only what the template looks like matters, not the strokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page?.dimensions, page?.template, page?.templateConfig, page?.backgroundColor],
  );

  const onCommit = useCallback(
    (stroke: Stroke) => {
      if (!page) return;
      commitStroke(page.id, stroke);
      // Writing reaches the end of the strip: move on so there is room for more, keeping the
      // end of what was just written a little way in so it can be seen joining the next.
      if (shouldAdvance(stroke.bbox.maxX, origin, region, pageSize)) {
        const at = { x: stroke.bbox.maxX - region.w * 0.25, y: origin.y };
        window.setTimeout(() => follow(at, page.dimensions), 120);
      }
    },
    [page, commitStroke, origin, region, pageSize, follow],
  );
  const onErase = useCallback((ids: ReadonlySet<string>) => page && eraseStrokes(page.id, ids), [page, eraseStrokes]);
  const onInteractionStart = useCallback(() => {
    if (pageIndex >= 0) setActivePage(pageIndex);
  }, [pageIndex, setActivePage]);
  const onBarrelSelect = useCallback(() => beginTemporaryTool('select'), []);
  const onLassoComplete = useCallback(
    (polygon: readonly Point[]) => {
      if (!page) return;
      const { lassoMode, lassoFilter } = settingsRef.current;
      const ids = selectStrokesInLasso(page.strokes, polygon, { mode: lassoMode, filter: lassoFilter });
      setLassoSelection(ids.length > 0 ? { pageId: page.id, strokeIds: ids } : null);
    },
    [page, settingsRef, setLassoSelection],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!page || e.ctrlKey) return;
      // The strip moves along the page the way the wheel would move it, in page units.
      follow({ x: origin.x + e.deltaX / mag, y: origin.y + e.deltaY / mag }, page.dimensions);
    },
    [page, origin, mag, follow],
  );

  if (!open || !page) return null;

  const erasing = currentTool === 'eraser-stroke' || currentTool === 'eraser-pixel';
  const eraserDiameterPx = erasing ? 2 * eraserRadius({ eraserSize } as Readonly<ToolSettings>, currentTool) * mag : null;
  const steps: readonly { readonly step: ZoomStep; readonly label: string; readonly Icon: typeof ChevronLeft }[] = [
    { step: 'left', label: 'Move the window left', Icon: ChevronLeft },
    { step: 'right', label: 'Move the window right', Icon: ChevronRight },
    { step: 'up', label: 'Move the window up', Icon: ChevronUp },
    { step: 'down', label: 'Move the window down', Icon: ChevronDown },
  ];
  const nextHeight = ZOOM_WINDOW_HEIGHTS[(Math.max(0, ZOOM_WINDOW_HEIGHTS.indexOf(height as never)) + 1) % ZOOM_WINDOW_HEIGHTS.length]!;

  return (
    <div
      className="relative z-20 flex shrink-0 flex-col border-t border-zinc-300 bg-white shadow-[0_-4px_12px_rgba(0,0,0,0.08)] dark:border-zinc-700 dark:bg-zinc-900"
      data-zoom-window
      data-zoom-magnification={mag}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-2" role="toolbar" aria-label="Zoom window">
        <span className="pr-1 text-xs font-semibold text-zinc-600 dark:text-zinc-300">Zoom</span>
        <div className="flex items-center gap-0.5" role="group" aria-label="Magnification">
          {ZOOM_MAGNIFICATIONS.map((m) => (
            <button
              key={m}
              type="button"
              className={`${BUTTON} ${m === mag ? 'bg-blue-600 text-white hover:bg-blue-600 dark:hover:bg-blue-600' : ''}`}
              aria-pressed={m === mag}
              data-zoom-mag={m}
              onClick={() => setMag(m, page.dimensions)}
            >
              {m}×
            </button>
          ))}
        </div>
        <span className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-600" aria-hidden="true" />
        <div className="flex items-center gap-0.5" role="group" aria-label="Move the window">
          {steps.map(({ step: s, label, Icon }) => (
            <button key={s} type="button" className={BUTTON} title={label} aria-label={label} data-zoom-step={s} onClick={() => step(s, page.dimensions)}>
              <Icon size={15} aria-hidden="true" />
            </button>
          ))}
        </div>
        <button
          type="button"
          className={BUTTON}
          title="Next line: back to where this one began, and down"
          aria-label="Next line"
          data-zoom-next-line
          onClick={() => nextLine(page.dimensions)}
        >
          <CornerDownLeft size={15} aria-hidden="true" />
          <span className="hidden sm:inline">Next line</span>
        </button>
        <span className="flex-1" />
        <button
          type="button"
          className={BUTTON}
          title="Make the window taller or shorter"
          aria-label="Change the window's height"
          data-zoom-height
          onClick={() => setHeight(nextHeight, page.dimensions)}
        >
          <ChevronsUpDown size={15} aria-hidden="true" />
        </button>
        <button type="button" className={BUTTON} title="Close the zoom window" aria-label="Close the zoom window" data-zoom-close onClick={close}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <div
        ref={areaRef}
        className="relative overflow-hidden"
        style={{
          height,
          backgroundColor: page.backgroundColor,
          backgroundImage,
          backgroundSize: `${page.dimensions.width * mag}px ${page.dimensions.height * mag}px`,
          backgroundPosition: `${-origin.x * mag}px ${-origin.y * mag}px`,
          backgroundRepeat: 'no-repeat',
        }}
        data-zoom-area
        onWheel={onWheel}
      >
        {page.pdf && <WindowPdf page={page} origin={origin} mag={mag} width={width} height={height} />}
        <InkSurface
          key={lowLatencyInk ? 'low-latency' : 'standard'}
          width={region.w}
          height={region.h}
          zoom={mag}
          viewOrigin={origin}
          strokes={page.strokes}
          settingsRef={settingsRef}
          allowMouse
          allowTouch={!readOnly}
          onCommitStroke={onCommit}
          onEraseStrokes={onErase}
          onInteractionStart={onInteractionStart}
          onBarrelSelect={onBarrelSelect}
          onBorrowSelectionTool={borrowSelectionTool}
          onBarrelStroke={consumeBarrelButton}
          onBarrelButton={noteBarrelButton}
          onBarrelCancel={cancelBarrelButton}
          onLassoStart={clearLassoSelection}
          onLassoComplete={onLassoComplete}
          eraserDiameterPx={eraserDiameterPx}
          gridSpacing={pageSnapSpacing(page)}
          {...(ruler ? { ruler } : {})}
          currentTool={currentTool}
          interactive={currentTool !== 'select'}
          ariaLabel="Zoom window drawing surface"
        />
      </div>
    </div>
  );
});

/**
 * The PDF behind the page, cropped to the region: drawn from the page's raster, which is asked
 * for at the window's magnification so the writing is not laid over a blurred copy of the page.
 */
function WindowPdf({ page, origin, mag, width, height }: { page: Page; origin: Point; mag: number; width: number; height: number }) {
  const ref = page.pdf;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const target = backgroundWidthBucket(Math.max(1, page.dimensions.width * mag), dpr);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceId = ref?.sourceId ?? '';
  const pageIndex = ref?.pageIndex ?? -1;
  const rotation = ref?.rotation ?? 0;

  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    import('../../pdf/pdfRenderer')
      .then((renderer) => renderer.renderPdfPageBitmap(ref, target))
      .then((b) => {
        if (!cancelled) setBitmap(b);
      })
      .catch(() => {
        /* the plain page colour stays */
      });
    return () => {
      cancelled = true;
    };
    // `ref` is identified by these three values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, pageIndex, rotation, target]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap || bitmap.width === 0) return;
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const scale = bitmap.width / page.dimensions.width;
    try {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(bitmap, origin.x * scale, origin.y * scale, (width / mag) * scale, (height / mag) * scale, 0, 0, w, h);
    } catch {
      /* evicted; the next render refreshes */
    }
  }, [bitmap, origin.x, origin.y, mag, width, height, dpr, page.dimensions.width]);

  if (!ref) return null;
  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute left-0 top-0 z-0 block"
      style={{ width, height }}
      data-zoom-pdf={bitmap ? 'ready' : 'loading'}
      aria-hidden="true"
    />
  );
}
