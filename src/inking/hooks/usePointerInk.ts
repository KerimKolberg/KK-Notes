import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  ANGLE_SNAP_INCREMENT_DEG,
  HOLD_TO_SNAP_MS,
  MIN_SNAP_PATH_LENGTH_PX,
  SNAP_JITTER_PX,
} from '../constants';
import { buildLineHud, geometricSegments, type AngleArc } from '../engine/angleHud';
import { strokeHitBySegment } from '../engine/hitTest';
import {
  isBarrelPress,
  isPointerAccepted,
  normalizePointerType,
  normalizePressure,
  resolveEffectiveTool,
} from '../engine/pointerPolicy';
import {
  clearSurface,
  drawAngleHud,
  drawEraserCursor,
  drawLiveStroke,
  drawShape,
  get2dContext,
} from '../engine/renderer';
import { recognizeShape } from '../engine/shapeRecognition';
import { coordinatePlaneFromDrag, createGeometricStroke, lineFromDrag } from '../engine/shapes';
import { polylineLength } from '../engine/simplify';
import { StrokeBuilder } from '../engine/strokeBuilder';
import { strokeEraserRadius, styleForTool } from '../engine/toolStyles';
import type {
  CanvasSize,
  CoordinatePlaneConfig,
  InkPoint,
  InkPointerType,
  Point,
  Shape,
  ShapeTool,
  Stroke,
  StrokeStyle,
  ToolSettings,
} from '../types';
import { useLatestRef } from './useLatestRef';

