/**
 * Runtime performance metrics for the inking pipeline.
 *
 * Three numbers matter on a pen device, and none of them is visible from a
 * flame chart taken after the fact:
 *
 *  - **Frame rate**, counted from `requestAnimationFrame`, which is the only
 *    honest measure of whether the app is keeping up with the display.
 *  - **Ink latency**: how long it takes for a pointer sample to become
 *    pixels. This is the number a person actually feels as the pen "lagging
 *    behind the nib", and it is not the frame rate — a steady 60 fps with two
 *    frames of buffering feels worse than a jittery 50 with none.
 *  - **React commit duration**, to catch a state update that blocks the main
 *    thread between a pointer event and the frame it should have produced.
 *
 * Everything here is off by default and costs a single boolean test on the
 * hot path when it is: `profilingEnabled()` is read from a module-level
 * `let`, which a JIT keeps in a register. Nothing is allocated per sample,
 * and no timing is taken at all unless the flag is on — a profiler that
 * perturbs what it measures is worse than no profiler.
 *
 * Subscribers are notified on a slow tick (four times a second) rather than
 * per frame, so drawing the overlay cannot itself cost a frame.
 */
import { RollingWindow } from './rollingWindow';

/** A React commit slower than this dropped the app below 60 fps. */
export const SLOW_COMMIT_MS = 16;

/** Samples kept per statistic: about two seconds of frames, and a long tail of input. */
const FRAME_WINDOW = 120;
const LATENCY_WINDOW = 240;
const DRAW_WINDOW = 120;

/** How often subscribers hear about it, in ms. */
const PUBLISH_INTERVAL_MS = 250;

/**
 * A pointer timestamp further in the past than this is not a latency
 * measurement — it is a clock that does not share `performance.now()`'s time
 * origin, or a frame that painted long after the last input (a laser trail
 * fading out, say). Either way it would poison the average.
 */
const MAX_PLAUSIBLE_LATENCY_MS = 2000;

export interface CommitStat {
  readonly id: string;
  /** Renders committed since profiling was last reset. */
  readonly commits: number;
  readonly slow: number;
  readonly averageMs: number;
  readonly worstMs: number;
  readonly lastMs: number;
}

export interface ProfilerSnapshot {
  readonly enabled: boolean;
  /** Frames counted over the last second of wall clock. */
  readonly fps: number;
  /** Mean and worst interval between animation frames, ms. */
  readonly frameMs: number;
  readonly worstFrameMs: number;
  /** Pointer sample → live-canvas draw returned, ms. */
  readonly latencyMs: number;
  readonly latencyP95Ms: number;
  readonly worstLatencyMs: number;
  readonly latencySamples: number;
  /** Time inside the live canvas's own drawing, ms. */
  readonly drawMs: number;
  readonly worstDrawMs: number;
  /** React commits, newest boundary first. */
  readonly commits: readonly CommitStat[];
}

