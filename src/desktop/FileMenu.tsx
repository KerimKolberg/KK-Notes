import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectIsDirty, useDocumentStore } from '../document/store';
import { useDesktopStore } from './desktopStore';
import { actionExportPdf, actionNew, actionOpen, actionOpenPath, actionSave, actionSaveAs, actionToggleFullscreen } from './fileActions';
import { fileBaseName } from './notex';

const item =
  'flex w-full items-center justify-between gap-6 rounded-md px-3 py-1.5 text-left text-sm text-zinc-800 hover:bg-zinc-100 ' +
  'disabled:opacity-40 disabled:hover:bg-transparent dark:text-zinc-100 dark:hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-blue-500';
const shortcut = 'text-xs tabular-nums text-zinc-400 dark:text-zinc-500';

/** Native-style File menu: New / Open / Save / Save As / Export PDF, recent files, fullscreen. */
export function FileMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { recent, busy, isDesktop, fullscreen } = useDesktopStore(
    useShallow((s) => ({ recent: s.recent, busy: s.busy, isDesktop: s.isDesktop, fullscreen: s.fullscreen })),
  );
  const { dirty, filePath, setImportDialogOpen } = useDocumentStore(
    useShallow((s) => ({ dirty: selectIsDirty(s), filePath: s.filePath, setImportDialogOpen: s.setImportDialogOpen })),
  );

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (action: () => Promise<unknown>): void => {
    setOpen(false);
    void action();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={`inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-200 dark:text-zinc-200 dark:hover:bg-zinc-800 ${
          open ? 'bg-zinc-200 dark:bg-zinc-800' : ''
        } focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="file-menu"
        onClick={() => setOpen((v) => !v)}
        data-file-menu
      >
        File
      </button>
      {open && (
        <div
          id="file-menu"
          role="menu"
          aria-label="File"
          className="absolute left-0 top-full z-40 mt-1 min-w-[260px] rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
        >
          <button type="button" role="menuitem" className={item} onClick={() => run(actionNew)}>
            New <span className={shortcut}>Ctrl+N</span>
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => run(actionOpen)} disabled={busy !== null}>
            Open… <span className={shortcut}>Ctrl+O</span>
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => run(actionSave)} disabled={busy !== null}>
            {isDesktop ? 'Save' : 'Save (download .notex)'} <span className={shortcut}>Ctrl+S</span>
          </button>
          {isDesktop && (
            <button type="button" role="menuitem" className={item} onClick={() => run(actionSaveAs)} disabled={busy !== null}>
              Save As… <span className={shortcut}>Ctrl+Shift+S</span>
            </button>
          )}
          <button type="button" role="menuitem" className={item} onClick={() => run(actionExportPdf)} disabled={busy !== null}>
            Export PDF… <span className={shortcut}>Ctrl+E</span>
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => run(async () => setImportDialogOpen(true))}>
            Import PDF…
          </button>

          <div className="my-1.5 border-t border-zinc-200 dark:border-zinc-800" role="separator" />
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">Recent files</div>
          {!isDesktop && <div className="px-3 pb-1.5 text-xs text-zinc-500 dark:text-zinc-400">Available in the desktop app.</div>}
          {isDesktop && recent.length === 0 && <div className="px-3 pb-1.5 text-xs text-zinc-500 dark:text-zinc-400">No recent documents.</div>}
          {isDesktop &&
            recent.map((entry) => (
              <button
                key={entry.path}
                type="button"
                role="menuitem"
                className={`${item} ${entry.path === filePath ? 'font-semibold' : ''}`}
                title={entry.path}
                onClick={() => run(() => actionOpenPath(entry.path))}
                data-recent-file
              >
                <span className="truncate">{entry.title || fileBaseName(entry.path)}</span>
                <span className="max-w-[120px] truncate text-xs text-zinc-400 dark:text-zinc-500">{fileBaseName(entry.path)}</span>
              </button>
            ))}

          {isDesktop && (
            <>
              <div className="my-1.5 border-t border-zinc-200 dark:border-zinc-800" role="separator" />
              <button type="button" role="menuitem" className={item} onClick={() => run(actionToggleFullscreen)}>
                {fullscreen ? 'Exit fullscreen' : 'Fullscreen'} <span className={shortcut}>F11</span>
              </button>
            </>
          )}
          {dirty && (
            <div className="px-3 pt-1.5 text-[11px] text-amber-600 dark:text-amber-400" data-dirty-hint>
              Unsaved changes
            </div>
          )}
        </div>
      )}
    </div>
  );
}
