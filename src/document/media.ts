/**
 * Pure media maths: placement, translation, rotation, anchored resize and
 * z-ordering. Units are page px; rotation is degrees clockwise about the box
 * centre (CSS convention, y down).
 *
 * Everything here is generic over `MediaBox`, so an image, a sticky note and
 * a table are dragged and resized by one implementation and the layer above
 * only has to decide how each one paints itself.
 */
import { createStrokeId } from '../inking/engine/ids';
import type { Point } from '../inking/types';
import {
  DEFAULT_NOTE_COLOR,
  DEFAULT_TABLE_COLUMNS,
  DEFAULT_TABLE_ROWS,
  IMAGE_MAX_FRACTION,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MIN_IMAGE_SIZE,
  NOTE_DEFAULT_SIZE,
  NOTE_GRIP_HEIGHT,
  NOTE_PADDING,
  TABLE_CELL_SIZE,
  TABLE_GRIP_HEIGHT,
} from './constants';
import type { ImageLayer, MediaBox, MediaObject, PageDimensions, StickyNote, TableLayer } from './types';

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Rotate a vector by `deg` clockwise (screen coordinates, y down). */
export function rotateVector(dx: number, dy: number, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

export function imageCenter(image: MediaBox): Point {
  return { x: image.x + image.width / 2, y: image.y + image.height / 2 };
}

export function normalizeDegrees(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

export function nextZIndex(images: readonly MediaBox[]): number {
  return images.reduce((max, img) => Math.max(max, img.zIndex), 0) + 1;
}

export interface CreateImageInit {
  readonly src: string;
  readonly mime: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly page: PageDimensions;
  /** Centre of the placed image; defaults to the page centre. */
  readonly at?: Point;
  readonly zIndex: number;
}

/** Place an image at natural size, shrunk uniformly to fit `IMAGE_MAX_FRACTION` of the page width. */
export function createImageLayer(init: CreateImageInit): ImageLayer {
  const maxWidth = init.page.width * IMAGE_MAX_FRACTION;
  const maxHeight = init.page.height * IMAGE_MAX_FRACTION;
  const natW = Math.max(1, init.naturalWidth);
  const natH = Math.max(1, init.naturalHeight);
  const fit = Math.min(1, maxWidth / natW, maxHeight / natH);
  const width = Math.max(MIN_IMAGE_SIZE, natW * fit);
  const height = Math.max(MIN_IMAGE_SIZE, natH * fit);
  const centre = init.at ?? { x: init.page.width / 2, y: init.page.height / 2 };
  return {
    kind: 'image',
    id: `img_${createStrokeId()}`,
    src: init.src,
    mime: init.mime,
    x: centre.x - width / 2,
    y: centre.y - height / 2,
    width,
    height,
    rotation: 0,
    zIndex: init.zIndex,
    naturalWidth: natW,
    naturalHeight: natH,
  };
}

export function moveImage<T extends MediaBox>(image: T, dx: number, dy: number): T {
  return dx === 0 && dy === 0 ? image : { ...image, x: image.x + dx, y: image.y + dy };
}

export function rotateImage<T extends MediaBox>(image: T, rotation: number): T {
  const r = normalizeDegrees(rotation);
  return r === image.rotation ? image : { ...image, rotation: r };
}

/** Which box edges a handle moves: −1 = min edge, +1 = max edge, 0 = neither. */
function handleAxes(handle: ResizeHandle): { hx: -1 | 0 | 1; hy: -1 | 0 | 1 } {
  const hx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const hy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  return { hx, hy };
}

/**
 * Resize by dragging `handle` by (`localDx`, `localDy`) — the pointer delta
 * expressed in the image's own (unrotated) frame. The opposite edge / corner
 * stays fixed in world space, which is what makes rotated boxes resize the
 * way users expect.
 */
export function resizeImage<T extends MediaBox>(
  image: T,
  handle: ResizeHandle,
  localDx: number,
  localDy: number,
  keepAspect: boolean,
  minSize = MIN_IMAGE_SIZE,
): T {
  const { hx, hy } = handleAxes(handle);
  const aspect = image.width / image.height;

  let width = image.width + hx * localDx;
  let height = image.height + hy * localDy;

  if (keepAspect) {
    if (hx !== 0 && hy !== 0) {
      // Corner: follow the axis the pointer moved most along.
      if (Math.abs(localDx) * image.height >= Math.abs(localDy) * image.width) height = width / aspect;
      else width = height * aspect;
    } else if (hx !== 0) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
  }

  width = Math.max(minSize, width);
  height = Math.max(minSize, height);
  if (keepAspect) {
    // Re-impose the ratio after clamping.
    if (width / height > aspect) width = height * aspect;
    else height = width / aspect;
  }

  // Anchor = the point opposite the handle (centre of the opposite edge, or the opposite corner).
  const centre = imageCenter(image);
  const anchorOffset = rotateVector((-hx * image.width) / 2, (-hy * image.height) / 2, image.rotation);
  const anchor = { x: centre.x + anchorOffset.x, y: centre.y + anchorOffset.y };
  const newOffset = rotateVector((-hx * width) / 2, (-hy * height) / 2, image.rotation);
  const newCentre = { x: anchor.x - newOffset.x, y: anchor.y - newOffset.y };

  return { ...image, x: newCentre.x - width / 2, y: newCentre.y - height / 2, width, height };
}

/** Convert a world (page) delta into the image's local frame. */
export function toLocalDelta(image: MediaBox, dx: number, dy: number): Point {
  return rotateVector(dx, dy, -image.rotation);
}

/** Point-in-rotated-box test in page px. */
export function pointInImage(image: MediaBox, p: Point): boolean {
  const c = imageCenter(image);
  const local = rotateVector(p.x - c.x, p.y - c.y, -image.rotation);
  return Math.abs(local.x) <= image.width / 2 && Math.abs(local.y) <= image.height / 2;
}

/** Handle positions in page px (world space) for the current rotation. */
export function handlePositions(image: MediaBox): Record<ResizeHandle, Point> {
  const c = imageCenter(image);
  const at = (hx: number, hy: number): Point => {
    const v = rotateVector((hx * image.width) / 2, (hy * image.height) / 2, image.rotation);
    return { x: c.x + v.x, y: c.y + v.y };
  };
  return { nw: at(-1, -1), n: at(0, -1), ne: at(1, -1), e: at(1, 0), se: at(1, 1), s: at(0, 1), sw: at(-1, 1), w: at(-1, 0) };
}

/** Rotation from the box centre to a pointer position, degrees clockwise, with the handle at the top. */
export function rotationFromPointer(image: MediaBox, p: Point, snapDeg = 0): number {
  const c = imageCenter(image);
  const deg = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
  const snapped = snapDeg > 0 ? Math.round(deg / snapDeg) * snapDeg : deg;
  return normalizeDegrees(snapped);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function renormalize<T extends MediaBox>(items: readonly T[]): T[] {
  return [...items]
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((item, i) => (item.zIndex === i + 1 ? item : { ...item, zIndex: i + 1 }));
}

export function sortedByZ<T extends MediaBox>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.zIndex - b.zIndex);
}

export function addImage<T extends MediaBox>(items: readonly T[], item: T): T[] {
  return renormalize([...items, { ...item, zIndex: nextZIndex(items) }]);
}

/**
 * Patch one object in place. The patch may not change what kind of thing it
 * is, nor its identity, so both are restored over whatever was passed.
 */
export function updateImage<T extends MediaBox>(items: readonly T[], id: string, patch: Partial<T>): T[] {
  const index = items.findIndex((item) => item.id === id);
  const current = items[index];
  if (!current) return [...items];
  const next = [...items];
  next[index] = { ...current, ...patch, id: current.id };
  return next;
}

export function removeImage<T extends MediaBox>(items: readonly T[], id: string): T[] {
  return renormalize(items.filter((item) => item.id !== id));
}

export function bringToFront<T extends MediaBox>(items: readonly T[], id: string): T[] {
  if (!items.some((item) => item.id === id)) return [...items];
  return renormalize(items.map((item) => (item.id === id ? { ...item, zIndex: nextZIndex(items) } : item)));
}

export function sendToBack<T extends MediaBox>(items: readonly T[], id: string): T[] {
  if (!items.some((item) => item.id === id)) return [...items];
  return renormalize(items.map((item) => (item.id === id ? { ...item, zIndex: 0 } : item)));
}

/** Parse a data URL into its MIME type and bytes. */
export function dataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] ?? 'application/octet-stream';
  const payload = m[3] ?? '';
  if (m[2]) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime, bytes };
  }
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}

