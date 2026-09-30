import { describe, expect, it } from 'vitest';
import {
  PROTRACTOR_MIN_RADIUS,
  PROTRACTOR_RADIUS,
  initialProtractor,
  keepProtractorOnPage,
  protractorPoint,
  protractorTicks,
  readAngle,
  type Protractor,
} from '../engine/protractor';

const near = (a: number, b: number, digits = 6): void => expect(a).toBeCloseTo(b, digits);
const flat: Protractor = { x: 300, y: 400, angle: 0, radius: 170 };

describe('the protractor\'s scale', () => {
  it('has a mark for every degree from 0 to 180, the fives and tens set apart', () => {
    const ticks = protractorTicks();
    expect(ticks).toHaveLength(181);
    expect(ticks[0]).toEqual({ degrees: 0, kind: 'ten' });
    expect(ticks[5]).toEqual({ degrees: 5, kind: 'five' });
    expect(ticks[7]).toEqual({ degrees: 7, kind: 'one' });
    expect(ticks.filter((t) => t.kind === 'ten')).toHaveLength(19);
    expect(ticks.filter((t) => t.kind === 'five')).toHaveLength(18);
  });

  it('puts 0 on the right of the base, 90 straight up and 180 on the left', () => {
    const right = protractorPoint(flat, 0, 100);
    near(right.x, 400);
    near(right.y, 400);
    const up = protractorPoint(flat, 90, 100);
    near(up.x, 300);
    near(up.y, 300);
    const left = protractorPoint(flat, 180, 100);
    near(left.x, 200);
    near(left.y, 400, 4);
  });

  it('turns with the protractor', () => {
    const turned = { ...flat, angle: Math.PI / 2 };
    // A quarter turn clockwise takes 0° from the right to below the vertex.
    const p = protractorPoint(turned, 0, 100);
    near(p.x, 300, 4);
    near(p.y, 500, 4);
  });
});

describe('reading an angle', () => {
  it('gives back the degrees a mark was put at, at any turn and distance', () => {
    for (const angle of [0, 0.4, 1.3, -2, Math.PI]) {
      const p = { ...flat, angle };
      for (const degrees of [0, 1, 33, 90, 120, 179.5, 180]) {
        for (const distance of [20, 150]) {
          const at = protractorPoint(p, degrees, distance);
          near(readAngle(p, at)!, degrees, 4);
        }
      }
    }
  });

  it('has nothing to say below the base or at the vertex', () => {
    expect(readAngle(flat, { x: 300, y: 450 })).toBeNull();
    expect(readAngle(flat, { x: 300, y: 400 })).toBeNull();
  });
});

describe('placing it', () => {
  it('starts in the middle of the page', () => {
    const p = initialProtractor({ width: 794, height: 1123 });
    near(p.x, 397);
    expect(p.radius).toBe(PROTRACTOR_RADIUS);
    expect(p.angle).toBe(0);
  });

  it('is no wider than the page, but never vanishingly small', () => {
    expect(initialProtractor({ width: 300, height: 400 }).radius).toBeLessThan(150);
    expect(initialProtractor({ width: 100, height: 100 }).radius).toBe(PROTRACTOR_MIN_RADIUS);
  });

  it('keeps its vertex on the page', () => {
    const page = { width: 800, height: 600 };
    expect(keepProtractorOnPage({ ...flat, x: -5, y: 700 }, page)).toMatchObject({ x: 0, y: 600 });
    expect(keepProtractorOnPage(flat, page)).toBe(flat);
  });
});
