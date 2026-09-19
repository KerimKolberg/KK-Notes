import { describe, expect, it } from 'vitest';
// Build scripts, not TypeScript; imported for their pure helpers. Neither
// writes anything unless run as a script.
import {
  ADAPTIVE_OFFSET,
  ADAPTIVE_SCALE,
  MARK,
  PALETTE,
  ico,
  markBounds,
  markShapes,
  markSvg,
  png,
  rasterize,
  // @ts-expect-error -- untyped .mjs
} from '../../../scripts/make-icons.mjs';
// eslint-disable-next-line import/order
import {
  PRODUCT_NAME,
  LAUNCHER_BACKGROUND,
  renameStrings,
  xmlProblems,
  // @ts-expect-error -- untyped .mjs
} from '../../../scripts/android-customize.mjs';

interface Shape {
  kind: 'roundRect' | 'bar' | 'poly';
  fill: string;
}

/**
 * What the generator hands back: a Node `Buffer`. Described structurally
 * rather than by name because this project's `tsconfig` does not pull Node's
 * globals into `src/`, and one test file is not a reason to.
 */
interface Bytes {
  readonly length: number;
  [index: number]: number;
  subarray(start?: number, end?: number): Bytes;
  readUInt32BE(offset: number): number;
  readUInt32LE(offset: number): number;
  readUInt16LE(offset: number): number;
  toString(encoding: string): string;
  [Symbol.iterator](): IterableIterator<number>;
}
interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const shapes = (options?: { body?: boolean; page?: boolean }): Shape[] => markShapes(options) as Shape[];
const bounds = (s: Shape[]): Bounds => markBounds(s) as Bounds;
const render = (size: number, s: Shape[], options?: Record<string, number>): Bytes =>
  rasterize(size, s, options) as Bytes;
const problems = (xml: string, label = 'icon.svg'): string[] => xmlProblems(xml, label) as string[];

/** The RGBA at a fractional position in a rendered square. */
function pixel(buffer: Bytes, size: number, u: number, v: number): [number, number, number, number] {
  const x = Math.min(size - 1, Math.floor(u * size));
  const y = Math.min(size - 1, Math.floor(v * size));
  const i = (y * size + x) * 4;
  return [buffer[i]!, buffer[i + 1]!, buffer[i + 2]!, buffer[i + 3]!];
}

const hex = (value: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) as [number, number, number];

/** Close enough, given a box filter over supersamples. */
function expectColour(actual: [number, number, number, number], expected: string, tolerance = 6): void {
  const [r, g, b] = hex(expected);
  expect(Math.abs(actual[0] - r)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[1] - g)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual[2] - b)).toBeLessThanOrEqual(tolerance);
  expect(actual[3]).toBe(255);
}

/**
 * The app icon.
 *
 * Icons are the one asset nobody looks at twice and everybody sees. The things
 * worth pinning are the ones that fail *silently*: an `.ico` whose directory
 * is malformed only surfaces when the Windows installer is built, and a mark
 * drawn outside Android's adaptive safe zone only surfaces on whichever
 * launcher happens to use a circular mask.
 */
