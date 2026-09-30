/**
 * Keeping a passcode without keeping the passcode.
 *
 * What is stored is a salted PBKDF2-SHA-256 hash, never the passcode itself, so reading the stored
 * record does not tell anyone what to type. The salt is random per passcode and the iteration count is
 * stored with the record, so it can be raised later without locking anyone out.
 *
 * This is a lock on the *app*: it keeps someone who picks up an unattended device from opening the
 * notes through KK-Notes. It is not encryption. The notes are ordinary files in the library folder, and
 * whoever can open that folder can read them with or without this.
 */

export interface LockRecord {
  readonly v: 1;
  /** Base64. */
  readonly salt: string;
  /** Base64. */
  readonly hash: string;
  readonly iterations: number;
}

/** PBKDF2 rounds: about a quarter of a second on a mid-range tablet, which is the price of each guess. */
export const DEFAULT_ITERATIONS = 300_000;
export const MIN_PASSCODE_LENGTH = 4;
export const MAX_PASSCODE_LENGTH = 64;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(passcode: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Compare without stopping at the first difference. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export async function createLockRecord(passcode: string, iterations = DEFAULT_ITERATIONS): Promise<LockRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(passcode, salt, iterations);
  return { v: 1, salt: toBase64(salt), hash: toBase64(hash), iterations };
}

export async function checkPasscode(passcode: string, record: LockRecord): Promise<boolean> {
  try {
    const hash = await derive(passcode, fromBase64(record.salt), record.iterations);
    return sameBytes(hash, fromBase64(record.hash));
  } catch {
    return false;
  }
}

/** Why a new passcode cannot be used, or `null` when it can. */
export function passcodeProblem(passcode: string, repeat: string): string | null {
  if (passcode.length < MIN_PASSCODE_LENGTH) return `Use at least ${MIN_PASSCODE_LENGTH} characters.`;
  if (passcode.length > MAX_PASSCODE_LENGTH) return `Use at most ${MAX_PASSCODE_LENGTH} characters.`;
  if (passcode !== repeat) return 'The two passcodes are not the same.';
  return null;
}

/** Whether something read from storage is a usable record. */
export function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    typeof r.salt === 'string' &&
    typeof r.hash === 'string' &&
    typeof r.iterations === 'number' &&
    Number.isInteger(r.iterations) &&
    r.iterations >= 1 &&
    r.iterations <= 10_000_000
  );
}

/** How long to wait before another try: none for the first few wrong ones, then longer each time. */
export const FREE_TRIES = 5;
export const MAX_WAIT_MS = 5 * 60 * 1000;

export function retryDelayMs(failures: number): number {
  if (failures < FREE_TRIES) return 0;
  return Math.min(MAX_WAIT_MS, 30_000 * 2 ** (failures - FREE_TRIES));
}
