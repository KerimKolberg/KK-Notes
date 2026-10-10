import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A stand-in for the Tauri window that records what it is asked to do, in order. `frame` is the invisible frame
 * Windows counts round a window: its inside is that far in from where the window is placed.
 */
function fakeWindow(state: { maximized: boolean; fullscreen: boolean }, frame = { left: 0, top: 0 }) {
  const calls: string[] = [];
  let outer = { x: 120, y: 80 };
  let inside = { width: 1400, height: 900 };
  const win = {
    isMaximized: async () => state.maximized,
    isFullscreen: async () => state.fullscreen,
    outerPosition: async () => outer,
    innerPosition: async () => ({ x: outer.x + frame.left, y: outer.y + frame.top }),
    innerSize: async () => inside,
    unmaximize: async () => {
      calls.push('unmaximize');
      state.maximized = false;
    },
    maximize: async () => {
      calls.push('maximize');
      state.maximized = true;
    },
    setDecorations: async (on: boolean) => void calls.push(`decorations ${on}`),
    setShadow: async (on: boolean) => void calls.push(`shadow ${on}`),
    setPosition: async (p: { x: number; y: number }) => {
      calls.push(`position ${p.x},${p.y}`);
      outer = { x: p.x, y: p.y };
    },
    setSize: async (s: { width: number; height: number }) => {
      calls.push(`size ${s.width}x${s.height}`);
      inside = { width: s.width, height: s.height };
    },
    setFullscreen: async (on: boolean) => {
      calls.push(`fullscreen ${on}`);
      state.fullscreen = on;
    },
  };
  return { win, calls };
}

let monitor: unknown = null;
let current = fakeWindow({ maximized: false, fullscreen: false });

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => current.win,
  currentMonitor: async () => monitor,
}));
vi.mock('@tauri-apps/api/dpi', () => ({
  PhysicalPosition: class {
    constructor(readonly x: number, readonly y: number) {}
  },
  PhysicalSize: class {
    constructor(readonly width: number, readonly height: number) {}
  },
}));

const WORK = { position: { x: 0, y: 0 }, size: { width: 2560, height: 1552 } };

async function service() {
  vi.resetModules();
  return import('../fileService');
}

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  monitor = { position: { x: 0, y: 0 }, size: { width: 2560, height: 1600 }, workArea: WORK };
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('fullscreen on the desktop', () => {
  it('takes the title bar off and fills the work area, from a maximised window', async () => {
    current = fakeWindow({ maximized: true, fullscreen: false });
    const { toggleFullscreen } = await service();
    expect(await toggleFullscreen()).toBe(true);
    // A maximised window ignores being placed, so it lets go of that first.
    expect(current.calls).toEqual(['unmaximize', 'decorations false', 'shadow false', 'position 0,0', 'size 2560x1551']);
  });

  it('moves the window by the invisible frame Windows counts round it, so its inside fills the work area', async () => {
    // As reported on the Flow Z13 at 150 %: the desktop showing down the left and along the top, the right off screen.
    current = fakeWindow({ maximized: true, fullscreen: false }, { left: 12, top: 2 });
    const { toggleFullscreen } = await service();
    expect(await toggleFullscreen()).toBe(true);
    expect(current.calls).toEqual(['unmaximize', 'decorations false', 'shadow false', 'position 0,0', 'size 2560x1551', 'position -12,-2']);
    expect(await current.win.innerPosition()).toEqual({ x: 0, y: 0 });
  });

  it('puts a maximised window back maximised, with its title bar', async () => {
    current = fakeWindow({ maximized: true, fullscreen: false });
    const { toggleFullscreen } = await service();
    await toggleFullscreen();
    current.calls.length = 0;
    expect(await toggleFullscreen()).toBe(false);
    expect(current.calls).toEqual(['decorations true', 'shadow true', 'maximize']);
  });

  it('puts a window that was not maximised back where it was, and as big', async () => {
    current = fakeWindow({ maximized: false, fullscreen: false });
    const { toggleFullscreen } = await service();
    await toggleFullscreen();
    current.calls.length = 0;
    await toggleFullscreen();
    expect(current.calls).toEqual(['decorations true', 'shadow true', 'size 1400x900', 'position 120,80']);
  });

  it('is the platform fullscreen, over the taskbar, when that is the style', async () => {
    current = fakeWindow({ maximized: true, fullscreen: false });
    const { toggleFullscreen } = await service();
    expect(await toggleFullscreen('screen')).toBe(true);
    expect(current.calls).toEqual(['fullscreen true']);
    expect(await toggleFullscreen('screen')).toBe(false);
    expect(current.calls).toEqual(['fullscreen true', 'fullscreen false']);
  });

  it('turns off whichever is on, whatever the style says by then', async () => {
    current = fakeWindow({ maximized: true, fullscreen: false });
    const { toggleFullscreen } = await service();
    await toggleFullscreen('window');
    current.calls.length = 0;
    // The setting was changed while the borderless window was up.
    expect(await toggleFullscreen('screen')).toBe(false);
    expect(current.calls).toEqual(['decorations true', 'shadow true', 'maximize']);
  });

  it('falls back to the platform fullscreen when the monitor says nothing usable', async () => {
    monitor = null;
    current = fakeWindow({ maximized: true, fullscreen: false });
    const { toggleFullscreen } = await service();
    expect(await toggleFullscreen()).toBe(true);
    expect(current.calls).toEqual(['fullscreen true']);
  });
});