// ---------------------------------------------------------------------------
// Sticky notes and tables
// ---------------------------------------------------------------------------

/** Where a new object lands when nothing says otherwise: the middle of the page. */
function placement(page: PageDimensions, width: number, height: number, at?: Point): Point {
  const centre = at ?? { x: page.width / 2, y: page.height / 2 };
  return { x: centre.x - width / 2, y: centre.y - height / 2 };
}

export function createStickyNote(page: PageDimensions, zIndex: number, at?: Point, color = DEFAULT_NOTE_COLOR): StickyNote {
  const { width, height } = NOTE_DEFAULT_SIZE;
  const { x, y } = placement(page, width, height, at);
  return { kind: 'note', id: `note_${createStrokeId()}`, x, y, width, height, rotation: 0, zIndex, text: '', color };
}

export function createTable(
  page: PageDimensions,
  zIndex: number,
  at?: Point,
  rows = DEFAULT_TABLE_ROWS,
  columns = DEFAULT_TABLE_COLUMNS,
): TableLayer {
  const r = clampTableCount(rows, MAX_TABLE_ROWS);
  const c = clampTableCount(columns, MAX_TABLE_COLUMNS);
  const width = c * TABLE_CELL_SIZE.width;
  const height = r * TABLE_CELL_SIZE.height;
  const { x, y } = placement(page, width, height, at);
  return {
    kind: 'table',
    id: `table_${createStrokeId()}`,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex,
    rows: r,
    columns: c,
    cells: Array.from({ length: r * c }, () => ''),
  };
}

