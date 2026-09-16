import type { ToolSettings } from './types';

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

/** Highlighter layer opacity (rendered with `multiply`). */
export const HIGHLIGHTER_OPACITY = 0.35;

export const MIN_STROKE_SIZE = 1;
export const MAX_STROKE_SIZE = 24;

export const DEFAULT_TOOL_SETTINGS: Readonly<ToolSettings> = {
  tool: 'pen',
  color: '#1f1f24',
  size: 4,
  touchDraw: false,
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
