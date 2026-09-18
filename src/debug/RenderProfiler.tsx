import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react';
import { noteCommit } from './profiler';

const onRender: ProfilerOnRenderCallback = (id, _phase, actualDuration) => {
  // `noteCommit` is a no-op — and logs nothing — while profiling is off.
  noteCommit(id, actualDuration);
};

export interface RenderProfilerProps {
  id: string;
  children: ReactNode;
}

/**
 * A `<Profiler>` boundary that is always present.
 *
 * Mounting it conditionally would be cheaper, but switching a Profiler in and
 * out changes the element type at that position, so React would tear down and
 * rebuild everything inside it — losing the canvases, the scroll position and
 * any stroke in progress every time debug mode was toggled. Keeping the
 * boundary and making its callback inert instead costs nothing measurable and
 * leaves the tree alone.
 *
 * React only supplies commit timings from a development (or profiling) build;
 * in a plain production bundle these counters simply stay empty, while the
 * frame rate and ink latency — which are measured without React's help — keep
 * working.
 */
export function RenderProfiler({ id, children }: RenderProfilerProps) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
