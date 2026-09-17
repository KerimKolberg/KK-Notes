/**
 * Android system-bar insets.
 *
 * `env(safe-area-inset-*)` reports only display cutouts in an Android WebView,
 * so `MainActivity` measures the real window insets and hands them to the web
 * layer as the `--android-inset-*` custom properties (see `index.css`, which
 * folds them into `--safe-*`).
 *
 * The activity pushes them as they change, but that push alone is not enough:
 * the inset listener fires as soon as the WebView is laid out, which is while
 * it still holds the blank document it starts with, and navigating to the app
 * throws away everything that push set. So the activity also exposes the
 * current values through a bridge object, and the page pulls them once it is
 * the document that will actually stay.
 */
import type { Insets } from './safeArea';

/** Name `MainActivity` registers the bridge under (`addJavascriptInterface`). */
export const INSET_BRIDGE = '__notexInsets';

export interface AndroidInsetBridge {
  /** JSON `{"top":n,"right":n,"bottom":n,"left":n}`, in CSS pixels. */
  get(): string;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Parse the bridge's payload. Returns `null` for anything that is not four
 * finite, non-negative numbers — this crosses a language boundary, so the
 * shape is checked rather than trusted.
 */
export function parseBridgeInsets(json: string): Insets | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const parsed: Record<string, number> = {};
  for (const side of SIDES) {
    const value = record[side];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    parsed[side] = value;
  }
  return parsed as unknown as Insets;
}

/** Write the insets onto an element as the `--android-inset-*` properties. */
export function applyAndroidInsets(root: HTMLElement, insets: Insets): void {
  for (const side of SIDES) root.style.setProperty(`--android-inset-${side}`, `${insets[side]}px`);
}

function findBridge(): AndroidInsetBridge | null {
  const candidate = (globalThis as Record<string, unknown>)[INSET_BRIDGE];
  if (typeof candidate !== 'object' || candidate === null) return null;
  const bridge = candidate as Partial<AndroidInsetBridge>;
  return typeof bridge.get === 'function' ? (bridge as AndroidInsetBridge) : null;
}

/** Pull the current insets and apply them. False when there is no bridge. */
export function syncAndroidInsets(): boolean {
  const bridge = findBridge();
  if (!bridge || typeof document === 'undefined') return false;
  const insets = parseBridgeInsets(bridge.get());
  if (!insets) return false;
  applyAndroidInsets(document.documentElement, insets);
  return true;
}

/**
 * Keep `--android-inset-*` in step with the system bars. A no-op off Android.
 *
 * `addJavascriptInterface` injects the bridge into the *next* page load, so on
 * a cold start it can arrive a beat after this script does; the install keeps
 * looking for a short while before giving up. Anywhere else those few checks
 * find nothing and stop. Once it is found, rotating is both when the insets
 * really change and when a dropped push would show, so re-pull there too.
 */
export function installAndroidInsets(attempts = 10, intervalMs = 150): () => void {
  const resync = (): void => void syncAndroidInsets();
  let timer = 0;
  let remaining = attempts;

  const attempt = (): void => {
    if (syncAndroidInsets()) {
      window.addEventListener('orientationchange', resync);
      window.addEventListener('resize', resync);
      return;
    }
    remaining -= 1;
    if (remaining > 0) timer = window.setTimeout(attempt, intervalMs);
  };
  attempt();

  return () => {
    window.clearTimeout(timer);
    remaining = 0;
    window.removeEventListener('orientationchange', resync);
    window.removeEventListener('resize', resync);
  };
}
