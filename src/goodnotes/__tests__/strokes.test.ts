import { describe, expect, it } from 'vitest';
import { SOURCE_PAGE_SIZES, findCandidates, fitToPage, toStrokes } from '../strokes';
import type { Candidate } from '../strokes';
import { WIRE_LENGTH, WIRE_VARINT, decodeMessage } from '../protobuf';

/**
 * The shape search, tested against messages built to have the shapes it hunts
 * for — and, more importantly, against messages built to *nearly* have them.
 *
 * A search that finds ink in a real file is only half the requirement: the other
 * half is not finding ink in a timestamp, a colour, or a run of padding. Every
 * negative case below is a float run that a looser test would have accepted as a
 * stroke and drawn on the page.
 */

const tag = (field: number, wire: number): number => (field << 3) | wire;

function varint(value: number): number[] {
  let n = value;
  const out: number[] = [];
  for (;;) {
    if (n < 0x80) {
      out.push(n);
      return out;
    }
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
}

function packed(values: number[], write: (view: DataView, i: number, value: number) => void, stride: number): number[] {
  const buffer = new ArrayBuffer(values.length * stride);
  const view = new DataView(buffer);
  values.forEach((value, i) => write(view, i * stride, value));
  return [...new Uint8Array(buffer)];
}

const floats = (values: number[]): number[] =>
  packed(values, (view, at, value) => view.setFloat32(at, value, true), 4);

/** A length-delimited field carrying packed float32s. */
const floatField = (field: number, values: number[]): number[] => {
  const body = floats(values);
  return [...varint(tag(field, WIRE_LENGTH)), ...varint(body.length), ...body];
};

const rawField = (field: number, body: number[]): number[] => [
  ...varint(tag(field, WIRE_LENGTH)),
  ...varint(body.length),
  ...body,
];

const varintField = (field: number, value: number): number[] => [...varint(tag(field, WIRE_VARINT)), ...varint(value)];

function fixed32Field(field: number, value: number): number[] {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return [...varint(tag(field, 5)), ...new Uint8Array(buffer)];
}

/** Wrap a message body in a length-delimited field, as a nested message. */
const nest = (field: number, body: number[]): number[] => rawField(field, body);

const parse = (body: number[]): ReturnType<typeof decodeMessage> => decodeMessage(new Uint8Array(body));
const find = (body: number[]): Candidate[] => findCandidates(parse(body));

/** A plausible stroke: eight samples across a page, with pressures beside them. */
const PATH = [100, 200, 110, 205, 120, 215, 130, 230, 140, 250, 150, 275, 160, 305, 170, 340];
const PRESSURES = [0.2, 0.35, 0.5, 0.62, 0.71, 0.8, 0.6, 0.3];

describe('finding stroke candidates', () => {
  it('finds a run of coordinate pairs, whatever field number carries it', () => {
    // The same stroke under three different field numbers, which is the whole
    // point of searching by shape.
    for (const field of [1, 7, 4096]) {
      const [candidate] = find(floatField(field, PATH));
      expect(candidate!.points).toHaveLength(8);
      expect(candidate!.points[0]).toMatchObject({ x: 100, y: 200 });
      expect(candidate!.points[7]).toMatchObject({ x: 170, y: 340 });
    }
  });

  it('pairs a pressure run with the coordinates by its length and range', () => {
    const body = [...floatField(3, PATH), ...floatField(9, PRESSURES)];
    const [candidate] = find(body);
    // Compared loosely: the file stores float32, so 0.35 comes back as the
    // nearest float32 to 0.35 and never as the double.
    candidate!.points.forEach((point, i) => expect(point.pressure).toBeCloseTo(PRESSURES[i]!, 6));
    // Pressure alongside geometry is the strongest signal there is, so this
    // should outrank a bare coordinate run.
    expect(candidate!.confidence).toBeGreaterThan(find(floatField(3, PATH))[0]!.confidence);
  });

  it('reads interleaved x, y, pressure triples when the third column is pressure', () => {
    const triples = [10, 20, 0.4, 11, 25, 0.5, 12, 30, 0.9, 13, 35, 0.6];
    const [candidate] = find(floatField(1, triples));
    expect(candidate!.points).toHaveLength(4);
    expect(candidate!.points[2]!.x).toBe(12);
    expect(candidate!.points[2]!.y).toBe(30);
    expect(candidate!.points[2]!.pressure).toBeCloseTo(0.9, 6);
  });

  it('reads pairs, not triples, when the length divides by both', () => {
    // Twelve floats: six pairs or four triples. Nothing here confines every
    // third value to 0..1, so pairs it is.
    const [candidate] = find(floatField(1, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]));
    expect(candidate!.points).toHaveLength(6);
    expect(candidate!.points[1]).toMatchObject({ x: 30, y: 40 });
  });

  it('picks up a colour and a width from the same message', () => {
    const body = [
      ...floatField(2, PATH),
      ...floatField(5, [0.2, 0.4, 0.6, 1]), // RGBA
      ...fixed32Field(6, 3.5), // width
    ];
    const [candidate] = find(body);
    expect(candidate!.color).toBe('#336699');
    expect(candidate!.width).toBeCloseTo(3.5, 5);
    // Fully opaque, so no alpha is carried: nothing to override.
    expect(candidate!.alpha).toBeUndefined();
  });

  it('carries alpha only when the colour is translucent', () => {
    const body = [...floatField(2, PATH), ...floatField(5, [1, 0, 0, 0.35])];
    expect(find(body)[0]!.alpha).toBeCloseTo(0.35, 5);
  });

  it('finds several strokes in one page', () => {
    const body = [
      ...nest(1, [...floatField(2, PATH), ...floatField(3, PRESSURES)]),
      ...nest(1, floatField(2, [300, 400, 310, 410, 320, 420])),
      ...nest(1, floatField(2, [50, 60, 55, 65, 60, 70, 65, 75])),
    ];
    expect(find(body)).toHaveLength(3);
  });

  it('finds ink however deeply it is wrapped', () => {
    let body = [...floatField(2, PATH), ...floatField(3, PRESSURES)];
    for (const field of [11, 6, 4, 1]) body = nest(field, body);
    const candidates = find(body);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.points).toHaveLength(8);
  });

  it('does not return the same stroke twice when the walk reaches it twice', () => {
    // A nested message is also raw bytes in its parent, and a parent that parses
    // both ways gets walked both ways. The byte range is what settles it.
    const inner = [...floatField(2, PATH), ...floatField(3, PRESSURES)];
    const body = [...nest(1, inner), ...varintField(4, 1)];
    expect(find(body)).toHaveLength(1);
  });
});

