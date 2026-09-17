/**
 * The laser pointer is live-only. These tests pin the guarantee at the two
 * places a stroke could sneak into a document: the pure page operations and
 * the store action the pointer pipeline calls when a stroke ends.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { makeStroke } from '../../inking/__tests__/testUtils';
import { isEphemeralTool } from '../../inking/engine/pointerPolicy';
import type { Stroke } from '../../inking/types';
import { appendStroke, createPage } from '../operations';
import { serializeDocument } from '../serialization';
import { useDocumentStore } from '../store';

const laserStroke = (): Stroke => makeStroke([[10, 10], [40, 30], [80, 25]], { tool: 'laser-pointer' });
const penStroke = (): Stroke => makeStroke([[10, 10], [40, 30]]);

const store = useDocumentStore;
const page = () => store.getState().document.pages[0]!;

describe('laser pointer strokes never reach the document', () => {
  beforeEach(() => {
    store.getState().setReadOnly(false);
    store.getState().newDocument();
  });

  it('is classified as an ephemeral tool', () => {
    expect(isEphemeralTool(laserStroke().tool)).toBe(true);
    expect(isEphemeralTool(penStroke().tool)).toBe(false);
  });

  it('appendStroke ignores it: no stroke, no history entry', () => {
    const blank = createPage();
    const next = appendStroke(blank, laserStroke());
    expect(next).toBe(blank);
    expect(next.strokes).toHaveLength(0);
    expect(next.undoStack).toHaveLength(0);
    expect(next.redoStack).toHaveLength(0);
  });

  it('appendStroke keeps ignoring it on a page that already has ink', () => {
    const inked = appendStroke(createPage(), penStroke());
    const next = appendStroke(inked, laserStroke());
    expect(next).toBe(inked);
    expect(next.strokes).toHaveLength(1);
    expect(next.undoStack).toHaveLength(1);
  });

  it('commitStroke leaves the page’s stroke array and undo stack untouched', () => {
    const pageId = page().id;
    store.getState().commitStroke(pageId, penStroke());
    const afterPen = page();
    expect(afterPen.strokes).toHaveLength(1);
    expect(afterPen.undoStack).toHaveLength(1);

    for (let i = 0; i < 5; i++) store.getState().commitStroke(pageId, laserStroke());

    expect(page().strokes).toHaveLength(1);
    expect(page().undoStack).toHaveLength(1);
    expect(page().redoStack).toHaveLength(0);
    // Nothing changed at all, so the page object itself is still the same.
    expect(page()).toBe(afterPen);
    expect(page().strokes.some((s) => isEphemeralTool(s.tool))).toBe(false);
  });

  it('cannot be undone into existence, or saved', () => {
    const pageId = page().id;
    store.getState().commitStroke(pageId, laserStroke());
    store.getState().undo(pageId);
    store.getState().redo(pageId);
    expect(page().strokes).toHaveLength(0);

    const saved = serializeDocument(store.getState().document);
    expect(saved).not.toContain('laser-pointer');
  });
});
