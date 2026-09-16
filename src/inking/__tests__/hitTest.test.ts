import { describe, expect, it } from 'vitest';
import { strokeHitBySegment } from '../engine/hitTest';
import { makeStroke } from './testUtils';

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

  it('never hits pixel-eraser strokes', () => {
    const eraser = makeStroke([[0, 50], [100, 50]], { tool: 'eraser-pixel' });
    expect(strokeHitBySegment(eraser, 50, 0, 50, 100, 5)).toBe(false);
  });
});
