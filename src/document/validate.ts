/**
 * A note read from a file is not trusted to be a note.
 *
 * It may have come from another device through sync, from someone else, from an older or a newer version of the app,
 * or from a disk that lost half of it. The types in `types.ts` say what the app writes; nothing made a file keep to
 * them, and a page 4 000 000 px tall, a stroke whose points are `null` or a title that is a number each took the
 * viewer down in its own way (the first by asking for a canvas no device can make).
 *
 * So what is read is checked here, part by part, before it becomes a document. What is sound is passed through as
 * it is, untouched and uncopied — a note of a hundred thousand points costs one pass over them — and what is not is
 * dropped or put right on its own: one bad stroke loses that stroke, never the page, and one bad page becomes a
 * blank one, never a note that will not open. Nothing here knows about meaning; that a stroke is ugly is not its
 * business, only that drawing it cannot fail.
 */
import { freehandBBox } from '../inking/engine/strokeBuilder';
import { shapeBBox } from '../inking/engine/shapes';
import type { BBox, Shape, Stroke, StrokeStyle } from '../inking/types';
import { A4_DIMENSIONS, LIGHT_PAGE_BACKGROUND, MAX_TEMPLATE_SPACING, MIN_TEMPLATE_SPACING } from './constants';
import type {
  Cover,
  FormField,
  FormValues,
  MediaObject,
  PageDimensions,
  PageTemplate,
  SerializedPage,
  SerializedPdfPageRef,
  SerializedPdfSource,
  TemplateConfig,
} from './types';

/** The smallest and largest side a page may have, in page px (A4 is 794 × 1123). Past this a canvas cannot be made. */
export const MIN_PAGE_SIDE = 32;
export const MAX_PAGE_SIDE = 20_000;
/** Longest title, bookmark or colour kept; a megabyte in a title is not a title. */
const MAX_TITLE = 300;
const MAX_COLOR = 64;

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isPoint = (v: unknown): boolean => isRaw(v) && isNum(v.x) && isNum(v.y);
const isColor = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= MAX_COLOR;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const TEMPLATES: readonly PageTemplate[] = ['blank', 'ruled', 'grid', 'engineering', 'isometric', 'pdf'];

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

function isBBox(v: unknown): v is BBox {
  return isRaw(v) && isNum(v.minX) && isNum(v.minY) && isNum(v.maxX) && isNum(v.maxY);
}

function isStyle(v: unknown): v is StrokeStyle {
  return isRaw(v) && isColor(v.color) && isNum(v.size) && v.size > 0;
}

function isShape(v: unknown): v is Shape {
  if (!isRaw(v)) return false;
  switch (v.type) {
    case 'line':
      return isPoint(v.from) && isPoint(v.to);
    case 'polyline':
    case 'polygon':
      return Array.isArray(v.points) && v.points.length > 0 && v.points.every(isPoint);
    case 'rectangle':
      return isPoint(v.center) && isNum(v.width) && isNum(v.height) && isNum(v.rotation);
    case 'ellipse':
      return isPoint(v.center) && isNum(v.radiusX) && isNum(v.radiusY) && isNum(v.rotation);
    case 'heart':
      return isPoint(v.center) && isNum(v.width) && isNum(v.height) && (v.rotation === undefined || isNum(v.rotation));
    case 'curve':
      return isStr(v.kind) && isPoint(v.from) && isPoint(v.to) && isNum(v.amplitude) && isNum(v.cycles);
    case 'coordinate-plane':
      return isPoint(v.origin) && isNum(v.extentX) && isNum(v.extentY) && isRaw(v.config) && isNum(v.config.divisions) && (v.rotation === undefined || isNum(v.rotation));
    default:
      return false;
  }
}

/** The stroke if it can be drawn, with a bounding box worked out again where the file's is missing or broken. */
export function sanitizeStroke(raw: unknown): Stroke | null {
  if (!isRaw(raw) || !isStr(raw.id) || !isStr(raw.tool) || !isStyle(raw.style)) return null;
  if (raw.kind === 'freehand') {
    const points = raw.points;
    if (!Array.isArray(points) || points.length === 0 || !points.every(isPoint)) return null;
    const stroke = raw as unknown as Extract<Stroke, { kind: 'freehand' }>;
    return isBBox(raw.bbox) ? stroke : { ...stroke, bbox: freehandBBox(stroke.points, stroke.style) };
  }
  if (raw.kind === 'geometric') {
    if (!isShape(raw.shape)) return null;
    const stroke = raw as unknown as Extract<Stroke, { kind: 'geometric' }>;
    return isBBox(raw.bbox) ? stroke : { ...stroke, bbox: shapeBBox(stroke.shape, stroke.style) };
  }
  return null;
}

