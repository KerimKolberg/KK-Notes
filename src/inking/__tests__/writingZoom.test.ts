import { getStroke } from 'perfect-freehand';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_SETTINGS } from '../constants';
import { MIN_SAMPLE_SPACING, StrokeBuilder } from '../engine/strokeBuilder';
import { freehandSamples, getStrokeOutline, strokeOutlineScale, toFreehandOptions, type Outline } from '../engine/strokeOutline';
import { styleForTool } from '../engine/toolStyles';
import { noiseScale, withWritingZoom } from '../engine/writingZoom';
import { appendStroke, createDocument } from '../../document/operations';
import { deserializeDocument, serializeDocument } from '../../document/serialization';
import type { FreehandStroke, InkPoint, StrokeStyle } from '../types';

const ballpoint = (size = 1): StrokeStyle => styleForTool('pen', { ...DEFAULT_TOOL_SETTINGS, size }, 'pen');

/**
 * Ten units to the right, then a curl of radius 1 turning back up and over: the end of a small
 * letter, sampled every 0.1 unit, as slow writing at 400 % is.
 */
function curl(style: StrokeStyle): FreehandStroke {
  const b = new StrokeBuilder('pen', style, 'pen');
  for (let x = 0; x < 10; x += 0.1) b.add({ x, y: 0, pressure: 0.5 });
  for (let a = 0; a <= Math.PI * 1.25; a += 0.1) b.add({ x: 10 + Math.sin(a), y: -1 + Math.cos(a), pressure: 0.5 });
  return b.build();
}

/** Nonzero-winding point-in-polygon, as the outline is filled. */
function inside(polygon: Outline, x: number, y: number): boolean {
  let winding = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i]!;
    const [bx, by] = polygon[(i + 1) % polygon.length]!;
    const cross = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
    if (ay <= y && by > y && cross > 0) winding++;
    else if (ay > y && by <= y && cross < 0) winding--;
  }
  return winding !== 0;
}

describe('the writing zoom', () => {
  it('is recorded only above 100 %, to three decimals', () => {
    const style = ballpoint();
    expect(withWritingZoom(style, 1)).toBe(style);
    expect(withWritingZoom(style, 0.6)).toBe(style);
    expect(withWritingZoom(style, 1.0004)).toBe(style);
    expect(withWritingZoom(style, 3.14159).writingZoom).toBe(3.142);
  });

  it('divides the thresholds by at least 1, whatever was stored', () => {
    expect(noiseScale({})).toBe(1);
    expect(noiseScale({ writingZoom: 0.5 })).toBe(1);
    expect(noiseScale({ writingZoom: Number.NaN })).toBe(1);
    expect(noiseScale({ writingZoom: 4 })).toBe(4);
  });

  it('measures the sample thinning on screen', () => {
    // 0.15 units apart: dropped at 100 %, but 0.6 units of screen at 400 %.
    const atFour = new StrokeBuilder('pen', withWritingZoom(ballpoint(2), 4), 'pen');
    const atOne = new StrokeBuilder('pen', ballpoint(2), 'pen');
    for (let i = 0; i < 10; i++) {
      atFour.add({ x: i * 0.15, y: 0, pressure: 0.5 });
      atOne.add({ x: i * 0.15, y: 0, pressure: 0.5 });
    }
    expect(atFour.points).toHaveLength(10);
    expect(atOne.points.length).toBeLessThan(10 * 0.15 / MIN_SAMPLE_SPACING + 1.5);
  });

  it('inks the curl at the end of a stroke written at 400 %', () => {
    const stroke = curl(withWritingZoom(ballpoint(), 4));
    const outline = getStrokeOutline(stroke.points, stroke.style, true);
    const curlSamples = stroke.points.filter((p) => p.x >= 10);
    expect(curlSamples.length).toBeGreaterThan(5);
    for (const p of curlSamples) expect(inside(outline, p.x, p.y)).toBe(true);
  });

  it('scales the outline for the writing zoom or for a fine pen, whichever asks for more', () => {
    expect(strokeOutlineScale(ballpoint(3))).toBe(1);
    // A fine pen alone: outlined as if 2 px wide.
    expect(strokeOutlineScale(ballpoint(1))).toBe(2);
    // At 400 % the zoom asks for more than the 1 px pen does…
    expect(strokeOutlineScale(withWritingZoom(ballpoint(1), 4))).toBe(4);
    // …and a quarter-pixel pen for more than the zoom.
    expect(strokeOutlineScale(withWritingZoom(ballpoint(0.25), 4))).toBe(8);
    // An ordinary pen written zoomed in, which the fine-pen scale never reached.
    expect(strokeOutlineScale(withWritingZoom(ballpoint(3), 4))).toBe(4);
    expect(strokeOutlineScale({ ...ballpoint(3), writingZoom: 0.5 })).toBe(1);
  });

  it('is perfect-freehand on the stroke scaled up, scaled back down', () => {
    // A fountain pen, so the tapers (page units) are scaled with everything else.
    const style = withWritingZoom(styleForTool('pen', { ...DEFAULT_TOOL_SETTINGS, brush: 'fountain', size: 3 }, 'pen'), 2.5);
    const points: InkPoint[] = Array.from({ length: 80 }, (_, i) => ({ x: i * 0.3, y: Math.sin(i * 0.2) * 3, pressure: 0.3 + (i % 7) * 0.08 }));
    const options = toFreehandOptions(style, true, points);
    const k = 2.5;
    const expected = getStroke(
      freehandSamples(points, style).map((p) => ({ x: p.x * k, y: p.y * k, pressure: p.pressure ?? 0.5 })),
      {
        ...options,
        size: options.size! * k,
        start: { ...options.start, taper: (options.start!.taper as number) * k },
        end: { ...options.end, taper: (options.end!.taper as number) * k },
      },
    ).map(([x, y]) => [x! / k, y! / k]);
    const actual = getStrokeOutline(points, style, true);
    expect(actual).toHaveLength(expected.length);
    actual.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(expected[i]![0]!, 9);
      expect(y).toBeCloseTo(expected[i]![1]!, 9);
    });
  });

  it('leaves strokes written at 100 % or less exactly as they were', () => {
    const points: InkPoint[] = Array.from({ length: 50 }, (_, i) => ({ x: i * 2, y: Math.cos(i * 0.3) * 8, pressure: 0.5 }));
    const style = ballpoint(2);
    expect(getStrokeOutline(points, { ...style, writingZoom: 0.5 }, true)).toEqual(getStrokeOutline(points, style, true));
  });

  it('is saved with the stroke', () => {
    const stroke = curl(withWritingZoom(ballpoint(), 4));
    const doc = createDocument(1);
    const page = appendStroke(doc.pages[0]!, stroke);
    const back = deserializeDocument(serializeDocument({ ...doc, pages: [page] }));
    expect(back.pages[0]!.strokes[0]!.style.writingZoom).toBe(4);
  });
});
