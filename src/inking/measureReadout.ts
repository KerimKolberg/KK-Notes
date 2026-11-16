/**
 * What a tool measures while it is being used — a line's angles and length, a ruler line's length, how far a
 * selection is being turned — said away from the pen.
 *
 * These read-outs used to be drawn on the page beside the line being drawn, which is exactly where the writer is
 * looking: on a busy PDF page they sat on top of the writing and the words around it (reported on the Flow Z13).
 * Now the page keeps only the thin angle arcs, which say *which* angle is meant, and the numbers go to one place
 * beside the toolbar (`MeasureReadout`).
 *
 * Not a store: the ink loop writes here once an animation frame while a line is drawn, and a React state update at
 * that rate would re-render for nothing. The read-out writes its text straight into its element instead.
 */

export interface MeasureReading {
  /** Each item is one figure: "θ 35.0°", "∠ 90.0°", "4.2 cm". */
  readonly items: readonly string[];
}

type Listener = (reading: MeasureReading | null) => void;

const listeners = new Set<Listener>();
let current: MeasureReading | null = null;
let currentKey = '';

/** Say what is being measured now, or `null` (or no items) when nothing is. Repeats of the same reading are free. */
export function setMeasureReading(items: readonly string[] | null): void {
  const next = items && items.length > 0 ? { items } : null;
  const key = next ? next.items.join('\u0000') : '';
  if (key === currentKey) return;
  currentKey = key;
  current = next;
  for (const listener of listeners) listener(current);
}

export function getMeasureReading(): MeasureReading | null {
  return current;
}

export function subscribeMeasureReading(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
