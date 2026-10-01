import { create } from 'zustand';

/** One snipped region of a page, kept to be put on a note. */
export interface Snip {
  readonly id: string;
  /** PNG data URL. */
  readonly src: string;
  /** Pixels. */
  readonly width: number;
  readonly height: number;
  /** The size of the region on the page it came from, in page units: how big it was on that page. */
  readonly unitsWidth: number;
  readonly unitsHeight: number;
  /** Where it was cut from: the document's title. */
  readonly from: string;
}

/** The most snips kept; the oldest go first. A snip is a PNG, and these are held in memory, not saved with a note. */
export const MAX_SNIPS = 12;

export interface SnipStore {
  /** Whether dragging over a page snips it. */
  readonly mode: boolean;
  /** Newest first. */
  readonly snips: readonly Snip[];
  /** Whether the tray lists them (otherwise just a count). */
  readonly trayOpen: boolean;
  setMode: (mode: boolean) => void;
  toggleMode: () => void;
  add: (snip: Snip) => void;
  remove: (id: string) => void;
  clear: () => void;
  setTrayOpen: (open: boolean) => void;
}

/**
 * The snips, and whether snipping is on. Held apart from any document, so a snip cut from one tab is still here
 * after switching to another — which is the whole use of it: cut from the exercise sheet, put in the notes.
 */
export const useSnipStore = create<SnipStore>()((set, get) => ({
  mode: false,
  snips: [],
  trayOpen: true,
  setMode: (mode) => set({ mode }),
  toggleMode: () => set({ mode: !get().mode }),
  add: (snip) => set({ snips: [snip, ...get().snips].slice(0, MAX_SNIPS), trayOpen: true }),
  remove: (id) => set({ snips: get().snips.filter((s) => s.id !== id) }),
  clear: () => set({ snips: [] }),
  setTrayOpen: (trayOpen) => set({ trayOpen }),
}));
