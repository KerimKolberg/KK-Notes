/**
 * What went wrong, kept for the next start.
 *
 * "It crashed" is all a writer can report, and on a Windows tablet nothing else is left: the window is gone, and
 * with it anything the app knew. So the app keeps a short record on the device (the last few errors, with where they
 * happened and which build it was), and notes while it is on screen that it is running. If it is found still running
 * at the next start, it did not close by itself: it says so, with a button that copies the record to be sent on.
 *
 * Nothing leaves the device: the record is in the web view's own storage, and is copied only when asked.
 */
import { describeBuild } from './buildInfo';

const PROBLEMS_KEY = 'kknotes.problems.v1';
const RUNNING_KEY = 'kknotes.running.v1';
const MAX_PROBLEMS = 8;
const MAX_DETAIL = 2_000;

export interface Problem {
  /** ISO time. */
  readonly at: string;
  readonly what: string;
  readonly detail: string;
  readonly build: string;
}

export interface PreviousRun {
  /** The app was on screen when it ended: it did not close by itself. */
  readonly endedUnexpectedly: boolean;
  /** What went wrong in it, oldest first. */
  readonly problems: readonly Problem[];
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage off: nothing is kept, and nothing breaks */
  }
}

function stored(): Problem[] {
  try {
    const parsed: unknown = JSON.parse(read(PROBLEMS_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((p): p is Problem => typeof p === 'object' && p !== null && typeof (p as Problem).what === 'string').slice(-MAX_PROBLEMS)
      : [];
  } catch {
    return [];
  }
}

/** Something went wrong: keep it (the newest few). */
export function recordProblem(what: string, error: unknown, extra = ''): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 8).join('\n')}`
      : String(error);
  const problem: Problem = {
    at: new Date().toISOString(),
    what,
    detail: `${detail}${extra ? `\n${extra}` : ''}`.slice(0, MAX_DETAIL),
    build: describeBuild(),
  };
  write(PROBLEMS_KEY, JSON.stringify([...stored(), problem].slice(-MAX_PROBLEMS)));
}

/**
 * Start keeping the record for this run, and say how the last one went. Errors nobody caught are kept; the app is
 * marked as running while it is on screen (not while it is hidden, when Android may end it without a word, which is
 * no crash).
 */
let previous: PreviousRun = { endedUnexpectedly: false, problems: [] };

/** How the last run went, as `startProblemLog` found it: for the settings panel to offer as a report. */
export function previousRunReport(): PreviousRun {
  return previous;
}

/** What went wrong in this run so far, as a report (with the last run's, if it had any). */
export function problemReport(): string {
  return describeProblems({ endedUnexpectedly: previous.endedUnexpectedly, problems: [...previous.problems, ...stored()] });
}

export function startProblemLog(): PreviousRun {
  const endedUnexpectedly = read(RUNNING_KEY) !== null;
  const problems = stored();
  previous = { endedUnexpectedly, problems };
  // The record is shown once: this run starts a new one.
  write(PROBLEMS_KEY, null);
  if (typeof window === 'undefined') return { endedUnexpectedly, problems };

  const running = (): void => write(RUNNING_KEY, document.visibilityState === 'hidden' ? null : new Date().toISOString());
  running();
  document.addEventListener('visibilitychange', running);
  window.addEventListener('pagehide', () => write(RUNNING_KEY, null));
  window.addEventListener('pageshow', running);
  window.addEventListener('error', (e) => recordProblem('An error nobody caught', e.error ?? e.message, e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : ''));
  window.addEventListener('unhandledrejection', (e) => recordProblem('A failure nobody caught', e.reason));
  return { endedUnexpectedly, problems };
}

/** The record as text to send on. */
export function describeProblems(run: PreviousRun): string {
  const head = `${describeBuild()}\n${run.endedUnexpectedly ? 'The previous run ended while the app was on screen.' : 'The previous run closed normally.'}`;
  if (run.problems.length === 0) return `${head}\nNo errors were recorded in it (so it was the web view or Windows that stopped it, not the app's code).`;
  return [head, ...run.problems.map((p) => `--- ${p.at} · ${p.what} · ${p.build}\n${p.detail}`)].join('\n');
}
