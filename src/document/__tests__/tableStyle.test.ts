import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS } from '../constants';
import { addTableColumn, createTable, fitOnPage, hexWithOpacity, reshapeTableOnPage, tableStyle } from '../media';
import type { TableLayer } from '../types';
import { sanitizeMedia } from '../validate';

describe('a table kept on its page', () => {
  const page = A4_DIMENSIONS;

  it('is moved back in when a column takes it past the edge', () => {
    const table = { ...createTable(page, 1), x: page.width - 400 };
    const wider = reshapeTableOnPage(table, addTableColumn(table), page);
    expect(wider.columns).toBe(table.columns + 1);
    expect(wider.x + wider.width).toBeLessThanOrEqual(page.width);
  });

  it('is narrowed to the page once it no longer fits, every column a little smaller', () => {
    let table: TableLayer = createTable(page, 1);
    for (let i = 0; i < 6; i++) table = reshapeTableOnPage(table, addTableColumn(table), page);
    expect(table.columns).toBe(9);
    expect(table.width).toBe(page.width);
    expect(table.x).toBe(0);
  });

  it('is left alone when it is turned (its corners are not its box)', () => {
    const table = { ...createTable(page, 1), rotation: 30, x: page.width - 100 };
    const next = addTableColumn(table);
    expect(reshapeTableOnPage(table, next, page)).toBe(next);
  });

  it('fits any box', () => {
    expect(fitOnPage({ x: -20, y: 900, width: 100, height: 400 }, { width: 600, height: 1000 })).toEqual({ x: 0, y: 600, width: 100, height: 400 });
    expect(fitOnPage({ x: 50, y: 50, width: 900, height: 100 }, { width: 600, height: 1000 })).toEqual({ x: 0, y: 50, width: 600, height: 100 });
  });
});

describe('how a table looks', () => {
  it('is grey lines on white when nothing is said', () => {
    expect(tableStyle(createTable(A4_DIMENSIONS, 1))).toEqual({ lineWidth: 1, lineOpacity: 1, lineColor: '#a1a1aa', fillColor: '#ffffff', fillOpacity: 1 });
  });

  it('can have no background, and no lines', () => {
    const table = { ...createTable(A4_DIMENSIONS, 1), fillOpacity: 0, lineOpacity: 0, lineColor: '#2563eb' };
    expect(tableStyle(table)).toMatchObject({ fillOpacity: 0, lineOpacity: 0, lineColor: '#2563eb' });
  });

  it('ignores a colour that is not #rrggbb, and an opacity out of range', () => {
    const table = { ...createTable(A4_DIMENSIONS, 1), lineColor: 'red; background: url(x)', fillOpacity: 4 };
    expect(tableStyle(table)).toMatchObject({ lineColor: '#a1a1aa', fillOpacity: 1 });
  });

  it('writes a colour at an opacity as CSS', () => {
    expect(hexWithOpacity('#2563eb', 0.5)).toBe('rgba(37, 99, 235, 0.5)');
    expect(hexWithOpacity('#ffffff', 0)).toBe('rgba(255, 255, 255, 0)');
  });

  it('keeps from a file only colours and opacities that are what they say', () => {
    const raw = {
      ...createTable(A4_DIMENSIONS, 1),
      lineColor: '#16a34a',
      fillColor: 'url(javascript:alert(1))',
      fillOpacity: 0,
      lineOpacity: 7,
      lineWidth: 'thick',
    };
    const table = sanitizeMedia(raw) as TableLayer;
    expect(table.lineColor).toBe('#16a34a');
    expect('fillColor' in table).toBe(false);
    expect(table.fillOpacity).toBe(0);
    expect(table.lineOpacity).toBe(1);
    expect('lineWidth' in table).toBe(false);
  });
});
