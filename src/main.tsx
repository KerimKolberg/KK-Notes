import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { installAndroidInsets } from './ui/androidInsets';
import { useDesktopStore } from './desktop/desktopStore';
import { describeProblems, startProblemLog } from './lib/problemLog';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}

// Before the first paint: the top bar and the palette are laid out against
// these, and on Android they are zero until the activity is asked for them.
installAndroidInsets();

// How the last run went: if it ended while on screen, or something went wrong in it, say so once, with the details
// to copy and send on (`lib/problemLog.ts`).
const previousRun = startProblemLog();
if (previousRun.endedUnexpectedly || previousRun.problems.length > 0) {
  const details = describeProblems(previousRun);
  useDesktopStore.getState().setNotice({
    text: previousRun.endedUnexpectedly
      ? 'KK-Notes closed unexpectedly last time. The details can be copied to send on.'
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

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
