/**
 * Read-only lock. The store is the enforcement point: while `readOnly` is
 * set, no action may change document content, while navigation, view state
 * and AcroForm values keep working.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeStroke } from '../../inking/__tests__/testUtils';
import type { ImageLayer } from '../types';
import { selectIsDirty, useDocumentStore } from '../store';

const store = useDocumentStore;
const doc = () => store.getState().document;
const page = (index = 0) => doc().pages[index]!;

const image: ImageLayer = {
  kind: 'image',
  id: 'img-1',
  src: 'data:image/png;base64,iVBORw0KGgo=',
  mime: 'image/png',
  x: 10,
  y: 10,
  width: 100,
  height: 80,
  rotation: 0,
  zIndex: 1,
  naturalWidth: 100,
  naturalHeight: 80,
};

describe('read-only lock', () => {
  beforeEach(() => {
    store.getState().setReadOnly(false);
    store.getState().newDocument();
  });

  it('starts unlocked and toggles', () => {
    expect(store.getState().readOnly).toBe(false);
    store.getState().toggleReadOnly();
    expect(store.getState().readOnly).toBe(true);
    store.getState().toggleReadOnly();
    expect(store.getState().readOnly).toBe(false);
  });

  it('drops the editing selections when it locks', () => {
    const pageId = page().id;
    store.getState().commitStroke(pageId, makeStroke([[0, 0], [10, 10]]));
    store.getState().setLassoSelection({ pageId, strokeIds: [page().strokes[0]!.id] });
    store.getState().addMedia(pageId, image);
    expect(store.getState().lassoSelection).not.toBeNull();
    expect(store.getState().selectedMedia).not.toBeNull();

    store.getState().setReadOnly(true);
    expect(store.getState().lassoSelection).toBeNull();
    expect(store.getState().selectedMedia).toBeNull();
  });

  it('refuses every content edit while locked', () => {
    const pageId = page().id;
    store.getState().commitStroke(pageId, makeStroke([[0, 0], [10, 10]]));
    store.getState().addPage('after');
    const before = doc();
    const strokeId = page().strokes[0]!.id;

    store.getState().setReadOnly(true);
    const s = store.getState();
    s.setTitle('Renamed while locked');
    s.commitStroke(pageId, makeStroke([[50, 50], [60, 60]]));
    s.eraseStrokes(pageId, new Set([strokeId]));
    s.clearPage(pageId);
    s.undo(pageId);
    s.redo(pageId);
    s.addPage('after');
    s.appendPages([]);
    s.duplicatePage(0);
    s.deletePage(1);
    s.movePage(0, 1);
    s.setPageTemplate(0, 'grid');
    s.setPageBackground(0, '#000000');
    s.addMedia(pageId, image);
    s.updateMedia(pageId, image.id, { x: 99 });
    s.removeMedia(pageId, image.id);
    s.bringMediaToFront(pageId, image.id);
    s.sendMediaToBack(pageId, image.id);
    s.setLassoSelection({ pageId, strokeIds: [strokeId] });
    s.transformSelection(pageId, [strokeId], { kind: 'translate', dx: 25, dy: 25 });
    s.restyleSelection(pageId, [strokeId], { color: '#ff0000' });
    s.duplicateSelection(pageId, [strokeId]);
    s.deleteSelection(pageId, [strokeId]);

    // Not a single action touched the document.
    expect(doc()).toBe(before);
    expect(store.getState().lassoSelection).toBeNull();
  });

  it('still navigates, zooms and fills in forms while locked', () => {
    store.getState().addPage('after');
    const pageId = page().id;
    store.getState().setReadOnly(true);

    store.getState().jumpToPage(1);
    expect(doc().activePageIndex).toBe(1);
    store.getState().setActivePage(0);
    expect(doc().activePageIndex).toBe(0);
    store.getState().setViewMode('single-page');
    expect(doc().viewMode).toBe('single-page');
    store.getState().setZoom(1.5);
    expect(doc().zoom).toBe(1.5);
    store.getState().zoomBy(1);
    expect(doc().zoom).toBeGreaterThan(1.5);
    store.getState().setArrangerOpen(true);
    expect(store.getState().arrangerOpen).toBe(true);

    // Filling in an AcroForm field is explicitly allowed.
    store.getState().setFormValue(pageId, 'signature', 'Ada');
    expect(page().formValues.signature).toBe('Ada');
    store.getState().setFormValue(pageId, 'agree', true);
    expect(page().formValues.agree).toBe(true);
  });

  it('never marks the document dirty by locking or unlocking', () => {
    expect(selectIsDirty(store.getState())).toBe(false);
    store.getState().setReadOnly(true);
    expect(selectIsDirty(store.getState())).toBe(false);
    store.getState().setReadOnly(false);
    expect(selectIsDirty(store.getState())).toBe(false);
  });

  it('resumes editing once unlocked', () => {
    const pageId = page().id;
    store.getState().setReadOnly(true);
    store.getState().commitStroke(pageId, makeStroke([[0, 0], [10, 10]]));
    expect(page().strokes).toHaveLength(0);

    store.getState().setReadOnly(false);
    store.getState().commitStroke(pageId, makeStroke([[0, 0], [10, 10]]));
    expect(page().strokes).toHaveLength(1);
    expect(page().undoStack).toHaveLength(1);
    store.getState().undo(pageId);
    expect(page().strokes).toHaveLength(0);
  });
});
