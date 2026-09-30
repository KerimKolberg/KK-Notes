/**
 * Earlier versions of a note, kept by the shell each time a save replaces the file.
 *
 * The shell does the keeping and the thinning (see `notes-sync`'s `history`); this is the
 * frontend's view of it: listing what is kept, putting one back, and saying when and how big.
 */
import { parseNotex } from './notex';
import { tauriInvoke } from './tauri';
import type { Document } from '../document/types';

export interface NoteVersion {
  /** When this version was saved, in ms since the epoch. Also its name. */
  readonly id: number;
  readonly bytes: number;
  readonly title: string;
  readonly pageCount: number;
}

interface OpenedPayload {
  readonly path: string;
  readonly contents: string;
}

export async function listVersions(path: string): Promise<NoteVersion[]> {
  return tauriInvoke<NoteVersion[]>('list_versions', { path });
}

/** Put a version back as the file at `path`; the shell keeps what was there first. */
export async function restoreVersion(path: string, id: number): Promise<Document> {
  const opened = await tauriInvoke<OpenedPayload>('restore_version', { path, id });
  return parseNotex(opened.contents).document;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "5 days ago", or a date for older. */
export function describeAge(then: number, now: number): string {
  const age = Math.max(0, now - then);
  if (age < MINUTE) return 'just now';
  if (age < HOUR) {
    const m = Math.round(age / MINUTE);
    return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  }
  if (age < DAY) {
    const h = Math.round(age / HOUR);
    return h === 1 ? '1 hour ago' : `${h} hours ago`;
  }
  const d = Math.floor(age / DAY);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d} days ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The day and time a version was saved, in the reader's own format. */
export function describeTime(then: number): string {
  return new Date(then).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "1 page", "12 pages", "No pages". */
export function describePages(count: number): string {
  return count === 0 ? 'No pages' : count === 1 ? '1 page' : `${count} pages`;
}

/** "640 B", "12 KB", "3.4 MB". */
export function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
