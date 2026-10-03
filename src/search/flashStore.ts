import { create } from 'zustand';

/** A box on a page, in page units. */
export interface FlashBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** How long the mark stays. */
export const FLASH_MS = 2200;

interface FlashStore {
  /** Where to point, on which page; `seq` tells one flash of the same place from the next. */
  readonly flash: { readonly pageId: string; readonly box: FlashBox; readonly seq: number } | null;
  show: (pageId: string, box: FlashBox) => void;
  clear: (seq: number) => void;
}

/**
 * The place on a page a search result is, marked for a moment once the page is shown — a handwritten word has no
 * object to select, so this is how a match in it is pointed out. View state only.
 */
export const useFlashStore = create<FlashStore>()((set, get) => ({
  flash: null,
  show: (pageId, box) => set({ flash: { pageId, box, seq: (get().flash?.seq ?? 0) + 1 } }),
  clear: (seq) => {
    if (get().flash?.seq === seq) set({ flash: null });
  },
}));
