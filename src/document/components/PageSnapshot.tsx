import { memo, useEffect, useRef } from 'react';
import { SNAPSHOT_MAX_SIDE } from '../constants';
import { useRasterBitmap } from '../hooks/useRasterBitmap';
import type { Page } from '../types';

export interface PageSnapshotProps {
  page: Page;
  /** On-screen size of the page in CSS px. */
  cssWidth: number;
  cssHeight: number;
}

/**
 * Cheap stand-in for an off-screen page: a single canvas showing a cached
 * raster of background + template + strokes. Costs one texture instead of
 * three full-resolution layers and no event handlers.
 */
export const PageSnapshot = memo(function PageSnapshot({ page, cssWidth, cssHeight }: PageSnapshotProps) {
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const longest = Math.max(cssWidth, cssHeight) * dpr;
  const scaleDown = longest > SNAPSHOT_MAX_SIDE ? SNAPSHOT_MAX_SIDE / longest : 1;
  const targetWidth = Math.max(1, Math.round(cssWidth * dpr * scaleDown));
  const bitmap = useRasterBitmap(page.id, page, targetWidth);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bitmap || bitmap.width === 0) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(bitmap, 0, 0);
    } catch {
      /* bitmap was closed by cache eviction; the next render refreshes it */
    }
  }, [bitmap]);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 block h-full w-full"
      data-snapshot={page.id}
      data-snapshot-ready={bitmap ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
});