describe('what the search refuses', () => {
  it('refuses a four-float run, which is a colour far more often than two points', () => {
    expect(find(floatField(1, [0.1, 0.2, 0.3, 1]))).toEqual([]);
  });

  it('refuses a run that never changes', () => {
    // Zeroed padding is the commonest float run in any binary file.
    expect(find(floatField(1, [0, 0, 0, 0, 0, 0, 0, 0]))).toEqual([]);
    expect(find(floatField(1, [7, 7, 7, 7, 7, 7]))).toEqual([]);
  });

  it('refuses a run holding a NaN, an infinity, or a number no page could hold', () => {
    const nan = [...rawField(1, [0xff, 0xff, 0xff, 0x7f, 0, 0, 0x80, 0x3f, 0, 0, 0, 0x40, 0, 0, 0x40, 0x40])];
    expect(find(nan)).toEqual([]);
    const huge = floatField(1, [1e9, 2, 3, 4, 5, 6]);
    expect(find(huge)).toEqual([]);
  });

  it('refuses an odd-length run that cannot be pairs or triples', () => {
    // Five floats: neither.
    expect(find(floatField(1, [1, 2, 3, 4, 5]))).toEqual([]);
  });

  it('refuses a run too short to be a path', () => {
    expect(find(floatField(1, [10, 20]))).toEqual([]);
  });

  it('ignores a length-delimited field whose length is not a multiple of four', () => {
    // A string, in other words. It cannot be floats, so it is not considered.
    expect(find(rawField(1, [...new TextEncoder().encode('Chemistry lecture 4')]))).toEqual([]);
  });

  it('finds nothing in a message that carries no float runs at all', () => {
    expect(find([...varintField(1, 1), ...varintField(2, 1758000000)])).toEqual([]);
  });

  it('does not take a pressure-shaped run as the geometry itself', () => {
    // Eight floats in 0..1, alone: the right length for four points, but four
    // points inside one pixel is a pressure array that lost its stroke.
    const candidates = find(floatField(1, PRESSURES));
    expect(candidates).toHaveLength(1);
    // It is accepted as a path — there is nothing left to distinguish it — but
    // it lands at the bottom of the confidence ordering, which is what the
    // threshold in the importer is for.
    expect(candidates[0]!.confidence).toBeLessThanOrEqual(0.6);
  });
});

