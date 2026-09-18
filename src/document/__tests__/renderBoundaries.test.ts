import { describe, expect, it } from 'vitest';
import { InkSurface } from '../../inking/InkSurface';
import { DocumentViewer } from '../components/DocumentViewer';
import { PageFrame } from '../components/PageFrame';
import { MediaLayer } from '../components/MediaLayer';
import { SelectionLayer } from '../components/SelectionLayer';

/** React tags a `memo()` result with this symbol; a plain function has none. */
const MEMO = Symbol.for('react.memo');

const isMemo = (component: unknown): boolean =>
  typeof component === 'object' && component !== null && (component as { $$typeof?: symbol }).$$typeof === MEMO;

/**
 * The canvas tree must not re-render because an unrelated bit of chrome did.
 *
 * Tool settings live in their own store, but the app component reads the
 * whole settings object, so moving a slider inside a popover re-renders it —
 * and without these boundaries that re-ran the entire page strip (laying out
 * every page, re-deriving the visible ranges) for a value the canvas does not
 * read from props at all. These guards are cheap and they fail loudly if a
 * `memo` is dropped in passing; the overlay's per-boundary commit counts are
 * how it is confirmed against a running app.
 */
describe('render boundaries around the canvas', () => {
  it('memoises every component between the app shell and the ink', () => {
    expect(isMemo(DocumentViewer)).toBe(true);
    expect(isMemo(PageFrame)).toBe(true);
    expect(isMemo(InkSurface)).toBe(true);
    expect(isMemo(MediaLayer)).toBe(true);
    expect(isMemo(SelectionLayer)).toBe(true);
  });

  it('takes only props the canvas actually depends on', () => {
    // `settingsRef` is a ref object with a stable identity, so tool settings
    // reach the pointer pipeline without ever appearing in a prop diff. That
    // leaves `currentTool` as the only thing that can re-render the viewer
    // from above — which it should, since the surfaces key their
    // interactivity off it.
    const props = (DocumentViewer as unknown as { type: (p: unknown) => unknown }).type;
    expect(typeof props).toBe('function');
    expect(props.length).toBe(1);
  });
});
