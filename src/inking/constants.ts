import { DEFAULT_BRUSH } from './engine/brushes';
import { ERASE_EVERYTHING } from './engine/eraseFilter';
import { LASSO_ALL_LAYERS } from './engine/lassoFilter';
import type { CoordinatePlaneConfig, StrokePattern, StylusSettings, ToolSettings, ToolType } from './types';

/** Pressure substituted when a device reports `0` (mouse, many touch digitisers). */
export const DEFAULT_PRESSURE = 0.5;

/**
 * Touch input is rejected for this long after the last pen event. Covers the
 * gap between the pen leaving hover range and the palm being lifted.
 */
export const PALM_REJECTION_GRACE_MS = 700;

/**
 * A hovering pen normally announces its departure with `pointerleave`, but not
 * every stack does. After this long without any pen event the "in proximity"
 * flag is treated as stale so touch input is not locked out forever.
 */
export const PEN_PROXIMITY_TIMEOUT_MS = 3000;

/** Cap on backing-store scale to bound memory on very dense displays. */
export const MAX_DEVICE_PIXEL_RATIO = 3;

/** Default undo depth. */
export const MAX_HISTORY_DEPTH = 200;

/**
 * Highlighter width in page px. Like the eraser's, it is its own setting: a
 * highlighter is a chisel of a fixed size, not a scaled-up pen.
 */
export const MIN_HIGHLIGHTER_WIDTH = 4;
export const MAX_HIGHLIGHTER_WIDTH = 72;
export const DEFAULT_HIGHLIGHTER_WIDTH = 16;
/** The other end of a dual-colour highlighter, before anything is picked. */
export const DEFAULT_HIGHLIGHTER_GRADIENT_TO = '#22d3ee';

/**
 * Area-eraser diameter in page px. It is its own setting rather than a
 * multiple of the pen width, because how thick you write and how precisely
 * you want to rub something out are unrelated decisions.
 */
/**
 * The stroke eraser's hit radius, in page px.
 *
 * Fixed, and small on purpose. The stroke eraser removes whole strokes it
 * crosses, so its size is not a brush width but a *precision*: a wide one
 * takes the neighbouring stroke as well and feels like it is guessing. It is
 * deliberately not the area eraser's size — how thickly you rub out a patch
 * and how precisely you pick one line out of a diagram are unrelated, and
 * sharing the slider made the stroke eraser unusable the moment the area
 * eraser had been set wide.
 */
export const STROKE_ERASER_RADIUS = 3;

export const MIN_ERASER_SIZE = 4;
export const MAX_ERASER_SIZE = 96;
export const DEFAULT_ERASER_SIZE = 16;

/** Default highlighter layer opacity (rendered with `multiply`). */
export const HIGHLIGHTER_OPACITY = 0.35;

/**
 * Range the highlighter's opacity slider covers. The floor keeps a stroke
 * visible at all; the ceiling keeps it a highlighter rather than a marker
 * that buries the text underneath.
 */
export const MIN_HIGHLIGHTER_OPACITY = 0.1;
export const MAX_HIGHLIGHTER_OPACITY = 0.9;

/**
 * The thinnest a pen can be, in page px: well under one, for writing small with the page zoomed in, where a
 * 1 px line is several screen pixels and fills the loops of letters a few pixels high.
 */
export const MIN_STROKE_SIZE = 0.25;
export const MAX_STROKE_SIZE = 24;

/**
 * Where the thickness sliders stop: fine steps below 1 px, where a quarter of a pixel is a third of the line, and
 * coarser ones above. An even 0.5 step from 0.25 left the fine end two notches long.
 */
export const STROKE_SIZE_STEPS: readonly number[] = [
  0.25, 0.35, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24,
];

/** The slider notch nearest a size (a size set before the notches were these lands on the closest). */
export function sizeToStep(size: number): number {
  let best = 0;
  for (let i = 1; i < STROKE_SIZE_STEPS.length; i++) {
    if (Math.abs(STROKE_SIZE_STEPS[i]! - size) < Math.abs(STROKE_SIZE_STEPS[best]! - size)) best = i;
  }
  return best;
}

export function stepToSize(step: number): number {
  const i = Math.min(STROKE_SIZE_STEPS.length - 1, Math.max(0, Math.round(step)));
  return STROKE_SIZE_STEPS[i]!;
}

