/**
 * Finding ink in a GoodNotes page by its shape, not by its field number.
 *
 * There is no `.proto` for this format, so there is no field called `points`.
 * What there is, in any version, is the thing itself: a packed run of
 * little-endian float32s holding interleaved coordinates, next to a run of the
 * same length holding pressures in 0..1, next to a scalar holding a width. Those
 * shapes are what a stroke *is*, and they survive GoodNotes renumbering
 * anything, adding a wrapper message, or changing which field carries what.
 *
 * So the search is: walk every message the file parses into, look at every
 * length-delimited value, and keep the ones whose contents could only plausibly
 * be geometry. Each test below rejects a shape that ink cannot have, and each
 * one is a guess that can be wrong — which is why the result is a list of
 * *candidates* carrying a confidence, and why the importer reports what it
 * found rather than presenting it as a faithful read.
 *
 * Two things are deliberately not attempted. Text boxes, images and shapes are
 * left alone: they are not float runs, and inventing them from ambiguous bytes
 * would put wrong content on the page rather than no content. And nothing is
 * ever written back — this reads.
 */
import { brushStyle } from '../inking/engine/brushes';
import { createStrokeId } from '../inking/engine/ids';
import { freehandBBox } from '../inking/engine/strokeBuilder';
import type { FreehandStroke, InkPoint } from '../inking/types';
import { WIRE_FIXED32, WIRE_FIXED64, WIRE_LENGTH, asFloat32Array, walkMessages } from './protobuf';
import type { PbField } from './protobuf';

/** Fewer samples than this is not a stroke; it is two numbers that rhyme. */
const MIN_POINTS = 2;

/** A coordinate past this is not on any page, whatever the unit. */
const MAX_COORDINATE = 100_000;

/** A stroke width, in whatever unit the source counts in. */
const MIN_WIDTH = 0.2;
const MAX_WIDTH = 200;

/** Plausible stroke widths, once scaled into our page px. */
const MIN_PAGE_WIDTH = 0.5;
const MAX_PAGE_WIDTH = 96;

export interface Candidate {
  /** Interleaved coordinates, in the source's own units. */
  readonly points: readonly InkPoint[];
  /** Stroke width in source units, when a scalar nearby looked like one. */
  readonly width?: number;
  /** `#rrggbb`, when a four-float run nearby looked like a colour. */
  readonly color?: string;
  /** Alpha from that colour, when it was not fully opaque. */
  readonly alpha?: number;
  /**
   * How much the shape tests agreed, 0..1. Pressure alongside the coordinates
   * is the strongest single signal that a float run really is ink.
   */
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------

function allFinite(values: Float32Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) return false;
  }
  return true;
}

function allWithinUnit(values: Float32Array): boolean {
  for (const value of values) {
    if (!(value >= 0 && value <= 1)) return false;
  }
  return true;
}

/** Does this run vary at all? A run of one repeated number is not a path. */
function varies(values: Float32Array): boolean {
  const first = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== first) return true;
  }
  return false;
}

/**
 * Could this run be pressures for `count` samples?
 *
 * Length and range together, because either alone is weak: plenty of float runs
 * are the right length, and plenty sit in 0..1 by accident. A run that never
 * changes is excluded too — a constant pressure array is possible, but so is a
 * run of zeroed padding, and treating padding as pressure loses nothing.
 */
function looksLikePressures(values: Float32Array, count: number): boolean {
  return values.length === count && allWithinUnit(values) && varies(values);
}

/**
 * Could this run be an RGBA colour?
 *
 * Exactly four components, all in 0..1. This is also, unavoidably, the shape of
 * two sub-pixel coordinates, which is why coordinate runs below refuse a
 * four-float run that fits entirely in 0..1: as ink that is a two-sample stroke
 * inside one pixel, and as a colour it is ordinary.
 */
function looksLikeColor(values: Float32Array): boolean {
  return values.length === 4 && allWithinUnit(values);
}

function hex(component: number): string {
  return Math.round(Math.min(1, Math.max(0, component)) * 255)
    .toString(16)
    .padStart(2, '0');
}

