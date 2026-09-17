import { describe, expect, it } from 'vitest';
import { A4_DIMENSIONS, MIN_IMAGE_SIZE } from '../constants';
import {
  addImage,
  bringToFront,
  createImageLayer,
  dataUrlToBytes,
  handlePositions,
  imageCenter,
  moveImage,
  pointInImage,
  removeImage,
  resizeImage,
  rotationFromPointer,
  sendToBack,
  toLocalDelta,
} from '../media';
import type { ImageLayer } from '../types';

const base: ImageLayer = {
  id: 'a',
  src: 'data:image/png;base64,AAAA',
  mime: 'image/png',
  x: 100,
  y: 100,
  width: 200,
  height: 100,
  rotation: 0,
  zIndex: 1,
  naturalWidth: 400,
  naturalHeight: 200,
};

describe('createImageLayer', () => {
  it('fits large images to 60 % of the page width, centred', () => {
    const img = createImageLayer({ src: 'x', mime: 'image/png', naturalWidth: 4000, naturalHeight: 2000, page: A4_DIMENSIONS, zIndex: 1 });
    expect(img.width).toBeCloseTo(A4_DIMENSIONS.width * 0.6);
    expect(img.height).toBeCloseTo(img.width / 2);
    expect(imageCenter(img)).toEqual({ x: A4_DIMENSIONS.width / 2, y: A4_DIMENSIONS.height / 2 });
  });

  it('keeps small images at natural size and honours the drop point', () => {
    const img = createImageLayer({ src: 'x', mime: 'image/png', naturalWidth: 120, naturalHeight: 80, page: A4_DIMENSIONS, at: { x: 300, y: 400 }, zIndex: 3 });
    expect(img).toMatchObject({ width: 120, height: 80, x: 240, y: 360, zIndex: 3 });
  });
});

describe('resizeImage', () => {
  it('east handle keeps the west edge fixed and preserves aspect by default', () => {
    const next = resizeImage(base, 'e', 50, 0, true);
    expect(next.x).toBe(100);
    expect(next.width).toBe(250);
    expect(next.height).toBe(125);
    expect(imageCenter(next).y).toBe(150); // grew symmetrically about the anchor edge midpoint
  });

  it('free transform when aspect is not kept', () => {
    const next = resizeImage(base, 'se', 50, -30, false);
    expect(next).toMatchObject({ x: 100, y: 100, width: 250, height: 70 });
  });

  it('never shrinks below the minimum size', () => {
    const next = resizeImage(base, 'nw', 1000, 1000, false);
    expect(next.width).toBe(MIN_IMAGE_SIZE);
    expect(next.height).toBe(MIN_IMAGE_SIZE);
    // Anchor (south-east corner) stays put.
    expect(next.x + next.width).toBeCloseTo(300);
    expect(next.y + next.height).toBeCloseTo(200);
  });

  it('rotated boxes keep the opposite corner anchored in world space', () => {
    const rotated = { ...base, rotation: 30 };
    const before = handlePositions(rotated).nw;
    const next = resizeImage(rotated, 'se', 40, 20, false);
    const after = handlePositions(next).nw;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(next.width).toBe(240);
    expect(next.height).toBe(120);
  });

  it('toLocalDelta undoes the rotation', () => {
    const local = toLocalDelta({ ...base, rotation: 90 }, 0, 10);
    expect(local.x).toBeCloseTo(10);
    expect(local.y).toBeCloseTo(0);
  });
});

describe('rotation / hit testing / moving', () => {
  it('rotationFromPointer measures from the top handle, with optional snapping', () => {
    expect(rotationFromPointer(base, { x: 200, y: 0 })).toBeCloseTo(0);
    expect(rotationFromPointer(base, { x: 400, y: 150 })).toBeCloseTo(90);
    expect(rotationFromPointer(base, { x: 400, y: 160 }, 15)).toBe(90);
  });

  it('pointInImage respects rotation', () => {
    expect(pointInImage(base, { x: 150, y: 150 })).toBe(true);
    expect(pointInImage(base, { x: 310, y: 150 })).toBe(false);
    // Corner of the unrotated box is outside once rotated 45°.
    expect(pointInImage({ ...base, rotation: 45 }, { x: 101, y: 101 })).toBe(false);
  });

  it('moveImage translates immutably', () => {
    const moved = moveImage(base, 5, -5);
    expect(moved).toMatchObject({ x: 105, y: 95 });
    expect(base.x).toBe(100);
    expect(moveImage(base, 0, 0)).toBe(base);
  });
});

describe('z-order lists', () => {
  const list = addImage(addImage(addImage([], base), { ...base, id: 'b' }), { ...base, id: 'c' });

  it('adds with increasing z and normalises to 1..n', () => {
    expect(list.map((i) => `${i.id}:${i.zIndex}`)).toEqual(['a:1', 'b:2', 'c:3']);
  });

  it('bringToFront / sendToBack reorder and renumber', () => {
    expect(bringToFront(list, 'a').map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(sendToBack(list, 'c').map((i) => `${i.id}:${i.zIndex}`)).toEqual(['c:1', 'a:2', 'b:3']);
    expect(bringToFront(list, 'missing').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('removeImage renumbers the rest', () => {
    expect(removeImage(list, 'b').map((i) => `${i.id}:${i.zIndex}`)).toEqual(['a:1', 'c:2']);
  });
});

describe('dataUrlToBytes', () => {
  it('decodes base64 data URLs with their MIME type', () => {
    const decoded = dataUrlToBytes('data:image/png;base64,iVBORw0KGgo=');
    expect(decoded?.mime).toBe('image/png');
    expect([...(decoded?.bytes ?? [])].slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(dataUrlToBytes('nope')).toBeNull();
  });
});
