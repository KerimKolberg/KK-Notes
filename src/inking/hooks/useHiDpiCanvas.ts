import { useLayoutEffect, type RefObject } from 'react';
import { MAX_DEVICE_PIXEL_RATIO } from '../constants';
import { get2dContext } from '../engine/renderer';
import type { CanvasSize } from '../types';
import { useLatestRef } from './useLatestRef';

export interface UseHiDpiCanvasOptions {
  containerRef: RefObject<HTMLElement | null>;
  /** All canvases that must share the container's size (kept in a stable array). */
  canvasRefs: ReadonlyArray<RefObject<HTMLCanvasElement | null>>;
  /** Written on every size / DPR change. */
  sizeRef: RefObject<CanvasSize>;
  /** Called after the backing stores were resized (which wipes them). */
  onResize: (size: CanvasSize) => void;
}

/**
 * Keeps the canvases' backing stores at `container size × devicePixelRatio`
 * and installs a matching scale transform so all drawing code can work in CSS
 * pixels. Prefers `device-pixel-content-box` observation for an exact pixel
 * size (avoids blurry half-pixel seams), with a matchMedia fallback for DPR
 * changes on browsers that only report the content box.
 */
export function useHiDpiCanvas({
  containerRef,
  canvasRefs,
  sizeRef,
  onResize,
}: UseHiDpiCanvasOptions): void {
  const onResizeRef = useLatestRef(onResize);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const apply = (cssWidth: number, cssHeight: number, devW?: number, devH?: number): void => {
      if (cssWidth < 1 || cssHeight < 1) return;
      const rawDpr = window.devicePixelRatio || 1;
      const dpr = Math.min(rawDpr, MAX_DEVICE_PIXEL_RATIO);

      // Prefer the observer's exact device-pixel box (no half-pixel seams), but
      // only when it agrees with `css × devicePixelRatio`: some engines report
      // it without accounting for emulated or clamped scale factors.
      const expectedW = cssWidth * dpr;
      const expectedH = cssHeight * dpr;
      const useExact =
        devW !== undefined &&
        devH !== undefined &&
        Math.abs(devW - expectedW) <= 1 &&
        Math.abs(devH - expectedH) <= 1;
      const pxWidth = useExact ? devW : Math.max(1, Math.round(expectedW));
      const pxHeight = useExact ? devH : Math.max(1, Math.round(expectedH));

      for (const ref of canvasRefs) {
        const canvas = ref.current;
        if (!canvas) continue;
        if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
          canvas.width = pxWidth;
          canvas.height = pxHeight;
        }
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        const ctx = get2dContext(canvas);
        // Setting width/height resets context state, so (re)install the scale.
        ctx?.setTransform(pxWidth / cssWidth, 0, 0, pxHeight / cssHeight, 0, 0);
      }

      const next: CanvasSize = { cssWidth, cssHeight, dpr: pxWidth / cssWidth };
      sizeRef.current = next;
      onResizeRef.current(next);
    };

    const measure = (): void => {
      const rect = container.getBoundingClientRect();
      apply(rect.width, rect.height);
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const content = entry.contentBoxSize?.[0];
      const cssWidth = content ? content.inlineSize : entry.contentRect.width;
      const cssHeight = content ? content.blockSize : entry.contentRect.height;
      const device = entry.devicePixelContentBoxSize?.[0];
      if (device) apply(cssWidth, cssHeight, device.inlineSize, device.blockSize);
      else apply(cssWidth, cssHeight);
    });

    try {
      observer.observe(container, { box: 'device-pixel-content-box' });
    } catch {
      observer.observe(container);
    }

    // Fallback for DPR changes (window moved between monitors) where the
    // observer only reports CSS boxes: re-arm a media query at the current DPR.
    let mediaQuery: MediaQueryList | null = null;
    const onDprChange = (): void => {
      measure();
      watchDpr();
    };
    const watchDpr = (): void => {
      mediaQuery?.removeEventListener('change', onDprChange);
      mediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mediaQuery.addEventListener('change', onDprChange);
    };
    watchDpr();

    // Size synchronously on mount so the first paint is already crisp.
    measure();

    return () => {
      observer.disconnect();
      mediaQuery?.removeEventListener('change', onDprChange);
    };
    // Deliberately mount-only: every input is a stable ref.
  }, []);
}
