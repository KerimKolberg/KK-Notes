/**
 * Where a PDF page's text is, for selecting it.
 *
 * PDF.js hands a page's text back as items: a string, the matrix that places it (in PDF user space, font size
 * included) and how long it runs. Each becomes a {@link TextRun} on the note's page — its baseline's start, the
 * direction the text runs and the direction "up" is, its length and how far its letters reach above and below the
 * baseline, all in page units — so a point on the page can be turned into a place in the text, and a stretch of
 * text back into shapes on the page, whatever way the page is turned.
 *
 * Positions inside an item are found by sharing its length out evenly between its letters. PDF.js does not say
 * where each letter is, and the error is a fraction of a letter in the narrow items most PDFs are made of.
 *
 * Pure: items and a mapping in, geometry out.
 */
import type { Point } from '../inking/types';

/** What of a PDF.js text item is read. */
export interface RawTextItem {
  readonly str?: string;
  readonly transform?: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly fontName?: string;
  readonly hasEOL?: boolean;
}

/** What of a PDF.js text style is read: how far the font reaches above and below the baseline, per unit of size. */
export interface RawTextStyle {
  readonly ascent?: number;
  readonly descent?: number;
}

/** One piece of text, placed on the page. */
export interface TextRun {
  readonly text: string;
  /** The start of its baseline. */
  readonly origin: Point;
  /** Unit vector along the text. */
  readonly dir: Point;
  /** Unit vector from the baseline towards the tops of the letters. */
  readonly up: Point;
  /** How far it runs along `dir`. */
  readonly length: number;
  readonly ascent: number;
  /** Below the baseline, as a positive distance. */
  readonly descent: number;
  /** The line ends after it. */
  readonly eol: boolean;
}

/** A place between two letters: before letter `offset` of run `run` (`offset` may be the run's length: after it). */
export interface Caret {
  readonly run: number;
  readonly offset: number;
}

/** A selected stretch of one line, in the line's own frame. */
export interface LineSpan {
  readonly origin: Point;
  readonly dir: Point;
  readonly up: Point;
  /** From and to, along `dir` from `origin`. */
  readonly from: number;
  readonly to: number;
  readonly ascent: number;
  readonly descent: number;
}

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = 0.2;

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;
const at = (o: Point, dir: Point, s: number, up: Point, t: number): Point => ({ x: o.x + dir.x * s + up.x * t, y: o.y + dir.y * s + up.y * t });

function unit(v: Point): Point | null {
  const len = Math.hypot(v.x, v.y);
  return len > 1e-9 ? { x: v.x / len, y: v.y / len } : null;
}

/**
 * The page's text as runs. `map` takes a PDF user-space point to the note's page (see `pdfPointToPage`). Items
 * with no letters are dropped, but a line ending they carry is kept on the run before.
 */
export function runsFromItems(
  items: readonly RawTextItem[],
  styles: Readonly<Record<string, RawTextStyle>>,
  map: (x: number, y: number) => Point,
): TextRun[] {
  const runs: TextRun[] = [];
  for (const item of items) {
    const text = typeof item.str === 'string' ? item.str : '';
    if (text.length === 0) {
      if (item.hasEOL && runs.length > 0) runs[runs.length - 1] = { ...runs[runs.length - 1]!, eol: true };
      continue;
    }
    const m = item.transform;
    if (!m || m.length < 6) continue;
    const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
    const along = unit({ x: a, y: b });
    const rise = unit({ x: c, y: d });
    if (!along || !rise) continue;
    const size = Math.hypot(c, d) || item.height || 0;
    const width = typeof item.width === 'number' && item.width > 0 ? item.width : size * 0.5 * text.length;
    const style = item.fontName ? styles[item.fontName] : undefined;
    const ascentPart = style?.ascent && style.ascent > 0 ? Math.min(style.ascent, 1.2) : DEFAULT_ASCENT;
    const descentPart = style?.descent && style.descent < 0 ? Math.min(-style.descent, 0.6) : DEFAULT_DESCENT;

    const origin = map(e, f);
    const end = map(e + along.x * width, f + along.y * width);
    const top = map(e + rise.x * size * ascentPart, f + rise.y * size * ascentPart);
    const bottom = map(e - rise.x * size * descentPart, f - rise.y * size * descentPart);
    const dir = unit(sub(end, origin));
    const upDir = unit(sub(top, origin));
    if (!dir || !upDir) continue;
    runs.push({
      text,
      origin,
      dir,
      up: upDir,
      length: Math.hypot(end.x - origin.x, end.y - origin.y),
      ascent: Math.hypot(top.x - origin.x, top.y - origin.y),
      descent: Math.hypot(bottom.x - origin.x, bottom.y - origin.y),
      eol: Boolean(item.hasEOL),
    });
  }
  return runs;
}

