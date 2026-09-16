import { useEffect, useState } from 'react';
import { getRasterClient } from '../raster/rasterClient';
import { rasterCache, visualKey } from '../raster/rasterCache';
import type { PageVisual } from '../types';

/**
 * Bitmap of a page at `targetWidth` device px, served from the LRU cache and
 * rendered asynchronously (worker or idle main thread) on a miss. Returns
 * `null` until the first render for a given visual state completes.
 */
export function useRasterBitmap(pageId: string, page: PageVisual | null, targetWidth: number): ImageBitmap | null {
  const key = page && targetWidth > 0 ? visualKey(pageId, page, targetWidth) : null;
  const [state, setState] = useState<{ key: string | null; bitmap: ImageBitmap | null }>(() => ({
    key,
    bitmap: key ? rasterCache.get(key) : null,
  }));

  useEffect(() => {
    if (!key || !page) {
      setState({ key: null, bitmap: null });
      return;
    }
    const cached = rasterCache.get(key);
    if (cached) {
      setState({ key, bitmap: cached });
      return;
    }
    let cancelled = false;
    getRasterClient()
      .request(page, targetWidth)
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close();
          return;
        }
        rasterCache.set(key, bitmap);
        setState({ key, bitmap });
      })
      .catch(() => {
        /* keep whatever we had; the background colour + template still show */
      });
    return () => {
      cancelled = true;
    };
    // `page` and `targetWidth` are fully captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Never hand out a bitmap for a different visual state than the current one.
  return state.key === key ? state.bitmap : null;
}
