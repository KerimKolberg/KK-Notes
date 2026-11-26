import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { installAndroidInsets } from './ui/androidInsets';
import { useDesktopStore } from './desktop/desktopStore';
import { addNativeProblems, describeProblems, markProblemsShown, startProblemLog, type PreviousRun } from './lib/problemLog';
import { isTauri, tauriInvoke } from './desktop/tauri';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}

// Before the first paint: the top bar and the palette are laid out against
// these, and on Android they are zero until the activity is asked for them.
installAndroidInsets();

// How the last run went: if it ended while on screen, or something went wrong in it, say so once, with the details
// to copy and send on (`lib/problemLog.ts`).
/** How long start-up is given to say its own things (a restored draft) before this is said. */
const AFTER_START_MS = 3_000;
/** The longest this waits for a notice already showing to go. */
const NOTICE_WAIT_MS = 15_000;

/**
 * After start-up, and after any notice already showing: a crash is followed by a restored draft, whose notice
 * ("Restored autosaved draft…") took the place of this one, so the crash was never seen to be reported.
 */
function whenStartedAndQuiet(say: () => void): void {
  window.setTimeout(() => {
    if (!useDesktopStore.getState().notice) {
      say();
      return;
    }
    const timer = window.setTimeout(() => {
      stop();
      say();
    }, NOTICE_WAIT_MS);
    const stop = useDesktopStore.subscribe((s) => {
      if (s.notice) return;
      window.clearTimeout(timer);
      stop();
      say();
    });
  }, AFTER_START_MS);
}

function sayHowTheLastRunWent(run: PreviousRun): void {
  if (!run.endedUnexpectedly && run.problems.length === 0) return;
  whenStartedAndQuiet(() => sayNow(run));
}

function sayNow(run: PreviousRun): void {
  const details = describeProblems(run);
  // Said once; the history stays for *Copy problem report* in the toolbar's settings.
  markProblemsShown();
  useDesktopStore.getState().setNotice({
    text: run.endedUnexpectedly
      ? 'KK-Notes stopped unexpectedly last time. The details can be copied to send on.'
      : 'Something went wrong last time KK-Notes ran. The details can be copied to send on.',
    action: {
      label: 'Copy details',
      run: () => {
        void navigator.clipboard?.writeText(details).then(
          () => useDesktopStore.getState().setNotice({ text: 'Copied. Paste it wherever you report the problem.' }),
          () => useDesktopStore.getState().setNotice({ text: 'Could not copy the details.' }),
        );
      },
    },
  });
}
const previousRun = startProblemLog();
if (isTauri()) {
  // The native side's record too (`src-tauri/src/crash_log.rs`): the web view losing its page or graphics process,
  // or a native error. What closes the window is written down there, not here.
  void tauriInvoke<unknown>('take_native_problems')
    .catch(() => '')
    .then((text) => sayHowTheLastRunWent(addNativeProblems(text)));
} else {
  sayHowTheLastRunWent(previousRun);
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
