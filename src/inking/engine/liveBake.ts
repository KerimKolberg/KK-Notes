/**
 * Drawing a long stroke while the pen is still on it, without drawing all of it again.
 *
 * The live layer used to be cleared and the whole stroke outlined and filled again on
 * every frame. That is cheap for a word and dear for a scribble: a mouse reports up
 * to a thousand times a second, a long scribble is thousands of samples, and each
 * frame paid for every one of them — the outline is computed from all the samples
 * and the path it makes is filled from all of them — so a frame at the end of a
 * scribble cost many times one at the start, on the hardware least able to spare it
 * and at a refresh rate that leaves five milliseconds to do it in.
 *
 * Instead the stroke is **baked** a chunk at a time. Once the samples run `CHUNK` past
 * the last bake, the run of them behind is drawn once and left on the live canvas,
 * never cleared. Each frame draws only what has come since — a tail of at most a
 * chunk and a bit, however long the stroke is — and draws it on a canvas of its own
 * above that one, which *is* cleared every frame. (The tail cannot go on the baked
 * canvas: its outline shifts a little each frame as samples arrive, and painted over
 * and over without clearing those shifts add up, a hundred frames of fringe that made
 * a fine pen visibly fatter than the stroke it was becoming.) Each piece reaches
 * `OVERLAP` samples back into the one before, and each bake looks `LOOKAHEAD` samples
 * past its end so the outline has settled there, so the joins are covered rather
 * than butted. The tail's canvas is made when a stroke first needs it and taken away
 * when the stroke ends, so a page of short strokes pays for no third layer.
 *
 * That is only invisible for ink that can be drawn twice without showing: fully
 * opaque, source-over, a plain even outline. Anything that blends, fades, textures,
 * bleeds, tapers or depends on the stroke as a whole — the highlighter, the pencil, the
 * fountain pen, a pattern, an arrowhead, a gradient — keeps redrawing in full, as
 * before (`canBakeLive`). And the committed stroke is still drawn the old way, as one
 * outline, when the pen lifts: this is only what is shown on the way.
 */
import type { InkPoint, StrokeStyle } from '../types';
import { strokeBrush } from './brushes';
import { clearSurface, drawLiveStroke, get2dContext } from './renderer';

/** Samples a bake adds to what is permanently on the canvas. */
export const BAKE_CHUNK = 96;
/** Samples past the end of a bake that shape its outline without being part of it. */
export const BAKE_LOOKAHEAD = 12;
/** Samples a piece reaches back into the one before it. */
export const BAKE_OVERLAP = 8;

/**
 * Whether a stroke in this style can be baked: the same ink drawn twice over the same
 * place has to look exactly like once.
 */
export function canBakeLive(style: StrokeStyle): boolean {
  if (style.compositeOperation !== 'source-over' || style.opacity < 1) return false;
  if (style.simulatePressure) return false; // pressure is worked out from the whole run
  if (style.pattern !== 'solid' || style.arrowheads !== 'none') return false;
  if (style.gradient || style.tape) return false;
  if (style.taperStart > 0 || style.taperEnd > 0) return false;
  const brush = strokeBrush(style);
  if (brush) {
    if (brush.texture !== 'none' || brush.bleed > 0 || brush.softness > 0) return false;
    if (brush.velocityTaper > 0 || brush.tiltResponse > 0 || brush.velocityWidth) return false;
  }
  return true;
}

/** One piece to draw: the samples `from` to `to` (exclusive). */
export interface BakeRange {
  readonly from: number;
  readonly to: number;
}

/**
 * The pieces to bake now, given `count` samples and `baked` of them already on the
 * canvas, and how many are baked once they are done.
 */
