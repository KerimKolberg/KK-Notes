import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import { actionSave } from '../../desktop/fileActions';
import { useDesktopStore } from '../../desktop/desktopStore';
import { clearDraft } from '../../desktop/fileService';
import { useVersionsStore } from '../../desktop/versionsStore';
import {
  describeAge,
  describePages,
  describeSize,
  describeTime,
  listVersions,
  restoreVersion,
  type NoteVersion,
} from '../../desktop/versions';
import { selectIsDirty, useDocumentStore } from '../store';
import { errorMessage } from '../../lib/errors';

/**
 * The earlier versions of this note: one is kept each time a save replaces the file, thinned to
 * the recent past in detail and the distant past in outline. Restoring one puts it back as the
 * note; what was there is kept too, so a restore can itself be undone.
 */
export const VersionHistory = memo(function VersionHistory() {
  const close = useVersionsStore((s) => s.close);
  const filePath = useDocumentStore((s) => s.filePath);
  const dirty = useDocumentStore(selectIsDirty);
  const setNotice = useDesktopStore((s) => s.setNotice);
  const [versions, setVersions] = useState<readonly NoteVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const now = Date.now();

  useEffect(() => {
    dialogRef.current?.focus();
    if (!filePath) return;
    let live = true;
    listVersions(filePath).then(
      (list) => live && setVersions(list),
      (e: unknown) => live && setError(errorMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [filePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const restore = useCallback(
    async (version: NoteVersion) => {
      if (!filePath) return;
      setBusy(true);
      setError(null);
      try {
        // What is on screen but not yet saved is saved first, so it is kept as a version too.
        if (dirty && !(await actionSave())) {
          setError('The note could not be saved first, so nothing was changed.');
          return;
        }
        const doc = await restoreVersion(filePath, version.id);
        useDocumentStore.getState().loadDocument(doc, filePath);
        await clearDraft();
        setNotice({ text: `Restored the version from ${describeTime(version.id)}. The note as it was is in the history too.` });
        close();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
        setConfirming(null);
      }
    },
    [close, dirty, filePath, setNotice],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" data-versions-backdrop onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Version history"
        data-versions-dialog
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-700">
          <History size={18} className="text-blue-600 dark:text-blue-400" aria-hidden="true" />
          <h2 className="flex-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">Version history</h2>
          <button
            type="button"
            aria-label="Close"
            data-versions-close
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            onClick={close}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {!filePath ? (
            <p className="p-4 text-sm text-zinc-600 dark:text-zinc-300" data-versions-empty>
              This note has not been saved to a file yet. A version is kept each time a save replaces a file.
            </p>
          ) : error ? (
            <p className="p-4 text-sm text-rose-700 dark:text-rose-300" role="alert" data-versions-error>
              {error}
            </p>
          ) : versions === null ? (
            <p className="p-4 text-sm text-zinc-500">Looking for earlier versions…</p>
          ) : versions.length === 0 ? (
            <p className="p-4 text-sm text-zinc-600 dark:text-zinc-300" data-versions-empty>
              No earlier versions yet. One is kept each time you save over this note, so they will appear here as you work.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800" data-versions-list={versions.length}>
              {versions.map((version) => (
                <li key={version.id} className="flex items-center gap-3 px-4 py-2.5" data-version={version.id}>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                      {describeTime(version.id)} <span className="font-normal text-zinc-400">· {describeAge(version.id, now)}</span>
                    </div>
                    <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                      {version.title || 'Untitled note'} · {describePages(version.pageCount)} · {describeSize(version.bytes)}
                    </div>
                  </div>
                  {confirming === version.id ? (
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        data-version-confirm
                        className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
                        onClick={() => void restore(version)}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="rounded-lg px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      data-version-restore
                      className="shrink-0 rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                      onClick={() => setConfirming(version.id)}
                    >
                      Restore…
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="border-t border-zinc-100 px-4 py-2 text-[11px] leading-snug text-zinc-400 dark:border-zinc-800" data-versions-note>
          {confirming !== null
            ? `Restoring puts that version back as this note.${dirty ? ' Your unsaved changes are saved first.' : ''} What is here now stays in the list, so you can come back to it.`
            : 'Recent saves are kept closely, older ones less so, for up to two months. Kept on this device only, and not synced.'}
        </p>
      </div>
    </div>
  );
});
