/**
 * Front door for rasterisation: a module Worker when the platform allows it,
 * otherwise a serial main-thread queue that yields between jobs.
 */
import { renderPdfPageBitmap } from '../../pdf/pdfRenderer';
import type { PageVisual } from '../types';
import type { RasterWorkerRequest, RasterWorkerResponse } from './protocol';
import { rasterizePage } from './rasterize';

/** The worker never needs PDF bytes; strip them so the message stays small. */
function forWorker(page: PageVisual): PageVisual {
  if (!page.pdf) return page;
  const { pdf: _pdf, ...rest } = page;
  return rest;
}

interface Pending {
  readonly resolve: (bitmap: ImageBitmap) => void;
  readonly reject: (error: Error) => void;
}

export class RasterClient {
  private worker: Worker | null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.worker = this.createWorker();
  }

  get usesWorker(): boolean {
    return this.worker !== null;
  }

  request(page: PageVisual, targetWidth: number): Promise<ImageBitmap> {
    if (page.pdf) return this.requestPdfPage(page, targetWidth);
    if (this.worker) {
      return this.requestFromWorker(this.worker, forWorker(page), targetWidth).catch(() =>
        // The worker died or rejected: fall back for this and future requests.
        this.requestOnMainThread(page, targetWidth),
      );
    }
    return this.requestOnMainThread(page, targetWidth);
  }

  /** PDF.js renders the background here; strokes and images are composed on top. */
  private requestPdfPage(page: PageVisual, targetWidth: number): Promise<ImageBitmap> {
    const ref = page.pdf;
    if (!ref) return this.requestOnMainThread(page, targetWidth);
    const job = this.queue
      .then(() => renderPdfPageBitmap(ref, targetWidth))
      .then((background) => rasterizePage(page, targetWidth, background));
    this.queue = job.catch(() => undefined);
    return job;
  }

  dispose(): void {
    this.worker?.terminate();
    this.failAll(new Error('RasterClient disposed'));
    this.worker = null;
  }

  private requestFromWorker(worker: Worker, page: PageVisual, targetWidth: number): Promise<ImageBitmap> {
    return new Promise<ImageBitmap>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const message: RasterWorkerRequest = { id, page, targetWidth };
      try {
        worker.postMessage(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private requestOnMainThread(page: PageVisual, targetWidth: number): Promise<ImageBitmap> {
    const job = this.queue
      .then(() => new Promise<void>((r) => setTimeout(r, 0)))
      .then(() => rasterizePage(page, targetWidth));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private createWorker(): Worker | null {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
    try {
      const worker = new Worker(new URL('./rasterWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<RasterWorkerResponse>) => {
        const entry = this.pending.get(e.data.id);
        if (!entry) return;
        this.pending.delete(e.data.id);
        if ('bitmap' in e.data) entry.resolve(e.data.bitmap);
        else entry.reject(new Error(e.data.error));
      };
      worker.onerror = () => {
        this.failAll(new Error('Raster worker failed'));
        worker.terminate();
        this.worker = null;
      };
      return worker;
    } catch {
      return null;
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

let singleton: RasterClient | null = null;

export function getRasterClient(): RasterClient {
  singleton ??= new RasterClient();
  return singleton;
}