function colorFrom(values: Float32Array): { color: string; alpha: number } {
  return {
    color: `#${hex(values[0]!)}${hex(values[1]!)}${hex(values[2]!)}`,
    alpha: values[3]!,
  };
}

/**
 * Split a coordinate run into samples.
 *
 * A run is pairs (`x, y`) or triples (`x, y, pressure`) depending on the
 * version, and the length alone cannot say which when it divides by both. The
 * tie-break is the third component: if every third value sits in 0..1 while the
 * others do not, it is pressure, because real coordinates do not confine
 * themselves to the top-left pixel of the page.
 */
function samplesFrom(values: Float32Array): InkPoint[] | null {
  const asTriples = values.length % 3 === 0 && values.length / 3 >= MIN_POINTS && thirdIsPressure(values);
  if (asTriples) {
    const points: InkPoint[] = [];
    for (let i = 0; i < values.length; i += 3) {
      points.push({ x: values[i]!, y: values[i + 1]!, pressure: clampPressure(values[i + 2]!) });
    }
    return points;
  }
  if (values.length % 2 !== 0 || values.length / 2 < MIN_POINTS) return null;
  const points: InkPoint[] = [];
  for (let i = 0; i < values.length; i += 2) {
    points.push({ x: values[i]!, y: values[i + 1]!, pressure: 1 });
  }
  return points;
}

function thirdIsPressure(values: Float32Array): boolean {
  let coordinateOutsideUnit = false;
  for (let i = 0; i < values.length; i += 3) {
    const pressure = values[i + 2]!;
    if (!(pressure >= 0 && pressure <= 1)) return false;
    if (Math.abs(values[i]!) > 1 || Math.abs(values[i + 1]!) > 1) coordinateOutsideUnit = true;
  }
  return coordinateOutsideUnit;
}

