import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  COLOR_PALETTE,
  MAX_CURVE_AMPLITUDE,
  MAX_CURVE_CYCLES,
  MAX_STROKE_SIZE,
  MIN_CURVE_AMPLITUDE,
  MIN_CURVE_CYCLES,
  MIN_STROKE_SIZE,
  STROKE_PATTERNS,
} from '../../inking/constants';
import { subscribeTouchGesture } from '../../inking/engine/gestureState';
import {
  SCALE_HANDLES,
  reshapeStrokes,
  restyleStrokes,
  scaleFromHandle,
  selectionBounds,
  selectionCurveParams,
  transformStroke,
  type ScaleHandle,
  type StrokeTransform,
} from '../../inking/engine/lasso';
import type { CurveEdit } from '../../inking/engine/shapes';
import { clearSurface, drawStroke, get2dContext } from '../../inking/engine/renderer';
import { usePageCanvas } from '../../inking/hooks/usePageCanvas';
import { useViewportShift } from '../../ui/useViewportShift';
import type { BBox, CanvasSize, CurveKind, Point, Stroke, StrokePattern } from '../../inking/types';
import { pageAtViewportPoint, pageHandoffOffset, type PageRect } from '../layout';
import { useDocumentStore } from '../store';
import type { Page } from '../types';

export interface SelectionLayerProps {
  page: Page;
  zoom: number;
  /** Ids of the selected strokes (all on `page`). */
  strokeIds: readonly string[];
  /** Strokes whose committed rendering must be hidden while this layer previews them; `null` when none. */
  onPreviewHidden: (ids: ReadonlySet<string> | null) => void;
  /**
   * True while the selection is being dragged. The page frame lifts its clip
   * for as long as it is, so the preview can be carried onto another page.
   */
  onDraggingChange: (dragging: boolean) => void;
}

/** An uncommitted edit shown on the preview canvas. */
type Draft =
  | { readonly kind: 'transform'; readonly transform: StrokeTransform }
  | { readonly kind: 'size'; readonly size: number }
  | { readonly kind: 'curve'; readonly edit: CurveEdit };

interface Drag {
  readonly mode: 'move' | 'scale';
  readonly handle?: ScaleHandle;
  readonly pointerId: number;
  readonly start: Point;
  readonly bounds: BBox;
}

const HANDLE_CURSORS: Record<ScaleHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

/** Breathing room between the strokes' padded bounds and the dashed box, page units. */
const BOX_MARGIN = 6;
const TOOLBAR_GAP = 12;
/** Approximate toolbar height, CSS px, used to decide above vs. below. */
const TOOLBAR_HEIGHT = 40;
const SWATCHES = COLOR_PALETTE.slice(0, 6);

