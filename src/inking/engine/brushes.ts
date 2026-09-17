/**
 * Advanced brush engine.
 *
 * A brush is a named preset that drives three things at once:
 *
 *  1. the perfect-freehand parameters baked into a stroke's `StrokeStyle`
 *     when it starts (width scale, pressure response, smoothing, tapers),
 *  2. the pressure→radius easing and the end tapers applied when the outline
 *     is generated, some of which depend on the samples themselves (a
 *     fountain pen's taper follows the speed of the nib), and
 *  3. how the outline is painted: hard polygon edges or smooth curves, a
 *     grain pattern inside the path, a soft bleed pass around it, and how
 *     the ends are capped.
 *
 * Only the brush *id* is stored on the style: the rest is looked up at paint
 * time, so a brush stays a single definition and strokes serialise as before
 * plus one short string.
 */
import type { BrushId, InkPoint, StrokeStyle, ToolSettings } from '../types';

export type { BrushId };

/** How the ends of a stroke are closed. */
export type BrushCap = 'round' | 'flat';

/** Extra fill applied inside the outline. */
export type BrushTexture = 'none' | 'pencil';

/** Shape of the pressure → radius response. */
export type BrushEasing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

export interface BrushDefinition {
  readonly id: BrushId;
  readonly label: string;
  readonly hint: string;
  /** Multiplies the toolbar width. */
  readonly sizeScale: number;
  readonly opacity: number;
  readonly composite: GlobalCompositeOperation;
  /** perfect-freehand parameters. */
  readonly thinning: number;
  readonly smoothing: number;
  readonly streamline: number;
  readonly easing: BrushEasing;
  /** Fixed taper in px at each end (before any velocity term). */
  readonly taperStart: number;
  readonly taperEnd: number;
  /**
   * Fountain-style nib: additional end taper proportional to the pen's speed
   * there, in px per (px/ms), capped at `velocityTaperMax`.
   */
  readonly velocityTaper: number;
  readonly velocityTaperMax: number;
  readonly cap: BrushCap;
  readonly texture: BrushTexture;
  /** Soft edge pass around the body, as a fraction of the stroke width. */
  readonly bleed: number;
  /** Alpha of that soft edge, relative to the stroke opacity. */
  readonly bleedAlpha: number;
  /** Outline drawn with smooth quadratic curves (false = hard polygon edges). */
  readonly smoothOutline: boolean;
  /** How strongly pen tilt widens and lightens the mark (0 = ignore tilt). */
  readonly tiltResponse: number;
}

