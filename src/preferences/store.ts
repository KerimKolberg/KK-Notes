/**
 * The persisted preferences store.
 *
 * Written straight to `localStorage` rather than through the document store,
 * because these outlive any document and belong to the install: the palette
 * you arranged should be the palette you get tomorrow, on whichever notebook
 * you open.
 *
 * Everything read back off disk goes through `normalize`. It is user-editable
 * storage that survives upgrades, so a slot that no longer exists, a colour
 * that is not a colour, or a list that lost half its entries has to leave the
 * app usable — the alternative is a palette with a hole in it and no way to
 * get it back short of clearing site data.
 */
import { create } from 'zustand';
import { DEFAULT_TEMPLATE_CONFIG, LIGHT_PAGE_BACKGROUND } from '../document/constants';
import {
  COLOR_PALETTE,
  DEFAULT_STYLUS_SETTINGS,
  DEFAULT_WIDTH_PRESETS,
  LEGACY_COLOR_PALETTE,
  MAX_STROKE_SIZE,
  MIN_STROKE_SIZE,
  STYLUS_TOOLS,
} from '../inking/constants';
import { setLowLatencyCanvas } from '../inking/engine/canvasMode';
import type { StylusSettings, ToolType } from '../inking/types';
import {
  DEFAULT_PALETTE_ORDER,
  MAX_SWATCHES,
  MIN_SWATCHES,
  PALETTE_DOCKS,
  type PageDefaults,
  POINTER_STYLES,
  type PaletteDock,
  type PaletteSlot,
  type PointerStyle,
  type Preferences,
} from './types';

const STORAGE_KEY = 'notes.preferences.v1';

export const DEFAULT_PREFERENCES: Preferences = {
  paletteOrder: DEFAULT_PALETTE_ORDER,
  paletteDock: 'bottom',
  palettePinned: true,
  pointerStyle: 'cross',
  stylus: DEFAULT_STYLUS_SETTINGS,
  lowLatencyInk: false,
  swatches: COLOR_PALETTE,
  widthPresets: DEFAULT_WIDTH_PRESETS,
  pageDefaults: null,
};

const STYLUS_TOOL_IDS: ReadonlySet<string> = new Set(STYLUS_TOOLS.map((tool) => tool.id));

function stylusTool(value: unknown, fallback: ToolType): ToolType {
  return typeof value === 'string' && STYLUS_TOOL_IDS.has(value) ? (value as ToolType) : fallback;
}

/**
 * Pen buttons read back from storage.
 *
 * Each field is checked against the same list the settings offer, and falls back
 * on its own: one stale tool name must not throw away the other two mappings, and
 * a stylus with no valid mapping at all would be a pen that draws nothing when a
 * button is held.
 */
export function normalizeStylus(stored: unknown): StylusSettings {
  const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  const toggle = Array.isArray(record.clickToggle) ? record.clickToggle : [];
  return {
    clickToggle: [
      stylusTool(toggle[0], DEFAULT_STYLUS_SETTINGS.clickToggle[0]),
      stylusTool(toggle[1], DEFAULT_STYLUS_SETTINGS.clickToggle[1]),
    ],
    holdTool: stylusTool(record.holdTool, DEFAULT_STYLUS_SETTINGS.holdTool),
    eraserEnd: stylusTool(record.eraserEnd, DEFAULT_STYLUS_SETTINGS.eraserEnd),
  };
}

export function normalizePointerStyle(stored: unknown): PointerStyle {
  return typeof stored === 'string' && (POINTER_STYLES as readonly string[]).includes(stored)
    ? (stored as PointerStyle)
    : DEFAULT_PREFERENCES.pointerStyle;
}

/**
 * Tell the stylesheet which pointer to use. On the root element, so every surface
 * (a page, a reference pane) follows one setting without being handed it.
 */
export function applyPointerStyle(style: PointerStyle): void {
  if (typeof document === 'undefined') return;
  if (style === 'cross') delete document.documentElement.dataset.pointer;
  else document.documentElement.dataset.pointer = style;
}

export function normalizeDock(stored: unknown): PaletteDock {
  return typeof stored === 'string' && (PALETTE_DOCKS as readonly string[]).includes(stored)
    ? (stored as PaletteDock)
    : DEFAULT_PREFERENCES.paletteDock;
}

