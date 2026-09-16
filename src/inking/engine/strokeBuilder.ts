import type { FreehandStroke, FreehandTool, InkPoint, InkPointerType, StrokeStyle } from '../types';
import { createStrokeId } from './ids';
import { arrowheadLength } from './shapes';

/**
 * Accumulates samples for the freehand stroke currently being drawn and
 * tracks its bounding box incrementally, so `build()` is O(1) apart from
 * freezing.
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
    readonly tool: FreehandTool,
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
    // Pad by the widest possible half-width, arrowheads and anti-aliasing slop.
    const arrow = this.style.arrowheads !== 'none' ? arrowheadLength(this.style.size) : 0;
    const pad = this.style.size * 0.5 * (1 + Math.max(0, this.style.thinning)) + arrow + 2;
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
