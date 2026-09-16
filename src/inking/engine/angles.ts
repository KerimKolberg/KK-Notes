/**
 * Angle helpers. Canvas space has y pointing down, so a "canvas angle" from
 * `atan2(dy, dx)` increases clockwise. Readouts use the math convention
 * (counter-clockwise, y up) because that is what STEM users expect.
 */
import type { Point } from '../types';

export const TAU = Math.PI * 2;

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Wrap to (-π, π]. */
export function normalizeRadians(rad: number): number {
  let a = rad % TAU;
  if (a <= -Math.PI) a += TAU;
  else if (a > Math.PI) a -= TAU;
  return a;
}

/** Direction from `from` to `to`, canvas orientation. */
export function angleOf(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Canvas angle → math-convention degrees in [0, 360). */
export function canvasAngleToMathDegrees(rad: number): number {
  const deg = -toDegrees(rad);
  const wrapped = ((deg % 360) + 360) % 360;
  // Avoid "360.0°" from tiny negative rounding.
  return wrapped >= 359.95 ? 0 : wrapped;
}

/** Round to the nearest multiple of `incrementDeg`. */
export function snapAngle(rad: number, incrementDeg: number): number {
  if (incrementDeg <= 0) return rad;
  const inc = toRadians(incrementDeg);
  return normalizeRadians(Math.round(rad / inc) * inc);
}

/** Rotate `to` about `from` so the segment lies on a snapped angle, keeping its length. */
export function snapLineEnd(from: Point, to: Point, incrementDeg: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0) return to;
  const a = snapAngle(angleOf(from, to), incrementDeg);
  return { x: from.x + length * Math.cos(a), y: from.y + length * Math.sin(a) };
}

/** Unsigned angle between two direction vectors, in [0, π]. */
export function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
  const dot = ux * vx + uy * vy;
  const cross = ux * vy - uy * vx;
  return Math.abs(Math.atan2(cross, dot));
}

/** Interior angle at `vertex` formed by rays towards `a` and `b`, in degrees [0, 180]. */
export function interiorAngleDeg(vertex: Point, a: Point, b: Point): number {
  return toDegrees(angleBetween(a.x - vertex.x, a.y - vertex.y, b.x - vertex.x, b.y - vertex.y));
}

/** Acute angle between two (undirected) lines, in degrees [0, 90]. */
export function acuteAngleDeg(dirA: number, dirB: number): number {
  const d = Math.abs(toDegrees(normalizeRadians(dirA - dirB)));
  return d > 90 ? 180 - d : d;
}

export function formatDegrees(deg: number): string {
  return `${deg.toFixed(1)}°`;
}
