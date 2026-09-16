import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { strokeHitBySegment } from '../engine/hitTest';
import {
  isPointerAccepted,
  normalizePointerType,
  normalizePressure,
  resolveEffectiveTool,
} from '../engine/pointerPolicy';
import {
  clearSurface,
  drawEraserCursor,
  drawLiveStroke,
  get2dContext,
} from '../engine/renderer';
import { StrokeBuilder } from '../engine/strokeBuilder';
import { strokeEraserRadius, styleForTool } from '../engine/toolStyles';
import type { CanvasSize, InkPoint, InkPointerType, Stroke, ToolSettings } from '../types';
import { useLatestRef } from './useLatestRef';

export interface UsePointerInkOptions {
  liveCanvasRef: RefObject<HTMLCanvasElement | null>;
  committedCanvasRef: RefObject<HTMLCanvasElement | null>;
  sizeRef: RefObject<CanvasSize>;
  settingsRef: RefObject<ToolSettings>;
  /** Latest committed strokes, for stroke-eraser hit testing. */
  strokesRef: RefObject<readonly Stroke[]>;
  /** Strokes temporarily hidden while the stroke eraser drags over them. */
  hiddenIdsRef: RefObject<Set<string>>;
  allowMouse: boolean;
  onCommitStroke: (stroke: Stroke) => void;
  onEraseStrokes: (ids: ReadonlySet<string>) => void;
  /** Full replay of the committed layer (honours `hiddenIdsRef`). */
  redrawCommitted: () => void;
}

type CanvasPointerHandler = (e: ReactPointerEvent<HTMLCanvasElement>) => void;

export interface PointerInkHandlers {
  onPointerDown: CanvasPointerHandler;
  onPointerMove: CanvasPointerHandler;
  onPointerUp: CanvasPointerHandler;
  onPointerCancel: CanvasPointerHandler;
  onPointerEnter: CanvasPointerHandler;
  onPointerLeave: CanvasPointerHandler;
  onLostPointerCapture: CanvasPointerHandler;
}

interface InkSession {
  readonly kind: 'ink';
  readonly pointerId: number;
  readonly pointerType: InkPointerType;
  readonly builder: StrokeBuilder;
  readonly rect: DOMRect;
}

interface EraseSession {
  readonly kind: 'erase';
  readonly pointerId: number;
  readonly pointerType: InkPointerType;
  readonly radius: number;
  readonly hits: Set<string>;
  readonly rect: DOMRect;
  last: InkPoint;
}

type Session = InkSession | EraseSession;

interface PenState {
  inProximity: boolean;
  lastSeen: number;
}

function toInkPoint(e: PointerEvent, rect: DOMRect): InkPoint {
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    pressure: normalizePressure(e.pressure),
  };
}

/**
 * Expand a pointermove into the high-frequency samples the browser coalesced
 * into it (pens commonly report at 240 Hz while events fire per frame).
 */
function expandSamples(e: PointerEvent): PointerEvent[] {
  if (typeof e.getCoalescedEvents === 'function') {
    const coalesced = e.getCoalescedEvents();
    if (coalesced.length > 0) return coalesced;
  }
  return [e];
}

/**
 * Pointer-event state machine for the canvas: palm rejection, pointer capture,
 * coalesced sampling, rAF-batched rendering of the live stroke, and hand-off of
 * finished strokes / erasures to the history layer.
 *
 * All configuration is read through refs so the returned handlers are created
 * once and never go stale.
 */
