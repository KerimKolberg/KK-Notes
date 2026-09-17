/**
 * Laser pointer: a disappearing trail that is never part of the document.
 *
 * The trail is a list of timestamped points. Every point carries the colour
 * and width it was drawn with, so a fading trail keeps its appearance even
 * after the toolbar changes, and fades on its own clock: a point's alpha
 * decays linearly from 1 to 0 over `LASER_FADE_MS` and the point is dropped
 * once it reaches zero.
 *
 * That single rule produces both behaviours the tool needs — while the pen
 * keeps moving, the tail dissolves `LASER_FADE_MS` behind the tip, and after
 * `pointerup` the newest point (drawn at the moment of release) takes exactly
 * `LASER_FADE_MS` to vanish.
 */
import { LASER_FADE_MS, LASER_RAINBOW_PERIOD_MS } from '../constants';
import type { InkPoint, Point } from '../types';

/** How far a point must move before it is recorded (drawing units). */
const MIN_SAMPLE_DISTANCE = 0.6;
/** Hard cap on retained samples (a 240 Hz pen fills ~650 in a fade window). */
export const MAX_LASER_POINTS = 2000;
/** Width at the faded tail, as a fraction of the drawn width. */
const TAIL_WIDTH_FRACTION = 0.55;

export interface LaserStyle {
  /** Base colour, used when `rainbow` is off. */
  readonly color: string;
  /** Base width in drawing units, before pressure. */
  readonly size: number;
  /** Cycle the hue along the stroke instead of using `color`. */
  readonly rainbow: boolean;
}

export interface LaserPoint extends Point {
  /** `performance.now()` timestamp of the sample. */
  readonly t: number;
  readonly color: string;
  readonly width: number;
  /** True for the first point of a stroke: no segment is drawn into it. */
  readonly startsStroke: boolean;
}

export interface LaserSegment {
  readonly from: Point;
  readonly to: Point;
  readonly width: number;
  /** 0..1 opacity for this segment (the older endpoint decides). */
  readonly alpha: number;
  readonly color: string;
}

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
    t,
    color: style.rainbow ? rainbowColor(t) : style.color,
    width: laserWidth(sample.pressure, style.size),
    startsStroke,
  };
}

/**
 * Append a sample, skipping ones too close to the previous point (except the
 * first of a stroke) and trimming the trail to `MAX_LASER_POINTS`.
 */
export function appendLaserPoint(
  trail: readonly LaserPoint[],
  sample: InkPoint,
  t: number,
  style: LaserStyle,
  startsStroke = false,
): LaserPoint[] {
  const last = trail[trail.length - 1];
  if (!startsStroke && last && Math.hypot(sample.x - last.x, sample.y - last.y) < MIN_SAMPLE_DISTANCE) {
    return trail as LaserPoint[];
  }
  const next = [...trail, laserPointFrom(sample, t, style, startsStroke)];
  return next.length > MAX_LASER_POINTS ? next.slice(next.length - MAX_LASER_POINTS) : next;
}

/** Remaining opacity of a sample of the given age (1 → 0 across the fade window). */
export function laserAlpha(age: number, fadeMs = LASER_FADE_MS): number {
  if (!(fadeMs > 0)) return 0;
  if (age <= 0) return 1;
  if (age >= fadeMs) return 0;
  return 1 - age / fadeMs;
}

/** Drop fully faded samples. Returns the same array when nothing expired. */
export function pruneLaserTrail(trail: readonly LaserPoint[], now: number, fadeMs = LASER_FADE_MS): LaserPoint[] {
  let first = 0;
  while (first < trail.length && now - (trail[first]?.t ?? 0) >= fadeMs) first++;
  if (first === 0) return trail as LaserPoint[];
  const kept = trail.slice(first);
  // The first survivor now begins a stroke: its predecessor is gone.
  const head = kept[0];
  if (head && !head.startsStroke) kept[0] = { ...head, startsStroke: true };
  return kept;
}

/** True once every sample has faded out. */
export function laserTrailIsEmpty(trail: readonly LaserPoint[], now: number, fadeMs = LASER_FADE_MS): boolean {
  const last = trail[trail.length - 1];
  return last === undefined || now - last.t >= fadeMs;
}

/**
 * Renderable segments for the current instant. Each segment takes the older
 * endpoint's alpha and colour, so the trail darkens and thins towards its
 * tail, and segments into a stroke start are skipped.
 */
export function laserSegments(trail: readonly LaserPoint[], now: number, fadeMs = LASER_FADE_MS): LaserSegment[] {
  const segments: LaserSegment[] = [];
  for (let i = 1; i < trail.length; i++) {
    const from = trail[i - 1];
    const to = trail[i];
    if (!from || !to || to.startsStroke) continue;
    const alpha = laserAlpha(now - from.t, fadeMs);
    if (alpha <= 0) continue;
    const width = ((from.width + to.width) / 2) * (TAIL_WIDTH_FRACTION + (1 - TAIL_WIDTH_FRACTION) * alpha);
    segments.push({ from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y }, width, alpha, color: from.color });
  }
  return segments;
}

/** Quantisation of the fade when segments are batched into polylines. */
export const LASER_ALPHA_STEPS = 24;

/** A run of consecutive segments that share a quantised alpha and a colour. */
export interface LaserRun {
  readonly points: readonly Point[];
  readonly alpha: number;
  readonly color: string;
  readonly width: number;
}

/**
 * Batch the trail into polylines so a frame costs a few dozen `stroke()`
 * calls instead of one per sample. Alpha and hue both vary monotonically
 * along the trail, so consecutive segments group naturally.
 */
export function laserRuns(
  trail: readonly LaserPoint[],
  now: number,
  fadeMs = LASER_FADE_MS,
  alphaSteps = LASER_ALPHA_STEPS,
): LaserRun[] {
  const runs: LaserRun[] = [];
  let points: Point[] = [];
  let color = '';
  let bucket = -1;
  let widthSum = 0;
  let alphaSum = 0;

  const flush = (): void => {
    if (points.length >= 2) {
      runs.push({ points, alpha: alphaSum / (points.length - 1), color, width: widthSum / (points.length - 1) });
    }
    points = [];
    widthSum = 0;
    alphaSum = 0;
  };

  for (const segment of laserSegments(trail, now, fadeMs)) {
    const segBucket = Math.max(0, Math.min(alphaSteps - 1, Math.floor(segment.alpha * alphaSteps)));
    const last = points[points.length - 1];
    const continues = last !== undefined && last.x === segment.from.x && last.y === segment.from.y;
    if (!continues || segBucket !== bucket || segment.color !== color) {
      flush();
      points = [segment.from];
      bucket = segBucket;
      color = segment.color;
    }
    points.push(segment.to);
    widthSum += segment.width;
    alphaSum += segment.alpha;
  }
  flush();
  return runs;
}
