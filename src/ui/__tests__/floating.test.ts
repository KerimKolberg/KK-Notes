import { describe, expect, it } from 'vitest';
import { fixedPlacement } from '../floating';

const r = { left: 100, top: 500, right: 140, bottom: 540, width: 40, height: 40 };
const screen = { width: 400, height: 800 };

describe('a panel placed on the screen beside its trigger', () => {
  it('stands above it, a gap away, lined up with its middle or either edge', () => {
    expect(fixedPlacement('top', 'center', r, screen)).toEqual({ bottom: 800 - 500 + 8, left: 120 });
    expect(fixedPlacement('top', 'start', r, screen)).toEqual({ bottom: 308, left: 100 });
    expect(fixedPlacement('top', 'end', r, screen)).toEqual({ bottom: 308, right: 400 - 140 });
  });

  it('hangs below it for a toolbar at the top of the screen', () => {
    expect(fixedPlacement('bottom', 'center', r, screen)).toEqual({ top: 548, left: 120 });
  });

  it('opens beside it for a toolbar on a side, lined up down the screen', () => {
    expect(fixedPlacement('right', 'center', r, screen)).toEqual({ left: 148, top: 520 });
    expect(fixedPlacement('left', 'start', r, screen)).toEqual({ right: 400 - 100 + 8, top: 500 });
    expect(fixedPlacement('left', 'end', r, screen)).toEqual({ right: 308, bottom: 800 - 540 });
  });

  it('takes the gap it is given', () => {
    expect(fixedPlacement('top', 'center', r, screen, 0)).toEqual({ bottom: 300, left: 120 });
  });
});
