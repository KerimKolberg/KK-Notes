import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ConflictResolution } from './types';

export interface ConflictDialogProps {
  /** Relative paths still waiting on an answer. */
  conflicts: readonly string[];
  onResolve: (path: string, choice: ConflictResolution) => Promise<void>;
  onClose: () => void;
}

const CHOICES: readonly { readonly id: ConflictResolution; readonly label: string; readonly hint: string }[] = [
  {
    id: 'keepBoth',
    label: 'Keep both',
    hint: 'The other version lands beside this one, named after the device it came from. Nothing is lost.',
  },
  { id: 'keepLocal', label: 'Keep this device’s', hint: 'Replaces the other version everywhere.' },
  { id: 'keepRemote', label: 'Keep the other device’s', hint: 'Replaces the version on this device.' },
];

/**
 * The one decision sync cannot make for you.
 *
 * Both copies changed since they last agreed, and there is no way to tell from
 * the outside which one has the work in it — the newer timestamp is not
 * reliably the better version. So the engine stops, keeps both files exactly
 * as they are, and asks. *Keep both* leads because it is the only answer that
 * cannot throw away a page of notes.
 */
export function ConflictDialog({ conflicts, onResolve, onClose }: ConflictDialogProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (path: string, choice: ConflictResolution): Promise<void> => {
    setBusy(`${path}:${choice}`);
    setError(null);
    try {
      await onResolve(path, choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-conflict-dialog>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="conflict-title"
        className="max-h-full w-full max-w-lg overflow-auto rounded-2xl bg-white p-4 shadow-2xl dark:bg-zinc-900"
      >
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 shrink-0 text-amber-500" size={20} aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id="conflict-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Changed in two places
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
              {conflicts.length === 1 ? 'This document' : 'These documents'} changed on this device and on another since
              they last matched. Nothing has been overwritten.
            </p>
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
            {error}
          </p>
        )}

        <ul className="mt-3 flex flex-col gap-3">
          {conflicts.map((path) => (
            <li key={path} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
              <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100" title={path}>
                {path}
              </p>
              <div className="mt-2 flex flex-col gap-1.5">
                {CHOICES.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    disabled={busy !== null}
                    data-conflict-choice={choice.id}
                    onClick={() => void choose(path, choice.id)}
                    className={`rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${
                      choice.id === 'keepBoth'
                        ? 'bg-blue-600 text-white hover:bg-blue-500'
                        : 'bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700'
                    }`}
                  >
                    <span className="block font-medium">
                      {busy === `${path}:${choice.id}` ? 'Working…' : choice.label}
                    </span>
                    <span className={`block text-xs ${choice.id === 'keepBoth' ? 'text-blue-100' : 'text-zinc-500 dark:text-zinc-400'}`}>
                      {choice.hint}
                    </span>
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Decide later
          </button>
        </div>
      </div>
    </div>
  );
}
