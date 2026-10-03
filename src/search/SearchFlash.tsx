import { memo, useEffect } from 'react';
import { FLASH_MS, useFlashStore } from './flashStore';

/** Room around the word, in page units, so the mark rings it rather than cutting through its letters. */
const PAD = 6;

/**
 * The mark on a page over a search result's place — a ring that pulses and fades. Drawn in the page's own units
 * stretched over the page, so it sits on the word at any zoom, and it takes no pointer events.
 */
export const SearchFlash = memo(function SearchFlash({ pageId, width, height }: { readonly pageId: string; readonly width: number; readonly height: number }) {
  const flash = useFlashStore((s) => (s.flash?.pageId === pageId ? s.flash : null));
  const clear = useFlashStore((s) => s.clear);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => clear(flash.seq), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash, clear]);
  if (!flash) return null;
  const { box } = flash;
  return (
    <svg
      key={flash.seq}
      className="search-flash pointer-events-none absolute inset-0 z-[37] h-full w-full"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-search-flash
    >
      <rect
        x={box.x - PAD}
        y={box.y - PAD}
        width={box.width + PAD * 2}
        height={box.height + PAD * 2}
        rx={8}
        fill="rgba(250, 204, 21, 0.28)"
        stroke="#f59e0b"
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
});
