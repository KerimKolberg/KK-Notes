import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { RenderProfiler } from '../debug/RenderProfiler';
import { eraserCursor } from './engine/cursor';
import { drawStroke, get2dContext, replayStrokes } from './engine/renderer';
import { useLatestRef } from './hooks/useLatestRef';
import { usePageCanvas } from './hooks/usePageCanvas';
import { usePointerInk } from './hooks/usePointerInk';
import styles from './InkingCanvas.module.css';
import type { CanvasSize, Point, Stroke, ToolSettings, ToolType } from './types';

export interface InkSurfaceProps {
  /** Page size in drawing units. */
  width: number;
  height: number;
  /** CSS pixels per drawing unit. */
  zoom: number;
  /** Committed strokes for this surface (immutable; append-only changes draw incrementally). */
  strokes: readonly Stroke[];
  /** Shared tool settings (read through a ref by the pointer pipeline). */
  settingsRef: RefObject<ToolSettings>;
  allowMouse?: boolean;
  /** When false, finger input never inks here even with Touch Draw on (locked documents). */
  allowTouch?: boolean;
  onCommitStroke: (stroke: Stroke) => void;
  onEraseStrokes: (ids: ReadonlySet<string>) => void;
  /** An accepted pointer began a stroke / erase / drag on this surface. */
  onInteractionStart?: () => void;
  /** Barrel button mapped to select was pressed: switch tools temporarily. */
  onBarrelSelect?: () => void;
  /** A pen button took the lasso while another tool is selected: switch to it and keep it. */
  onBorrowSelectionTool?: (tool: ToolType) => void;
  /** The pen touched down with its barrel button held: that press is a stroke, not a click. */
  onBarrelStroke?: () => void;
  /** While an eraser is active: how wide it is on screen, in CSS px, so the pointer can show it. */
  eraserDiameterPx?: number | null;
  /** The page's grid cell, in page units, for the shape tool's grid snapping. */
  gridSpacing?: number;
  /** The pen's barrel button went down or came up, contact or not. */
  onBarrelButton?: (pressed: boolean) => void;
  /** The barrel gesture must be abandoned (pen out of range, gesture taken over). */
  onBarrelCancel?: () => void;
  /** Lasso tool: a loop is starting / was closed (polygon in page units). */
  onLassoStart?: () => void;
  onLassoComplete?: (polygon: readonly Point[]) => void;
  /** Strokes to leave out of the committed layer (a selection being dragged draws them elsewhere). */
  hiddenStrokeIds?: ReadonlySet<string> | null;
  currentTool: ToolSettings['tool'];
  /** When false the surface ignores pointer input (e.g. the select tool is active). Default true. */
  interactive?: boolean;
  ariaLabel?: string;
}

const EMPTY: readonly Stroke[] = [];