describe('the mark', () => {
  it('is drawn from one geometry, so no two renderers can disagree', () => {
    // Everything else in this file leans on this: the PNGs, the .ico and the
    // favicon are all projections of the same shape list.
    const full = shapes();
    expect(full.length).toBeGreaterThan(8);
    expect(markSvg(full)).toContain(PALETTE.teal);
    expect(render(32, full)).toHaveLength(32 * 32 * 4);
  });

  it('keeps the monogram on the page, centred', () => {
    // The teal shapes are everything after the folio furniture.
    const monogram = bounds(shapes({ body: false, page: false }));
    const page = MARK.page as { x: number; y: number; w: number; h: number };

    expect(monogram.minX).toBeGreaterThan(page.x);
    expect(monogram.maxX).toBeLessThan(page.x + page.w);
    expect(monogram.minY).toBeGreaterThan(page.y);
    expect(monogram.maxY).toBeLessThan(page.y + page.h);

    // Optically centred: the gaps either side agree to within half a percent
    // of the icon's width, which is under a pixel at 192 px.
    const leftGap = monogram.minX - page.x;
    const rightGap = page.x + page.w - monogram.maxX;
    expect(Math.abs(leftGap - rightGap)).toBeLessThan(0.005);
  });

  it('gives the second K a stylus that outruns the cap height at both ends', () => {
    // What makes it a pen and not a tall K. If a future tweak shortens either
    // end past the letterform, the logo quietly becomes a typo.
    const monogram = bounds(shapes({ body: false, page: false }));
    expect(monogram.minY).toBeLessThan(MARK.capTop as number);
    expect(monogram.maxY).toBeGreaterThan(MARK.capBottom as number);
  });

  it('fits inside the Android adaptive safe zone once scaled', () => {
    // The launcher draws the foreground at 108 dp and shows the middle 72 dp,
    // masked to a circle on some devices. Anything outside that is cropped,
    // and it is cropped on a stranger's phone rather than here.
    const foreground = bounds(shapes({ body: false }));
    const place = (v: number): number => v * ADAPTIVE_SCALE + ADAPTIVE_OFFSET;
    for (const edge of [place(foreground.minX), place(foreground.maxX), place(foreground.minY), place(foreground.maxY)]) {
      expect(edge).toBeGreaterThanOrEqual(ADAPTIVE_OFFSET - 1e-9);
      expect(edge).toBeLessThanOrEqual(1 - ADAPTIVE_OFFSET + 1e-9);
    }
  });

  it('leaves the folio out of the adaptive foreground', () => {
    // The launcher paints the background layer itself, from colors.xml. A
    // foreground that carried the navy body too would be masked into a
    // rounded square inside a circle.
    const foreground = shapes({ body: false });
    expect(foreground.some((s) => s.fill === PALETTE.navy)).toBe(false);
    expect(shapes().some((s) => s.fill === PALETTE.navy)).toBe(true);
    // …and that background colour is the one Android is told to paint.
    expect((LAUNCHER_BACKGROUND as string).toUpperCase()).toBe((PALETTE.navy as string).toUpperCase());
  });
});

describe('rendering', () => {
  it('paints navy at the edges, page in the middle and teal on the strokes', () => {
    const buffer = render(256, shapes());
    // A corner is outside the rounded body, so it is transparent.
    expect(pixel(buffer, 256, 0.004, 0.004)[3]).toBe(0);
    // Halfway down the left bezel: body.
    expectColour(pixel(buffer, 256, 0.03, 0.5), PALETTE.navy as string);
    // Inside the page but off the monogram.
    expectColour(pixel(buffer, 256, 0.12, 0.15), PALETTE.screen as string);
    // The first K's stem.
    expectColour(pixel(buffer, 256, (MARK.k1 as number) + (MARK.stem as number) / 2, 0.5), PALETTE.teal as string);
    // The hinge.
    expectColour(pixel(buffer, 256, (MARK.spine as { x: number; w: number }).x + 0.014, 0.5), PALETTE.spine as string);
  });

  it('antialiases rather than leaving a hard staircase', () => {
    // Supersampling is the whole reason the K's diagonals are legible at 48 px.
    // Without it every edge pixel would be one of two colours.
    const buffer = render(64, shapes());
    const navy = hex(PALETTE.navy as string);
    const screen = hex(PALETTE.screen as string);
    let blended = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const [r, g, b, a] = [buffer[i]!, buffer[i + 1]!, buffer[i + 2]!, buffer[i + 3]!];
      if (a === 0) continue;
      const isNavy = r === navy[0] && g === navy[1] && b === navy[2];
      const isScreen = r === screen[0] && g === screen[1] && b === screen[2];
      if (!isNavy && !isScreen) blended += 1;
    }
    expect(blended).toBeGreaterThan(100);
  });

  it('never leaves a half-covered edge darker than both sides', () => {
    // The un-premultiply step. Without it a partly covered pixel keeps its
    // colour scaled by coverage, and every edge fades towards black — which
    // looks like a drop shadow nobody asked for.
    const buffer = render(128, shapes());
    for (let i = 0; i < buffer.length; i += 4) {
      const a = buffer[i + 3]!;
      if (a === 0 || a === 255) continue;
      const brightness = buffer[i]! + buffer[i + 1]! + buffer[i + 2]!;
      // The darkest thing in the mark is the navy body.
      const floor = hex(PALETTE.navy as string).reduce((sum, c) => sum + c, 0);
      expect(brightness).toBeGreaterThanOrEqual(floor - 12);
    }
  });

  it('scales the adaptive foreground into the middle', () => {
    const size = 108;
    const buffer = render(size, shapes({ body: false }), { scale: ADAPTIVE_SCALE, offset: ADAPTIVE_OFFSET });
    // The outer ring is empty, so a mask has only transparency to crop.
    expect(pixel(buffer, size, 0.02, 0.5)[3]).toBe(0);
    expect(pixel(buffer, size, 0.98, 0.5)[3]).toBe(0);
    expect(pixel(buffer, size, 0.5, 0.02)[3]).toBe(0);
    // And the middle still carries the page.
    expect(pixel(buffer, size, 0.35, 0.3)[3]).toBe(255);
  });
});

