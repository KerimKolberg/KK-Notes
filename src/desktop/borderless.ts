/**
 * "Fullscreen" without Windows' fullscreen.
 *
 * The native fullscreen is a borderless window resized to cover the whole monitor. To
 * Windows that is a window it can present directly — no compositing, the "independent
 * flip" that games get — and on the ROG Flow Z13 that is where the trouble was: with
 * everything else the same, the mouse pointer lagged the hand and blinked in
 * fullscreen and not in a maximised window, while the pen, which Windows draws
 * differently, was fine. Windows composites a window that does *not* cover the whole
 * monitor, so this style takes the title bar off and fills the space a maximised
 * window would — the monitor less the taskbar — and leaves the last row of pixels
 * alone so that a window on a monitor with an auto-hidden taskbar (whose work area is
 * the whole monitor) is not eligible either.
 */

/** The parts of Tauri's `Monitor` this needs, in physical pixels. */
export interface MonitorFrame {
  readonly position: { readonly x: number; readonly y: number };
  readonly size: { readonly width: number; readonly height: number };
  readonly workArea?: {
    readonly position: { readonly x: number; readonly y: number };
    readonly size: { readonly width: number; readonly height: number };
  };
}

export interface BorderlessFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Physical pixels left unused along the bottom edge, so the window never quite covers the monitor. */
export const BORDERLESS_GAP_PX = 1;

/**
 * Where the borderless window goes: the monitor's work area if it reports one, else
 * the monitor itself, less the gap. `null` for a monitor that reports nothing usable,
 * where the caller should use the native fullscreen instead.
 */
export function borderlessFrame(monitor: MonitorFrame): BorderlessFrame | null {
  const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
  const { width, height } = area.size;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200) return null;
  return { x: area.position.x, y: area.position.y, width, height: height - BORDERLESS_GAP_PX };
}
