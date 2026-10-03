import { useEffect } from 'react';
import { useDesktopStore } from '../desktop/desktopStore';
import { isPenNearby, notePenPresence } from '../inking/engine/gestureState';
import { useDocumentStore } from '../document/store';
import { useTabStore } from '../document/tabStore';
import type { Page } from '../document/types';
import { snipPage } from './capture';
import { dragRect, isSnip, pageRegion, type Rect } from './geometry';
import { useSnipStore } from './snipStore';
import { errorMessage } from '../lib/errors';

/** Every page on screen, in the editor and in the reference pane. */
const FRAME = '[data-page-index], [data-reference-page-frame]';

/** The page a frame on screen shows, and what to call the document it is in. */
export function pageOfFrame(frame: HTMLElement): { page: Page; from: string } | null {
  if (frame.dataset.pageIndex !== undefined) {
    const doc = useDocumentStore.getState().document;
    const page = doc.pages[Number(frame.dataset.pageIndex)];
    return page ? { page, from: doc.title || 'Untitled note' } : null;
  }
  const id = frame.dataset.referencePageId;
  const { tabs, splitId } = useTabStore.getState();
  const tab = tabs.find((t) => t.id === splitId);
  const page = tab?.session?.document.pages.find((p) => p.id === id);
  return page && tab ? { page, from: tab.title } : null;
}

function asRect(r: DOMRect): Rect {
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * Snipping: while it is on, dragging a pen, a mouse or a finger over a page — in the editor or the reference pane —
 * cuts the rectangle out as a snip instead of drawing or scrolling. A second finger landing during a drag ends it and
 * is left to the page's own gestures, and a finger that lands while a pen is near is a palm and is ignored, as it
 * is for drawing.
 *
 * It listens in the capture phase on the window, so the drag never reaches the page's own handlers and nothing is
 * drawn or selected under it; and it draws its rubber band as one element it moves directly, not through React.
 */
export function useSnipping(): void {
  const mode = useSnipStore((s) => s.mode);

  useEffect(() => {
    if (!mode) return;
    document.documentElement.dataset.snipping = 'true';

    let drag: { frame: HTMLElement; frameRect: Rect; start: { x: number; y: number }; marquee: HTMLDivElement; pointerId: number } | null = null;

    const show = (e: PointerEvent): Rect => {
      const d = drag!;
      const rect = dragRect(d.start, { x: e.clientX, y: e.clientY }, d.frameRect);
      Object.assign(d.marquee.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      return rect;
    };
    const end = (): void => {
      drag?.marquee.remove();
      drag = null;
    };

    const onDown = (e: PointerEvent): void => {
      if (e.pointerType === 'pen') notePenPresence();
      if (drag) {
        // A second finger: not a snip any more, and for the page to make of what it will (a pinch).
        if (e.pointerType === 'touch') end();
        return;
      }
      if (e.button !== 0) return;
      if (e.pointerType === 'touch' && isPenNearby()) return;
      const frame = e.target instanceof Element ? e.target.closest<HTMLElement>(FRAME) : null;
      if (!frame) return;
      e.preventDefault();
      e.stopPropagation();
      const marquee = document.createElement('div');
      marquee.setAttribute('data-snip-marquee', '');
      Object.assign(marquee.style, {
        position: 'fixed',
        zIndex: '9998',
        pointerEvents: 'none',
        border: '2px dashed #2563eb',
        background: 'rgba(37, 99, 235, 0.12)',
      });
      document.body.append(marquee);
      drag = { frame, frameRect: asRect(frame.getBoundingClientRect()), start: { x: e.clientX, y: e.clientY }, marquee, pointerId: e.pointerId };
      show(e);
    };
    const onMove = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      show(e);
    };
    const onUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      e.preventDefault();
      e.stopPropagation();
      const { frame, frameRect } = drag;
      const rect = show(e);
      end();
      if (!isSnip(rect)) return;
      const found = pageOfFrame(frame);
      if (!found) return;
      snipPage(found.page, pageRegion(rect, frameRect, found.page.dimensions), found.from).then(
        (snip) => useSnipStore.getState().add(snip),
        (error: unknown) =>
          useDesktopStore.getState().setNotice({ text: `Could not snip that: ${errorMessage(error)}` }),
      );
    };
    const onCancel = (): void => end();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (drag) end();
      else useSnipStore.getState().setMode(false);
    };

    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey);
      end();
      delete document.documentElement.dataset.snipping;
    };
  }, [mode]);
}
