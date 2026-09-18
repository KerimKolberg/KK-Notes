import { useEffect } from 'react';
import { setPageDefaultsSource } from '../document/operations';
import { usePreferencesStore } from './store';

/**
 * Let `createPage` see the user's preferred layout.
 *
 * Installed as a callback rather than passed down, because pages are created
 * from a dozen places — the arranger, a duplicate, a fresh document, a PDF
 * import — and threading a preference through every one of them would mean
 * every one of them could forget. `operations.ts` stays a pure module that
 * knows nothing about a store; this hands it a function to ask.
 */
export function usePageDefaultsSource(): void {
  useEffect(() => {
    setPageDefaultsSource(() => usePreferencesStore.getState().pageDefaults);
    return () => setPageDefaultsSource(null);
  }, []);
}
