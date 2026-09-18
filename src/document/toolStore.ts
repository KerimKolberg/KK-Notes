import { create } from 'zustand';
import { DEFAULT_TOOL_SETTINGS } from '../inking/constants';
import type { ToolSettings, ToolType } from '../inking/types';

export interface ToolStore {
  settings: ToolSettings;
  update: (patch: Partial<ToolSettings>) => void;
}

/**
 * Tool settings shared by every page surface.
 *
 * The performance overlay starts open in a development build and closed in a
 * shipped one, and the settings popover can switch it either way — a
 * dev-only overlay with no off switch is in the way the moment you want to
 * look at the thing underneath it, and a production build that can never show
 * one is no use when a report says "it lags on my tablet".
 */
export const useToolStore = create<ToolStore>()((set) => ({
  settings: { ...DEFAULT_TOOL_SETTINGS, debugMode: import.meta.env.DEV },
  update: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
}));

/**
 * Switch tools for the duration of a pen press (e.g. barrel button → select)
 * and restore the previous tool when that pen lifts.
 */
export function beginTemporaryTool(tool: ToolType): void {
  const previous = useToolStore.getState().settings.tool;
  if (previous === tool) return;
  useToolStore.getState().update({ tool });
  const restore = (e: PointerEvent): void => {
    if (e.pointerType !== 'pen') return;
    window.removeEventListener('pointerup', restore, true);
    window.removeEventListener('pointercancel', restore, true);
    if (useToolStore.getState().settings.tool === tool) useToolStore.getState().update({ tool: previous });
  };
  window.addEventListener('pointerup', restore, true);
  window.addEventListener('pointercancel', restore, true);
}
