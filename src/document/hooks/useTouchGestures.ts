/**
 * Touch navigation for the document viewer:
 *
 * - one finger (Touch Draw off) pans the scroll container directly;
 * - exactly two fingers pan by the midpoint and pinch-zoom about the
 *   centroid. While two fingers are down every ink surface refuses touch
 *   input (see `gestureState`), so a pinch can never leave a stray mark even
 *   with Touch Draw on;
 * - the pen always wins: touches are ignored while a pen is nearby, a pen
 *   landing ends a pinch and cancels a one-finger pan (it was a palm).
 *
 * Pinches are previewed with a CSS transform on the scroll content and
 * committed once when the fingers lift; the host re-scrolls so the page
 * point under the centroid stays put after the layout is rebuilt.
 */
import { useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { beginTouchGesture, endTouchGesture, isPenNearby } from '../../inking/engine/gestureState';
import type { Point } from '../../inking/types';
import {
  anchorForContentPoint,
  panScroll,
  pinchStart,
  pinchUpdate,
  previewTransform,
  type GestureAnchor,
  type PinchStart,
  type PinchState,
} from '../gestures';
import type { DocumentLayout } from '../layout';
import { usePreferencesStore } from '../../preferences/store';

export interface TouchGestureCommit {
  /** Zoom the document should switch to (already rounded / clamped). */
  readonly zoom: number;
  /** Page point that must stay under the fingers, and where. */
  readonly anchor: GestureAnchor;
}

export interface UseTouchGesturesOptions {
  /** The scroll container. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The element that receives the pinch preview transform. */
  previewRef: RefObject<HTMLDivElement | null>;
  layoutRef: RefObject<DocumentLayout>;
  zoomRef: RefObject<number>;
  /**
   * Whether a single finger draws ink (then it must not pan). False while
   * Touch Draw is off and while the document is locked, so a locked page
   * always scrolls under one finger.
   */
  oneFingerInksRef: RefObject<boolean>;
  onCommit: (commit: TouchGestureCommit) => void;
}

type DivPointerHandler = (e: ReactPointerEvent<HTMLDivElement>) => void;

export interface TouchGestureHandlers {
  onPointerDown: DivPointerHandler;
  onPointerMove: DivPointerHandler;
  onPointerUp: DivPointerHandler;
  onPointerCancel: DivPointerHandler;
}

interface PanState {
  readonly kind: 'pan';
  readonly pointerId: number;
  readonly start: Point;
  readonly scroll: Point;
}

interface PinchGesture {
  readonly kind: 'pinch';
  readonly ids: readonly [number, number];
  readonly start: PinchStart;
  /** Scroll-content point under the starting centroid (transform origin). */
  readonly content: Point;
  readonly anchor: GestureAnchor | null;
  readonly offset: Point;
  last: PinchState;
}

/**
 * The pen scrolling the view: dragging the scrollbar (`thumb`, which moves the view the way a scrollbar does, by the
 * whole document for the length of the track) or pressed beside the pages (`content`, which moves it as a finger
 * does, with the pen).
 */
interface PenScrollState {
  readonly kind: 'pen-scroll';
  readonly pointerId: number;
  readonly mode: 'thumb' | 'content';
  readonly axis: 'x' | 'y';
  readonly start: Point;
  readonly scroll: Point;
}

/** A finger left over from a finished pinch is ignored until it lifts. */
interface BlockedState {
  readonly kind: 'blocked';
}

type GestureState = PanState | PinchGesture | BlockedState | PenScrollState | null;

/** Elements a single finger should operate instead of panning. */
const NO_PAN_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[data-image-toolbar]',
  '[data-resize-handle]',
  '[data-rotate-handle]',
  'img[data-image-id]',
  '[data-selection-box]',
  '[data-selection-handle]',
  '[data-selection-toolbar]',
].join(',');

function isNoPanTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NO_PAN_SELECTOR) !== null;
}

/** Anything on a page, or on the cover: the pen writes there, and does not scroll. */
const ON_A_PAGE_SELECTOR = ['[data-page-id]', '[data-cover]', NO_PAN_SELECTOR].join(',');

/**
 * Where a pen pressed on the view's own surface lands: on its scrollbar (and which), or beside the pages. `null` for
 * anything on a page. The scrollbar is no element: it is the strip of the scroller past its client box.
 */