function clampTableCount(value: number, max: number): number {
  return Math.min(max, Math.max(1, Math.round(Number.isFinite(value) ? value : 1)));
}

/** Index of a cell in the row-major `cells` array. */
export function cellIndex(table: Pick<TableLayer, 'columns'>, row: number, column: number): number {
  return row * table.columns + column;
}

export function tableCell(table: TableLayer, row: number, column: number): string {
  return table.cells[cellIndex(table, row, column)] ?? '';
}

export function setTableCell(table: TableLayer, row: number, column: number, value: string): TableLayer {
  const index = cellIndex(table, row, column);
  if (index < 0 || index >= table.cells.length) return table;
  const cells = [...table.cells];
  cells[index] = value;
  return { ...table, cells };
}

/**
 * Reshape a table to `rows` × `columns`, keeping whatever text still has a
 * cell to live in. Growing widens the box by a column's worth so the cells
 * keep their size rather than being squeezed; shrinking gives that back.
 */
export function resizeTable(table: TableLayer, rows: number, columns: number): TableLayer {
  const r = clampTableCount(rows, MAX_TABLE_ROWS);
  const c = clampTableCount(columns, MAX_TABLE_COLUMNS);
  if (r === table.rows && c === table.columns) return table;
  const cells: string[] = [];
  for (let row = 0; row < r; row++) {
    for (let column = 0; column < c; column++) {
      cells.push(row < table.rows && column < table.columns ? tableCell(table, row, column) : '');
    }
  }
  return {
    ...table,
    rows: r,
    columns: c,
    cells,
    width: (table.width / table.columns) * c,
    height: (table.height / table.rows) * r,
  };
}

export function addTableRow(table: TableLayer): TableLayer {
  return resizeTable(table, table.rows + 1, table.columns);
}

export function removeTableRow(table: TableLayer): TableLayer {
  return resizeTable(table, table.rows - 1, table.columns);
}

export function addTableColumn(table: TableLayer): TableLayer {
  return resizeTable(table, table.rows, table.columns + 1);
}

export function removeTableColumn(table: TableLayer): TableLayer {
  return resizeTable(table, table.rows, table.columns - 1);
}

/** Locked media ignores every drag; the lock button is the only way back. */
export function isLocked(item: MediaObject): boolean {
  return item.locked === true;
}

// ---------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------

/**
 * Break text into lines that fit `maxWidth`, honouring the newlines already
 * in it. `measure` is supplied by the caller because the three renderers ask
 * different things — a canvas context, a PDF font, or nothing at all in a
 * test — and none of them belong in this module.
 *
 * A single word longer than the line is broken mid-word rather than allowed
 * to overflow: a URL in a sticky note should look cramped, not run off it.
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/).filter((w) => w !== '')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (line !== '' && measure(candidate) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
      while (measure(line) > maxWidth && line.length > 1) {
        // Still too wide on its own: peel off what fits and carry the rest.
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line !== '') lines.push(line);
  }
  return lines;
}

/** The text area inside a note's card, below its grip and inside its padding. */
export function noteTextBox(note: StickyNote): { x: number; y: number; width: number; height: number } {
  return {
    x: note.x + NOTE_PADDING,
    y: note.y + NOTE_GRIP_HEIGHT + NOTE_PADDING,
    width: Math.max(1, note.width - NOTE_PADDING * 2),
    height: Math.max(1, note.height - NOTE_GRIP_HEIGHT - NOTE_PADDING * 2),
  };
}

/** The grid area of a table, below its grip. */
export function tableGridBox(table: TableLayer): { x: number; y: number; width: number; height: number } {
  return {
    x: table.x,
    y: table.y + TABLE_GRIP_HEIGHT,
    width: table.width,
    height: Math.max(1, table.height - TABLE_GRIP_HEIGHT),
  };
}

/** Box of one cell in page px, in the table's unrotated frame. */
export function tableCellBox(table: TableLayer, row: number, column: number): { x: number; y: number; width: number; height: number } {
  const grid = tableGridBox(table);
  const width = grid.width / table.columns;
  const height = grid.height / table.rows;
  return { x: grid.x + column * width, y: grid.y + row * height, width, height };
}
