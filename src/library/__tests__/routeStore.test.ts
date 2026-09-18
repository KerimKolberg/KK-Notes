import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from '../../document/store';
import { HOME, nextRoute, useRouteStore, type Route } from '../routeStore';

const library = (folder: string | null = null): Route => ({ view: 'library', folder });
const document = (path: string | null, from: string | null = null): Route => ({ view: 'document', path, from });

describe('route transitions', () => {
  it('starts at the library root', () => {
    expect(HOME).toEqual({ view: 'library', folder: null });
  });

  it('opens a document, remembering the folder it came from', () => {
    const route = nextRoute(library('/lib/Maths'), { kind: 'document', path: '/lib/Maths/Week 1.notex' });
    expect(route).toEqual(document('/lib/Maths/Week 1.notex', '/lib/Maths'));
  });

  it('goes back to the folder the document was opened from', () => {
    const open = nextRoute(library('/lib/Maths'), { kind: 'document', path: '/lib/Maths/Week 1.notex' });
    expect(nextRoute(open, { kind: 'back' })).toEqual(library('/lib/Maths'));
  });

  it('keeps the original folder when one document opens another', () => {
    // Following a link from inside a document should still go back to where
    // the reader started, not to the root.
    const first = nextRoute(library('/lib/Maths'), { kind: 'document', path: '/lib/Maths/a.notex' });
    const second = nextRoute(first, { kind: 'document', path: '/lib/Maths/b.notex' });
    expect(second).toEqual(document('/lib/Maths/b.notex', '/lib/Maths'));
    expect(nextRoute(second, { kind: 'back' })).toEqual(library('/lib/Maths'));
  });

  it('sends Home to the root, not to wherever you were', () => {
    const deep = nextRoute(library('/lib/Maths/2026'), { kind: 'document', path: '/lib/Maths/2026/a.notex' });
    expect(nextRoute(deep, { kind: 'library' })).toEqual(HOME);
    expect(nextRoute(library('/lib/Maths'), { kind: 'library' })).toEqual(HOME);
  });

  it('navigates between folders', () => {
    expect(nextRoute(HOME, { kind: 'folder', folder: '/lib/Maths' })).toEqual(library('/lib/Maths'));
    expect(nextRoute(library('/lib/Maths'), { kind: 'folder', folder: null })).toEqual(HOME);
  });

  it('treats back from the library as a no-op', () => {
    // Climbing out of a folder needs the parent path, which only a listing
    // knows, so the view asks for that folder by name instead.
    const root = library(null);
    expect(nextRoute(root, { kind: 'back' })).toBe(root);
    const folder = library('/lib/Maths');
    expect(nextRoute(folder, { kind: 'back' })).toBe(folder);
  });

  it('returns the very same object when nothing changes', () => {
    // Identity matters: a no-op navigation must not re-render the tree it was
    // supposed to leave alone.
    const current = library('/lib/Maths');
    expect(nextRoute(current, { kind: 'folder', folder: '/lib/Maths' })).toBe(current);
    const open = document('/lib/a.notex', '/lib');
    expect(nextRoute(open, { kind: 'document', path: '/lib/a.notex' })).toBe(open);
    expect(nextRoute(HOME, { kind: 'library' })).toBe(HOME);
  });

  it('handles a document that has never been saved', () => {
    const route = nextRoute(HOME, { kind: 'document', path: null });
    expect(route).toEqual(document(null, null));
    expect(nextRoute(route, { kind: 'back' })).toEqual(HOME);
  });
});

describe('the route store', () => {
  beforeEach(() => {
    useRouteStore.setState({ route: HOME });
    useDocumentStore.getState().newDocument();
  });

  it('moves between the library and a document', () => {
    useRouteStore.getState().openFolder('/lib/Maths');
    expect(useRouteStore.getState().route).toEqual(library('/lib/Maths'));
    useRouteStore.getState().openDocument('/lib/Maths/Week 1.notex');
    expect(useRouteStore.getState().route).toEqual(document('/lib/Maths/Week 1.notex', '/lib/Maths'));
    useRouteStore.getState().backToLibrary();
    expect(useRouteStore.getState().route).toEqual(library('/lib/Maths'));
  });

  it('releases the open document on the way back to the library', () => {
    // The document is the largest thing the app holds. Leaving the library
    // still pointing at it would mean every notebook opened in a session
    // stayed in memory for the rest of it.
    const store = useDocumentStore.getState();
    const pageId = store.document.pages[0]!.id;
    store.commitStroke(pageId, {
      kind: 'freehand',
      id: 'stroke-1',
      tool: 'pen',
      points: [{ x: 0, y: 0, pressure: 0.5 }],
      style: store.document.pages[0]!.strokes[0]?.style ?? {
        color: '#000',
        size: 4,
        opacity: 1,
        compositeOperation: 'source-over',
        thinning: 0,
        smoothing: 0.5,
        streamline: 0.5,
        simulatePressure: false,
        taperStart: 0,
        taperEnd: 0,
        pattern: 'solid',
        arrowheads: 'none',
      },
      bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      pointerType: 'pen',
      createdAt: 0,
    });
    useDocumentStore.setState({ filePath: '/lib/Week 1.notex' });
    expect(useDocumentStore.getState().document.pages[0]!.strokes).toHaveLength(1);

    useRouteStore.getState().openDocument('/lib/Week 1.notex');
    useRouteStore.getState().backToLibrary();

    const after = useDocumentStore.getState();
    expect(after.document.pages[0]!.strokes).toHaveLength(0);
    expect(after.filePath).toBeNull();
    expect(after.lassoSelection).toBeNull();
    expect(after.selectedMedia).toBeNull();
  });

  it('leaves the document alone when navigating inside the library', () => {
    useDocumentStore.setState({ filePath: '/lib/Week 1.notex' });
    useRouteStore.getState().openFolder('/lib/Maths');
    expect(useDocumentStore.getState().filePath).toBe('/lib/Week 1.notex');
  });
});
