import { useCallback, useEffect, useState } from 'react';
import { Cloud, CloudOff, LoaderCircle, TriangleAlert } from 'lucide-react';
import {
  DISCONNECTED,
  cloudSyncAvailable,
  completeDriveSignIn,
  describeAccount,
  driveAccount,
  driveSignIn,
  driveSignOut,
  onOauthRedirect,
  watchDriveAccount,
  type DriveAccountInfo,
} from './driveService';
import type { SyncStatus } from './types';

export interface CloudSyncPanelProps {
  status: SyncStatus;
  onClose: () => void;
  /** Run a pass now, after connecting or on demand. */
  onSyncNow: () => void;
}

const PHASE_NOTE: Readonly<Record<SyncStatus['phase'], string>> = {
  offline: 'Nothing is syncing.',
  syncing: 'Syncing now…',
  upToDate: 'Everything is up to date.',
  conflicted: 'Some documents changed in two places and need an answer.',
  error: 'The last pass failed.',
};

/**
 * Cloud Sync, in the library's settings.
 *
 * The panel is deliberately plain about what connecting does and does not
 * mean. Notes sync into one "Notex Sync" folder that this app creates, under
 * a permission (`drive.file`) that lets it see nothing else in the account —
 * which is worth saying out loud, because "sign in with Google" usually is not
 * that narrow and people are right to be wary.
 *
 * Signing in leaves for the system browser, so this component never sees the
 * result of its own button: it listens for the account event instead, which is
 * also what makes it correct when the sign-in finishes minutes later, or on
 * Android after the app has been evicted and relaunched by the redirect.
 */
export function CloudSyncPanel({ status, onClose, onSyncNow }: CloudSyncPanelProps) {
  const [info, setInfo] = useState<DriveAccountInfo>(DISCONNECTED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void driveAccount().then(setInfo).catch(() => {});
  }, []);

  // The sign-in finishes in another window, so the answer arrives as an event.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void watchDriveAccount((next) => {
      if (cancelled) return;
      setBusy(false);
      setError(next.error ?? null);
      setInfo(next);
      if (next.connected) onSyncNow();
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onSyncNow]);

  // Android's half: the redirect comes back as an intent, not a loopback
  // request, so the page forwards it to Rust to be checked and redeemed.
  useEffect(
    () =>
      onOauthRedirect((redirect) => {
        setBusy(true);
        completeDriveSignIn(redirect)
          .then((next) => {
            setInfo(next);
            setError(null);
            if (next.connected) onSyncNow();
          })
          .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }),
    [onSyncNow],
  );

  const signIn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await driveSignIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
    // Deliberately stays busy on success: the browser is open and the answer
    // is still out there.
  }, []);

  const signOut = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await driveSignOut());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const inApp = cloudSyncAvailable();
  const connected = info.connected && info.hasDriveAccess;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-cloud-panel>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-sync-title"
        className="max-h-full w-full max-w-lg overflow-auto rounded-2xl bg-white p-4 shadow-2xl dark:bg-zinc-900"
      >
        <div className="flex items-start gap-3">
          {connected ? (
            <Cloud className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400" size={20} aria-hidden="true" />
          ) : (
            <CloudOff className="mt-0.5 shrink-0 text-zinc-400" size={20} aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <h2 id="cloud-sync-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Cloud Sync
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300" data-cloud-account>
              {describeAccount(info, inApp)}
            </p>
          </div>
        </div>

        {error && (
          <p
            className="mt-3 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300"
            role="alert"
            data-cloud-error
          >
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="mt-4 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Google Drive</h3>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Notes sync into a <strong>Notex Sync</strong> folder in your Drive. Notex asks only for access to the files
            it creates there — it cannot see anything else in your account.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {connected ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void signOut()}
                data-drive-sign-out
                className="inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-200 disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
              >
                {busy && <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />}
                Disconnect
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || !inApp || !info.configured}
                onClick={() => void signIn()}
                data-drive-sign-in
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? (
                  <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Cloud size={15} aria-hidden="true" />
                )}
                {busy ? 'Waiting for the browser…' : 'Sign in with Google Drive'}
              </button>
            )}

            {connected && (
              <button
                type="button"
                onClick={onSyncNow}
                data-cloud-sync-now
                className="rounded-lg px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950"
              >
                Sync now
              </button>
            )}
          </div>

          {busy && !connected && (
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400" data-cloud-waiting>
              Finish signing in, in the browser window that just opened. This panel updates by itself.
            </p>
          )}
        </div>

        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400" data-cloud-phase>
          {PHASE_NOTE[status.phase]}
          {status.phase === 'error' && status.message ? ` ${status.message}` : ''}
        </p>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
