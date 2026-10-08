import { useCallback, useEffect, useState } from 'react';
import { FileText, Folder, RotateCcw, Trash2, X } from 'lucide-react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { errorMessage } from '../lib/errors';
import { deleteForever, emptyRecycleBin, listRecycleBin, restoreFromTrash } from './trash';
import { TRASH_KEEP_DAYS, type TrashItem } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** "today", "yesterday", "3 days ago". */
export function deletedAgo(deletedMs: number, now: number): string {
  const days = Math.floor((now - deletedMs) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/** How long before something in the bin goes for good, in whole days, at least one while it is still there. */
export function daysLeft(deletedMs: number, now: number): number {
  return Math.max(1, Math.ceil((deletedMs + TRASH_KEEP_DAYS * DAY_MS - now) / DAY_MS));
}

/** The folder something was in, for "from Week 1"; the library's top level is "Library". */
function folderOf(original: string): string {
  const parts = original.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : 'Library';
}

type Asking = { readonly kind: 'delete'; readonly ids: readonly string[] } | { readonly kind: 'empty' };

/**
 * The recycle bin: what was deleted from the library in the last month, to put back where it was or to delete for
 * good. Whatever is chosen comes back with its star and tags (`trash.ts`); a folder with what was in it.
 */
export function RecycleBin({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<Asking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = Date.now();

  const load = useCallback(async () => {
    try {
      const next = await listRecycleBin();
      setItems(next);
      setChosen((current) => new Set([...current].filter((id) => next.some((item) => item.id === id))));
    } catch (e) {
      setError(errorMessage(e));
      setItems([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !asking) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, asking]);

  const act = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setChosen(new Set());
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const toggle = (id: string): void =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const ids = [...chosen];
  const all = items ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-recycle-backdrop onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Recycle bin"
        data-recycle-bin
        className="flex max-h-[min(36rem,calc(100dvh-2rem))] w-full max-w-lg flex-col rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <Trash2 size={16} className="text-zinc-500" aria-hidden="true" />
          <h2 className="min-w-0 flex-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">Recycle bin</h2>
          <button type="button" aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="px-4 pt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Notes you delete stay here for {TRASH_KEEP_DAYS} days, then go for good. Select what to put back where it was.
        </p>
        {error && (
          <p className="mx-4 mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300" role="alert">
            {error}
          </p>
        )}
        <ul className="min-h-0 flex-1 overflow-y-auto px-2 py-2" data-recycle-items={all.length}>
          {items === null ? (
            <li className="px-2 py-6 text-center text-sm text-zinc-500">Looking in the recycle bin…</li>
          ) : all.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-zinc-500" data-recycle-empty>
              The recycle bin is empty.
            </li>
          ) : (
            all.map((item) => (
              <li key={item.id}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800" data-recycle-item={item.name}>
                  <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={chosen.has(item.id)} onChange={() => toggle(item.id)} aria-label={`Select ${item.name}`} />
                  {item.isFolder ? <Folder size={18} className="shrink-0 text-blue-500" aria-hidden="true" /> : <FileText size={18} className="shrink-0 text-zinc-400" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.name}</span>
                    <span className="block truncate text-xs text-zinc-500 dark:text-zinc-400">
                      From {folderOf(item.original)}
                      {item.isFolder ? ` · ${item.count} note${item.count === 1 ? '' : 's'}` : ''} · deleted {deletedAgo(item.deletedMs, now)} · gone in{' '}
                      {daysLeft(item.deletedMs, now)} day{daysLeft(item.deletedMs, now) === 1 ? '' : 's'}
                    </span>
                  </span>
                </label>
              </li>
            ))
          )}
        </ul>
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <button
            type="button"
            className="h-9 rounded-lg px-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-zinc-800"
            disabled={all.length === 0 || busy}
            onClick={() => setChosen(chosen.size === all.length ? new Set() : new Set(all.map((item) => item.id)))}
            data-recycle-all
          >
            {chosen.size === all.length && all.length > 0 ? 'Select none' : 'Select all'}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:text-rose-300 dark:hover:bg-rose-950/50"
            disabled={ids.length === 0 || busy}
            onClick={() => setAsking({ kind: 'delete', ids })}
            data-recycle-delete
          >
            Delete for good
          </button>
          <button
            type="button"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
            disabled={ids.length === 0 || busy}
            onClick={() => void act(() => restoreFromTrash(ids))}
            data-recycle-restore
          >
            <RotateCcw size={15} aria-hidden="true" />
            Put back{ids.length > 1 ? ` ${ids.length}` : ''}
          </button>
        </div>
        {all.length > 0 && (
          <button
            type="button"
            className="border-t border-zinc-200 px-4 py-2 text-xs font-medium text-zinc-500 hover:bg-zinc-50 hover:text-rose-600 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
            disabled={busy}
            onClick={() => setAsking({ kind: 'empty' })}
            data-recycle-empty-all
          >
            Empty the recycle bin
          </button>
        )}
      </div>
      {asking && (
        <ConfirmDialog
          title={asking.kind === 'empty' ? 'Empty the recycle bin?' : `Delete ${asking.ids.length === 1 ? 'this' : `these ${asking.ids.length}`} for good?`}
          confirmLabel={asking.kind === 'empty' ? 'Empty the recycle bin' : 'Delete for good'}
          danger
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const current = asking;
            setAsking(null);
            void act(() => (current.kind === 'empty' ? emptyRecycleBin() : deleteForever(current.ids)));
          }}
        >
          {asking.kind === 'empty'
            ? `Everything in it — ${all.length} item${all.length === 1 ? '' : 's'} — is deleted for good. This cannot be undone.`
            : 'They are deleted for good. This cannot be undone.'}
        </ConfirmDialog>
      )}
    </div>
  );
}
