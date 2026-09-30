import { create } from 'zustand';
import { useSearchStore } from '../search/searchStore';

/** Whether the bookmarks panel is open. View state, like the search panel's; the two share a corner, so one closes the other. */
export interface BookmarksStore {
  readonly open: boolean;
  show: () => void;
  close: () => void;
  toggle: () => void;
}

export const useBookmarksStore = create<BookmarksStore>()((set, get) => ({
  open: false,
  show: () => {
    useSearchStore.getState().close();
    set({ open: true });
  },
  close: () => set({ open: false }),
  toggle: () => (get().open ? set({ open: false }) : get().show()),
}));
