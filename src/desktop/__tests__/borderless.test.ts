import { describe, expect, it } from 'vitest';
import { BORDERLESS_GAP_PX, borderlessFrame, placementCorrection } from '../borderless';

const monitor = { position: { x: 0, y: 0 }, size: { width: 2560, height: 1600 } };

describe('the borderless fullscreen frame', () => {
  it('fills the work area, so the taskbar keeps its place', () => {
    const frame = borderlessFrame({ ...monitor, workArea: { position: { x: 0, y: 0 }, size: { width: 2560, height: 1552 } } });
    expect(frame).toEqual({ x: 0, y: 0, width: 2560, height: 1552 - BORDERLESS_GAP_PX });
  });

  it('never quite covers the monitor, even with an auto-hidden taskbar (work area = monitor)', () => {
    const frame = borderlessFrame({ ...monitor, workArea: { position: { x: 0, y: 0 }, size: { width: 2560, height: 1600 } } });
    expect(frame).not.toBeNull();
    expect(frame?.height).toBeLessThan(monitor.size.height);
  });

  it('uses the monitor itself when it reports no work area', () => {
    expect(borderlessFrame(monitor)).toEqual({ x: 0, y: 0, width: 2560, height: 1600 - BORDERLESS_GAP_PX });
  });

  it('keeps the work area\'s own origin on a second monitor and beside a side taskbar', () => {
    const frame = borderlessFrame({
      position: { x: 2560, y: 0 },
      size: { width: 1920, height: 1080 },
      workArea: { position: { x: 2560 + 60, y: 0 }, size: { width: 1860, height: 1080 } },
    });
    expect(frame).toEqual({ x: 2620, y: 0, width: 1860, height: 1080 - BORDERLESS_GAP_PX });
  });

  it('gives up on a monitor that reports nothing usable, so the caller falls back', () => {
    expect(borderlessFrame({ position: { x: 0, y: 0 }, size: { width: 0, height: 0 } })).toBeNull();
    expect(borderlessFrame({ position: { x: 0, y: 0 }, size: { width: Number.NaN, height: 900 } })).toBeNull();
  });
});

describe('putting the inside of the window where it was asked for', () => {
  const frame = { x: 0, y: 0, width: 2560, height: 1551 };

  it('leaves a window that is there alone, a pixel either way included', () => {
    expect(placementCorrection(frame, { outer: { x: 0, y: 0 }, inner: { x: 0, y: 0 }, innerSize: { width: 2560, height: 1551 } })).toBeNull();
    expect(placementCorrection(frame, { outer: { x: 0, y: 0 }, inner: { x: 1, y: 0 }, innerSize: { width: 2559, height: 1551 } })).toBeNull();
  });

  it('moves it back by the invisible frame Windows counts round it', () => {
    // The Flow Z13 at 150 %: the inside 12 px in and 2 px down from where the window was put.
    const fix = placementCorrection(frame, { outer: { x: 0, y: 0 }, inner: { x: 12, y: 2 }, innerSize: { width: 2560, height: 1551 } });
    expect(fix).toEqual({ position: { x: -12, y: -2 }, size: false });
  });

  it('asks for the size again when it came out different', () => {
    const fix = placementCorrection(frame, { outer: { x: -12, y: -2 }, inner: { x: 0, y: 0 }, innerSize: { width: 2536, height: 1539 } });
    expect(fix).toEqual({ position: null, size: true });
  });

  it('works on a second monitor, wherever it is', () => {
    const second = { x: -1920, y: 200, width: 1920, height: 1039 };
    const fix = placementCorrection(second, { outer: { x: -1920, y: 200 }, inner: { x: -1909, y: 201 }, innerSize: { width: 1920, height: 1039 } });
    expect(fix).toEqual({ position: { x: -1931, y: 199 }, size: false });
  });
});