export function penScrollTarget(
  box: { left: number; top: number; clientWidth: number; clientHeight: number; offsetWidth: number; offsetHeight: number },
  x: number,
  y: number,
  onPage: boolean,
): { mode: 'thumb' | 'content'; axis: 'x' | 'y' } | null {
  const verticalBar = box.offsetWidth > box.clientWidth && x >= box.left + box.clientWidth;
  const horizontalBar = box.offsetHeight > box.clientHeight && y >= box.top + box.clientHeight;
  if (verticalBar) return { mode: 'thumb', axis: 'y' };
  if (horizontalBar) return { mode: 'thumb', axis: 'x' };
  return onPage ? null : { mode: 'content', axis: 'y' };
}

/**
 * The scroll a pen dragging the scrollbar's thumb by `delta` (window px along the bar) asks for: the thumb covers the
 * track as the view covers the document, so a px of thumb is `scrollSize / viewSize` px of document.
 */
export function thumbScroll(startScroll: number, delta: number, scrollSize: number, viewSize: number): number {
  if (viewSize <= 0) return startScroll;
  return Math.min(Math.max(0, startScroll + (delta * scrollSize) / viewSize), Math.max(0, scrollSize - viewSize));
}

function capture(el: HTMLElement, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* synthetic pointer or capture unsupported */
  }
}

