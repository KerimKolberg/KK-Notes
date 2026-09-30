import { describe, expect, it } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_DEFER_MS, AUTOSAVE_RECHECK_MS, nextAutosaveStep } from '../autosave';

describe('when a draft is written', () => {
  it('writes it straight away when the pen is away', () => {
    expect(nextAutosaveStep({ penNearby: false, deferredMs: 0 })).toBe('save');
  });

  it('puts it off while the pen is on the page or hovering over it', () => {
    expect(nextAutosaveStep({ penNearby: true, deferredMs: 0 })).toBe('wait');
    expect(nextAutosaveStep({ penNearby: true, deferredMs: 5_000 })).toBe('wait');
  });

  it('does not put it off for ever, because a draft is what a crash restores from', () => {
    expect(nextAutosaveStep({ penNearby: true, deferredMs: AUTOSAVE_MAX_DEFER_MS - 1 })).toBe('wait');
    expect(nextAutosaveStep({ penNearby: true, deferredMs: AUTOSAVE_MAX_DEFER_MS })).toBe('save');
  });

  it('looks again well inside the put-off, so it runs soon after the pen goes quiet', () => {
    expect(AUTOSAVE_RECHECK_MS).toBeLessThan(AUTOSAVE_DEBOUNCE_MS);
    expect(AUTOSAVE_MAX_DEFER_MS).toBeGreaterThan(AUTOSAVE_DEBOUNCE_MS * 4);
  });
});