const DEFINITIONS: Readonly<Record<BrushId, BrushDefinition>> = {
  ballpoint: {
    id: 'ballpoint',
    label: 'Ballpoint',
    hint: 'Fixed width, hard edges, barely any pressure variance',
    // The default brush, so the toolbar width means exactly what it says.
    sizeScale: 1,
    opacity: 1,
    composite: 'source-over',
    thinning: 0.08,
    smoothing: 0.5,
    // High streamline damps jitter but also lags the pen; 0.5 keeps a short
    // stroke the length the user drew it.
    streamline: 0.5,
    easing: 'linear',
    taperStart: 0,
    taperEnd: 0,
    velocityTaper: 0,
    velocityTaperMax: 0,
    cap: 'round',
    texture: 'none',
    bleed: 0,
    bleedAlpha: 0,
    smoothOutline: false,
    tiltResponse: 0,
  },
  fountain: {
    id: 'fountain',
    label: 'Fountain pen',
    hint: 'Strong pressure variance with a nib that tapers as the pen accelerates',
    sizeScale: 1.15,
    opacity: 1,
    composite: 'source-over',
    thinning: 0.78,
    smoothing: 0.62,
    streamline: 0.45,
    easing: 'ease-in-out',
    taperStart: 2,
    taperEnd: 4,
    velocityTaper: 8,
    velocityTaperMax: 30,
    cap: 'round',
    texture: 'none',
    bleed: 0,
    bleedAlpha: 0,
    smoothOutline: true,
    tiltResponse: 0.15,
  },
  pencil: {
    id: 'pencil',
    label: 'Pencil',
    hint: 'Grainy graphite; tilt the pen to shade broader and lighter',
    sizeScale: 1,
    opacity: 0.82,
    composite: 'source-over',
    thinning: 0.5,
    smoothing: 0.35,
    streamline: 0.4,
    easing: 'ease-out',
    taperStart: 0,
    taperEnd: 0,
    velocityTaper: 0,
    velocityTaperMax: 0,
    cap: 'round',
    texture: 'pencil',
    bleed: 0,
    bleedAlpha: 0,
    smoothOutline: true,
    tiltResponse: 1,
  },
  marker: {
    id: 'marker',
    label: 'Marker',
    hint: 'Thick chisel tip, translucent multiply ink that bleeds at the edges',
    sizeScale: 2.4,
    opacity: 0.62,
    composite: 'multiply',
    thinning: 0,
    smoothing: 0.5,
    streamline: 0.5,
    easing: 'linear',
    taperStart: 0,
    taperEnd: 0,
    velocityTaper: 0,
    velocityTaperMax: 0,
    cap: 'flat',
    texture: 'none',
    bleed: 0.22,
    bleedAlpha: 0.45,
    smoothOutline: true,
    tiltResponse: 0,
  },
  brush: {
    id: 'brush',
    label: 'Brush',
    hint: 'Wet brush: very smooth, very pressure-sensitive, spreads at the edges',
    sizeScale: 1.8,
    opacity: 0.92,
    composite: 'source-over',
    thinning: 0.86,
    smoothing: 0.85,
    streamline: 0.62,
    easing: 'ease-in',
    taperStart: 6,
    taperEnd: 18,
    velocityTaper: 6,
    velocityTaperMax: 24,
    cap: 'round',
    texture: 'none',
    bleed: 0.26,
    bleedAlpha: 0.32,
    smoothOutline: true,
    tiltResponse: 0.2,
  },
};

export const BRUSHES: readonly BrushDefinition[] = [
  DEFINITIONS.ballpoint,
  DEFINITIONS.fountain,
  DEFINITIONS.pencil,
  DEFINITIONS.marker,
  DEFINITIONS.brush,
];

export const DEFAULT_BRUSH: BrushId = 'ballpoint';

export function isBrushId(value: string): value is BrushId {
  return value in DEFINITIONS;
}

/** The named brush, falling back to the default for unknown / legacy ids. */
export function brushById(id: BrushId | undefined): BrushDefinition {
  return (id && DEFINITIONS[id]) || DEFINITIONS[DEFAULT_BRUSH];
}

/** The brush a stroke was drawn with (legacy strokes have none). */
export function strokeBrush(style: StrokeStyle): BrushDefinition | null {
  return style.brush ? brushById(style.brush) : null;
}

