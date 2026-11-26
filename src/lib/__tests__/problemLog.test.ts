import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENDED_UNEXPECTEDLY, addNativeProblems, describeProblems, markProblemsShown, problemReport, recordProblem, startProblemLog } from '../problemLog';

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

describe('what went wrong, kept on the device until it is sent on', () => {
  beforeEach(() => localStorage.clear());

  it('finds a run that ended while on screen, and what went wrong in it', () => {
    startProblemLog();
    recordProblem('Drawing this note failed', new Error('boom'));
    // The app is gone without closing: the next start finds it still marked as running.
    const next = startProblemLog();
    expect(next.endedUnexpectedly).toBe(true);
    expect(next.problems.map((p) => p.what)).toEqual(['Drawing this note failed', ENDED_UNEXPECTEDLY]);
    expect(next.problems[0]!.detail).toContain('Error: boom');
  });

  it('is not a crash when the app closed itself', () => {
    startProblemLog();
    window.dispatchEvent(new Event('pagehide'));
    const next = startProblemLog();
    expect(next.endedUnexpectedly).toBe(false);
    expect(next.problems).toHaveLength(0);
  });

  it('says once what is new, and keeps the history for the report', () => {
    recordProblem('Once', 'x');
    expect(startProblemLog().problems).toHaveLength(1);
    markProblemsShown();
    window.dispatchEvent(new Event('pagehide'));
    expect(startProblemLog().problems).toHaveLength(0);
    expect(problemReport()).toContain('Once');
  });

  it('keeps only the newest twenty', () => {
    for (let i = 0; i < 30; i++) recordProblem(`problem ${i}`, 'x');
    const report = problemReport();
    expect(report).toContain('problem 29');
    expect(report).not.toContain('problem 9\n');
    expect(report).toMatch(/The last 20 problem/);
  });

  it('says when nothing was recorded that it was not the app\'s code', () => {
    expect(describeProblems({ endedUnexpectedly: true, problems: [] })).toMatch(/web view or Windows/);
  });

  it('takes in what the native side wrote down: when, what, and why', () => {
    startProblemLog();
    const run = addNativeProblems("1763990000\tThe handwriting reader failed (kept apart from the app)\texit code 0xc0000005; \n");
    expect(run.problems.at(-1)!.what).toBe('The handwriting reader failed (kept apart from the app) (native)');
    expect(run.problems.at(-1)!.at).toMatch(/^2025-11-24T/);
    expect(describeProblems(run)).toContain('0xc0000005');
    expect(problemReport()).toContain('0xc0000005');
  });

  it('takes nothing from a native side that answered with nothing', () => {
    startProblemLog();
    for (const nothing of ['   ', null, undefined, { odd: true }]) expect(addNativeProblems(nothing).problems).toHaveLength(0);
  });

  it('counts the times the app ended while on screen, in the report', () => {
    startProblemLog();
    startProblemLog();
    startProblemLog();
    expect(problemReport()).toContain('Ended while on screen: 2.');
  });
});
