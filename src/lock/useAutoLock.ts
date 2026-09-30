import { useEffect } from 'react';
import { useLockStore } from './lockStore';

/** How often idleness is looked at while the app is in front. */
const CHECK_EVERY_MS = 15_000;

/**
 * Lock the app after it has been left alone for the chosen time, and let nothing reach it while it is locked.
 *
 * "Left alone" is no pointer, key, touch or wheel for that long; the clock is checked every few seconds
 * and again the moment the window comes back to the front, because a hidden window's timers are slowed
 * and a tablet that slept must not come back open. Also Ctrl+Shift+L locks at once.
 *
 * While locked, keys that are not going to the lock screen are stopped before anything else sees them:
 * the note behind it is still mounted, and Ctrl+Z, Ctrl+S or Delete must not reach it.
 */
export function useAutoLock(): void {
  useEffect(() => {
    let lastActive = Date.now();
    const touch = (): void => {
      lastActive = Date.now();
    };
    const check = (): void => {
      const { record, autoLockMinutes, locked, lockNow } = useLockStore.getState();
      if (!record || locked || autoLockMinutes <= 0) return;
      if (Date.now() - lastActive >= autoLockMinutes * 60_000) lockNow();
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') check();
    };
    const onKey = (e: KeyboardEvent): void => {
      const { locked, record, lockNow } = useLockStore.getState();
      if (record && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        e.stopImmediatePropagation();
        lockNow();
        return;
      }
      if (locked && !(e.target instanceof Element && e.target.closest('[data-lock-screen]'))) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };

    const activity: (keyof WindowEventMap)[] = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
    for (const name of activity) window.addEventListener(name, touch, { passive: true, capture: true });
    // Capture, registered before the document's own handlers, so a locked app never sees the key.
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    return () => {
      for (const name of activity) window.removeEventListener(name, touch, { capture: true });
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, []);
}