describe('fitting the source page into ours', () => {
  const page = { width: 794, height: 1123 }; // our A4 in px

  it('snaps to the first paper that contains the ink', () => {
    const candidates: Candidate[] = [
      { points: [{ x: 20, y: 30, pressure: 1 }, { x: 560, y: 800, pressure: 1 }], confidence: 1 },
    ];
    const fit = fitToPage([candidates], page);
    expect(fit.source).toBe('A4');
    expect(fit.matched).toBe(true);
    expect(fit.scale).toBeCloseTo(Math.min(794 / 595.28, 1123 / 841.89), 6);
  });

  it('falls through to a bigger paper when the ink does not fit the first', () => {
    // Wider than A4 but shorter than it: Letter.
    const wide: Candidate[] = [
      { points: [{ x: 0, y: 0, pressure: 1 }, { x: 605, y: 780, pressure: 1 }], confidence: 1 },
    ];
    expect(fitToPage([wide], page).source).toBe('Letter');
    const tall: Candidate[] = [
      { points: [{ x: 0, y: 0, pressure: 1 }, { x: 605, y: 980, pressure: 1 }], confidence: 1 },
    ];
    expect(fitToPage([tall], page).source).toBe('Legal');
  });

  it('does not magnify a page just because little was written on it', () => {
    // The ink's box is only a lower bound on the page — somebody who wrote in
    // one corner of an A4 sheet leaves ink that would fit on A6. Guessing small
    // would blow their handwriting up to fill the sheet, which is the error that
    // cannot be told apart from correct output.
    const corner: Candidate[] = [
      { points: [{ x: 10, y: 10, pressure: 1 }, { x: 120, y: 90, pressure: 1 }], confidence: 1 },
    ];
    const full: Candidate[] = [
      { points: [{ x: 10, y: 10, pressure: 1 }, { x: 580, y: 820, pressure: 1 }], confidence: 1 },
    ];
    expect(fitToPage([corner], page).scale).toBeCloseTo(fitToPage([full], page).scale, 6);
    expect(fitToPage([corner], page).source).toBe('A4');
  });

  it('keeps one scale for the whole notebook, not one per page', () => {
    // With the units unrecognised there is no paper to snap to, so the scale
    // comes from the ink — and that is where per-page fitting would drift: page 1
    // has small writing, page 2 fills the sheet, and fitting each alone would
    // blow page 1 up to match page 2.
    const small: Candidate[] = [
      { points: [{ x: 0, y: 0, pressure: 1 }, { x: 500, y: 500, pressure: 1 }], confidence: 1 },
    ];
    const large: Candidate[] = [
      { points: [{ x: 0, y: 0, pressure: 1 }, { x: 5000, y: 5000, pressure: 1 }], confidence: 1 },
    ];
    const together = fitToPage([small, large], page);
    expect(together.matched).toBe(false);
    expect(together.scale).toBeLessThan(fitToPage([small], page).scale);
    expect(together.scale).toBeCloseTo(fitToPage([large], page).scale, 6);
  });

  it('measures from the origin, because a page whose writing starts low is still a page', () => {
    // Ink only in the bottom third. Scaling its own box to the page would move
    // it to the top and magnify it.
    const candidates: Candidate[] = [
      { points: [{ x: 100, y: 600, pressure: 1 }, { x: 400, y: 700, pressure: 1 }], confidence: 1 },
    ];
    const fit = fitToPage([candidates], page);
    const [stroke] = toStrokes(candidates, fit);
    expect(stroke!.points[0]!.y).toBeGreaterThan(page.height * 0.5);
  });

  it('shifts negative coordinates back onto the page', () => {
    const candidates: Candidate[] = [
      { points: [{ x: -50, y: -20, pressure: 1 }, { x: 300, y: 400, pressure: 1 }], confidence: 1 },
    ];
    const fit = fitToPage([candidates], page);
    const [stroke] = toStrokes(candidates, fit);
    expect(stroke!.points[0]!.x).toBeGreaterThanOrEqual(0);
    expect(stroke!.points[0]!.y).toBeGreaterThanOrEqual(0);
  });

  it('leaves the requested margin around the ink', () => {
    const candidates: Candidate[] = [
      { points: [{ x: 0, y: 0, pressure: 1 }, { x: 595, y: 841, pressure: 1 }], confidence: 1 },
    ];
    const fit = fitToPage([candidates], page, 24);
    const [stroke] = toStrokes(candidates, fit);
    expect(stroke!.points[0]!.x).toBeCloseTo(24, 5);
    expect(stroke!.points[1]!.x).toBeLessThanOrEqual(page.width - 24 + 0.5);
  });

  it('says so when no paper size fits, rather than pretending', () => {
    // Coordinates in some other unit entirely.
    const candidates: Candidate[] = [
      { points: [{ x: 0, y: 0, pressure: 1 }, { x: 4000, y: 9000, pressure: 1 }], confidence: 1 },
    ];
    const fit = fitToPage([candidates], page);
    expect(fit.matched).toBe(false);
    expect(fit.source).toMatch(/bounding box/);
    // Still usable: the ink lands on the page.
    const [stroke] = toStrokes(candidates, fit);
    expect(stroke!.points[1]!.y).toBeLessThanOrEqual(page.height + 0.5);
  });

  it('handles a page with no ink at all', () => {
    const fit = fitToPage([[]], page);
    expect(fit.matched).toBe(false);
    expect(fit.scale).toBe(1);
    expect(toStrokes([], fit)).toEqual([]);
  });

  it('lists every paper size reachably, and starts at A4', () => {
    const areas = SOURCE_PAGE_SIZES.map((size) => size.width * size.height);
    // A4 first is the whole bias: never guess a page smaller than the common one.
    expect(SOURCE_PAGE_SIZES[0]!.name).toBe('A4');
    expect(SOURCE_PAGE_SIZES.some((size) => size.name === 'A5')).toBe(false);
    // Not strictly sorted by area — Letter and Legal interleave — but each entry
    // must be reachable, i.e. no entry may be contained by an earlier one.
    for (let i = 1; i < SOURCE_PAGE_SIZES.length; i++) {
      const size = SOURCE_PAGE_SIZES[i]!;
      const shadowed = SOURCE_PAGE_SIZES.slice(0, i).some((e) => e.width >= size.width && e.height >= size.height);
      expect(shadowed).toBe(false);
    }
    expect(areas[0]).toBeLessThan(areas[areas.length - 1]!);
  });
});

