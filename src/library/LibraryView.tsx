import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Cloud, FolderOpen, FolderPlus, Grid2x2, House, List, Plus } from 'lucide-react';
import { openDocumentFromLibrary } from './openDocument';
import { CloudSyncPanel } from './CloudSyncPanel';
import { ConflictDialog } from './ConflictDialog';
import { DocumentCard } from './DocumentCard';
import { SyncIndicator } from './SyncIndicator';
import {
  createDocumentInLibrary,
  createFolder,
  deleteEntry,
  listLibrary,
  moveEntry,
  resolveConflict,
  syncNow,
  syncStatus,
  watchSyncStatus,
} from './libraryService';
import { useDesktopStore } from '../desktop/desktopStore';
import { openFileFromLibrary } from './openFile';
import { useRouteStore } from './routeStore';
import {
  DEFAULT_SORT,
  OFFLINE_STATUS,
  SORT_KEYS,
  type ConflictResolution,
  type LibraryLayout,
  type LibraryListing,
  type LibrarySort,
  type SortKey,
  type SyncStatus,
} from './types';

const LAYOUT_KEY = 'notes.library.layout';
const SORT_KEY = 'notes.library.sort';

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode; the preference simply does not persist */
  }
}

/** Crumbs for the folder path, so a nested folder can be climbed out of. */
function crumbs(listing: LibraryListing | null): { name: string; path: string | null }[] {
  if (!listing || listing.relativePath === '') return [];
  const parts = listing.relativePath.split('/');
  const base = listing.path.slice(0, listing.path.length - listing.relativePath.length);
  return parts.map((name, i) => ({ name, path: base + parts.slice(0, i + 1).join('/') }));
}

/**
 * The home screen: everything the user has written, as folders and documents.
 *
 * It owns no document. Cards are drawn from each file's first page alone (see
 * `thumbnail.ts`), so browsing a library never loads a notebook — that only
 * happens when one is opened, and it is released again on the way back.
 */
