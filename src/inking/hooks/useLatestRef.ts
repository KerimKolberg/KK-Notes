import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * A ref that always holds the latest render's value. Lets long-lived event
 * handlers read fresh state without being re-created (and re-bound) on every
 * render. The write happens in a layout effect so it lands before any
 * sibling effects declared later in the component run.
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef<T>(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
