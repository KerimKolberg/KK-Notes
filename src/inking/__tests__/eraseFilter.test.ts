import { describe, expect, it } from 'vitest';
import {
  ERASE_EVERYTHING,
  ERASE_FILTERS,
  filterIsActive,
  idsInFilter,
  inEraseFilter,
  keepStrokes,
  strokesInFilter,
  type EraseFilter,
} from '../engine/eraseFilter';
import type { Stroke } from '../types';
import { makeLine, makeStroke } from './testUtils';

const pen = makeStroke([[0, 0], [10, 10]]);
const highlight = makeStroke([[0, 0], [20, 0]], { tool: 'highlighter' });
const tape = makeStroke([[0, 40], [80, 40]], { tool: 'washi-tape' });
const line = makeLine({ x: 0, y: 0 }, { x: 50, y: 50 });
const all: Stroke[] = [pen, highlight, tape, line];

const HIGHLIGHTER_ONLY: EraseFilter = { highlighter: true, washiTape: false };
const WASHI_ONLY: EraseFilter = { highlighter: false, washiTape: true };
const BOTH: EraseFilter = { highlighter: true, washiTape: true };

describe('what an eraser is allowed to take', () => {
  it('offers exactly the two toggles the flyout shows', () => {
    expect(ERASE_FILTERS.map((f) => f.key)).toEqual(['highlighter', 'washiTape']);
  });

  it('is unfiltered until a toggle is turned on', () => {
    expect(filterIsActive(ERASE_EVERYTHING)).toBe(false);
    expect(filterIsActive(HIGHLIGHTER_ONLY)).toBe(true);
    expect(filterIsActive(WASHI_ONLY)).toBe(true);
    expect(filterIsActive(BOTH)).toBe(true);
  });

  it('takes everything while unfiltered', () => {
    for (const stroke of all) expect(inEraseFilter(stroke, ERASE_EVERYTHING)).toBe(true);
    expect(strokesInFilter(all)).toHaveLength(all.length);
    expect(keepStrokes(all, ERASE_EVERYTHING)).toEqual([]);
  });

  it('ignores ordinary pen strokes the moment any filter is on', () => {
    // The whole point: scrubbing out a highlight must not touch the writing.
    for (const filter of [HIGHLIGHTER_ONLY, WASHI_ONLY, BOTH]) {
      expect(inEraseFilter(pen, filter)).toBe(false);
      expect(keepStrokes(all, filter)).toContain(pen);
    }
  });

  it('narrows to highlighter, leaving the writing and the tape', () => {
    expect(inEraseFilter(highlight, HIGHLIGHTER_ONLY)).toBe(true);
    expect(inEraseFilter(tape, HIGHLIGHTER_ONLY)).toBe(false);
    expect(keepStrokes(all, HIGHLIGHTER_ONLY)).toEqual([pen, tape, line]);
  });

  it('narrows to washi tape, leaving whatever it was laid across', () => {
    expect(inEraseFilter(tape, WASHI_ONLY)).toBe(true);
    expect(inEraseFilter(highlight, WASHI_ONLY)).toBe(false);
    expect(keepStrokes(all, WASHI_ONLY)).toEqual([pen, highlight, line]);
  });

  it('takes both decorative layers when both toggles are on', () => {
    // Which a single "only this one layer" setting could not express.
    expect(keepStrokes(all, BOTH)).toEqual([pen, line]);
  });

  it('never takes a geometric stroke under a filter — it is neither layer', () => {
    for (const filter of [HIGHLIGHTER_ONLY, WASHI_ONLY, BOTH]) expect(inEraseFilter(line, filter)).toBe(false);
    expect(inEraseFilter(line, ERASE_EVERYTHING)).toBe(true);
  });

  it('returns the same array when the filter matched nothing at all', () => {
    // Lets the caller skip the write, and the undo entry that would come with it.
    const noTape = [pen, highlight, line];
    expect(keepStrokes(noTape, WASHI_ONLY)).toBe(noTape);
    expect(keepStrokes(noTape, HIGHLIGHTER_ONLY)).not.toBe(noTape);
  });

  it('filters a set of eraser hits down to what the filter allows', () => {
    // The eraser was dragged across all four; only the matching ones may go.
    const hits = new Set(all.map((s) => s.id));
    expect([...idsInFilter(all, hits, HIGHLIGHTER_ONLY)]).toEqual([highlight.id]);
    expect([...idsInFilter(all, hits, WASHI_ONLY)]).toEqual([tape.id]);
    expect([...idsInFilter(all, hits, BOTH)]).toEqual([highlight.id, tape.id]);
    expect(idsInFilter(all, hits, ERASE_EVERYTHING).size).toBe(4);
    // An id that is not on the page cannot be erased off it.
    expect(idsInFilter(all, new Set(['ghost']), HIGHLIGHTER_ONLY).size).toBe(0);
  });
});
