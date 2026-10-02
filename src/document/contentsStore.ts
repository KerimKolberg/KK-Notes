import { create } from 'zustand';
import { useBookmarksStore } from './bookmarksStore';
import { useSearchStore } from '../search/searchStore';

/**
 * Whether the contents list is open. View state, like the search's and the bookmarks'; the three share a corner,
 * so opening one closes the others.
 */
export interface ContentsStore {
  readonly open: boolean;
  show: () => void;
  close: () => void;
  toggle: () => void;
}

export const useContentsStore = create<ContentsStore>()((set, get) => ({
  open: false,
  show: () => {
    useSearchStore.getState().close();
    useBookmarksStore.getState().close();
    set({ open: true });
  },
  close: () => set((s) => (s.open ? { open: false } : s)),
  toggle: () => (get().open ? set({ open: false }) : get().show()),
}));

// The other two do not know about this one (they came first, and importing it back would be a cycle), so it
// steps aside when either opens.
useSearchStore.subscribe((s, prev) => {
  if (s.open && !prev.open) useContentsStore.getState().close();
});
useBookmarksStore.subscribe((s, prev) => {
  if (s.open && !prev.open) useContentsStore.getState().close();
});
