/**
 * What the user has changed about the app itself, as opposed to about a
 * document: the order of the palette's icons, the quick colours under it, and
 * the page layout a new note starts with.
 *
 * Kept apart from `ToolSettings` deliberately. Tool settings are what you are
 * drawing with *now* and change constantly; these are how the app is set up
 * and change rarely, which is also why one "Reset to defaults" can clear all
 * of them without touching the pen you happen to be holding.
 */
import type { PageTemplate, TemplateConfig } from '../document/types';

/**
 * A reorderable position on the palette.
 *
 * Only the tools are reorderable. The drag handle, undo/redo and the settings
 * button are chrome: they are where they are so that they are findable, and a
 * palette whose settings button moves is one you cannot explain to anyone.
 */
export type PaletteSlot =
  | 'select'
  | 'lasso'
  | 'laser'
  | 'insert'
  | 'pen'
  | 'highlighter'
  | 'washi'
  | 'line'
  | 'plane'
  | 'stroke'
  | 'eraser';

/** The order the palette ships with: pointers, then pens, then geometry, then the eraser. */
export const DEFAULT_PALETTE_ORDER: readonly PaletteSlot[] = [
  'select',
  'lasso',
  'laser',
  'insert',
  'pen',
  'highlighter',
  'washi',
  'line',
  'plane',
  'stroke',
  'eraser',
];

/** Where a divider is drawn: before the slot that starts each group. */
export const PALETTE_GROUP_STARTS: readonly PaletteSlot[] = ['pen', 'line', 'eraser'];

export const PALETTE_SLOT_LABELS: Readonly<Record<PaletteSlot, string>> = {
  select: 'Select',
  lasso: 'Lasso',
  laser: 'Laser pointer',
  insert: 'Add to the page',
  pen: 'Pen',
  highlighter: 'Highlighter',
  washi: 'Washi tape',
  line: 'Lines and shapes',
  plane: 'Coordinate system',
  stroke: 'Line pattern',
  eraser: 'Eraser',
};

/** The layout a new page starts with. */
export interface PageDefaults {
  readonly template: PageTemplate;
  readonly templateConfig: TemplateConfig;
  readonly backgroundColor: string;
}

export interface Preferences {
  readonly paletteOrder: readonly PaletteSlot[];
  /** Quick colours on the palette's second row. */
  readonly swatches: readonly string[];
  /** `null` until the user has pressed "Set as default" on a page. */
  readonly pageDefaults: PageDefaults | null;
}

/** How many quick colours the palette shows; the picker covers everything else. */
export const MAX_SWATCHES = 10;
export const MIN_SWATCHES = 2;
