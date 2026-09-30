import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { useLockStore } from './lockStore';

/**
 * Covers everything while the app is locked.
 *
 * Opaque and above every other layer, so nothing of the note shows through, and it says so when it is
 * in the way of a wrong guess rather than silently doing nothing. The note underneath stays mounted,
 * so unlocking puts the person back exactly where they were.
 */
export function LockScreen() {
  const unlock = useLockStore((s) => s.unlock);
  const retryAt = useLockStore((s) => s.retryAt);
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  // Counts the wait down while it is running.
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  const waitSeconds = Math.max(0, Math.ceil((retryAt - now) / 1000));

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || value.length === 0) return;
    setBusy(true);
    const result = await unlock(value);
    setBusy(false);
    setNow(Date.now());
    if (result === 'ok') {
      setValue('');
      setMessage(null);
    } else {
      setValue('');
      setMessage(result === 'wait' ? 'Too many wrong tries. Wait a moment.' : 'That is not the right passcode.');
      inputRef.current?.focus();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="KK-Notes is locked"
      data-lock-screen
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-4 bg-zinc-100 px-6 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
    >
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg">
        <Lock size={26} aria-hidden="true" />
      </span>
      <h1 className="text-lg font-semibold">KK-Notes is locked</h1>
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-xs flex-col gap-2">
        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="current-password"
          aria-label="Passcode"
          placeholder="Passcode"
          data-lock-input
          disabled={busy}
          className="h-11 rounded-xl border border-zinc-300 bg-white px-3 text-center text-base outline-none focus:border-blue-500 dark:border-zinc-600 dark:bg-zinc-900"
        />
        <button
          type="submit"
          data-lock-submit
          disabled={busy || value.length === 0 || waitSeconds > 0}
          className="h-11 rounded-xl bg-blue-600 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {waitSeconds > 0 ? `Try again in ${waitSeconds} s` : 'Unlock'}
        </button>
        <p className="min-h-5 text-center text-sm text-rose-600 dark:text-rose-400" role="alert" data-lock-message>
          {message}
        </p>
      </form>
    </div>
  );
}