describe('converting to our stroke model', () => {
  const page = { width: 794, height: 1123 };
  const candidate: Candidate = {
    points: [
      { x: 100, y: 100, pressure: 0.3 },
      { x: 200, y: 150, pressure: 0.8 },
      { x: 300, y: 260, pressure: 0.5 },
    ],
    width: 2.4,
    color: '#1d4ed8',
    confidence: 0.9,
  };

  it('produces a freehand pen stroke with a bounding box and an id', () => {
    const fit = fitToPage([[candidate]], page);
    const [stroke] = toStrokes([candidate], fit);
    expect(stroke!.kind).toBe('freehand');
    expect(stroke!.tool).toBe('pen');
    expect(stroke!.pointerType).toBe('pen');
    expect(stroke!.id).toBeTruthy();
    expect(stroke!.style.brush).toBe('ballpoint');
    expect(stroke!.style.color).toBe('#1d4ed8');
    // The bbox must contain the points, padded — it is what culling relies on.
    expect(stroke!.bbox.minX).toBeLessThan(stroke!.points[0]!.x);
    expect(stroke!.bbox.maxY).toBeGreaterThan(stroke!.points[2]!.y);
  });

  it('gives every stroke its own id', () => {
    const fit = fitToPage([[candidate]], page);
    const ids = new Set(toStrokes([candidate, candidate, candidate], fit).map((s) => s.id));
    expect(ids.size).toBe(3);
  });

  it('keeps pressure through the transform and scales the width by it', () => {
    const fit = fitToPage([[candidate]], page);
    const [stroke] = toStrokes([candidate], fit);
    expect(stroke!.points.map((p) => p.pressure)).toEqual([0.3, 0.8, 0.5]);
    // A ballpoint scales its own size, so this is about the ratio holding.
    const bare = toStrokes([{ ...candidate, width: 4.8 }], fit)[0]!;
    expect(bare.style.size / stroke!.style.size).toBeCloseTo(2, 5);
  });

  it('falls back to a default colour and width when the search found neither', () => {
    const fit = fitToPage([[candidate]], page);
    const [stroke] = toStrokes([{ points: candidate.points, confidence: 0.4 }], fit, {
      color: '#111827',
      size: 3,
    });
    expect(stroke!.style.color).toBe('#111827');
    expect(stroke!.style.size).toBeGreaterThan(0);
  });

  it('clamps a width that scaled to something unusable', () => {
    const fit = fitToPage([[candidate]], page);
    const hair = toStrokes([{ ...candidate, width: 0.0001 }], fit)[0]!;
    const slab = toStrokes([{ ...candidate, width: 190 }], fit)[0]!;
    expect(hair.style.size).toBeGreaterThanOrEqual(0.5);
    expect(slab.style.size).toBeLessThanOrEqual(96);
  });

  it('uses a translucent colour’s alpha as the stroke opacity', () => {
    const fit = fitToPage([[candidate]], page);
    const [stroke] = toStrokes([{ ...candidate, alpha: 0.4 }], fit);
    expect(stroke!.style.opacity).toBeCloseTo(0.4, 5);
    // And never fully transparent, which would import as an invisible page.
    const [ghost] = toStrokes([{ ...candidate, alpha: 0 }], fit);
    expect(ghost!.style.opacity).toBeGreaterThan(0);
  });
});

