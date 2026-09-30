import { beforeEach, describe, expect, it } from 'vitest';
import { useLockStore } from '../lockStore';

const reset = (): void =>
  useLockStore.setState({ record: null, autoLockMinutes: 0, locked: false, failures: 0, retryAt: 0 });

describe('the lock', () => {
  beforeEach(reset);

  it('is off until a passcode is set, and lockNow does nothing then', () => {
    useLockStore.getState().lockNow();
    expect(useLockStore.getState().locked).toBe(false);
  });

  it('turns on with a good passcode, leaving the app open, and locks when asked', async () => {
    expect(await useLockStore.getState().enable('1234', '1234')).toBeNull();
    expect(useLockStore.getState().record).not.toBeNull();
    expect(useLockStore.getState().locked).toBe(false);
    useLockStore.getState().lockNow();
    expect(useLockStore.getState().locked).toBe(true);
  });

  it('refuses a passcode that is too short or not repeated, and stays off', async () => {
    expect(await useLockStore.getState().enable('12', '12')).toMatch(/at least/);
    expect(await useLockStore.getState().enable('1234', '4321')).toMatch(/not the same/);
    expect(useLockStore.getState().record).toBeNull();
  });

  it('unlocks with the passcode and not without it', async () => {
    await useLockStore.getState().enable('open sesame', 'open sesame');
    useLockStore.getState().lockNow();
    expect(await useLockStore.getState().unlock('nope')).toBe('wrong');
    expect(useLockStore.getState().locked).toBe(true);
    expect(await useLockStore.getState().unlock('open sesame')).toBe('ok');
    expect(useLockStore.getState().locked).toBe(false);
  });

  it('makes a person wait after five wrong tries, even for the right passcode', async () => {
    await useLockStore.getState().enable('1234', '1234');
    useLockStore.getState().lockNow();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(await useLockStore.getState().unlock('0000', t0)).toBe('wrong');
    expect(await useLockStore.getState().unlock('1234', t0 + 10_000)).toBe('wait');
    expect(useLockStore.getState().locked).toBe(true);
    expect(await useLockStore.getState().unlock('1234', t0 + 31_000)).toBe('ok');
    expect(useLockStore.getState().failures).toBe(0);
  });

  it('turns off only for the current passcode', async () => {
    await useLockStore.getState().enable('1234', '1234');
    expect(await useLockStore.getState().disable('9999')).toBe(false);
    expect(useLockStore.getState().record).not.toBeNull();
    expect(await useLockStore.getState().disable('1234')).toBe(true);
    expect(useLockStore.getState().record).toBeNull();
    expect(useLockStore.getState().locked).toBe(false);
  });

  it('changes the passcode only for the current one, and the new one then works', async () => {
    await useLockStore.getState().enable('1234', '1234');
    expect(await useLockStore.getState().change('0000', 'abcd', 'abcd')).toMatch(/current/);
    expect(await useLockStore.getState().change('1234', 'ab', 'ab')).toMatch(/at least/);
    expect(await useLockStore.getState().change('1234', 'abcd', 'abcd')).toBeNull();
    useLockStore.getState().lockNow();
    expect(await useLockStore.getState().unlock('1234')).toBe('wrong');
    expect(await useLockStore.getState().unlock('abcd')).toBe('ok');
  });

  it('takes only the auto-lock times it offers', () => {
    useLockStore.getState().setAutoLock(5);
    expect(useLockStore.getState().autoLockMinutes).toBe(5);
    useLockStore.getState().setAutoLock(7);
    expect(useLockStore.getState().autoLockMinutes).toBe(5);
  });
});
