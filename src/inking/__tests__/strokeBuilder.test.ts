import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_SETTINGS } from '../constants';
import { MIN_SAMPLE_SPACING, StrokeBuilder } from '../engine/strokeBuilder';
import { styleForTool } from '../engine/toolStyles';

const builder = (): StrokeBuilder => new StrokeBuilder('pen', styleForTool('pen', { ...DEFAULT_TOOL_SETTINGS }, 'mouse'), 'mouse');
const at = (x: number, y = 0) => ({ x, y, pressure: 0.5 });

describe('the samples a stroke keeps', () => {
  it('keeps samples that are further apart than the spacing', () => {
    const b = builder();
    for (let i = 0; i < 20; i++) b.add(at(i * (MIN_SAMPLE_SPACING + 0.1)));
    expect(b.build().points).toHaveLength(20);
  });

  it('holds back samples that are closer, so a dense mouse does not multiply the vertices', () => {
    const b = builder();
    // A slow drag at a thousand reports a second: a tenth of a unit between samples.
    for (let i = 0; i <= 10_000; i++) b.add(at(i * 0.1));
    const kept = b.build().points.length;
    // Two and a half to four times fewer than were reported, and not a dozen either.
    expect(kept).toBeLessThan(10_001 / 2.4);
    expect(kept).toBeGreaterThan(10_001 / 5);
  });

  it('still ends the stroke exactly where the pen ended', () => {
    const b = builder();
    b.add(at(0));
    b.add(at(10));
    // The last few reports are all within the spacing of the one before.
    b.add(at(10.1));
    b.add(at(10.2));
    b.add(at(10.3));
    const points = b.build().points;
    expect(points[points.length - 1]).toMatchObject({ x: 10.3 });
    expect(points).toHaveLength(3);
  });

  it('does not add the end twice when it was kept anyway', () => {
    const b = builder();
    b.add(at(0));
    b.add(at(10));
    expect(b.build().points).toHaveLength(2);
  });

  it('keeps a dot: a single sample, and a tap that barely moved', () => {
    const dot = builder();
    dot.add(at(5, 5));
    expect(dot.build().points).toHaveLength(1);
    const wobble = builder();
    wobble.add(at(5, 5));
    wobble.add(at(5.1, 5.1));
    // The second is held and then put back on the end: two points, one at each end of the tap.
    expect(wobble.build().points).toHaveLength(2);
  });

  it('drops exact duplicates as it always did', () => {
    const b = builder();
    b.add(at(3, 3));
    b.add(at(3, 3));
    b.add(at(3, 3));
    expect(b.build().points).toHaveLength(1);
  });

  it('keeps the bounds honest about the held end', () => {
    const b = builder();
    b.add(at(0));
    b.add(at(10));
    b.add(at(10.3));
    const stroke = b.build();
    const pad = stroke.bbox.maxX - 10.3;
    expect(pad).toBeGreaterThan(0);
    expect(stroke.bbox.minX).toBeCloseTo(-pad, 6);
  });

  it('shows the live preview the samples kept so far, without the held ones', () => {
    const b = builder();
    b.add(at(0));
    b.add(at(0.1));
    expect(b.points).toHaveLength(1);
  });
});