/** How far a point is from a run's box (0 inside), the up-down distance counting double: lines are close together. */
function distanceTo(run: TextRun, p: Point): { distance: number; along: number } {
  const v = sub(p, run.origin);
  const s = dot(v, run.dir);
  const t = dot(v, run.up);
  const dx = Math.max(0, -s, s - run.length);
  const dy = Math.max(0, -run.descent - t, t - run.ascent);
  return { distance: Math.hypot(dx, dy * 2), along: s };
}

/**
 * The place in the text nearest `p`, or `null` when no text is within `maxDistance` (page units). The place is
 * the gap between letters closest to the point along its run.
 */
export function caretAt(runs: readonly TextRun[], p: Point, maxDistance = Infinity): Caret | null {
  let best: Caret | null = null;
  let bestDistance = Infinity;
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    const { distance, along } = distanceTo(run, p);
    if (distance >= bestDistance || distance > maxDistance) continue;
    bestDistance = distance;
    const n = run.text.length;
    const offset = run.length > 0 ? Math.round((along / run.length) * n) : 0;
    best = { run: index, offset: Math.min(n, Math.max(0, offset)) };
  }
  return best;
}

export function compareCarets(a: Caret, b: Caret): number {
  return a.run - b.run || a.offset - b.offset;
}

/** The two ends in reading order. */
export function ordered(a: Caret, b: Caret): readonly [Caret, Caret] {
  return compareCarets(a, b) <= 0 ? [a, b] : [b, a];
}

/** True when nothing lies between the two. */
export function isCollapsed(runs: readonly TextRun[], a: Caret, b: Caret): boolean {
  const [from, to] = ordered(a, b);
  if (from.run === to.run) return from.offset === to.offset;
  // From the very end of one run to the very start of the next is nothing either.
  return to.run === from.run + 1 && from.offset >= (runs[from.run]?.text.length ?? 0) && to.offset === 0;
}

/** Whether `next` starts a new line after `prev`: a line ending, or a baseline clearly above or below. */
function newLine(prev: TextRun, next: TextRun): boolean {
  if (prev.eol) return true;
  const t = dot(sub(next.origin, prev.origin), prev.up);
  return Math.abs(t) > Math.max(prev.ascent, next.ascent) * 0.5 || dot(next.dir, prev.dir) < 0.9;
}

/** The letters of each run between the two ends, as [run, start, end]. */
function pieces(runs: readonly TextRun[], a: Caret, b: Caret): [number, number, number][] {
  const [from, to] = ordered(a, b);
  const out: [number, number, number][] = [];
  for (let i = from.run; i <= to.run && i < runs.length; i++) {
    const run = runs[i]!;
    const start = i === from.run ? from.offset : 0;
    const end = i === to.run ? to.offset : run.text.length;
    if (end > start) out.push([i, start, end]);
  }
  return out;
}

/**
 * The selected text as it would be copied: a line break where the PDF's lines break, a space where two pieces of
 * one line stand apart without one, and nothing added between pieces that touch (a word split across items).
 */
