import { describe, expect, it } from 'vitest';
import {
  bboxFromPoints,
  bboxIntersects,
  pointToSegmentDistanceSq,
  segmentToSegmentDistanceSq,
  segmentsIntersect,
} from '../engine/geometry';

describe('geometry', () => {
  it('point-to-segment distance clamps to the endpoints', () => {
    // Segment (0,0)-(10,0)
    expect(pointToSegmentDistanceSq(5, 3, 0, 0, 10, 0)).toBe(9);
    expect(pointToSegmentDistanceSq(-4, 0, 0, 0, 10, 0)).toBe(16);
    expect(pointToSegmentDistanceSq(13, 4, 0, 0, 10, 0)).toBe(25);
  });

  it('degenerate segments behave like points', () => {
    expect(pointToSegmentDistanceSq(3, 4, 0, 0, 0, 0)).toBe(25);
  });

  it('detects crossing and touching segments', () => {
    expect(segmentsIntersect(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
    expect(segmentsIntersect(0, 0, 10, 0, 5, 0, 5, 5)).toBe(true); // T-junction
    expect(segmentsIntersect(0, 0, 10, 0, 0, 1, 10, 1)).toBe(false); // parallel
    expect(segmentsIntersect(0, 0, 1, 1, 2, 2, 3, 3)).toBe(false); // collinear, disjoint
  });

  it('segment-to-segment distance is zero when crossing, else the closest approach', () => {
    expect(segmentToSegmentDistanceSq(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0);
    expect(segmentToSegmentDistanceSq(0, 0, 10, 0, 0, 3, 10, 3)).toBe(9);
    expect(segmentToSegmentDistanceSq(0, 0, 10, 0, 14, 0, 20, 0)).toBe(16);
  });

  it('builds and intersects bounding boxes', () => {
    const b = bboxFromPoints(
      [
        { x: 1, y: 2 },
        { x: 5, y: -1 },
      ],
      1,
    );
    expect(b).toEqual({ minX: 0, minY: -2, maxX: 6, maxY: 3 });
    expect(bboxIntersects(b, { minX: 6, minY: 3, maxX: 9, maxY: 9 })).toBe(true); // edge contact
    expect(bboxIntersects(b, { minX: 7, minY: 0, maxX: 9, maxY: 9 })).toBe(false);
  });
});