export function planBakes(count: number, baked: number): { readonly ranges: readonly BakeRange[]; readonly baked: number } {
  const ranges: BakeRange[] = [];
  let done = baked;
  while (count - done >= BAKE_CHUNK + BAKE_LOOKAHEAD) {
    ranges.push({ from: Math.max(0, done - BAKE_OVERLAP), to: done + BAKE_CHUNK + BAKE_LOOKAHEAD });
    done += BAKE_CHUNK;
  }
  return { ranges, baked: done };
}

/** The part drawn afresh on every frame: everything since the last bake, and a little before it. */
export function tailStart(baked: number): number {
  return Math.max(0, baked - BAKE_OVERLAP);
}

/**
 * Draws the stroke in progress onto the live layer, baking as it goes. One per
 * surface; `paint` is called every frame while a stroke of a bakeable style is down,
 * and `reset` whenever the layer is used for anything else.
 */
export class LiveBaker {
  private baked = 0;
  private dirty = true;
  private owner: object | null = null;
  private sizeKey = '';
  private tail: HTMLCanvasElement | null = null;

  /**
   * Forget what is on the canvas — the next `paint` starts from a clean one — and
   * take the tail's canvas away. Does not touch the live canvas itself.
   */
  reset(): void {
    this.baked = 0;
    this.dirty = true;
    this.owner = null;
    this.tail?.remove();
    this.tail = null;
  }

  /** A canvas exactly over `live`, for the part of the stroke that is redrawn every frame. */
  private tailContext(live: HTMLCanvasElement, size: { readonly cssWidth: number; readonly cssHeight: number }): CanvasRenderingContext2D | null {
    if (!this.tail) {
      if (typeof document === 'undefined' || !live.parentNode) return null;
      const tail = document.createElement('canvas');
      tail.setAttribute('data-layer', 'tail');
      tail.setAttribute('aria-hidden', 'true');
      tail.width = live.width;
      tail.height = live.height;
      Object.assign(tail.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: live.style.width,
        height: live.style.height,
        pointerEvents: 'none',
        display: 'block',
      });
      live.after(tail);
      // The same scale the live canvas draws under: page units onto device pixels.
      get2dContext(tail)?.setTransform(live.width / size.cssWidth, 0, 0, live.height / size.cssHeight, 0, 0);
      this.tail = tail;
    }
    return get2dContext(this.tail);
  }

  /** How many samples are permanently on the canvas. */
  get bakedCount(): number {
    return this.baked;
  }

  /**
   * `owner` is whatever identifies the stroke (its session): a different one starts
   * over. So does a canvas that changed size, which the browser cleared.
   */
  paint(
    ctx: CanvasRenderingContext2D,
    owner: object,
    points: readonly InkPoint[],
    style: StrokeStyle,
    size: { readonly cssWidth: number; readonly cssHeight: number; readonly dpr?: number },
  ): void {
    const key = `${size.cssWidth}x${size.cssHeight}@${size.dpr ?? 1}`;
    if (this.owner !== owner || this.sizeKey !== key) {
      this.reset();
      this.owner = owner;
      this.sizeKey = key;
    }
    if (this.dirty) {
      clearSurface(ctx, size.cssWidth, size.cssHeight);
      this.dirty = false;
    }
    const plan = planBakes(points.length, this.baked);
    for (const range of plan.ranges) drawLiveStroke(ctx, points.slice(range.from, range.to), style);
    this.baked = plan.baked;
    const tailCtx = this.baked === 0 ? null : this.tailContext(ctx.canvas, size);
    if (!tailCtx) {
      // Nothing is permanent yet, and the stroke is short: clear and draw it whole.
      // (Or there is nowhere to put a tail layer, which is the same thing done slowly.)
      if (this.baked > 0) this.baked = 0;
      clearSurface(ctx, size.cssWidth, size.cssHeight);
      drawLiveStroke(ctx, points, style);
      return;
    }
    clearSurface(tailCtx, size.cssWidth, size.cssHeight);
    drawLiveStroke(tailCtx, points.slice(tailStart(this.baked)), style);
  }
}
