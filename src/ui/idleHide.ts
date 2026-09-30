import { useEffect, useRef, useSyncExternalStore } from 'react';

/** How long an unpinned toolbar stays up once nothing is holding it open. */
export const IDLE_HIDE_MS = 5000;

export interface IdleHideState {
  /** Unpinned. When false the thing never hides, whatever else is true. */
  readonly enabled: boolean;
  /** Something is using it: hovered, focused, a flyout open, being dragged. */
  readonly busy: boolean;
}

/**
 * Decides when an unpinned toolbar should get out of the way.
 *
 * Framework-free so the rules can be tested against a fake clock: React only
 * supplies the two facts (`enabled`, `busy`) and reads back one (`concealed`).
 *
 * The rules:
 * - it hides after `delayMs` with nothing holding it open, and never before;
 * - anything holding it open — including the moment it is pinned — shows it and
 *   stops the clock, so it cannot vanish from under a finger;
 * - `reveal` shows it and restarts the clock, which is how the edge tab brings it
 *   back: it then has `delayMs` to be picked up before it goes again.
 */
export class IdleHide {
  private hidden = false;
  private state: IdleHideState = { enabled: false, busy: false };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly delayMs: number = IDLE_HIDE_MS) {}

  /** Arrow functions: passed straight to `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly concealed = (): boolean => this.hidden;

  set(next: IdleHideState): void {
    this.state = next;
    if (!next.enabled || next.busy) {
      // Pinned, or in use: visible, and nothing to count down to.
      this.disarm();
      this.setHidden(false);
    } else if (!this.hidden && this.timer === null) {
      // Idle and showing. A clock that is already running keeps running: telling
      // it the same thing twice must not push the deadline back.
      this.arm();
    }
  }

  reveal(): void {
    this.setHidden(false);
    this.disarm();
    if (this.state.enabled && !this.state.busy) this.arm();
  }

  dispose(): void {
    this.disarm();
    this.listeners.clear();
  }

  private arm(): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state.enabled && !this.state.busy) this.setHidden(true);
    }, this.delayMs);
  }

  private disarm(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface UseIdleHide {
  /** True while the toolbar should be out of the way. */
  readonly concealed: boolean;
  /** Bring it back; it will hide again after the delay unless it is used. */
  readonly reveal: () => void;
}

/** {@link IdleHide} for a component: pass what it knows, get whether to hide. */
export function useIdleHide(enabled: boolean, busy: boolean, delayMs: number = IDLE_HIDE_MS): UseIdleHide {
  const holder = useRef<IdleHide | null>(null);
  holder.current ??= new IdleHide(delayMs);
  const idle = holder.current;

  useEffect(() => {
    idle.set({ enabled, busy });
  }, [idle, enabled, busy]);
  // Separate from the effect above, which re-runs whenever the facts change and
  // must not tear the thing down each time. Development's double-mount runs this
  // cleanup and then `set` again, which is why `set` re-arms an idle toolbar.
  useEffect(() => () => idle.dispose(), [idle]);

  const concealed = useSyncExternalStore(idle.subscribe, idle.concealed, idle.concealed);
  return { concealed, reveal: () => idle.reveal() };
}
