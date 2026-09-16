import type { InkPoint, InkPointerType, InkTool, Stroke, StrokeStyle } from '../types';
import { createStrokeId } from './ids';

/**
 * Accumulates samples for the stroke currently being drawn and tracks its
 * bounding box incrementally, so `build()` is O(1) apart from freezing.
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
    readonly tool: InkTool,
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

  build(): Stroke {
    // Pad by the widest possible half-width plus anti-aliasing slop.
    const pad = this.style.size * 0.5 * (1 + Math.max(0, this.style.thinning)) + 2;
    return {
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
