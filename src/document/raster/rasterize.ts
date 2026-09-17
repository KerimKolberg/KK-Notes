/**
 * Page → bitmap. Pure with respect to the DOM apart from canvas creation, so
 * it runs identically on the main thread and inside a worker. Images are
 * decoded from their data URLs (cached), and PDF pages pass in a pre-rendered
 * background bitmap because PDF.js only runs on the main thread here.
 */
import { drawStroke, type InkContext } from '../../inking/engine/renderer';
import { sortedByZ } from '../media';
import { drawTemplate } from '../templates';
import type { ImageLayer, PageDimensions, PageVisual } from '../types';

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

const IMAGE_CACHE_LIMIT = 32;
const imageBitmaps = new Map<string, Promise<ImageBitmap>>();

/** Decode an image data URL to a bitmap (cached per source string). */
export function loadImageBitmap(src: string): Promise<ImageBitmap> {
  let pending = imageBitmaps.get(src);
  if (!pending) {
    if (imageBitmaps.size >= IMAGE_CACHE_LIMIT) imageBitmaps.clear();
    pending = fetch(src)
      .then((r) => r.blob())
      .then((blob) => createImageBitmap(blob));
    pending.catch(() => imageBitmaps.delete(src));
    imageBitmaps.set(src, pending);
  }
  return pending;
}

/** Draw placed images in z order; failures are skipped. */
export function drawImageLayers(ctx: InkContext, images: readonly ImageLayer[], bitmaps: ReadonlyMap<string, ImageBitmap>): void {
  for (const image of sortedByZ(images)) {
    const bitmap = bitmaps.get(image.id);
    if (!bitmap || bitmap.width === 0) continue;
    ctx.save();
    ctx.translate(image.x + image.width / 2, image.y + image.height / 2);
    ctx.rotate((image.rotation * Math.PI) / 180);
    ctx.drawImage(bitmap, -image.width / 2, -image.height / 2, image.width, image.height);
    ctx.restore();
  }
}

async function loadImages(images: readonly ImageLayer[]): Promise<Map<string, ImageBitmap>> {
  const out = new Map<string, ImageBitmap>();
  await Promise.all(
    images.map(async (image) => {
      try {
        out.set(image.id, await loadImageBitmap(image.src));
      } catch {
        /* undecodable image: leave a gap */
      }
    }),
  );
  return out;
}

/**
 * Paint background (template or PDF raster), images and strokes at `scale`
 * device px per page unit.
 */
export async function paintPage(ctx: InkContext, page: PageVisual, scale: number, background?: ImageBitmap): Promise<void> {
  const bitmaps = await loadImages(page.images);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (background && background.width > 0) {
    ctx.fillStyle = page.backgroundColor;
    ctx.fillRect(0, 0, page.dimensions.width, page.dimensions.height);
    const drawnHeight = (background.height * page.dimensions.width) / background.width;
    ctx.drawImage(background, 0, 0, page.dimensions.width, drawnHeight);
  } else {
    drawTemplate(ctx, page);
  }
  drawImageLayers(ctx, page.images, bitmaps);
  for (const stroke of page.strokes) drawStroke(ctx, stroke);
}

export async function rasterizePage(page: PageVisual, targetWidth: number, background?: ImageBitmap): Promise<ImageBitmap> {
  const { width, height, scale } = rasterSize(page.dimensions, targetWidth);
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    await paintPage(ctx, page, scale, background);
    return canvas.transferToImageBitmap();
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  await paintPage(ctx, page, scale, background);
  return createImageBitmap(canvas);
}
