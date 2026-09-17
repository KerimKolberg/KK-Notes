import { memo, useEffect, useRef, useState } from 'react';
import type { Page } from '../document/types';
import { backgroundWidthBucket, renderPdfPageBitmap } from './pdfRenderer';

export interface PdfBackgroundProps {
  page: Page;
  /** On-screen page width in CSS px. */
  cssWidth: number;
}

/**
 * z-0 background for PDF-backed pages: the PDF.js raster (without form
 * widgets) drawn on a canvas that keeps the PDF's aspect ratio and is
 * anchored at the page's top-left.
 */
export const PdfBackground = memo(function PdfBackground({ page, cssWidth }: PdfBackgroundProps) {
  const ref = page.pdf;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = backgroundWidthBucket(Math.max(1, cssWidth), dpr);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const sourceId = ref?.sourceId ?? '';
  const pageIndex = ref?.pageIndex ?? -1;
  const rotation = ref?.rotation ?? 0;

  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    renderPdfPageBitmap(ref, targetWidth)
      .then((b) => {
        if (!cancelled) setBitmap(b);
      })
      .catch(() => {
        /* keep the plain background colour */
      });
    return () => {
      cancelled = true;
    };
    // `ref` is identified by these three values; `data` never changes for a source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, pageIndex, rotation, targetWidth]);

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
      /* evicted; the next render refreshes */
    }
  }, [bitmap]);

  if (!ref) return null;
  const aspect = bitmap && bitmap.width > 0 ? `${bitmap.width} / ${bitmap.height}` : undefined;
  return (
    <canvas
      ref={canvasRef}
      className="absolute left-0 top-0 z-0 block w-full"
      style={aspect ? { aspectRatio: aspect } : { height: '100%' }}
      data-pdf-background={`${sourceId}#${pageIndex}`}
      data-pdf-ready={bitmap ? 'true' : 'false'}
      aria-hidden="true"
    />
  );
});
