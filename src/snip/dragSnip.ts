import { viewportToPagePoint } from '../document/layout';
import { useDocumentStore } from '../document/store';
import { useTabStore } from '../document/tabStore';
import { placeSnip } from './place';
import type { Snip } from './snipStore';

/** How far a press has to move before it is a drag and not a tap. */
const DRAG_START_PX = 5;
/** How long a snip held over a tab before that tab opens, as in a browser. */
export const TAB_DWELL_MS = 550;

/**
 * Drag a snip out of the tray onto a page.
 *
 * With pointer events rather than the browser's drag-and-drop, so that a pen drags as well as a mouse, and so that
 * the page under the pointer can be lit up and a tab it rests on can be opened on the way — the snip is usually
 * cut in one tab and wanted in another. Dropping on a page puts the snip there, centred on the pointer; dropping
 * anywhere else does nothing, and the snip stays in the tray.
 */
export function dragSnip(snip: Snip, start: PointerEvent): void {
  if (start.button !== 0) return;
  let dragging = false;
  let ghost: HTMLImageElement | null = null;
  let lit: HTMLElement | null = null;
  let hovered: { el: HTMLElement; id: string; timer: number } | null = null;

  const light = (el: HTMLElement | null, attr: string, current: HTMLElement | null): HTMLElement | null => {
    if (current === el) return current;
    current?.removeAttribute(attr);
    el?.setAttribute(attr, '');
    return el;
  };
  const stopHover = (): void => {
    if (!hovered) return;
    window.clearTimeout(hovered.timer);
    hovered.el.removeAttribute('data-snip-hover');
    hovered = null;
  };

  const move = (e: PointerEvent): void => {
    if (!dragging) {
      if (Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) < DRAG_START_PX) return;
      dragging = true;
      ghost = document.createElement('img');
      ghost.src = snip.src;
      ghost.alt = '';
      ghost.setAttribute('data-snip-ghost', '');
      Object.assign(ghost.style, {
        position: 'fixed',
        zIndex: '9999',
        pointerEvents: 'none',
        maxWidth: '220px',
        maxHeight: '160px',
        opacity: '0.85',
        border: '2px solid #2563eb',
        background: '#fff',
        boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
      });
      document.body.append(ghost);
    }
    e.preventDefault();
    if (ghost) {
      ghost.style.left = `${e.clientX - ghost.width / 2}px`;
      ghost.style.top = `${e.clientY - ghost.height / 2}px`;
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    lit = light(under?.closest<HTMLElement>('[data-page-index]') ?? null, 'data-snip-target', lit);

    // Resting on a tab for a moment opens it, so the snip can be carried to the note it is for.
    const tab = under?.closest<HTMLElement>('[data-tab-id]') ?? null;
    const id = tab?.dataset.tabId;
    if (tab && id && id !== useTabStore.getState().activeId) {
      if (hovered?.id !== id) {
        stopHover();
        tab.setAttribute('data-snip-hover', '');
        hovered = { el: tab, id, timer: window.setTimeout(() => void useTabStore.getState().activate(id).then(stopHover), TAB_DWELL_MS) };
      }
    } else {
      stopHover();
    }
  };

  const finish = (e: PointerEvent): void => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', cancel, true);
    ghost?.remove();
    ghost = null;
    light(null, 'data-snip-target', lit);
    lit = null;
    stopHover();
    if (!dragging) return;
    const frame = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-page-index]') ?? null;
    if (!frame) return;
    const pageIndex = Number(frame.dataset.pageIndex);
    const zoom = useDocumentStore.getState().document.zoom;
    placeSnip(snip, { pageIndex, at: viewportToPagePoint(e.clientX, e.clientY, frame.getBoundingClientRect(), zoom) });
  };
  const cancel = (e: PointerEvent): void => {
    dragging = false;
    finish(e);
  };

  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', cancel, true);
}
