import { describe, expect, it } from 'vitest';
import { strokeHitBySegment } from '../engine/hitTest';
import { makeGeometric, makeLine, makeStroke } from './testUtils';

describe('strokeHitBySegment', () => {
  const horizontal = makeStroke([
    [0, 50],
    [50, 50],
    [100, 50],
  ]);

  it('hits when the eraser sweep crosses the stroke', () => {
    expect(strokeHitBySegment(horizontal, 50, 0, 50, 100, 5)).toBe(true);
  });

  it('hits when the sweep passes within eraser radius + half width', () => {
    // Stroke half-width 2, eraser radius 5 → threshold 7. Sweep at y=56 is 6 away.
    expect(strokeHitBySegment(horizontal, 0, 56, 100, 56, 5)).toBe(true);
    expect(strokeHitBySegment(horizontal, 0, 58, 100, 58, 5)).toBe(false);
  });

  it('rejects quickly when bounding boxes do not overlap', () => {
    expect(strokeHitBySegment(horizontal, 0, 200, 100, 200, 5)).toBe(false);
  });

  it('handles single-point (dot) strokes', () => {
    const dot = makeStroke([[10, 10]]);
    expect(strokeHitBySegment(dot, 0, 10, 20, 10, 1)).toBe(true);
    expect(strokeHitBySegment(dot, 0, 30, 20, 30, 1)).toBe(false);
  });

  it('bridges sparse samples: a fast sweep between two far-apart points still hits', () => {
    const vertical = makeStroke([
      [50, 0],
      [50, 100],
    ]);
    expect(strokeHitBySegment(vertical, 0, 50, 100, 50, 1)).toBe(true);
  });

  it('hits a geometric line by its segment', () => {
    const line = makeLine({ x: 0, y: 50 }, { x: 100, y: 50 });
    expect(strokeHitBySegment(line, 50, 0, 50, 100, 5)).toBe(true);
    expect(strokeHitBySegment(line, 0, 80, 100, 80, 5)).toBe(false);
  });

  it('hits a rectangle only on its outline, not inside', () => {
    const rect = makeGeometric({ type: 'rectangle', center: { x: 100, y: 100 }, width: 100, height: 60, rotation: 0 });
    expect(strokeHitBySegment(rect, 50, 60, 50, 80, 3)).toBe(true); // left edge at x=50
    expect(strokeHitBySegment(rect, 100, 95, 100, 105, 3)).toBe(false); // centre
  });

  it('hits an ellipse near its rim', () => {
    const ellipse = makeGeometric({ type: 'ellipse', center: { x: 0, y: 0 }, radiusX: 50, radiusY: 50, rotation: 0 });
    expect(strokeHitBySegment(ellipse, 45, -5, 55, 5, 3)).toBe(true);
    expect(strokeHitBySegment(ellipse, -5, -5, 5, 5, 3)).toBe(false);
  });

  it('hits a coordinate plane on its axes', () => {
    const plane = makeGeometric({
      type: 'coordinate-plane',
      origin: { x: 200, y: 200 },
      extentX: 100,
      extentY: 100,
      config: { mode: 'four-quadrant', divisions: 4, showGrid: true, tickLabels: false, xLabel: 'x', yLabel: 'y' },
    });
    expect(strokeHitBySegment(plane, 250, 190, 250, 210, 3)).toBe(true); // x axis
    expect(strokeHitBySegment(plane, 240, 240, 260, 260, 3)).toBe(false); // open quadrant
  });

  it('never hits pixel-eraser strokes', () => {
    const eraser = makeStroke([[0, 50], [100, 50]], { tool: 'eraser-pixel' });
    expect(strokeHitBySegment(eraser, 50, 0, 50, 100, 5)).toBe(false);
  });
});