export interface UsePointerInkOptions {
  liveCanvasRef: RefObject<HTMLCanvasElement | null>;
  committedCanvasRef: RefObject<HTMLCanvasElement | null>;
  sizeRef: RefObject<CanvasSize>;
  settingsRef: RefObject<ToolSettings>;
  /** Latest committed strokes, for stroke-eraser hit testing and the angle HUD. */
  strokesRef: RefObject<readonly Stroke[]>;
  /** Strokes temporarily hidden while the stroke eraser drags over them. */
  hiddenIdsRef: RefObject<Set<string>>;
  allowMouse: boolean;
  /**
   * CSS pixels per drawing unit (the page zoom). Pointer positions are divided
   * by this so strokes are stored in page-local units. Default 1.
   */
  contentScaleRef?: RefObject<number>;
  /** Fired when an accepted pointer starts any session (used to activate a page). */
  onInteractionStart?: () => void;
  /** The pen's barrel button is mapped to select mode and was pressed on the surface. */
  onBarrelSelect?: () => void;
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

/** Hold-to-snap bookkeeping for a freehand stroke. */
interface SnapState {
  /** Where the pointer came to rest. */
  anchor: Point;
  /** When it came to rest. */
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Recognised shape currently replacing the raw preview, if any. */
  shape: Shape | null;
  hud: readonly AngleArc[];
}

interface InkSession {
  readonly kind: 'ink';
  readonly pointerId: number;
  readonly pointerType: InkPointerType;
  readonly builder: StrokeBuilder;
  readonly rect: DOMRect;
  readonly scale: number;
  readonly snap: SnapState | null;
}

/** Click-and-drag primitive (line, coordinate plane). */
interface ShapeSession {
  readonly kind: 'shape';
  readonly pointerId: number;
  readonly pointerType: InkPointerType;
  readonly tool: ShapeTool;
  readonly style: StrokeStyle;
  readonly rect: DOMRect;
  readonly scale: number;
  readonly start: Point;
  readonly planeConfig: CoordinatePlaneConfig;
  readonly angleSnapDeg: number | undefined;
  readonly createdAt: number;
  current: Point;
  shape: Shape;
  hud: readonly AngleArc[];
}

interface EraseSession {
  readonly kind: 'erase';
  readonly pointerId: number;
  readonly pointerType: InkPointerType;
  readonly radius: number;
  readonly hits: Set<string>;
  readonly rect: DOMRect;
  readonly scale: number;
  last: InkPoint;
}

type Session = InkSession | ShapeSession | EraseSession;

interface PenState {
  inProximity: boolean;
  lastSeen: number;
}

/**
 * Project a viewport position into drawing units: subtract the surface's
 * on-screen origin (which already accounts for any scroll offsets, since
 * `getBoundingClientRect` is viewport-relative) and undo the zoom.
 */
function toInkPoint(e: PointerEvent, rect: DOMRect, scale: number): InkPoint {
  return {
    x: (e.clientX - rect.left) / scale,
    y: (e.clientY - rect.top) / scale,
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

function buildDragShape(
  tool: ShapeTool,
  start: Point,
  current: Point,
  angleSnapDeg: number | undefined,
  planeConfig: CoordinatePlaneConfig,
): Shape {
  return tool === 'line'
    ? lineFromDrag(start, current, angleSnapDeg)
    : coordinatePlaneFromDrag(start, current, planeConfig);
}

function isDegenerateShape(shape: Shape): boolean {
  if (shape.type === 'line') return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < 2;
  if (shape.type === 'coordinate-plane') return shape.extentX < 8 || shape.extentY < 8;
  return false;
}

/**
 * Pointer-event state machine for the canvas: palm rejection, pointer capture,
 * coalesced sampling, rAF-batched rendering of the live stroke, hold-to-snap
 * recognition, drag-to-draw primitives, and hand-off of finished strokes /
 * erasures to the history layer.
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

    const angleSnapFor = (settings: ToolSettings): number | undefined =>
      settings.angleSnap ? ANGLE_SNAP_INCREMENT_DEG : undefined;

    /** Angle overlay for a straight line against the committed segments. */
    const hudFor = (shape: Shape): AngleArc[] => {
      if (shape.type !== 'line') return [];
      const { strokesRef, hiddenIdsRef } = optionsRef.current;
      return buildLineHud(shape, geometricSegments(strokesRef.current, hiddenIdsRef.current));
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

      if (session.kind === 'shape') {
        drawShape(live, session.shape, session.style);
        drawAngleHud(live, session.hud);
        return;
      }

      const { builder, snap } = session;
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

      if (snap?.shape) {
        // Hold-to-snap: the idealised primitive replaces the raw preview.
        drawShape(live, snap.shape, builder.style);
        drawAngleHud(live, snap.hud);
        return;
      }

      drawLiveStroke(live, builder.points, builder.style);
    };

    const scheduleFrame = (): void => {
      if (frameRef.current === 0) frameRef.current = requestAnimationFrame(renderFrame);
    };

    // ---- hold-to-snap -----------------------------------------------------

    const clearSnapTimer = (snap: SnapState | null): void => {
      if (snap?.timer) {
        clearTimeout(snap.timer);
        snap.timer = null;
      }
    };

    /**
     * (Re)start the dwell timer. Runs recognition once the pointer has been
     * still for `HOLD_TO_SNAP_MS`; a timer (rather than the rAF loop) is
     * required because a perfectly still pen produces no events at all.
     */
    const armSnapTimer = (session: InkSession): void => {
      const { snap } = session;
      if (!snap) return;
      clearSnapTimer(snap);
      snap.timer = setTimeout(() => {
        snap.timer = null;
        if (sessionRef.current !== session) return;
        const points = session.builder.points;
        if (polylineLength(points) < MIN_SNAP_PATH_LENGTH_PX) return;
        const settings = optionsRef.current.settingsRef.current;
        const snapDeg = angleSnapFor(settings);
        const shape = recognizeShape(points, snapDeg === undefined ? {} : { angleSnapDeg: snapDeg });
        if (!shape) return;
        snap.shape = shape;
        snap.hud = hudFor(shape);
        scheduleFrame();
      }, HOLD_TO_SNAP_MS);
    };

    /** Movement beyond the jitter radius restarts the dwell and drops any snap. */
    const noteDwell = (session: InkSession, point: Point, now: number): void => {
      const { snap } = session;
      if (!snap) return;
      if (Math.hypot(point.x - snap.anchor.x, point.y - snap.anchor.y) <= SNAP_JITTER_PX) return;
      snap.anchor = point;
      snap.since = now;
      if (snap.shape) {
        snap.shape = null;
        snap.hud = [];
      }
      armSnapTimer(session);
    };

    // ---- erasing ------------------------------------------------------------

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

    // ---- session lifecycle ----------------------------------------------------

    const finishSession = (): void => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      cancelFrame();
      releaseCapture(session.pointerId);

      const opts = optionsRef.current;
      if (session.kind === 'ink') {
        clearSnapTimer(session.snap);
        const { builder } = session;
        const snapped = session.snap?.shape ?? null;
        if (snapped && builder.tool !== 'eraser-pixel') {
          opts.onCommitStroke(
            createGeometricStroke({
              tool: builder.tool,
              shape: snapped,
              style: builder.style,
              pointerType: builder.pointerType,
              createdAt: builder.createdAt,
            }),
          );
        } else {
          opts.onCommitStroke(builder.build());
        }
      } else if (session.kind === 'shape') {
        if (!isDegenerateShape(session.shape)) {
          opts.onCommitStroke(
            createGeometricStroke({
              tool: session.tool,
              shape: session.shape,
              style: session.style,
              pointerType: session.pointerType,
              createdAt: session.createdAt,
            }),
          );
        }
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
        clearSnapTimer(session.snap);
        needsRedraw = session.builder.tool === 'eraser-pixel';
      } else if (session.kind === 'erase') {
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

    // ---- handlers ---------------------------------------------------------------

    const onPointerDown: CanvasPointerHandler = (e) => {
      const pointerType = normalizePointerType(e.pointerType);
      notePen(pointerType);

      const opts = optionsRef.current;
      const settings = opts.settingsRef.current;
      const pen = penRef.current;
      const now = performance.now();
      const accepted = isPointerAccepted({
        pointerType,
        touchDraw: settings.touchDraw,
        allowMouse: opts.allowMouse,
        penInProximity: pen.inProximity,
        msSincePen: now - pen.lastSeen,
      });
      if (!accepted) return;

      if (sessionRef.current) {
        // Only one stroke at a time. A pen may pre-empt a touch stroke (palm);
        // anything else is a secondary pointer and is ignored.
        if (pointerType === 'pen' && sessionRef.current.pointerType === 'touch') cancelSession();
        else return;
      }

      const tool = resolveEffectiveTool(settings.tool, pointerType, e.button, e.buttons, settings.stylus);
      if (tool === null) return;
      // The select tool leaves the surface to the media / form layers. When a
      // barrel press asked for it, let the host switch tools for the duration.
      if (tool === 'select') {
        if (settings.tool !== 'select' && isBarrelPress(pointerType, e.button, e.buttons)) opts.onBarrelSelect?.();
        return;
      }

      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      const scale = opts.contentScaleRef?.current ?? 1;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported; strokes will end at the element edge */
      }
      opts.onInteractionStart?.();

      const point = toInkPoint(e.nativeEvent, rect, scale);

      if (tool === 'eraser-stroke') {
        const session: EraseSession = {
          kind: 'erase',
          pointerId: e.pointerId,
          pointerType,
          radius: strokeEraserRadius(settings),
          hits: new Set<string>(),
          rect,
          scale,
          last: point,
        };
        sessionRef.current = session;
        if (eraseSweep(session, point, point)) opts.redrawCommitted();
      } else if (tool === 'line' || tool === 'coordinate-plane') {
        const angleSnapDeg = angleSnapFor(settings);
        const planeConfig = settings.coordinatePlane;
        const shape = buildDragShape(tool, point, point, angleSnapDeg, planeConfig);
        sessionRef.current = {
          kind: 'shape',
          pointerId: e.pointerId,
          pointerType,
          tool,
          style: styleForTool(tool, settings, pointerType),
          rect,
          scale,
          start: point,
          planeConfig,
          angleSnapDeg,
          createdAt: now,
          current: point,
          shape,
          hud: [],
        };
      } else {
        const builder = new StrokeBuilder(tool, styleForTool(tool, settings, pointerType), pointerType);
        builder.add(point);
        const canSnap = settings.holdToSnap && tool !== 'eraser-pixel';
        const session: InkSession = {
          kind: 'ink',
          pointerId: e.pointerId,
          pointerType,
          builder,
          rect,
          scale,
          snap: canSnap ? { anchor: point, since: now, timer: null, shape: null, hud: [] } : null,
        };
        sessionRef.current = session;
        armSnapTimer(session);
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
        const now = performance.now();
        for (const sample of samples) {
          const point = toInkPoint(sample, session.rect, session.scale);
          session.builder.add(point);
          noteDwell(session, point, now);
        }
      } else if (session.kind === 'shape') {
        const sample = samples[samples.length - 1];
        if (sample) {
          session.current = toInkPoint(sample, session.rect, session.scale);
          session.shape = buildDragShape(
            session.tool,
            session.start,
            session.current,
            session.angleSnapDeg,
            session.planeConfig,
          );
          session.hud = hudFor(session.shape);
        }
      } else {
        let dirty = false;
        for (const sample of samples) {
          const point = toInkPoint(sample, session.rect, session.scale);
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

  // Drop any in-flight frame or dwell timer if the component unmounts mid-stroke.
  useEffect(
    () => () => {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      const session = sessionRef.current;
      if (session?.kind === 'ink' && session.snap?.timer) clearTimeout(session.snap.timer);
      sessionRef.current = null;
    },
    [],
  );

  return handlers;
}
