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
 *
 * It is one of two styles F11 can have (*Settings → Fullscreen*); the other is the
 * platform's own, which covers the taskbar too, for a PC whose pointer keeps up in it.
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

/** Where the window's inside (its client area, which is all there is to see of it without a title bar) actually is. */
export interface PlacedWindow {
  readonly outer: { readonly x: number; readonly y: number };
  readonly inner: { readonly x: number; readonly y: number };
  readonly innerSize: { readonly width: number; readonly height: number };
}

/** How far, in physical pixels, a placement may be off and still be where it was asked to go. */
const PLACEMENT_SLACK_PX = 1;

/**
 * What to move the window by so its inside lands on `frame`, or `null` when it is there already.
 *
 * Windows keeps an invisible resize frame around a window, about 8 px a side scaled by the display's scale (12 px at
 * 150 %), and counts it in the window's position even with the title bar off — so a window placed at the screen's
 * corner showed the desktop down its left side and at its top and ran off the right edge (reported on the Flow Z13).
 * Rather than guess the frame, the window is placed, where its inside went is read back, and it is moved by the
 * difference; a size that came out different is asked for again (`setSize` sets the inside's size).
 */
export function placementCorrection(
  frame: BorderlessFrame,
  placed: PlacedWindow,
): { readonly position: { readonly x: number; readonly y: number } | null; readonly size: boolean } | null {
  const dx = frame.x - placed.inner.x;
  const dy = frame.y - placed.inner.y;
  const moved = Math.abs(dx) > PLACEMENT_SLACK_PX || Math.abs(dy) > PLACEMENT_SLACK_PX;
  const resized =
    Math.abs(placed.innerSize.width - frame.width) > PLACEMENT_SLACK_PX || Math.abs(placed.innerSize.height - frame.height) > PLACEMENT_SLACK_PX;
  if (!moved && !resized) return null;
  return { position: moved ? { x: placed.outer.x + dx, y: placed.outer.y + dy } : null, size: resized };
}