/** The same array when every stroke in it is sound (the usual case), so nothing is copied for a note that is well. */
function sanitizeStrokes(raw: unknown): readonly Stroke[] {
  if (!Array.isArray(raw)) return [];
  let out: Stroke[] | null = null;
  for (let i = 0; i < raw.length; i++) {
    const stroke = sanitizeStroke(raw[i]);
    if (out) {
      if (stroke) out.push(stroke);
    } else if (stroke === null || stroke !== raw[i]) {
      out = (raw as Stroke[]).slice(0, i);
      if (stroke) out.push(stroke);
    }
  }
  return out ?? (raw as Stroke[]);
}

// ---------------------------------------------------------------------------
// What is placed on a page
// ---------------------------------------------------------------------------

function isBox(v: Raw): boolean {
  return isStr(v.id) && isNum(v.x) && isNum(v.y) && isNum(v.width) && v.width > 0 && isNum(v.height) && v.height > 0;
}

/**
 * A picture, note, table or text box, if it is one. A picture's source has to be a `data:image/` URL, which is all
 * the app ever writes: anything else would have the app fetch an address a file chose.
 */
export function sanitizeMedia(raw: unknown, legacyImage = false): MediaObject | null {
  if (!isRaw(raw) || !isBox(raw)) return null;
  const kind = legacyImage ? 'image' : raw.kind;
  const box = {
    ...raw,
    kind,
    rotation: isNum(raw.rotation) ? raw.rotation : 0,
    zIndex: isNum(raw.zIndex) ? raw.zIndex : 0,
  };
  switch (kind) {
    case 'image':
      if (!isStr(raw.src) || !/^data:image\//i.test(raw.src)) return null;
      return box as unknown as MediaObject;
    case 'note':
      return { ...box, text: isStr(raw.text) ? raw.text : '', color: isColor(raw.color) ? raw.color : '#fef08a' } as unknown as MediaObject;
    case 'table': {
      const rows = isNum(raw.rows) ? Math.trunc(raw.rows) : 0;
      const columns = isNum(raw.columns) ? Math.trunc(raw.columns) : 0;
      if (rows < 1 || columns < 1 || rows * columns > 10_000) return null;
      const cells = Array.from({ length: rows * columns }, (_, i) => {
        const cell: unknown = Array.isArray(raw.cells) ? raw.cells[i] : undefined;
        return isStr(cell) ? cell : '';
      });
      return { ...box, rows, columns, cells } as unknown as MediaObject;
    }
    case 'text':
      return { ...box, text: isStr(raw.text) ? raw.text : '' } as unknown as MediaObject;
    default:
      return null;
  }
}

function sanitizeFormField(raw: unknown): FormField | null {
  if (!isRaw(raw) || !isStr(raw.id) || !isStr(raw.name) || !isStr(raw.kind)) return null;
  const box = raw.box;
  if (!isRaw(box) || !isNum(box.x) || !isNum(box.y) || !isNum(box.width) || !isNum(box.height)) return null;
  return raw as unknown as FormField;
}

function sanitizeFormValues(raw: unknown): FormValues {
  if (!isRaw(raw)) return {};
  const out: Record<string, string | boolean> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'boolean') out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function sanitizeDimensions(raw: unknown): PageDimensions {
  if (!isRaw(raw) || !isNum(raw.width) || !isNum(raw.height) || raw.width <= 0 || raw.height <= 0) return A4_DIMENSIONS;
  const width = clamp(raw.width, MIN_PAGE_SIDE, MAX_PAGE_SIDE);
  const height = clamp(raw.height, MIN_PAGE_SIDE, MAX_PAGE_SIDE);
  return width === raw.width && height === raw.height ? (raw as unknown as PageDimensions) : { width, height };
}

function sanitizeTemplateConfig(raw: unknown): Partial<TemplateConfig> {
  if (!isRaw(raw)) return {};
  // Every setting that is a plain value is kept (a margin, whatever a later version adds); the three that are drawn
  // with are held to what can be drawn, and one that cannot is left for the default to fill.
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isNum(value) || typeof value === 'boolean' || isColor(value)) out[key] = value;
  }
  if (isNum(raw.spacing) && raw.spacing > 0) out.spacing = clamp(raw.spacing, MIN_TEMPLATE_SPACING / 2, MAX_TEMPLATE_SPACING * 2);
  else delete out.spacing;
  if (isNum(raw.strokeWidth) && raw.strokeWidth > 0) out.strokeWidth = Math.min(raw.strokeWidth, 20);
  else delete out.strokeWidth;
  if (!isColor(raw.strokeColor)) delete out.strokeColor;
  return out;
}