export function usePointerInk(options: UsePointerInkOptions): PointerInkHandlers {
  const optionsRef = useLatestRef(options);
  const sessionRef = useRef<Session | null>(null);
  const frameRef = useRef(0);
  const penRef = useRef<PenState>({ inProximity: false, lastSeen: Number.NEGATIVE_INFINITY });

  const handlers = useMemo<PointerInkHandlers>(() => {
    const liveContext = (): CanvasRenderingContext2D | null =>
      get2dContext(optionsRef.current.liveCanvasRef.current);
    const committedContext = (): CanvasRenderingContext2D | null =>
      get2dContext(optionsRef.current.committedCanvasRef.current);

    const clearLive = (): void => {
      const ctx = liveContext();
      if (!ctx) return;
      const { cssWidth, cssHeight } = optionsRef.current.sizeRef.current;
      clearSurface(ctx, cssWidth, cssHeight);
    };

    /**
     * The live layer is a separate canvas composited over the committed one, so
     * a highlighter preview must blend through CSS to look like the final
     * `multiply` fill will.
     */
    const setLiveBlend = (mode: 'normal' | 'multiply'): void => {
      const canvas = optionsRef.current.liveCanvasRef.current;
      if (canvas) canvas.style.mixBlendMode = mode;
    };

    const releaseCapture = (pointerId: number): void => {
      const canvas = optionsRef.current.liveCanvasRef.current;
      if (!canvas) return;
      try {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      } catch {
        /* pointer already gone */
      }
    };

    const cancelFrame = (): void => {
      if (frameRef.current !== 0) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };

    const renderFrame = (): void => {
      frameRef.current = 0;
      const session = sessionRef.current;
      const live = liveContext();
      if (!live) return;
      const { cssWidth, cssHeight } = optionsRef.current.sizeRef.current;
      clearSurface(live, cssWidth, cssHeight);
      if (!session) return;

      if (session.kind === 'erase') {
        drawEraserCursor(live, session.last.x, session.last.y, session.radius);
        return;
      }

      const { builder } = session;
      if (builder.tool === 'eraser-pixel') {
        // destination-out on a transparent preview layer is invisible, so the
        // pixel eraser paints straight onto the committed layer. Re-applying
        // the same outline on commit is idempotent, and a cancel triggers a
        // full replay.
        const committed = committedContext();
        if (committed) drawLiveStroke(committed, builder.points, builder.style);
        const last = builder.last;
        if (last) drawEraserCursor(live, last.x, last.y, builder.style.size / 2);
        return;
      }

      drawLiveStroke(live, builder.points, builder.style);
    };

    const scheduleFrame = (): void => {
      if (frameRef.current === 0) frameRef.current = requestAnimationFrame(renderFrame);
    };

    /** Hit-test one eraser sweep; returns true when new strokes were hidden. */
    const eraseSweep = (session: EraseSession, from: InkPoint, to: InkPoint): boolean => {
      const { strokesRef, hiddenIdsRef } = optionsRef.current;
      const hidden = hiddenIdsRef.current;
      let dirty = false;
      for (const stroke of strokesRef.current) {
        if (session.hits.has(stroke.id)) continue;
        if (strokeHitBySegment(stroke, from.x, from.y, to.x, to.y, session.radius)) {
          session.hits.add(stroke.id);
          hidden.add(stroke.id);
          dirty = true;
        }
      }
      return dirty;
    };

    const finishSession = (): void => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      cancelFrame();
      releaseCapture(session.pointerId);

      const opts = optionsRef.current;
      if (session.kind === 'ink') {
        opts.onCommitStroke(session.builder.build());
      } else {
        opts.hiddenIdsRef.current.clear();
        if (session.hits.size > 0) opts.onEraseStrokes(session.hits);
      }
      clearLive();
      setLiveBlend('normal');
    };

    const cancelSession = (): void => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      cancelFrame();
      releaseCapture(session.pointerId);

      const opts = optionsRef.current;
      let needsRedraw = false;
      if (session.kind === 'ink') {
        needsRedraw = session.builder.tool === 'eraser-pixel';
      } else {
        needsRedraw = session.hits.size > 0;
        opts.hiddenIdsRef.current.clear();
      }
      if (needsRedraw) opts.redrawCommitted();
      clearLive();
      setLiveBlend('normal');
    };

    /**
     * Record pen presence. A pen arriving while a finger is drawing means the
     * finger was almost certainly a palm, so that stroke is discarded.
     */
    const notePen = (pointerType: InkPointerType): void => {
      if (pointerType !== 'pen') return;
      penRef.current.inProximity = true;
      penRef.current.lastSeen = performance.now();
      const session = sessionRef.current;
      if (session && session.pointerType === 'touch') cancelSession();
    };

    const onPointerDown: CanvasPointerHandler = (e) => {
      const pointerType = normalizePointerType(e.pointerType);
      notePen(pointerType);

      const opts = optionsRef.current;
      const settings = opts.settingsRef.current;
      const pen = penRef.current;
      const accepted = isPointerAccepted({
        pointerType,
        touchDraw: settings.touchDraw,
        allowMouse: opts.allowMouse,
        penInProximity: pen.inProximity,
        msSincePen: performance.now() - pen.lastSeen,
      });
      if (!accepted) return;

      if (sessionRef.current) {
        // Only one stroke at a time. A pen may pre-empt a touch stroke (palm);
        // anything else is a secondary pointer and is ignored.
        if (pointerType === 'pen' && sessionRef.current.pointerType === 'touch') cancelSession();
        else return;
      }

      const tool = resolveEffectiveTool(settings.tool, pointerType, e.button, e.buttons);
      if (tool === null) return;

      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported; strokes will end at the element edge */
      }

      const point = toInkPoint(e.nativeEvent, rect);
      if (tool === 'eraser-stroke') {
        const session: EraseSession = {
          kind: 'erase',
          pointerId: e.pointerId,
          pointerType,
          radius: strokeEraserRadius(settings),
          hits: new Set<string>(),
          rect,
          last: point,
        };
        sessionRef.current = session;
        if (eraseSweep(session, point, point)) opts.redrawCommitted();
      } else {
        const builder = new StrokeBuilder(tool, styleForTool(tool, settings, pointerType), pointerType);
        builder.add(point);
        sessionRef.current = { kind: 'ink', pointerId: e.pointerId, pointerType, builder, rect };
        setLiveBlend(tool === 'highlighter' ? 'multiply' : 'normal');
      }
      scheduleFrame();
    };

    const onPointerMove: CanvasPointerHandler = (e) => {
      const pointerType = normalizePointerType(e.pointerType);
      notePen(pointerType);

      const session = sessionRef.current;
      if (!session || session.pointerId !== e.pointerId) return;

      const samples = expandSamples(e.nativeEvent);
      if (session.kind === 'ink') {
        for (const sample of samples) session.builder.add(toInkPoint(sample, session.rect));
      } else {
        let dirty = false;
        for (const sample of samples) {
          const point = toInkPoint(sample, session.rect);
          if (eraseSweep(session, session.last, point)) dirty = true;
          session.last = point;
        }
        if (dirty) optionsRef.current.redrawCommitted();
      }
      scheduleFrame();
    };

    const onPointerUp: CanvasPointerHandler = (e) => {
      const session = sessionRef.current;
      if (session && session.pointerId === e.pointerId) finishSession();
    };

    const onPointerCancel: CanvasPointerHandler = (e) => {
      const session = sessionRef.current;
      if (session && session.pointerId === e.pointerId) cancelSession();
    };

    const onPointerEnter: CanvasPointerHandler = (e) => {
      notePen(normalizePointerType(e.pointerType));
    };

    const onPointerLeave: CanvasPointerHandler = (e) => {
      if (normalizePointerType(e.pointerType) !== 'pen') return;
      const pen = penRef.current;
      pen.inProximity = false;
      pen.lastSeen = performance.now();
    };

    const onLostPointerCapture: CanvasPointerHandler = (e) => {
      // Normally preceded by pointerup/cancel (session already closed). If the
      // browser yanked capture for another reason, keep what was drawn.
      const session = sessionRef.current;
      if (session && session.pointerId === e.pointerId) finishSession();
    };

    return {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerEnter,
      onPointerLeave,
      onLostPointerCapture,
    };
  }, [optionsRef]);

  // Drop any in-flight frame if the component unmounts mid-stroke.
  useEffect(
    () => () => {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      sessionRef.current = null;
    },
    [],
  );

  return handlers;
}
