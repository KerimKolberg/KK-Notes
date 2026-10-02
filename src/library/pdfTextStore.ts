/**
 * The words of the PDFs in the library's notes, kept between runs.
 *
 * Reading a PDF's words means parsing the PDF, which for a long lecture is seconds; the words of an embedded PDF
 * never change (a source's bytes are fixed once imported, and a new import is a new source), so they are read
 * once and kept by source id, in IndexedDB. A plain in-memory map stands in where there is no IndexedDB (tests,
 * a private window that refuses it): searches still work, they just read again next time.
 */

/** Where the words are kept. */
export interface PdfTextStore {
  /** Each page's words, or `null` when this source has not been read. */
  get(sourceId: string): Promise<readonly string[] | null>;
  put(sourceId: string, pages: readonly string[]): Promise<void>;
  /** Every source kept. */
  keys(): Promise<string[]>;
  delete(sourceId: string): Promise<void>;
}

export function memoryPdfTextStore(): PdfTextStore {
  const map = new Map<string, readonly string[]>();
  return {
    get: async (id) => map.get(id) ?? null,
    put: async (id, pages) => {
      map.set(id, pages);
    },
    keys: async () => [...map.keys()],
    delete: async (id) => {
      map.delete(id);
    },
  };
}

const DB_NAME = 'kk-notes-search';
const STORE = 'pdf-text';

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB would not open'));
    open.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

/** IndexedDB, falling back to memory for the rest of the session the first time it fails. */
export function persistentPdfTextStore(): PdfTextStore {
  const memory = memoryPdfTextStore();
  let db: Promise<IDBDatabase> | null = null;
  let broken = typeof indexedDB === 'undefined';
  const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    db ??= openDb();
    const store = (await db).transaction(STORE, mode).objectStore(STORE);
    return request(run(store));
  };
  const guard = async <T>(persistent: () => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    if (broken) return fallback();
    try {
      return await persistent();
    } catch {
      broken = true;
      return fallback();
    }
  };
  return {
    get: (id) =>
      guard(
        async () => {
          const value: unknown = await withStore('readonly', (s) => s.get(id));
          return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null;
        },
        () => memory.get(id),
      ),
    put: (id, pages) =>
      guard(
        async () => {
          await withStore('readwrite', (s) => s.put([...pages], id));
        },
        () => memory.put(id, pages),
      ),
    keys: () =>
      guard(
        async () => (await withStore('readonly', (s) => s.getAllKeys())).map(String),
        () => memory.keys(),
      ),
    delete: (id) =>
      guard(
        async () => {
          await withStore('readwrite', (s) => s.delete(id));
        },
        () => memory.delete(id),
      ),
  };
}
