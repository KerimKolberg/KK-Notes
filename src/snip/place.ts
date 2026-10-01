import { useDesktopStore } from '../desktop/desktopStore';
import { createImageLayer, nextZIndex } from '../document/media';
import { useDocumentStore } from '../document/store';
import { useToolStore } from '../document/toolStore';
import type { ImageLayer } from '../document/types';
import { defaultCentre, fitOnPage, topLeftFor, type Pt } from './geometry';
import type { Snip } from './snipStore';

/**
 * Put a snip on a page of the note that is open, as a picture: the size it was where it was cut (shrunk if that is
 * more than most of the page), at `at` if given, else near the top left. It is selected, so it can be moved and
 * resized straight away, and Undo takes it off again. `false` when it could not be placed (a locked note).
 */
export function placeSnip(snip: Snip, options: { readonly pageIndex?: number; readonly at?: Pt } = {}): boolean {
  const state = useDocumentStore.getState();
  if (state.readOnly) {
    useDesktopStore.getState().setNotice({ text: 'This note is locked for presenting, so nothing can be added to it.' });
    return false;
  }
  const doc = state.document;
  const index = options.pageIndex ?? doc.activePageIndex;
  const page = doc.pages[index];
  if (!page) return false;

  const size = fitOnPage({ width: snip.unitsWidth, height: snip.unitsHeight }, page.dimensions);
  const centre = options.at ?? defaultCentre(size, page.dimensions, page.media.length);
  const corner = topLeftFor(centre, size, page.dimensions);
  const base = createImageLayer({
    src: snip.src,
    mime: 'image/png',
    naturalWidth: snip.width,
    naturalHeight: snip.height,
    page: page.dimensions,
    zIndex: nextZIndex(page.media),
  });
  const layer: ImageLayer = { ...base, x: corner.x, y: corner.y, width: size.width, height: size.height };

  state.addMediaUndoable(page.id, layer, 'placing a snip');
  state.setActivePage(index);
  useToolStore.getState().update({ tool: 'select' });
  state.selectMedia({ pageId: page.id, mediaId: layer.id });
  return true;
}
