/**
 * What went wrong, kept on the device until it can be sent on.
 *
 * "It crashed" is all a writer can report, and on a Windows tablet nothing else is left: the window is gone, and
 * with it anything the app knew. So the app keeps a history (the last `MAX_PROBLEMS` problems, each with when, what,
 * where and which build): an error nobody caught, a screen that failed to draw, the app found to have ended while it
 * was on screen (it marks itself as running while visible), and what its native side wrote down (`addNativeProblems`:
 * a native error, the web view losing a process, the handwriting reader failing).
 *
 * The history is kept, not shown once and forgotten: a notice at the next start says something new went wrong (it
 * goes by itself after a few seconds, and can be overtaken by the app's own start-up messages), and *Copy problem
 * report* at the foot of the toolbar's settings copies the whole history at any time.
 *
 * Nothing leaves the device: the history is in the web view's own storage, and is copied only when asked.
 */
import { describeBuild } from './buildInfo';

const PROBLEMS_KEY = 'kknotes.problems.v1';
/** The newest problem a notice has already been about (ISO time). */
const SHOWN_KEY = 'kknotes.problems.shown.v1';
const RUNNING_KEY = 'kknotes.running.v1';
const MAX_PROBLEMS = 20;
const MAX_DETAIL = 2_000;

/** What the app found at start when the run before it ended while on screen. */
export const ENDED_UNEXPECTEDLY = 'The app ended while it was on screen';

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
  /** What went wrong that no notice has been about yet, oldest first. */
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

function keep(problems: readonly Problem[]): void {
  const sorted = [...problems].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  write(PROBLEMS_KEY, JSON.stringify(sorted.slice(-MAX_PROBLEMS)));
}

function problem(what: string, detail: string, at = new Date().toISOString()): Problem {
  return { at, what, detail: detail.slice(0, MAX_DETAIL), build: describeBuild() };
}

/** Something went wrong: keep it (the newest few). */
export function recordProblem(what: string, error: unknown, extra = ''): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${(error.stack ?? '').split('\n').slice(1, 8).join('\n')}`
      : String(error);
  keep([...stored(), problem(what, `${detail}${extra ? `\n${extra}` : ''}`)]);
}

/** Problems that no notice has been about yet. */
function unshown(): Problem[] {
  const shown = read(SHOWN_KEY) ?? '';
  return stored().filter((p) => p.at > shown);
}

let endedUnexpectedly = false;

/** How the last run went, as far as is known now (the native side's record may be added after). */
export function previousRunReport(): PreviousRun {
  return { endedUnexpectedly, problems: unshown() };
}

/** A notice has been about everything there is: the next one is only for something new. */
export function markProblemsShown(): void {
  const newest = stored().at(-1);
  if (newest) write(SHOWN_KEY, newest.at);
}

/**
 * Add what the native side wrote down (`src-tauri/src/crash_log.rs`, read at start, asynchronously) to the history:
 * one line a problem, "seconds since 1970 · what · detail". Anything but text is nothing.
 */
export function addNativeProblems(text: unknown): PreviousRun {
  const lines = typeof text === 'string' ? text.split('\n').filter((line) => line.trim() !== '') : [];
  if (lines.length > 0) {
    const added = lines.map((line) => {
      const [seconds, what, ...detail] = line.split('\t');
      const when = Number(seconds);
      const at = Number.isFinite(when) && when > 0 ? new Date(when * 1000).toISOString() : new Date().toISOString();
      return problem(`${what ?? 'A native problem'} (native)`, detail.join(' '), at);
    });
    keep([...stored(), ...added]);
  }
  return previousRunReport();
}

/**
 * Start keeping the history for this run, and say how the last one went. Errors nobody caught are kept; the app is
 * marked as running while it is on screen (not while it is hidden, when Android may end it without a word, which is
 * no crash). Found still marked at start, the last run ended while on screen: that goes in the history too.
 */
export function startProblemLog(): PreviousRun {
  endedUnexpectedly = read(RUNNING_KEY) !== null;
  if (endedUnexpectedly) {
    keep([...stored(), problem(ENDED_UNEXPECTEDLY, `Found at the next start (the window closed, or was closed by Windows, without the app closing itself). Last seen running: ${read(RUNNING_KEY)}`)]);
  }
  if (typeof window === 'undefined') return previousRunReport();

  const running = (): void => write(RUNNING_KEY, document.visibilityState === 'hidden' ? null : new Date().toISOString());
  running();
  document.addEventListener('visibilitychange', running);
  window.addEventListener('pagehide', () => write(RUNNING_KEY, null));
  window.addEventListener('pageshow', running);
  window.addEventListener('error', (e) => recordProblem('An error nobody caught', e.error ?? e.message, e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : ''));
  window.addEventListener('unhandledrejection', (e) => recordProblem('A failure nobody caught', e.reason));
  return previousRunReport();
}

/** Problems as text to send on. */
export function describeProblems(run: PreviousRun): string {
  const head = `${describeBuild()}\n${run.endedUnexpectedly ? 'The previous run ended while the app was on screen.' : 'The previous run closed normally.'}`;
  if (run.problems.length === 0) return `${head}\nNo errors were recorded in it (so it was the web view or Windows that stopped it, not the app's code).`;
  return [head, ...run.problems.map((p) => `--- ${p.at} · ${p.what} · ${p.build}\n${p.detail}`)].join('\n');
}

/** The whole history, newest last, as text to send on: what *Copy problem report* copies. */
export function problemReport(): string {
  const all = stored();
  const head = `${describeBuild()}\nThe last ${all.length} problem(s) this device kept, oldest first. Ended while on screen: ${all.filter((p) => p.what === ENDED_UNEXPECTEDLY).length}.`;
  return [head, ...all.map((p) => `--- ${p.at} · ${p.what} · ${p.build}\n${p.detail}`)].join('\n');
}
