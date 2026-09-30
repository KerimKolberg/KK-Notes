/**
 * What was last copied or cut from a page, kept for pasting.
 *
 * Its own small store rather than a part of the document's: the document is what is
 * saved and undone, and a clipboard is neither. It belongs to the running app, so it
 * is still there after switching to another note in a tab — which is the whole point
 * of a clipboard — and it is gone when the app closes.
 */
import { create } from 'zustand';
import type { Stroke } from '../inking/types';

interface ClipboardState {
  /** The copied strokes, exactly as they were. Empty when nothing has been copied. */
  readonly strokes: readonly Stroke[];
  /** The page they came from, so a paste back onto it lands beside the original and not on top of it. */
  readonly sourcePageId: string | null;
  /** How many times they have been pasted since, so each paste steps a little further along. */
  readonly pastes: number;
  copy: (strokes: readonly Stroke[], sourcePageId: string) => void;
  notePasted: () => void;
  clear: () => void;
}

export const useClipboardStore = create<ClipboardState>()((set) => ({
  strokes: [],
  sourcePageId: null,
  pastes: 0,
  copy: (strokes, sourcePageId) => set(strokes.length === 0 ? {} : { strokes, sourcePageId, pastes: 0 }),
  notePasted: () => set((s) => ({ pastes: s.pastes + 1 })),
  clear: () => set({ strokes: [], sourcePageId: null, pastes: 0 }),
}));
