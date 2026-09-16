/**
 * Dedicated worker: receives page data, returns an ImageBitmap (transferred,
 * zero-copy). Keeps thumbnail / snapshot rendering off the main thread so
 * inking latency is unaffected by page management.
 */
import type { RasterWorkerRequest, RasterWorkerResponse } from './protocol';
import { rasterizePage } from './rasterize';

interface WorkerScope {
  onmessage: ((e: MessageEvent<RasterWorkerRequest>) => void) | null;
  postMessage(message: RasterWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e) => {
  const { id, page, targetWidth } = e.data;
  rasterizePage(page, targetWidth)
    .then((bitmap) => scope.postMessage({ id, bitmap }, [bitmap]))
    .catch((error: unknown) => scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }));
};
