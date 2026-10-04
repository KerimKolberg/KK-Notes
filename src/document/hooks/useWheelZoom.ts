import { useEffect, type RefObject } from 'react';
import { MAX_ZOOM, MIN_ZOOM } from '../constants';
import { anchorForContentPoint, wheelZoomFactor, type GestureAnchor } from '../gestures';
import { clampZoom, type DocumentLayout, type LayoutAxis } from '../layout';
import type { TouchGestureCommit } from './useTouchGestures';

/** Quiet this long after the last wheel event and the zoom is committed. */
export const WHEEL_ZOOM_SETTLE_MS = 160;

export interface UseWheelZoomOptions {
  scrollRef: RefObject<HTMLDivElement | null>;
  previewRef: RefObject<HTMLDivElement | null>;
  layoutRef: RefObject<DocumentLayout>;
  zoomRef: RefObject<number>;
  axisRef: RefObject<LayoutAxis>;
  /** The same commit a two-finger pinch on the screen makes. */
  onCommit: (commit: TouchGestureCommit) => void;
  /** A zoom with nothing under the pointer to hold on to, which keeps the middle of the view where it is. */
  setZoom: (zoom: number) => void;
}

interface WheelGesture {
  readonly startZoom: number;
  /** Scroll-content point under the pointer when the gesture began: the transform origin. */
  readonly content: { readonly x: number; readonly y: number };
  readonly anchor: GestureAnchor | null;
  /** Not rounded: a slow pinch is many steps of a fraction of a percent, which rounding each would lose. */
  zoom: number;
}

/**
 * Zooming with a touchpad pinch, and with Ctrl + the mouse wheel.
 *
 * A pinch on a laptop's touchpad does not reach the page as touches — the touch screen's two-finger handling never
 * sees it — but as Ctrl + wheel events. Those are taken here (the listener is not passive, so the webview's own zoom
 * never happens) and handled as a pinch on the screen is: the page point under the pointer stays where it is, the
 * zoom is previewed with a transform while the fingers move, and committed once, a moment after they stop, so the
 * pages are laid out and drawn again once rather than at every step.
 */
export function useWheelZoom({ scrollRef, previewRef, layoutRef, zoomRef, axisRef, onCommit, setZoom }: UseWheelZoomOptions): void {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let gesture: WheelGesture | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const commit = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const g = gesture;
      gesture = null;
      if (!g) return;
      const zoom = clampZoom(g.zoom);
      if (g.anchor) {
        onCommit({ zoom, anchor: g.anchor });
        return;
      }
      // Nothing under the pointer to hold on to (beside the pages): zoom as the toolbar does, about the middle.
      const preview = previewRef.current;
      if (preview) preview.style.transform = '';
      setZoom(zoom);
    };

    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) {
        // Scrolling again: settle the zoom first, so the scroll moves what is on screen.
        if (gesture) commit();
        return;
      }
      e.preventDefault();
      if (!gesture) {
        const rect = el.getBoundingClientRect();
        const offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const content = { x: offset.x + el.scrollLeft, y: offset.y + el.scrollTop };
        const zoom = zoomRef.current;
        gesture = { startZoom: zoom, content, anchor: anchorForContentPoint(layoutRef.current.items, content, zoom, offset, axisRef.current), zoom };
      }
      gesture.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, gesture.zoom * wheelZoomFactor(e.deltaY, e.deltaMode)));
      const preview = previewRef.current;
      if (preview) {
        preview.style.transformOrigin = `${gesture.content.x}px ${gesture.content.y}px`;
        preview.style.transform = `scale(${gesture.zoom / gesture.startZoom})`;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(commit, WHEEL_ZOOM_SETTLE_MS);
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (timer !== null) clearTimeout(timer);
      if (gesture && previewRef.current) previewRef.current.style.transform = '';
    };
  }, [scrollRef, previewRef, layoutRef, zoomRef, axisRef, onCommit, setZoom]);
}
