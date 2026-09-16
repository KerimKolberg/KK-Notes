import { create } from 'zustand';
import { DEFAULT_TOOL_SETTINGS } from '../inking/constants';
import type { ToolSettings } from '../inking/types';

export interface ToolStore {
  settings: ToolSettings;
  update: (patch: Partial<ToolSettings>) => void;
}

/** Tool settings shared by every page surface. */
export const useToolStore = create<ToolStore>()((set) => ({
  settings: { ...DEFAULT_TOOL_SETTINGS },
  update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
}));