const EASINGS: Readonly<Record<BrushEasing, (t: number) => number>> = {
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => t * (2 - t),
  'ease-in-out': (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
};

export function brushEasing(easing: BrushEasing): (t: number) => number {
  return EASINGS[easing];
}

/** Pressure → radius easing for a style (identity without a brush). */
export function easingForStyle(style: StrokeStyle): (t: number) => number {
  const brush = strokeBrush(style);
  return brush ? EASINGS[brush.easing] : EASINGS.linear;
}

/** Frozen render style for a new stroke drawn with `id`. */
export function brushStyle(
  id: BrushId,
  settings: Readonly<Pick<ToolSettings, 'color' | 'size' | 'pattern' | 'arrowheads'>>,
  pointerType: 'pen' | 'touch' | 'mouse',
): StrokeStyle {
  const brush = brushById(id);
  return {
    color: settings.color,
    size: Math.max(0.5, settings.size * brush.sizeScale),
    opacity: brush.opacity,
    compositeOperation: brush.composite,
    thinning: brush.thinning,
    smoothing: brush.smoothing,
    streamline: brush.streamline,
    // A device that reports no pressure still gets life from velocity, except
    // for brushes that are meant to be even-width.
    simulatePressure: pointerType !== 'pen' && brush.thinning > 0.2,
    taperStart: brush.taperStart,
    taperEnd: brush.taperEnd,
    pattern: settings.pattern,
    arrowheads: settings.arrowheads,
    brush: id,
  };
}

// ---------------------------------------------------------------------------
// Tilt
// ---------------------------------------------------------------------------

/** Tilt at which the pen counts as fully flat (degrees from vertical). */
export const MAX_TILT_DEG = 70;

/**
 * Normalised tilt magnitude in 0..1 from the two W3C tilt axes: 0 is upright,
 * 1 is flat on the page. `tiltX`/`tiltY` are independent angles from the
 * vertical, so the combined lean is their vector magnitude.
 */
export function tiltMagnitude(tiltX: number, tiltY: number): number {
  const x = Number.isFinite(tiltX) ? tiltX : 0;
  const y = Number.isFinite(tiltY) ? tiltY : 0;
  if (x === 0 && y === 0) return 0;
  const degrees = Math.min(90, Math.hypot(x, y));
  return Math.min(1, degrees / MAX_TILT_DEG);
}

/**
 * Effective pressure for a pencil sample: leaning the pencil over broadens
 * the mark even at the same pressure, because more of the lead touches.
 */
export function pencilPressure(pressure: number, tilt: number, response: number): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
  const t = Math.min(1, Math.max(0, tilt)) * response;
  return Math.min(1, p * (1 + 0.9 * t));
}

/**
 * Width multiplier for a leaning pencil. Pressure alone cannot widen a mark
 * much (perfect-freehand's thinning only spans a fraction of the size), so
 * the lean scales the nib itself for the run of samples it covers.
 */
export function pencilWidthScale(tilt: number, response: number): number {
  const t = Math.min(1, Math.max(0, tilt)) * response;
  return 1 + 0.9 * t;
}

/** …and lightens it, because the same graphite is spread over more paper. */
export function pencilAlpha(pressure: number, tilt: number, response: number): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
  const t = Math.min(1, Math.max(0, tilt)) * response;
  return Math.min(1, Math.max(0.15, (0.45 + 0.75 * p) * (1 - 0.45 * t)));
}

/** Mean pressure and tilt of a run of samples. */
export function meanPressureTilt(points: readonly InkPoint[]): { pressure: number; tilt: number } {
  if (points.length === 0) return { pressure: 0.5, tilt: 0 };
  let pressure = 0;
  let tilt = 0;
  for (const p of points) {
    pressure += Number.isFinite(p.pressure) ? p.pressure : 0.5;
    tilt += p.tilt ?? 0;
  }
  return { pressure: pressure / points.length, tilt: tilt / points.length };
}

/**
 * Apply perfect-freehand's input smoothing up front, using its own formula
 * (`t = 0.15 + (1 - streamline) · 0.85`, a running lerp towards the previous
 * point). A chunked brush needs this: `getStroke` would otherwise re-apply
 * the lag inside every chunk, pulling each one away from its neighbour and
 * opening hairline seams at the joins.
 */
export function streamlinePoints(points: readonly InkPoint[], streamline: number): readonly InkPoint[] {
  const t = 0.15 + (1 - Math.min(1, Math.max(0, streamline))) * 0.85;
  if (points.length < 2 || t >= 1) return points;
  const first = points[0];
  if (!first) return points;
  const out: InkPoint[] = [first];
  for (let i = 1; i < points.length; i++) {
    const prev = out[i - 1];
    const p = points[i];
    if (!prev || !p) break;
    out.push({ ...p, x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t });
  }
  return out;
}

/**
 * Split a stroke into overlapping chunks so a textured brush can vary its
 * opacity along the stroke: each chunk is filled separately, and sharing an
 * endpoint with its neighbour keeps the joins seamless.
 */
