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
 * The pointer over a page while a pen tool is selected: the app's own small cross, the
 * system's crosshair, or the plain arrow. A way to tell whether the pointer that lags
 * in fullscreen on some tablets is the picture (a custom cursor image can take a
 * slower path through the system than a stock one) or the screen it is shown on.
 */
export type PointerStyle = 'cross' | 'crosshair' | 'arrow';

export const POINTER_STYLES: readonly PointerStyle[] = ['cross', 'crosshair', 'arrow'];

export interface Preferences {
  readonly paletteOrder: readonly PaletteSlot[];
  /** The pointer over a page. */
  readonly pointerStyle: PointerStyle;
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
  /**
   * Read handwriting so it can be searched, where the device can (Windows' recogniser). On unless turned off:
   * it runs only while nothing is being written, on the device, and is what makes handwriting findable.
   */
  readonly handwritingSearch: boolean;
  /** The recogniser (language) to read handwriting with, by name; `null` for the one Windows picks. */
  readonly handwritingRecognizer: string | null;
  /** How pinching and the zoom buttons feel. */
  readonly zoom: ZoomPreferences;
}

/** How zooming feels: a pinch (on a touchpad or the screen), and one step of the buttons or a wheel notch. */
export interface ZoomPreferences {
  /** How far a pinch zooms for the same movement of the fingers; 1 is the pinch's own scale. */
  readonly pinchSpeed: number;
  /**
   * How much a pinch has to change the zoom before the zoom follows it, as a fraction (0.05 is 5 %); 0 for at once.
   * Past it the zoom carries on from where it is, without a jump. Raised, a two-finger scroll that pinches a little
   * on the way does not zoom.
   */
  readonly pinchThreshold: number;
  /** One click of + / −, or one notch of Ctrl + a mouse wheel, in percentage points. */
  readonly zoomStep: number;
}

export const DEFAULT_ZOOM_PREFERENCES: ZoomPreferences = { pinchSpeed: 1, pinchThreshold: 0, zoomStep: 10 };
export const PINCH_SPEED_RANGE = { min: 0.25, max: 3 } as const;
export const PINCH_THRESHOLD_RANGE = { min: 0, max: 0.2 } as const;
export const ZOOM_STEP_RANGE = { min: 5, max: 50 } as const;

/** How many quick colours the palette shows; the picker covers everything else. */
export const MAX_SWATCHES = 10;
export const MIN_SWATCHES = 2;
