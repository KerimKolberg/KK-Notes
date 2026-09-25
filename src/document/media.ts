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
  MIN_TRACK_FRACTION,
  NOTE_BUBBLE_RADIUS,
  NOTE_DEFAULT_SIZE,
  NOTE_GRIP_HEIGHT,
  NOTE_PADDING,
  NOTE_TAIL_HEIGHT,
  NOTE_TAIL_WIDTH,
  TABLE_CELL_SIZE,
  TABLE_GRIP_HEIGHT,
} from './constants';
import type {
  ImageLayer,
  MediaBox,
  MediaObject,
  NoteShape,
  PageDimensions,
  StickyNote,
  TableLayer,
  TextAlign,
  TextBox,
  TextFontId,
  TextStyle,
} from './types';

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

export interface NoteInit {
  readonly color?: string;
  readonly shape?: NoteShape;
}

export function createStickyNote(page: PageDimensions, zIndex: number, at?: Point, init: NoteInit = {}): StickyNote {
  const { width, height } = NOTE_DEFAULT_SIZE;
  const { x, y } = placement(page, width, height, at);
  return {
    kind: 'note',
    id: `note_${createStrokeId()}`,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex,
    text: '',
    color: init.color ?? DEFAULT_NOTE_COLOR,
    shape: init.shape ?? 'rectangle',
  };
}

// ---------------------------------------------------------------------------
// Text boxes
// ---------------------------------------------------------------------------

/**
 * The three families, each with the CSS that draws it and the PDF base-14
 * name for every weight/slant combination.
 *
 * Both halves live here, together, on purpose: the whole reason the catalogue
 * is closed is that a family the screen can render but the export cannot embed
 * would silently come out as something else. Keeping the mapping in one table
 * makes that impossible to forget when adding one.
 */
export const TEXT_FONTS: readonly {
  readonly id: TextFontId;
  readonly label: string;
  readonly css: string;
  /**
   * PDF base-14 font *names* — regular, bold, italic, bold italic.
   *
   * The values pdf-lib's `StandardFonts` enum holds, not its key names: they
   * are hyphenated (`Helvetica-Bold`, `Times-Roman`), and anything else is
   * taken for a custom font and rejected for want of a fontkit instance.
   */
  readonly pdf: readonly [string, string, string, string];
}[] = [
  {
    id: 'sans',
    label: 'Sans',
    css: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    pdf: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  },
  {
    id: 'serif',
    label: 'Serif',
    css: 'Georgia, "Times New Roman", Times, serif',
    pdf: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  },
  {
    id: 'mono',
    label: 'Mono',
    css: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    pdf: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
  },
];

/** Sizes offered in the toolbar, in page px. */
export const TEXT_SIZES: readonly number[] = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64];

export const DEFAULT_TEXT_STYLE: Readonly<TextStyle> = {
  fontFamily: 'sans',
  fontSize: 16,
  color: '#18181b',
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  align: 'left',
};

/** A new box, sized for a line or two at the default size. */
export const TEXT_DEFAULT_SIZE = { width: 260, height: 80 } as const;

/** Leading, as a multiple of the font size. Shared by the DOM and the export. */
export const TEXT_LINE_HEIGHT = 1.35;

export function fontById(id: TextFontId): (typeof TEXT_FONTS)[number] {
  return TEXT_FONTS.find((font) => font.id === id) ?? TEXT_FONTS[0]!;
}

/**
 * The PDF base-14 name for a style.
 *
 * Bold and italic are separate *fonts* in PDF, not attributes of one — there
 * is no "make this bold" — so the combination has to be resolved to a name
 * before anything is drawn.
 */
export function pdfFontName(style: Pick<TextStyle, 'fontFamily' | 'bold' | 'italic'>): string {
  const [regular, bold, italic, boldItalic] = fontById(style.fontFamily).pdf;
  if (style.bold && style.italic) return boldItalic;
  if (style.bold) return bold;
  if (style.italic) return italic;
  return regular;
}

/** The style as CSS, for the textarea and for anything measuring it. */
export function textCss(style: TextStyle): {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  textDecorationLine: string;
  color: string;
  textAlign: TextAlign;
} {
  const decorations = [style.underline ? 'underline' : '', style.strikethrough ? 'line-through' : ''].filter(Boolean);
  return {
    fontFamily: fontById(style.fontFamily).css,
    fontSize: style.fontSize,
    lineHeight: TEXT_LINE_HEIGHT,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? 'italic' : 'normal',
    // `none` rather than `''`: an empty string leaves whatever the browser's
    // default decoration for the element is.
    textDecorationLine: decorations.length > 0 ? decorations.join(' ') : 'none',
    color: style.color,
    textAlign: style.align,
  };
}

/** Everything a stored box might be missing, for files written before it had it. */
export function textStyleOf(box: TextBox): TextStyle {
  return {
    fontFamily: box.fontFamily ?? DEFAULT_TEXT_STYLE.fontFamily,
    fontSize: Number.isFinite(box.fontSize) && box.fontSize > 0 ? box.fontSize : DEFAULT_TEXT_STYLE.fontSize,
    color: box.color || DEFAULT_TEXT_STYLE.color,
    bold: box.bold === true,
    italic: box.italic === true,
    underline: box.underline === true,
    strikethrough: box.strikethrough === true,
    align: box.align ?? DEFAULT_TEXT_STYLE.align,
  };
}

