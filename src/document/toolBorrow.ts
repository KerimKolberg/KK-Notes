/**
 * Keeping a lasso that a pen button took, until what it selected is done with.
 *
 * A pen button can *borrow* a tool: hold it, and the pen erases or lassos; let go,
 * and the pen is what it was. For an eraser that is the whole story. For the lasso
 * it is not, because the lasso does not end when the loop is closed — it leaves a
 * selection, with handles and a toolbar, and the selection only exists while the
 * lasso tool is the active one. Hand the tool back the moment the button comes up
 * (which is almost always straight after the loop, or before it) and the selection
 * is cleared with it: the button "selected something" that was never shown.
 *
 * So a borrowed lasso is kept while there is a selection, and handed back when
 * there is not — when the selection is dismissed (Escape, Deselect, delete, a tap
 * outside it) or a loop selects nothing. The user picking some other tool in the
 * meantime settles it too: they have said what they want.
 *
 * Module-level, like the barrel gesture that feeds it, because the pen can cross
 * from one page to the next in the middle of it.
 */
import type { ToolType } from '../inking/types';
import { useDocumentStore } from './store';
import { useToolStore } from './toolStore';

/** Tools that leave something behind that only lives while they are active. */
export function isSelectionTool(tool: ToolType): boolean {
  return tool === 'lasso';
}

interface Pending {
  /** The tool a button took. */
  readonly tool: ToolType;
  /** What to give back when it is done with. */
  readonly previous: ToolType;
}

let pending: Pending | null = null;
let penDown = false;
let unwatch: Array<() => void> = [];

function hasSelection(): boolean {
  return useDocumentStore.getState().lassoSelection !== null;
}

function forget(): void {
  pending = null;
  for (const stop of unwatch) stop();
  unwatch = [];
}

function giveBack(): void {
  if (!pending) return;
  const { tool, previous } = pending;
  forget();
  const store = useToolStore.getState();
  if (store.settings.tool === tool) store.update({ tool: previous });
}

/**
 * Decide what a borrowed lasso does now: nothing while the pen is down or a
 * selection is up, and go back to what it was otherwise.
 */
export function settleBorrowedTool(): void {
  if (!pending || penDown) return;
  if (useToolStore.getState().settings.tool !== pending.tool) {
    // Something else was chosen: nothing left to hand back.
    forget();
    return;
  }
  if (!hasSelection()) giveBack();
}

/** Whether a pen is on the screen. Fed by the window listeners below, and by tests. */
export function notePenContact(down: boolean): void {
  penDown = down;
}

function watch(): void {
  if (unwatch.length > 0) return;
  // A selection going away, or the tool being changed under it, is a reason to look again.
  unwatch.push(useDocumentStore.subscribe((state, previous) => {
    if (state.lassoSelection !== previous.lassoSelection) settleBorrowedTool();
  }));
  unwatch.push(useToolStore.subscribe((state, previous) => {
    if (state.settings.tool !== previous.settings.tool) settleBorrowedTool();
  }));
}

/**
 * The pen went down on a tool that is not the selected one because a button asked
 * for it — the second button, or the barrel with the tip on the page. Switch to it
 * and remember what to hand back.
 */
export function borrowSelectionTool(tool: ToolType): void {
  const store = useToolStore.getState();
  const previous = store.settings.tool;
  if (previous === tool || !isSelectionTool(tool)) return;
  // Called from the pen's pointerdown, so the pen is down whether or not the window
  // listener below has seen it yet — and the switch itself must not be settled away.
  penDown = true;
  pending = { tool, previous };
  watch();
  store.update({ tool });
}

/**
 * A button that borrowed `borrowed` was let go, and `previous` is what it took the
 * pen from. Anything but a selection tool goes straight back; a lasso stays while
 * it has something selected, or a loop still being drawn.
 */
export function handBackTool(borrowed: ToolType, previous: ToolType): void {
  if (borrowed !== previous && isSelectionTool(borrowed) && (penDown || hasSelection())) {
    pending = { tool: borrowed, previous };
    watch();
    return;
  }
  useToolStore.getState().update({ tool: previous });
}

/** Test seam: forget any borrowed tool and the pen's state. */
export function resetToolBorrow(): void {
  forget();
  penDown = false;
}

/** Whether a lasso is currently being held on to. */
export function borrowedToolPending(): boolean {
  return pending !== null;
}

// The pen lifting is the moment a loop has just become (or failed to become) a
// selection. The listeners are on the window, in the capture phase, so they see the
// pen come down and go up wherever it does — on a page, on a selection's handles,
// on the toolbar — and the settle waits a tick, so the surface's own handler has
// closed the loop before anyone looks for the selection it made.
if (typeof window !== 'undefined') {
  const isPen = (e: PointerEvent): boolean => e.pointerType === 'pen';
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (isPen(e)) penDown = true;
    },
    true,
  );
  const lifted = (e: PointerEvent): void => {
    if (!isPen(e)) return;
    penDown = false;
    if (pending) setTimeout(settleBorrowedTool, 0);
  };
  window.addEventListener('pointerup', lifted, true);
  window.addEventListener('pointercancel', lifted, true);
}
