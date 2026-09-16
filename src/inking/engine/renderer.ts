import type { InkPoint, Stroke, StrokeStyle } from '../types';
import { getStrokeOutline, outlineToPath2D } from './strokeOutline';

/**
 * `desynchronized` lets Chromium present the canvas outside the compositor's
 * vsync pipeline, shaving a frame or more of pen-to-ink latency on Windows.
 * Browsers that don't support it ignore the hint.
 */
const CONTEXT_ATTRIBUTES: CanvasRenderingContext2DSettings = {
  alpha: true,
  desynchronized: true,
};

export function get2dContext(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  return canvas ? canvas.getContext('2d', CONTEXT_ATTRIBUTES) : null;
}

/**
 * Committed strokes never change, so their outline geometry is computed once
 * and cached for the lifetime of the object. A WeakMap keeps memory bound to
 * the strokes still referenced by history.
 */
const pathCache = new WeakMap<Stroke, Path2D>();

export function getStrokePath(stroke: Stroke): Path2D {
  let path = pathCache.get(stroke);
  if (!path) {
    path = outlineToPath2D(getStrokeOutline(stroke.points, stroke.style, true));
    pathCache.set(stroke, path);
  }
  return path;
}

export function fillStrokePath(ctx: CanvasRenderingContext2D, path: Path2D, style: StrokeStyle): void {
  ctx.save();
  ctx.globalCompositeOperation = style.compositeOperation;
  ctx.globalAlpha = style.opacity;
  ctx.fillStyle = style.color;
  // Outlines self-intersect at sharp turns; nonzero winding keeps them solid.
  ctx.fill(path, 'nonzero');
  ctx.restore();
}

export function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void {
  fillStrokePath(ctx, getStrokePath(stroke), stroke.style);
}

/** Render an in-progress stroke (no end cap, not cached). */
export function drawLiveStroke(
  ctx: CanvasRenderingContext2D,
  points: readonly InkPoint[],
  style: StrokeStyle,
): void {
  if (points.length === 0) return;
  fillStrokePath(ctx, outlineToPath2D(getStrokeOutline(points, style, false)), style);
}

/** Clear the whole surface. Expects the DPR transform to be set on `ctx`. */
export function clearSurface(ctx: CanvasRenderingContext2D, cssWidth: number, cssHeight: number): void {
  ctx.clearRect(0, 0, cssWidth, cssHeight);
}

/** Full redraw of the committed layer, skipping any ids in `hidden`. */
export function replayStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: readonly Stroke[],
  cssWidth: number,
  cssHeight: number,
  hidden?: ReadonlySet<string>,
): void {
  clearSurface(ctx, cssWidth, cssHeight);
  for (const stroke of strokes) {
    if (hidden && hidden.has(stroke.id)) continue;
    drawStroke(ctx, stroke);
  }
}

/** Ring that follows the pointer while an eraser tool is active. */
export function drawEraserCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(17, 17, 17, 0.6)';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  ctx.arc(x, y, Math.max(radius, 2), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
