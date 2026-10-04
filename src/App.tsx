import { Suspense, lazy } from 'react';
import { DocumentApp } from './document/components/DocumentApp';
import { useOpenWith } from './desktop/useOpenWith';
import { useBackgroundLife } from './desktop/background';
import { useFileDropGuard } from './desktop/useFileDrop';
import { LibraryView } from './library/LibraryView';
import { useRouteStore } from './library/routeStore';
import { useBoot } from './library/useBoot';
import { useImportReportStore } from './goodnotes/reportStore';
import { LockScreen } from './lock/LockScreen';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { useLockStore } from './lock/lockStore';
import { useAutoLock } from './lock/useAutoLock';

// Lazy, so the dialog costs nothing until a notebook is actually imported.
const ImportReportDialog = lazy(() =>
  import('./goodnotes/ImportReportDialog').then((m) => ({ default: m.ImportReportDialog })),
);

/**
 * Multi-page notes app. The library is the home screen and one document is
 * open at a time; `100dvh` tracks the dynamic browser chrome on tablets.
 *
 * The switch is deliberately a swap rather than two mounted trees kept behind
 * a CSS toggle: the document tree owns canvases, a pointer pipeline and a
 * page raster cache, and leaving it mounted behind the library would keep all
 * of that alive for as long as the app ran.
 */
export default function App() {
  // A file association or a restored draft decides the first view, so nothing
  // is rendered until that is settled — otherwise the library would flash up
  // on the way to a document the user actually double-clicked.
  const ready = useBoot();
  // A file opened from elsewhere while this app was already running. Mounted
  // above the router because it may need to switch views to show the result.
  useOpenWith();
  useBackgroundLife();
  // Above the router for a blunter reason: a file dropped on any part of the
  // window the app does not handle would otherwise navigate the webview to it,
  // replacing the app and losing whatever was unsaved.
  useFileDropGuard();
  const view = useRouteStore((s) => s.route.view);
  const locked = useLockStore((s) => s.locked);
  useAutoLock();
  // Above the router for the same reason: an import may land in either view, and
  // a failed one leaves the user in the library — the summary has to outlive the
  // switch either way.
  const hasImportReport = useImportReportStore((s) => s.outcome !== null);
  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh' }}>
      {/* While locked the app stays mounted (so unlocking returns to exactly where it was) but cannot be
          reached by keyboard, pointer or screen reader, and the lock screen is opaque above it. */}
      <div style={{ position: 'absolute', inset: 0 }} inert={locked} aria-hidden={locked || undefined}>
        {!ready ? null : view === 'library' ? (
          <ErrorBoundary what="your library">
            <LibraryView />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary what="this note">
            <DocumentApp />
          </ErrorBoundary>
        )}
        {ready && hasImportReport && (
          <Suspense fallback={null}>
            <ImportReportDialog />
          </Suspense>
        )}
      </div>
      {locked && <LockScreen />}
    </div>
  );
}
