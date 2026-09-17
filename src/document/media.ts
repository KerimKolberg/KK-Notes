/**
 * Pure image-layer maths: placement, translation, rotation, anchored resize
 * and z-ordering. Units are page px; rotation is degrees clockwise about the
 * box centre (CSS convention, y down).
 */
import { createStrokeId } from '../inking/engine/ids';
import type { Point } from '../inking/types';
import { IMAGE_MAX_FRACTION, MIN_IMAGE_SIZE } from './constants';
import type { ImageLayer, PageDimensions } from './types';

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Rotate a vector by `deg` clockwise (screen coordinates, y down). */
export function rotateVector(dx: number, dy: number, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

export function imageCenter(image: ImageLayer): Point {
  return { x: image.x + image.width / 2, y: image.y + image.height / 2 };
}

export function normalizeDegrees(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

export function nextZIndex(images: readonly ImageLayer[]): number {
  return images.reduce((max, img) => Math.max(max, img.zIndex), 0) + 1;
}

export interface CreateImageInit {
  readonly src: string;
  readonly mime: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly page: PageDimensions;
  /** Centre of the placed image; defaults to the page centre. */
  readonly at?: Point;
  readonly zIndex: number;
}

/** Place an image at natural size, shrunk uniformly to fit `IMAGE_MAX_FRACTION` of the page width. */
export function createImageLayer(init: CreateImageInit): ImageLayer {
  const maxWidth = init.page.width * IMAGE_MAX_FRACTION;
  const maxHeight = init.page.height * IMAGE_MAX_FRACTION;
  const natW = Math.max(1, init.naturalWidth);
  const natH = Math.max(1, init.naturalHeight);
  const fit = Math.min(1, maxWidth / natW, maxHeight / natH);
  const width = Math.max(MIN_IMAGE_SIZE, natW * fit);
  const height = Math.max(MIN_IMAGE_SIZE, natH * fit);
  const centre = init.at ?? { x: init.page.width / 2, y: init.page.height / 2 };
  return {
    id: `img_${createStrokeId()}`,
    src: init.src,
    mime: init.mime,
    x: centre.x - width / 2,
    y: centre.y - height / 2,
    width,
    height,
    rotation: 0,
    zIndex: init.zIndex,
    naturalWidth: natW,
    naturalHeight: natH,
  };
}

export function moveImage(image: ImageLayer, dx: number, dy: number): ImageLayer {
  return dx === 0 && dy === 0 ? image : { ...image, x: image.x + dx, y: image.y + dy };
}

export function rotateImage(image: ImageLayer, rotation: number): ImageLayer {
  const r = normalizeDegrees(rotation);
  return r === image.rotation ? image : { ...image, rotation: r };
}

/** Which box edges a handle moves: −1 = min edge, +1 = max edge, 0 = neither. */
function handleAxes(handle: ResizeHandle): { hx: -1 | 0 | 1; hy: -1 | 0 | 1 } {
  const hx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0;
  const hy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0;
  return { hx, hy };
}

/**
 * Resize by dragging `handle` by (`localDx`, `localDy`) — the pointer delta
 * expressed in the image's own (unrotated) frame. The opposite edge / corner
 * stays fixed in world space, which is what makes rotated boxes resize the
 * way users expect.
 */
export function resizeImage(
  image: ImageLayer,
  handle: ResizeHandle,
  localDx: number,
  localDy: number,
  keepAspect: boolean,
  minSize = MIN_IMAGE_SIZE,
): ImageLayer {
  const { hx, hy } = handleAxes(handle);
  const aspect = image.width / image.height;

  let width = image.width + hx * localDx;
  let height = image.height + hy * localDy;

  if (keepAspect) {
    if (hx !== 0 && hy !== 0) {
      // Corner: follow the axis the pointer moved most along.
      if (Math.abs(localDx) * image.height >= Math.abs(localDy) * image.width) height = width / aspect;
      else width = height * aspect;
    } else if (hx !== 0) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
  }

  width = Math.max(minSize, width);
  height = Math.max(minSize, height);
  if (keepAspect) {
    // Re-impose the ratio after clamping.
    if (width / height > aspect) width = height * aspect;
    else height = width / aspect;
  }

  // Anchor = the point opposite the handle (centre of the opposite edge, or the opposite corner).
  const centre = imageCenter(image);
  const anchorOffset = rotateVector((-hx * image.width) / 2, (-hy * image.height) / 2, image.rotation);
  const anchor = { x: centre.x + anchorOffset.x, y: centre.y + anchorOffset.y };
  const newOffset = rotateVector((-hx * width) / 2, (-hy * height) / 2, image.rotation);
  const newCentre = { x: anchor.x - newOffset.x, y: anchor.y - newOffset.y };

  return { ...image, x: newCentre.x - width / 2, y: newCentre.y - height / 2, width, height };
}

/** Convert a world (page) delta into the image's local frame. */
export function toLocalDelta(image: ImageLayer, dx: number, dy: number): Point {
  return rotateVector(dx, dy, -image.rotation);
}

/** Point-in-rotated-box test in page px. */
export function pointInImage(image: ImageLayer, p: Point): boolean {
  const c = imageCenter(image);
  const local = rotateVector(p.x - c.x, p.y - c.y, -image.rotation);
  return Math.abs(local.x) <= image.width / 2 && Math.abs(local.y) <= image.height / 2;
}

/** Handle positions in page px (world space) for the current rotation. */
export function handlePositions(image: ImageLayer): Record<ResizeHandle, Point> {
  const c = imageCenter(image);
  const at = (hx: number, hy: number): Point => {
    const v = rotateVector((hx * image.width) / 2, (hy * image.height) / 2, image.rotation);
    return { x: c.x + v.x, y: c.y + v.y };
  };
  return { nw: at(-1, -1), n: at(0, -1), ne: at(1, -1), e: at(1, 0), se: at(1, 1), s: at(0, 1), sw: at(-1, 1), w: at(-1, 0) };
}

/** Rotation from the box centre to a pointer position, degrees clockwise, with the handle at the top. */
export function rotationFromPointer(image: ImageLayer, p: Point, snapDeg = 0): number {
  const c = imageCenter(image);
  const deg = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
  const snapped = snapDeg > 0 ? Math.round(deg / snapDeg) * snapDeg : deg;
  return normalizeDegrees(snapped);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function renormalize(images: readonly ImageLayer[]): ImageLayer[] {
  return [...images]
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((img, i) => (img.zIndex === i + 1 ? img : { ...img, zIndex: i + 1 }));
}

export function sortedByZ(images: readonly ImageLayer[]): ImageLayer[] {
  return [...images].sort((a, b) => a.zIndex - b.zIndex);
}

export function addImage(images: readonly ImageLayer[], image: ImageLayer): ImageLayer[] {
  return renormalize([...images, { ...image, zIndex: nextZIndex(images) }]);
}

export function updateImage(images: readonly ImageLayer[], id: string, patch: Partial<ImageLayer>): ImageLayer[] {
  const index = images.findIndex((img) => img.id === id);
  const current = images[index];
  if (!current) return [...images];
  const next = [...images];
  next[index] = { ...current, ...patch, id: current.id };
  return next;
}

export function removeImage(images: readonly ImageLayer[], id: string): ImageLayer[] {
  return renormalize(images.filter((img) => img.id !== id));
}

export function bringToFront(images: readonly ImageLayer[], id: string): ImageLayer[] {
  const target = images.find((img) => img.id === id);
  if (!target) return [...images];
  return renormalize(images.map((img) => (img.id === id ? { ...img, zIndex: nextZIndex(images) } : img)));
}

export function sendToBack(images: readonly ImageLayer[], id: string): ImageLayer[] {
  const target = images.find((img) => img.id === id);
  if (!target) return [...images];
  return renormalize(images.map((img) => (img.id === id ? { ...img, zIndex: 0 } : img)));
}

/** Parse a data URL into its MIME type and bytes. */
export function dataUrlToBytes(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return null;
  const mime = m[1] ?? 'application/octet-stream';
  const payload = m[3] ?? '';
  if (m[2]) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime, bytes };
  }
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}
