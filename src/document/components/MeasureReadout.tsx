import { memo, useEffect, useRef } from 'react';
import { getMeasureReading, subscribeMeasureReading, type MeasureReading } from '../../inking/measureReadout';

/** Gap between the read-out and the toolbar, and the least it keeps from the window's edge, in CSS px. */
const GAP = 10;
const EDGE = 8;

/**
 * Where the read-out goes: beside the toolbar, on the side towards the page, so the figures are near where the eye
 * goes for the tools and away from where the pen is. Above a toolbar at the bottom, below one at the top, beside one
 * at either side; above a free-floating one, or below it when it is too near the top.
 */
export function readoutPlacement(
  palette: { left: number; top: number; right: number; bottom: number },
  dock: string,
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  const centreX = (palette.left + palette.right) / 2 - size.width / 2;
  const centreY = (palette.top + palette.bottom) / 2 - size.height / 2;
  let left = centreX;
  let top = palette.top - GAP - size.height;
  if (dock === 'top') top = palette.bottom + GAP;
  else if (dock === 'left') [left, top] = [palette.right + GAP, centreY];
  else if (dock === 'right') [left, top] = [palette.left - GAP - size.width, centreY];
  else if (dock !== 'bottom' && top < EDGE) top = palette.bottom + GAP;
  return {
    left: Math.min(Math.max(EDGE, left), Math.max(EDGE, view.width - size.width - EDGE)),
    top: Math.min(Math.max(EDGE, top), Math.max(EDGE, view.height - size.height - EDGE)),
  };
}

/**
 * The figures a tool is measuring (`inking/measureReadout.ts`), shown beside the toolbar rather than on the page.
 *
 * Written straight into the DOM from the reading's subscription: a line being drawn changes its figures every frame,
 * and none of that needs React.
 */
export const MeasureReadout = memo(function MeasureReadout() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = (reading: MeasureReading | null): void => {
      const el = ref.current;
      if (!el) return;
      if (!reading) {
        el.hidden = true;
        return;
      }
      el.replaceChildren(
        ...reading.items.map((item) => {
          const span = document.createElement('span');
          span.textContent = item;
          return span;
        }),
      );
      el.hidden = false;
      const palette = document.querySelector<HTMLElement>('[data-tool-palette]');
      const rect = palette?.getBoundingClientRect();
      const size = { width: el.offsetWidth, height: el.offsetHeight };
      const view = { width: window.innerWidth, height: window.innerHeight };
      // No toolbar on screen (hidden, or a phone's sheet): the top of the window, out of the pen's way.
      const at = rect && rect.width > 0
        ? readoutPlacement(rect, palette?.dataset.dock ?? 'free', size, view)
        : { left: (view.width - size.width) / 2, top: EDGE + 56 };
      el.style.transform = `translate(${Math.round(at.left)}px, ${Math.round(at.top)}px)`;
    };
    show(getMeasureReading());
    return subscribeMeasureReading(show);
  }, []);

  return (
    <div
      ref={ref}
      hidden
      role="status"
      aria-live="off"
      data-measure-readout
      className="pointer-events-none fixed left-0 top-0 z-40 flex gap-3 rounded-lg bg-zinc-900/90 px-3 py-1.5 text-sm font-medium tabular-nums text-white shadow-lg"
    />
  );
});
