/**
 * Command-style undo/redo over an immutable stroke list.
 *
 * Each entry records just enough to invert itself (`add` → the stroke,
 * `remove` → strokes with their original indices, `clear` → the whole list),
 * so memory stays O(total strokes) instead of O(strokes × history depth).
 */
import type { HistoryEntry, IndexedStroke, Stroke } from '../types';

export interface HistoryState {
  readonly strokes: readonly Stroke[];
  readonly undoStack: readonly HistoryEntry[];
  readonly redoStack: readonly HistoryEntry[];
}

export type HistoryAction =
  | { readonly type: 'add'; readonly stroke: Stroke }
  | { readonly type: 'remove'; readonly ids: ReadonlySet<string> }
  | { readonly type: 'clear' }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' };

export function createHistoryState(strokes: readonly Stroke[] = []): HistoryState {
  return { strokes: [...strokes], undoStack: [], redoStack: [] };
}

function pushCapped(
  stack: readonly HistoryEntry[],
  entry: HistoryEntry,
  maxDepth: number,
): HistoryEntry[] {
  const overflow = stack.length - maxDepth + 1;
  const base = overflow > 0 ? stack.slice(overflow) : stack.slice();
  base.push(entry);
  return base;
}

/** Re-apply an entry (used by redo). */
function applyEntry(strokes: readonly Stroke[], entry: HistoryEntry): Stroke[] {
  switch (entry.kind) {
    case 'add':
      return [...strokes, entry.stroke];
    case 'remove': {
      const ids = new Set(entry.removed.map((r) => r.stroke.id));
      return strokes.filter((s) => !ids.has(s.id));
    }
    case 'clear':
      return [];
  }
}

/** Invert an entry (used by undo). */
function revertEntry(strokes: readonly Stroke[], entry: HistoryEntry): Stroke[] {
  switch (entry.kind) {
    case 'add': {
      let index = strokes.lastIndexOf(entry.stroke);
      if (index === -1) index = strokes.findLastIndex((s) => s.id === entry.stroke.id);
      if (index === -1) return [...strokes];
      return [...strokes.slice(0, index), ...strokes.slice(index + 1)];
    }
    case 'remove': {
      // `removed` is in ascending index order, so re-inserting sequentially
      // restores every stroke to its original position.
      const next = [...strokes];
      for (const { index, stroke } of entry.removed) {
        next.splice(Math.min(index, next.length), 0, stroke);
      }
      return next;
    }
    case 'clear':
      return [...entry.removed];
  }
}

export function historyReducer(
  state: HistoryState,
  action: HistoryAction,
  maxDepth: number,
): HistoryState {
  switch (action.type) {
    case 'add':
      return {
        strokes: [...state.strokes, action.stroke],
        undoStack: pushCapped(state.undoStack, { kind: 'add', stroke: action.stroke }, maxDepth),
        redoStack: [],
      };

    case 'remove': {
      const removed: IndexedStroke[] = [];
      const kept: Stroke[] = [];
      state.strokes.forEach((stroke, index) => {
        if (action.ids.has(stroke.id)) removed.push({ index, stroke });
        else kept.push(stroke);
      });
      if (removed.length === 0) return state;
      return {
        strokes: kept,
        undoStack: pushCapped(state.undoStack, { kind: 'remove', removed }, maxDepth),
        redoStack: [],
      };
    }

    case 'clear':
      if (state.strokes.length === 0) return state;
      return {
        strokes: [],
        undoStack: pushCapped(state.undoStack, { kind: 'clear', removed: state.strokes }, maxDepth),
        redoStack: [],
      };

    case 'undo': {
      const entry = state.undoStack[state.undoStack.length - 1];
      if (!entry) return state;
      return {
        strokes: revertEntry(state.strokes, entry),
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, entry],
      };
    }

    case 'redo': {
      const entry = state.redoStack[state.redoStack.length - 1];
      if (!entry) return state;
      return {
        strokes: applyEntry(state.strokes, entry),
        undoStack: pushCapped(state.undoStack, entry, maxDepth),
        redoStack: state.redoStack.slice(0, -1),
      };
    }
  }
}
