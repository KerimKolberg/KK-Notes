import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { installAndroidInsets } from './ui/androidInsets';
import { useDesktopStore } from './desktop/desktopStore';
import { addNativeProblems, describeProblems, startProblemLog, type PreviousRun } from './lib/problemLog';
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
function sayHowTheLastRunWent(run: PreviousRun): void {
  if (!run.endedUnexpectedly && run.problems.length === 0 && !run.native) return;
  const details = describeProblems(run);
  useDesktopStore.getState().setNotice({
    text: run.endedUnexpectedly || run.native
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
  void tauriInvoke<string>('take_native_problems')
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
