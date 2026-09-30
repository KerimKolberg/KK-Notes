import { describe, expect, it } from 'vitest';
import { BORDERLESS_GAP_PX, borderlessFrame } from '../borderless';

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
