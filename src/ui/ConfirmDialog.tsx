import { useEffect, useRef, type ReactNode } from 'react';

export interface ConfirmDialogProps {
  readonly title: string;
  readonly children?: ReactNode;
  /** What the confirming button says: what will happen, not "OK". */
  readonly confirmLabel: string;
  /** Red, for what cannot be taken back. */
  readonly danger?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Asking before something is done, in the app rather than with the browser's `confirm()`: the app's web view on a
 * tablet or a phone may not show that at all — a right-click that deleted a note without a word was one — and a
 * dialog that says what will happen, on a button that says it, is one that gets read.
 *
 * Escape and a press outside it cancel; the cancel button has the focus to begin with, so Enter does not delete.
 */
export function ConfirmDialog({ title, children, confirmLabel, danger = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      data-confirm-backdrop
      onPointerDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-confirm-dialog
        className="flex w-full max-w-sm flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
        {children && <div className="text-sm text-zinc-600 dark:text-zinc-300">{children}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            type="button"
            className="h-9 rounded-lg px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-zinc-200 dark:hover:bg-zinc-800"
            onClick={onCancel}
            data-confirm-cancel
          >
            Cancel
          </button>
          <button
            type="button"
            className={`h-9 rounded-lg px-3 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
              danger ? 'bg-rose-600 hover:bg-rose-500' : 'bg-blue-600 hover:bg-blue-500'
            }`}
            onClick={onConfirm}
            data-confirm-ok
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
