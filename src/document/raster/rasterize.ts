/**
 * Page → bitmap. Pure with respect to the DOM apart from canvas creation, so
 * it runs identically on the main thread and inside a worker.
 */
import { drawStroke, type InkContext } from '../../inking/engine/renderer';
import { drawTemplate } from '../templates';
import type { PageDimensions, PageVisual } from '../types';

export interface RasterSize {
  readonly width: number;
  readonly height: number;
  /** Device pixels per page unit. */
  readonly scale: number;
}

export function rasterSize(dimensions: PageDimensions, targetWidth: number): RasterSize {
  const width = Math.max(1, Math.round(targetWidth));
  const scale = width / dimensions.width;
  return { width, height: Math.max(1, Math.round(dimensions.height * scale)), scale };
}

/** Paint background, template and strokes at `scale` device px per page unit. */
export function paintPage(ctx: InkContext, page: PageVisual, scale: number): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawTemplate(ctx, page);
  for (const stroke of page.strokes) drawStroke(ctx, stroke);
}

export async function rasterizePage(page: PageVisual, targetWidth: number): Promise<ImageBitmap> {
  const { width, height, scale } = rasterSize(page.dimensions, targetWidth);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    paintPage(ctx, page, scale);
    return canvas.transferToImageBitmap();
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  paintPage(ctx, page, scale);
  return createImageBitmap(canvas);
}
