import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { DEFAULT_TOOL_SETTINGS, MAX_HISTORY_DEPTH } from './constants';
import { drawStroke, get2dContext, replayStrokes } from './engine/renderer';
import { useHiDpiCanvas } from './hooks/useHiDpiCanvas';
import { useHistory } from './hooks/useHistory';
import { useLatestRef } from './hooks/useLatestRef';
import { usePointerInk } from './hooks/usePointerInk';
import { useUndoRedoShortcuts } from './hooks/useUndoRedoShortcuts';
import styles from './InkingCanvas.module.css';
import { DebugOverlay } from '../debug/DebugOverlay';
import { ToolPalette } from './palette/ToolPalette';
import type { CanvasSize, InkingCanvasHandle, InkingCanvasProps, Stroke, ToolSettings } from './types';

const EMPTY_STROKES: readonly Stroke[] = [];

/** True when `next` is `prev` with zero or more strokes appended. */
function isAppendOnly(prev: readonly Stroke[], next: readonly Stroke[]): boolean {
  if (prev.length > next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}

/**
 * Full-surface inking canvas tuned for 2-in-1 pen/touch devices.
 *
 * Two stacked canvases: `committed` holds every finished stroke and is only
 * redrawn when history changes (append-only changes are drawn incrementally);
 * `live` shows the stroke in progress and is repainted once per animation
 * frame from coalesced pointer samples.
 */
export const InkingCanvas = forwardRef<InkingCanvasHandle, InkingCanvasProps>(function InkingCanvas(
  {
    initialStrokes = EMPTY_STROKES,
    onStrokesChange,
    initialSettings,
    showToolbar = true,
    allowMouse = true,
    background = '#ffffff',
    maxHistory = MAX_HISTORY_DEPTH,
    className,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const canvasRefs = useRef([committedRef, liveRef]).current;
  const sizeRef = useRef<CanvasSize>({ cssWidth: 0, cssHeight: 0, dpr: 1 });

  const [settings, setSettings] = useState<ToolSettings>(() => ({
    ...DEFAULT_TOOL_SETTINGS,
    ...initialSettings,
  }));
  const settingsRef = useLatestRef(settings);
  const updateSettings = useCallback((patch: Partial<ToolSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const history = useHistory(initialStrokes, maxHistory);
  const strokesRef = useLatestRef(history.strokes);
  const hiddenIdsRef = useRef<Set<string>>(new Set());
  /** The stroke list the committed layer currently displays. */
  const renderedRef = useRef<readonly Stroke[]>(EMPTY_STROKES);

  const redrawCommitted = useCallback(() => {
    const ctx = get2dContext(committedRef.current);
    if (!ctx) return;
    const { cssWidth, cssHeight } = sizeRef.current;
    replayStrokes(ctx, strokesRef.current, cssWidth, cssHeight, hiddenIdsRef.current);
    renderedRef.current = strokesRef.current;
  }, [strokesRef]);

  useHiDpiCanvas({ containerRef, canvasRefs, sizeRef, onResize: redrawCommitted });

  // Keep the committed layer in sync with history. Appends (the hot path after
  // every stroke) draw just the new strokes; anything else replays.
  useLayoutEffect(() => {
    const next = history.strokes;
    const prev = renderedRef.current;
    if (prev === next) return;
    const ctx = get2dContext(committedRef.current);
    if (!ctx) return;
    if (hiddenIdsRef.current.size === 0 && isAppendOnly(prev, next)) {
      for (let i = prev.length; i < next.length; i++) {
        const stroke = next[i];
        if (stroke) drawStroke(ctx, stroke);
      }
      renderedRef.current = next;
    } else {
      redrawCommitted();
    }
  }, [history.strokes, redrawCommitted]);

  const pointerHandlers = usePointerInk({
    liveCanvasRef: liveRef,
    committedCanvasRef: committedRef,
    sizeRef,
    settingsRef,
    strokesRef,
    hiddenIdsRef,
    allowMouse,
    onCommitStroke: history.addStroke,
    onEraseStrokes: history.removeStrokes,
    redrawCommitted,
  });

  useUndoRedoShortcuts(history.undo, history.redo);

  // Notify after commits (not on mount).
  const onStrokesChangeRef = useLatestRef(onStrokesChange);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    onStrokesChangeRef.current?.(history.strokes);
  }, [history.strokes, onStrokesChangeRef]);

  useImperativeHandle(
    ref,
    (): InkingCanvasHandle => ({
      undo: history.undo,
      redo: history.redo,
      clear: history.clear,
      getStrokes: () => strokesRef.current,
      toDataURL: (type = 'image/png', quality?: number) => {
        const committed = committedRef.current;
        if (!committed || committed.width === 0 || committed.height === 0) return '';
        const out = document.createElement('canvas');
        out.width = committed.width;
        out.height = committed.height;
        const ctx = out.getContext('2d');
        if (!ctx) return '';
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(committed, 0, 0);
        return out.toDataURL(type, quality);
      },
    }),
    [history.undo, history.redo, history.clear, strokesRef, background],
  );

  const rootClassName = className ? `${styles.root} ${className}` : styles.root;

  return (
    <div ref={containerRef} className={rootClassName} style={{ background }} data-tool={settings.tool}>
      <canvas ref={committedRef} className={`${styles.layer} ${styles.committed}`} aria-hidden="true" />
      <canvas
        ref={liveRef}
        className={`${styles.layer} ${styles.live}`}
        role="img"
        aria-label="Drawing surface"
        onContextMenu={(e) => e.preventDefault()}
        {...pointerHandlers}
      />
      {showToolbar && (
        <ToolPalette
          settings={settings}
          onSettingsChange={updateSettings}
          onClear={history.clear}
          containerRef={containerRef}
          history={{ canUndo: history.canUndo, canRedo: history.canRedo, onUndo: history.undo, onRedo: history.redo }}
        />
      )}
      <DebugOverlay enabled={settings.debugMode} />
    </div>
  );
});
