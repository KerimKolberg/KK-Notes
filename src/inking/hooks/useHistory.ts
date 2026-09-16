import { useCallback, useReducer } from 'react';
import { createHistoryState, historyReducer, type HistoryAction, type HistoryState } from '../engine/history';
import type { Stroke } from '../types';

export interface UseHistoryResult {
  strokes: readonly Stroke[];
  canUndo: boolean;
  canRedo: boolean;
  addStroke: (stroke: Stroke) => void;
  removeStrokes: (ids: ReadonlySet<string>) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;
}

/** React binding for the pure history reducer. */
export function useHistory(initialStrokes: readonly Stroke[], maxDepth: number): UseHistoryResult {
  const reducer = useCallback(
    (state: HistoryState, action: HistoryAction) => historyReducer(state, action, maxDepth),
    [maxDepth],
  );
  const [state, dispatch] = useReducer(reducer, initialStrokes, createHistoryState);

  const addStroke = useCallback((stroke: Stroke) => dispatch({ type: 'add', stroke }), []);
  const removeStrokes = useCallback((ids: ReadonlySet<string>) => dispatch({ type: 'remove', ids }), []);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);

  return {
    strokes: state.strokes,
    canUndo: state.undoStack.length > 0,
    canRedo: state.redoStack.length > 0,
    addStroke,
    removeStrokes,
    clear,
    undo,
    redo,
  };
}
