import { getRasterClient } from '../document/raster/rasterClient';
import type { Page } from '../document/types';
import { createStrokeId } from '../inking/engine/ids';
import { snipScale, type Rect } from './geometry';
import type { Snip } from './snipStore';

/**
 * Cut a region (in page units) out of a page as it looks: its background (a PDF's own page included), objects and
 * ink. The page is drawn at the sharpness the region wants and the region cropped from that, because the page
 * rasteriser draws whole pages.
 */
export async function snipPage(page: Page, region: Rect, from: string): Promise<Snip> {
  const scale = snipScale(region.width, page.dimensions.width);
  const bitmap = await getRasterClient().request(page, Math.round(page.dimensions.width * scale));
  try {
    // The bitmap's own scale, which rounding the width may have nudged.
    const k = bitmap.width / page.dimensions.width;
    const sx = Math.max(0, Math.round(region.x * k));
    const sy = Math.max(0, Math.round(region.y * k));
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(region.width * k)));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(region.height * k)));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    return {
      id: `snip_${createStrokeId()}`,
      src: canvas.toDataURL('image/png'),
      width: sw,
      height: sh,
      unitsWidth: region.width,
      unitsHeight: region.height,
      from,
    };
  } finally {
    bitmap.close();
  }
}
