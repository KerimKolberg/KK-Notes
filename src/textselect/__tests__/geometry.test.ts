import { describe, expect, it } from 'vitest';
import { pdfPointToPage } from '../../pdf/pdfCoords';
import {
  caretAt,
  isCollapsed,
  ordered,
  runsFromItems,
  selectedText,
  selectionLines,
  spanHighlight,
  spanPolygon,
  spansBounds,
  wordAround,
  type RawTextItem,
} from '../geometry';

// A US-letter page shown at 1 page unit per point, the right way up.
const VIEW: [number, number, number, number] = [0, 0, 612, 792];
const upright = (x: number, y: number) => pdfPointToPage(x, y, VIEW, 0, 1);

/** A line of 10 pt text at baseline `y` (PDF space, from the bottom), each letter 5 pt wide. */
const item = (str: string, x: number, y: number, extra: Partial<RawTextItem> = {}): RawTextItem => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width: str.length * 5,
  height: 10,
  fontName: 'f1',
  ...extra,
});

const styles = { f1: { ascent: 0.8, descent: -0.2 } };

describe('runsFromItems', () => {
  it('places each item on the page: baseline, direction, length and letter height', () => {
    const [run] = runsFromItems([item('Hello', 100, 700)], styles, upright);
    expect(run!.origin).toEqual({ x: 100, y: 92 });
    expect(run!.dir.x).toBeCloseTo(1);
    expect(run!.up.y).toBeCloseTo(-1);
    expect(run!.length).toBeCloseTo(25);
    expect(run!.ascent).toBeCloseTo(8);
    expect(run!.descent).toBeCloseTo(2);
  });

  it('drops empty items but keeps the line ending they carry', () => {
    const runs = runsFromItems([item('one', 0, 700), { str: '', hasEOL: true }, item('two', 0, 680)], styles, upright);
    expect(runs.map((r) => [r.text, r.eol])).toEqual([['one', true], ['two', false]]);
  });

  it('follows a page shown turned a quarter: the text then runs down the page', () => {
    const turned = (x: number, y: number) => pdfPointToPage(x, y, VIEW, 90, 1);
    const [run] = runsFromItems([item('abc', 100, 700)], styles, turned);
    expect(run!.dir.x).toBeCloseTo(0);
    expect(Math.abs(run!.dir.y)).toBeCloseTo(1);
    expect(run!.length).toBeCloseTo(15);
  });

  it('uses usual proportions for a font it knows nothing about', () => {
    const [run] = runsFromItems([item('x', 0, 700, { fontName: 'unknown' })], styles, upright);
    expect(run!.ascent).toBeCloseTo(8);
    expect(run!.descent).toBeCloseTo(2);
  });
});

describe('carets and selected text', () => {
  // "The quick" then "brown fox" on the next line, and a second piece on the first line further right.
  const runs = runsFromItems(
    [item('The quick', 100, 700), item('jumps', 160, 700, { hasEOL: true }), item('brown fox', 100, 685)],
    styles,
    upright,
  );

  it('finds the gap between letters nearest a point', () => {
    expect(caretAt(runs, { x: 100, y: 88 })).toEqual({ run: 0, offset: 0 });
    expect(caretAt(runs, { x: 117, y: 88 })).toEqual({ run: 0, offset: 3 });
    expect(caretAt(runs, { x: 112, y: 104 })).toEqual({ run: 2, offset: 2 });
  });

  it('finds nothing when the point is far from any text and a limit is set', () => {
    expect(caretAt(runs, { x: 400, y: 500 }, 36)).toBeNull();
    expect(caretAt(runs, { x: 400, y: 500 })).not.toBeNull();
  });

  it('reads the selection in order, a space between pieces apart on a line and a break between lines', () => {
    const a = { run: 0, offset: 4 };
    const b = { run: 2, offset: 5 };
    expect(selectedText(runs, a, b)).toBe('quick jumps\nbrown');
    // Backwards is the same.
    expect(selectedText(runs, b, a)).toBe('quick jumps\nbrown');
    expect(ordered(b, a)[0]).toEqual(a);
  });

  it('adds no space between pieces that touch', () => {
    const touching = runsFromItems([item('fre', 0, 700), item('quency', 15, 700)], styles, upright);
    expect(selectedText(touching, { run: 0, offset: 0 }, { run: 1, offset: 6 })).toBe('frequency');
  });

  it('knows a selection with nothing in it', () => {
    expect(isCollapsed(runs, { run: 0, offset: 2 }, { run: 0, offset: 2 })).toBe(true);
    expect(isCollapsed(runs, { run: 0, offset: 9 }, { run: 1, offset: 0 })).toBe(true);
    expect(isCollapsed(runs, { run: 0, offset: 2 }, { run: 0, offset: 3 })).toBe(false);
  });

  it('takes the word around a caret, and the word just before one', () => {
    expect(selectedText(runs, ...wordAround(runs, { run: 0, offset: 6 })!)).toBe('quick');
    expect(selectedText(runs, ...wordAround(runs, { run: 0, offset: 3 })!)).toBe('The');
    expect(wordAround(runs, { run: 9, offset: 0 })).toBeNull();
  });
});

describe('shapes of a selection', () => {
  const runs = runsFromItems(
    [item('The quick', 100, 700), item('jumps', 160, 700, { hasEOL: true }), item('brown fox', 100, 685)],
    styles,
    upright,
  );

  it('is one span per line, pieces of a line joined', () => {
    const lines = selectionLines(runs, { run: 0, offset: 4 }, { run: 2, offset: 5 });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.from).toBeCloseTo(20);
    expect(lines[0]!.to).toBeCloseTo(85);
    expect(lines[1]!.from).toBeCloseTo(0);
    expect(lines[1]!.to).toBeCloseTo(25);
  });

  it('outlines a span from the tops of its letters to below the baseline', () => {
    const [line] = selectionLines(runs, { run: 0, offset: 0 }, { run: 0, offset: 3 });
    const poly = spanPolygon(line!);
    expect(poly.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([[100, 84], [115, 84], [115, 94], [100, 94]]);
    expect(spansBounds([line!])).toEqual({ x: 100, y: 84, width: 15, height: 10 });
  });

  it('highlights along the middle of the letters, as thick as they are tall, ends pulled in for the round caps', () => {
    const [line] = selectionLines(runs, { run: 0, offset: 0 }, { run: 0, offset: 9 });
    const h = spanHighlight(line!);
    expect(h.width).toBeCloseTo(10);
    expect(h.from.y).toBeCloseTo(89);
    expect(h.from.x).toBeCloseTo(102.5);
    expect(h.to.x).toBeCloseTo(142.5);
  });

  it('keeps a very short highlight a point rather than turned inside out', () => {
    const [line] = selectionLines(runs, { run: 0, offset: 0 }, { run: 0, offset: 1 });
    const h = spanHighlight(line!);
    expect(h.from.x).toBeCloseTo(h.to.x);
  });
});
