import { useEffect, useState } from 'react';
import {
  EMPTY_SNAPSHOT,
  SLOW_COMMIT_MS,
  resetProfiler,
  setProfilingEnabled,
  subscribeProfiler,
  type ProfilerSnapshot,
} from './profiler';

export interface DebugOverlayProps {
  /** Collection and the overlay go on and off together; nothing is measured while it is closed. */
  enabled: boolean;
}

/** Below 55 fps something is being dropped; below 30 it is obvious to the eye. */
function fpsTone(fps: number): string {
  if (fps >= 55) return 'text-emerald-300';
  return fps >= 30 ? 'text-amber-300' : 'text-rose-300';
}

/**
 * Under ~25 ms a pen feels attached to the nib; past ~50 ms it visibly trails.
 * The thresholds are generous because this measures the main thread only —
 * the display adds its own frame or two on top.
 */
function latencyTone(ms: number): string {
  if (ms <= 25) return 'text-emerald-300';
  return ms <= 50 ? 'text-amber-300' : 'text-rose-300';
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function Line({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-white/50">{label}</span>
      <span className={`tabular-nums ${tone || 'text-white/90'}`}>{value}</span>
    </div>
  );
}

/**
 * A corner read-out of frame rate, ink latency and React commit cost.
 *
 * Deliberately inert: `pointer-events: none` throughout, so it can sit over
 * the page without ever swallowing a pen stroke aimed at what is underneath
 * it, and it repaints four times a second rather than per frame — an overlay
 * that cost a frame to draw would be measuring itself.
 */
export function DebugOverlay({ enabled }: DebugOverlayProps) {
  const [stats, setStats] = useState<ProfilerSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    setProfilingEnabled(enabled);
    if (!enabled) {
      setStats(EMPTY_SNAPSHOT);
      return;
    }
    const unsubscribe = subscribeProfiler(setStats);
    return () => {
      unsubscribe();
      setProfilingEnabled(false);
    };
  }, [enabled]);

  if (!enabled) return null;

  const slowCommits = stats.commits.reduce((total, c) => total + c.slow, 0);

  return (
    <div
      role="status"
      aria-live="off"
      aria-label="Performance monitor"
      data-debug-overlay
      className="pointer-events-none absolute z-50 w-44 select-none rounded-lg bg-zinc-950/80 p-2 font-mono text-[10px] leading-relaxed text-white shadow-lg backdrop-blur-sm"
      style={{ top: 'calc(0.5rem + var(--safe-top))', right: 'calc(0.5rem + var(--safe-right))' }}
    >
      <div className="mb-1 flex items-baseline justify-between border-b border-white/15 pb-1">
        <span className="font-semibold tracking-wide text-white/70">PERF</span>
        <span className={`text-sm font-bold tabular-nums ${fpsTone(stats.fps)}`} data-debug-fps>
          {stats.fps.toFixed(0)} fps
        </span>
      </div>

      <Line label="frame" value={`${ms(stats.frameMs)} / ${ms(stats.worstFrameMs)}`} />

      <div className="mt-1 border-t border-white/10 pt-1">
        <Line label="ink lag" value={ms(stats.latencyMs)} tone={latencyTone(stats.latencyMs)} />
        <Line label="p95" value={ms(stats.latencyP95Ms)} />
        <Line label="worst" value={ms(stats.worstLatencyMs)} />
        <Line label="samples" value={String(stats.latencySamples)} />
        <Line label="draw" value={`${ms(stats.drawMs)} / ${ms(stats.worstDrawMs)}`} />
      </div>

      <div className="mt-1 border-t border-white/10 pt-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-white/50">react</span>
          <span className={`tabular-nums ${slowCommits > 0 ? 'text-amber-300' : 'text-white/90'}`} data-debug-slow-commits>
            {slowCommits} over {SLOW_COMMIT_MS}ms
          </span>
        </div>
        {stats.commits.length === 0 ? (
          // A production bundle does not hand the Profiler commit timings; FPS
          // and latency are measured without React's help and keep working.
          <div className="text-white/40">no commit data</div>
        ) : (
          stats.commits.map((commit) => (
            <Line
              key={commit.id}
              label={commit.id}
              value={`${commit.commits}× ${ms(commit.averageMs)}`}
              tone={commit.slow > 0 ? 'text-amber-300' : ''}
            />
          ))
        )}
      </div>

      {/* Inert like the rest of the panel: a button here could eat a pen
          stroke. Resetting is available from the settings popover instead. */}
      <div className="mt-1 border-t border-white/10 pt-1 text-white/35">counters reset with the toggle</div>
    </div>
  );
}

export { resetProfiler };
