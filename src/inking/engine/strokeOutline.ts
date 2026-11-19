/**
 * perfect-freehand integration.
 *
 * `getStroke` turns a raw polyline of `{x, y, pressure}` samples into a closed
 * polygon that *surrounds* the line, with per-point width. In short:
 *
 *  1. **Streamline** – each incoming point is moved toward the previous one by
 *     `streamline` (a running lerp), damping sensor jitter without adding lag
 *     beyond a fraction of one sample.
 *  2. **Radius** – for each point, `r = size / 2 · easing(0.5 − thinning · (0.5 − pressure))`.
 *     `thinning = 0` gives a constant width; positive values make light pressure thin.
 *     With `simulatePressure`, pressure is instead derived from inverse velocity.
 *  3. **Offsets** – the unit direction vector between neighbouring points is
 *     rotated 90° and scaled by `r` to produce a left and a right offset point.
 *     Sharp turns insert extra points along an arc so joins stay round.
 *  4. **Caps/tapers** – the ends are closed with semicircular caps or tapered
 *     to zero width over `taper` pixels.
 *  5. The left side followed by the reversed right side forms the polygon.
 *
 * We then render that polygon as a `Path2D` using quadratic curves through the
 * midpoints of consecutive vertices, which hides the faceting of the polygon.
 */
import { getStrokeOutlinePoints, getStrokePoints, type StrokeOptions } from 'perfect-freehand';
import { easingForStyle, pencilPressure, strokeBrush, strokeTapers } from './brushes';
import type { InkPoint, StrokeStyle } from '../types';

export type Outline = ReadonlyArray<readonly [number, number]>;

type FreehandPoint = { x: number; y: number; pressure?: number };

/**
 * Map our persisted style onto perfect-freehand options. The brush (when the
 * stroke has one) supplies the pressure→radius easing, whether the ends are
 * capped or chiselled flat, and any velocity-dependent taper, which is why
 * the samples are needed here.
 */
export interface CapOverrides {
  /** Flat, uncapped ends, used where one chunk of a stroke meets the next. */
  readonly start?: boolean;
  readonly end?: boolean;
}

export function toFreehandOptions(
  style: StrokeStyle,
  complete: boolean,
  points: readonly InkPoint[] = [],
  caps: CapOverrides = {},
): StrokeOptions {
  const brush = strokeBrush(style);
  const taper = strokeTapers(points, style);
  const cap = brush?.cap !== 'flat';
  const startCap = caps.start ?? cap;
  const endCap = caps.end ?? cap;
  return {
    size: style.size,
    thinning: style.thinning,
    smoothing: style.smoothing,
    streamline: style.streamline,
    simulatePressure: style.simulatePressure,
    easing: easingForStyle(style),
    start: { cap: startCap, taper: startCap ? taper.start : 0 },
    end: { cap: endCap, taper: endCap ? taper.end : 0 },
    // `last: false` while the pen is down: the end is left "open" so the live
    // preview doesn't flash a cap that moves every frame.
    last: complete,
  };
}

/**
 * Samples as perfect-freehand wants them. Brushes that respond to tilt fold
 * the lean of the stylus into the pressure, so a flat pencil draws broader.
 */
export function freehandSamples(points: readonly InkPoint[], style: StrokeStyle): readonly FreehandPoint[] {
  const brush = strokeBrush(style);
  if (!brush || brush.tiltResponse === 0) return points;
  let tilted = false;
  for (const p of points) {
    if (p.tilt) {
      tilted = true;
      break;
    }
  }
  if (!tilted) return points;
  return points.map((p) => ({ x: p.x, y: p.y, pressure: pencilPressure(p.pressure, p.tilt ?? 0, brush.tiltResponse) }));
}

/** Pens finer than this are outlined scaled up to it (see `getStrokeOutline`). */
const OUTLINE_BASE_SIZE = 2;

/**
 * Every stroke is outlined at least this much scaled up, so the 3 units at its end that perfect-freehand passes over
 * are 0.75 page px, under a fine line's width: a small letter keeps its last curl (see `getStrokeOutline`).
 */
const OUTLINE_MIN_SCALE = 4;

/**
 * How far into a stroke (page px) the samples may be passed over before its direction is taken. perfect-freehand
 * passes over the stroke's whole width, which for a 2.5 px pen is the first quarter of a small letter's hook.
 */
const START_SKIP_PX = 0.5;

/**
 * The outline's corners are at most this far apart (page px) on a writing pen (up to `FINE_OUTLINE_MAX_SIZE`).
 * perfect-freehand spaces them `size × smoothing` apart, which on a 2.5 px ballpoint (drawn as a hard polygon) was a
 * corner every 1.25 px: facets on the tight curves of small letters, and a curve cut short across its inside.
 */
