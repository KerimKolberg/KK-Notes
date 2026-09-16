import { describe, expect, it } from 'vitest';
import { createHistoryState, historyReducer, type HistoryState } from '../engine/history';
import { makeStroke } from './testUtils';

const MAX = 10;
const reduce = (state: HistoryState, ...actions: Parameters<typeof historyReducer>[1][]): HistoryState =>
  actions.reduce((s, a) => historyReducer(s, a, MAX), state);

describe('historyReducer', () => {
  it('adds strokes and clears the redo stack', () => {
    const a = makeStroke([[0, 0]]);
    const b = makeStroke([[1, 1]]);
    let state = reduce(createHistoryState(), { type: 'add', stroke: a }, { type: 'undo' });
    expect(state.redoStack).toHaveLength(1);

    state = reduce(state, { type: 'add', stroke: b });
    expect(state.strokes).toEqual([b]);
    expect(state.redoStack).toHaveLength(0);
  });

  it('undoes and redoes an add', () => {
    const a = makeStroke([[0, 0]]);
    let state = reduce(createHistoryState(), { type: 'add', stroke: a });
    state = reduce(state, { type: 'undo' });
    expect(state.strokes).toEqual([]);
    state = reduce(state, { type: 'redo' });
    expect(state.strokes).toEqual([a]);
  });

  it('restores removed strokes at their original indices on undo', () => {
    const [a, b, c, d] = [makeStroke([[0, 0]]), makeStroke([[1, 1]]), makeStroke([[2, 2]]), makeStroke([[3, 3]])];
    let state = reduce(
      createHistoryState(),
      { type: 'add', stroke: a },
      { type: 'add', stroke: b },
      { type: 'add', stroke: c },
      { type: 'add', stroke: d },
    );
    state = reduce(state, { type: 'remove', ids: new Set([b.id, d.id]) });
    expect(state.strokes).toEqual([a, c]);

    state = reduce(state, { type: 'undo' });
    expect(state.strokes).toEqual([a, b, c, d]);

    state = reduce(state, { type: 'redo' });
    expect(state.strokes).toEqual([a, c]);
  });

  it('ignores removals that match nothing', () => {
    const a = makeStroke([[0, 0]]);
    const state = reduce(createHistoryState(), { type: 'add', stroke: a });
    const next = reduce(state, { type: 'remove', ids: new Set(['nope']) });
    expect(next).toBe(state);
  });

  it('clear is undoable and a no-op on an empty canvas', () => {
    const a = makeStroke([[0, 0]]);
    const empty = createHistoryState();
    expect(reduce(empty, { type: 'clear' })).toBe(empty);

    let state = reduce(empty, { type: 'add', stroke: a }, { type: 'clear' });
    expect(state.strokes).toEqual([]);
    state = reduce(state, { type: 'undo' });
    expect(state.strokes).toEqual([a]);
  });

  it('undo/redo on empty stacks are no-ops', () => {
    const state = createHistoryState();
    expect(reduce(state, { type: 'undo' })).toBe(state);
    expect(reduce(state, { type: 'redo' })).toBe(state);
  });

  it('caps the undo stack, dropping the oldest entries', () => {
    let state = createHistoryState();
    for (let i = 0; i < MAX + 5; i++) {
      state = reduce(state, { type: 'add', stroke: makeStroke([[i, i]]) });
    }
    expect(state.strokes).toHaveLength(MAX + 5);
    expect(state.undoStack).toHaveLength(MAX);

    for (let i = 0; i < MAX + 5; i++) state = reduce(state, { type: 'undo' });
    // Only MAX undos were possible; the first 5 strokes are permanent.
    expect(state.strokes).toHaveLength(5);
  });

  it('seeds from initial strokes without history', () => {
    const a = makeStroke([[0, 0]]);
    const state = createHistoryState([a]);
    expect(state.strokes).toEqual([a]);
    expect(state.undoStack).toHaveLength(0);
  });
});
