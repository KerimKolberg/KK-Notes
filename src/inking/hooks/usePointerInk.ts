import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  ANGLE_SNAP_INCREMENT_DEG,
  HOLD_TO_SNAP_MS,
  MIN_SNAP_PATH_LENGTH_PX,
} from '../constants';
import { buildLineHud, geometricSegments, type AngleArc } from '../engine/angleHud';
import {
  isTouchGestureActive,
  notePenLeft,
  notePenPresence,
  penPresence,
  subscribeTouchGesture,
} from '../engine/gestureState';
import { tiltMagnitude } from '../engine/brushes';
import { strokeHitBySegment } from '../engine/hitTest';
import {
  EMPTY_LASER_TRAIL,
  appendLaserPoint,
  laserRuns,
  laserTrailExpired,
  type LaserStyle,
  type LaserTrail,
} from '../engine/laser';
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
  drawLaserTrail,
  drawLassoPreview,
  drawLiveStroke,
  drawShape,
  get2dContext,
} from '../engine/renderer';
import { recognizeShape } from '../engine/shapeRecognition';
import { coordinatePlaneFromDrag, createGeometricStroke, curveFromDrag, lineFromDrag } from '../engine/shapes';
import { polylineLength } from '../engine/simplify';
import { StrokeBuilder } from '../engine/strokeBuilder';
import { beginDwell, lockDwell, noteDwellMovement, type DwellState } from '../engine/dwell';
import { filterIsActive, inEraseFilter, type EraseFilter } from '../engine/eraseFilter';
import { eraserRadius, laserStyleFor, styleForTool } from '../engine/toolStyles';
import type {
  CanvasSize,
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
  /** When false, touch never inks, whatever Touch Draw says. */
  allowTouch?: boolean;
  /**
   * CSS pixels per drawing unit (the page zoom). Pointer positions are divided
   * by this so strokes are stored in page-local units. Default 1.
   */
  contentScaleRef?: RefObject<number>;
  /** Fired when an accepted pointer starts any session (used to activate a page). */
  onInteractionStart?: () => void;
  /** The pen's barrel button is mapped to select mode and was pressed on the surface. */
  onBarrelSelect?: () => void;
  /** A lasso loop is starting (hosts clear any previous selection). */
  onLassoStart?: () => void;
  /** A lasso loop was closed; `polygon` is in drawing units. */
  onLassoComplete?: (polygon: readonly Point[]) => void;
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

/** Hold-to-snap bookkeeping: the dwell state machine plus its timer. */
interface SnapState extends DwellState {
  timer: ReturnType<typeof setTimeout> | null;
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
  /** Toolbar state frozen at pointerdown, like every stroke's style. */
  readonly settings: Readonly<ToolSettings>;
  readonly angleSnapDeg: number | undefined;
  readonly createdAt: number;
  current: Point;
  shape: Shape;
  hud: readonly AngleArc[];
}

/**
 * Laser pointer stroke. The trail itself is kept outside the session: it
 * keeps fading (and animating) after the pointer lifts, and it is never
 * committed anywhere.
 */
interface LaserSession {
  readonly kind: 'laser';
  readonly pointerId: number;
  readonly pointerType: InkPointerType;
  readonly rect: DOMRect;
  readonly scale: number;
  readonly style: LaserStyle;
}

/** Freehand lasso loop. */
interface LassoSession {
  readonly kind: 'lasso';
  readonly pointerId: number;
  readonly pointerType: InkPointerType;
  readonly rect: DOMRect;
  readonly scale: number;
  readonly points: Point[];
}

interface EraseSession {
  readonly kind: 'erase';
  /** Which layers this erase may take, frozen at pointerdown. */
  readonly filter: EraseFilter;
  readonly pointerId: number;
  readonly pointerType: InkPointerType;
  readonly radius: number;
  readonly hits: Set<string>;
  readonly rect: DOMRect;
  readonly scale: number;
  last: InkPoint;
}

type Session = InkSession | ShapeSession | EraseSession | LassoSession | LaserSession;

/**
 * Project a viewport position into drawing units: subtract the surface's
 * on-screen origin (which already accounts for any scroll offsets, since
 * `getBoundingClientRect` is viewport-relative) and undo the zoom.
 */
function toInkPoint(e: PointerEvent, rect: DOMRect, scale: number): InkPoint {
  // Tilt is only recorded when the digitiser reports it, so strokes from
  // devices without it stay exactly as small as before.
  const tilt = tiltMagnitude(e.tiltX, e.tiltY);
  return {
    x: (e.clientX - rect.left) / scale,
    y: (e.clientY - rect.top) / scale,
    pressure: normalizePressure(e.pressure),
    ...(tilt > 0 ? { tilt } : {}),
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
  settings: Readonly<ToolSettings>,
): Shape {
  if (tool !== 'line') return coordinatePlaneFromDrag(start, current, settings.coordinatePlane);
  // The line tool lays down whichever path its flyout is set to; all of them
  // are defined by the drag's two endpoints, so the gesture is the same one.
  if (settings.lineCurve === 'straight') return lineFromDrag(start, current, angleSnapDeg);
  return curveFromDrag(
    start,
    current,
    settings.lineCurve,
    settings.curveAmplitude,
    settings.curveCycles,
    settings.curveFlip,
    angleSnapDeg,
  );
}

function isDegenerateShape(shape: Shape): boolean {
  if (shape.type === 'line' || shape.type === 'curve') {
    return Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < 2;
  }
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

  const controller = useMemo<PointerInkHandlers & { cancelTouchSession: () => void; dropLaserTrail: () => void }>(() => {
    /** The laser trail; outlives the session that drew it. */
    let laserTrail: LaserTrail = EMPTY_LASER_TRAIL;

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

      // The laser trail is independent of the session: it holds for as long
      // as the pointer keeps refreshing it, then fades out as a whole, and
      // keeps the loop alive until it has.
      if (laserTrail.points.length > 0) {
        const now = performance.now();
        if (laserTrailExpired(laserTrail, now)) {
          laserTrail = EMPTY_LASER_TRAIL;
        } else {
          drawLaserTrail(live, laserRuns(laserTrail, now));
          scheduleFrame();
        }
      }

      if (!session) return;
      if (session.kind === 'laser') return;

      if (session.kind === 'erase') {
        drawEraserCursor(live, session.last.x, session.last.y, session.radius);
        return;
      }

      if (session.kind === 'shape') {
        drawShape(live, session.shape, session.style);
        drawAngleHud(live, session.hud);
        return;
      }

      if (session.kind === 'lasso') {
        drawLassoPreview(live, session.points);
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
        lockDwell(snap, shape, hudFor(shape));
        scheduleFrame();
      }, HOLD_TO_SNAP_MS);
    };

    /**
     * Movement restarts the dwell — but only past the tolerance the dwell is
     * currently on, which widens once a shape is locked so that lifting the
     * pen cannot undo the recognition.
     */
    const noteDwell = (session: InkSession, point: Point, now: number): void => {
      const { snap } = session;
      if (snap && noteDwellMovement(snap, point, now)) armSnapTimer(session);
    };

    // ---- erasing ------------------------------------------------------------

    /** Hit-test one eraser sweep; returns true when new strokes were hidden. */
    const eraseSweep = (session: EraseSession, from: InkPoint, to: InkPoint): boolean => {
      const { strokesRef, hiddenIdsRef } = optionsRef.current;
      const hidden = hiddenIdsRef.current;
      let dirty = false;
      for (const stroke of strokesRef.current) {
        if (session.hits.has(stroke.id)) continue;
        // Out of scope: the eraser passes straight over it, so a highlight can
        // be scrubbed off without taking the writing underneath with it.
        if (!inEraseFilter(stroke, session.filter)) continue;
        if (strokeHitBySegment(stroke, from.x, from.y, to.x, to.y, session.radius)) {
          session.hits.add(stroke.id);
          hidden.add(stroke.id);
          dirty = true;
        }
      }
      return dirty;
    };

    // ---- session lifecycle ----------------------------------------------------

    /** Clear the preview layer, unless a laser trail is still on screen. */
    const endLiveFrame = (): void => {
      if (laserTrail.points.length > 0) scheduleFrame();
      else clearLive();
    };

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
      } else if (session.kind === 'lasso') {
        if (session.points.length >= 3) opts.onLassoComplete?.(session.points);
      } else if (session.kind === 'laser') {
        // Nothing to commit, by design: the trail simply finishes fading.
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
      endLiveFrame();
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
      endLiveFrame();
      setLiveBlend('normal');
    };

    /**
     * Record pen presence (shared across all surfaces). A pen arriving while a
     * finger is drawing means the finger was almost certainly a palm, so that
     * stroke is discarded.
     */
    const notePen = (pointerType: InkPointerType): void => {
      if (pointerType !== 'pen') return;
      notePenPresence();
      const session = sessionRef.current;
      if (session && session.pointerType === 'touch') cancelSession();
    };

    /** A two-finger navigation gesture began: touch may not ink until it ends. */
    const cancelTouchSession = (): void => {
      const session = sessionRef.current;
      if (session && session.pointerType === 'touch') cancelSession();
    };

    // ---- handlers ---------------------------------------------------------------

    const onPointerDown: CanvasPointerHandler = (e) => {
      const pointerType = normalizePointerType(e.pointerType);
      notePen(pointerType);

      const opts = optionsRef.current;
      const settings = opts.settingsRef.current;
      const now = performance.now();
      // Fingers never ink during a two-finger pan / pinch.
      if (pointerType === 'touch' && isTouchGestureActive()) return;
      const pen = penPresence(now);
      const accepted = isPointerAccepted({
        pointerType,
        touchDraw: settings.touchDraw && (opts.allowTouch ?? true),
        allowMouse: opts.allowMouse,
        penInProximity: pen.inProximity,
        msSincePen: pen.msSincePen,
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

      if (tool === 'laser-pointer') {
        const style = laserStyleFor(settings);
        laserTrail = appendLaserPoint(laserTrail, point, now, style, true);
        sessionRef.current = { kind: 'laser', pointerId: e.pointerId, pointerType, rect, scale, style };
        scheduleFrame();
        return;
      }

      if (tool === 'lasso') {
        opts.onLassoStart?.();
        sessionRef.current = { kind: 'lasso', pointerId: e.pointerId, pointerType, rect, scale, points: [point] };
        scheduleFrame();
        return;
      }

      // A filtered area eraser cannot cut pixels: `destination-out` takes
      // whatever is underneath it on the shared canvas, with no way to spare
      // one ink type. Narrowed, it therefore removes the matching strokes it
      // sweeps over instead — which is what the filter is actually for, and
      // leaves everything else untouched as promised.
      const filteredArea = tool === 'eraser-pixel' && filterIsActive(settings.eraseFilter);
      if (tool === 'eraser-stroke' || filteredArea) {
        const session: EraseSession = {
          kind: 'erase',
          filter: settings.eraseFilter,
          pointerId: e.pointerId,
          pointerType,
          radius: eraserRadius(settings),
          hits: new Set<string>(),
          rect,
          scale,
          last: point,
        };
        sessionRef.current = session;
        if (eraseSweep(session, point, point)) opts.redrawCommitted();
      } else if (tool === 'line' || tool === 'coordinate-plane') {
        const angleSnapDeg = angleSnapFor(settings);
        const shape = buildDragShape(tool, point, point, angleSnapDeg, settings);
        sessionRef.current = {
          kind: 'shape',
          pointerId: e.pointerId,
          pointerType,
          tool,
          style: styleForTool(tool, settings, pointerType),
          rect,
          scale,
          start: point,
          settings,
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
          snap: canSnap ? { ...beginDwell(point, now), timer: null } : null,
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
      } else if (session.kind === 'lasso') {
        for (const sample of samples) {
          const point = toInkPoint(sample, session.rect, session.scale);
          const last = session.points[session.points.length - 1];
          if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= 1) session.points.push(point);
        }
      } else if (session.kind === 'laser') {
        const now = performance.now();
        for (const sample of samples) {
          laserTrail = appendLaserPoint(laserTrail, toInkPoint(sample, session.rect, session.scale), now, session.style);
        }
      } else if (session.kind === 'shape') {
        const sample = samples[samples.length - 1];
        if (sample) {
          session.current = toInkPoint(sample, session.rect, session.scale);
          session.shape = buildDragShape(session.tool, session.start, session.current, session.angleSnapDeg, session.settings);
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
      notePenLeft();
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
      cancelTouchSession,
      dropLaserTrail: () => {
        laserTrail = EMPTY_LASER_TRAIL;
      },
    };
  }, [optionsRef]);

  // Two-finger gestures cancel any touch stroke in progress on this surface.
  useEffect(() => subscribeTouchGesture((active) => {
    if (active) controller.cancelTouchSession();
  }), [controller]);

  // Drop any in-flight frame or dwell timer if the component unmounts mid-stroke.
  useEffect(
    () => () => {
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      const session = sessionRef.current;
      if (session?.kind === 'ink' && session.snap?.timer) clearTimeout(session.snap.timer);
      sessionRef.current = null;
      controller.dropLaserTrail();
    },
    [controller],
  );

  const { cancelTouchSession: _cancel, dropLaserTrail: _drop, ...handlers } = controller;
  return handlers;
}
