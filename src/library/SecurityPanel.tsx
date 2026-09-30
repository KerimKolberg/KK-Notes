import { useState, type FormEvent, type ReactNode } from 'react';
import { Lock, ShieldCheck, X } from 'lucide-react';
import { AUTO_LOCK_CHOICES, useLockStore } from '../lock/lockStore';

const FIELD =
  'h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 outline-none focus:border-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100';
const PRIMARY = 'h-9 rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50';
const QUIET = 'h-9 rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800';

function autoLockLabel(minutes: number): string {
  return minutes === 0 ? 'Only when the app starts' : minutes === 1 ? 'After 1 minute of not using it' : `After ${minutes} minutes of not using it`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
      {label}
      {children}
    </label>
  );
}

/**
 * The app passcode, in the library's settings.
 *
 * Plain about what it is: a lock on this app, which keeps someone who picks up an unattended device
 * from opening the notes through it, and is not encryption — the notes are files in the library folder.
 * And plain about the one thing that cannot be undone: a forgotten passcode cannot be recovered.
 */
export function SecurityPanel({ onClose }: { onClose: () => void }) {
  const record = useLockStore((s) => s.record);
  const autoLockMinutes = useLockStore((s) => s.autoLockMinutes);
  const { enable, disable, change, setAutoLock, lockNow } = useLockStore.getState();

  const [mode, setMode] = useState<'idle' | 'change' | 'off'>('idle');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = (): void => {
    setMode('idle');
    setCurrent('');
    setNext('');
    setRepeat('');
    setMessage(null);
  };

  const run = async (work: () => Promise<string | null>, done?: string): Promise<void> => {
    setBusy(true);
    const problem = await work();
    setBusy(false);
    if (problem) {
      setMessage(problem);
      return;
    }
    reset();
    if (done) setMessage(done);
  };

  const turnOn = (e: FormEvent): void => {
    e.preventDefault();
    void run(() => enable(next, repeat), 'The passcode is on. It will be asked for when the app starts.');
  };
  const changeIt = (e: FormEvent): void => {
    e.preventDefault();
    void run(() => change(current, next, repeat), 'Passcode changed.');
  };
  const turnOff = (e: FormEvent): void => {
    e.preventDefault();
    void run(async () => ((await disable(current)) ? null : 'That is not the current passcode.'), 'The passcode is off.');
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-security-backdrop
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="App passcode"
        data-security-panel
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <h2 className="flex-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">App passcode</h2>
          <button type="button" aria-label="Close" data-security-close className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <p className="text-sm text-zinc-600 dark:text-zinc-300">
          {record
            ? 'KK-Notes asks for the passcode when it starts' + (autoLockMinutes > 0 ? ' and after it has been left alone for a while.' : '.')
            : 'Ask for a passcode before the notes open, so a device left lying around does not open onto them.'}
        </p>

        {record ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={PRIMARY} data-lock-now onClick={() => { lockNow(); onClose(); }}>
                <Lock size={14} className="mr-1.5 inline" aria-hidden="true" />
                Lock now
              </button>
              <span className="text-xs text-zinc-400">Ctrl+Shift+L</span>
            </div>
            <Field label="Lock automatically">
              <select className={FIELD} value={autoLockMinutes} data-auto-lock onChange={(e) => setAutoLock(Number(e.target.value))}>
                {AUTO_LOCK_CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {autoLockLabel(m)}
                  </option>
                ))}
              </select>
            </Field>

            {mode === 'idle' && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={QUIET} data-lock-change onClick={() => { reset(); setMode('change'); }}>
                  Change passcode
                </button>
                <button type="button" className={QUIET} data-lock-off onClick={() => { reset(); setMode('off'); }}>
                  Turn off
                </button>
              </div>
            )}
            {mode === 'change' && (
              <form className="flex flex-col gap-2" onSubmit={changeIt}>
                <Field label="Current passcode">
                  <input className={FIELD} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" data-lock-current />
                </Field>
                <Field label="New passcode">
                  <input className={FIELD} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" data-lock-new />
                </Field>
                <Field label="New passcode again">
                  <input className={FIELD} type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" data-lock-repeat />
                </Field>
                <div className="flex gap-2">
                  <button type="submit" className={PRIMARY} disabled={busy} data-lock-save>Change</button>
                  <button type="button" className={QUIET} onClick={reset}>Cancel</button>
                </div>
              </form>
            )}
            {mode === 'off' && (
              <form className="flex flex-col gap-2" onSubmit={turnOff}>
                <Field label="Current passcode, to turn it off">
                  <input className={FIELD} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" data-lock-current />
                </Field>
                <div className="flex gap-2">
                  <button type="submit" className={PRIMARY} disabled={busy} data-lock-save>Turn off</button>
                  <button type="button" className={QUIET} onClick={reset}>Cancel</button>
                </div>
              </form>
            )}
          </>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={turnOn}>
            <Field label="Passcode">
              <input className={FIELD} type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" data-lock-new />
            </Field>
            <Field label="Passcode again">
              <input className={FIELD} type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" data-lock-repeat />
            </Field>
            <div>
              <button type="submit" className={PRIMARY} disabled={busy} data-lock-save>Turn on the passcode</button>
            </div>
          </form>
        )}

        <p className="min-h-4 text-sm text-blue-700 dark:text-blue-300" role="status" data-security-message>
          {message}
        </p>

        <p className="border-t border-zinc-100 pt-2 text-[11px] leading-snug text-zinc-400 dark:border-zinc-800" data-security-note>
          This locks the app; it does not encrypt your notes, which are ordinary files in your library folder.
          <strong className="font-medium text-zinc-500 dark:text-zinc-300"> A forgotten passcode cannot be recovered</strong>, so choose one you will remember.
        </p>
      </div>
    </div>
  );
}
