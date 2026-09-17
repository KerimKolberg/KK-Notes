/**
 * Laser pointer: a disappearing trail that is never part of the document.
 *
 * The trail is one mark with one clock, not a crowd of independently fading
 * samples. Every pointer event refreshes its activity timestamp; the whole
 * trail then stays at full strength for `LASER_HOLD_MS` after the last one,
 * and only then fades out together over `LASER_FADE_OUT_MS` and is dropped.
 *
 * That is what a presenter wants: a diagram drawn in half a dozen strokes
 * stays on screen while it is being talked through, instead of dissolving
 * behind the pen, and clears itself the moment attention moves on.
 *
 * Each point still carries the colour and width it was drawn with, so a trail
 * keeps its appearance even after the toolbar changes underneath it.
 */
import { LASER_FADE_OUT_MS, LASER_HOLD_MS, LASER_RAINBOW_PERIOD_MS } from '../constants';
import type { InkPoint, Point } from '../types';

/** How far a point must move before it is recorded (drawing units). */
const MIN_SAMPLE_DISTANCE = 0.6;
/** Hard cap on retained samples; the oldest are dropped past it. */
export const MAX_LASER_POINTS = 2000;

export interface LaserStyle {
  /** Base colour, used when `rainbow` is off. */
  readonly color: string;
  /** Base width in drawing units, before pressure. */
  readonly size: number;
  /** Cycle the hue along the stroke instead of using `color`. */
  readonly rainbow: boolean;
}

export interface LaserPoint extends Point {
  readonly color: string;
  readonly width: number;
  /** True for the first point of a stroke: no segment is drawn into it. */
  readonly startsStroke: boolean;
}

/** The whole live trail: its samples and when it was last drawn on. */
export interface LaserTrail {
  readonly points: readonly LaserPoint[];
  /** `performance.now()` of the most recent pointer event. */
  readonly activeAt: number;
}

export const EMPTY_LASER_TRAIL: LaserTrail = { points: [], activeAt: 0 };

/** Hue cycles with wall-clock time, so a rainbow gradient travels along the stroke. */
export function rainbowColor(t: number, periodMs = LASER_RAINBOW_PERIOD_MS): string {
  const hue = (((t % periodMs) + periodMs) % periodMs) / periodMs;
  return `hsl(${Math.round(hue * 360)}, 100%, 58%)`;
}

/** Pressure-modulated width: a light touch draws a thinner beam. */
export function laserWidth(pressure: number, size: number): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
  return Math.max(1, size * (0.55 + 0.9 * p));
}

export function laserPointFrom(sample: InkPoint, t: number, style: LaserStyle, startsStroke: boolean): LaserPoint {
  return {
    x: sample.x,
    y: sample.y,
    color: style.rainbow ? rainbowColor(t) : style.color,
    width: laserWidth(sample.pressure, style.size),
    startsStroke,
  };
}

/**
 * Append a sample and mark the trail active at `t`. Samples too close to the
 * previous point are skipped (except the first of a stroke), but they still
 * count as activity: holding the pen still on one spot is pointing at it, and
 * must not let the trail start fading.
 */
export function appendLaserPoint(
  trail: LaserTrail,
  sample: InkPoint,
  t: number,
  style: LaserStyle,
  startsStroke = false,
): LaserTrail {
  const last = trail.points[trail.points.length - 1];
  if (!startsStroke && last && Math.hypot(sample.x - last.x, sample.y - last.y) < MIN_SAMPLE_DISTANCE) {
    return { points: trail.points, activeAt: t };
  }
  const next = [...trail.points, laserPointFrom(sample, t, style, startsStroke)];
  if (next.length > MAX_LASER_POINTS) {
    const kept = next.slice(next.length - MAX_LASER_POINTS);
    // The first survivor now begins a stroke: its predecessor is gone.
    const head = kept[0];
    if (head && !head.startsStroke) kept[0] = { ...head, startsStroke: true };
    return { points: kept, activeAt: t };
  }
  return { points: next, activeAt: t };
}

/**
 * Opacity of the whole trail for a given idle time: full until the hold
 * expires, then linear to nothing across the fade-out.
 */
export function laserAlpha(idle: number, holdMs = LASER_HOLD_MS, fadeOutMs = LASER_FADE_OUT_MS): number {
  if (idle <= holdMs) return 1;
  if (!(fadeOutMs > 0)) return 0;
  const faded = (idle - holdMs) / fadeOutMs;
  return faded >= 1 ? 0 : 1 - faded;
}

/** Opacity of `trail` at `now`. Zero once it has faded out completely. */
export function laserTrailAlpha(trail: LaserTrail, now: number, holdMs = LASER_HOLD_MS, fadeOutMs = LASER_FADE_OUT_MS): number {
  return trail.points.length === 0 ? 0 : laserAlpha(now - trail.activeAt, holdMs, fadeOutMs);
}

/** True once the trail has finished fading and can be dropped. */
export function laserTrailExpired(trail: LaserTrail, now: number, holdMs = LASER_HOLD_MS, fadeOutMs = LASER_FADE_OUT_MS): boolean {
  return laserTrailAlpha(trail, now, holdMs, fadeOutMs) <= 0;
}

/** A run of consecutive segments sharing a colour, drawn as one polyline. */
export interface LaserRun {
  readonly points: readonly Point[];
  readonly alpha: number;
  readonly color: string;
  readonly width: number;
}

/**
 * Batch the trail into polylines so a frame costs a few `stroke()` calls
 * instead of one per sample. The trail has a single opacity now, so a run
 * only ends where a stroke ends or where the rainbow hue moves on.
 */
export function laserRuns(trail: LaserTrail, now: number, holdMs = LASER_HOLD_MS, fadeOutMs = LASER_FADE_OUT_MS): LaserRun[] {
  const alpha = laserTrailAlpha(trail, now, holdMs, fadeOutMs);
  if (alpha <= 0) return [];

  const runs: LaserRun[] = [];
  let points: Point[] = [];
  let color = '';
  let widthSum = 0;

  const flush = (): void => {
    if (points.length >= 2) runs.push({ points, alpha, color, width: widthSum / points.length });
    points = [];
    widthSum = 0;
  };

  let previous: LaserPoint | null = null;
  for (const point of trail.points) {
    // A new stroke is not joined to the one before it, and a hue change ends
    // the run because a polyline is stroked in a single colour.
    if (previous === null || point.startsStroke || point.color !== previous.color) {
      flush();
      color = point.color;
      // Same stroke, new hue: repeat the shared vertex so no gap opens up.
      if (previous && !point.startsStroke) {
        points.push({ x: previous.x, y: previous.y });
        widthSum += previous.width;
      }
    }
    points.push({ x: point.x, y: point.y });
    widthSum += point.width;
    previous = point;
  }
  flush();
  return runs;
}
