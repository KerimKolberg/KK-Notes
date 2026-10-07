import { useEffect } from 'react';
import { Keyboard, X } from 'lucide-react';
import { isMac, keyLabel, SHORTCUT_GROUPS } from './shortcuts';
import { showShortcuts, useTypingStore } from './typingStore';

/** Every typing shortcut, grouped as a word processor's help lists them (Ctrl+/, or the keyboard button). */
export function ShortcutSheet() {
  const open = useTypingStore((s) => s.sheetOpen);
  const controller = useTypingStore((s) => s.controller);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        showShortcuts(false);
        controller?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, controller]);
  if (!open) return null;
  const mac = isMac();
  const close = (): void => {
    showShortcuts(false);
    controller?.focus();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-shortcut-sheet
        className="flex max-h-[85dvh] w-full max-w-3xl flex-col gap-3 overflow-hidden rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2">
          <Keyboard size={16} className="text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">Typing shortcuts</h2>
          <button type="button" aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="grid min-h-0 grid-cols-1 gap-x-6 gap-y-4 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} data-shortcut-group={group.title}>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{group.title}</h3>
              <ul className="flex flex-col gap-1">
                {group.shortcuts.map((s) => (
                  <li key={s.label} className="flex items-start justify-between gap-2 text-sm">
                    <span className="min-w-0 text-zinc-700 dark:text-zinc-200">
                      {s.label}
                      {s.note && <span className="ml-1 text-xs text-zinc-400 dark:text-zinc-500">({s.note})</span>}
                    </span>
                    <span className="flex max-w-[60%] flex-wrap justify-end gap-1">
                      {s.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-sans text-[11px] text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200"
                        >
                          {keyLabel(key, mac)}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
