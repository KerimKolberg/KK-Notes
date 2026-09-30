import { describe, expect, it } from 'vitest';
import { MAX_CURSOR_PX, MIN_CURSOR_PX, eraserCursor } from '../engine/cursor';

const svgOf = (css: string): string => decodeURIComponent(/url\("data:image\/svg\+xml,([^"]+)"\)/.exec(css)?.[1] ?? '');
const sizeOf = (css: string): number => Number(/width='(\d+)'/.exec(svgOf(css))?.[1]);
const hotspot = (css: string): [number, number] => {
  const m = /"\)\s+(\d+)\s+(\d+),/.exec(css);
  return [Number(m?.[1]), Number(m?.[2])];
};

describe('the eraser cursor', () => {
  it('is a cursor image with the system crosshair behind it', () => {
    const css = eraserCursor(24) ?? '';
    expect(css.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(css.endsWith(', crosshair')).toBe(true);
  });

  it('has its hot spot at the centre of the ring', () => {
    for (const d of [8, 16, 33, 96]) {
      const css = eraserCursor(d) ?? '';
      const size = sizeOf(css);
      expect(hotspot(css)).toEqual([size / 2, size / 2]);
    }
  });

  it('is as wide as the eraser plus room for its edge', () => {
    const css = eraserCursor(40) ?? '';
    expect(sizeOf(css)).toBeGreaterThanOrEqual(40);
    expect(sizeOf(css)).toBeLessThan(40 + 12);
    expect(svgOf(css)).toContain("r='20'");
  });

  it('is drawn no smaller than a ring you can see', () => {
    const css = eraserCursor(2) ?? '';
    expect(svgOf(css)).toContain(`r='${MIN_CURSOR_PX / 2}'`);
  });

  it('gives way to the drawn ring when the eraser is too big for a cursor image', () => {
    expect(eraserCursor(MAX_CURSOR_PX)).not.toBeNull();
    expect(eraserCursor(MAX_CURSOR_PX + 1)).toBeNull();
    expect(eraserCursor(Number.NaN)).toBeNull();
    expect(eraserCursor(0)).toBeNull();
    expect(eraserCursor(-4)).toBeNull();
  });

  it('is an even size, so the centre is on a whole pixel', () => {
    for (const d of [11, 17, 25, 59]) expect(sizeOf(eraserCursor(d) ?? '') % 2).toBe(0);
  });
});
