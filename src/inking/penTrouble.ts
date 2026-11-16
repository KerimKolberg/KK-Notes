/**
 * Saying why the pen wrote nothing, when it is the pen's own buttons. A pen that reports its side button held
 * (pressed by the grip, or stuck) erases instead of writing, as the "Barrel hold" setting says it should; over
 * empty paper that erases nothing and shows nothing, which looks exactly like a pen that stopped working (found
 * looking into a report from the Flow Z13: the pen chose tools on the toolbar but drew nothing, the mouse drew).
 *
 * A small subscription, like the measure read-out, so the ink loop does not depend on the app's notices.
 */
import type { ToolType } from './types';

/** Tools that put writing on the page: a stroke meant for one of these that erased nothing was not meant. */
const WRITING: ReadonlySet<ToolType> = new Set<ToolType>(['pen', 'highlighter', 'washi-tape', 'line', 'coordinate-plane']);
/** Two strokes in a row is a pattern; one is someone using the button on purpose and missing. */
const MISSES_TO_SAY = 2;

type Listener = (message: string) => void;
const listeners = new Set<Listener>();
let misses = 0;

export function subscribePenTrouble(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function say(message: string): void {
  for (const listener of listeners) listener(message);
}

/**
 * A pen stroke has ended. `selected` is the toolbar's tool, `used` what the stroke was, `byButton` whether a pen
 * button made it that, and `erased` whether it took anything away (`null`: cannot tell).
 */
export function notePenStroke(selected: ToolType, used: ToolType, byButton: boolean, erased: boolean | null): void {
  const erasing = used === 'eraser-stroke' || used === 'eraser-pixel';
  if (!byButton || !erasing || !WRITING.has(selected) || erased === true) {
    misses = 0;
    return;
  }
  misses += 1;
  if (misses < MISSES_TO_SAY) return;
  misses = 0;
  say("The pen's side button is held, so it erases instead of writing. Let go of the button to write. What it does is under the toolbar's settings: Barrel hold.");
}

/** A pen came down with buttons that no tool is set for: nothing happens, and that is said. */
export function notePenIgnored(buttons: number): void {
  misses = 0;
  say(`The pen touched the page with a button held that no tool is set for (buttons ${buttons}), so nothing was drawn. Let go of the pen's buttons to write.`);
}

/** For tests. */
export function resetPenTrouble(): void {
  misses = 0;
}
