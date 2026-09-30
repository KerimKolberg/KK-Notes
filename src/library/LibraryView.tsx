import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Cloud, FolderOpen, FolderPlus, Grid2x2, House, List, Plus, Search, ShieldCheck, X } from 'lucide-react';
import { openDocumentFromLibrary } from './openDocument';
import { CloudSyncPanel } from './CloudSyncPanel';
import { ConflictDialog } from './ConflictDialog';
import { DocumentCard } from './DocumentCard';
import { LibrarySearchResults } from './LibrarySearchResults';
import { SecurityPanel } from './SecurityPanel';
import { useLockStore } from '../lock/lockStore';
import { useLibrarySearch } from './useLibrarySearch';
import { revealText } from '../search/reveal';
import type { SearchHit } from '../search/text';
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
import { openBrowserFile, openFileFromLibrary, planDrop } from './openFile';
import { isFileDrag } from '../desktop/useFileDrop';
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
  const [showSecurity, setShowSecurity] = useState(false);
  const lockOn = useLockStore((s) => s.record !== null);
  // Notices raised outside the library — an "open with" that could not be
  // read, most of all. The document top bar shows these too, but only at xl,
  // so on the phone where "open with" actually happens this is the only place
  // the message is ever seen.
  const notice = useDesktopStore((s) => s.notice);
  const setNotice = useDesktopStore((s) => s.setNotice);
  const generation = useRef(0);
  const [query, setQuery] = useState('');
  /**
   * Whether a file is being dragged over the library.
   *
   * Counted rather than set, because `dragleave` fires every time the pointer
   * crosses into a child element: a boolean flipped on enter and off on leave
   * flickers the highlight off as soon as the cursor reaches the first card.
   */
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

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
   * Open a file that is not in the library — a PDF to annotate, a document
   * shared from somewhere else, or a GoodNotes notebook to import. The library
   * is the home screen, so "open something" belongs here rather than only
   * inside a note you had to create first in order to reach the menu.
   */
  const openFile = useCallback(() => {
    setBusy(true);
    setError(null);
    void (async () => {
      const { openDocumentInTab } = await import('../document/tabStore');
      let path: string | null = null;
      const opened = await openDocumentInTab(async () => {
        const target = await openFileFromLibrary();
        path = target?.path ?? null;
        return target !== null;
      });
      if (opened) useRouteStore.getState().openDocument(path);
    })()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  /**
   * A file dropped onto the library.
   *
   * Routed through `openBrowserFile`, which is the decision the Open button
   * already makes, so a dropped PDF becomes the same document a picked one does.
   * Only files the app can open are attempted: dropping a photo on the library
   * has no meaning here (it does on a *page*, where the document view places it),
   * and saying so beats appearing to ignore it.
   */
  const dropFiles = useCallback((files: readonly File[]) => {
    const plan = planDrop(files);
    if (plan.rejected.length > 0) {
      setNotice({
        text:
          `Cannot open ${plan.rejected.map((file) => file.name).join(', ')} here. ` +
          'The library opens notes, PDFs and GoodNotes notebooks; drop an image onto a page instead.',
      });
    }
    if (!plan.open) return;
    if (plan.deferred.length > 0) {
      setNotice({ text: `Opening ${plan.open.name}. Drop one file at a time to open the others.` });
    }
    setBusy(true);
    setError(null);
    const file = plan.open;
    void (async () => {
      const { openDocumentInTab } = await import('../document/tabStore');
      let path: string | null = null;
      // In a tab, so opening from the library adds to what is already open
      // instead of discarding it.
      const opened = await openDocumentInTab(async () => {
        const target = await openBrowserFile(file);
        path = target?.path ?? null;
        return target !== null;
      });
      if (opened) useRouteStore.getState().openDocument(path);
    })()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [setNotice]);

  const dragHandlers = useMemo(
    () => ({
      onDragEnter: (e: React.DragEvent) => {
        if (!isFileDrag(e.dataTransfer)) return;
        dragDepth.current += 1;
        setDragging(true);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!isFileDrag(e.dataTransfer)) return;
        // Both of these are required for a drop to arrive at all: without the
        // prevented default the webview keeps the drag for itself.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!isFileDrag(e.dataTransfer)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      },
      onDrop: (e: React.DragEvent) => {
        if (!isFileDrag(e.dataTransfer)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        dropFiles([...e.dataTransfer.files]);
      },
    }),
    [dropFiles],
  );

  const trail = useMemo(() => crumbs(listing), [listing]);
  const entries = listing?.entries ?? [];
  const searching = query.trim().length > 0;
  const search = useLibrarySearch(query, listing);

  /** A note picked from the search results, opened at the place the words were found. */
  const openFound = useCallback(
    (path: string, hit: SearchHit | null) => {
      void guard(async () => {
        await openDocumentFromLibrary(path);
        if (hit) revealText(hit.source);
        openDocument(path);
      });
    },
    [guard, openDocument],
  );

  return (
    <div
      className="relative flex h-full w-full flex-col bg-zinc-50 dark:bg-zinc-950"
      data-library-view
      {...dragHandlers}
    >
      {dragging && (
        // Feedback, because an unmarked drop target is indistinguishable from
        // one that does not exist — which is what this screen looked like.
        <div
          className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-blue-500 bg-blue-500/10"
          data-library-drop-target
        >
          <span className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-lg">
            Drop to open
          </span>
        </div>
      )}
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
        <button
          type="button"
          onClick={() => setShowSecurity(true)}
          aria-label="App passcode"
          title={lockOn ? 'App passcode (on)' : 'App passcode'}
          data-security-settings
          className={`inline-flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-lg transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-zinc-800 ${
            lockOn ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          <ShieldCheck size={16} aria-hidden="true" />
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
          title="Open a PDF, a document or a GoodNotes notebook from this device"
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

        <div className="relative min-w-[8rem] max-w-xs flex-1 basis-40">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder="Search all notes"
            aria-label="Search all notes"
            data-library-search
            className="h-8 w-full rounded-lg border border-zinc-300 bg-white pl-8 pr-7 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-blue-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear the search"
              data-library-search-clear
              onClick={() => setQuery('')}
              className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>

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
        {searching ? (
          <LibrarySearchResults search={search} query={query} onOpen={openFound} />
        ) : entries.length === 0 ? (
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
        {!searching && entries.length > 0 && (
          <p className="pt-4 text-center text-xs text-zinc-400 dark:text-zinc-500">
            Drag a note onto a folder to file it. Right-click to delete.
          </p>
        )}
      </div>

      {showConflicts && status.conflicts.length > 0 && (
        <ConflictDialog conflicts={status.conflicts} onResolve={onResolve} onClose={() => setShowConflicts(false)} />
      )}

      {showSecurity && <SecurityPanel onClose={() => setShowSecurity(false)} />}

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