describe('the containers', () => {
  it('writes a PNG that declares the size it is', () => {
    const data = png(64, shapes()) as Bytes;
    expect([...data.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(data.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(data.readUInt32BE(16)).toBe(64);
    expect(data.readUInt32BE(20)).toBe(64);
    expect(data[24]).toBe(8); // 8 bits per channel
    expect(data[25]).toBe(6); // RGBA
    expect(data.subarray(data.length - 8).toString('latin1')).toContain('IEND');
  });

  it('writes an ICO whose directory actually points at its images', () => {
    // A malformed directory does not throw here — it fails when the NSIS
    // installer is built, or worse, ships an icon Explorer refuses to draw.
    const sizes = [16, 32, 48, 256];
    const data = ico(sizes, shapes()) as Bytes;
    expect(data.readUInt16LE(0)).toBe(0);
    expect(data.readUInt16LE(2)).toBe(1); // type: icon
    expect(data.readUInt16LE(4)).toBe(sizes.length);

    for (const [index, size] of sizes.entries()) {
      const entry = 6 + 16 * index;
      // 256 does not fit in the one-byte field and is written as 0.
      expect(data[entry]).toBe(size >= 256 ? 0 : size);
      expect(data[entry + 1]).toBe(size >= 256 ? 0 : size);
      const length = data.readUInt32LE(entry + 8);
      const offset = data.readUInt32LE(entry + 12);
      expect(offset + length).toBeLessThanOrEqual(data.length);
      // Each entry is a whole PNG, which is what modern Windows expects.
      const image = data.subarray(offset, offset + length);
      expect([...image.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(image.readUInt32BE(16)).toBe(size);
    }
  });

  it('writes a favicon that is well-formed SVG of the same mark', () => {
    const svg = markSvg(shapes()) as string;
    expect(problems(svg)).toEqual([]);
    expect(svg).toContain('viewBox="0 0 1 1"');
    expect(svg).toContain(`aria-label="${PRODUCT_NAME}"`);
    // One element per shape, so nothing is silently dropped on the way out.
    const drawn = [...svg.matchAll(/<(rect|polygon)\b/g)].length;
    expect(drawn).toBe(shapes().length);
    for (const colour of Object.values(PALETTE as Record<string, string>)) {
      expect(svg).toContain(colour);
    }
  });
});

describe('the name', () => {
  it('is KK-Notes, from one place', () => {
    expect(PRODUCT_NAME).toBe('KK-Notes');
  });

  it('is what the Android launcher label is rewritten to', () => {
    const before = `<resources>
    <string name="app_name">"Notes"</string>
    <string name="main_activity_title">"Notes"</string>
</resources>`;
    const after = renameStrings(before, PRODUCT_NAME) as string;
    expect(after).toContain(`<string name="app_name">"${PRODUCT_NAME}"</string>`);
    expect(after).toContain(`<string name="main_activity_title">"${PRODUCT_NAME}"</string>`);
    expect(problems(after, 'strings.xml')).toEqual([]);
    // Idempotent: the script runs on every Android build.
    expect(renameStrings(after, PRODUCT_NAME)).toBe(after);
  });
});