describe('end to end, on a message shaped like a page', () => {
  it('turns a synthetic page into strokes on our page', () => {
    // As close to a GoodNotes page as can be written without one: a wrapper
    // message holding several stroke messages, each with geometry, pressures, a
    // colour, a width and assorted metadata that must not be mistaken for ink.
    const stroke = (points: number[], pressures: number[], rgba: number[], width: number): number[] =>
      nest(3, [
        ...varintField(1, 2),
        ...floatField(4, points),
        ...floatField(5, pressures),
        ...floatField(6, rgba),
        ...fixed32Field(7, width),
        ...varintField(8, 1758790000),
        ...rawField(9, [...new TextEncoder().encode('stroke-uuid-here')]),
      ]);

    const page = [
      ...rawField(1, [...new TextEncoder().encode('Page 1')]),
      ...stroke(PATH, PRESSURES, [0, 0, 0, 1], 1.8),
      ...stroke([400, 100, 420, 130, 440, 170, 460, 220], [0.5, 0.6, 0.7, 0.4], [0.9, 0.1, 0.1, 1], 3.2),
      ...floatField(20, [0, 0, 0, 0, 0, 0]), // padding, not ink
    ];

    const candidates = findCandidates(parse(page));
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.confidence >= 0.8)).toBe(true);
    // 0.9 as a float32 is a hair under 0.9, so it rounds to 0xe5 rather than
    // 0xe6 — which is the colour the file actually holds.
    expect(candidates.map((c) => c.color)).toEqual(['#000000', '#e51a1a']);

    const fit = fitToPage([candidates], { width: 794, height: 1123 });
    const strokes = toStrokes(candidates, fit);
    expect(strokes).toHaveLength(2);
    for (const s of strokes) {
      for (const point of s.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(794);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1123);
      }
    }
  });
});
