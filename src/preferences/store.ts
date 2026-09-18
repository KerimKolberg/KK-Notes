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
import { COLOR_PALETTE } from '../inking/constants';
import {
  DEFAULT_PALETTE_ORDER,
  MAX_SWATCHES,
  MIN_SWATCHES,
  type PageDefaults,
  type PaletteSlot,
  type Preferences,
} from './types';

const STORAGE_KEY = 'notes.preferences.v1';

export const DEFAULT_PREFERENCES: Preferences = {
  paletteOrder: DEFAULT_PALETTE_ORDER,
  swatches: COLOR_PALETTE,
  pageDefaults: null,
};

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
  return colors.length >= MIN_SWATCHES ? colors : DEFAULT_PREFERENCES.swatches;
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
    swatches: normalizeSwatches(record.swatches),
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
  setPageDefaults: (defaults: PageDefaults | null) => void;
  /** Clear custom colours, tool order and page defaults in one go. */
  resetPreferences: () => void;
}

export const usePreferencesStore = create<PreferencesStore>()((set, get) => {
  const save = (patch: Partial<Preferences>): void => {
    const next: Preferences = {
      paletteOrder: patch.paletteOrder ?? get().paletteOrder,
      swatches: patch.swatches ?? get().swatches,
      pageDefaults: patch.pageDefaults !== undefined ? patch.pageDefaults : get().pageDefaults,
    };
    write(next);
    set(next);
  };

  return {
    ...read(),

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

    setPageDefaults: (defaults) => save({ pageDefaults: defaults }),

    resetPreferences: () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* nothing stored to remove */
      }
      set(DEFAULT_PREFERENCES);
    },
  };
});

/** The page layout a new note starts with, preferences applied. */
export function currentPageDefaults(): PageDefaults | null {
  return usePreferencesStore.getState().pageDefaults;
}
