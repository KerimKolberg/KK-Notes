import { useEffect, useState } from 'react';
import { NO_INSETS, PROBE_STYLE, insetsEqual, parseInsets, type Insets } from './safeArea';

/**
 * The current safe-area insets in CSS pixels, re-measured when the window
 * resizes or the device rotates. Returns zeros outside a browser.
 */
export function useSafeAreaInsets(): Insets {
  const [insets, setInsets] = useState<Insets>(NO_INSETS);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.setAttribute('data-safe-area-probe', '');
    probe.style.cssText = PROBE_STYLE;
    document.body.append(probe);

    const measure = (): void => {
      const next = parseInsets(getComputedStyle(probe));
      setInsets((current) => (insetsEqual(current, next) ? current : next));
    };
    measure();

    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    // MainActivity updates the custom properties as the system bars change.
    const observer = new MutationObserver(measure);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      observer.disconnect();
      probe.remove();
    };
  }, []);

  return insets;
}
