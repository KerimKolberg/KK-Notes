import { createGeometricStroke } from '../engine/shapes';
import { freehandBBox } from '../engine/strokeBuilder';
import type { FreehandStroke, GeometricStroke, InkPoint, Point, Shape, Stroke, StrokeStyle } from '../types';

export const PEN_STYLE: StrokeStyle = {
  color: '#000',
  size: 4,
  opacity: 1,
  compositeOperation: 'source-over',
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.5,
  simulatePressure: false,
  taperStart: 0,
  taperEnd: 0,
  pattern: 'solid',
  arrowheads: 'none',
};

let seq = 0;

export function makeStroke(
  points: readonly (readonly [number, number])[],
  overrides: Partial<Omit<FreehandStroke, 'kind'>> = {},
): Stroke {
  const pts: InkPoint[] = points.map(([x, y]) => ({ x, y, pressure: 0.5 }));
  const style = overrides.style ?? PEN_STYLE;
  seq += 1;
  return {
    kind: 'freehand',
    id: `stroke-${seq}`,
    tool: 'pen',
    points: pts,
    style,
    bbox: freehandBBox(pts, style),
    pointerType: 'pen',
    createdAt: 0,
    ...overrides,
  };
}

export function makeGeometric(shape: Shape, style: StrokeStyle = PEN_STYLE): GeometricStroke {
  seq += 1;
  return createGeometricStroke({
    id: `geo-${seq}`,
    tool: shape.type === 'coordinate-plane' ? 'coordinate-plane' : 'line',
    shape,
    style,
    pointerType: 'pen',
    createdAt: 0,
  });
}

export function makeLine(from: Point, to: Point, style: StrokeStyle = PEN_STYLE): GeometricStroke {
  return makeGeometric({ type: 'line', from, to }, style);
}

/** Sample a parametric curve into points, optionally with deterministic jitter. */
export function sampleCurve(
  fn: (t: number) => Point,
  count: number,
  jitter = 0,
  closed = true,
): Point[] {
  const out: Point[] = [];
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const steps = closed ? count : count - 1;
  for (let i = 0; i < count; i++) {
    const p = fn(i / steps);
    out.push({ x: p.x + rand() * 2 * jitter, y: p.y + rand() * 2 * jitter });
  }
  return out;
}

/** Walk a closed polygon perimeter with `perSide` samples on each edge. */
export function samplePolygon(corners: readonly Point[], perSide: number, jitter = 0): Point[] {
  const out: Point[] = [];
  let seed = 777;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    if (!a || !b) continue;
    for (let k = 0; k < perSide; k++) {
      const t = k / perSide;
      out.push({ x: a.x + (b.x - a.x) * t + rand() * 2 * jitter, y: a.y + (b.y - a.y) * t + rand() * 2 * jitter });
    }
  }
  const first = corners[0];
  if (first) out.push({ x: first.x + 1, y: first.y - 1 }); // nearly closed
  return out;
}