function sanitizePdfRef(raw: unknown): SerializedPdfPageRef | null {
  if (!isRaw(raw) || !isStr(raw.sourceId) || !isNum(raw.pageIndex) || raw.pageIndex < 0) return null;
  const box = raw.viewBox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(isNum)) return null;
  if (!isNum(raw.scale) || raw.scale <= 0) return null;
  return {
    sourceId: raw.sourceId,
    pageIndex: Math.trunc(raw.pageIndex),
    viewBox: box as unknown as SerializedPdfPageRef['viewBox'],
    rotation: isNum(raw.rotation) ? raw.rotation : 0,
    scale: raw.scale,
  };
}

/**
 * A page as the file has it, made safe to show. `newId` names a page the file left unnamed (or named like another).
 * Fields this version does not know are left out, as they always were: a page is rebuilt from what is understood.
 */
export function sanitizePage(raw: unknown, newId: () => string): SerializedPage {
  const page: Raw = isRaw(raw) ? raw : {};
  const pdf = sanitizePdfRef(page.pdf);
  const template = TEMPLATES.find((t) => t === page.template) ?? 'blank';
  const media = Array.isArray(page.media)
    ? page.media.map((m) => sanitizeMedia(m)).filter((m): m is MediaObject => m !== null)
    : Array.isArray(page.images)
      ? page.images.map((m) => sanitizeMedia(m, true)).filter((m): m is MediaObject => m !== null)
      : [];
  return {
    id: isStr(page.id) && page.id.length > 0 ? page.id : newId(),
    dimensions: sanitizeDimensions(page.dimensions),
    // A page that says it is a PDF's but has no PDF page to show is a blank one.
    template: template === 'pdf' && !pdf ? 'blank' : template,
    templateConfig: sanitizeTemplateConfig(page.templateConfig) as TemplateConfig,
    backgroundColor: isColor(page.backgroundColor) ? page.backgroundColor : LIGHT_PAGE_BACKGROUND,
    strokes: sanitizeStrokes(page.strokes),
    ...(pdf ? { pdf } : {}),
    formFields: Array.isArray(page.formFields) ? page.formFields.map(sanitizeFormField).filter((f): f is FormField => f !== null) : [],
    formValues: sanitizeFormValues(page.formValues),
    media,
    ...(isStr(page.bookmark) ? { bookmark: page.bookmark.slice(0, MAX_TITLE) } : {}),
    ...(page.inkText !== undefined ? { inkText: page.inkText as NonNullable<SerializedPage['inkText']> } : {}),
  };
}

// ---------------------------------------------------------------------------
// The document around them
// ---------------------------------------------------------------------------

export function sanitizeTitle(raw: unknown): string {
  return isStr(raw) && raw.trim().length > 0 ? raw.slice(0, MAX_TITLE) : 'Untitled note';
}

export function sanitizeCover(raw: unknown): Cover | null {
  if (!isRaw(raw)) return null;
  return {
    title: isStr(raw.title) ? raw.title.slice(0, MAX_TITLE) : '',
    description: isStr(raw.description) ? raw.description.slice(0, 2000) : '',
    coverColor: isColor(raw.coverColor) ? raw.coverColor : '#1e3a8a',
    textColor: isColor(raw.textColor) ? raw.textColor : '#ffffff',
  };
}

/** The embedded PDFs that are whole: a name, a page count and base64 bytes. */
export function sanitizePdfSources(raw: unknown): Record<string, SerializedPdfSource> {
  const out: Record<string, SerializedPdfSource> = {};
  if (!isRaw(raw)) return out;
  for (const [id, source] of Object.entries(raw)) {
    if (!isRaw(source) || !isStr(source.data)) continue;
    out[id] = {
      name: isStr(source.name) ? source.name.slice(0, MAX_TITLE) : 'PDF',
      pageCount: isNum(source.pageCount) && source.pageCount > 0 ? Math.trunc(source.pageCount) : 1,
      data: source.data,
    };
  }
  return out;
}
