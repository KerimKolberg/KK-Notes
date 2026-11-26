import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS, TABLE_CELL_SIZE } from '../constants';
import { drawnTableStrokes } from '../drawnTable';
import { addImage, createTable, createTextBox, sortedByZ } from '../media';
import { brushStyle } from '../../inking/engine/brushes';
import type { MediaObject, TextBox } from '../types';

const pageText = (): TextBox => ({ ...createTextBox(A4_DIMENSIONS, 1), id: 'page-text', flow: true });

describe('the page\'s own text, under everything placed on the page', () => {
  it('goes under a table put there before it', () => {
    const table = createTable(A4_DIMENSIONS, 1);
    const items = addImage<MediaObject>(addImage<MediaObject>([], table), pageText());
    expect(sortedByZ(items).map((m) => m.id)).toEqual(['page-text', table.id]);
    expect(items.find((m) => m.id === 'page-text')!.zIndex).toBeLessThan(items.find((m) => m.id === table.id)!.zIndex);
  });

  it('is stacked first even where a note saved before this has it on top', () => {
    const table = { ...createTable(A4_DIMENSIONS, 1), zIndex: 1 };
    const text = { ...pageText(), zIndex: 2 };
    expect(sortedByZ([table, text]).map((m) => m.id)).toEqual(['page-text', table.id]);
  });

  it('leaves everything else in the order it was put there', () => {
    const a = createTable(A4_DIMENSIONS, 1);
    const b = createTextBox(A4_DIMENSIONS, 1);
    const items = addImage<MediaObject>(addImage<MediaObject>([], a), b);
    expect(sortedByZ(items).map((m) => m.id)).toEqual([a.id, b.id]);
  });
});

describe('a table drawn as lines', () => {
  const style = brushStyle('ballpoint', { color: '#2563eb', size: 2, pattern: 'solid', arrowheads: 'none' }, 'pen');

  it('is a frame and the lines between its rows and columns, in the pen\'s colour', () => {
    const strokes = drawnTableStrokes(A4_DIMENSIONS, { rows: 3, columns: 4, style });
    expect(strokes).toHaveLength(4 + 5);
    expect(strokes.every((s) => s.kind === 'geometric' && s.shape.type === 'line' && s.style.color === '#2563eb')).toBe(true);
    expect(new Set(strokes.map((s) => s.id)).size).toBe(strokes.length);
  });

  it('has cells the size of a typed table\'s, in the middle of the page', () => {
    const strokes = drawnTableStrokes(A4_DIMENSIONS, { rows: 2, columns: 2, style });
    const xs = strokes.flatMap((s) => (s.kind === 'geometric' && s.shape.type === 'line' ? [s.shape.from.x, s.shape.to.x] : []));
    const ys = strokes.flatMap((s) => (s.kind === 'geometric' && s.shape.type === 'line' ? [s.shape.from.y, s.shape.to.y] : []));
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2 * TABLE_CELL_SIZE.width);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * TABLE_CELL_SIZE.height);
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(A4_DIMENSIONS.width / 2);
  });

  it('stays on the page however many columns', () => {
    const strokes = drawnTableStrokes(A4_DIMENSIONS, { rows: 2, columns: 20, style });
    const xs = strokes.flatMap((s) => (s.kind === 'geometric' && s.shape.type === 'line' ? [s.shape.from.x, s.shape.to.x] : []));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(A4_DIMENSIONS.width);
  });
});