export function selectedText(runs: readonly TextRun[], a: Caret, b: Caret): string {
  let out = '';
  let prev: TextRun | null = null;
  for (const [i, start, end] of pieces(runs, a, b)) {
    const run = runs[i]!;
    const piece = run.text.slice(start, end);
    if (prev) {
      if (newLine(prev, run)) out = out.replace(/[ \t]+$/, '') + '\n';
      else {
        const gap = dot(sub(run.origin, prev.origin), prev.dir) - prev.length;
        if (gap > (prev.ascent + prev.descent) * 0.15 && !/\s$/.test(out) && !/^\s/.test(piece)) out += ' ';
      }
    }
    out += piece;
    prev = run;
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

/** The selected stretch of each line, pieces of one line joined into one span. */
export function selectionLines(runs: readonly TextRun[], a: Caret, b: Caret): LineSpan[] {
  const lines: LineSpan[] = [];
  let prev: TextRun | null = null;
  for (const [i, start, end] of pieces(runs, a, b)) {
    const run = runs[i]!;
    const n = run.text.length;
    const s0 = (start / n) * run.length;
    const s1 = (end / n) * run.length;
    const last = lines[lines.length - 1];
    if (last && prev && !newLine(prev, run)) {
      // Same line: measure this piece in the line's frame and stretch the span to cover it.
      const offset = dot(sub(run.origin, last.origin), last.dir);
      lines[lines.length - 1] = {
        ...last,
        from: Math.min(last.from, offset + s0),
        to: Math.max(last.to, offset + s1),
        ascent: Math.max(last.ascent, run.ascent),
        descent: Math.max(last.descent, run.descent),
      };
    } else {
      lines.push({ origin: run.origin, dir: run.dir, up: run.up, from: s0, to: s1, ascent: run.ascent, descent: run.descent });
    }
    prev = run;
  }
  return lines.filter((l) => l.to - l.from > 0.01);
}

/** A span's outline, four corners. */
export function spanPolygon(span: LineSpan): Point[] {
  return [
    at(span.origin, span.dir, span.from, span.up, span.ascent),
    at(span.origin, span.dir, span.to, span.up, span.ascent),
    at(span.origin, span.dir, span.to, span.up, -span.descent),
    at(span.origin, span.dir, span.from, span.up, -span.descent),
  ];
}

/**
 * How far in from each end of the text a highlight's line stops, as a share of its thickness. The stroke's round
 * ends reach half its thickness past its last points, so the colour runs a little past the words, as a real
 * highlighter's does, without reaching into the next word.
 */
export const HIGHLIGHT_END_INSET = 0.25;

/** The line a highlighter would draw over a span: along its middle, as thick as the letters are tall. */
export function spanHighlight(span: LineSpan): { readonly from: Point; readonly to: Point; readonly width: number } {
  const width = span.ascent + span.descent;
  const middle = (span.ascent - span.descent) / 2;
  const inset = Math.min(width * HIGHLIGHT_END_INSET, (span.to - span.from) / 2);
  return {
    from: at(span.origin, span.dir, span.from + inset, span.up, middle),
    to: at(span.origin, span.dir, span.to - inset, span.up, middle),
    width,
  };
}

/** The box around some spans, in page units. */
export function spansBounds(spans: readonly LineSpan[]): { x: number; y: number; width: number; height: number } | null {
  const points = spans.flatMap(spanPolygon);
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The word around a caret: letters and digits, with what joins them inside a word (an apostrophe, a hyphen). */
export function wordAround(runs: readonly TextRun[], caret: Caret): readonly [Caret, Caret] | null {
  const run = runs[caret.run];
  if (!run) return null;
  const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}'’_-]/u.test(ch);
  let start = Math.min(caret.offset, run.text.length);
  let end = start;
  // A caret just after a word takes that word.
  if (!isWord(run.text[start]) && isWord(run.text[start - 1])) start -= 1;
  if (!isWord(run.text[start])) return null;
  end = start;
  while (start > 0 && isWord(run.text[start - 1])) start -= 1;
  while (end < run.text.length && isWord(run.text[end])) end += 1;
  return [
    { run: caret.run, offset: start },
    { run: caret.run, offset: end },
  ];
}
