import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, PAGE_GAP, VIEWER_PADDING } from '../constants';
import {
  anchorForContentPoint,
  anchoredScroll,
  centroid,
  panScroll,
  pinchStart,
  pinchUpdate,
  previewTransform,
  scrollForAnchor,
  feltPinchLog,
  feltPinchScale,
  isWheelNotch,
  NATURAL_ZOOM,
  touchDistance,
  wheelPinchLog,
} from '../gestures';
import { clampZoom, itemAtContent, layoutPages } from '../layout';

const A4 = { width: 794, height: 1123 };
const items = layoutPages([{ dimensions: A4 }, { dimensions: A4 }, { dimensions: A4 }], {
  zoom: 1,
  gap: PAGE_GAP,
  padding: VIEWER_PADDING,
  containerWidth: 1200,
}).items;

describe('clampZoom', () => {
  it('rounds to 1% and clamps to the supported range', () => {
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
  });
});

describe('pinch math', () => {
  it('computes centroid and distance', () => {
    expect(centroid({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
    expect(touchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('scales zoom by the change in finger distance and pans by the midpoint', () => {
    const start = pinchStart({ x: 100, y: 100 }, { x: 200, y: 100 }, 1);
    expect(start).toEqual({ mid: { x: 150, y: 100 }, dist: 100, zoom: 1 });
    // Spread to 200px apart and drift 30px down.
    const state = pinchUpdate(start, { x: 60, y: 130 }, { x: 260, y: 130 });
    expect(state.zoom).toBe(2);
    expect(state.scale).toBe(2);
    expect(state.pan).toEqual({ x: 10, y: 30 });
    expect(state.mid).toEqual({ x: 160, y: 130 });
  });

  it('clamps to the zoom range and keeps the scale consistent with the clamped zoom', () => {
    const start = pinchStart({ x: 0, y: 0 }, { x: 100, y: 0 }, 2);
    const state = pinchUpdate(start, { x: 0, y: 0 }, { x: 1000, y: 0 });
    expect(state.zoom).toBe(MAX_ZOOM);
    expect(state.scale).toBeCloseTo(MAX_ZOOM / 2);
    const tiny = pinchUpdate(start, { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(tiny.zoom).toBe(MIN_ZOOM);
  });

  it('a pinch that starts with the fingers together only pans', () => {
    const start = pinchStart({ x: 50, y: 50 }, { x: 50, y: 50 }, 1.5);
    const state = pinchUpdate(start, { x: 0, y: 50 }, { x: 300, y: 50 });
    expect(state.zoom).toBe(1.5);
    expect(state.scale).toBe(1);
    expect(state.pan).toEqual({ x: 100, y: 0 });
  });

  it('pan / anchored scroll are simple inverses of finger motion', () => {
    expect(panScroll({ x: 100, y: 500 }, { x: 10, y: -20 })).toEqual({ x: 90, y: 520 });
    expect(anchoredScroll({ x: 1000, y: 2000 }, { x: 300, y: 400 })).toEqual({ x: 700, y: 1600 });
  });

  it('previewTransform keeps the anchor under the moved centroid', () => {
    const css = previewTransform({ x: 40, y: 60 }, { x: 5, y: -5 }, 1.5);
    expect(css.transformOrigin).toBe('40px 60px');
    expect(css.transform).toBe('translate(5px, -5px) scale(1.5)');
  });
});

describe('anchoring across a zoom change', () => {
  it('finds the page under a content point (or the nearest one in a gap)', () => {
    const second = items[1]!;
    expect(itemAtContent(items, { x: 0, y: second.top + 10 })?.index).toBe(1);
    expect(itemAtContent(items, { x: 0, y: second.top - 2 })?.index).toBe(1); // in the gap, nearer to page 2
    expect(itemAtContent(items, { x: 0, y: -1000 })?.index).toBe(0);
    expect(itemAtContent(items, { x: 0, y: 1e9 })?.index).toBe(2);
    expect(itemAtContent([], { x: 0, y: 10 })).toBeUndefined();
  });

  it('maps content → page point and back so the anchored point stays under the fingers', () => {
    const zoom0 = 1;
    const second = items[1]!;
    const content = { x: second.left + 200, y: second.top + 300 };
    const offset = { x: 640, y: 450 };
    const anchor = anchorForContentPoint(items, content, zoom0, offset);
    expect(anchor).toEqual({ itemIndex: 1, pagePoint: { x: 200, y: 300 }, offset });

    // Zoom to 2× — the layout is rebuilt; re-scrolling must put (200, 300) of page 2 at `offset`.
    const zoom1 = 2;
    const items2 = layoutPages([{ dimensions: A4 }, { dimensions: A4 }, { dimensions: A4 }], {
      zoom: zoom1,
      gap: PAGE_GAP,
      padding: VIEWER_PADDING,
      containerWidth: 1200,
    }).items;
    const scroll = scrollForAnchor(items2, anchor!, zoom1)!;
    const second2 = items2[1]!;
    expect(scroll.x + offset.x).toBeCloseTo(second2.left + 200 * zoom1);
    expect(scroll.y + offset.y).toBeCloseTo(second2.top + 300 * zoom1);
  });

  it('returns null without a layout item to anchor on', () => {
    expect(anchorForContentPoint([], { x: 0, y: 0 }, 1, { x: 0, y: 0 })).toBeNull();
    expect(scrollForAnchor(items, { itemIndex: 7, pagePoint: { x: 0, y: 0 }, offset: { x: 0, y: 0 } }, 1)).toBeNull();
  });
});

describe('touchpad pinch (Ctrl + wheel)', () => {
  it('gives a pinch its own scale back', () => {
    // Chromium sends a pinch of scale s as deltaY = −100 · ln(s).
    for (const scale of [1.02, 1.1, 0.9, 0.97]) expect(Math.exp(wheelPinchLog(-100 * Math.log(scale)))).toBeCloseTo(scale, 6);
  });

  it('tells a mouse wheel notch from a step of a pinch', () => {
    expect(isWheelNotch(-4)).toBe(false);
    expect(isWheelNotch(12.5)).toBe(false);
    expect(isWheelNotch(-100)).toBe(true);
    expect(isWheelNotch(120)).toBe(true);
    expect(isWheelNotch(-3, 1)).toBe(true);
    expect(isWheelNotch(1, 2)).toBe(true);
  });

  it('ignores nonsense', () => {
    expect(wheelPinchLog(Number.NaN)).toBe(0);
    expect(feltPinchLog(Number.NaN)).toBe(0);
    expect(feltPinchScale(0)).toBe(1);
  });
});

describe('how a pinch feels (the zoom settings)', () => {
  const feel = (pinchSpeed: number, pinchThreshold: number) => ({ ...NATURAL_ZOOM, pinchSpeed, pinchThreshold });

  it('follows the fingers exactly by default', () => {
    for (const scale of [0.5, 0.9, 1, 1.3, 2]) expect(feltPinchScale(scale)).toBeCloseTo(scale, 9);
  });

  it('goes further, or less far, for the same pinch with the speed', () => {
    expect(feltPinchScale(1.2, feel(2, 0))).toBeCloseTo(1.44, 9);
    expect(feltPinchScale(1.44, feel(0.5, 0))).toBeCloseTo(1.2, 9);
    // In and out mirror each other.
    expect(feltPinchScale(1 / 1.2, feel(2, 0))).toBeCloseTo(1 / 1.44, 9);
  });

  it('does nothing inside the threshold, then carries on from there without a jump', () => {
    const f = feel(1, 0.1);
    expect(feltPinchScale(1.05, f)).toBe(1);
    expect(feltPinchScale(1 / 1.05, f)).toBe(1);
    expect(feltPinchScale(1.1, f)).toBeCloseTo(1, 9);
    expect(feltPinchScale(1.1 * 1.2, f)).toBeCloseTo(1.2, 9);
    expect(feltPinchScale(1 / (1.1 * 1.2), f)).toBeCloseTo(1 / 1.2, 9);
  });

  it('a pinch on the screen follows the settings too', () => {
    const start = pinchStart({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
    expect(pinchUpdate(start, { x: 0, y: 0 }, { x: 150, y: 0 }).zoom).toBe(1.5);
    expect(pinchUpdate(start, { x: 0, y: 0 }, { x: 150, y: 0 }, undefined, undefined, feel(2, 0)).zoom).toBe(2.25);
    expect(pinchUpdate(start, { x: 0, y: 0 }, { x: 104, y: 0 }, undefined, undefined, feel(1, 0.05)).zoom).toBe(1);
  });
});
