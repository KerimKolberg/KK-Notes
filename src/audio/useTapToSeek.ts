import { useEffect } from 'react';
import { useDocumentStore } from '../document/store';
import { playFrom, say, usePlayerStore } from './player';
import { markAt } from './replay';

/** How near ink (screen pixels) a tap has to land to count as on it. */
const TAP_RADIUS_PX = 10;

/**
 * With the player open and "tap ink" on, tapping writing plays the recording from when it was written.
 *
 * It listens in the capture phase on the window, as snipping and selecting text do, so a tap meant for the player
 * never reaches the page and draws a dot. A pen or a mouse never draws on a page while it is on; a finger that misses
 * the writing is left alone, so it still scrolls.
 */
export function useTapToSeek(): void {
  const on = usePlayerStore((s) => s.open && s.tapToSeek);

  useEffect(() => {
    if (!on) return;
    document.documentElement.dataset.tapToSeek = 'true';

    const onPointerDown = (e: PointerEvent): void => {
      if (!e.isPrimary || e.button !== 0) return;
      const frame = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-page-index]') : null;
      if (!frame) return;
      const page = useDocumentStore.getState().document.pages[Number(frame.dataset.pageIndex)];
      const { markTimes } = usePlayerStore.getState();
      if (!page || !markTimes) return;
      const rect = frame.getBoundingClientRect();
      const scale = page.dimensions.width / Math.max(1, rect.width);
      const x = (e.clientX - rect.left) * scale;
      const y = (e.clientY - rect.top) * (page.dimensions.height / Math.max(1, rect.height));
      const t = markAt(page.strokes, markTimes, x, y, TAP_RADIUS_PX * scale);
      if (t === null && e.pointerType === 'touch') return;
      e.preventDefault();
      e.stopPropagation();
      if (t !== null) {
        playFrom(t);
        return;
      }
      if (markAt(page.strokes, everyStroke(page.strokes), x, y, TAP_RADIUS_PX * scale) !== null) {
        say('Not written during this recording');
      }
    };
    // The rest of a press that was taken is not the page's either.
    const taken = new Set<number>();
    const down = (e: PointerEvent): void => {
      onPointerDown(e);
      if (e.defaultPrevented) taken.add(e.pointerId);
    };
    const swallow = (e: PointerEvent): void => {
      if (!taken.has(e.pointerId)) return;
      e.stopPropagation();
      if (e.type !== 'pointermove') taken.delete(e.pointerId);
    };

    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', swallow, true);
    window.addEventListener('pointerup', swallow, true);
    window.addEventListener('pointercancel', swallow, true);
    return () => {
      delete document.documentElement.dataset.tapToSeek;
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', swallow, true);
      window.removeEventListener('pointerup', swallow, true);
      window.removeEventListener('pointercancel', swallow, true);
    };
  }, [on]);
}

/** Every stroke at time 0: to tell writing from paper under a tap. */
function everyStroke(strokes: readonly { readonly id: string }[]): ReadonlyMap<string, number> {
  return new Map(strokes.map((s) => [s.id, 0]));
}