/** True when `next` is `prev` with zero or more strokes appended. */
function isAppendOnly(prev: readonly Stroke[], next: readonly Stroke[]): boolean {
  if (prev.length > next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

/**
 * A transparent, page-sized inking surface: committed + live canvas layers
 * driven by the shared pointer pipeline. Owns no history — strokes come in
 * as props and leave through `onCommitStroke` / `onEraseStrokes`, so a
 * document store can host any number of these.
 */
export const InkSurface = memo(function InkSurface({
  width,
  height,
  zoom,
  strokes,
  settingsRef,
  allowMouse = true,
  allowTouch = true,
  onCommitStroke,
  onEraseStrokes,
  onInteractionStart,
  onBarrelSelect,
  onBorrowSelectionTool,
  onBarrelStroke,
  eraserDiameterPx = null,
  onBarrelButton,
  onBarrelCancel,
  onLassoStart,
  onLassoComplete,
  gridSpacing,
  hiddenStrokeIds = null,
  currentTool,
  interactive = true,
  ariaLabel = 'Drawing surface',
}: InkSurfaceProps) {
  const committedRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const canvasRefs = useRef([committedRef, liveRef]).current;
  const sizeRef = useRef<CanvasSize>({ cssWidth: width, cssHeight: height, dpr: 1 });
  const zoomRef = useLatestRef(zoom);
  const strokesRef = useLatestRef(strokes);
  const hiddenIdsRef = useRef<Set<string>>(new Set());
  const renderedRef = useRef<readonly Stroke[]>(EMPTY);

  const redrawCommitted = useCallback(() => {
    const ctx = get2dContext(committedRef.current);
    if (!ctx) return;
    const { cssWidth, cssHeight } = sizeRef.current;
    replayStrokes(ctx, strokesRef.current, cssWidth, cssHeight, hiddenIdsRef.current);
    renderedRef.current = strokesRef.current;
  }, [strokesRef]);

  usePageCanvas({ canvasRefs, pageWidth: width, pageHeight: height, zoom, sizeRef, onResize: redrawCommitted });

  useLayoutEffect(() => {
    const prev = renderedRef.current;
    if (prev === strokes) return;
    const ctx = get2dContext(committedRef.current);
    if (!ctx) return;
    if (hiddenIdsRef.current.size === 0 && isAppendOnly(prev, strokes)) {
      for (let i = prev.length; i < strokes.length; i++) {
        const stroke = strokes[i];
        if (stroke) drawStroke(ctx, stroke);
      }
      renderedRef.current = strokes;
    } else {
      redrawCommitted();
    }
  }, [strokes, redrawCommitted]);

  // Externally hidden strokes (selection previews) share the eraser's hidden set.
  useEffect(() => {
    const hidden = hiddenIdsRef.current;
    const next = hiddenStrokeIds ?? new Set<string>();
    let same = hidden.size === next.size;
    if (same) for (const id of next) if (!hidden.has(id)) { same = false; break; }
    if (same) return;
    hidden.clear();
    for (const id of next) hidden.add(id);
    redrawCommitted();
  }, [hiddenStrokeIds, redrawCommitted]);

  const handlers = usePointerInk({
    liveCanvasRef: liveRef,
    committedCanvasRef: committedRef,
    sizeRef,
    settingsRef,
    strokesRef,
    hiddenIdsRef,
    allowMouse,
    allowTouch,
    contentScaleRef: zoomRef,
    ...(gridSpacing !== undefined ? { gridSpacing } : {}),
    ...(onInteractionStart ? { onInteractionStart } : {}),
    ...(onBarrelSelect ? { onBarrelSelect } : {}),
    ...(onBorrowSelectionTool ? { onBorrowSelectionTool } : {}),
    ...(onBarrelStroke ? { onBarrelStroke } : {}),
    ...(onBarrelButton ? { onBarrelButton } : {}),
    ...(onBarrelCancel ? { onBarrelCancel } : {}),
    ...(onLassoStart ? { onLassoStart } : {}),
    ...(onLassoComplete ? { onLassoComplete } : {}),
    onCommitStroke,
    onEraseStrokes,
    redrawCommitted,
  });

  // The eraser's ring as the system's own pointer, drawn where the pen is with no
  // frame of lag; `null` (no eraser, or one too big for a cursor) leaves the
  // stylesheet's pointer for the tool.
  const eraserPointer = useMemo(() => (eraserDiameterPx === null ? null : eraserCursor(eraserDiameterPx)), [eraserDiameterPx]);

  return (
    <RenderProfiler id="InkSurface">
      <div
        className={styles.surface}
        data-tool={currentTool}
        {...(gridSpacing !== undefined ? { 'data-grid-spacing': gridSpacing } : {})}
        data-layer="surface"
        style={{ pointerEvents: interactive ? 'auto' : 'none' }}
      >
        <canvas ref={committedRef} className={`${styles.layer} ${styles.committed}`} data-layer="committed" aria-hidden="true" />
        <canvas
          ref={liveRef}
          className={`${styles.layer} ${styles.live}`}
          data-layer="live"
          role="img"
          aria-label={ariaLabel}
          {...(eraserPointer ? { style: { cursor: eraserPointer } } : {})}
          onContextMenu={(e) => e.preventDefault()}
          {...handlers}
        />
      </div>
    </RenderProfiler>
  );
});
