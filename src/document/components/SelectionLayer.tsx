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
import { COLOR_PALETTE, MAX_STROKE_SIZE, MIN_STROKE_SIZE } from '../../inking/constants';
import { subscribeTouchGesture } from '../../inking/engine/gestureState';
import {
  SCALE_HANDLES,
  restyleStrokes,
  scaleFromHandle,
  selectionBounds,
  transformStroke,
  type ScaleHandle,
  type StrokeTransform,
} from '../../inking/engine/lasso';
import { clearSurface, drawStroke, get2dContext } from '../../inking/engine/renderer';
import { usePageCanvas } from '../../inking/hooks/usePageCanvas';
import type { BBox, CanvasSize, Point, Stroke } from '../../inking/types';
import { useDocumentStore } from '../store';
import type { Page } from '../types';

export interface SelectionLayerProps {
  page: Page;
  zoom: number;
  /** Ids of the selected strokes (all on `page`). */
  strokeIds: readonly string[];
  /** Strokes whose committed rendering must be hidden while this layer previews them; `null` when none. */
  onPreviewHidden: (ids: ReadonlySet<string> | null) => void;
}

/** An uncommitted edit shown on the preview canvas. */
type Draft = { readonly kind: 'transform'; readonly transform: StrokeTransform } | { readonly kind: 'size'; readonly size: number };

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
};

/** Breathing room between the strokes' padded bounds and the dashed box, page units. */
const BOX_MARGIN = 6;
const TOOLBAR_GAP = 12;
/** Approximate toolbar footprint, CSS px, used to keep it inside the page. */
const TOOLBAR_WIDTH = 560;
const TOOLBAR_HEIGHT = 40;
const SWATCHES = COLOR_PALETTE.slice(0, 6);

function isIdentity(t: StrokeTransform): boolean {
  return t.kind === 'translate' ? t.dx === 0 && t.dy === 0 : t.sx === 1 && t.sy === 1;
}

function applyDraft(selected: readonly Stroke[], ids: ReadonlySet<string>, draft: Draft): Stroke[] {
  if (draft.kind === 'transform') return selected.map((s) => transformStroke(s, draft.transform));
  return restyleStrokes(selected, ids, { size: draft.size });
}

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
export const SelectionLayer = memo(function SelectionLayer({ page, zoom, strokeIds, onPreviewHidden }: SelectionLayerProps) {
  const { clearLassoSelection, transformSelection, restyleSelection, duplicateSelection, deleteSelection } = useDocumentStore(
    useShallow((s) => ({
      clearLassoSelection: s.clearLassoSelection,
      transformSelection: s.transformSelection,
      restyleSelection: s.restyleSelection,
      duplicateSelection: s.duplicateSelection,
      deleteSelection: s.deleteSelection,
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
  const containerRef = useRef<HTMLDivElement>(null);

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
        setDraft(null);
      }),
    [setDraft],
  );

  const previewStrokes = useMemo(() => (draft ? applyDraft(selected, idSet, draft) : null), [draft, selected, idSet]);
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
      const current = draftRef.current;
      if (commit && current?.kind === 'transform' && !isIdentity(current.transform)) {
        transformSelection(page.id, strokeIds, current.transform);
      }
      setDraft(null);
    },
    [page.id, strokeIds, transformSelection, setDraft],
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
  const commitSize = useCallback(() => {
    const current = draftRef.current;
    if (current?.kind !== 'size') return;
    setDraft(null);
    restyleSelection(page.id, strokeIds, { size: current.size });
  }, [page.id, strokeIds, restyleSelection, setDraft]);

  if (!bounds || selected.length === 0) return null;

  const box = {
    left: bounds.minX - BOX_MARGIN,
    top: bounds.minY - BOX_MARGIN,
    width: bounds.maxX - bounds.minX + BOX_MARGIN * 2,
    height: bounds.maxY - bounds.minY + BOX_MARGIN * 2,
  };
  const handleSize = 12 / zoom;
  // Toolbar above the box, or below it when that would leave the page; centred, but kept inside the page edges.
  const toolbarBelow = box.top - (TOOLBAR_GAP + TOOLBAR_HEIGHT) / zoom < 0;
  const toolbarHalf = TOOLBAR_WIDTH / 2 / zoom;
  const toolbarX = Math.min(Math.max(box.left + box.width / 2, toolbarHalf), Math.max(toolbarHalf, page.dimensions.width - toolbarHalf));
  const handlePoint = (h: ScaleHandle): Point => ({
    x: h.includes('w') ? box.left : box.left + box.width,
    y: h.includes('n') ? box.top : box.top + box.height,
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
    'inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-white hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-blue-300';

  return (
    <div className="pointer-events-none absolute inset-0" data-selection-layer={page.id} style={{ zIndex: 25 }}>
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
        {SCALE_HANDLES.map((h) => (
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
          role="toolbar"
          aria-label="Selection actions"
          data-selection-toolbar
          data-selection-toolbar-placement={toolbarBelow ? 'below' : 'above'}
          style={{
            position: 'absolute',
            left: toolbarX,
            top: toolbarBelow ? box.top + box.height + TOOLBAR_GAP / zoom : box.top - TOOLBAR_GAP / zoom,
            transform: `translate(-50%, ${toolbarBelow ? '0' : '-100%'}) scale(${1 / zoom})`,
            transformOrigin: toolbarBelow ? 'top center' : 'bottom center',
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
          className="flex items-center gap-1 rounded-lg bg-zinc-900/90 p-1 shadow-lg backdrop-blur"
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
