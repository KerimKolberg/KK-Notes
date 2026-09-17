/**
 * LRU cache of rendered bitmaps keyed by page visuals + target width. Evicted
 * bitmaps are closed to release GPU memory.
 */
import type { Stroke } from '../../inking/types';
import { RASTER_CACHE_SIZE } from '../constants';
import type { ImageLayer, PageVisual } from '../types';

const arrayIds = new WeakMap<object, number>();
let nextArrayId = 1;

/** Cheap identity token for an immutable array. */
export function arrayToken(array: readonly unknown[]): number {
  let id = arrayIds.get(array);
  if (id === undefined) {
    id = nextArrayId++;
    arrayIds.set(array, id);
  }
  return id;
}

/** Cheap identity token for an immutable stroke array. */
export function strokesToken(strokes: readonly Stroke[]): number {
  return arrayToken(strokes);
}

export function imagesToken(images: readonly ImageLayer[]): number {
  return images.length === 0 ? 0 : arrayToken(images);
}

/** Key that changes whenever the page would render differently at `targetWidth`. */
export function visualKey(pageId: string, page: PageVisual, targetWidth: number): string {
  const c = page.templateConfig;
  return [
    pageId,
    Math.round(targetWidth),
    page.dimensions.width,
    page.dimensions.height,
    page.template,
    page.backgroundColor,
    c.spacing,
    c.strokeColor,
    c.strokeWidth,
    c.marginOffset ?? '',
    strokesToken(page.strokes),
    imagesToken(page.images),
    page.pdf ? `${page.pdf.sourceId}#${page.pdf.pageIndex}@${page.pdf.rotation}` : '',
  ].join('|');
}

export class RasterCache {
  private readonly entries = new Map<string, ImageBitmap>();

  constructor(private readonly capacity = RASTER_CACHE_SIZE) {}

  get(key: string): ImageBitmap | null {
    const bitmap = this.entries.get(key);
    if (!bitmap) return null;
    if (bitmap.width === 0) {
      // Closed elsewhere; drop it so callers re-render.
      this.entries.delete(key);
      return null;
    }
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, bitmap);
    return bitmap;
  }

  set(key: string, bitmap: ImageBitmap): void {
    const existing = this.entries.get(key);
    if (existing && existing !== bitmap) existing.close();
    this.entries.delete(key);
    this.entries.set(key, bitmap);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.get(oldest)?.close();
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export const rasterCache = new RasterCache();
