import { useLayoutEffect, type RefObject } from 'react';
import { MAX_DEVICE_PIXEL_RATIO } from '../constants';
import { get2dContext } from '../engine/renderer';
import type { CanvasSize } from '../types';
import { useLatestRef } from './useLatestRef';

export interface UsePageCanvasOptions {
  /** All canvases that share the page's size (kept in a stable array). */
  canvasRefs: ReadonlyArray<RefObject<HTMLCanvasElement | null>>;
  /** Page size in drawing units (page-local CSS px at zoom 1). */
  pageWidth: number;
  pageHeight: number;
  /** CSS pixels per drawing unit. */
  zoom: number;
  /**
   * Receives the logical size. `cssWidth`/`cssHeight` are the *drawing-unit*
   * dimensions (so `clearRect(0, 0, cssWidth, cssHeight)` clears the whole
   * surface under the installed transform) and `dpr` is the total
   * device-pixels-per-unit scale (`devicePixelRatio × zoom`).
   */
  sizeRef: RefObject<CanvasSize>;
  /** Called after the backing stores were (re)sized, which wipes them. */
  onResize: (size: CanvasSize) => void;
}

/**
 * Sizes a page's canvases from known page dimensions instead of observing a
 * container: backing store = `page × zoom × devicePixelRatio`, CSS size =
 * `page × zoom`, and a single `setTransform` so all drawing code works in
 * page-local units regardless of zoom or display density.
 */
export function usePageCanvas({
  canvasRefs,
  pageWidth,
  pageHeight,
  zoom,
  sizeRef,
  onResize,
}: UsePageCanvasOptions): void {
  const onResizeRef = useLatestRef(onResize);

  useLayoutEffect(() => {
    const apply = (): void => {
      if (pageWidth < 1 || pageHeight < 1 || zoom <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
      const cssWidth = pageWidth * zoom;
      const cssHeight = pageHeight * zoom;
      const pxWidth = Math.max(1, Math.round(cssWidth * dpr));
      const pxHeight = Math.max(1, Math.round(cssHeight * dpr));

      for (const ref of canvasRefs) {
        const canvas = ref.current;
        if (!canvas) continue;
        if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
          canvas.width = pxWidth;
          canvas.height = pxHeight;
        }
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        // Setting width/height resets context state, so (re)install the scale.
        get2dContext(canvas)?.setTransform(pxWidth / pageWidth, 0, 0, pxHeight / pageHeight, 0, 0);
      }

      const next: CanvasSize = { cssWidth: pageWidth, cssHeight: pageHeight, dpr: pxWidth / pageWidth };
      sizeRef.current = next;
      onResizeRef.current(next);
    };

    apply();

    // Re-apply when the window moves to a display with a different density.
    let mediaQuery: MediaQueryList | null = null;
    const onDprChange = (): void => {
      apply();
      watchDpr();
    };
    const watchDpr = (): void => {
      mediaQuery?.removeEventListener('change', onDprChange);
      mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mediaQuery.addEventListener('change', onDprChange);
    };
    watchDpr();

    return () => mediaQuery?.removeEventListener('change', onDprChange);
    // canvasRefs and sizeRef are stable refs; onResize is read through a ref.
  }, [pageWidth, pageHeight, zoom, canvasRefs, sizeRef, onResizeRef]);
}
