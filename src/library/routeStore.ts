/**
 * Where the app is: the library, or one open document.
 *
 * The reducer is a pure function so the navigation rules can be tested
 * without mounting anything, and the store is a thin shell over it that also
 * carries the one side effect the rules imply — a document left behind must
 * be released, or every notebook opened in a session stays in memory for the
 * rest of it.
 */
import { create } from 'zustand';
import { useDocumentStore } from '../document/store';
import { rasterCache } from '../document/raster/rasterCache';

export type Route =
  | { readonly view: 'library'; readonly folder: string | null }
  | {
      readonly view: 'document';
      /** Native path, or `null` for a document that has never been saved. */
      readonly path: string | null;
      /** The folder it was opened from, so going back lands where it started. */
      readonly from: string | null;
    };

export type RouteIntent =
  | { readonly kind: 'library' }
  | { readonly kind: 'folder'; readonly folder: string | null }
  | { readonly kind: 'document'; readonly path: string | null }
  | { readonly kind: 'back' };

/** The library root. */
export const HOME: Route = { view: 'library', folder: null };

function sameRoute(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false;
  if (a.view === 'library' && b.view === 'library') return a.folder === b.folder;
  if (a.view === 'document' && b.view === 'document') return a.path === b.path && a.from === b.from;
  return false;
}

/**
 * The next route for an intent.
 *
 * Returns the *same object* when nothing changes, so a no-op navigation
 * cannot re-render the tree it was supposed to leave alone.
 */
export function nextRoute(current: Route, intent: RouteIntent): Route {
  const proposed = propose(current, intent);
  return sameRoute(current, proposed) ? current : proposed;
}

function propose(current: Route, intent: RouteIntent): Route {
  switch (intent.kind) {
    // "Home" goes to the root, not to wherever you happened to be. It is the
    // way out of a library you have navigated deep into.
    case 'library':
      return HOME;
    case 'folder':
      return { view: 'library', folder: intent.folder };
    case 'document':
      return {
        view: 'document',
        path: intent.path,
        // Opening from a folder means going back lands in that folder; opening
        // one document from another keeps the original folder.
        from: current.view === 'library' ? current.folder : current.from,
      };
    case 'back':
      // Back out of a document, to the folder it came from. Backing out of the
      // library is the caller's job: going up a level needs the parent path,
      // which only a listing knows.
      return current.view === 'document' ? { view: 'library', folder: current.from } : current;
  }
}

export interface RouteStore {
  route: Route;
  navigate: (intent: RouteIntent) => void;
  openDocument: (path: string | null) => void;
  openFolder: (folder: string | null) => void;
  /** Leave the open document behind and show the library again. */
  backToLibrary: () => void;
  goHome: () => void;
}

/**
 * Release the open document.
 *
 * A document is the largest thing the app holds — every page's strokes, every
 * embedded image as a data URL, any imported PDF — and the page raster cache
 * holds decoded bitmaps of it on top. Returning to the library resets the
 * store to a fresh empty document and drops the bitmaps, so browsing a library
 * does not accumulate every notebook that was opened along the way.
 */
function releaseDocument(): void {
  useDocumentStore.getState().newDocument();
  rasterCache.clear();
}

export const useRouteStore = create<RouteStore>()((set, get) => {
  const go = (intent: RouteIntent): void => {
    const current = get().route;
    const next = nextRoute(current, intent);
    if (next === current) return;
    if (current.view === 'document' && next.view === 'library') releaseDocument();
    set({ route: next });
  };
  return {
    route: HOME,
    navigate: go,
    openDocument: (path) => go({ kind: 'document', path }),
    openFolder: (folder) => go({ kind: 'folder', folder }),
    backToLibrary: () => go({ kind: 'back' }),
    goHome: () => go({ kind: 'library' }),
  };
});
