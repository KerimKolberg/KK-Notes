/**
 * Whether ink canvases ask the browser for a low-latency surface.
 *
 * `desynchronized: true` lets Chromium present a canvas outside the compositor's
 * vsync pipeline, which can save up to a frame of pen-to-ink latency. The price is
 * that on Windows it does so through the GPU's *overlay hardware*: a limited
 * number of planes that also carry the mouse cursor, sit under anything
 * translucent drawn over them, and are shared between every desynchronized canvas
 * on screen. Two pages of them, a floating toolbar above and a fullscreen window
 * is more than some GPUs can juggle, and what that looks like from the chair is a
 * page going black, a cursor that flickers and a toolbar that lags when moved.
 *
 * So it is a switch, off by default, rather than a decision made for every
 * machine: only the device in your hand can say which side of that line it is on.
 *
 * Its own module, and free of imports, so the drawing code can read it without
 * depending on where preferences are stored — and the store can set it without
 * depending on the drawing code.
 *
 * A canvas's attributes are fixed by its *first* `getContext` call, so flipping
 * this affects canvases created afterwards. The page layer remounts its surface
 * when the preference changes, which is what makes the switch take effect
 * immediately rather than after a restart.
 */
let lowLatency = false;

export function setLowLatencyCanvas(enabled: boolean): void {
  lowLatency = enabled;
}

export function lowLatencyCanvas(): boolean {
  return lowLatency;
}

/** The 2D context attributes for an on-screen ink canvas, under the current mode. */
export function inkContextAttributes(): CanvasRenderingContext2DSettings {
  return lowLatency ? { alpha: true, desynchronized: true } : { alpha: true };
}
