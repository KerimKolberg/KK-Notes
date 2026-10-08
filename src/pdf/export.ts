/**
 * Vector PDF export with pdf-lib.
 *
 * - PDF-backed pages are copied from their source (`copyPages`), keeping the
 *   original vectors, fonts and text. Form values are written into the
 *   source's AcroForm first so the copied widgets carry filled appearances,
 *   and an AcroForm is rebuilt in the output so the fields stay live.
 * - Template pages get their background colour and grid lines as vectors.
 * - Images are embedded (PNG / JPEG directly, anything else re-encoded as PNG
 *   when a canvas is available).
 * - Strokes are burned as resolution-independent paths / primitives via the
 *   pure `pdfOps` conversion.
 */
import {
  BlendMode,
  LineCapStyle,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFForm,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import type { Point } from '../inking/types';
import {
  columnFractions,
  dataUrlToBytes,
  isAboveInk,
  noteBodyBox,
  noteShapeOf,
  noteTailPoints,
  noteTextLocalBox,
  rowFractions,
  sortedByZ,
  tableCell,
  trackEdges,
  wrapText,
  TEXT_FONTS,
  pdfFontName,
} from '../document/media';
import { layoutRich, paintRich, type RichPainter, type RunStyle } from '../document/richLayout';
import { isRichEmpty, richBaseOf, richOf } from '../document/richText';
import {
  DEFAULT_TABLE_LINE_OPACITY,
  DEFAULT_TABLE_LINE_WIDTH,
  NOTE_FONT_SIZE,
  NOTE_LINE_HEIGHT,
  TABLE_CELL_PADDING,
  TABLE_FONT_SIZE,
  TABLE_GRIP_HEIGHT,
} from '../document/constants';
import { templateLines } from '../document/templates';
import type { Document, FormField, FormValues, ImageLayer, MediaBox, MediaObject, Page, StickyNote, TableLayer, TextBox } from '../document/types';
import { pagePointToPdf, PX_PER_POINT } from './pdfCoords';
import { cssColorToPdf, fmt, strokeToPdfOps, type PdfOp, type PdfProjection, type RgbColor } from './pdfOps';

export interface ExportOptions {
  /** Draw template grids / rules for non-PDF pages. Default true. */
  readonly includeTemplates?: boolean;
  /** pdf-lib object streams make files smaller but harder to inspect. Default false. */
  readonly useObjectStreams?: boolean;
}

const toColor = (c: RgbColor) => rgb(c.r, c.g, c.b);

/** A colour laid over white at `alpha`, for the transparency PDF ops lack. */
function blendOnWhite(c: RgbColor, alpha: number): RgbColor {
  const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
  return { r: 1 - a * (1 - c.r), g: 1 - a * (1 - c.g), b: 1 - a * (1 - c.b) };
}
const toBlend = (b: 'normal' | 'multiply') => (b === 'multiply' ? BlendMode.Multiply : BlendMode.Normal);

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

function projectionFor(page: Page): { projection: PdfProjection; size: { width: number; height: number } } {
  const ref = page.pdf;
  if (ref) {
    return {
      projection: {
        toPdf: (p: Point) => pagePointToPdf(p.x, p.y, ref.viewBox, ref.rotation, ref.scale),
        scale: 1 / ref.scale,
        pageRotation: ref.rotation,
      },
      size: { width: 0, height: 0 },
    };
  }
  const k = 1 / PX_PER_POINT; // points per px
  const height = page.dimensions.height * k;
  return {
    projection: { toPdf: (p: Point) => ({ x: p.x * k, y: height - p.y * k }), scale: k, pageRotation: 0 },
    size: { width: page.dimensions.width * k, height },
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

interface Fonts {
  readonly regular: PDFFont;
  readonly italic: PDFFont;
  /**
   * Every family/weight/slant the text tool can choose, keyed by its base-14
   * name. PDF has no "bold" attribute — bold *is* a different font — so the
   * combination has to be resolved to one of these before anything is drawn.
   */
  readonly text: ReadonlyMap<string, PDFFont>;
}

function drawOp(target: PDFPage, op: PdfOp, fonts: Fonts): void {
  switch (op.kind) {
    case 'path':
      target.drawSvgPath(op.d, {
        x: 0,
        y: 0,
        scale: 1,
        ...(op.fill ? { color: toColor(op.fill), opacity: op.opacity } : {}),
        ...(op.stroke
          ? {
              borderColor: toColor(op.stroke),
              borderWidth: op.lineWidth ?? 1,
              borderOpacity: op.opacity,
              borderLineCap: LineCapStyle.Round,
              ...(op.dash ? { borderDashArray: [...op.dash] } : {}),
            }
          : {}),
        blendMode: toBlend(op.blend),
      });
      return;
    case 'line':
      target.drawLine({
        start: op.start,
        end: op.end,
        thickness: op.thickness,
        color: toColor(op.color),
        opacity: op.opacity,
        lineCap: LineCapStyle.Round,
        ...(op.dash ? { dashArray: [...op.dash] } : {}),
        blendMode: toBlend(op.blend),
      });
      return;
    case 'rectangle':
      target.drawRectangle({
        x: op.x,
        y: op.y,
        width: op.width,
        height: op.height,
        rotate: degrees(op.rotateDeg),
        borderColor: toColor(op.borderColor),
        borderWidth: op.borderWidth,
        borderOpacity: op.opacity,
        borderLineCap: LineCapStyle.Round,
        ...(op.dash ? { borderDashArray: [...op.dash] } : {}),
        blendMode: toBlend(op.blend),
      });
      return;
    case 'ellipse':
      target.drawEllipse({
        x: op.cx,
        y: op.cy,
        xScale: op.rx,
        yScale: op.ry,
        rotate: degrees(op.rotateDeg),
        borderColor: toColor(op.borderColor),
        borderWidth: op.borderWidth,
        borderOpacity: op.opacity,
        ...(op.dash ? { borderDashArray: [...op.dash] } : {}),
        blendMode: toBlend(op.blend),
      });
      return;
    case 'text':
      try {
        target.drawText(op.text, {
          x: op.x,
          y: op.y,
          size: op.size,
          font: op.italic ? fonts.italic : fonts.regular,
          color: toColor(op.color),
          opacity: op.opacity,
        });
      } catch {
        /* glyph not in the standard font (e.g. Greek); skip the label */
      }
      return;
  }
}

function drawTemplateBackground(target: PDFPage, page: Page, projection: PdfProjection, size: { width: number; height: number }): void {
  const bg = cssColorToPdf(page.backgroundColor);
  target.drawRectangle({ x: 0, y: 0, width: size.width, height: size.height, color: toColor(bg), opacity: bg.alpha });
  for (const line of templateLines(page)) {
    const c = cssColorToPdf(line.color);
    target.drawLine({
      start: projection.toPdf({ x: line.x1, y: line.y1 }),
      end: projection.toPdf({ x: line.x2, y: line.y2 }),
      thickness: line.width * projection.scale,
      color: toColor(c),
      opacity: c.alpha,
    });
  }
}

async function reencodeAsPng(src: string): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === 'undefined' || typeof fetch === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(await (await fetch(src)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function embedImage(out: PDFDocument, image: ImageLayer, cache: Map<string, Promise<PDFImage | null>>): Promise<PDFImage | null> {
  let pending = cache.get(image.src);
  if (!pending) {
    pending = (async () => {
      const decoded = dataUrlToBytes(image.src);
      if (!decoded) return null;
      try {
        if (decoded.mime === 'image/png') return await out.embedPng(decoded.bytes);
        if (decoded.mime === 'image/jpeg' || decoded.mime === 'image/jpg') return await out.embedJpg(decoded.bytes);
        const png = await reencodeAsPng(image.src);
        return png ? await out.embedPng(png) : null;
      } catch {
        return null;
      }
    })();
    cache.set(image.src, pending);
  }
  return pending;
}

/**
 * Bottom-left corner of a media box in PDF user space, plus the rotation to
 * hand pdf-lib. CSS rotates clockwise with y down; PDF rotates
 * counter-clockwise, and a rotated source page shifts the frame again by its
 * own display rotation — so every placement goes through here rather than
 * each caller getting the signs right on its own.
 */
function placeBox(item: MediaBox, projection: PdfProjection): { x: number; y: number; width: number; height: number; rotateDeg: number } {
  const centre = projection.toPdf({ x: item.x + item.width / 2, y: item.y + item.height / 2 });
  const width = item.width * projection.scale;
  const height = item.height * projection.scale;
  const rotateDeg = projection.pageRotation - item.rotation;
  const rad = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // pdf-lib rotates about the bottom-left corner: place that corner explicitly.
  return {
    x: centre.x + (-width / 2) * cos - (-height / 2) * sin,
    y: centre.y + (-width / 2) * sin + (-height / 2) * cos,
    width,
    height,
    rotateDeg,
  };
}

/**
 * A sticky note: its card, cut to its shape, then its text wrapped to the
 * same box the DOM wraps it to, measured with the PDF font so the line breaks
 * match.
 *
 * A bubble's body is drawn square-cornered. pdf-lib's rectangle carries no
 * corner radius, and hand-building the path would give up its rotation
 * handling — the tail is what makes a bubble read as one, and that is drawn
 * exactly.
 */
function drawNote(target: PDFPage, note: StickyNote, projection: PdfProjection, fonts: Fonts): void {
  const box = placeBox(note, projection);
  const card = cssColorToPdf(note.color);
  const shape = noteShapeOf(note);
  const rad = (box.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  /** A point in the note's own frame, in PDF units (x right, y down from its top). */
  const at = (localX: number, localY: number): { x: number; y: number } => {
    const fromBottom = box.height - localY;
    return { x: box.x + localX * cos - fromBottom * sin, y: box.y + localX * sin + fromBottom * cos };
  };
  const body = noteBodyBox(note);
  const bodyHeight = body.height * projection.scale;
  const edge = toColor(cssColorToPdf('#00000022'));

  if (shape === 'ellipse') {
    const centre = projection.toPdf({ x: note.x + note.width / 2, y: note.y + note.height / 2 });
    target.drawEllipse({
      x: centre.x,
      y: centre.y,
      xScale: box.width / 2,
      yScale: box.height / 2,
      rotate: degrees(box.rotateDeg),
      color: toColor(card),
      opacity: card.alpha,
      borderColor: edge,
      borderWidth: 0.5,
    });
  } else {
    // The body sits at the top of the box, so a bubble's rectangle starts
    // above its tail rather than at the box's own bottom edge.
    const corner = at(0, bodyHeight);
    target.drawRectangle({
      x: corner.x,
      y: corner.y,
      width: box.width,
      height: bodyHeight,
      rotate: degrees(box.rotateDeg),
      color: toColor(card),
      opacity: card.alpha,
      borderColor: edge,
      borderWidth: 0.5,
    });
    if (shape === 'bubble') {
      const [a, b, tip] = noteTailPoints(note).map((p) => at(p.x * projection.scale, p.y * projection.scale));
      if (a && b && tip) {
        // Relative to `a`, and flipped back into PDF's y-up before drawing.
        const d = `M 0 0 L ${fmt(b.x - a.x)} ${fmt(a.y - b.y)} L ${fmt(tip.x - a.x)} ${fmt(a.y - tip.y)} Z`;
        target.drawSvgPath(d, { x: a.x, y: a.y, color: toColor(card), opacity: card.alpha, borderWidth: 0 });
      }
    }
  }
  if (note.text === '') return;

  const size = NOTE_FONT_SIZE * projection.scale;
  const lineHeight = size * NOTE_LINE_HEIGHT;
  const text = noteTextLocalBox(note);
  const width = text.width * projection.scale;
  const lines = wrapText(note.text, width, (t) => fonts.regular.widthOfTextAtSize(sanitizeText(t), size));
  // Only as many lines as the card has room for; the live note scrolls, and
  // paper cannot.
  const maxLines = Math.max(0, Math.floor((text.height * projection.scale) / lineHeight));
  lines.slice(0, maxLines).forEach((line, i) => {
    const p = at(text.x * projection.scale, text.y * projection.scale + lineHeight * (i + 0.8));
    target.drawText(sanitizeText(line), {
      x: p.x,
      y: p.y,
      size,
      font: fonts.regular,
      color: toColor(cssColorToPdf('#27272a')),
      rotate: degrees(box.rotateDeg),
    });
  });
}

/**
 * A text box: its paragraphs laid out as the page lays them out (`document/richLayout.ts`), measured with the
 * PDF's own fonts, each run in the base-14 font its family, weight and slant resolve to, with list markers,
 * highlights and rules.
 *
 * Underline and strikethrough are *drawn*, not typeset. PDF text has no decoration property at all — a viewer
 * that shows you an underline is looking at a line someone drew — so each one is a thin filled rectangle at a
 * measured offset from the baseline, rotated with the box like everything else.
 */
function drawTextBox(target: PDFPage, item: TextBox, projection: PdfProjection, fonts: Fonts): void {
  const rich = richOf(item);
  if (isRichEmpty(rich)) return;
  const base = richBaseOf(item);
  const box = placeBox(item, projection);
  const rad = (box.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotate = degrees(box.rotateDeg);
  const k = projection.scale;
  /** A point in the box's own frame, page px (x right, y down from its top), in PDF units. */
  const at = (localX: number, localY: number): { x: number; y: number } => {
    const fromBottom = box.height - localY * k;
    return { x: box.x + localX * k * cos - fromBottom * sin, y: box.y + localX * k * sin + fromBottom * cos };
  };
  const fontFor = (style: RunStyle): PDFFont => fonts.text.get(pdfFontName(style)) ?? fonts.regular;
  const paint = (color: string, opacity: number) => {
    const c = cssColorToPdf(color);
    return { color: toColor(c), opacity: Math.max(0, Math.min(1, opacity * c.alpha)) };
  };
  // Laid out in page px, measured at page-px sizes, so it wraps where the page does and scales on the way out.
  const layout = layoutRich(rich, base, item.width, (text, style) => fontFor(style).widthOfTextAtSize(sanitizeText(text), style.size));
  // A box from before text could be formatted in parts hid what overflowed it: only the lines that fit.
  const limit = item.rich ? Infinity : item.height;

  const painter: RichPainter = {
    text: (text, x, baseline, style, opacity, anchor = 'left') => {
      const clean = sanitizeText(text);
      if (clean === '' || baseline > limit) return;
      const font = fontFor(style);
      const size = style.size * k;
      const left = anchor === 'right' ? x - font.widthOfTextAtSize(clean, size) / k : x;
      const p = at(left, baseline);
      target.drawText(clean, { x: p.x, y: p.y, size, font, rotate, ...paint(style.color, opacity) });
    },
    rect: (x, top, width, height, color, opacity) => {
      if (top > limit) return;
      // Anchored at its bottom-left corner, as pdf-lib rotates about it.
      const p = at(x, top + height);
      target.drawRectangle({ x: p.x, y: p.y, width: width * k, height: height * k, rotate, ...paint(color, opacity) });
    },
    circle: (cx, cy, r, color, filled, line, opacity) => {
      const p = at(cx, cy);
      const { color: c, opacity: o } = paint(color, opacity);
      target.drawCircle(
        filled
          ? { x: p.x, y: p.y, size: r * k, color: c, opacity: o }
          : { x: p.x, y: p.y, size: r * k, borderColor: c, borderWidth: line * k, borderOpacity: o },
      );
    },
    polyline: (points, color, line, opacity) => {
      const { color: c, opacity: o } = paint(color, opacity);
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1]!;
        const [bx, by] = points[i]!;
        target.drawLine({ start: at(ax, ay), end: at(bx, by), thickness: line * k, color: c, opacity: o, lineCap: LineCapStyle.Round });
      }
    },
    square: (x, top, side, color, line, opacity) => {
      const p = at(x, top + side);
      const { color: c, opacity: o } = paint(color, opacity);
      target.drawRectangle({ x: p.x, y: p.y, width: side * k, height: side * k, rotate, borderColor: c, borderWidth: line * k, borderOpacity: o });
    },
  };
  paintRich(layout, painter, base);
}

/** A table: its frame, every grid line, and one clipped line of text per cell. */
function drawTable(target: PDFPage, table: TableLayer, projection: PdfProjection, fonts: Fonts): void {
  const box = placeBox(table, projection);
  const rad = (box.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  /** A point given in the table's own frame (x right, y down from the top). */
  const at = (localX: number, localY: number) => {
    const fromBottom = box.height - localY;
    return { x: box.x + localX * cos - fromBottom * sin, y: box.y + localX * sin + fromBottom * cos };
  };

  // Grid weight and tint travel with the table. PDF has no alpha in this
  // vocabulary, so a faint grid is exported as its colour blended towards the
  // white the table is drawn on — the same thing the eye sees on screen.
  const thickness = (table.lineWidth ?? DEFAULT_TABLE_LINE_WIDTH) * projection.scale;
  const rule = toColor(blendOnWhite(cssColorToPdf('#a1a1aa'), table.lineOpacity ?? DEFAULT_TABLE_LINE_OPACITY));

  target.drawRectangle({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotate: degrees(box.rotateDeg),
    color: toColor(cssColorToPdf('#ffffff')),
    borderColor: rule,
    borderWidth: thickness,
  });

  const grip = TABLE_GRIP_HEIGHT * projection.scale;
  const gridHeight = Math.max(0, box.height - grip);
  const columnEdges = trackEdges(columnFractions(table)).map((f) => f * box.width);
  const rowEdges = trackEdges(rowFractions(table)).map((f) => grip + f * gridHeight);
  for (const x of columnEdges.slice(1, -1)) {
    target.drawLine({ start: at(x, grip), end: at(x, box.height), thickness, color: rule });
  }
  for (const y of rowEdges) {
    target.drawLine({ start: at(0, y), end: at(box.width, y), thickness, color: rule });
  }

  const size = TABLE_FONT_SIZE * projection.scale;
  const padding = TABLE_CELL_PADDING * projection.scale;
  const ink = toColor(cssColorToPdf('#18181b'));
  for (let row = 0; row < table.rows; row++) {
    for (let column = 0; column < table.columns; column++) {
      const raw = tableCell(table, row, column);
      if (raw === '') continue;
      // One line, truncated to the cell: a cell that overflows on screen is
      // scrolled, which paper cannot do either.
      const x = columnEdges[column] ?? 0;
      const cellWidth = (columnEdges[column + 1] ?? box.width) - x;
      const y = rowEdges[row] ?? grip;
      const cellHeight = (rowEdges[row + 1] ?? box.height) - y;
      const [line = ''] = wrapText(raw, Math.max(1, cellWidth - padding * 2), (t) =>
        fonts.regular.widthOfTextAtSize(sanitizeText(t), size),
      );
      if (line === '') continue;
      const baseline = y + cellHeight / 2 + size * 0.35;
      const p = at(x + padding, baseline);
      target.drawText(sanitizeText(line), { x: p.x, y: p.y, size, font: fonts.regular, color: ink, rotate: degrees(box.rotateDeg) });
    }
  }
}

/**
 * The standard PDF fonts are WinAnsi only, and pdf-lib throws on a glyph it
 * cannot encode — which would fail the whole export over one emoji in one
 * note. Anything outside the range becomes '?' instead.
 */
/**
 * Text the base-14 fonts can set: they encode WinAnsi, which is Latin-1 and the typographer's punctuation a
 * phone's keyboard puts in by itself — curly quotes, dashes, the ellipsis — so those are kept, a tab is four
 * spaces, and anything else is a question mark.
 */
function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\t/g, '    ').replace(/[^\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '?');
}

async function drawMedia(
  out: PDFDocument,
  target: PDFPage,
  media: readonly MediaObject[],
  projection: PdfProjection,
  fonts: Fonts,
  cache: Map<string, Promise<PDFImage | null>>,
): Promise<void> {
  for (const item of sortedByZ(media)) {
    if (item.kind === 'note') {
      drawNote(target, item, projection, fonts);
      continue;
    }
    if (item.kind === 'table') {
      drawTable(target, item, projection, fonts);
      continue;
    }
    if (item.kind === 'text') {
      drawTextBox(target, item, projection, fonts);
      continue;
    }
    const embedded = await embedImage(out, item, cache);
    if (!embedded) continue;
    const box = placeBox(item, projection);
    target.drawImage(embedded, { x: box.x, y: box.y, width: box.width, height: box.height, rotate: degrees(box.rotateDeg) });
  }
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/** Write the page's values into the source document's fields (before copying). */
export function applyFormValues(form: PDFForm, fields: readonly FormField[], values: FormValues): number {
  let applied = 0;
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    const value = values[field.name];
    if (value === undefined) continue;
    const target = form.getFieldMaybe(field.name);
    if (!target) continue;
    try {
      if (target instanceof PDFTextField) {
        target.setText(typeof value === 'string' ? value : String(value));
      } else if (target instanceof PDFCheckBox) {
        if (value === true) target.check();
        else target.uncheck();
      } else if (target instanceof PDFRadioGroup) {
        if (typeof value === 'string' && value !== '' && target.getOptions().includes(value)) target.select(value);
      } else if (target instanceof PDFDropdown) {
        if (typeof value === 'string' && target.getOptions().includes(value)) target.select(value);
      } else if (target instanceof PDFOptionList) {
        if (typeof value === 'string' && target.getOptions().includes(value)) target.select(value);
      } else {
        continue;
      }
      applied++;
    } catch {
      /* e.g. text longer than maxLength, or a value not in the options */
    }
  }
  return applied;
}

/** Top-level field dictionaries referenced by a copied page's widget annotations. */
function collectFieldRefs(out: PDFDocument, target: PDFPage): PDFRef[] {
  const annots = target.node.Annots();
  if (!annots) return [];
  const refs: PDFRef[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const item = annots.get(i);
    if (!(item instanceof PDFRef)) continue;
    try {
      let ref: PDFRef = item;
      let dict = out.context.lookup(ref, PDFDict);
      if (dict.get(PDFName.of('Subtype'))?.toString() !== '/Widget') continue;
      for (let depth = 0; depth < 32; depth++) {
        const parent = dict.get(PDFName.of('Parent'));
        if (!(parent instanceof PDFRef)) break;
        ref = parent;
        dict = out.context.lookup(parent, PDFDict);
      }
      refs.push(ref);
    } catch {
      /* malformed annotation; skip */
    }
  }
  return refs;
}

/** Give the output document an AcroForm listing every copied field so viewers keep them interactive. */
function rebuildAcroForm(out: PDFDocument, fieldRefs: readonly PDFRef[]): void {
  const unique = new Map<string, PDFRef>();
  for (const ref of fieldRefs) unique.set(ref.toString(), ref);
  if (unique.size === 0) return;
  const fields = PDFArray.withContext(out.context);
  for (const ref of unique.values()) fields.push(ref);
  const acroForm = out.context.obj({
    Fields: fields,
    DA: PDFString.of('/Helv 0 Tf 0 g'),
  });
  out.catalog.set(PDFName.of('AcroForm'), out.context.register(acroForm));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

interface SourceEntry {
  readonly doc: PDFDocument;
  readonly font: PDFFont;
}

export async function exportDocumentToPdf(document: Document, options: ExportOptions = {}): Promise<Uint8Array> {
  const includeTemplates = options.includeTemplates ?? true;
  const out = await PDFDocument.create();
  out.setTitle(document.title);
  out.setProducer('notes-taking-app');
  // The base-14 are referenced rather than embedded, so taking all twelve
  // costs a handful of dictionary entries and removes any chance of a text box
  // exporting in a font nobody chose.
  const textFonts = new Map<string, PDFFont>();
  for (const family of TEXT_FONTS) {
    for (const name of family.pdf) {
      if (!textFonts.has(name)) textFonts.set(name, await out.embedFont(name as StandardFonts));
    }
  }
  const fonts: Fonts = {
    regular: await out.embedFont(StandardFonts.Helvetica),
    italic: await out.embedFont(StandardFonts.HelveticaOblique),
    text: textFonts,
  };
  const sources = new Map<string, Promise<SourceEntry>>();
  const imageCache = new Map<string, Promise<PDFImage | null>>();
  const fieldRefs: PDFRef[] = [];

  const sourceFor = (page: Page): Promise<SourceEntry> | null => {
    const ref = page.pdf;
    if (!ref) return null;
    let pending = sources.get(ref.sourceId);
    if (!pending) {
      pending = (async () => {
        const doc = await PDFDocument.load(ref.data, { ignoreEncryption: true, updateMetadata: false });
        const font = await doc.embedFont(StandardFonts.Helvetica);
        return { doc, font };
      })();
      sources.set(ref.sourceId, pending);
    }
    return pending;
  };

  // 1. Fill every source's form before any page is copied.
  const touchedSources = new Set<string>();
  for (const page of document.pages) {
    const pending = sourceFor(page);
    if (!pending || !page.pdf || page.formFields.length === 0) continue;
    const { doc, font } = await pending;
    try {
      const form = doc.getForm();
      if (applyFormValues(form, page.formFields, page.formValues) > 0) touchedSources.add(page.pdf.sourceId);
      if (touchedSources.has(page.pdf.sourceId)) form.updateFieldAppearances(font);
    } catch {
      /* source has no usable AcroForm */
    }
  }

  // 2. Assemble pages in document order.
  for (const page of document.pages) {
    const { projection, size } = projectionFor(page);
    let target: PDFPage;
    const pending = sourceFor(page);
    if (pending && page.pdf) {
      const { doc } = await pending;
      const [copied] = await out.copyPages(doc, [page.pdf.pageIndex]);
      if (!copied) continue;
      target = out.addPage(copied);
      fieldRefs.push(...collectFieldRefs(out, target));
    } else {
      target = out.addPage([size.width, size.height]);
      if (includeTemplates) drawTemplateBackground(target, page, projection, size);
    }

    // Under the ink, the ink, and typed text set in front of it over that, as the page shows them.
    await drawMedia(out, target, page.media.filter((m) => !isAboveInk(m)), projection, fonts, imageCache);
    for (const stroke of page.strokes) {
      for (const op of strokeToPdfOps(stroke, projection)) drawOp(target, op, fonts);
    }
    await drawMedia(out, target, page.media.filter(isAboveInk), projection, fonts, imageCache);
  }

  rebuildAcroForm(out, fieldRefs);
  return out.save({ useObjectStreams: options.useObjectStreams ?? false });
}
