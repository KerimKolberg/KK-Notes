import { describe, expect, it } from 'vitest';
import { DEFAULT_SNAP_GRID, snapSpacing, snapToGrid } from '../engine/grid';
import { pageSnapSpacing } from '../../document/templates';
import { DEFAULT_TEMPLATE_CONFIG } from '../../document/constants';

describe('snapping to a grid', () => {
  it('moves a point to the nearest crossing', () => {
    expect(snapToGrid({ x: 13, y: 37 }, 24)).toEqual({ x: 24, y: 48 });
    expect(snapToGrid({ x: 11.9, y: 12.1 }, 24)).toEqual({ x: 0, y: 24 });
  });

  it('leaves a point that is on the grid where it is', () => {
    expect(snapToGrid({ x: 48, y: 72 }, 24)).toEqual({ x: 48, y: 72 });
  });

  it('keeps everything else about the point, pressure included', () => {
    expect(snapToGrid({ x: 5, y: 5, pressure: 0.6 }, 10)).toEqual({ x: 10, y: 10, pressure: 0.6 });
  });

  it('does nothing for a grid that is not one', () => {
    const p = { x: 3.3, y: 4.4 };
    for (const bad of [0, -5, Number.NaN]) expect(snapToGrid(p, bad)).toBe(p);
  });

  it('is its own fixed point: snapping twice is snapping once', () => {
    const once = snapToGrid({ x: 101.3, y: -47.9 }, 16);
    expect(snapToGrid(once, 16)).toEqual(once);
  });
});

describe('which grid a page snaps to', () => {
  it('uses the template\'s own spacing where it draws a grid', () => {
    expect(snapSpacing(32, true)).toBe(32);
    expect(pageSnapSpacing({ template: 'grid', templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, spacing: 40 } })).toBe(40);
    expect(pageSnapSpacing({ template: 'engineering', templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, spacing: 12 } })).toBe(12);
    expect(pageSnapSpacing({ template: 'ruled', templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, spacing: 28 } })).toBe(28);
  });

  it('uses a fixed one where there is no grid to follow', () => {
    expect(snapSpacing(32, false)).toBe(DEFAULT_SNAP_GRID);
    expect(pageSnapSpacing({ template: 'blank', templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, spacing: 40 } })).toBe(DEFAULT_SNAP_GRID);
    expect(pageSnapSpacing({ template: 'pdf', templateConfig: { ...DEFAULT_TEMPLATE_CONFIG, spacing: 40 } })).toBe(DEFAULT_SNAP_GRID);
  });

  it('never snaps to something a hand could not hit', () => {
    expect(snapSpacing(0, true)).toBe(DEFAULT_SNAP_GRID);
    expect(snapSpacing(1, true)).toBe(DEFAULT_SNAP_GRID);
    expect(snapSpacing(Number.NaN, true)).toBe(DEFAULT_SNAP_GRID);
    expect(snapSpacing(undefined, true)).toBe(DEFAULT_SNAP_GRID);
  });
});
