import { create } from 'zustand';
import { checkPasscode, createLockRecord, isLockRecord, passcodeProblem, retryDelayMs, type LockRecord } from './pin';

const STORAGE_KEY = 'notes.lock.v1';

/** Idle minutes before the app locks itself; `0` means only when it starts. */
export const AUTO_LOCK_CHOICES: readonly number[] = [0, 1, 5, 15, 30];

interface Persisted {
  readonly record: LockRecord | null;
  readonly autoLockMinutes: number;
}

/**
 * Its own key, not part of the preferences: "reset to defaults" must not be a way round the lock.
 */
function read(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed === 'object' && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      const record = isLockRecord(p.record) ? p.record : null;
      const minutes = typeof p.autoLockMinutes === 'number' && AUTO_LOCK_CHOICES.includes(p.autoLockMinutes) ? p.autoLockMinutes : 0;
      return { record, autoLockMinutes: minutes };
    }
  } catch {
    /* unreadable storage means no lock was set */
  }
  return { record: null, autoLockMinutes: 0 };
}

function write(value: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* the lock then lasts until the app is closed */
  }
}

export type UnlockResult = 'ok' | 'wrong' | 'wait';

export interface LockStore {
  /** The stored passcode hash, or `null` when there is no lock. */
  readonly record: LockRecord | null;
  readonly autoLockMinutes: number;
  /** Whether the lock screen is up. Starts up whenever there is a passcode. */
  readonly locked: boolean;
  /** Wrong tries in a row, and when the next one is allowed. */
  readonly failures: number;
  readonly retryAt: number;

  /** Set a passcode and leave the app unlocked. Resolves the problem with it, or `null`. */
  enable: (passcode: string, repeat: string) => Promise<string | null>;
  /** Turn the lock off, given the current passcode. */
  disable: (passcode: string) => Promise<boolean>;
  /** Replace the passcode, given the current one. */
  change: (current: string, next: string, repeat: string) => Promise<string | null>;
  setAutoLock: (minutes: number) => void;
  lockNow: () => void;
  unlock: (passcode: string, now?: number) => Promise<UnlockResult>;
}

const initial = read();

export const useLockStore = create<LockStore>()((set, get) => ({
  record: initial.record,
  autoLockMinutes: initial.autoLockMinutes,
  locked: initial.record !== null,
  failures: 0,
  retryAt: 0,

  enable: async (passcode, repeat) => {
    const problem = passcodeProblem(passcode, repeat);
    if (problem) return problem;
    const record = await createLockRecord(passcode);
    write({ record, autoLockMinutes: get().autoLockMinutes });
    set({ record, locked: false, failures: 0, retryAt: 0 });
    return null;
  },

  disable: async (passcode) => {
    const { record } = get();
    if (!record || !(await checkPasscode(passcode, record))) return false;
    write({ record: null, autoLockMinutes: 0 });
    set({ record: null, autoLockMinutes: 0, locked: false, failures: 0, retryAt: 0 });
    return true;
  },

  change: async (current, next, repeat) => {
    const { record } = get();
    if (!record || !(await checkPasscode(current, record))) return 'That is not the current passcode.';
    const problem = passcodeProblem(next, repeat);
    if (problem) return problem;
    const replacement = await createLockRecord(next);
    write({ record: replacement, autoLockMinutes: get().autoLockMinutes });
    set({ record: replacement });
    return null;
  },

  setAutoLock: (minutes) => {
    if (!AUTO_LOCK_CHOICES.includes(minutes)) return;
    write({ record: get().record, autoLockMinutes: minutes });
    set({ autoLockMinutes: minutes });
  },

  lockNow: () => {
    if (get().record) set({ locked: true });
  },

  unlock: async (passcode, now = Date.now()) => {
    const { record, retryAt, failures } = get();
    if (!record) {
      set({ locked: false });
      return 'ok';
    }
    if (now < retryAt) return 'wait';
    if (await checkPasscode(passcode, record)) {
      set({ locked: false, failures: 0, retryAt: 0 });
      return 'ok';
    }
    const next = failures + 1;
    set({ failures: next, retryAt: now + retryDelayMs(next) });
    return 'wrong';
  },
}));
