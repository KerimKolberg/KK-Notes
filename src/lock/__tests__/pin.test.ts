import { describe, expect, it } from 'vitest';
import { checkPasscode, createLockRecord, isLockRecord, passcodeProblem, retryDelayMs, sameBytes } from '../pin';

// Few rounds: the test is of the logic, not of how slow a guess should be.
const ROUNDS = 1000;

describe('a passcode record', () => {
  it('accepts the passcode it was made from and nothing else', async () => {
    const record = await createLockRecord('correct horse', ROUNDS);
    expect(await checkPasscode('correct horse', record)).toBe(true);
    expect(await checkPasscode('correct horsE', record)).toBe(false);
    expect(await checkPasscode('', record)).toBe(false);
  });

  it('does not contain the passcode, and differs for the same passcode twice', async () => {
    const a = await createLockRecord('1234', ROUNDS);
    const b = await createLockRecord('1234', ROUNDS);
    expect(JSON.stringify(a)).not.toContain('1234');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('is not fooled by a record whose hash was swapped or damaged', async () => {
    const a = await createLockRecord('1234', ROUNDS);
    const b = await createLockRecord('5678', ROUNDS);
    expect(await checkPasscode('5678', { ...a, hash: b.hash })).toBe(false);
    expect(await checkPasscode('1234', { ...a, salt: '!!!not base64!!!' })).toBe(false);
  });

  it('works with any characters', async () => {
    const record = await createLockRecord('pässwörd ✏️ 日本', ROUNDS);
    expect(await checkPasscode('pässwörd ✏️ 日本', record)).toBe(true);
  });
});

describe('isLockRecord', () => {
  it('accepts a real record and refuses what storage might hold instead', async () => {
    expect(isLockRecord(await createLockRecord('1234', ROUNDS))).toBe(true);
    expect(isLockRecord(null)).toBe(false);
    expect(isLockRecord({})).toBe(false);
    expect(isLockRecord({ v: 2, salt: 'a', hash: 'b', iterations: 10 })).toBe(false);
    expect(isLockRecord({ v: 1, salt: 'a', hash: 'b', iterations: 0 })).toBe(false);
    expect(isLockRecord({ v: 1, salt: 'a', hash: 'b', iterations: 1e12 })).toBe(false);
    expect(isLockRecord({ v: 1, salt: 1, hash: 'b', iterations: 10 })).toBe(false);
  });
});

describe('passcodeProblem', () => {
  it('asks for enough characters, and the same twice', () => {
    expect(passcodeProblem('123', '123')).toMatch(/at least 4/);
    expect(passcodeProblem('1234', '1235')).toMatch(/not the same/);
    expect(passcodeProblem('x'.repeat(65), 'x'.repeat(65))).toMatch(/at most 64/);
    expect(passcodeProblem('1234', '1234')).toBeNull();
  });
});

describe('retryDelayMs', () => {
  it('is free for a few tries, then grows and stops at five minutes', () => {
    expect([0, 1, 4].map(retryDelayMs)).toEqual([0, 0, 0]);
    expect(retryDelayMs(5)).toBe(30_000);
    expect(retryDelayMs(6)).toBe(60_000);
    expect(retryDelayMs(7)).toBe(120_000);
    expect(retryDelayMs(50)).toBe(300_000);
  });
});

describe('sameBytes', () => {
  it('compares whole arrays', () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
