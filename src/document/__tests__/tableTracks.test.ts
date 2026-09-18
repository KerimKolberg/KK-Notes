import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS, MAX_TABLE_COLUMNS, MIN_TRACK_FRACTION } from '../constants';
import {
  addTableColumn,
  columnFractions,
  createTable,
  evenFractions,
  removeTableColumn,
  resizeTrack,
  rowFractions,
  setColumnFractions,
  tableCellBox,
  trackEdges,
  trackFractions,
} from '../media';

const page = A4_DIMENSIONS;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe('track fractions', () => {
  it('divides evenly when nothing is stored', () => {
    expect(evenFractions(4)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(trackFractions(undefined, 3).every((f) => Math.abs(f - 1 / 3) < 1e-12)).toBe(true);
  });

  it('falls back to even when the stored list no longer fits the table', () => {
    // A file written before a column was added, or hand-edited.
    expect(trackFractions([0.5, 0.5], 3)).toEqual(evenFractions(3));
    expect(trackFractions([0, 0], 2)).toEqual(evenFractions(2));
  });

  it('normalises a stored list that does not sum to one', () => {
    const fractions = trackFractions([2, 1, 1], 4 - 1);
    expect(sum(fractions)).toBeCloseTo(1);
    expect(fractions[0]).toBeCloseTo(0.5);
  });

  it('runs the edges from 0 to exactly 1', () => {
    const edges = trackEdges([0.2, 0.3, 0.5]);
    expect(edges).toHaveLength(4);
    expect(edges[0]).toBe(0);
    expect(edges[3]).toBe(1);
    expect(edges[1]).toBeCloseTo(0.2);
    expect(edges[2]).toBeCloseTo(0.5);
  });
});

describe('dragging a divider', () => {
  it('moves only the two tracks either side of it', () => {
    const before = [0.25, 0.25, 0.25, 0.25];
    const after = resizeTrack(before, 2, 0.6);
    expect(after[0]).toBeCloseTo(0.25);
    expect(after[3]).toBeCloseTo(0.25);
    expect(after[1]).toBeCloseTo(0.35);
    expect(after[2]).toBeCloseTo(0.15);
    expect(sum(after)).toBeCloseTo(1);
  });

  it('never collapses either neighbour past the floor', () => {
    const before = evenFractions(3);
    const squashed = resizeTrack(before, 1, -5);
    expect(squashed[0]).toBeCloseTo(MIN_TRACK_FRACTION);
    expect(sum(squashed)).toBeCloseTo(1);

    const stretched = resizeTrack(before, 1, 5);
    expect(stretched[1]).toBeCloseTo(MIN_TRACK_FRACTION);
    expect(sum(stretched)).toBeCloseTo(1);
  });

  it('leaves the list alone when the divider does not exist', () => {
    const before = evenFractions(2);
    expect(resizeTrack(before, 0, 0.5)).toEqual(before);
    expect(resizeTrack(before, 2, 0.5)).toEqual(before);
  });

  it('places the cells on the dragged grid', () => {
    const table = setColumnFractions(createTable(page, 1, undefined, { rows: 1, columns: 2 }), [0.75, 0.25]);
    const left = tableCellBox(table, 0, 0);
    const right = tableCellBox(table, 0, 1);
    expect(left.width).toBeCloseTo(table.width * 0.75);
    expect(right.x - table.x).toBeCloseTo(table.width * 0.75);
    expect(right.width).toBeCloseTo(table.width * 0.25);
  });
});

describe('a table built from the insert menu', () => {
  it('takes the grid size and ruling it was configured with', () => {
    const table = createTable(page, 1, undefined, { rows: 3, columns: 5, lineWidth: 2.5, lineOpacity: 0.4 });
    expect(table.rows).toBe(3);
    expect(table.columns).toBe(5);
    expect(table.lineWidth).toBe(2.5);
    expect(table.lineOpacity).toBe(0.4);
    expect(table.cells).toHaveLength(15);
  });

  it('clamps a grid bigger than the picker can offer', () => {
    const table = createTable(page, 1, undefined, { rows: 999, columns: 999 });
    expect(table.columns).toBe(MAX_TABLE_COLUMNS);
  });

  it('keeps a dragged layout when a column is added and taken away again', () => {
    const table = setColumnFractions(createTable(page, 1, undefined, { rows: 2, columns: 3 }), [0.5, 0.25, 0.25]);
    const wider = { ...table, ...addTableColumn(table) };
    expect(wider.columns).toBe(4);
    expect(sum(columnFractions(wider))).toBeCloseTo(1);
    // The first column is still the widest: the new one took its share of the
    // table rather than resetting everything to even.
    const [first] = columnFractions(wider);
    expect(first).toBeGreaterThan(columnFractions(wider)[1]!);

    const back = { ...wider, ...removeTableColumn(wider) };
    expect(back.columns).toBe(3);
    expect(sum(columnFractions(back))).toBeCloseTo(1);
    expect(sum(rowFractions(back))).toBeCloseTo(1);
  });
});
