import { describe, expect, it } from 'vitest';
import { EDGE_ZONE_PX, MAX_SCROLL_PER_SECOND, edgeVelocity } from '../autoScroll';

describe('edgeVelocity', () => {
  it('is nothing in the middle of the area', () => {
    expect(edgeVelocity(500, 0, 1000)).toBe(0);
    expect(edgeVelocity(EDGE_ZONE_PX, 0, 1000)).toBe(0);
    expect(edgeVelocity(1000 - EDGE_ZONE_PX, 0, 1000)).toBe(0);
  });

  it('goes towards the start near the start and towards the end near the end', () => {
    expect(edgeVelocity(10, 0, 1000)).toBeLessThan(0);
    expect(edgeVelocity(990, 0, 1000)).toBeGreaterThan(0);
  });

  it('is faster the closer to the edge, up to a top speed', () => {
    const slow = edgeVelocity(1000 - EDGE_ZONE_PX / 2, 0, 1000);
    const fast = edgeVelocity(1000 - 4, 0, 1000);
    expect(fast).toBeGreaterThan(slow);
    expect(edgeVelocity(1000, 0, 1000)).toBe(MAX_SCROLL_PER_SECOND);
    expect(edgeVelocity(0, 0, 1000)).toBe(-MAX_SCROLL_PER_SECOND);
  });

  it('stays at the top speed beyond the edge, where a drag that left the area still asks for more', () => {
    expect(edgeVelocity(1400, 0, 1000)).toBe(MAX_SCROLL_PER_SECOND);
    expect(edgeVelocity(-300, 0, 1000)).toBe(-MAX_SCROLL_PER_SECOND);
  });

  it('works away from zero, as an area on a page is', () => {
    expect(edgeVelocity(300, 200, 900)).toBe(0 + edgeVelocity(300, 200, 900));
    expect(edgeVelocity(205, 200, 900)).toBeLessThan(0);
    expect(edgeVelocity(895, 200, 900)).toBeGreaterThan(0);
  });

  it('never has the middle of a very small area in both zones', () => {
    // 60 px across with zones of 56: each gets 30, and the very middle is still.
    expect(edgeVelocity(30, 0, 60)).toBe(0);
    expect(edgeVelocity(10, 0, 60)).toBeLessThan(0);
    expect(edgeVelocity(50, 0, 60)).toBeGreaterThan(0);
  });
});
