/**
 * Turning a document's first page into a card image.
 *
 * The page arrives as raw `SerializedPage` JSON — the shape on disk — and is
 * hydrated on its own rather than as part of a document, which is what keeps
 * the rest of the file out of memory. A page that references an imported PDF
 * is drawn without it: the PDF sources are the biggest thing in a `.notex` and
 * fetching one to render a 200 px card would undo the whole point, so the card
 * shows the page's template and ink over its background colour, which is
 * enough to recognise a notebook by.
 */
import { fromSerializablePage } from '../document/serialization';
import { rasterizePage } from '../document/raster/rasterize';
import type { PageVisual, SerializedPage } from '../document/types';

/** Width of a rendered card image in CSS px, before the device pixel ratio. */
export const CARD_WIDTH = 220;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The visual half of a serialized page, or `null` when it is not one.
 *
 * Returns `PageVisual` rather than a full `Page` because that is all the
 * renderer needs, and because a document's page numbering is not knowable
 * from one page anyway.
 */
export function pageVisualFrom(raw: unknown): PageVisual | null {
  if (!isRecord(raw)) return null;
  if (!isRecord(raw.dimensions) || typeof raw.dimensions.width !== 'number' || typeof raw.dimensions.height !== 'number') {
    return null;
  }
  // Check the lists here rather than letting the renderer discover them. The
  // hydrator passes an unexpected shape straight through, so a page with, say,
  // a string where its strokes should be would throw deep inside the
  // rasteriser instead of failing once, at the boundary, where the card can
  // simply fall back to a blank sheet.
  for (const key of ['strokes', 'media', 'images'] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) return null;
  }
  try {
    // `pdf` is dropped deliberately: without its source the hydrator would
    // throw, and fetching the source is exactly the cost being avoided.
    const { pdf: _pdf, ...rest } = raw as unknown as SerializedPage;
    const page = fromSerializablePage(rest as SerializedPage, 0);
    return {
      dimensions: page.dimensions,
      template: page.template,
      templateConfig: page.templateConfig,
      backgroundColor: page.backgroundColor,
      strokes: page.strokes,
      media: page.media,
    };
  } catch {
    // A page from a newer version, or a corrupt one. The card falls back to a
    // blank sheet rather than taking the whole library down with it.
    return null;
  }
}

/** Render a first page to a PNG data URL for a card. */
export async function renderCardImage(raw: unknown, width = CARD_WIDTH): Promise<string | null> {
  const visual = pageVisualFrom(raw);
  if (!visual) return null;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const bitmap = await rasterizePage(visual, Math.round(width * dpr));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    // The bitmap has served its purpose; holding one per card is what a
    // library of a hundred notebooks cannot afford.
    bitmap.close();
  }
}

/** The aspect ratio to reserve for a card before its image arrives. */
export function cardAspect(raw: unknown): string {
  const visual = pageVisualFrom(raw);
  if (!visual) return '794 / 1123';
  return `${visual.dimensions.width} / ${visual.dimensions.height}`;
}