/** A CSS hex colour, the only form the swatch editor produces. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value.trim());
}

/**
 * A palette order that is definitely usable: known slots only, no duplicates,
 * and anything the stored list is missing appended in its default position.
 *
 * That last part is what makes adding a tool in a future version safe — a
 * saved order from before it existed simply gains it at the end rather than
 * hiding it.
 */
export function normalizeOrder(stored: unknown): readonly PaletteSlot[] {
  const known = new Set<string>(DEFAULT_PALETTE_ORDER);
  const seen = new Set<PaletteSlot>();
  const order: PaletteSlot[] = [];
  if (Array.isArray(stored)) {
    for (const value of stored) {
      if (typeof value !== 'string' || !known.has(value)) continue;
      const slot = value as PaletteSlot;
      if (seen.has(slot)) continue;
      seen.add(slot);
      order.push(slot);
    }
  }
  for (const slot of DEFAULT_PALETTE_ORDER) if (!seen.has(slot)) order.push(slot);
  return order;
}

/** Swatches that are all real colours, within the range the row can show. */
export function normalizeSwatches(stored: unknown): readonly string[] {
  if (!Array.isArray(stored)) return DEFAULT_PREFERENCES.swatches;
  const colors = stored.filter(isHexColor).map((c) => c.trim().toLowerCase()).slice(0, MAX_SWATCHES);
  // Too few to be a palette: fall back rather than leave one colour to draw with.
  if (colors.length < MIN_SWATCHES) return DEFAULT_PREFERENCES.swatches;
  // Saved only because something else in the preferences changed, not because the
  // colours did: this is the old shipped row, so it takes the new one.
  if (colors.join() === LEGACY_COLOR_PALETTE.join()) return DEFAULT_PREFERENCES.swatches;
  return colors;
}

/** Two widths, each within what the slider offers; anything else is the shipped pair. */
export function normalizeWidthPresets(stored: unknown): readonly number[] {
  if (!Array.isArray(stored) || stored.length !== 2) return DEFAULT_PREFERENCES.widthPresets;
  const ok = stored.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= MIN_STROKE_SIZE && n <= MAX_STROKE_SIZE);
  return ok ? stored.map((n: number) => Math.round(n * 2) / 2) : DEFAULT_PREFERENCES.widthPresets;
}

function normalizePageDefaults(stored: unknown): PageDefaults | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const record = stored as Record<string, unknown>;
  if (typeof record.template !== 'string') return null;
  const config = typeof record.templateConfig === 'object' && record.templateConfig !== null ? record.templateConfig : {};
  return {
    template: record.template as PageDefaults['template'],
    // Merged over the shipped config, so a field added later has a value.
    templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, ...(config as object) },
    backgroundColor: isHexColor(record.backgroundColor) ? record.backgroundColor : LIGHT_PAGE_BACKGROUND,
  };
}

export function normalize(stored: unknown): Preferences {
  const record = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  return {
    paletteOrder: normalizeOrder(record.paletteOrder),
    paletteDock: normalizeDock(record.paletteDock),
    // Pinned unless it was explicitly unpinned: a mangled value must not make the
    // toolbar start disappearing on someone.
    palettePinned: record.palettePinned !== false,
    pointerStyle: normalizePointerStyle(record.pointerStyle),
    stylus: normalizeStylus(record.stylus),
    // Strictly `true`: anything else, including a stale or mangled value, is off.
    lowLatencyInk: record.lowLatencyInk === true,
    swatches: normalizeSwatches(record.swatches),
    widthPresets: normalizeWidthPresets(record.widthPresets),
    pageDefaults: normalizePageDefaults(record.pageDefaults),
  };
}

/** Move one slot to another position, as a drag does. */
export function reorder<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

function read(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_PREFERENCES : normalize(JSON.parse(raw));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function write(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    /* private mode, or the quota is gone; the session keeps its settings */
  }
}

