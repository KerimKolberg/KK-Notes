import { describe, expect, it } from 'vitest';
import {
  isStrokeWhollyInside,
  polylineCrossesPolygon,
  segmentsIntersect,
  selectStrokesInLasso,
  strokeTouchesLasso,
} from '../engine/lasso';
import { LASSO_ALL_LAYERS, inLassoFilter, lassoFilterIsEmpty, lassoFilterIsOpen, lassoLayerOf } from '../engine/lassoFilter';
import type { Point, Stroke } from '../types';
import { PEN_STYLE, makeGeometric, makeLine, makeStroke } from './testUtils';

const square = (x: number, y: number, w: number, h: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe('segment intersection', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 10 };

  it('finds a plain crossing', () => {
    expect(segmentsIntersect(a, b, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
  });

  it('rejects segments that would only meet past their ends', () => {
    // Same lines as above, but the second segment stops short of the crossing.
    expect(segmentsIntersect(a, b, { x: 0, y: 10 }, { x: 3, y: 7.5 })).toBe(false);
    expect(segmentsIntersect(a, b, { x: 20, y: 20 }, { x: 30, y: 30 })).toBe(false);
  });

  it('counts a touch at an endpoint', () => {
    expect(segmentsIntersect(a, b, { x: 10, y: 10 }, { x: 20, y: 0 })).toBe(true);
    expect(segmentsIntersect(a, b, { x: 5, y: 5 }, { x: 5, y: 40 })).toBe(true);
  });

  it('counts collinear overlap, and not collinear separation', () => {
    expect(segmentsIntersect(a, b, { x: 5, y: 5 }, { x: 20, y: 20 })).toBe(true);
    expect(segmentsIntersect(a, b, { x: 11, y: 11 }, { x: 20, y: 20 })).toBe(false);
  });

  it('handles parallel and degenerate inputs without claiming a crossing', () => {
    expect(segmentsIntersect(a, b, { x: 0, y: 5 }, { x: 10, y: 15 })).toBe(false);
    // A zero-length segment on the line counts; one off it does not.
    expect(segmentsIntersect(a, b, { x: 5, y: 5 }, { x: 5, y: 5 })).toBe(true);
    expect(segmentsIntersect(a, b, { x: 5, y: 6 }, { x: 5, y: 6 })).toBe(false);
  });
});

describe('polylineCrossesPolygon', () => {
  const box = square(0, 0, 100, 100);

  it('sees a polyline that cuts straight through', () => {
    expect(polylineCrossesPolygon([{ x: -50, y: 50 }, { x: 150, y: 50 }], box)).toBe(true);
  });

  it('does not see one that stays wholly outside', () => {
    expect(polylineCrossesPolygon([{ x: -50, y: 200 }, { x: 150, y: 200 }], box)).toBe(false);
  });

  it('does not see one that stays wholly inside: it crosses no edge', () => {
    expect(polylineCrossesPolygon([{ x: 10, y: 10 }, { x: 90, y: 90 }], box)).toBe(false);
  });

  it('ignores inputs too short to have a segment', () => {
    expect(polylineCrossesPolygon([{ x: 50, y: 50 }], box)).toBe(false);
    expect(polylineCrossesPolygon([{ x: 0, y: 0 }, { x: 10, y: 10 }], [{ x: 0, y: 0 }])).toBe(false);
  });
});

describe('partial touch selection', () => {
  const big = makeGeometric({ type: 'rectangle', center: { x: 200, y: 200 }, width: 200, height: 200, rotation: 0 });

  it('selects a big shape from a small stroke dragged across its edge', () => {
    // A sliver of a loop straddling the rectangle's left edge. Every sample of
    // the rectangle is outside it, so only the crossing gives it away.
    const slash = square(90, 190, 30, 6);
    expect(strokeTouchesLasso(big, slash)).toBe(true);
    expect(isStrokeWhollyInside(big, slash)).toBe(false);
  });

  it('still selects something swallowed whole by a big loop', () => {
    const small = makeStroke([[195, 195], [205, 205]]);
    const loop = square(0, 0, 400, 400);
    expect(strokeTouchesLasso(small, loop)).toBe(true);
  });

  it('leaves a shape the loop never reaches', () => {
    expect(strokeTouchesLasso(big, square(600, 600, 40, 40))).toBe(false);
  });

  it('needs at least a line: a loop of one point catches nothing', () => {
    expect(strokeTouchesLasso(big, [{ x: 200, y: 200 }])).toBe(false);
  });
});

describe('enclose-entirely selection', () => {
  const loop = square(0, 0, 100, 100);

  it('takes a stroke that is completely inside', () => {
    expect(isStrokeWhollyInside(makeStroke([[20, 20], [40, 40], [60, 30]]), loop)).toBe(true);
  });

  it('leaves one that pokes out, however little', () => {
    // Five of six samples inside; the last is past the right edge.
    expect(isStrokeWhollyInside(makeStroke([[10, 50], [30, 50], [50, 50], [70, 50], [90, 50], [110, 50]]), loop)).toBe(false);
  });

  it('takes a thick stroke whose samples are inside, padding or no padding', () => {
    // A 40 px stroke hugging the edge: its padded bounding box spills well
    // past the loop, but every sample of the path itself is inside it. The
    // rule used to require the padded box to be contained, which meant the
    // halo around any thick stroke — half its width, plus any arrowhead —
    // could veto a stroke the user had clearly lassoed.
    const fat = makeStroke([[5, 50], [95, 50]], { style: { ...PEN_STYLE, size: 40 } });
    expect(fat.bbox.minX).toBeLessThan(0);
    expect(isStrokeWhollyInside(fat, loop)).toBe(true);
  });

  it('forgives a near miss but not a straddle', () => {
    // Nine of ten samples in — a descender clipped by a couple of pixels — is
    // what the threshold exists for. Half in is not.
    const nearMiss = makeStroke(Array.from({ length: 10 }, (_, i) => [10 + i * 9, 50] as [number, number]));
    expect(isStrokeWhollyInside(nearMiss, loop)).toBe(true);
    const straddling = makeStroke(Array.from({ length: 10 }, (_, i) => [50 + i * 9, 50] as [number, number]));
    expect(isStrokeWhollyInside(straddling, loop)).toBe(false);
  });

  it('respects a concave loop: an arm is in, the notch is not', () => {
    const cShape: Point[] = [
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 50, y: 100 },
      { x: 50, y: 70 },
      { x: 80, y: 70 },
      { x: 80, y: 30 },
      { x: 50, y: 30 },
    ];
    expect(isStrokeWhollyInside(makeStroke([[85, 40], [90, 50], [85, 60]]), cShape)).toBe(true);
    expect(isStrokeWhollyInside(makeStroke([[60, 40], [65, 50], [60, 60]]), cShape)).toBe(false);
  });
});

