/**
 * What is read out of a PDF — a page's words, where they sit, its contents list — kept per source.
 *
 * Each is read with PDF.js from the file it already holds parsed, and does not change, so it is read once and the
 * promise kept: callers asking again while it is still being read share the one reading. A reading that fails is not
 * kept (the next ask tries again), the least recently used goes once a cache is full, and releasing a source
 * (`releasePdfSource`, when its last tab closes) clears everything read from it, in every cache.
 */

interface Entry<T> {
  readonly sourceId: string;
  readonly value: Promise<T>;
}

const all = new Set<SourceCache<unknown>>();

export class SourceCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly max: number) {
    all.add(this as SourceCache<unknown>);
  }

  /** The value for `key` of the source `sourceId`, read with `load` the first time it is asked for. */
  get(sourceId: string, key: string, load: () => Promise<T>): Promise<T> {
    const id = `${sourceId}\u0000${key}`;
    const cached = this.entries.get(id);
    if (cached) {
      // Most recently used last, so the oldest is the one let go.
      this.entries.delete(id);
      this.entries.set(id, cached);
      return cached.value;
    }
    const value = load();
    const entry = { sourceId, value };
    this.entries.set(id, entry);
    value.catch(() => {
      if (this.entries.get(id) === entry) this.entries.delete(id);
    });
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return value;
  }

  /** Forget everything read from one source. */
  release(sourceId: string): void {
    for (const [id, entry] of this.entries) if (entry.sourceId === sourceId) this.entries.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Forget everything read from a source, in every cache. */
export function releaseSourceCaches(sourceId: string): void {
  for (const cache of all) cache.release(sourceId);
}