// ---- Hold-to-snap ---------------------------------------------------------

/** Dwell required at the end of a stroke before shape recognition runs. */
export const HOLD_TO_SNAP_MS = 1000;
/** Movement below this radius counts as "stationary" during the dwell. */
export const SNAP_JITTER_PX = 5;
/**
 * …but once a shape has been recognised it takes this much to give it up. A
 * stylus slides a few pixels as it leaves the glass, and at the jitter radius
 * that lift was discarding the snap the user had just waited a second for.
 * Past this, carrying on drawing is clearly what was meant.
 */
export const SNAP_RELEASE_PX = 28;
/** Strokes shorter than this are never snapped (taps, dots). */
export const MIN_SNAP_PATH_LENGTH_PX = 24;

// ---- Washi tape -----------------------------------------------------------

/** A strip is wide: these are band widths in page px, not pen widths. */
export const MIN_WASHI_WIDTH = 8;
export const MAX_WASHI_WIDTH = 96;
export const DEFAULT_WASHI_WIDTH = 32;
/** Tape is translucent enough to read writing through, like the real thing. */
export const DEFAULT_WASHI_OPACITY = 0.7;
export const MIN_WASHI_OPACITY = 0.2;
export const MAX_WASHI_OPACITY = 1;
export const DEFAULT_WASHI_ACCENT = '#ffffff';

// ---- Procedural curves ----------------------------------------------------

/**
 * How deep a curve bows, as a fraction of the drag's own length, so the shape
 * of a curve is the same whether it spans an inch or the page.
 */
export const DEFAULT_CURVE_AMPLITUDE = 0.18;
export const MIN_CURVE_AMPLITUDE = 0.02;
export const MAX_CURVE_AMPLITUDE = 0.6;

/** Whole cycles a wave or zigzag fits between the drag's endpoints. */
export const DEFAULT_CURVE_CYCLES = 4;
export const MIN_CURVE_CYCLES = 1;
export const MAX_CURVE_CYCLES = 20;

// ---- Angles ---------------------------------------------------------------

export const ANGLE_SNAP_INCREMENT_DEG = 15;
/** Endpoints closer than this are treated as connected for the angle HUD. */
export const CONNECT_TOLERANCE_PX = 14;

// ---- Patterns / coordinate plane -----------------------------------------

export const STROKE_PATTERNS: readonly { readonly id: StrokePattern; readonly label: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'dotted', label: 'Dotted' },
  { id: 'dash-dot', label: 'Dash-dot' },
  { id: 'long-dash', label: 'Long dash' },
];

export const DEFAULT_AXIS_STEP = 1;

export const DEFAULT_COORDINATE_PLANE: Readonly<CoordinatePlaneConfig> = {
  mode: 'four-quadrant',
  divisions: 5,
  showGrid: true,
  tickLabels: false,
  xLabel: 'x',
  yLabel: 'y',
  stepX: DEFAULT_AXIS_STEP,
  stepY: DEFAULT_AXIS_STEP,
};

/** What one grid cell is worth when nothing says otherwise. */
export const MIN_AXIS_STEP = 0.0001;
export const MAX_AXIS_STEP = 100000;

/** Quick axis-label pairs for common STEM diagrams. */
export const AXIS_LABEL_PRESETS: readonly { readonly x: string; readonly y: string }[] = [
  { x: 'x', y: 'y' },
  { x: 't', y: 'y' },
  { x: 't', y: 'x(t)' },
  { x: 'σ', y: 'jω' },
  { x: 'Re', y: 'Im' },
  { x: 'Q', y: 'P' },
  { x: 'f', y: '|H(f)|' },
];

/**
 * The tools a pen button can be given, with the labels the settings show.
 *
 * One list for the settings selects *and* for validating what was saved, so a
 * stored value that names a tool which no longer exists is rejected by the same
 * definition that would have offered it.
 */
export const STYLUS_TOOLS: readonly { readonly id: ToolType; readonly label: string }[] = [
  { id: 'pen', label: 'Pen' },
  { id: 'highlighter', label: 'Highlighter' },
  { id: 'eraser-stroke', label: 'Stroke eraser' },
  { id: 'eraser-pixel', label: 'Area eraser' },
  { id: 'lasso', label: 'Lasso' },
  { id: 'select', label: 'Select' },
  { id: 'laser-pointer', label: 'Laser pointer' },
  { id: 'line', label: 'Lines and shapes' },
];