export const EMPTY_SNAPSHOT: ProfilerSnapshot = {
  enabled: false,
  fps: 0,
  frameMs: 0,
  worstFrameMs: 0,
  latencyMs: 0,
  latencyP95Ms: 0,
  worstLatencyMs: 0,
  latencySamples: 0,
  drawMs: 0,
  worstDrawMs: 0,
  commits: [],
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Read on every pointer move and every animation frame, so it is a plain
 * module-level binding rather than anything that needs a lookup.
 */
let enabled = false;

const frames = new RollingWindow(FRAME_WINDOW);
const latency = new RollingWindow(LATENCY_WINDOW);
const draws = new RollingWindow(DRAW_WINDOW);

interface CommitRecord {
  commits: number;
  slow: number;
  window: RollingWindow;
  worst: number;
  last: number;
}
const commits = new Map<string, CommitRecord>();

/**
 * The newest pointer timestamp not yet answered by a painted frame.
 *
 * Only the newest is kept: the frame that eventually paints shows where the
 * pen is *now*, so the honest measurement is against the last sample that
 * went into it. Averaging in the older coalesced samples would flatter the
 * number on a 240 Hz pen, which reports four samples per 60 Hz frame.
 *
 * `NOTHING_PENDING` is negative rather than 0 because 0 is a perfectly good
 * `DOMHighResTimeStamp` — the first frames after the time origin — and a
 * sentinel that collides with a real value drops those samples on the floor.
 */
const NOTHING_PENDING = -1;
let pendingInputAt = NOTHING_PENDING;

let loop = 0;
let lastFrameAt = 0;
let lastPublishAt = 0;
let framesThisSecond = 0;
let secondStartedAt = 0;
let fps = 0;

type Listener = (snapshot: ProfilerSnapshot) => void;
const listeners = new Set<Listener>();

// ---------------------------------------------------------------------------
// Hot path
// ---------------------------------------------------------------------------

/** True when metrics are being collected. Cheap enough to call per sample. */
export function profilingEnabled(): boolean {
  return enabled;
}

/**
 * Record that input arrived, with the event's own timestamp.
 *
 * `PointerEvent.timeStamp` shares its time origin with `performance.now()`,
 * and for a coalesced sample it is when the digitiser reported the point —
 * so this measures from the hardware, not from when the main thread got
 * round to the event. Call it with the *newest* sample of a coalesced batch.
 */
export function noteInput(eventTimeStamp: number): void {
  if (!enabled || !Number.isFinite(eventTimeStamp)) return;
  if (eventTimeStamp > pendingInputAt) pendingInputAt = eventTimeStamp;
}

/**
 * Close the measurement: the live canvas has finished drawing.
 *
 * What this times is the JS call returning, not the pixels lighting up — the
 * GPU work after `fill()` is not observable from here, and forcing it to be
 * (by reading a pixel back) would stall the pipeline and change the number it
 * was trying to report. So this is main-thread latency, which is the part the
 * app controls.
 */
export function noteFramePainted(startedAt: number, finishedAt: number): void {
  if (!enabled) return;
  draws.push(finishedAt - startedAt);
  if (pendingInputAt === NOTHING_PENDING) return;
  const delta = finishedAt - pendingInputAt;
  pendingInputAt = NOTHING_PENDING;
  // A negative delta means the two clocks disagree; a huge one means this
  // frame was not drawn in response to that input at all.
  if (delta >= 0 && delta <= MAX_PLAUSIBLE_LATENCY_MS) latency.push(delta);
}

/** Record a React commit. Called from a `<Profiler>`'s `onRender`. */
export function noteCommit(id: string, durationMs: number): void {
  if (!enabled || !Number.isFinite(durationMs)) return;
  let record = commits.get(id);
  if (!record) {
    record = { commits: 0, slow: 0, window: new RollingWindow(FRAME_WINDOW), worst: 0, last: 0 };
    commits.set(id, record);
  }
  record.commits++;
  record.last = durationMs;
  record.worst = Math.max(record.worst, durationMs);
  record.window.push(durationMs);
  if (durationMs > SLOW_COMMIT_MS) {
    record.slow++;
    // eslint-disable-next-line no-console
    console.warn(
      `[profiler] ${id} committed in ${durationMs.toFixed(1)}ms (> ${SLOW_COMMIT_MS}ms): this blocked the frame.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export function snapshot(): ProfilerSnapshot {
  return {
    enabled,
    fps,
    frameMs: frames.average,
    worstFrameMs: frames.max,
    latencyMs: latency.average,
    latencyP95Ms: latency.percentile(0.95),
    worstLatencyMs: latency.max,
    latencySamples: latency.count,
    drawMs: draws.average,
    worstDrawMs: draws.max,
    commits: [...commits.entries()].map(([id, record]) => ({
      id,
      commits: record.commits,
      slow: record.slow,
      averageMs: record.window.average,
      worstMs: record.worst,
      lastMs: record.last,
    })),
  };
}

function publish(): void {
  const current = snapshot();
  for (const listener of listeners) listener(current);
}

/**
 * The frame counter. Counting frames needs a callback on every frame, so
 * this loop is the one unavoidable cost of having the overlay open — which
 * is why it only runs while it is.
 */
function tick(now: number): void {
  loop = requestAnimationFrame(tick);
  if (lastFrameAt !== 0) frames.push(now - lastFrameAt);
  lastFrameAt = now;

  framesThisSecond++;
  if (now - secondStartedAt >= 1000) {
    fps = (framesThisSecond * 1000) / (now - secondStartedAt);
    framesThisSecond = 0;
    secondStartedAt = now;
  }

  if (now - lastPublishAt >= PUBLISH_INTERVAL_MS) {
    lastPublishAt = now;
    publish();
  }
}

export function resetProfiler(): void {
  frames.clear();
  latency.clear();
  draws.clear();
  commits.clear();
  pendingInputAt = NOTHING_PENDING;
  lastFrameAt = 0;
  framesThisSecond = 0;
  secondStartedAt = 0;
  fps = 0;
}

/** Turn collection on or off. Turning it on clears whatever was there before. */
export function setProfilingEnabled(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  resetProfiler();
  if (typeof requestAnimationFrame !== 'function') return;
  if (next) {
    secondStartedAt = performance.now();
    lastPublishAt = secondStartedAt;
    loop = requestAnimationFrame(tick);
  } else if (loop !== 0) {
    cancelAnimationFrame(loop);
    loop = 0;
    publish();
  }
}

/** Listen for snapshots. Fires immediately with the current one. */
export function subscribeProfiler(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}
