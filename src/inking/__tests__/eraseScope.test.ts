import { describe, expect, it } from 'vitest';
import { ERASE_SCOPES, idsInScope, inEraseScope, keepStrokes, strokesInScope } from '../engine/eraseScope';
import type { Stroke } from '../types';
import { makeLine, makeStroke } from './testUtils';

const pen = makeStroke([[0, 0], [10, 10]]);
const highlight = makeStroke([[0, 0], [20, 0]], { tool: 'highlighter' });
const tape = makeStroke([[0, 40], [80, 40]], { tool: 'washi-tape' });
const line = makeLine({ x: 0, y: 0 }, { x: 50, y: 50 });
const all: Stroke[] = [pen, highlight, tape, line];

describe('what an eraser is allowed to take', () => {
  it('offers exactly the three scopes the eraser flyout shows', () => {
    expect(ERASE_SCOPES.map((s) => s.id)).toEqual(['all', 'highlighter', 'washi-tape']);
  });

  it('takes everything under the default scope', () => {
    for (const stroke of all) expect(inEraseScope(stroke, 'all')).toBe(true);
    expect(strokesInScope(all)).toHaveLength(all.length);
    expect(keepStrokes(all, 'all')).toEqual([]);
  });

  it('narrows to highlighter, leaving the writing underneath', () => {
    expect(inEraseScope(highlight, 'highlighter')).toBe(true);
    expect(inEraseScope(pen, 'highlighter')).toBe(false);
    expect(inEraseScope(tape, 'highlighter')).toBe(false);
    expect(keepStrokes(all, 'highlighter')).toEqual([pen, tape, line]);
  });

  it('narrows to washi tape, leaving whatever it was laid across', () => {
    expect(inEraseScope(tape, 'washi-tape')).toBe(true);
    expect(inEraseScope(highlight, 'washi-tape')).toBe(false);
    expect(keepStrokes(all, 'washi-tape')).toEqual([pen, highlight, line]);
  });

  it('never narrows onto a geometric stroke, which is neither', () => {
    expect(inEraseScope(line, 'highlighter')).toBe(false);
    expect(inEraseScope(line, 'washi-tape')).toBe(false);
    expect(inEraseScope(line, 'all')).toBe(true);
  });

  it('returns the same array when the scope matched nothing at all', () => {
    // Lets the caller skip the write, and the undo entry that would come with it.
    const noTape = [pen, highlight, line];
    expect(keepStrokes(noTape, 'washi-tape')).toBe(noTape);
    expect(keepStrokes(noTape, 'highlighter')).not.toBe(noTape);
  });

  it('filters a set of eraser hits down to what the scope allows', () => {
    // The eraser dragged across all four; only the highlight may go.
    const hits = new Set(all.map((s) => s.id));
    expect([...idsInScope(all, hits, 'highlighter')]).toEqual([highlight.id]);
    expect([...idsInScope(all, hits, 'washi-tape')]).toEqual([tape.id]);
    expect(idsInScope(all, hits, 'all').size).toBe(4);
    // An id that is not on the page cannot be erased off it.
    expect(idsInScope(all, new Set(['ghost']), 'highlighter').size).toBe(0);
  });
});
