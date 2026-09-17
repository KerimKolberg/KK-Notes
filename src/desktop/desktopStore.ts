import { create } from 'zustand';
import type { RecentFile } from './fileService';
import { isTauri } from './tauri';

export type BusyKind = 'open' | 'save' | 'export' | null;

export interface DesktopStore {
  readonly isDesktop: boolean;
  recent: readonly RecentFile[];
  /** Transient status shown in the top bar. */
  notice: { text: string; action?: { label: string; run: () => void } } | null;
  busy: BusyKind;
  fullscreen: boolean;
  setRecent: (recent: readonly RecentFile[]) => void;
  setNotice: (notice: DesktopStore['notice']) => void;
  setBusy: (busy: BusyKind) => void;
  setFullscreen: (fullscreen: boolean) => void;
}

export const useDesktopStore = create<DesktopStore>()((set) => ({
  isDesktop: isTauri(),
  recent: [],
  notice: null,
  busy: null,
  fullscreen: false,
  setRecent: (recent) => set({ recent }),
  setNotice: (notice) => set({ notice }),
  setBusy: (busy) => set({ busy }),
  setFullscreen: (fullscreen) => set({ fullscreen }),
}));