const OUTLINE_MAX_STEP_PX = 0.6;
const FINE_OUTLINE_MAX_SIZE = 6;

/** How much a stroke `size` wide is scaled up to be outlined. */
export function outlineScale(size: number): number {
  const fine = size > 0 && size < OUTLINE_BASE_SIZE ? OUTLINE_BASE_SIZE / size : 1;
  return Math.max(OUTLINE_MIN_SCALE, fine);
}

/**
 * Compute the outline polygon for a set of input samples.
 *
 * perfect-freehand works in the units it is given, and nearly everything it does is measured against the stroke's
 * size, except three things that cost small letters their shape (measured: on a 2.5 px pen, a fifth of the points an
 * "e" 10 px high was written through had no ink on them):
 *
 * - it passes over the samples in the last 3 units of a stroke, a fixed number. The stroke is outlined scaled up
 *   (`outlineScale`: at least 4×, more for a pen finer than 2 px) and the outline scaled back, so those 3 units are
 *   0.75 page px;
 * - it passes over the samples in the first `size` units, before it takes the stroke's direction: the points are
 *   worked out here, passing over only `START_SKIP_PX` (except for a pen whose width comes from its speed, which
 *   is read from those first samples);
 * - it spaces the outline's corners `size × smoothing` apart: on a writing pen at most `OUTLINE_MAX_STEP_PX`.
 *
 * Everything else comes out as it would have: widths, pressure, tapers and the smoothing of the pen's path.
 */
export function getStrokeOutline(
  points: readonly InkPoint[],
  style: StrokeStyle,
  complete: boolean,
  caps: CapOverrides = {},
): Outline {
  if (points.length === 0) return [];
  const k = outlineScale(style.size);
  // The options for the stroke as it is, then scaled: the width and the tapers (lengths, worked out from the samples
  // as drawn, so a brush's speed-driven taper is what it would be unscaled).
  const plain = toFreehandOptions(style, complete, points, caps);
  const scaleTaper = (taper: number | boolean | undefined): number | boolean => (typeof taper === 'number' ? taper * k : (taper ?? 0));
  const options: StrokeOptions = {
    ...plain,
    size: style.size * k,
    start: { ...plain.start, taper: scaleTaper(plain.start?.taper) },
    end: { ...plain.end, taper: scaleTaper(plain.end?.taper) },
  };
  const smoothing =
    style.size <= FINE_OUTLINE_MAX_SIZE && style.size > 0 ? Math.min(plain.smoothing ?? 0.5, OUTLINE_MAX_STEP_PX / style.size) : plain.smoothing;
  // The samples scaled, as the arrays perfect-freehand turns objects into anyway: one pass, no second copy.
  const source = freehandSamples(points, style);
  const samples = new Array<[number, number, number]>(source.length);
  for (let i = 0; i < source.length; i++) {
    const p = source[i]!;
    samples[i] = [p.x * k, p.y * k, p.pressure ?? 0.5];
  }
  // A pen whose width comes from its speed reads that from the first samples, as perfect-freehand spaced them.
  const startSkip = style.simulatePressure ? style.size * k : Math.min(style.size, START_SKIP_PX) * k;
  const strokePoints = getStrokePoints(samples, { ...options, size: startSkip });
  const outline = getStrokeOutlinePoints(strokePoints, { ...options, ...(smoothing === undefined ? {} : { smoothing }) });
  return outline.map(([x, y]) => [x / k, y / k] as const);
}

/**
 * Convert an outline polygon to a closed `Path2D`.
 *
 * Smooth (the default): each vertex becomes the control point of a quadratic
 * curve ending at the midpoint to the next vertex — the construction
 * perfect-freehand's docs use for SVG paths. A ballpoint asks for `smooth:
 * false` instead, keeping the polygon's own hard edges.
 */
export function outlineToPath2D(outline: Outline, smooth = true): Path2D {
  const path = new Path2D();
  const n = outline.length;
  if (n === 0) return path;

  const first = outline[0];
  if (!first) return path;

  if (n < 3) {
    // Degenerate outline: perfect-freehand normally returns a full circle for a
    // single input point, so this only guards against pathological input.
    path.arc(first[0], first[1], 0.5, 0, Math.PI * 2);
    return path;
  }

  path.moveTo(first[0], first[1]);
  if (!smooth) {
    for (let i = 1; i < n; i++) {
      const p = outline[i];
      if (p) path.lineTo(p[0], p[1]);
    }
    path.closePath();
    return path;
  }
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    if (!a || !b) continue;
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}
