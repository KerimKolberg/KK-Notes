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

  constructor(
    readonly tool: PersistentFreehandTool,
    readonly style: StrokeStyle,
    readonly pointerType: InkPointerType,
  ) {}

  get points(): readonly InkPoint[] {
    return this.samples;
  }

  get last(): InkPoint | undefined {
    return this.samples[this.samples.length - 1];
  }

  /** Append a sample; consecutive duplicates (same position) are dropped. */
  add(point: InkPoint): void {
    const prev = this.last;
    if (prev && prev.x === point.x && prev.y === point.y) return;
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
