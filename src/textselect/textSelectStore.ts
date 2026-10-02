import { create } from 'zustand';
import { useSnipStore } from '../snip/snipStore';
import type { LineSpan } from './geometry';

/** Which side the selected text is on: the note being written in, or the document in the reading pane. */
export type TextSurface = 'editor' | 'reference';

/** Text selected on one page, worked out once for everything that shows or uses it. */
export interface TextSelection {
  readonly surface: TextSurface;
  readonly pageId: string;
  /** The page's size in page units, which the spans are in. */
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly lines: readonly LineSpan[];
  readonly text: string;
}

/** Highlighter colours offered for text: the usual four. */
export const TEXT_HIGHLIGHT_COLORS = [
  { color: '#facc15', name: 'yellow' },
  { color: '#4ade80', name: 'green' },
  { color: '#60a5fa', name: 'blue' },
  { color: '#f472b6', name: 'pink' },
] as const;

export interface TextSelectStore {
  /** Whether dragging over a PDF page selects its text. */
  readonly mode: boolean;
  readonly selection: TextSelection | null;
  setMode: (mode: boolean) => void;
  toggleMode: () => void;
  setSelection: (selection: TextSelection | null) => void;
}

/**
 * Selecting a PDF's text. Like snipping, it is a mode the pages are in rather than a tool: the pen goes back to
 * writing when it is turned off. The two are never on together, since both are what a drag over a page does.
 */
export const useTextSelectStore = create<TextSelectStore>()((set, get) => ({
  mode: false,
  selection: null,
  setMode: (mode) => {
    if (mode) useSnipStore.getState().setMode(false);
    set(mode ? { mode } : { mode, selection: null });
  },
  toggleMode: () => get().setMode(!get().mode),
  setSelection: (selection) => set({ selection }),
}));

// Snipping does not know about this (it came first); this steps aside when snipping is turned on.
useSnipStore.subscribe((s, prev) => {
  if (s.mode && !prev.mode && useTextSelectStore.getState().mode) useTextSelectStore.getState().setMode(false);
});
