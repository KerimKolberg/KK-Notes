import { describe, expect, it } from 'vitest';
import { penScrollTarget, thumbScroll } from '../hooks/useTouchGestures';
import { isOnPage, keepOnPage } from '../layout';

// A view 800 × 600 at (100, 50), with a 16 px scrollbar down its right side.
const view = { left: 100, top: 50, clientWidth: 800, clientHeight: 600, offsetWidth: 816, offsetHeight: 600 };

describe('the pen on the view\'s own surface', () => {
  it('drags the scrollbar when pressed on it', () => {
    expect(penScrollTarget(view, 905, 300, false)).toEqual({ mode: 'thumb', axis: 'y' });
    // Even over a page's edge: the scrollbar is on top.
    expect(penScrollTarget(view, 905, 300, true)).toEqual({ mode: 'thumb', axis: 'y' });
  });

  it('drags a horizontal scrollbar along the bottom', () => {
    const wide = { ...view, offsetWidth: 800, offsetHeight: 616 };
    expect(penScrollTarget(wide, 400, 655, false)).toEqual({ mode: 'thumb', axis: 'x' });
  });

  it('pans beside the pages, and leaves the pages to write on', () => {
    expect(penScrollTarget(view, 150, 300, false)).toEqual({ mode: 'content', axis: 'y' });
    expect(penScrollTarget(view, 500, 300, true)).toBeNull();
  });

  it('has no scrollbar to drag with overlay scrollbars', () => {
    const overlay = { ...view, offsetWidth: 800 };
    expect(penScrollTarget(overlay, 895, 300, false)).toEqual({ mode: 'content', axis: 'y' });
  });
});

describe('a scrollbar dragged by the pen', () => {
  it('moves the view by the document for each px of the track', () => {
    // A document 6 views long: a px of thumb is 6 px of document.
    expect(thumbScroll(1000, 50, 3600, 600)).toBe(1300);
    expect(thumbScroll(1000, -50, 3600, 600)).toBe(700);
  });

  it('stops at either end', () => {
    expect(thumbScroll(100, -500, 3600, 600)).toBe(0);
    expect(thumbScroll(2900, 500, 3600, 600)).toBe(3000);
  });

  it('stays put with nothing to scroll', () => {
    expect(thumbScroll(0, 40, 600, 600)).toBe(0);
    expect(thumbScroll(20, 40, 600, 0)).toBe(20);
  });
});

describe('a box let go on its page', () => {
  const page = { width: 600, height: 800 };

  it('stays where it is put while any of it is on the page', () => {
    expect(keepOnPage({ x: 100, y: 200, width: 200, height: 50 }, page)).toEqual({ x: 100, y: 200 });
  });

  it('keeps a strip on the page when let go past an edge', () => {
    expect(keepOnPage({ x: 100, y: 1200, width: 200, height: 50 }, page)).toEqual({ x: 100, y: 776 });
    expect(keepOnPage({ x: -500, y: -300, width: 200, height: 50 }, page)).toEqual({ x: -176, y: -26 });
    expect(keepOnPage({ x: 900, y: 10, width: 200, height: 50 }, page)).toEqual({ x: 576, y: 10 });
  });

  it('keeps all of a box smaller than the strip', () => {
    expect(keepOnPage({ x: 700, y: 900, width: 10, height: 10 }, page)).toEqual({ x: 590, y: 790 });
  });

  it('tells a point on a page from one beside it', () => {
    const rect = { pageId: 'p', left: 0, top: 0, right: 100, bottom: 200 };
    expect(isOnPage(rect, 50, 100)).toBe(true);
    expect(isOnPage(rect, 50, 203)).toBe(false);
  });
});
