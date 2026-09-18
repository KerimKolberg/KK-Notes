/**
 * A fixed-size window of recent numbers, for the profiler's moving averages.
 *
 * Nothing is allocated per sample: the values live in one pre-sized
 * `Float64Array` written round-robin, so pushing from a pointer handler at
 * 240 Hz cannot itself become the thing that drops frames. The mean is kept
 * as a running sum with the evicted value subtracted, which makes reading it
 * O(1) — and re-summed from the buffer once per wrap, because a running sum
 * that is only ever added to and subtracted from drifts as rounding errors
 * accumulate, and a latency read-out that slowly diverges from the truth is
 * worse than none.
 *
 * Statistics that need the whole window (the maximum, a percentile) are
 * computed on read rather than maintained on write: they are read a few times
 * a second and written thousands of times, so the cost belongs on the read.
 */
export class RollingWindow {
  private readonly buffer: Float64Array;
  private readonly capacity: number;
  /** Where the next value goes. */
  private head = 0;
  private filled = 0;
  private sum = 0;
  /** Pushes since the sum was last recomputed from the buffer. */
  private sinceResum = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.buffer = new Float64Array(this.capacity);
  }

  /** Add a sample. Values that are not finite numbers are dropped. */
  push(value: number): void {
    if (!Number.isFinite(value)) return;
    const evicted = this.filled === this.capacity ? (this.buffer[this.head] ?? 0) : 0;
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
    this.sum += value - evicted;
    if (++this.sinceResum >= this.capacity) this.resum();
  }

  /** Recompute the sum from the values themselves, clearing accumulated drift. */
  private resum(): void {
    let total = 0;
    for (let i = 0; i < this.filled; i++) total += this.buffer[i] ?? 0;
    this.sum = total;
    this.sinceResum = 0;
  }

  get count(): number {
    return this.filled;
  }

  get full(): boolean {
    return this.filled === this.capacity;
  }

  /** Mean of the window, or 0 while it is empty. */
  get average(): number {
    return this.filled === 0 ? 0 : this.sum / this.filled;
  }

  /** The most recent sample, or 0 while the window is empty. */
  get latest(): number {
    if (this.filled === 0) return 0;
    return this.buffer[(this.head + this.capacity - 1) % this.capacity] ?? 0;
  }

  get max(): number {
    let worst = 0;
    for (let i = 0; i < this.filled; i++) worst = Math.max(worst, this.buffer[i] ?? 0);
    return worst;
  }

  /**
   * The value at `fraction` through the sorted window (0.95 → the 95th
   * percentile), using nearest-rank. The tail is what a latency figure is
   * really about: a mean of 8 ms hides a stutter that a p95 of 40 ms does not.
   */
  percentile(fraction: number): number {
    if (this.filled === 0) return 0;
    const sorted = this.values().sort((a, b) => a - b);
    const clamped = Math.min(1, Math.max(0, fraction));
    const rank = Math.ceil(clamped * sorted.length);
    return sorted[Math.max(0, rank - 1)] ?? 0;
  }

  /** The window's samples, oldest first. */
  values(): number[] {
    const out: number[] = [];
    const start = this.filled === this.capacity ? this.head : 0;
    for (let i = 0; i < this.filled; i++) out.push(this.buffer[(start + i) % this.capacity] ?? 0);
    return out;
  }

  clear(): void {
    this.buffer.fill(0);
    this.head = 0;
    this.filled = 0;
    this.sum = 0;
    this.sinceResum = 0;
  }
}
