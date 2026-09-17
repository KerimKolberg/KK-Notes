import { DEFAULT_BRUSH } from './engine/brushes';
import type { CoordinatePlaneConfig, StrokePattern, StylusSettings, ToolSettings } from './types';

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

/** Highlighter width relative to the base stroke width. */
export const HIGHLIGHTER_SIZE_MULTIPLIER = 4;

/** Eraser (both kinds) diameter relative to the base stroke width. */
export const ERASER_SIZE_MULTIPLIER = 4;

/** Default highlighter layer opacity (rendered with `multiply`). */
export const HIGHLIGHTER_OPACITY = 0.35;

/**
 * Range the highlighter's opacity slider covers. The floor keeps a stroke
 * visible at all; the ceiling keeps it a highlighter rather than a marker
 * that buries the text underneath.
 */
export const MIN_HIGHLIGHTER_OPACITY = 0.1;
export const MAX_HIGHLIGHTER_OPACITY = 0.9;

export const MIN_STROKE_SIZE = 1;
export const MAX_STROKE_SIZE = 24;

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

export const DEFAULT_COORDINATE_PLANE: Readonly<CoordinatePlaneConfig> = {
  mode: 'four-quadrant',
  divisions: 5,
  showGrid: true,
  tickLabels: false,
  xLabel: 'x',
  yLabel: 'y',
};

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

export const DEFAULT_STYLUS_SETTINGS: Readonly<StylusSettings> = {
  barrelButton: 'eraser-stroke',
  eraserEnd: 'eraser-stroke',
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
  size: 4,
  touchDraw: false,
  brush: DEFAULT_BRUSH,
  highlighterOpacity: HIGHLIGHTER_OPACITY,
  laserColor: LASER_DEFAULT_COLOR,
  laserRainbow: false,
  pattern: 'solid',
  arrowheads: 'none',
  lineCurve: 'straight',
  curveAmplitude: DEFAULT_CURVE_AMPLITUDE,
  curveCycles: DEFAULT_CURVE_CYCLES,
  curveFlip: false,
  angleSnap: false,
  holdToSnap: true,
  coordinatePlane: DEFAULT_COORDINATE_PLANE,
  stylus: DEFAULT_STYLUS_SETTINGS,
};

/** Quick-pick swatches shown in the toolbar. */
export const COLOR_PALETTE: readonly string[] = [
  '#1f1f24',
  '#e11d48',
  '#ea580c',
  '#ca8a04',
  '#16a34a',
  '#0284c7',
  '#7c3aed',
  '#ffffff',
];
