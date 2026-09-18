import { beforeEach, describe, expect, it } from 'vitest';
import { COLOR_PALETTE } from '../../inking/constants';
import { DEFAULT_PREFERENCES, isHexColor, normalize, normalizeOrder, normalizeSwatches, reorder, usePreferencesStore } from '../store';
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