export function useTouchGestures(options: UseTouchGesturesOptions): TouchGestureHandlers {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const controller = useMemo(() => {
    const touches = new Map<number, Point>();
    let state: GestureState = null;

    const clearPreview = (): void => {
      const el = optionsRef.current.previewRef.current;
      if (el) el.style.transform = '';
    };

    const finishPinch = (): void => {
      if (state?.kind !== 'pinch') return;
      const pinch = state;
      state = touches.size > 0 ? { kind: 'blocked' } : null;
      endTouchGesture();
      const { last, anchor } = pinch;
      const { scrollRef, onCommit } = optionsRef.current;
      const el = scrollRef.current;
      if (!el) {
        clearPreview();
        return;
      }
      const offset = { x: pinch.offset.x + last.pan.x, y: pinch.offset.y + last.pan.y };
      if (anchor) {
        onCommit({ zoom: last.zoom, anchor: { ...anchor, offset } });
      } else {
        // Nothing to anchor on (empty layout): just pan and clear the preview.
        const scroll = panScroll({ x: el.scrollLeft, y: el.scrollTop }, last.pan);
        el.scrollLeft = scroll.x;
        el.scrollTop = scroll.y;
        clearPreview();
      }
    };

    const cancelPan = (): void => {
      if (state?.kind === 'pan') state = null;
    };

    const startPinch = (a: number, b: number): void => {
      const { scrollRef, layoutRef, zoomRef } = optionsRef.current;
      const el = scrollRef.current;
      const pa = touches.get(a);
      const pb = touches.get(b);
      if (!el || !pa || !pb) return;
      const zoom = zoomRef.current;
      const start = pinchStart(pa, pb, zoom);
      const rect = el.getBoundingClientRect();
      const offset = { x: start.mid.x - rect.left, y: start.mid.y - rect.top };
      const content = { x: offset.x + el.scrollLeft, y: offset.y + el.scrollTop };
      const anchor = anchorForContentPoint(layoutRef.current.items, content, zoom, offset, layoutRef.current.axis);
      state = {
        kind: 'pinch',
        ids: [a, b],
        start,
        content,
        anchor,
        offset,
        last: pinchUpdate(start, pa, pb, undefined, undefined, usePreferencesStore.getState().zoom),
      };
      beginTouchGesture();
      capture(el, a);
      capture(el, b);
    };

    const updatePinch = (): void => {
      if (state?.kind !== 'pinch') return;
      const pa = touches.get(state.ids[0]);
      const pb = touches.get(state.ids[1]);
      if (!pa || !pb) return;
      state.last = pinchUpdate(state.start, pa, pb, undefined, undefined, usePreferencesStore.getState().zoom);
      const preview = optionsRef.current.previewRef.current;
      if (!preview) return;
      const css = previewTransform(state.content, state.last.pan, state.last.scale);
      preview.style.transformOrigin = css.transformOrigin;
      preview.style.transform = css.transform;
    };

    const onPointerDown: DivPointerHandler = (e) => {
      if (e.pointerType === 'pen') {
        // A pen landing means any finger down was a palm: stop navigating.
        if (state?.kind === 'pinch') finishPinch();
        else cancelPan();
        // The pen on the view's own surface (its scrollbar, or beside the pages) scrolls it. Left to the web view, a
        // pen on the scrollbar jumped the view about, left it blank, and selected text on the way (reported on the
        // Flow Z13, in a screen recording), since the view takes no touch actions of its own (`touch-action: none`).
        const el = optionsRef.current.scrollRef.current;
        if (!el || state !== null || e.button !== 0) return;
        const onPage = e.target instanceof Element && e.target.closest(ON_A_PAGE_SELECTOR) !== null;
        const rect = el.getBoundingClientRect();
        const target = penScrollTarget(
          { left: rect.left, top: rect.top, clientWidth: el.clientWidth, clientHeight: el.clientHeight, offsetWidth: el.offsetWidth, offsetHeight: el.offsetHeight },
          e.clientX,
          e.clientY,
          onPage,
        );
        if (!target) return;
        e.preventDefault();
        if (target.mode === 'thumb') {
          // Pressed on the track rather than on the thumb: the thumb comes to the pen first, as a scrollbar's does.
          const along = target.axis === 'y' ? e.clientY - rect.top : e.clientX - rect.left;
          const view = target.axis === 'y' ? el.clientHeight : el.clientWidth;
          const size = target.axis === 'y' ? el.scrollHeight : el.scrollWidth;
          const scroll = target.axis === 'y' ? el.scrollTop : el.scrollLeft;
          const thumbStart = (scroll / size) * view;
          const thumbLength = (view / size) * view;
          if (along < thumbStart || along > thumbStart + thumbLength) {
            const centred = thumbScroll(0, along - thumbLength / 2, size, view);
            if (target.axis === 'y') el.scrollTop = centred;
            else el.scrollLeft = centred;
          }
        }
        state = { kind: 'pen-scroll', pointerId: e.pointerId, mode: target.mode, axis: target.axis, start: { x: e.clientX, y: e.clientY }, scroll: { x: el.scrollLeft, y: el.scrollTop } };
        capture(el, e.pointerId);
        return;
      }
      if (e.pointerType !== 'touch') return;
      if (isPenNearby()) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touches.size === 2 && state?.kind !== 'pinch') {
        const [a, b] = [...touches.keys()];
        if (a !== undefined && b !== undefined) startPinch(a, b);
        return;
      }
      if (touches.size !== 1 || state !== null) return;
      const el = optionsRef.current.scrollRef.current;
      if (!el || optionsRef.current.oneFingerInksRef.current || isNoPanTarget(e.target)) return;
      state = {
        kind: 'pan',
        pointerId: e.pointerId,
        start: { x: e.clientX, y: e.clientY },
        scroll: { x: el.scrollLeft, y: el.scrollTop },
      };
      capture(el, e.pointerId);
    };

    const onPointerMove: DivPointerHandler = (e) => {
      if (e.pointerType === 'pen') {
        if (state?.kind === 'pen-scroll' && state.pointerId === e.pointerId) {
          const el = optionsRef.current.scrollRef.current;
          if (!el) return;
          const dx = e.clientX - state.start.x;
          const dy = e.clientY - state.start.y;
          if (state.mode === 'thumb') {
            if (state.axis === 'y') el.scrollTop = thumbScroll(state.scroll.y, dy, el.scrollHeight, el.clientHeight);
            else el.scrollLeft = thumbScroll(state.scroll.x, dx, el.scrollWidth, el.clientWidth);
          } else {
            const scroll = panScroll(state.scroll, { x: dx, y: dy });
            el.scrollLeft = scroll.x;
            el.scrollTop = scroll.y;
          }
          return;
        }
        // Pen hovering over a one-finger pan: that finger is a resting palm.
        cancelPan();
        return;
      }
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (state?.kind === 'pinch') {
        if (state.ids.includes(e.pointerId)) updatePinch();
      } else if (state?.kind === 'pan' && state.pointerId === e.pointerId) {
        if (isPenNearby()) {
          cancelPan();
          return;
        }
        const el = optionsRef.current.scrollRef.current;
        if (!el) return;
        const scroll = panScroll(state.scroll, { x: e.clientX - state.start.x, y: e.clientY - state.start.y });
        el.scrollLeft = scroll.x;
        el.scrollTop = scroll.y;
      }
    };

    const onPointerEnd: DivPointerHandler = (e) => {
      if (state?.kind === 'pen-scroll') {
        if (state.pointerId === e.pointerId) state = null;
        return;
      }
      if (e.pointerType !== 'touch') return;
      if (!touches.delete(e.pointerId)) return;
      if (state?.kind === 'pinch') {
        if (state.ids.includes(e.pointerId)) finishPinch();
      } else if (state?.kind === 'pan') {
        if (state.pointerId === e.pointerId) state = null;
      }
      if (state?.kind === 'blocked' && touches.size === 0) state = null;
    };

    /** Unmount: drop everything without committing. */
    const reset = (): void => {
      if (state?.kind === 'pinch') {
        endTouchGesture();
        clearPreview();
      }
      touches.clear();
      state = null;
    };

    return { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, reset };
  }, []);

  useEffect(() => () => controller.reset(), [controller]);

  const { reset: _reset, ...handlers } = controller;
  return handlers;
}
