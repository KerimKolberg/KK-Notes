/**
 * The shapes the Rust side sends over IPC (`notes-sync`), mirrored here.
 *
 * Kept as a hand-written mirror rather than generated: there are six of them,
 * they change rarely, and a generator in the build would be more machinery
 * than the problem is worth. The field names match the `camelCase` serde
 * rename on the Rust structs.
 */

export interface LibraryEntry {
  /** Absolute path on this device. */
  readonly path: string;
  /** Path within the library root, `/`-separated. The name sync uses. */
  readonly relativePath: string;
  /** File name without `.notex`, or the folder's name. */
  readonly name: string;
  readonly isFolder: boolean;
  readonly bytes: number;
  readonly modifiedMs: number;
  readonly createdMs: number;
  /** Documents and folders directly inside a folder. */
  readonly childCount: number;
}

export interface LibraryListing {
  readonly path: string;
  readonly relativePath: string;
  /** `null` at the library root. */
  readonly parentPath: string | null;
  readonly entries: readonly LibraryEntry[];
}

export type SortKey = 'name' | 'modified' | 'created';
export type SortOrder = 'ascending' | 'descending';

export interface LibrarySort {
  readonly key: SortKey;
  readonly order: SortOrder;
}

export type LibraryLayout = 'grid' | 'list';

/** What a document card needs, without opening the document. */
export interface ThumbnailSource {
  readonly title: string;
  readonly pageCount: number;
  /** The first page as `SerializedPage`, or `null` for an empty document. */
  readonly page: unknown | null;
  readonly savedAt: string | null;
}

export type SyncPhase = 'offline' | 'syncing' | 'upToDate' | 'conflicted' | 'error';

export interface SyncStatus {
  readonly phase: SyncPhase;
  readonly provider: string;
  readonly pending: number;
  /** Relative paths waiting on an answer. */
  readonly conflicts: readonly string[];
  readonly lastSyncedMs: number;
  readonly message: string | null;
}

export type ConflictResolution = 'keepLocal' | 'keepRemote' | 'keepBoth';

export const OFFLINE_STATUS: SyncStatus = {
  phase: 'offline',
  provider: 'Not connected',
  pending: 0,
  conflicts: [],
  lastSyncedMs: 0,
  message: null,
};

export const DEFAULT_SORT: LibrarySort = { key: 'modified', order: 'descending' };

export const SORT_KEYS: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'modified', label: 'Date modified' },
  { key: 'created', label: 'Date created' },
];
