import { useEffect, useState } from 'react';
import { resolveBootTarget } from '../desktop/boot';
import { useRouteStore } from './routeStore';

/**
 * Run the boot decision once, before anything is shown.
 *
 * Returns false until it has finished, so the library does not flash up for a
 * moment on its way to a document the user actually asked for.
 */
export function useBoot(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void resolveBootTarget().then((target) => {
      if (cancelled) return;
      if (target.view === 'document') useRouteStore.getState().openDocument(target.path);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return ready;
}
