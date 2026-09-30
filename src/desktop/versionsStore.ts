import { create } from 'zustand';

/** Whether the version history dialog is open. View state, like the search panel's. */
export interface VersionsStore {
  readonly open: boolean;
  show: () => void;
  close: () => void;
}

export const useVersionsStore = create<VersionsStore>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));