/**
 * The minimum a finger can reliably hit, in CSS px.
 *
 * Android's own guidance is 48dp and Apple's is 44pt; 44 is the number both
 * agree is enough, and it is what the palette's own buttons use. Anything
 * grabbable on the page is measured against it.
 */
export const TOUCH_TARGET = 44;

/**
 * Where a text box's drag strip sits, and how big it is.
 *
 * In *screen* px rather than page px, which is the whole point: a strip
 * measured in page units shrinks with the zoom, so the gesture that works on
 * one page is unusable on the overview. Dividing by the zoom keeps the target
 * the same size under the finger whatever the page is doing.
 *
 * It sits above the box rather than over it because a text box is all text —
 * a strip laid on top would eat the first line's taps.
 */
export function textGrabStrip(zoom: number): { readonly height: number; readonly top: number } {
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const height = TOUCH_TARGET / scale;
  return { height, top: -height };
}

export type TextInit = Partial<TextStyle>;

export function createTextBox(page: PageDimensions, zIndex: number, at?: Point, init: TextInit = {}): TextBox {
  const { width, height } = TEXT_DEFAULT_SIZE;
  const { x, y } = placement(page, width, height, at);
  return {
    kind: 'text',
    id: `text_${createStrokeId()}`,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex,
    text: '',
    ...DEFAULT_TEXT_STYLE,
    ...init,
  };
}

export interface TableInit {
  readonly rows?: number;
  readonly columns?: number;
  readonly lineWidth?: number;
  readonly lineOpacity?: number;
}

export function createTable(page: PageDimensions, zIndex: number, at?: Point, init: TableInit = {}): TableLayer {
  const { rows = DEFAULT_TABLE_ROWS, columns = DEFAULT_TABLE_COLUMNS } = init;
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
    ...(init.lineWidth === undefined ? {} : { lineWidth: init.lineWidth }),
    ...(init.lineOpacity === undefined ? {} : { lineOpacity: init.lineOpacity }),
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
    columnFractions: reshapeFractions(columnFractions(table), c),
    rowFractions: reshapeFractions(rowFractions(table), r),
    width: (table.width / table.columns) * c,
    height: (table.height / table.rows) * r,
  };
}

/**
 * Fit a set of track shares to a new track count: keep the ones that survive,
 * give a new track the average share, and renormalise. A dragged layout is
 * therefore preserved across adding and removing rows or columns.
 */
