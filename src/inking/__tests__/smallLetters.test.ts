import { describe, expect, it } from 'vitest';
import { brushStyle } from '../engine/brushes';
import { StrokeBuilder } from '../engine/strokeBuilder';
import { getStrokeOutline } from '../engine/strokeOutline';
import type { InkPoint } from '../types';

/**
 * Small letters keep their shape: the ink covers where the pen went, and not much else. Measured as a picture, 8
 * samples a page px, against the ideal (everything within the pen's radius of its path). Before the outline passed
 * over a stroke's first width and last 3 units (`strokeOutline.ts`), a 2.5 px pen left 27 % of a small hook, 12 % of
 * an "s" and 8 % of an "e" without ink.
 */

const H = 10; // page px: a letter written small
function sampled(f: (t: number) => [number, number], n: number): InkPoint[] {
  return Array.from({ length: n }, (_, i) => {
    const [x, y] = f(i / (n - 1));
    return { x, y, pressure: 0.5 };
  });
}
const LETTERS: Record<string, InkPoint[]> = {
  e: sampled((t) => {
    if (t < 0.15) return [(t / 0.15) * H * 0.6, H * 0.5];
    const a = ((t - 0.15) / 0.85) * Math.PI * 1.7;
    return [H * 0.3 + Math.cos(-a) * H * 0.3, H * 0.5 - Math.sin(-a) * H * 0.45];
  }, 70),
  s: sampled((t) => [H * 0.25 * Math.sin(t * Math.PI * 2) * (t < 0.5 ? -1 : 1) + H * 0.3, t * H], 70),
  hook: sampled((t) => {
    const r = H * 0.15;
    return [Math.cos(t * Math.PI * 1.5) * r + r, Math.sin(t * Math.PI * 1.5) * r];
  }, 30),
};

/** Nonzero winding, as the canvas fills: ink over ink is ink. */
function inked(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!;
    const [bx, by] = poly[(i + 1) % poly.length]!;
    const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y) {
      if (by > y && cross > 0) w++;
    } else if (by <= y && cross < 0) w--;
  }
  return w !== 0;
}

function distanceToPath(x: number, y: number, pts: readonly InkPoint[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = dx * dx + dy * dy;
    const t = l === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l));
    d = Math.min(d, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return d;
}

function picture(raw: readonly InkPoint[], size: number): { missing: number; extra: number } {
  const style = brushStyle('ballpoint', { color: '#000', size, pattern: 'solid', arrowheads: 'none' }, 'pen');
  const builder = new StrokeBuilder('pen', style, 'pen');
  for (const p of raw) builder.add(p);
  const outline = getStrokeOutline(builder.build().points, style, true);
  const xs = raw.map((p) => p.x);
  const ys = raw.map((p) => p.y);
  let ideal = 0;
  let missing = 0;
  let extra = 0;
  for (let x = Math.min(...xs) - size; x <= Math.max(...xs) + size; x += 0.125) {
    for (let y = Math.min(...ys) - size; y <= Math.max(...ys) + size; y += 0.125) {
      const want = distanceToPath(x, y, raw) <= style.size / 2;
      const got = inked(outline, x, y);
      if (want) ideal++;
      if (want && !got) missing++;
      if (got && !want) extra++;
    }
  }
  return { missing: missing / ideal, extra: extra / ideal };
}

describe('small letters keep their shape', () => {
  for (const size of [1, 2, 2.5, 4]) {
    for (const [name, raw] of Object.entries(LETTERS)) {
      it(`a ${size} px pen inks where an "${name}" ${H} px high was written, and not much else`, () => {
        const { missing, extra } = picture(raw, size);
        expect(missing).toBeLessThan(0.05);
        expect(extra).toBeLessThan(0.02);
      });
    }
  }
});