describe('layer filters', () => {
  const pen = makeStroke([[10, 10], [40, 40]]);
  const highlight = makeStroke([[10, 20], [40, 50]], { tool: 'highlighter' });
  const tape = makeStroke([[10, 30], [40, 60]], { tool: 'washi-tape' });
  const shape = makeLine({ x: 10, y: 40 }, { x: 40, y: 70 });
  const eraser = makeStroke([[10, 10], [40, 40]], { tool: 'eraser-pixel' });
  const loop = square(0, 0, 100, 100);
  const all: Stroke[] = [pen, highlight, tape, shape, eraser];

  it('maps each stroke to the switch that governs it', () => {
    expect(lassoLayerOf(pen)).toBe('ink');
    expect(lassoLayerOf(highlight)).toBe('highlighter');
    expect(lassoLayerOf(tape)).toBe('washiTape');
    expect(lassoLayerOf(shape)).toBe('shapes');
    // Never selectable, whatever the switches say.
    expect(lassoLayerOf(eraser)).toBeNull();
    expect(inLassoFilter(eraser, LASSO_ALL_LAYERS)).toBe(false);
  });

  it('takes everything when every layer is on', () => {
    expect(selectStrokesInLasso(all, loop)).toEqual([pen.id, highlight.id, tape.id, shape.id]);
    expect(lassoFilterIsOpen(LASSO_ALL_LAYERS)).toBe(true);
  });

  it('ignores the layers that are switched off', () => {
    const inkOnly = { ink: true, highlighter: false, washiTape: false, shapes: false };
    expect(selectStrokesInLasso(all, loop, { filter: inkOnly })).toEqual([pen.id]);
    const decoration = { ink: false, highlighter: true, washiTape: true, shapes: false };
    expect(selectStrokesInLasso(all, loop, { filter: decoration })).toEqual([highlight.id, tape.id]);
  });

  it('finds nothing at all with every layer off', () => {
    const none = { ink: false, highlighter: false, washiTape: false, shapes: false };
    expect(lassoFilterIsEmpty(none)).toBe(true);
    expect(selectStrokesInLasso(all, loop, { filter: none })).toEqual([]);
    expect(selectStrokesInLasso(all, loop, { filter: none, mode: 'touch' })).toEqual([]);
  });

  it('applies the filter in touch mode too', () => {
    const across = square(-10, 15, 200, 4); // crosses the highlighter's path
    const inkOnly = { ink: true, highlighter: false, washiTape: false, shapes: false };
    expect(selectStrokesInLasso(all, across, { mode: 'touch', filter: inkOnly })).toEqual([pen.id]);
  });
});
