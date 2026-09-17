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
import { dataUrlToBytes, sortedByZ } from '../document/media';
import { templateLines } from '../document/templates';
import type { Document, FormField, FormValues, ImageLayer, Page } from '../document/types';
import { pagePointToPdf, PX_PER_POINT } from './pdfCoords';
import { cssColorToPdf, strokeToPdfOps, type PdfOp, type PdfProjection, type RgbColor } from './pdfOps';

export interface ExportOptions {
  /** Draw template grids / rules for non-PDF pages. Default true. */
  readonly includeTemplates?: boolean;
  /** pdf-lib object streams make files smaller but harder to inspect. Default false. */
  readonly useObjectStreams?: boolean;
}

const toColor = (c: RgbColor) => rgb(c.r, c.g, c.b);
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

async function drawImages(
  out: PDFDocument,
  target: PDFPage,
  page: Page,
  projection: PdfProjection,
  cache: Map<string, Promise<PDFImage | null>>,
): Promise<void> {
  for (const image of sortedByZ(page.images)) {
    const embedded = await embedImage(out, image, cache);
    if (!embedded) continue;
    const centre = projection.toPdf({ x: image.x + image.width / 2, y: image.y + image.height / 2 });
    const w = image.width * projection.scale;
    const h = image.height * projection.scale;
    // CSS rotation is clockwise (y down); PDF rotation is counter-clockwise, and a
    // rotated source page shifts the frame by its display rotation.
    const rotateDeg = projection.pageRotation - image.rotation;
    const rad = (rotateDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // pdf-lib rotates about the bottom-left corner: place that corner explicitly.
    const bl = { x: centre.x + (-w / 2) * cos - (-h / 2) * sin, y: centre.y + (-w / 2) * sin + (-h / 2) * cos };
    target.drawImage(embedded, { x: bl.x, y: bl.y, width: w, height: h, rotate: degrees(rotateDeg) });
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
  const fonts: Fonts = {
    regular: await out.embedFont(StandardFonts.Helvetica),
    italic: await out.embedFont(StandardFonts.HelveticaOblique),
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

    await drawImages(out, target, page, projection, imageCache);
    for (const stroke of page.strokes) {
      for (const op of strokeToPdfOps(stroke, projection)) drawOp(target, op, fonts);
    }
  }

  rebuildAcroForm(out, fieldRefs);
  return out.save({ useObjectStreams: options.useObjectStreams ?? false });
}
