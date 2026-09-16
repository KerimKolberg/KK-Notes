import type { PageVisual } from '../types';

export interface RasterWorkerRequest {
  readonly id: number;
  readonly page: PageVisual;
  readonly targetWidth: number;
}

export type RasterWorkerResponse =
  | { readonly id: number; readonly bitmap: ImageBitmap }
  | { readonly id: number; readonly error: string };
