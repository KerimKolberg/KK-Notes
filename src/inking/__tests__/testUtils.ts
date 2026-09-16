import type { InkPoint, Stroke, StrokeStyle } from '../types';

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
};

let seq = 0;

export function makeStroke(
  points: readonly (readonly [number, number])[],
  overrides: Partial<Stroke> = {},
): Stroke {
  const pts: InkPoint[] = points.map(([x, y]) => ({ x, y, pressure: 0.5 }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const pad = PEN_STYLE.size / 2 + 2;
  seq += 1;
  return {
    id: `stroke-${seq}`,
    tool: 'pen',
    points: pts,
    style: PEN_STYLE,
    bbox: {
      minX: Math.min(...xs) - pad,
      minY: Math.min(...ys) - pad,
      maxX: Math.max(...xs) + pad,
      maxY: Math.max(...ys) + pad,
    },
    pointerType: 'pen',
    createdAt: 0,
    ...overrides,
  };
}
