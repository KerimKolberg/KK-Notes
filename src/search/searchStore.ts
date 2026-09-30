/**
 * Whether the search panel is open and what it is looking for. View state: not saved, not undone.
 */
import { create } from 'zustand';

interface SearchStore {
  readonly open: boolean;
  readonly query: string;
  /** Bumped each time the panel is asked for, so an open one takes focus again. */
  readonly focusRequest: number;
  show: () => void;
  close: () => void;
  toggle: () => void;
  setQuery: (query: string) => void;
}

export const useSearchStore = create<SearchStore>()((set) => ({
  open: false,
  query: '',
  focusRequest: 0,
  show: () => set((s) => ({ open: true, focusRequest: s.focusRequest + 1 })),
  close: () => set((s) => (s.open ? { open: false } : s)),
  toggle: () => set((s) => (s.open ? { open: false } : { open: true, focusRequest: s.focusRequest + 1 })),
  setQuery: (query) => set({ query }),
}));
