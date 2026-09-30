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
import type { StylusSettings } from '../inking/types';

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

/**
 * Where the toolbar sits. The four edges dock it there, laid out along that
 * edge; `free` leaves it wherever it was dropped.
 */
export type PaletteDock = 'bottom' | 'top' | 'left' | 'right' | 'free';

export const PALETTE_DOCKS: readonly PaletteDock[] = ['bottom', 'top', 'left', 'right', 'free'];

/**
 * What F11 does on the desktop. `window` takes the title bar off and fills the space a
 * maximised window would (the taskbar stays); `screen` is the platform's own fullscreen,
 * covering the monitor. See `desktop/borderless.ts` for why there are two.
 */
export type FullscreenStyle = 'window' | 'screen';

export const FULLSCREEN_STYLES: readonly FullscreenStyle[] = ['window', 'screen'];

export interface Preferences {
  readonly paletteOrder: readonly PaletteSlot[];
  /** How the desktop app goes fullscreen. */
  readonly fullscreenStyle: FullscreenStyle;
  /** Where the toolbar is docked. */
  readonly paletteDock: PaletteDock;
  /**
   * Whether the toolbar stays on screen. Unpinned, it slips away after a few idle
   * seconds and comes back from a small tab on the edge it is docked to.
   */
  readonly palettePinned: boolean;
  /**
   * What the pen's buttons do.
   *
   * Here rather than in the tool settings because tool settings start from their
   * defaults on every launch, and a button mapping that resets each time the app
   * opens is one nobody would bother setting.
   */
  readonly stylus: StylusSettings;
  /**
   * Ask the browser for a low-latency canvas (`desynchronized`).
   *
   * Off by default. It presents the canvas through the GPU's overlay hardware,
   * which saves up to a frame of pen latency and, on some Windows GPUs, makes a
   * page go black or the cursor flicker. A switch rather than a decision, because
   * only the device in your hand can say which it does — and on the ROG Flow Z13
   * it said: every page went dark and the fullscreen cursor blinked.
   */
  readonly lowLatencyInk: boolean;
  /** Quick colours on the palette's second row. */
  readonly swatches: readonly string[];
  /** The widths one tap away beside the thickness slider: two of them, a fine one and a broader one. */
  readonly widthPresets: readonly number[];
  /** `null` until the user has pressed "Set as default" on a page. */
  readonly pageDefaults: PageDefaults | null;
}

/** How many quick colours the palette shows; the picker covers everything else. */
export const MAX_SWATCHES = 10;
export const MIN_SWATCHES = 2;
