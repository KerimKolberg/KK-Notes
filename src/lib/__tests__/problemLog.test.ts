import { beforeEach, describe, expect, it, vi } from 'vitest';
import { describeProblems, problemReport, recordProblem, startProblemLog } from '../problemLog';

// The tests run without a browser: a page's storage, events and visibility, as the log uses them.
const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};
const window = new EventTarget();
vi.stubGlobal('localStorage', localStorage);
vi.stubGlobal('window', window);
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));

describe('what went wrong, kept for the next start', () => {
  beforeEach(() => localStorage.clear());

  it('finds a run that ended while on screen, and what went wrong in it', () => {
    startProblemLog();
    recordProblem('Drawing this note failed', new Error('boom'));
    // The app is gone without closing: the next start finds it still marked as running.
    const next = startProblemLog();
    expect(next.endedUnexpectedly).toBe(true);
    expect(next.problems).toHaveLength(1);
    expect(next.problems[0]!.detail).toContain('Error: boom');
  });

  it('shows the record once', () => {
    recordProblem('x', 'y');
    startProblemLog();
    window.dispatchEvent(new Event('pagehide'));
    expect(startProblemLog().problems).toHaveLength(0);
  });

  it('is not a crash when the app closed itself', () => {
    startProblemLog();
    window.dispatchEvent(new Event('pagehide'));
    expect(startProblemLog().endedUnexpectedly).toBe(false);
  });

  it('keeps only the newest few', () => {
    for (let i = 0; i < 20; i++) recordProblem(`problem ${i}`, 'x');
    const run = startProblemLog();
    expect(run.problems.length).toBeLessThanOrEqual(8);
    expect(run.problems.at(-1)!.what).toBe('problem 19');
  });

  it('says when nothing was recorded that it was not the app\'s code', () => {
    expect(describeProblems({ endedUnexpectedly: true, problems: [] })).toMatch(/web view or Windows/);
  });

  it('reports this run too', () => {
    startProblemLog();
    recordProblem('Now', new TypeError('bad'));
    expect(problemReport()).toContain('TypeError: bad');
  });
});
