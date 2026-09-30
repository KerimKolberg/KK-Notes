import { beforeEach, describe, expect, it } from 'vitest';
import { COLOR_PALETTE } from '../../inking/constants';
import { DEFAULT_STYLUS_SETTINGS } from '../../inking/constants';
import {
  DEFAULT_PREFERENCES,
  isHexColor,
  normalize,
  normalizeDock,
  normalizeOrder,
  normalizeStylus,
  normalizeSwatches,
  reorder,
  usePreferencesStore,
} from '../store';
import { DEFAULT_PALETTE_ORDER, MAX_SWATCHES, MIN_SWATCHES } from '../types';

beforeEach(() => {
  usePreferencesStore.getState().resetPreferences();
});

describe('reordering', () => {
  it('moves an item to a new position', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(reorder(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('leaves the list alone for a move that goes nowhere', () => {
    expect(reorder(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
    expect(reorder(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
    expect(reorder(['a', 'b'], 0, 9)).toEqual(['a', 'b']);
  });

  it('never loses or duplicates an item', () => {
    const start = [...DEFAULT_PALETTE_ORDER];
    let order = start;
    for (const [from, to] of [[0, 5], [10, 1], [3, 3], [7, 0]] as const) order = reorder(order, from, to);
    expect([...order].sort()).toEqual([...start].sort());
  });
});

describe('reading a stored palette order back', () => {
  it('keeps a valid order as it is', () => {
    const custom = ['eraser', 'pen', ...DEFAULT_PALETTE_ORDER.filter((s) => s !== 'eraser' && s !== 'pen')];
    expect(normalizeOrder(custom)).toEqual(custom);
  });

  it('appends a tool the stored order never knew about', () => {
    // An order saved before a tool existed must gain it, not hide it — this is
    // what keeps a future version from shipping an invisible feature.
    const old = DEFAULT_PALETTE_ORDER.filter((s) => s !== 'washi' && s !== 'plane');
    const fixed = normalizeOrder(old);
    expect(fixed).toHaveLength(DEFAULT_PALETTE_ORDER.length);
    expect(fixed).toContain('washi');
    expect(fixed).toContain('plane');
    // …and the order that was saved is preserved ahead of the newcomers.
    expect(fixed.slice(0, old.length)).toEqual(old);
  });

  it('drops slots that no longer exist, and duplicates', () => {
    expect(normalizeOrder(['pen', 'pen', 'typewriter', 'eraser'])[0]).toBe('pen');
    expect(normalizeOrder(['pen', 'pen'])).toHaveLength(DEFAULT_PALETTE_ORDER.length);
    expect(normalizeOrder(['pen', 'pen']).filter((s) => s === 'pen')).toHaveLength(1);
  });

  it('falls back completely for anything that is not a list', () => {
    for (const junk of [null, undefined, 'pen', 42, {}]) {
      expect(normalizeOrder(junk)).toEqual(DEFAULT_PALETTE_ORDER);
    }
  });
});

describe('swatches', () => {
  it('accepts the colour forms the picker produces', () => {
    expect(isHexColor('#fff')).toBe(true);
    expect(isHexColor('#1F1F24')).toBe(true);
    expect(isHexColor('#1f1f24ff')).toBe(true);
    expect(isHexColor('red')).toBe(false);
    expect(isHexColor('rgb(0,0,0)')).toBe(false);
    expect(isHexColor('#12')).toBe(false);
    expect(isHexColor(42)).toBe(false);
  });

  it('keeps a stored palette, lower-cased and capped', () => {
    expect(normalizeSwatches(['#FFF', '#000'])).toEqual(['#fff', '#000']);
    const many = Array.from({ length: MAX_SWATCHES + 5 }, () => '#123456');
    expect(normalizeSwatches(many)).toHaveLength(MAX_SWATCHES);
  });

  it('falls back rather than leaving too few colours to draw with', () => {
    expect(normalizeSwatches(['#fff'])).toEqual(DEFAULT_PREFERENCES.swatches);
    expect(normalizeSwatches(['not a colour', 42])).toEqual(DEFAULT_PREFERENCES.swatches);
    expect(normalizeSwatches('nope')).toEqual(DEFAULT_PREFERENCES.swatches);
  });

  it('edits, adds and removes one at a time', () => {
    const store = usePreferencesStore.getState();
    store.setSwatch(0, '#ABCDEF');
    expect(usePreferencesStore.getState().swatches[0]).toBe('#abcdef');
    // Rubbish is refused rather than stored.
    store.setSwatch(0, 'chartreuse');
    expect(usePreferencesStore.getState().swatches[0]).toBe('#abcdef');

    const before = usePreferencesStore.getState().swatches.length;
    usePreferencesStore.getState().addSwatch('#123123');
    expect(usePreferencesStore.getState().swatches).toHaveLength(before + 1);
    usePreferencesStore.getState().removeSwatch(0);
    expect(usePreferencesStore.getState().swatches).toHaveLength(before);
  });

  it('will not shrink the row below the floor or grow it past the cap', () => {
    const store = usePreferencesStore;
    store.setState({ swatches: ['#000', '#fff'] });
    store.getState().removeSwatch(0);
    expect(store.getState().swatches).toHaveLength(MIN_SWATCHES);

    store.setState({ swatches: Array.from({ length: MAX_SWATCHES }, () => '#000') });
    store.getState().addSwatch('#fff');
    expect(store.getState().swatches).toHaveLength(MAX_SWATCHES);
  });
});

describe('page defaults', () => {
  it('starts unset, so a new note is blank', () => {
    expect(usePreferencesStore.getState().pageDefaults).toBeNull();
  });

  it('fills in fields a stored default was written without', () => {
    const restored = normalize({ pageDefaults: { template: 'ruled' } });
    expect(restored.pageDefaults?.template).toBe('ruled');
    expect(restored.pageDefaults?.templateConfig.spacing).toBeGreaterThan(0);
    expect(isHexColor(restored.pageDefaults?.backgroundColor ?? '')).toBe(true);
  });

  it('refuses a stored default that is not one', () => {
    expect(normalize({ pageDefaults: 'ruled' }).pageDefaults).toBeNull();
    expect(normalize({ pageDefaults: { spacing: 20 } }).pageDefaults).toBeNull();
  });
});

describe('pen buttons', () => {
  it('starts with the eraser on the barrel hold and the lasso on the second button', () => {
    const { stylus } = usePreferencesStore.getState();
    expect(stylus.holdTool).toBe('eraser-stroke');
    expect(stylus.eraserEnd).toBe('lasso');
  });

  it('keeps a mapping the user chose', () => {
    usePreferencesStore.getState().setStylus({ ...DEFAULT_STYLUS_SETTINGS, holdTool: 'lasso', eraserEnd: 'eraser-pixel' });
    const { stylus } = usePreferencesStore.getState();
    expect(stylus.holdTool).toBe('lasso');
    expect(stylus.eraserEnd).toBe('eraser-pixel');
  });

  it('reads a saved mapping back', () => {
    const stored = { clickToggle: ['highlighter', 'pen'], holdTool: 'select', eraserEnd: 'laser-pointer' };
    expect(normalizeStylus(stored)).toEqual(stored);
  });

  it('falls back field by field, so one stale name does not cost the others', () => {
    // A tool that no longer exists in the middle of an otherwise good mapping.
    const restored = normalizeStylus({ clickToggle: ['pen', 'eraser-stroke'], holdTool: 'teleport', eraserEnd: 'lasso' });
    expect(restored.holdTool).toBe(DEFAULT_STYLUS_SETTINGS.holdTool);
    expect(restored.eraserEnd).toBe('lasso');
  });

  it('survives storage that is not an object, or a toggle that is not a pair', () => {
    for (const junk of [null, undefined, 'pen', 7, [], { clickToggle: 'pen' }, { clickToggle: [1, 2] }]) {
      const restored = normalizeStylus(junk);
      expect(restored.clickToggle).toHaveLength(2);
      expect(typeof restored.holdTool).toBe('string');
      expect(typeof restored.eraserEnd).toBe('string');
    }
  });

  it('is cleared by a reset like everything else', () => {
    usePreferencesStore.getState().setStylus({ ...DEFAULT_STYLUS_SETTINGS, holdTool: 'lasso' });
    usePreferencesStore.getState().resetPreferences();
    expect(usePreferencesStore.getState().stylus).toEqual(DEFAULT_PREFERENCES.stylus);
  });
});

describe('the toolbar dock', () => {
  it('starts at the bottom, where the toolbar has always been', () => {
    expect(usePreferencesStore.getState().paletteDock).toBe('bottom');
  });

  it('remembers an edge', () => {
    usePreferencesStore.getState().setPaletteDock('left');
    expect(usePreferencesStore.getState().paletteDock).toBe('left');
  });

  it('accepts every real dock and nothing else', () => {
    for (const dock of ['bottom', 'top', 'left', 'right', 'free']) expect(normalizeDock(dock)).toBe(dock);
    for (const junk of ['center', '', null, 3, undefined, ['left']]) expect(normalizeDock(junk)).toBe('bottom');
  });
});

describe('pinning the toolbar', () => {
  it('starts pinned: a toolbar that hides itself is opted into', () => {
    expect(DEFAULT_PREFERENCES.palettePinned).toBe(true);
    expect(usePreferencesStore.getState().palettePinned).toBe(true);
  });

  it('remembers being unpinned', () => {
    usePreferencesStore.getState().setPalettePinned(false);
    expect(usePreferencesStore.getState().palettePinned).toBe(false);
    usePreferencesStore.getState().setPalettePinned(true);
    expect(usePreferencesStore.getState().palettePinned).toBe(true);
  });

  it('reads back as unpinned only for a real false', () => {
    expect(normalize({ palettePinned: false }).palettePinned).toBe(false);
    // Anything mangled leaves the toolbar where it always was.
    for (const junk of ['false', 0, null, undefined, {}, 'no']) {
      expect(normalize({ palettePinned: junk }).palettePinned).toBe(true);
    }
    // And an install from before the setting existed is pinned.
    expect(normalize({}).palettePinned).toBe(true);
  });

  it('is pinned again after a reset', () => {
    usePreferencesStore.getState().setPalettePinned(false);
    usePreferencesStore.getState().resetPreferences();
    expect(usePreferencesStore.getState().palettePinned).toBe(true);
  });
});

describe('low-latency ink', () => {
  it('is off until someone turns it on', () => {
    // It is a hint that can make a page go black on some GPUs, so the safe state
    // is the default and the risk is opted into.
    expect(DEFAULT_PREFERENCES.lowLatencyInk).toBe(false);
    expect(usePreferencesStore.getState().lowLatencyInk).toBe(false);
  });

  it('can be turned on and off', () => {
    usePreferencesStore.getState().setLowLatencyInk(true);
    expect(usePreferencesStore.getState().lowLatencyInk).toBe(true);
    usePreferencesStore.getState().setLowLatencyInk(false);
    expect(usePreferencesStore.getState().lowLatencyInk).toBe(false);
  });

  it('reads back as on only for a real true', () => {
    expect(normalize({ lowLatencyInk: true }).lowLatencyInk).toBe(true);
    for (const junk of ['true', 1, {}, null, undefined, 'yes']) {
      expect(normalize({ lowLatencyInk: junk }).lowLatencyInk).toBe(false);
    }
  });
});

describe('reset to defaults', () => {
  it('clears custom colours, tool order and page defaults together', () => {
    const store = usePreferencesStore.getState();
    store.movePaletteSlot(0, 4);
    store.setSwatch(0, '#abcdef');
    store.setPageDefaults({
      template: 'grid',
      templateConfig: { spacing: 40, strokeColor: 'auto', strokeWidth: 1 },
      backgroundColor: '#fffdf5',
    });
    expect(usePreferencesStore.getState().paletteOrder).not.toEqual(DEFAULT_PALETTE_ORDER);

    usePreferencesStore.getState().resetPreferences();
    const after = usePreferencesStore.getState();
    expect(after.paletteOrder).toEqual(DEFAULT_PALETTE_ORDER);
    expect(after.swatches).toEqual(COLOR_PALETTE);
    expect(after.pageDefaults).toBeNull();
  });
});
