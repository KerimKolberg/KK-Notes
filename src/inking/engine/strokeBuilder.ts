import type {
  BBox,
  FreehandStroke,
  InkPoint,
  InkPointerType,
  PersistentFreehandTool,
  Point,
  StrokeStyle,
} from '../types';
import { brushPadding } from './brushes';
import { bboxFromPoints } from './geometry';
import { createStrokeId } from './ids';
import { arrowheadLength } from './shapes';
import { straightenTape } from './tape';
import { noiseScale } from './writingZoom';

/** Padding around a freehand path: widest half-width, arrowheads, anti-aliasing slop. */
export function freehandPadding(style: StrokeStyle): number {
  const arrow = style.arrowheads !== 'none' ? arrowheadLength(style.size) : 0;
  return style.size * 0.5 * (1 + Math.max(0, style.thinning)) + arrow + brushPadding(style) + 2;
}

/** Padded bounding box of a freehand stroke's points. */
export function freehandBBox(points: readonly Point[], style: StrokeStyle): BBox {
  return bboxFromPoints(points, freehandPadding(style));
}

/**
 * Samples closer than this to the last one kept are not kept, in page units.
 *
 * A mouse reports up to a thousand times a second and a touchpad a few hundred, and a
 * hand moving slowly (or a cursor resting) piles up samples a fraction of a pixel
 * apart. They add nothing a screen can show — a device pixel is half a page unit at
 * twice the scale — but each is a vertex in an outline that is derived and filled
 * again on every frame, so a long scribble made with a mouse cost several times what
 * the same scribble made with a pen did, and got dearer with every sample. Fast
 * strokes are untouched: their samples are already further apart than this.
 *
 * It is a distance on screen at 100 %: a stroke written zoomed in divides it by its
 * `writingZoom` (`writingZoom.ts`), or small writing at 400 % keeps one sample in five.
 */
export const MIN_SAMPLE_SPACING = 0.4;

/**
 * Accumulates samples for the freehand stroke currently being drawn and
 * tracks its bounding box incrementally, so `build()` is O(1) apart from
 * freezing. Ephemeral tools (the laser pointer) never use it — nothing they
 * draw may become a stroke.
 */
function rawBounds(points: readonly Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export class StrokeBuilder {
  readonly id: string = createStrokeId();
  readonly createdAt: number = performance.now();
  private readonly samples: InkPoint[] = [];
  private minX = Number.POSITIVE_INFINITY;
  private minY = Number.POSITIVE_INFINITY;
  private maxX = Number.NEGATIVE_INFINITY;
  private maxY = Number.NEGATIVE_INFINITY;
  /** The newest sample that was too close to the last one kept; the stroke still ends on it. */
  private held: InkPoint | null = null;
  /** The spacing for this stroke, squared (see the constructor). */
  private readonly spacingSq: number;

  constructor(
    readonly tool: PersistentFreehandTool,
    readonly style: StrokeStyle,
    readonly pointerType: InkPointerType,
  ) {
    // `MIN_SAMPLE_SPACING` on screen, whatever the zoom the stroke is written at; and a fine pen
    // keeps samples closer still, half its width apart, since its letters are smaller than a
    // coarse one's. Whichever keeps more.
    const spacing = Math.min(MIN_SAMPLE_SPACING / noiseScale(style), style.size * 0.5);
    this.spacingSq = spacing * spacing;
  }

  get points(): readonly InkPoint[] {
    return this.samples;
  }

  get last(): InkPoint | undefined {
    return this.samples[this.samples.length - 1];
  }

  /**
   * Append a sample; one within `MIN_SAMPLE_SPACING` of the last kept is held back
   * instead (which also drops exact duplicates). The held sample is put on the end
   * when the stroke is built, so the stroke finishes exactly where the pen did.
   */
  add(point: InkPoint): void {
    const prev = this.last;
    if (prev) {
      const dx = point.x - prev.x;
      const dy = point.y - prev.y;
      if (dx * dx + dy * dy < this.spacingSq) {
        if (dx !== 0 || dy !== 0) this.held = point;
        return;
      }
    }
    this.held = null;
    this.keep(point);
  }

  private keep(point: InkPoint): void {
    this.samples.push(point);
    if (point.x < this.minX) this.minX = point.x;
    if (point.y < this.minY) this.minY = point.y;
    if (point.x > this.maxX) this.maxX = point.x;
    if (point.y > this.maxY) this.maxY = point.y;
  }

  /**
   * The finished stroke.
   *
   * Washi tape is straightened here and nowhere else: the RDP pass is the
   * expensive part of that tool, and running it per frame during the drag
   * made long strips stutter. Committing the straightened path means the
   * stroke on the page, its snapshot and its PDF export all hold the same
   * geometry without any of them re-deriving it.
   */
  build(): FreehandStroke {
    // The pen's last position, if the last few samples were held back as too close.
    if (this.held) {
      const held = this.held;
      this.held = null;
      this.keep(held);
    }
    const points = straightenTape(this.samples, this.style);
    const pad = freehandPadding(this.style);
    // Straightening drops points, so the bounds have to come from what is
    // actually being committed rather than from what was drawn.
    const bounds =
      points === this.samples
        ? { minX: this.minX, minY: this.minY, maxX: this.maxX, maxY: this.maxY }
        : rawBounds(points);
    return {
      kind: 'freehand',
      id: this.id,
      tool: this.tool,
      points,
      style: this.style,
      bbox: {
        minX: bounds.minX - pad,
        minY: bounds.minY - pad,
        maxX: bounds.maxX + pad,
        maxY: bounds.maxY + pad,
      },
      pointerType: this.pointerType,
      createdAt: this.createdAt,
    };
  }
}
