import { describe, expect, it } from 'vitest';
import {
  BARREL_CLICK_MS,
  IDLE_BARREL,
  barrelCancel,
  barrelDown,
  barrelTick,
  barrelUp,
  toggleTool,
  type BarrelState,
} from '../engine/barrelButton';

/** Press at `t`, release at `t + held`, with ticks along the way. */
function press(held: number, holdTool = 'lasso' as const, currentTool = 'pen' as const) {
  const actions: string[] = [];
  let state: BarrelState = IDLE_BARREL;
  let tool: string = currentTool;
  const record = (step: { state: BarrelState; action: { kind: string; tool?: string } }): void => {
    state = step.state;
    if (step.action.kind !== 'none') actions.push(step.action.kind);
    if (step.action.kind === 'hold-start' || step.action.kind === 'hold-end') tool = step.action.tool!;
  };

  record(barrelDown(state, 0));
  // A timer fires at the threshold; simulate it only if the press lasts that long.
  if (held >= BARREL_CLICK_MS) record(barrelTick(state, BARREL_CLICK_MS, holdTool, tool as typeof currentTool));
  record(barrelUp(state, held));
  return { actions, state, tool };
}

describe('telling a click from a hold', () => {
  it('uses 300ms as the line between them', () => {
    expect(BARREL_CLICK_MS).toBe(300);
  });

  it('calls a quick press a click', () => {
    expect(press(120).actions).toEqual(['click']);
    expect(press(0).actions).toEqual(['click']);
    // Right up to the threshold.
    expect(press(BARREL_CLICK_MS - 1).actions).toEqual(['click']);
  });

  it('calls a long press a hold, and gives the tool back', () => {
    const { actions, tool } = press(900);
    expect(actions).toEqual(['hold-start', 'hold-end']);
    // Borrowed the lasso, handed the pen back.
    expect(tool).toBe('pen');
  });

  it('treats exactly the threshold as a hold, not a click', () => {
    expect(press(BARREL_CLICK_MS).actions).toEqual(['hold-start', 'hold-end']);
  });

  it('lands back at idle either way', () => {
    expect(press(50).state).toEqual(IDLE_BARREL);
    expect(press(5000).state).toEqual(IDLE_BARREL);
  });
});

describe('the hold', () => {
  it('borrows the tool at the threshold, not on release', () => {
    // The whole point of the timer: the tool has to appear under the hand
    // while the button is still down.
    let state = barrelDown(IDLE_BARREL, 0).state;
    const early = barrelTick(state, 100, 'lasso', 'pen');
    expect(early.action.kind).toBe('none');
    expect(early.state.phase).toBe('pending');

    const late = barrelTick(state, 400, 'lasso', 'pen');
    expect(late.action).toEqual({ kind: 'hold-start', tool: 'lasso', restore: 'pen' });
    expect(late.state.phase).toBe('held');
    state = late.state;

    expect(barrelUp(state, 900).action).toEqual({ kind: 'hold-end', tool: 'pen' });
  });

  it('remembers whatever tool was active, not a fixed one', () => {
    const state = barrelDown(IDLE_BARREL, 0).state;
    const held = barrelTick(state, 400, 'laser-pointer', 'highlighter');
    expect(held.action).toEqual({ kind: 'hold-start', tool: 'laser-pointer', restore: 'highlighter' });
    expect(barrelUp(held.state, 800).action).toEqual({ kind: 'hold-end', tool: 'highlighter' });
  });

  it('does nothing when the hold tool is already the active one', () => {
    // Nothing to borrow and nothing to give back; holding must not leave the
    // user somewhere they did not start.
    const state = barrelDown(IDLE_BARREL, 0).state;
    const held = barrelTick(state, 400, 'lasso', 'lasso');
    expect(held.action.kind).toBe('none');
    expect(held.state.phase).toBe('held');
    expect(barrelUp(held.state, 900).action.kind).toBe('none');
  });

  it('is a hold even when no tick ever ran', () => {
    // A caller with no timer still must not turn a two-second press into a
    // tool swap the user never asked for.
    const state = barrelDown(IDLE_BARREL, 0).state;
    expect(barrelUp(state, 2000).action.kind).toBe('none');
  });

  it('only ticks while a press is pending', () => {
    expect(barrelTick(IDLE_BARREL, 999, 'lasso', 'pen').action.kind).toBe('none');
    const held = barrelTick(barrelDown(IDLE_BARREL, 0).state, 400, 'lasso', 'pen').state;
    // A second tick must not borrow twice.
    expect(barrelTick(held, 800, 'lasso', 'lasso').action.kind).toBe('none');
  });
});

describe('gestures that do not end cleanly', () => {
  it('gives a borrowed tool back when the pen leaves range', () => {
    const held = barrelTick(barrelDown(IDLE_BARREL, 0).state, 400, 'lasso', 'pen').state;
    const cancelled = barrelCancel(held);
    expect(cancelled.action).toEqual({ kind: 'hold-end', tool: 'pen' });
    expect(cancelled.state).toEqual(IDLE_BARREL);
  });

  it('drops a pending press without turning it into a click', () => {
    // We never saw it end, so we do not know it was a click — and swapping
    // the user's tool because their pen wandered out of range is worse than
    // doing nothing.
    const pending = barrelDown(IDLE_BARREL, 0).state;
    const cancelled = barrelCancel(pending);
    expect(cancelled.action.kind).toBe('none');
    expect(cancelled.state).toEqual(IDLE_BARREL);
  });

  it('ignores a release it never saw pressed', () => {
    expect(barrelUp(IDLE_BARREL, 100).action.kind).toBe('none');
  });

  it('restarts rather than stacking on a repeated press', () => {
    // Drivers do drop events; a second down must not leave the machine
    // thinking two buttons are held.
    const first = barrelDown(IDLE_BARREL, 0).state;
    const second = barrelDown(first, 500).state;
    expect(second.phase).toBe('pending');
    expect(second.pressedAt).toBe(500);
    // Measured from the *second* press, so this is still a click.
    expect(barrelUp(second, 600).action.kind).toBe('click');
  });

  it('leaves a hold alone when a stray press arrives', () => {
    const held = barrelTick(barrelDown(IDLE_BARREL, 0).state, 400, 'lasso', 'pen').state;
    expect(barrelDown(held, 500).state).toBe(held);
  });
});

describe('what a click toggles to', () => {
  const pair = ['pen', 'eraser-stroke'] as const;

  it('swaps between the configured pair', () => {
    expect(toggleTool('pen', pair)).toBe('eraser-stroke');
    expect(toggleTool('eraser-stroke', pair)).toBe('pen');
  });

  it('goes to the second tool from anywhere else', () => {
    // The second slot is the one people configure as the thing they reach
    // for, so that is the useful direction out of a third tool.
    expect(toggleTool('highlighter', pair)).toBe('eraser-stroke');
    expect(toggleTool('lasso', pair)).toBe('eraser-stroke');
    // And the click after brings you back to the first.
    expect(toggleTool(toggleTool('highlighter', pair), pair)).toBe('pen');
  });

  it('honours a pair the user configured differently', () => {
    const custom = ['highlighter', 'lasso'] as const;
    expect(toggleTool('highlighter', custom)).toBe('lasso');
    expect(toggleTool('lasso', custom)).toBe('highlighter');
    expect(toggleTool('pen', custom)).toBe('lasso');
  });

  it('copes with a pair of the same tool', () => {
    // Nothing useful, but it must not loop or throw.
    expect(toggleTool('pen', ['pen', 'pen'])).toBe('pen');
  });
});
