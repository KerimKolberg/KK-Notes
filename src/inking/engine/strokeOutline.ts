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
import { getStroke, type StrokeOptions } from 'perfect-freehand';
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
  if (!brush || brush.tiltResponse === 0) return points as readonly FreehandPoint[];
  let tilted = false;
  for (const p of points) {
    if (p.tilt) {
      tilted = true;
      break;
    }
  }
  if (!tilted) return points as readonly FreehandPoint[];
  return points.map((p) => ({ x: p.x, y: p.y, pressure: pencilPressure(p.pressure, p.tilt ?? 0, brush.tiltResponse) }));
}

/** Compute the outline polygon for a set of input samples. */
export function getStrokeOutline(
  points: readonly InkPoint[],
  style: StrokeStyle,
  complete: boolean,
  caps: CapOverrides = {},
): Outline {
  if (points.length === 0) return [];
  // perfect-freehand accepts `{x, y, pressure}` objects directly; InkPoint is
  // structurally compatible so no per-frame allocation is needed here.
  return getStroke(freehandSamples(points, style) as FreehandPoint[], toFreehandOptions(style, complete, points, caps));
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