export interface PreferencesStore extends Preferences {
  movePaletteSlot: (from: number, to: number) => void;
  setPaletteOrder: (order: readonly PaletteSlot[]) => void;
  setSwatch: (index: number, color: string) => void;
  addSwatch: (color: string) => void;
  removeSwatch: (index: number) => void;
  /** Make slot `index` (0 or 1) of the quick widths this width. */
  setWidthPreset: (index: number, size: number) => void;
  setPageDefaults: (defaults: PageDefaults | null) => void;
  setPaletteDock: (dock: PaletteDock) => void;
  setPalettePinned: (pinned: boolean) => void;
  setPointerStyle: (style: PointerStyle) => void;
  setStylus: (stylus: StylusSettings) => void;
  setLowLatencyInk: (enabled: boolean) => void;
  /** Clear custom colours, tool order and page defaults in one go. */
  resetPreferences: () => void;
}

export const usePreferencesStore = create<PreferencesStore>()((set, get) => {
  const save = (patch: Partial<Preferences>): void => {
    const current = get();
    const next: Preferences = {
      paletteOrder: patch.paletteOrder ?? current.paletteOrder,
      paletteDock: patch.paletteDock ?? current.paletteDock,
      palettePinned: patch.palettePinned ?? current.palettePinned,
      pointerStyle: patch.pointerStyle ?? current.pointerStyle,
      stylus: patch.stylus ?? current.stylus,
      lowLatencyInk: patch.lowLatencyInk ?? current.lowLatencyInk,
      swatches: patch.swatches ?? current.swatches,
      widthPresets: patch.widthPresets ?? current.widthPresets,
      pageDefaults: patch.pageDefaults !== undefined ? patch.pageDefaults : current.pageDefaults,
    };
    write(next);
    // Before the state changes, so a surface that remounts on the change already
    // sees the new mode when it creates its canvases.
    setLowLatencyCanvas(next.lowLatencyInk);
    applyPointerStyle(next.pointerStyle);
    set(next);
  };

  const initial = read();
  setLowLatencyCanvas(initial.lowLatencyInk);
  applyPointerStyle(initial.pointerStyle);

  return {
    ...initial,

    movePaletteSlot: (from, to) => save({ paletteOrder: reorder(get().paletteOrder, from, to) }),
    setPaletteOrder: (order) => save({ paletteOrder: normalizeOrder(order) }),

    setSwatch: (index, color) => {
      if (!isHexColor(color)) return;
      const swatches = [...get().swatches];
      if (index < 0 || index >= swatches.length) return;
      swatches[index] = color.toLowerCase();
      save({ swatches });
    },
    addSwatch: (color) => {
      const swatches = get().swatches;
      if (!isHexColor(color) || swatches.length >= MAX_SWATCHES) return;
      save({ swatches: [...swatches, color.toLowerCase()] });
    },
    removeSwatch: (index) => {
      const swatches = get().swatches;
      // Never below the floor: a palette of one colour is not a palette.
      if (swatches.length <= MIN_SWATCHES || index < 0 || index >= swatches.length) return;
      save({ swatches: swatches.filter((_, i) => i !== index) });
    },

    setWidthPreset: (index, size) => {
      const presets = [...get().widthPresets];
      if (index < 0 || index >= presets.length) return;
      // A width the slider cannot make is ignored, not allowed to reset the other slot with it.
      if (!Number.isFinite(size) || size < MIN_STROKE_SIZE || size > MAX_STROKE_SIZE) return;
      presets[index] = size;
      save({ widthPresets: normalizeWidthPresets(presets) });
    },

    setPageDefaults: (defaults) => save({ pageDefaults: defaults }),
    setPaletteDock: (dock) => save({ paletteDock: normalizeDock(dock) }),
    setPalettePinned: (pinned) => save({ palettePinned: pinned !== false }),
    setPointerStyle: (style) => save({ pointerStyle: normalizePointerStyle(style) }),
    setStylus: (stylus) => save({ stylus: normalizeStylus(stylus) }),
    setLowLatencyInk: (enabled) => save({ lowLatencyInk: enabled === true }),

    resetPreferences: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* nothing stored to remove */
      }
      setLowLatencyCanvas(DEFAULT_PREFERENCES.lowLatencyInk);
      applyPointerStyle(DEFAULT_PREFERENCES.pointerStyle);
      set(DEFAULT_PREFERENCES);
    },
  };
});

/** The page layout a new note starts with, preferences applied. */
export function currentPageDefaults(): PageDefaults | null {
  return usePreferencesStore.getState().pageDefaults;
}
