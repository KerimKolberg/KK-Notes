/**
 * Page → bitmap. Pure with respect to the DOM apart from canvas creation, so
 * it runs identically on the main thread and inside a worker. Images are
 * decoded from their data URLs (cached), and PDF pages pass in a pre-rendered
 * background bitmap because PDF.js only runs on the main thread here.
 */
import { drawStroke, type InkContext } from '../../inking/engine/renderer';
import {
  DEFAULT_TABLE_LINE_OPACITY,
  DEFAULT_TABLE_LINE_WIDTH,
  NOTE_FONT_SIZE,
  NOTE_GRIP_HEIGHT,
  NOTE_LINE_HEIGHT,
  NOTE_PADDING,
  TABLE_CELL_PADDING,
  TABLE_FONT_SIZE,
  TABLE_GRIP_HEIGHT,
} from '../constants';
import { columnFractions, noteTextBox, rowFractions, sortedByZ, tableCell, trackEdges, wrapText } from '../media';
import { drawTemplate } from '../templates';
import type { ImageLayer, MediaObject, PageDimensions, PageVisual, StickyNote, TableLayer } from '../types';

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

const MEDIA_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** The card of a sticky note, with its text laid out the way the DOM lays it out. */
function drawNote(ctx: InkContext, note: StickyNote): void {
  ctx.fillStyle = note.color;
  ctx.fillRect(0, 0, note.width, note.height);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
  ctx.fillRect(0, 0, note.width, NOTE_GRIP_HEIGHT);
  if (note.text === '') return;

  const box = noteTextBox(note);
  ctx.font = `${NOTE_FONT_SIZE}px ${MEDIA_FONT}`;
  ctx.fillStyle = '#27272a';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const lineHeight = NOTE_FONT_SIZE * NOTE_LINE_HEIGHT;
  const lines = wrapText(note.text, box.width, (t) => ctx.measureText(t).width);
  ctx.save();
  // The live note scrolls its overflow; a snapshot has no scrollbar, so clip
  // instead of spilling text out over the page.
  ctx.beginPath();
  ctx.rect(NOTE_PADDING, NOTE_GRIP_HEIGHT + NOTE_PADDING, box.width, box.height);
  ctx.clip();
  lines.forEach((line, i) => {
    ctx.fillText(line, NOTE_PADDING, NOTE_GRIP_HEIGHT + NOTE_PADDING + lineHeight * (i + 0.8));
  });
  ctx.restore();
}

/** A table's frame, cell grid and cell text, with its own tracks and ruling. */
function drawTable(ctx: InkContext, table: TableLayer): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, table.width, table.height);
  ctx.fillStyle = '#e4e4e7';
  ctx.fillRect(0, 0, table.width, TABLE_GRIP_HEIGHT);

  const gridHeight = Math.max(1, table.height - TABLE_GRIP_HEIGHT);
  // Dragged dividers are shares of the table, so a snapshot lands on the same
  // grid as the live page whatever size the bitmap is rendered at.
  const columnEdges = trackEdges(columnFractions(table)).map((f) => f * table.width);
  const rowEdges = trackEdges(rowFractions(table)).map((f) => TABLE_GRIP_HEIGHT + f * gridHeight);
  const lineWidth = table.lineWidth ?? DEFAULT_TABLE_LINE_WIDTH;
  const rule = `rgba(161, 161, 170, ${table.lineOpacity ?? DEFAULT_TABLE_LINE_OPACITY})`;

  ctx.strokeStyle = rule;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (const x of columnEdges) {
    ctx.moveTo(x, TABLE_GRIP_HEIGHT);
    ctx.lineTo(x, table.height);
  }
  for (const y of rowEdges) {
    ctx.moveTo(0, y);
    ctx.lineTo(table.width, y);
  }
  ctx.stroke();
  ctx.strokeRect(0, 0, table.width, table.height);

  ctx.font = `${TABLE_FONT_SIZE}px ${MEDIA_FONT}`;
  ctx.fillStyle = '#18181b';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let row = 0; row < table.rows; row++) {
    for (let column = 0; column < table.columns; column++) {
      const text = tableCell(table, row, column);
      if (text === '') continue;
      const x = columnEdges[column] ?? 0;
      const y = rowEdges[row] ?? TABLE_GRIP_HEIGHT;
      const cellWidth = (columnEdges[column + 1] ?? table.width) - x;
      const cellHeight = (rowEdges[row + 1] ?? table.height) - y;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cellWidth, cellHeight);
      ctx.clip();
      ctx.fillText(text, x + TABLE_CELL_PADDING, y + cellHeight / 2);
      ctx.restore();
    }
  }
}

/**
 * Draw placed media in z order. Notes and tables are HTML on a live page, but
 * a page far from the viewport is a bitmap — so they are painted here too, or
 * they would blink out of existence as the reader scrolls away from them.
 */
export function drawMediaLayers(ctx: InkContext, media: readonly MediaObject[], bitmaps: ReadonlyMap<string, ImageBitmap>): void {
  for (const item of sortedByZ(media)) {
    const bitmap = item.kind === 'image' ? bitmaps.get(item.id) : undefined;
    if (item.kind === 'image' && (!bitmap || bitmap.width === 0)) continue;
    ctx.save();
    ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
    ctx.rotate((item.rotation * Math.PI) / 180);
    ctx.translate(-item.width / 2, -item.height / 2);
    if (item.kind === 'image' && bitmap) ctx.drawImage(bitmap, 0, 0, item.width, item.height);
    else if (item.kind === 'note') drawNote(ctx, item);
    else if (item.kind === 'table') drawTable(ctx, item);
    ctx.restore();
  }
}

async function loadImages(media: readonly MediaObject[]): Promise<Map<string, ImageBitmap>> {
  const images = media.filter((item): item is ImageLayer => item.kind === 'image');
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
 * Paint background (template or PDF raster), media and strokes at `scale`
 * device px per page unit.
 */
export async function paintPage(ctx: InkContext, page: PageVisual, scale: number, background?: ImageBitmap): Promise<void> {
  const bitmaps = await loadImages(page.media);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (background && background.width > 0) {
    ctx.fillStyle = page.backgroundColor;
    ctx.fillRect(0, 0, page.dimensions.width, page.dimensions.height);
    const drawnHeight = (background.height * page.dimensions.width) / background.width;
    ctx.drawImage(background, 0, 0, page.dimensions.width, drawnHeight);
  } else {
    drawTemplate(ctx, page);
  }
  drawMediaLayers(ctx, page.media, bitmaps);
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
