import { describe, expect, it } from 'vitest';
import { VIEWPORT_MARGIN, horizontalShift } from '../viewportClamp';
import { INSET_BRIDGE, applyAndroidInsets, parseBridgeInsets } from '../androidInsets';

/** A phone in portrait, which is where anchored panels actually run out of room. */
const PHONE = 412;

describe('keeping an anchored panel on screen', () => {
  it('leaves a panel that already fits exactly where it is', () => {
    expect(horizontalShift(100, 300, PHONE)).toBe(0);
    expect(horizontalShift(VIEWPORT_MARGIN, PHONE - VIEWPORT_MARGIN, PHONE)).toBe(0);
  });

  it('pulls a panel back in from either edge', () => {
    // A 280px flyout centred on a button near the right edge.
    expect(horizontalShift(200, 480, PHONE)).toBe(PHONE - VIEWPORT_MARGIN - 480);
    expect(horizontalShift(-40, 240, PHONE)).toBe(VIEWPORT_MARGIN + 40);
  });

  it('shifts by exactly enough, and no further', () => {
    const shift = horizontalShift(200, 480, PHONE);
    expect(480 + shift).toBe(PHONE - VIEWPORT_MARGIN);
    expect(horizontalShift(200 + shift, 480 + shift, PHONE)).toBe(0);
  });

  it('pins a panel wider than the viewport to the left edge', () => {
    // Nothing can make it fit; showing its beginning beats showing its middle.
    expect(horizontalShift(-100, 900, PHONE)).toBe(VIEWPORT_MARGIN + 100);
  });

  it('honours a custom margin', () => {
    expect(horizontalShift(200, 480, PHONE, 24)).toBe(PHONE - 24 - 480);
  });
});

describe('Android inset bridge', () => {
  it('parses the insets the activity hands over', () => {
    expect(parseBridgeInsets('{"top":48,"right":0,"bottom":32,"left":0}')).toEqual({
      top: 48,
      right: 0,
      bottom: 32,
      left: 0,
    });
  });

  it('rejects anything that is not four non-negative numbers', () => {
    expect(parseBridgeInsets('not json')).toBeNull();
    expect(parseBridgeInsets('null')).toBeNull();
    expect(parseBridgeInsets('[48, 0, 32, 0]')).toBeNull();
    expect(parseBridgeInsets('{"top":48,"right":0,"bottom":32}')).toBeNull();
    expect(parseBridgeInsets('{"top":"48","right":0,"bottom":32,"left":0}')).toBeNull();
    expect(parseBridgeInsets('{"top":-1,"right":0,"bottom":32,"left":0}')).toBeNull();
  });

  it('writes the custom properties index.css folds into --safe-*', () => {
    const written = new Map<string, string>();
    const root = { style: { setProperty: (name: string, value: string) => void written.set(name, value) } };
    applyAndroidInsets(root as unknown as HTMLElement, { top: 48, right: 0, bottom: 32, left: 0 });
    expect(Object.fromEntries(written)).toEqual({
      '--android-inset-top': '48px',
      '--android-inset-right': '0px',
      '--android-inset-bottom': '32px',
      '--android-inset-left': '0px',
    });
  });

  it('agrees with MainActivity on the name the bridge is registered under', () => {
    expect(INSET_BRIDGE).toBe('__notexInsets');
  });
});
