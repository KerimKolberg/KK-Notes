import { describe, expect, it } from 'vitest';
import {
  acuteAngleDeg,
  angleOf,
  canvasAngleToMathDegrees,
  formatDegrees,
  interiorAngleDeg,
  normalizeRadians,
  snapAngle,
  snapLineEnd,
  toRadians,
} from '../engine/angles';

describe('angles', () => {
  it('converts canvas angles (y down) to math degrees (y up)', () => {
    expect(canvasAngleToMathDegrees(angleOf({ x: 0, y: 0 }, { x: 10, y: 0 }))).toBeCloseTo(0);
    expect(canvasAngleToMathDegrees(angleOf({ x: 0, y: 0 }, { x: 10, y: -10 }))).toBeCloseTo(45);
    expect(canvasAngleToMathDegrees(angleOf({ x: 0, y: 0 }, { x: 0, y: -10 }))).toBeCloseTo(90);
    expect(canvasAngleToMathDegrees(angleOf({ x: 0, y: 0 }, { x: 0, y: 10 }))).toBeCloseTo(270);
    // Tiny rounding on either side of zero must read as 0, never 360.
    expect(canvasAngleToMathDegrees(-1e-12)).toBeCloseTo(0, 6);
    expect(canvasAngleToMathDegrees(1e-12)).toBe(0);
  });

  it('wraps radians into (-π, π]', () => {
    expect(normalizeRadians(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeRadians(-3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeRadians(0.5)).toBeCloseTo(0.5);
  });

  it('snaps to 15° increments, rounding to the nearest', () => {
    expect(snapAngle(toRadians(7), 15)).toBeCloseTo(0);
    expect(snapAngle(toRadians(8), 15)).toBeCloseTo(toRadians(15));
    expect(snapAngle(toRadians(37), 15)).toBeCloseTo(toRadians(30));
    expect(snapAngle(toRadians(38), 15)).toBeCloseTo(toRadians(45));
    expect(snapAngle(toRadians(-52), 15)).toBeCloseTo(toRadians(-45));
    expect(snapAngle(toRadians(88), 15)).toBeCloseTo(toRadians(90));
  });

  it('snapping with a non-positive increment is a no-op', () => {
    expect(snapAngle(0.3, 0)).toBe(0.3);
  });

  it('snapLineEnd keeps the length and rotates the end point', () => {
    const from = { x: 100, y: 100 };
    const to = { x: 100 + 50 * Math.cos(toRadians(40)), y: 100 - 50 * Math.sin(toRadians(40)) };
    const snapped = snapLineEnd(from, to, 15);
    expect(Math.hypot(snapped.x - from.x, snapped.y - from.y)).toBeCloseTo(50, 6);
    expect(canvasAngleToMathDegrees(angleOf(from, snapped))).toBeCloseTo(45, 6);
    expect(snapLineEnd(from, from, 15)).toBe(from);
  });

  it('computes interior and acute angles', () => {
    const v = { x: 0, y: 0 };
    expect(interiorAngleDeg(v, { x: 10, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90);
    expect(interiorAngleDeg(v, { x: 10, y: 0 }, { x: -10, y: 0 })).toBeCloseTo(180);
    expect(interiorAngleDeg(v, { x: 10, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(45);
    expect(acuteAngleDeg(0, toRadians(150))).toBeCloseTo(30);
    expect(acuteAngleDeg(toRadians(10), toRadians(-80))).toBeCloseTo(90);
  });

  it('formats with one decimal', () => {
    expect(formatDegrees(45)).toBe('45.0°');
    expect(formatDegrees(33.333)).toBe('33.3°');
  });
});