/** On-screen rects of every mounted page, for deciding where a drag was dropped. */
function mountedPageRects(): PageRect[] {
  const rects: PageRect[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[data-page-id]')) {
    const pageId = el.dataset.pageId;
    if (!pageId) continue;
    const rect = el.getBoundingClientRect();
    rects.push({ pageId, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return rects;
}

function isIdentity(t: StrokeTransform): boolean {
  return t.kind === 'translate' ? t.dx === 0 && t.dy === 0 : t.sx === 1 && t.sy === 1;
}

function applyDraft(selected: readonly Stroke[], ids: ReadonlySet<string>, draft: Draft): Stroke[] {
  if (draft.kind === 'transform') return selected.map((s) => transformStroke(s, draft.transform));
  if (draft.kind === 'curve') return reshapeStrokes(selected, ids, draft.edit);
  return restyleStrokes(selected, ids, { size: draft.size });
}

/** The four paths a committed line can be rebuilt as, same set the line tool offers. */
const CURVE_KINDS: readonly { readonly id: 'straight' | CurveKind; readonly label: string }[] = [
  { id: 'straight', label: 'Straight' },
  { id: 'parabola', label: 'Parabola' },
  { id: 'wave', label: 'Wave' },
  { id: 'zigzag', label: 'Zigzag' },
];

/** The most common stroke width of the selection, for the width slider's initial value. */
function dominantSize(strokes: readonly Stroke[]): number {
  const counts = new Map<number, number>();
  let best = strokes[0]?.style.size ?? 4;
  let bestCount = 0;
  for (const s of strokes) {
    const n = (counts.get(s.style.size) ?? 0) + 1;
    counts.set(s.style.size, n);
    if (n > bestCount) {
      bestCount = n;
      best = s.style.size;
    }
  }
  return best;
}

/**
 * z-25 selection layer for the lasso tool: a dashed box around the selected
 * strokes with body drag (translate), corner handles (scale; Shift for free
 * aspect), and a quick-action toolbar. Edits are previewed on a private
 * canvas — the originals are hidden on the ink layer meanwhile — and
 * committed to the store once, as a single undo step, when the drag ends.
 */
export const SelectionLayer = memo(function SelectionLayer({
  page,
  zoom,
  strokeIds,
  onPreviewHidden,
  onDraggingChange,
}: SelectionLayerProps) {
  const {
    clearLassoSelection,
    transformSelection,
    restyleSelection,
    reshapeSelection,
    duplicateSelection,
    deleteSelection,
    moveSelectionToPage,
  } = useDocumentStore(
    useShallow((s) => ({
      clearLassoSelection: s.clearLassoSelection,
      transformSelection: s.transformSelection,
      restyleSelection: s.restyleSelection,
      reshapeSelection: s.reshapeSelection,
      duplicateSelection: s.duplicateSelection,
      deleteSelection: s.deleteSelection,
      moveSelectionToPage: s.moveSelectionToPage,
    })),
  );

  const idSet = useMemo(() => new Set(strokeIds), [strokeIds]);
  const selected = useMemo(() => page.strokes.filter((s) => idSet.has(s.id)), [page.strokes, idSet]);

  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const setDraft = useCallback((next: Draft | null) => {
    draftRef.current = next;
    setDraftState(next);
  }, []);
  const dragRef = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // The page frame un-clips itself while a drag is in flight, so the preview
  // can leave the sheet; tell it when, and make sure it hears the end even if
  // the move carried the selection onto another page and unmounted this.
  useEffect(() => {
    onDraggingChange(dragging);
  }, [dragging, onDraggingChange]);
  useEffect(() => () => onDraggingChange(false), [onDraggingChange]);

  // The selection evaporated (undo past its creation, page cleared…).
  useEffect(() => {
    if (selected.length === 0) clearLassoSelection();
  }, [selected.length, clearLassoSelection]);

  // A two-finger gesture cancels whatever drag is in flight.
  useEffect(
    () =>
      subscribeTouchGesture((active) => {
        if (!active) return;
        dragRef.current = null;
        setDragging(false);
        setDraft(null);
      }),
    [setDraft],
  );

  /**
   * A move is previewed by translating the whole layer rather than the strokes
   * inside it: the preview canvas is only as big as the page, so geometry
   * carried past the edge would be cut off by the canvas itself — which is
   * exactly what a drag onto the next page has to survive.
   */
  const moveDelta = draft?.kind === 'transform' && draft.transform.kind === 'translate' ? draft.transform : null;
  const previewStrokes = useMemo(
    () => (draft === null ? null : moveDelta ? selected : applyDraft(selected, idSet, draft)),
    [draft, moveDelta, selected, idSet],
  );
  const shown = previewStrokes ?? selected;
  const bounds = useMemo(() => selectionBounds(shown), [shown]);

  // Hide the originals while previewing; restore on unmount.
  const previewing = previewStrokes !== null;
  useEffect(() => {
    onPreviewHidden(previewing ? idSet : null);
  }, [previewing, idSet, onPreviewHidden]);
  useEffect(() => () => onPreviewHidden(null), [onPreviewHidden]);

  // Preview canvas (page-sized, zoom-aware like the ink layers).
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasRefs = useRef([canvasRef]).current;
  const sizeRef = useRef<CanvasSize>({ cssWidth: page.dimensions.width, cssHeight: page.dimensions.height, dpr: 1 });
  const previewRef = useRef<readonly Stroke[] | null>(null);
  previewRef.current = previewStrokes;
  const redraw = useCallback(() => {
    const ctx = get2dContext(canvasRef.current);
    if (!ctx) return;
    const { cssWidth, cssHeight } = sizeRef.current;
    clearSurface(ctx, cssWidth, cssHeight);
    const strokes = previewRef.current;
    if (!strokes) return;
    for (const stroke of strokes) drawStroke(ctx, stroke);
  }, []);
  usePageCanvas({ canvasRefs, pageWidth: page.dimensions.width, pageHeight: page.dimensions.height, zoom, sizeRef, onResize: redraw });
  useLayoutEffect(redraw, [previewStrokes, redraw]);

  const pagePoint = useCallback(
    (clientX: number, clientY: number): Point => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
    },
    [zoom],
  );

  const begin = useCallback(
    (e: ReactPointerEvent<HTMLElement>, mode: Drag['mode'], handle?: ScaleHandle) => {
      if (e.button !== 0 || !bounds) return;
      e.preventDefault();
      dragRef.current = { mode, pointerId: e.pointerId, start: { x: e.clientX, y: e.clientY }, bounds, ...(handle ? { handle } : {}) };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer */
      }
    },
    [bounds],
  );

  const onDragMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      // Only a press that actually moves counts as a drag: a tap on the box
      // must not flicker the handles and the toolbar away.
      setDragging(true);
      if (drag.mode === 'move') {
        const dx = (e.clientX - drag.start.x) / zoom;
        const dy = (e.clientY - drag.start.y) / zoom;
        setDraft({ kind: 'transform', transform: { kind: 'translate', dx, dy } });
      } else if (drag.handle) {
        setDraft({ kind: 'transform', transform: scaleFromHandle(drag.bounds, drag.handle, pagePoint(e.clientX, e.clientY), e.shiftKey) });
      }
    },
    [zoom, pagePoint, setDraft],
  );

  const onDragEnd = useCallback(
    (e: ReactPointerEvent<HTMLElement>, commit: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      setDragging(false);
      const current = draftRef.current;
      setDraft(null);
      if (!commit || current?.kind !== 'transform' || isIdentity(current.transform)) return;

      // Dropped over a different sheet: the strokes leave this page's store for
      // that one, offset so they stay exactly where the pointer left them.
      if (drag.mode === 'move' && current.transform.kind === 'translate') {
        const rects = mountedPageRects();
        const source = rects.find((r) => r.pageId === page.id);
        const target = pageAtViewportPoint(rects, e.clientX, e.clientY);
        if (source && target && target.pageId !== page.id) {
          const offset = pageHandoffOffset(source, target, zoom);
          moveSelectionToPage(page.id, target.pageId, strokeIds, {
            kind: 'translate',
            dx: current.transform.dx + offset.x,
            dy: current.transform.dy + offset.y,
          });
          return;
        }
      }
      transformSelection(page.id, strokeIds, current.transform);
    },
    [page.id, strokeIds, zoom, transformSelection, moveSelectionToPage, setDraft],
  );

  // Width slider: preview while dragging, one undo step on release.
  const [sizeValue, setSizeValue] = useState(() => dominantSize(selected));
  useEffect(() => {
    if (draftRef.current?.kind !== 'size') setSizeValue(dominantSize(selected));
  }, [selected]);
  const onSizeInput = useCallback(
    (size: number) => {
      setSizeValue(size);
      setDraft({ kind: 'size', size });
    },
    [setDraft],
  );
  // The toolbar is wider than a phone; centring it on the box is only a start.
  const { ref: toolbarRef, shift: toolbarShift } = useViewportShift<HTMLDivElement>(!dragging);
  const commitSize = useCallback(() => {
    const current = draftRef.current;
    if (current?.kind !== 'size') return;
    setDraft(null);
    restyleSelection(page.id, strokeIds, { size: current.size });
  }, [page.id, strokeIds, restyleSelection, setDraft]);

  // Curve editing. A committed line or curve still carries everything it was
  // drawn from — its ends, its signed depth, its cycle count — so the toolbar
  // can take it apart and rebuild it instead of deforming the points it left
  // behind. `null` when the selection holds no line or curve at all.
  const curve = useMemo(() => selectionCurveParams(selected), [selected]);
  const applyCurve = useCallback(
    (edit: CurveEdit) => {
      setDraft(null);
      reshapeSelection(page.id, strokeIds, edit);
    },
    [page.id, strokeIds, reshapeSelection, setDraft],
  );
  // Depth is a slider, so it behaves like the width one: previewed on the
  // private canvas as it moves, and pushed onto the undo stack once, on release.
  const [depthValue, setDepthValue] = useState(() => curve?.amplitudeRatio ?? MIN_CURVE_AMPLITUDE);
  useEffect(() => {
    if (draftRef.current?.kind !== 'curve' && curve) setDepthValue(curve.amplitudeRatio);
  }, [curve]);
  const onDepthInput = useCallback(
    (amplitudeRatio: number) => {
      setDepthValue(amplitudeRatio);
      setDraft({ kind: 'curve', edit: { amplitudeRatio } });
    },
    [setDraft],
  );
  const commitDepth = useCallback(() => {
    const current = draftRef.current;
    if (current?.kind !== 'curve') return;
    setDraft(null);
    reshapeSelection(page.id, strokeIds, current.edit);
  }, [page.id, strokeIds, reshapeSelection, setDraft]);

  if (!bounds || selected.length === 0) return null;

  const box = {
    left: bounds.minX - BOX_MARGIN,
    top: bounds.minY - BOX_MARGIN,
    width: bounds.maxX - bounds.minX + BOX_MARGIN * 2,
    height: bounds.maxY - bounds.minY + BOX_MARGIN * 2,
  };
  // Touch wants a bigger target than a mouse, and the handles are drawn in page
  // units, so the on-screen size has to be divided back out of the zoom.
  const handleSize = 14 / zoom;
  // Toolbar above the box, or below it when that would leave the page. It is
  // centred on the box and then nudged by `toolbarShift`, measured against the
  // real viewport — a page edge says nothing about where the screen ends.
  const toolbarBelow = box.top - (TOOLBAR_GAP + TOOLBAR_HEIGHT) / zoom < 0;
  const toolbarX = box.left + box.width / 2;
  /** Corners sit on their corner; an edge handle sits at the middle of it. */
  const handlePoint = (h: ScaleHandle): Point => ({
    x: h.includes('w') ? box.left : h.includes('e') ? box.left + box.width : box.left + box.width / 2,
    y: h.includes('n') ? box.top : h.includes('s') ? box.top + box.height : box.top + box.height / 2,
  });
  const dragHandlers = {
    onPointerMove: onDragMove,
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => onDragEnd(e, true),
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => onDragEnd(e, false),
  };
  const handleStyle = (h: ScaleHandle): CSSProperties => {
    const p = handlePoint(h);
    return {
      position: 'absolute',
      left: p.x - handleSize / 2,
      top: p.y - handleSize / 2,
      width: handleSize,
      height: handleSize,
      background: '#fff',
      border: `${1.5 / zoom}px solid #2563eb`,
      borderRadius: 2 / zoom,
      cursor: HANDLE_CURSORS[h],
      boxSizing: 'border-box',
      touchAction: 'none',
      pointerEvents: 'auto',
    };
  };
  const toolbarButton =
    'inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-white hover:bg-white/15 ' +
    'focus-visible:outline-2 focus-visible:outline-blue-300 disabled:opacity-40';
  const curvePattern: StrokePattern = selected.find((s) => s.kind === 'geometric')?.style.pattern ?? 'solid';

  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-selection-layer={page.id}
      data-selection-dragging={dragging ? 'true' : undefined}
      style={{
        zIndex: 25,
        ...(moveDelta ? { transform: `translate(${moveDelta.dx * zoom}px, ${moveDelta.dy * zoom}px)` } : {}),
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute left-0 top-0"
        style={{ pointerEvents: 'none', display: previewing ? 'block' : 'none' }}
        aria-hidden="true"
        data-selection-preview
      />
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: page.dimensions.width,
          height: page.dimensions.height,
          transform: `scale(${zoom})`,
          transformOrigin: '0 0',
          pointerEvents: 'none',
        }}
      >
        <div
          role="group"
          aria-label={`Selection of ${selected.length} stroke${selected.length === 1 ? '' : 's'}`}
          data-selection-box
          data-selection-count={selected.length}
          style={{
            position: 'absolute',
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            border: `${1.5 / zoom}px dashed rgba(37, 99, 235, 0.9)`,
            background: 'rgba(37, 99, 235, 0.04)',
            boxSizing: 'border-box',
            cursor: 'move',
            touchAction: 'none',
            pointerEvents: 'auto',
          }}
          onPointerDown={(e) => begin(e, 'move')}
          {...dragHandlers}
          onContextMenu={(e) => e.preventDefault()}
        />
        {!dragging &&
          SCALE_HANDLES.map((h) => (
            <div
              key={h}
              role="presentation"
              data-selection-handle={h}
              style={handleStyle(h)}
              onPointerDown={(e) => begin(e, 'scale', h)}
              {...dragHandlers}
            />
          ))}
        <div
          ref={toolbarRef}
          role="toolbar"
          aria-label="Selection actions"
          data-selection-toolbar
          data-selection-toolbar-placement={toolbarBelow ? 'below' : 'above'}
          hidden={dragging}
          style={{
            position: 'absolute',
            left: toolbarX,
            top: toolbarBelow ? box.top + box.height + TOOLBAR_GAP / zoom : box.top - TOOLBAR_GAP / zoom,
            // The inverse scale keeps the toolbar a constant size on screen, so
            // its own box is already in screen px — but the shift is applied
            // before it, in page units, hence dividing it back out.
            transform: `translate(calc(-50% + ${toolbarShift / zoom}px), ${toolbarBelow ? '0' : '-100%'}) scale(${1 / zoom})`,
            transformOrigin: toolbarBelow ? 'top center' : 'bottom center',
            maxWidth: 'calc(100vw - 1rem)',
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
          className="flex flex-wrap items-center justify-center gap-1 rounded-lg bg-zinc-900/90 p-1 shadow-lg backdrop-blur"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className={toolbarButton}
            onClick={() => duplicateSelection(page.id, strokeIds)}
            title="Duplicate selection"
            aria-label="Duplicate selection"
          >
            Duplicate
          </button>
          <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
          <div className="flex items-center gap-0.5" role="group" aria-label="Stroke colour">
            {SWATCHES.map((color) => (
              <button
                key={color}
                type="button"
                className="h-5 w-5 rounded-full ring-1 ring-white/40 hover:ring-white focus-visible:outline-2 focus-visible:outline-blue-300"
                style={{ background: color }}
                onClick={() => restyleSelection(page.id, strokeIds, { color })}
                title={`Recolour ${color}`}
                aria-label={`Recolour ${color}`}
              />
            ))}
            <input
              type="color"
              className="h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
              aria-label="Custom stroke colour"
              defaultValue={selected[0]?.style.color.length === 7 ? selected[0].style.color : '#000000'}
              onChange={(e) => restyleSelection(page.id, strokeIds, { color: e.target.value })}
            />
          </div>
          <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
          <label className="flex items-center gap-1 text-xs text-white/90">
            <span>Width</span>
            <input
              type="range"
              min={MIN_STROKE_SIZE}
              max={MAX_STROKE_SIZE}
              step={0.5}
              value={sizeValue}
              aria-label="Stroke width"
              className="h-1 w-20 accent-blue-400"
              onChange={(e) => onSizeInput(Number(e.target.value))}
              onPointerUp={commitSize}
              onKeyUp={commitSize}
              onBlur={commitSize}
            />
            <span className="w-6 tabular-nums" data-selection-width>
              {sizeValue}
            </span>
          </label>
          {curve && (
            <>
              <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
              <div
                className="flex flex-wrap items-center justify-center gap-1"
                role="group"
                aria-label="Curve shape"
                data-selection-curve={curve.curve}
              >
                {CURVE_KINDS.map((kind) => (
                  <button
                    key={kind.id}
                    type="button"
                    className={`${toolbarButton} ${curve.curve === kind.id ? 'bg-blue-500 hover:bg-blue-500' : ''}`}
                    aria-pressed={curve.curve === kind.id}
                    data-selection-curve-kind={kind.id}
                    title={`Rebuild as ${kind.label.toLowerCase()}`}
                    onClick={() => applyCurve({ curve: kind.id })}
                  >
                    {kind.label}
                  </button>
                ))}
                <select
                  className="h-6 rounded-md border border-white/25 bg-zinc-800 px-1 text-xs text-white"
                  aria-label="Line pattern"
                  value={curvePattern}
                  data-selection-curve-pattern
                  onChange={(e) => restyleSelection(page.id, strokeIds, { pattern: e.target.value as StrokePattern })}
                >
                  {STROKE_PATTERNS.map((pattern) => (
                    <option key={pattern.id} value={pattern.id}>
                      {pattern.label}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-xs text-white/90">
                  <span>Depth</span>
                  <input
                    type="range"
                    min={MIN_CURVE_AMPLITUDE}
                    max={MAX_CURVE_AMPLITUDE}
                    step={0.01}
                    value={depthValue}
                    disabled={curve.curve === 'straight'}
                    aria-label="Curve depth"
                    className="h-1 w-16 accent-blue-400 disabled:opacity-40"
                    data-selection-curve-depth
                    onChange={(e) => onDepthInput(Number(e.target.value))}
                    onPointerUp={commitDepth}
                    onKeyUp={commitDepth}
                    onBlur={commitDepth}
                  />
                </label>
                <button
                  type="button"
                  className={toolbarButton}
                  disabled={curve.curve === 'straight'}
                  aria-pressed={curve.flip}
                  data-selection-curve-flip={curve.flip ? 'true' : undefined}
                  title="Mirror the curve"
                  aria-label="Mirror the curve"
                  onClick={() => applyCurve({ flip: !curve.flip })}
                >
                  Flip
                </button>
                <label className="flex items-center gap-1 text-xs text-white/90">
                  <span>Cycles</span>
                  <input
                    type="number"
                    min={MIN_CURVE_CYCLES}
                    max={MAX_CURVE_CYCLES}
                    step={1}
                    value={curve.cycles}
                    disabled={curve.curve !== 'wave' && curve.curve !== 'zigzag'}
                    aria-label="Curve cycles"
                    className="h-6 w-12 rounded-md border border-white/25 bg-zinc-800 px-1 text-xs text-white disabled:opacity-40"
                    data-selection-curve-cycles
                    onChange={(e) => {
                      const value = Math.round(Number(e.target.value));
                      if (!Number.isFinite(value)) return;
                      applyCurve({ cycles: Math.min(MAX_CURVE_CYCLES, Math.max(MIN_CURVE_CYCLES, value)) });
                    }}
                  />
                </label>
              </div>
            </>
          )}
          <span className="mx-0.5 h-5 w-px bg-white/20" aria-hidden="true" />
          <button
            type="button"
            className={`${toolbarButton} text-rose-200`}
            onClick={() => deleteSelection(page.id, strokeIds)}
            title="Delete selection"
            aria-label="Delete selection"
          >
            Delete
          </button>
          <button type="button" className={toolbarButton} onClick={clearLassoSelection} title="Deselect" aria-label="Deselect">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
});
