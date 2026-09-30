/**
 * The protractor: a half disc lying on the page, to read an angle off.
 *
 * Pure geometry in page units. It stands on its base line with the vertex at `(x, y)`
 * — the point a real one has a notch at — and is turned about that point. Its scale
 * runs 0° to 180° round the arc, both ways, so either end of the base can be zero.
 */
import type { Point } from '../types';

export interface Protractor {
  /** The vertex: the middle of the base, where the angle's corner goes. */
  readonly x: number;
  readonly y: number;
  /** Radians, clockwise on the page: 0 has the base along the page's top edge, the arc above it. */
  readonly angle: number;
  /** Of the arc. */
  readonly radius: number;
}

export const PROTRACTOR_RADIUS = 170;
export const PROTRACTOR_MIN_RADIUS = 60;

export function initialProtractor(page: { readonly width: number; readonly height: number }): Protractor {
  const radius = Math.min(PROTRACTOR_RADIUS, Math.max(PROTRACTOR_MIN_RADIUS, page.width / 2 - 40));
  return { x: page.width / 2, y: page.height * 0.5, angle: 0, radius };
}

export function keepProtractorOnPage(p: Protractor, page: { readonly width: number; readonly height: number }): Protractor {
  const x = Math.min(page.width, Math.max(0, p.x));
  const y = Math.min(page.height, Math.max(0, p.y));
  return x === p.x && y === p.y ? p : { ...p, x, y };
}

export interface ProtractorTick {
  /** Degrees from the base's right end, round the arc to its left. */
  readonly degrees: number;
  readonly kind: 'ten' | 'five' | 'one';
}

/** A mark for every degree, the fives and tens set apart. */
export function protractorTicks(): ProtractorTick[] {
  const out: ProtractorTick[] = [];
  for (let d = 0; d <= 180; d++) out.push({ degrees: d, kind: d % 10 === 0 ? 'ten' : d % 5 === 0 ? 'five' : 'one' });
  return out;
}

/**
 * Where the mark for `degrees` is at `distance` from the vertex, before the protractor is
 * turned: 0° on the right of the base, 90° straight up, 180° on the left.
 */
export function protractorPoint(p: Protractor, degrees: number, distance: number): Point {
  const a = -(degrees * Math.PI) / 180 + p.angle;
  return { x: p.x + distance * Math.cos(a), y: p.y + distance * Math.sin(a) };
}

/**
 * The angle, in degrees from the base's right end, of the direction from the vertex to `at`
 * as the protractor reads it; `null` when the point is at the vertex or below the base,
 * where there is no scale to read it from.
 */
export function readAngle(p: Protractor, at: Point): number | null {
  const dx = at.x - p.x;
  const dy = at.y - p.y;
  if (Math.hypot(dx, dy) < 1e-9) return null;
  // Into the protractor's own frame (undo its turn), y up.
  const cos = Math.cos(-p.angle);
  const sin = Math.sin(-p.angle);
  const lx = dx * cos - dy * sin;
  const ly = -(dx * sin + dy * cos);
  // A hair below the base is the base: the marks at 0° and 180° sit exactly on it.
  if (ly < -1e-6) return null;
  return (Math.atan2(Math.max(0, ly), lx) * 180) / Math.PI;
}