export function LibraryView() {
  const openDocument = useRouteStore((s) => s.openDocument);
  const openFolder = useRouteStore((s) => s.openFolder);
  const goHome = useRouteStore((s) => s.goHome);
  const folder = useRouteStore((s) => (s.route.view === 'library' ? s.route.folder : null));

  const [layout, setLayout] = useState<LibraryLayout>(() => readStored<LibraryLayout>(LAYOUT_KEY, 'grid'));
  const [sort, setSort] = useState<LibrarySort>(() => readStored<LibrarySort>(SORT_KEY, DEFAULT_SORT));
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SyncStatus>(OFFLINE_STATUS);
  const [showConflicts, setShowConflicts] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  // Notices raised outside the library — an "open with" that could not be
  // read, most of all. The document top bar shows these too, but only at xl,
  // so on the phone where "open with" actually happens this is the only place
  // the message is ever seen.
  const notice = useDesktopStore((s) => s.notice);
  const setNotice = useDesktopStore((s) => s.setNotice);
  const generation = useRef(0);

  useEffect(() => store(LAYOUT_KEY, layout), [layout]);
  useEffect(() => store(SORT_KEY, sort), [sort]);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await listLibrary(folder, sort);
      if (generation.current === mine) {
        setListing(next);
        setError(null);
      }
    } catch (e) {
      if (generation.current === mine) setError(e instanceof Error ? e.message : String(e));
    }
  }, [folder, sort]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Sync: the current status, a pass on arrival — which is also the
  // reconciliation the filesystem watcher cannot promise — and then whatever
  // the watcher pushes afterwards.
  useEffect(() => {
    let live = true;
    void syncStatus().then((s) => live && setStatus(s));
    void syncNow().then((s) => {
      if (!live) return;
      setStatus(s);
      void refresh();
    });
    const unlisten = watchSyncStatus((s) => {
      if (!live) return;
      setStatus(s);
      void refresh();
    });
    return () => {
      live = false;
      void unlisten.then((stop) => stop());
    };
    // Only on mount: a pass per sort change would be wasteful and pointless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guard = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const newDocument = useCallback(() => {
    void guard(async () => {
      const path = await createDocumentInLibrary(folder, 'Untitled note');
      await openDocumentFromLibrary(path);
      openDocument(path);
    });
  }, [folder, guard, openDocument]);

  const newFolder = useCallback(() => {
    const name = window.prompt('Name this folder', 'New folder');
    if (name === null) return;
    void guard(() => createFolder(folder, name));
  }, [folder, guard]);

  const open = useCallback(
    (path: string, isFolder: boolean) => {
      if (isFolder) {
        openFolder(path);
        return;
      }
      void guard(async () => {
        await openDocumentFromLibrary(path);
        openDocument(path);
      });
    },
    [guard, openDocument, openFolder],
  );

  const remove = useCallback(
    (path: string, name: string) => {
      if (!window.confirm(`Delete “${name}”? This cannot be undone.`)) return;
      void guard(() => deleteEntry(path));
    },
    [guard],
  );

  const onResolve = useCallback(
    async (path: string, choice: ConflictResolution) => {
      const next = await resolveConflict(path, choice);
      setStatus(next);
      if (next.conflicts.length === 0) setShowConflicts(false);
      await refresh();
    },
    [refresh],
  );

  /**
   * Open a file that is not in the library — a PDF to annotate, or a document
   * shared from somewhere else. The library is the home screen, so "open
   * something" belongs here rather than only inside a note you had to create
   * first in order to reach the menu.
   */
  const openFile = useCallback(() => {
    setBusy(true);
    setError(null);
    void openFileFromLibrary()
      .then((target) => {
        if (target) useRouteStore.getState().openDocument(target.path);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  const trail = useMemo(() => crumbs(listing), [listing]);
  const entries = listing?.entries ?? [];

  return (
    <div className="flex h-full w-full flex-col bg-zinc-50 dark:bg-zinc-950" data-library-view>
      <header
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900"
        style={{ paddingTop: 'calc(0.5rem + var(--safe-top))' }}
      >
        <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Library location">
          <button
            type="button"
            onClick={goHome}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 font-semibold text-zinc-900 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-zinc-100 dark:hover:bg-zinc-800"
            data-library-home
          >
            <House size={16} aria-hidden="true" />
            Library
          </button>
          {trail.map((crumb) => (
            <span key={crumb.path} className="flex min-w-0 items-center">
              <ChevronRight size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />
              <button
                type="button"
                onClick={() => openFolder(crumb.path)}
                className="truncate rounded-lg px-2 py-1 text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        <SyncIndicator status={status} onSyncNow={() => void syncNow().then(setStatus)} onShowConflicts={() => setShowConflicts(true)} />
        <button
          type="button"
          onClick={() => setShowCloud(true)}
          aria-label="Cloud sync settings"
          title="Cloud sync"
          data-cloud-settings
          className="inline-flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <Cloud size={16} aria-hidden="true" />
        </button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <button
          type="button"
          onClick={newDocument}
          disabled={busy}
          data-new-document
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          <Plus size={16} aria-hidden="true" />
          New note
        </button>
        <button
          type="button"
          onClick={openFile}
          disabled={busy}
          data-open-file
          title="Open a PDF or a document from this device"
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <FolderOpen size={16} aria-hidden="true" />
          Open
        </button>
        <button
          type="button"
          onClick={newFolder}
          disabled={busy}
          data-new-folder
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <FolderPlus size={16} aria-hidden="true" />
          New folder
        </button>
        {listing?.parentPath !== null && listing !== null && (
          <button
            type="button"
            onClick={() => openFolder(listing.parentPath)}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800"
            data-library-up
          >
            <ArrowUp size={16} aria-hidden="true" />
            Up
          </button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="sr-only sm:not-sr-only">Sort by</span>
            <select
              className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
              value={sort.key}
              aria-label="Sort by"
              data-library-sort
              onChange={(e) => setSort((s) => ({ ...s, key: e.target.value as SortKey }))}
            >
              {SORT_KEYS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label={sort.order === 'ascending' ? 'Sort descending' : 'Sort ascending'}
              data-library-sort-order={sort.order}
              onClick={() => setSort((s) => ({ ...s, order: s.order === 'ascending' ? 'descending' : 'ascending' }))}
              className="h-8 rounded-lg px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {sort.order === 'ascending' ? '↑' : '↓'}
            </button>
          </label>

          <div className="flex items-center rounded-lg border border-zinc-300 dark:border-zinc-600" role="group" aria-label="Layout">
            {([
              { id: 'grid' as const, icon: Grid2x2, label: 'Grid view' },
              { id: 'list' as const, icon: List, label: 'List view' },
            ]).map(({ id, icon: Icon, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={layout === id}
                aria-label={label}
                data-library-layout={id}
                onClick={() => setLayout(id)}
                className={`inline-flex h-8 w-8 items-center justify-center first:rounded-l-lg last:rounded-r-lg ${
                  layout === id ? 'bg-blue-600 text-white' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
                }`}
              >
                <Icon size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <p className="shrink-0 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/50 dark:text-rose-300" role="alert">
          {error}
        </p>
      )}

      {notice && (
        <div
          className="flex shrink-0 items-start gap-2 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200"
          role="status"
          data-library-notice
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.action && (
            <button
              type="button"
              className="shrink-0 rounded px-1.5 py-0.5 font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-950"
              onClick={notice.action.run}
            >
              {notice.action.label}
            </button>
          )}
          <button
            type="button"
            className="shrink-0 rounded px-1.5 text-amber-700 hover:text-amber-950 dark:text-amber-400 dark:hover:text-amber-100"
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3" style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom))' }}>
        {entries.length === 0 ? (
          <p className="py-16 text-center text-sm text-zinc-500 dark:text-zinc-400" data-library-empty>
            {listing === null ? 'Opening your library…' : 'Nothing here yet. Start a new note.'}
          </p>
        ) : (
          <ul
            className={
              layout === 'grid'
                ? 'grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3'
                : 'flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800'
            }
            data-library-entries={entries.length}
          >
            {entries.map((entry) => (
              <DocumentCard
                key={entry.path}
                entry={entry}
                layout={layout}
                onOpen={() => open(entry.path, entry.isFolder)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  remove(entry.path, entry.name);
                }}
                {...(entry.isFolder
                  ? { onDropEntry: (from: string) => void guard(() => moveEntry(from, entry.path)) }
                  : {})}
              />
            ))}
          </ul>
        )}
        {entries.length > 0 && (
          <p className="pt-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
            Drag a note onto a folder to file it. Right-click to delete.
          </p>
        )}
      </div>

      {showConflicts && status.conflicts.length > 0 && (
        <ConflictDialog conflicts={status.conflicts} onResolve={onResolve} onClose={() => setShowConflicts(false)} />
      )}

      {showCloud && (
        <CloudSyncPanel
          status={status}
          onClose={() => setShowCloud(false)}
          onSyncNow={() => {
            void syncNow().then((s) => {
              setStatus(s);
              void refresh();
            });
          }}
        />
      )}
    </div>
  );
}
