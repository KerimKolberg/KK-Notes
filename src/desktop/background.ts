/**
 * The desktop app's life in the background (`src-tauri/src/background.rs`): opening when Windows starts, starting
 * in the tray, and staying in the tray when the window is closed.
 *
 * The settings are kept by the shell, not with the page's preferences, because the shell needs them before the page
 * has loaded: whether to show the window at all. This module reads and changes them, and answers the tray's Quit —
 * a recording in progress is finished and put in its note, and unsaved work kept in the draft, before the app goes.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { selectIsDirty, useDocumentStore } from '../document/store';
import { errorMessage } from '../lib/errors';
import { isTauri, tauriInvoke } from './tauri';

export interface BackgroundSettings {
  /** Start the app when Windows starts. */
  readonly openAtLogin: boolean;
  /** …and then only in the tray, with no window. */
  readonly startInTray: boolean;
  /** Closing the window hides it; the app keeps running in the tray. */
  readonly closeToTray: boolean;
}

export interface BackgroundStatus extends BackgroundSettings {
  /** Whether this device has any of it (Windows does; Android does not). */
  readonly supported: boolean;
}

interface BackgroundState {
  /** `null` until the shell has been asked, and in a browser. */
  readonly status: BackgroundStatus | null;
  /** Why the last change did not happen, in the shell's words. */
  readonly error: string | null;
  readonly saving: boolean;
}

export const useBackgroundStore = create<BackgroundState>()(() => ({ status: null, error: null, saving: false }));

/** The event the shell sends when Quit is chosen in the tray. */
export const QUIT_EVENT = 'notex-quit-requested';

function statusOf(raw: unknown): BackgroundStatus | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return { supported: r.supported === true, openAtLogin: r.openAtLogin === true, startInTray: r.startInTray === true, closeToTray: r.closeToTray === true };
}

/** Ask the shell for the settings. */
export async function loadBackgroundSettings(): Promise<void> {
  if (!isTauri()) return;
  try {
    useBackgroundStore.setState({ status: statusOf(await tauriInvoke<unknown>('background_settings')) });
  } catch {
    // An older shell without the commands: no background life to offer.
    useBackgroundStore.setState({ status: null });
  }
}

/** Change some of the settings; the shell registers the login start and puts up or takes down the tray icon. */
export async function changeBackgroundSettings(patch: Partial<BackgroundSettings>): Promise<void> {
  const current = useBackgroundStore.getState().status;
  if (!current?.supported) return;
  const settings: BackgroundSettings = {
    openAtLogin: patch.openAtLogin ?? current.openAtLogin,
    startInTray: patch.startInTray ?? current.startInTray,
    closeToTray: patch.closeToTray ?? current.closeToTray,
  };
  useBackgroundStore.setState({ saving: true });
  try {
    const status = statusOf(await tauriInvoke<unknown>('set_background_settings', { settings }));
    useBackgroundStore.setState({ status: status ?? current, error: null });
  } catch (error) {
    useBackgroundStore.setState({ error: errorMessage(error) });
  } finally {
    useBackgroundStore.setState({ saving: false });
  }
}

/** Whether closing the window only hides it (the shell does the hiding). */
export function closesToTray(): boolean {
  return useBackgroundStore.getState().status?.closeToTray === true;
}

/** What has to happen before the app quits from the tray: nothing recorded or written is left behind. */
export async function prepareToQuit(): Promise<void> {
  const { stopRecording, useRecorderStore } = await import('../audio/recorder');
  if (useRecorderStore.getState().status !== 'idle') await stopRecording();
  const state = useDocumentStore.getState();
  if (selectIsDirty(state)) {
    const { saveDraft } = await import('./fileService');
    await saveDraft(state.document).catch(() => {});
  }
}

/** Load the settings, and answer the tray's Quit. Mounted once, for the life of the app. */
export function useBackgroundLife(): void {
  useEffect(() => {
    if (!isTauri()) return;
    void loadBackgroundSettings();
    let unlisten: (() => void) | null = null;
    let gone = false;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const off = await listen(QUIT_EVENT, () => {
          void (async () => {
            try {
              await prepareToQuit();
            } finally {
              await tauriInvoke('quit_app').catch(() => {});
            }
          })();
        });
        if (gone) off();
        else unlisten = off;
      } catch {
        // No event bridge: the shell quits on its own after its grace period.
      }
    })();
    return () => {
      gone = true;
      unlisten?.();
    };
  }, []);
}
