import { memo, useEffect, useRef } from 'react';
import { THUMBNAIL_WIDTH } from '../constants';
import type { ReorderItemProps } from '../hooks/usePointerReorder';
import { useRasterBitmap } from '../hooks/useRasterBitmap';
import type { Page } from '../types';

export interface PageThumbnailProps {
  page: Page;
  index: number;
  selected: boolean;
  dragging: boolean;
  dropTarget: boolean;
  itemProps: ReorderItemProps;
}

/** Thumbnail card: cached bitmap of the page plus its number. */
export const PageThumbnail = memo(function PageThumbnail({ page, index, selected, dragging, dropTarget, itemProps }: PageThumbnailProps) {
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 2);
  const bitmap = useRasterBitmap(page.id, page, THUMBNAIL_WIDTH * dpr);
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
      /* closed by cache eviction; refreshed on next render */
    }
  }, [bitmap]);

  const { ref, ...handlers } = itemProps;
  const aspect = `${page.dimensions.width} / ${page.dimensions.height}`;

  return (
    <li className="list-none" data-thumbnail-index={index}>
      <button
        type="button"
        ref={ref}
        {...handlers}
        aria-label={`Page ${page.pageNumber}`}
        aria-current={selected ? 'page' : undefined}
        data-thumbnail={page.id}
        data-thumbnail-ready={bitmap ? 'true' : 'false'}
        style={{ touchAction: 'pan-y' }}
        className={`group flex w-full flex-col items-stretch gap-1.5 rounded-xl p-2 text-left transition-[background-color,opacity,transform] select-none ${
          selected ? 'bg-blue-50 dark:bg-blue-950/50' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/70'
        } ${dragging ? 'scale-95 opacity-50' : ''} ${dropTarget ? 'ring-2 ring-blue-500' : ''} focus-visible:outline-2 focus-visible:outline-blue-500`}
      >
        <div
          className={`relative w-full overflow-hidden rounded-md shadow ring-1 ${selected ? 'ring-blue-500' : 'ring-black/10 dark:ring-white/10'}`}
          style={{ aspectRatio: aspect, backgroundColor: page.backgroundColor }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" aria-hidden="true" />
        </div>
        <span className="text-center text-xs font-medium tabular-nums text-zinc-600 dark:text-zinc-300">{page.pageNumber}</span>
      </button>
    </li>
  );
});