export const DEFAULT_STYLUS_SETTINGS: Readonly<StylusSettings> = {
  // A quick press swaps pen and eraser, which is what the button is for on every
  // tablet that has one.
  clickToggle: ['pen', 'eraser-stroke'],
  // Holding the barrel button borrows the eraser: the thing you reach for
  // mid-sentence, and the one that needs no aiming at a toolbar.
  holdTool: 'eraser-stroke',
  // The second button borrows the lasso. Windows reports a pen's second button as
  // its eraser flag, so this is also what an eraser *tip* would do — which is
  // right for a pen with two buttons and no tip, and worth changing back to an
  // eraser for one that has a tip.
  eraserEnd: 'lasso',
};

/**
 * How long the laser trail stays at full strength after the last pointer
 * event. Any movement restarts it, so a trail drawn in several strokes
 * survives as long as the presenter keeps working on it.
 */
export const LASER_HOLD_MS = 2700;

/** How long the whole trail then takes to fade out, all at once. */
export const LASER_FADE_OUT_MS = 450;

/** Full hue cycle of the rainbow laser, in milliseconds of drawing. */
export const LASER_RAINBOW_PERIOD_MS = 1800;

/** Default laser colour (the laser keeps its own colour, apart from the ink colour). */
export const LASER_DEFAULT_COLOR = '#ef4444';

export const DEFAULT_TOOL_SETTINGS: Readonly<ToolSettings> = {
  tool: 'pen',
  color: '#1f1f24',
  // The finest the slider goes: what most people write with.
  size: 1,
  touchDraw: false,
  brush: DEFAULT_BRUSH,
  highlighterOpacity: HIGHLIGHTER_OPACITY,
  highlighterWidth: DEFAULT_HIGHLIGHTER_WIDTH,
  highlighterGradient: 'none',
  highlighterGradientTo: DEFAULT_HIGHLIGHTER_GRADIENT_TO,
  washiWidth: DEFAULT_WASHI_WIDTH,
  washiOpacity: DEFAULT_WASHI_OPACITY,
  washiPattern: 'stripes',
  washiAccent: DEFAULT_WASHI_ACCENT,
  washiStraighten: true,
  eraserMode: 'stroke',
  eraserSize: DEFAULT_ERASER_SIZE,
  eraseFilter: ERASE_EVERYTHING,
  laserColor: LASER_DEFAULT_COLOR,
  laserRainbow: false,
  pattern: 'solid',
  arrowheads: 'none',
  angleSnap: false,
  lineCurve: 'straight',
  curveAmplitude: DEFAULT_CURVE_AMPLITUDE,
  curveCycles: DEFAULT_CURVE_CYCLES,
  curveFlip: false,
  linePattern: 'solid',
  lineArrowheads: 'none',
  lineAngleSnap: false,
  lineGridSnap: false,
  lassoFilter: LASSO_ALL_LAYERS,
  lassoMode: 'enclose',
  holdToSnap: true,
  coordinatePlane: DEFAULT_COORDINATE_PLANE,
  stylus: DEFAULT_STYLUS_SETTINGS,
  debugMode: false,
};

/**
 * Quick-pick swatches shown in the toolbar: black, blue, green, red, brown, purple,
 * orange, pink — the order they were asked for, so the first six are the everyday
 * ones (the selection's own toolbar shows those).
 */
export const COLOR_PALETTE: readonly string[] = [
  '#1f1f24',
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#8b5a2b',
  '#7c3aed',
  '#ea580c',
  '#ec4899',
];

/**
 * The swatches the app shipped with before that, so that a person who never changed
 * them is moved to the new ones, and one who did is left alone.
 */
export const LEGACY_COLOR_PALETTE: readonly string[] = [
  '#1f1f24',
  '#e11d48',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0284c7',
  '#7c3aed',
  '#ffffff',
];

/** The two widths within reach of one tap: a fine one to write with and a broader one to rule lines with. */
export const DEFAULT_WIDTH_PRESETS: readonly number[] = [1, 5];
