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
import type { InkPoint, StrokeStyle } from '../types';

export type Outline = ReadonlyArray<readonly [number, number]>;

/** Map our persisted style onto perfect-freehand options. */
export function toFreehandOptions(style: StrokeStyle, complete: boolean): StrokeOptions {
  return {
    size: style.size,
    thinning: style.thinning,
    smoothing: style.smoothing,
    streamline: style.streamline,
    simulatePressure: style.simulatePressure,
    easing: (t) => t,
    start: { cap: true, taper: style.taperStart },
    end: { cap: true, taper: style.taperEnd },
    // `last: false` while the pen is down: the end is left "open" so the live
    // preview doesn't flash a cap that moves every frame.
    last: complete,
  };
}

/** Compute the outline polygon for a set of input samples. */
export function getStrokeOutline(
  points: readonly InkPoint[],
  style: StrokeStyle,
  complete: boolean,
): Outline {
  if (points.length === 0) return [];
  // perfect-freehand accepts `{x, y, pressure}` objects directly; InkPoint is
  // structurally compatible so no per-frame allocation is needed here.
  return getStroke(points as { x: number; y: number; pressure?: number }[], toFreehandOptions(style, complete));
}

/**
 * Convert an outline polygon to a smooth closed `Path2D`.
 *
 * Each vertex becomes the control point of a quadratic curve that ends at the
 * midpoint to the next vertex (the same construction perfect-freehand's docs
 * use for SVG paths).
 */
export function outlineToPath2D(outline: Outline): Path2D {
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
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    if (!a || !b) continue;
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}