export function chunkRanges(count: number, maxChunks: number, minPoints = 8): Array<[number, number]> {
  if (count < 2) return count === 1 ? [[0, 1]] : [];
  const chunks = Math.max(1, Math.min(maxChunks, Math.floor(count / minPoints)));
  if (chunks <= 1) return [[0, count]];
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < chunks; i++) {
    const start = Math.floor((i * count) / chunks);
    const end = i === chunks - 1 ? count : Math.floor(((i + 1) * count) / chunks) + 1;
    if (end - start >= 2) ranges.push([start, end]);
  }
  return ranges.length > 0 ? ranges : [[0, count]];
}

/** Chunks a pencil stroke is painted in. */
export const PENCIL_MAX_CHUNKS = 10;

// ---------------------------------------------------------------------------
// Velocity taper (fountain nib)
// ---------------------------------------------------------------------------

/** Speed in px/ms over the last `window` samples at one end of a stroke. */
export function endSpeed(points: readonly InkPoint[], atStart: boolean, window = 4): number {
  const n = points.length;
  if (n < 2) return 0;
  const count = Math.min(window, n - 1);
  let distance = 0;
  for (let i = 0; i < count; i++) {
    const a = atStart ? points[i] : points[n - 1 - i];
    const b = atStart ? points[i + 1] : points[n - 2 - i];
    if (!a || !b) break;
    distance += Math.hypot(b.x - a.x, b.y - a.y);
  }
  // Samples arrive at a roughly fixed rate, so distance per sample is a good
  // stand-in for speed without storing timestamps on every point.
  return distance / count;
}

export interface Tapers {
  readonly start: number;
  readonly end: number;
}

/**
 * Tapers for a stroke: the style's fixed taper plus, for nib-like brushes, a
 * term proportional to how fast the pen was moving at that end — a flick
 * finishes in a hairline, a deliberate stop stays full width.
 */
export function strokeTapers(points: readonly InkPoint[], style: StrokeStyle): Tapers {
  const brush = strokeBrush(style);
  if (!brush || brush.velocityTaper === 0) return { start: style.taperStart, end: style.taperEnd };
  const scale = (speed: number): number => Math.min(brush.velocityTaperMax, speed * brush.velocityTaper * 0.1);
  return {
    start: style.taperStart + scale(endSpeed(points, true)),
    end: style.taperEnd + scale(endSpeed(points, false)),
  };
}

/**
 * Extra bounding-box padding a brush needs: its soft edge, plus the widest a
 * tilt-responsive nib can get (the box is a bound, so the worst case is the
 * right thing to reserve).
 */
export function brushPadding(style: StrokeStyle): number {
  const brush = strokeBrush(style);
  if (!brush) return 0;
  const tiltWidening = brush.tiltResponse > 0 ? (style.size * (pencilWidthScale(1, brush.tiltResponse) - 1)) / 2 : 0;
  return style.size * brush.bleed + tiltWidening;
}

// ---------------------------------------------------------------------------
// Pencil grain
// ---------------------------------------------------------------------------

/** Side of the repeating grain tile, in drawing units. */
export const GRAIN_TILE = 64;

/** Deterministic value noise in 0..1 for the grain tile. */
export function grainNoise(x: number, y: number, seed = 1): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 43.7585) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Alpha mask of the grain tile: mostly opaque with scattered thin spots, so
 * a filled path reads as graphite caught on paper tooth rather than as a
 * flat colour. Returned as RGBA bytes for `putImageData`.
 */
export function grainTileData(size = GRAIN_TILE, seed = 1): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(new ArrayBuffer(size * size * 4));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const coarse = grainNoise(Math.floor(x / 2), Math.floor(y / 2), seed);
      const fine = grainNoise(x, y, seed + 7);
      // Two octaves: paper tooth plus per-pixel speckle.
      const value = 0.55 * coarse + 0.45 * fine;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, 0.35 + value * 0.75)));
    }
  }
  return data;
}
