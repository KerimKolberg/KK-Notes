import type {
  BBox,
  FreehandStroke,
  InkPoint,
  InkPointerType,
  PersistentFreehandTool,
  Point,
  StrokeStyle,
} from '../types';
import { bboxFromPoints } from './geometry';
import { createStrokeId } from './ids';
import { arrowheadLength } from './shapes';

/** Padding around a freehand path: widest half-width, arrowheads, anti-aliasing slop. */
export function freehandPadding(style: StrokeStyle): number {
  const arrow = style.arrowheads !== 'none' ? arrowheadLength(style.size) : 0;
  return style.size * 0.5 * (1 + Math.max(0, style.thinning)) + arrow + 2;
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

  build(): FreehandStroke {
    const pad = freehandPadding(this.style);
    return {
      kind: 'freehand',
      id: this.id,
      tool: this.tool,
      points: this.samples,
      style: this.style,
      bbox: {
        minX: this.minX - pad,
        minY: this.minY - pad,
        maxX: this.maxX + pad,
        maxY: this.maxY + pad,
      },
      pointerType: this.pointerType,
      createdAt: this.createdAt,
    };
  }
}
