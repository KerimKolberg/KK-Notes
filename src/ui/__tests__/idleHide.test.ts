import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleHide } from '../idleHide';

const DELAY = 5000;

describe('IdleHide', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function make(state = { enabled: true, busy: false }) {
    const idle = new IdleHide(DELAY);
    const seen: boolean[] = [];
    idle.subscribe(() => seen.push(idle.concealed()));
    idle.set(state);
    return { idle, seen };
  }

  it('never hides a pinned toolbar', () => {
    const { idle } = make({ enabled: false, busy: false });
    vi.advanceTimersByTime(DELAY * 10);
    expect(idle.concealed()).toBe(false);
  });

  it('hides an idle unpinned one after the delay, and not a moment before', () => {
    const { idle, seen } = make();
    vi.advanceTimersByTime(DELAY - 1);
    expect(idle.concealed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(idle.concealed()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('stays up while it is being used', () => {
    const { idle } = make({ enabled: true, busy: true });
    vi.advanceTimersByTime(DELAY * 3);
    expect(idle.concealed()).toBe(false);
  });

  it('starts counting only once it is let go of', () => {
    const { idle } = make({ enabled: true, busy: true });
    vi.advanceTimersByTime(DELAY * 3);
    idle.set({ enabled: true, busy: false });
    vi.advanceTimersByTime(DELAY - 1);
    expect(idle.concealed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(idle.concealed()).toBe(true);
  });

  it('is put off again by being picked up mid-countdown', () => {
    const { idle } = make();
    vi.advanceTimersByTime(DELAY - 100);
    idle.set({ enabled: true, busy: true });
    vi.advanceTimersByTime(DELAY * 2);
    expect(idle.concealed()).toBe(false);
    // Let go: a whole new delay, not the 100 ms that was left.
    idle.set({ enabled: true, busy: false });
    vi.advanceTimersByTime(DELAY - 1);
    expect(idle.concealed()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(idle.concealed()).toBe(true);
  });

  it('is shown at once when it is pinned while hidden', () => {
    const { idle } = make();
    vi.advanceTimersByTime(DELAY);
    expect(idle.concealed()).toBe(true);
    idle.set({ enabled: false, busy: false });
    expect(idle.concealed()).toBe(false);
  });

  it('is shown at once when something takes hold of it while hidden', () => {
    const { idle } = make();
    vi.advanceTimersByTime(DELAY);
    idle.set({ enabled: true, busy: true });
    expect(idle.concealed()).toBe(false);
  });

  describe('reveal', () => {
    it('brings a hidden toolbar back', () => {
      const { idle } = make();
      vi.advanceTimersByTime(DELAY);
      idle.reveal();
      expect(idle.concealed()).toBe(false);
    });

    it('gives it a full delay to be picked up before it goes again', () => {
      const { idle } = make();
      vi.advanceTimersByTime(DELAY);
      idle.reveal();
      vi.advanceTimersByTime(DELAY - 1);
      expect(idle.concealed()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(idle.concealed()).toBe(true);
    });

    it('restarts the clock if it is asked while already showing', () => {
      const { idle } = make();
      vi.advanceTimersByTime(DELAY - 10);
      idle.reveal();
      vi.advanceTimersByTime(DELAY - 1);
      expect(idle.concealed()).toBe(false);
    });

    it('does not start a clock for a toolbar that is in use', () => {
      const { idle } = make({ enabled: true, busy: true });
      idle.reveal();
      vi.advanceTimersByTime(DELAY * 3);
      expect(idle.concealed()).toBe(false);
    });
  });

  it('does not push the deadline back when told the same thing twice', () => {
    // Development mounts effects twice; a re-render must not stretch the wait either.
    const { idle } = make();
    vi.advanceTimersByTime(DELAY - 1000);
    idle.set({ enabled: true, busy: false });
    vi.advanceTimersByTime(1000);
    expect(idle.concealed()).toBe(true);
  });

  it('starts counting again after a dispose and a set, as a double-mount does', () => {
    const { idle } = make();
    idle.dispose();
    idle.set({ enabled: true, busy: false });
    vi.advanceTimersByTime(DELAY);
    expect(idle.concealed()).toBe(true);
  });

  it('tells a listener only when the answer changes', () => {
    const { idle, seen } = make();
    idle.set({ enabled: true, busy: false });
    idle.reveal();
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(DELAY);
    idle.reveal();
    expect(seen).toEqual([true, false]);
  });
});