function reshapeFractions(fractions: readonly number[], count: number): number[] {
  if (count === fractions.length) return [...fractions];
  const average = 1 / Math.max(1, count);
  const next = Array.from({ length: count }, (_, i) => fractions[i] ?? average);
  const total = next.reduce((sum, f) => sum + f, 0);
  return total > 0 ? next.map((f) => f / total) : evenFractions(count);
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

// ---------------------------------------------------------------------------
// Note shapes
// ---------------------------------------------------------------------------

/** The outline of a note, defaulting to the rectangle older notes are. */
export function noteShapeOf(note: StickyNote): NoteShape {
  return note.shape ?? 'rectangle';
}

/**
 * The drag lip across the top of the card — rectangles only.
 *
 * A full-width bar clipped to an ellipse comes out as a lens-shaped sliver
 * and reads as a rendering bug. The other two shapes are dragged by the grip
 * every placed object carries anyway, so they simply have no lip and give
 * that height back to the text.
 */
export function noteLipHeight(note: StickyNote): number {
  return noteShapeOf(note) === 'rectangle' ? NOTE_GRIP_HEIGHT : 0;
}

/** A bubble's tail, scaled down on a small note so it stays a tail. */
export function noteTailSize(note: StickyNote): { width: number; height: number } {
  return {
    width: Math.min(NOTE_TAIL_WIDTH, note.width * 0.35),
    height: Math.min(NOTE_TAIL_HEIGHT, note.height * 0.25),
  };
}

/**
 * The filled body of the note in its own frame (origin at its top-left). For
 * a bubble this stops above the tail; for the other two it is the whole box.
 */
export function noteBodyBox(note: StickyNote): { x: number; y: number; width: number; height: number } {
  const tail = noteShapeOf(note) === 'bubble' ? noteTailSize(note).height : 0;
  return { x: 0, y: 0, width: note.width, height: Math.max(1, note.height - tail) };
}

/**
 * The three corners of a bubble's tail in the note's own frame: it hangs from
 * the lower left of the body, the way a speech balloon points back at whoever
 * is speaking.
 */
export function noteTailPoints(note: StickyNote): [Point, Point, Point] {
  const body = noteBodyBox(note);
  const tail = noteTailSize(note);
  const left = Math.min(body.width - tail.width, Math.max(0, body.width * 0.18));
  return [
    { x: left, y: body.height - 1 },
    { x: left + tail.width, y: body.height - 1 },
    { x: left + tail.width * 0.25, y: body.height + tail.height },
  ];
}

/**
 * The text area in the note's own frame: below the lip, inside the padding,
 * and pulled in far enough that a line of text cannot poke out through the
 * curve of the shape.
 *
 * For an ellipse that means the inscribed rectangle — the largest axis-aligned
 * box that fits inside it, half the ellipse's size times the square root of
 * two — which is why an oval note holds noticeably less than the rectangle of
 * the same footprint. Anything roomier would clip mid-word at the sides.
 */
export function noteTextLocalBox(note: StickyNote): { x: number; y: number; width: number; height: number } {
  const shape = noteShapeOf(note);
  if (shape === 'ellipse') {
    const halfW = (note.width / 2) * Math.SQRT1_2;
    const halfH = (note.height / 2) * Math.SQRT1_2;
    return {
      x: note.width / 2 - halfW + NOTE_PADDING,
      y: note.height / 2 - halfH + NOTE_PADDING,
      width: Math.max(1, halfW * 2 - NOTE_PADDING * 2),
      height: Math.max(1, halfH * 2 - NOTE_PADDING * 2),
    };
  }
  const body = noteBodyBox(note);
  // A bubble's corners are rounded, so its text starts inside the radius.
  const inset = NOTE_PADDING + (shape === 'bubble' ? NOTE_BUBBLE_RADIUS * 0.4 : 0);
  const top = noteLipHeight(note) + inset;
  return {
    x: inset,
    y: top,
    width: Math.max(1, body.width - inset * 2),
    height: Math.max(1, body.height - top - inset),
  };
}

/** The text area inside a note's card, in page coordinates. */
export function noteTextBox(note: StickyNote): { x: number; y: number; width: number; height: number } {
  const local = noteTextLocalBox(note);
  return { x: note.x + local.x, y: note.y + local.y, width: local.width, height: local.height };
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
  const columns = trackEdges(columnFractions(table));
  const rows = trackEdges(rowFractions(table));
  const x0 = columns[column] ?? 0;
  const x1 = columns[column + 1] ?? 1;
  const y0 = rows[row] ?? 0;
  const y1 = rows[row + 1] ?? 1;
  return {
    x: grid.x + x0 * grid.width,
    y: grid.y + y0 * grid.height,
    width: (x1 - x0) * grid.width,
    height: (y1 - y0) * grid.height,
  };
}

// ---------------------------------------------------------------------------
// Uneven table tracks
// ---------------------------------------------------------------------------

/** `count` equal shares, summing to 1. */
export function evenFractions(count: number): number[] {
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n }, () => 1 / n);
}

/**
 * The column (or row) shares of a table, always `count` long and summing to
 * 1. A table with no stored fractions — a new one, or one from a file written
 * before dividers could be dragged — is evenly divided.
 */
export function trackFractions(stored: readonly number[] | undefined, count: number): number[] {
  const n = Math.max(1, Math.round(count));
  if (!stored || stored.length !== n) return evenFractions(n);
  const total = stored.reduce((sum, f) => sum + (Number.isFinite(f) && f > 0 ? f : 0), 0);
  if (!(total > 0)) return evenFractions(n);
  return stored.map((f) => (Number.isFinite(f) && f > 0 ? f / total : 0));
}

export function columnFractions(table: TableLayer): number[] {
  return trackFractions(table.columnFractions, table.columns);
}

export function rowFractions(table: TableLayer): number[] {
  return trackFractions(table.rowFractions, table.rows);
}

/** Cumulative offsets 0…1 of every divider, including both outer edges. */
export function trackEdges(fractions: readonly number[]): number[] {
  const edges = [0];
  let run = 0;
  for (const f of fractions) {
    run += f;
    edges.push(Math.min(1, run));
  }
  edges[edges.length - 1] = 1;
  return edges;
}

/**
 * Move divider `index` (1-based: the first interior one is 1) to `position`,
 * a 0..1 offset across the table. Only the two tracks either side of it
 * change, which is how a spreadsheet behaves and keeps the rest of the table
 * where the user left it. Neither may collapse past `MIN_TRACK_FRACTION`.
 */
export function resizeTrack(fractions: readonly number[], index: number, position: number): number[] {
  const next = [...fractions];
  const before = next[index - 1];
  const after = next[index];
  if (before === undefined || after === undefined) return next;
  const edges = trackEdges(fractions);
  const start = edges[index - 1] ?? 0;
  const pair = before + after;
  const clamped = Math.min(
    start + pair - MIN_TRACK_FRACTION,
    Math.max(start + MIN_TRACK_FRACTION, Number.isFinite(position) ? position : start + before),
  );
  next[index - 1] = clamped - start;
  next[index] = pair - next[index - 1]!;
  return next;
}

export function setColumnFractions(table: TableLayer, fractions: readonly number[]): TableLayer {
  return { ...table, columnFractions: [...fractions] };
}

export function setRowFractions(table: TableLayer, fractions: readonly number[]): TableLayer {
  return { ...table, rowFractions: [...fractions] };
}
