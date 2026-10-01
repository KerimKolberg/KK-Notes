import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for the Tauri window that records what it is asked to do, in order. */
function fakeWindow(state: { maximized: boolean; fullscreen: boolean }) {
  const calls: string[] = [];
  const win = {
    isMaximized: async () => state.maximized,
    isFullscreen: async () => state.fullscreen,
    outerPosition: async () => ({ x: 120, y: 80 }),
    outerSize: async () => ({ width: 1400, height: 900 }),
    unmaximize: async () => {
      calls.push('unmaximize');
      state.maximized = false;
    },
    maximize: async () => {
      calls.push('maximize');
      state.maximized = true;
    },
    setDecorations: async (on: boolean) => void calls.push(`decorations ${on}`),
    setPosition: async (p: { x: number; y: number }) => void calls.push(`position ${p.x},${p.y}`),
    setSize: async (s: { width: number; height: number }) => void calls.push(`size ${s.width}x${s.height}`),
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
    expect(current.calls).toEqual(['unmaximize', 'decorations false', 'position 0,0', 'size 2560x1551']);
  });

  it('puts a maximised window back maximised, with its title bar', async () => {
    current = fakeWindow({ maximized: true, fullscreen: false });
    const { toggleFullscreen } = await service();
    await toggleFullscreen();
    current.calls.length = 0;
    expect(await toggleFullscreen()).toBe(false);
    expect(current.calls).toEqual(['decorations true', 'maximize']);
  });

  it('puts a window that was not maximised back where it was, and as big', async () => {
    current = fakeWindow({ maximized: false, fullscreen: false });
    const { toggleFullscreen } = await service();
    await toggleFullscreen();
    current.calls.length = 0;
    await toggleFullscreen();
    expect(current.calls).toEqual(['decorations true', 'size 1400x900', 'position 120,80']);
  });

  it('falls back to the platform fullscreen when the monitor says nothing usable', async () => {
    monitor = null;
    current = fakeWindow({ maximized: true, fullscreen: false });
    const { toggleFullscreen } = await service();
    expect(await toggleFullscreen()).toBe(true);
    expect(current.calls).toEqual(['fullscreen true']);
  });
});