function clampPressure(pressure: number): number {
  if (!Number.isFinite(pressure) || pressure <= 0) return 0.5;
  return Math.min(1, pressure);
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

interface FloatRun {
  readonly field: number;
  readonly values: Float32Array;
  /**
   * Where the bytes behind this run live in the file. `values` is a fresh array
   * rather than a view, so it cannot answer that itself — and the answer is what
   * identifies a run that the walk reaches twice.
   */
  readonly at: number;
  readonly length: number;
}

/** Every length-delimited field in one message that reads as a run of floats. */
function floatRuns(message: readonly PbField[]): FloatRun[] {
  const runs: FloatRun[] = [];
  for (const field of message) {
    if (field.wire !== WIRE_LENGTH) continue;
    const values = asFloat32Array(field.bytes);
    if (values && allFinite(values)) {
      runs.push({ field: field.field, values, at: field.bytes.byteOffset, length: field.bytes.byteLength });
    }
  }
  return runs;
}

/** A scalar in the same message that could be a stroke width. */
function widthNear(message: readonly PbField[]): number | undefined {
  for (const field of message) {
    if (field.wire === WIRE_FIXED32 && field.float >= MIN_WIDTH && field.float <= MAX_WIDTH) return field.float;
    if (field.wire === WIRE_FIXED64 && field.double >= MIN_WIDTH && field.double <= MAX_WIDTH) return field.double;
  }
  return undefined;
}

/**
 * Every run of floats in the tree that could be a stroke.
 *
 * Deduplicated by where the bytes live, because walking descends into
 * length-delimited fields speculatively and the same run can be reached twice —
 * once as itself and once through a parent that also parsed as a message. Two
 * copies of one stroke is a visible artefact, so the byte range is the identity.
 */
export function findCandidates(fields: readonly PbField[]): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const message of walkMessages(fields)) {
    const runs = floatRuns(message);
    if (runs.length === 0) continue;

    // The longest run in a message is the geometry; the short ones beside it are
    // its pressures and its colour. Ties keep document order.
    const sorted = [...runs].sort((a, b) => b.values.length - a.values.length);
    const geometry = sorted[0]!;
    const key = `${geometry.at}:${geometry.length}`;
    if (seen.has(key)) continue;
    if (geometry.values.length < MIN_POINTS * 2) continue;
    if (looksLikeColor(geometry.values)) continue;
    if (!varies(geometry.values)) continue;

    const points = samplesFrom(geometry.values);
    if (!points) continue;

    const others = sorted.slice(1);
    const pressures = others.find((run) => looksLikePressures(run.values, points.length));
    const colorRun = others.find((run) => run !== pressures && looksLikeColor(run.values));
    const width = widthNear(message);

    const withPressure = pressures
      ? points.map((point, i) => ({ ...point, pressure: clampPressure(pressures.values[i]!) }))
      : points;

    // Confidence is the count of independent shape tests that agreed, which is
    // all it claims to be: a way to sort and to threshold, not a probability.
    let confidence = 0.4;
    if (pressures) confidence += 0.3;
    if (points[0]!.pressure !== 1 && !pressures) confidence += 0.2;
    if (colorRun) confidence += 0.1;
    if (width !== undefined) confidence += 0.1;
    if (points.length >= 8) confidence += 0.1;

    seen.add(key);

    const color = colorRun ? colorFrom(colorRun.values) : null;
    candidates.push({
      points: withPressure,
      confidence: Math.min(1, confidence),
      ...(width !== undefined ? { width } : {}),
      ...(color ? { color: color.color } : {}),
      ...(color && color.alpha < 0.99 ? { alpha: color.alpha } : {}),
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Fitting the source's coordinate space into ours
// ---------------------------------------------------------------------------

/**
 * Page sizes worth guessing, in PostScript points, in the order they are tried.
 *
 * GoodNotes lays a page out in points and its own paper list is the usual one,
 * so the source page is very probably one of these — but the file never says so
 * anywhere this importer can read. Snapping to the first that contains the ink
 * keeps every page of a notebook on one scale, which is what stops page 3 coming
 * in twice the size of page 2 because someone wrote bigger on it.
 *
 * The order starts at A4 rather than at the smallest paper there is, and that is
 * the interesting decision. The ink's bounding box is only a *lower* bound on the
 * page: somebody who wrote in the top corner of an A4 sheet leaves ink that would
 * fit on A6. Guessing small then magnifies their handwriting to fill the page,
 * which is the worse of the two errors — it destroys the layout and cannot be
 * told apart from correct output. Guessing large leaves the writing smaller than
 * it was, which looks like what it is and which the lasso can scale back up.
 * There is no A5 entry for that reason: an A5 notebook comes in at 70%, legibly.
 */
export const SOURCE_PAGE_SIZES: ReadonlyArray<{ readonly name: string; readonly width: number; readonly height: number }> = [
  { name: 'A4', width: 595.28, height: 841.89 },
  { name: 'Letter', width: 612, height: 792 },
  { name: 'Legal', width: 612, height: 1008 },
  { name: 'A3', width: 841.89, height: 1190.55 },
  { name: 'Tabloid', width: 792, height: 1224 },
  // The same papers at 2×, which is what a file storing device pixels looks
  // like on a Retina display.
  { name: 'A4 at 2×', width: 1190.56, height: 1683.78 },
  { name: 'Letter at 2×', width: 1224, height: 1584 },
];

export interface Fit {
  /** Multiply source coordinates by this. */
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Which page size the fit was derived from, for the import report. */
  readonly source: string;
  /**
   * False when nothing plausible contained the ink and the fit is a plain
   * shrink-to-fit of its bounding box. Worth telling the user about: the layout
   * will be right relative to itself and wrong relative to the page.
   */
  readonly matched: boolean;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(candidates: readonly Candidate[]): Bounds | null {
  const bounds: Bounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  let any = false;
  for (const candidate of candidates) {
    for (const point of candidate.points) {
      any = true;
      if (point.x < bounds.minX) bounds.minX = point.x;
      if (point.y < bounds.minY) bounds.minY = point.y;
      if (point.x > bounds.maxX) bounds.maxX = point.x;
      if (point.y > bounds.maxY) bounds.maxY = point.y;
    }
  }
  return any ? bounds : null;
}

/**
 * One transform for the whole notebook, derived from every page's ink at once.
 *
 * Per-page fitting would be worse than useless: each page would get its own
 * scale, so handwriting that was the same size throughout would arrive in a
 * different size on every page. Deriving one scale from the union of all the
 * ink keeps the notebook internally consistent even when the absolute guess is
 * wrong.
 */
export function fitToPage(
  pages: ReadonlyArray<readonly Candidate[]>,
  page: { readonly width: number; readonly height: number },
  margin = 0,
): Fit {
  const bounds = boundsOf(pages.flat());
  const usableWidth = Math.max(1, page.width - margin * 2);
  const usableHeight = Math.max(1, page.height - margin * 2);
  if (!bounds) return { scale: 1, offsetX: 0, offsetY: 0, source: 'nothing to fit', matched: false };

  // Ink is positioned from the page's top-left, so the page has to contain the
  // origin as well as the ink: a page whose writing starts halfway down is
  // still a whole page.
  const extentX = Math.max(bounds.maxX, 0) - Math.min(bounds.minX, 0);
  const extentY = Math.max(bounds.maxY, 0) - Math.min(bounds.minY, 0);

  // First, not smallest: the order encodes the preference (see above).
  const paper = SOURCE_PAGE_SIZES.find((size) => extentX <= size.width && extentY <= size.height);
  if (paper) {
    const scale = Math.min(usableWidth / paper.width, usableHeight / paper.height);
    return {
      scale,
      offsetX: margin - Math.min(bounds.minX, 0) * scale,
      offsetY: margin - Math.min(bounds.minY, 0) * scale,
      source: paper.name,
      matched: true,
    };
  }

  // Nothing contained it, so the units are not points and there is nothing left
  // to infer from. Fit the ink's own box and say as much.
  const scale = Math.min(usableWidth / Math.max(extentX, 1), usableHeight / Math.max(extentY, 1));
  return {
    scale,
    offsetX: margin - Math.min(bounds.minX, 0) * scale,
    offsetY: margin - Math.min(bounds.minY, 0) * scale,
    source: 'the ink’s own bounding box',
    matched: false,
  };
}

// ---------------------------------------------------------------------------
// Into our model
// ---------------------------------------------------------------------------

/**
 * Turn candidates into strokes this app can draw.
 *
 * Everything arrives as a ballpoint pen stroke. GoodNotes' pen, highlighter and
 * brush are distinguished by fields this importer cannot identify, and guessing
 * would produce a page where some strokes are silently translucent; one honest
 * pen is better than three confident wrong ones. A width and a colour are used
 * when the shape search found them and defaulted when it did not.
 */
export function toStrokes(
  candidates: readonly Candidate[],
  fit: Fit,
  defaults: { readonly color: string; readonly size: number } = { color: '#18181b', size: 2 },
): FreehandStroke[] {
  const strokes: FreehandStroke[] = [];
  const createdAt = Date.now();

  for (const candidate of candidates) {
    const points: InkPoint[] = candidate.points.map((point) => ({
      x: point.x * fit.scale + fit.offsetX,
      y: point.y * fit.scale + fit.offsetY,
      pressure: point.pressure,
    }));

    const scaledWidth = candidate.width === undefined ? defaults.size : candidate.width * fit.scale;
    const size = Math.min(MAX_PAGE_WIDTH, Math.max(MIN_PAGE_WIDTH, scaledWidth));
    const style = brushStyle(
      'ballpoint',
      { color: candidate.color ?? defaults.color, size, pattern: 'solid', arrowheads: 'none' },
      'pen',
    );
    const withAlpha =
      candidate.alpha === undefined ? style : { ...style, opacity: Math.max(0.05, candidate.alpha) };

    strokes.push({
      kind: 'freehand',
      tool: 'pen',
      id: createStrokeId(),
      style: withAlpha,
      bbox: freehandBBox(points, withAlpha),
      pointerType: 'pen',
      points,
      createdAt,
    });
  }

  return strokes;
}
