import { DocumentApp } from './document';
import { LibraryView } from './library/LibraryView';
import { useRouteStore } from './library/routeStore';
import { useBoot } from './library/useBoot';

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
  const view = useRouteStore((s) => s.route.view);
  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100dvh' }}>
      {!ready ? null : view === 'library' ? <LibraryView /> : <DocumentApp />}
    </div>
  );
}
