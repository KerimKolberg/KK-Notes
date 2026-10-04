import { useShallow } from 'zustand/react/shallow';
import { Row, Switch } from '../ui/SettingsRow';
import { changeBackgroundSettings, useBackgroundStore } from './background';

const NOTE = 'px-1 text-xs text-zinc-500 dark:text-zinc-400';

/**
 * Starting with Windows and living in the tray, in the settings. Only where the shell has them (Windows); nothing at
 * all elsewhere.
 */
export function BackgroundSettings() {
  const { status, error, saving } = useBackgroundStore(useShallow((s) => ({ status: s.status, error: s.error, saving: s.saving })));
  if (!status?.supported) return null;
  return (
    <>
      <Row label="Windows">
        <Switch checked={status.openAtLogin} onChange={(v) => void changeBackgroundSettings({ openAtLogin: v })}>
          <span data-open-at-login>Open when Windows starts</span>
        </Switch>
        <label
          className={`inline-flex h-8 items-center gap-2 rounded-lg px-2 text-xs font-medium ${
            status.openAtLogin ? 'cursor-pointer text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800' : 'text-zinc-400 dark:text-zinc-500'
          }`}
        >
          <input
            type="checkbox"
            role="switch"
            className="h-4 w-4 accent-blue-600"
            checked={status.openAtLogin && status.startInTray}
            disabled={!status.openAtLogin || saving}
            onChange={(e) => void changeBackgroundSettings({ startInTray: e.target.checked })}
            data-start-in-tray
          />
          …in the tray, without a window
        </label>
        <Switch checked={status.closeToTray} onChange={(v) => void changeBackgroundSettings({ closeToTray: v })}>
          <span data-close-to-tray>Keep running in the tray when closed</span>
        </Switch>
      </Row>
      <p className={NOTE} data-background-note>
        In the tray (the icons by the clock), click KK-Notes to open it; right-click it to quit. Opening KK-Notes again
        from the Start menu brings back the one already running.
      </p>
      {error && (
        <p className="px-1 text-xs text-rose-600 dark:text-rose-400" role="alert" data-background-error>
          {error}
        </p>
      )}
    </>
  );
}
