/**
 * The words in a page's handwriting, for searching it.
 *
 * A recogniser (Windows' own, see `recognizer.ts`) reads the pen strokes of a page into words with boxes; the
 * result is kept on the page (`Page.inkText`) and saved with the note. Kept alongside it is a fingerprint of the
 * handwriting it was read from, so the page is read again only when its writing changes, and a note opened on a
 * device that cannot read handwriting is still searchable from what was read elsewhere.
 *
 * Pure: strokes and words in, fingerprints, payloads and text out.
 */
import type { InkText, InkWord } from '../document/types';
import type { FreehandStroke, Stroke } from '../inking/types';

/** Handwriting is what the pen wrote: not the highlighter, tape, shapes or the pixel eraser. */
export function isHandwriting(stroke: Stroke): stroke is FreehandStroke {
  return stroke.kind === 'freehand' && stroke.tool === 'pen';
}

const keys = new WeakMap<readonly Stroke[], string>();

/**
 * A fingerprint of a page's handwriting: every pen stroke's id, where it is and how many points it has, hashed.
 * Strokes never change in place (a moved stroke is a new object with a new box), so this changes whenever the
 * writing does; and the page's stroke array is a new array after every edit, so it is worked out once per edit.
 * `''` for a page with no handwriting.
 */
export function inkKey(strokes: readonly Stroke[]): string {
  const cached = keys.get(strokes);
  if (cached !== undefined) return cached;
  let hash = 0x811c9dc5;
  let count = 0;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const stroke of strokes) {
    if (!isHandwriting(stroke)) continue;
    count += 1;
    const b = stroke.bbox;
    mix(`${stroke.id}:${Math.round(b.minX)},${Math.round(b.minY)},${Math.round(b.maxX)},${Math.round(b.maxY)},${stroke.points.length};`);
  }
  const key = count === 0 ? '' : `${count}-${(hash >>> 0).toString(36)}`;
  keys.set(strokes, key);
  return key;
}

/** What `by` says for the recogniser Windows picks itself (the one for the language it is set to). */
export const DEFAULT_RECOGNIZER = 'default';

/** Whether a page's words are what its handwriting says now, as read by `by`. */
export function inkTextIsCurrent(page: { readonly strokes: readonly Stroke[]; readonly inkText?: InkText }, by: string): boolean {
  const key = inkKey(page.strokes);
  if (key === '') return page.inkText === undefined;
  return page.inkText !== undefined && page.inkText.key === key && page.inkText.by === by;
}

/** Points closer than this (page units) to the last one kept are left out: the recogniser reads shapes, not samples. */
const MIN_STEP = 1;

const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The handwriting as the recogniser takes it: each stroke a flat run of x, y, pressure. Points closer together
 * than a page unit are dropped (a stroke's last point never is), which keeps what crosses to the recogniser
 * small without changing a letter; a dot is given a second point, since a stroke of one point is not a stroke.
 */
export function recognizerInput(strokes: readonly Stroke[]): { points: number[] }[] {
  const out: { points: number[] }[] = [];
  for (const stroke of strokes) {
    if (!isHandwriting(stroke)) continue;
    const points = stroke.points;
    const flat: number[] = [];
    let lastX = Number.NaN;
    let lastY = Number.NaN;
    points.forEach((p, i) => {
      const last = i === points.length - 1;
      if (i > 0 && !last && Math.hypot(p.x - lastX, p.y - lastY) < MIN_STEP) return;
      flat.push(r2(p.x), r2(p.y), Math.round(Math.min(1, Math.max(0.01, p.pressure || 0.5)) * 1000) / 1000);
      lastX = p.x;
      lastY = p.y;
    });
    if (flat.length === 0) continue;
    if (flat.length === 3) flat.push(r2(flat[0]! + 0.5), flat[1]!, flat[2]!);
    out.push({ points: flat });
  }
  return out;
}

/** Most words kept for one page: more than any page holds, few enough that a broken file cannot balloon. */
export const MAX_INK_WORDS = 4000;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One word as a recogniser or a file gives it, if it is one. */
export function toInkWord(raw: unknown): InkWord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as Record<string, unknown>;
  const text = typeof w.text === 'string' ? w.text.replace(/\s+/g, ' ').trim() : '';
  if (!text || !isNumber(w.x) || !isNumber(w.y) || !isNumber(w.width) || !isNumber(w.height)) return null;
  return { text: text.slice(0, 200), x: w.x, y: w.y, width: Math.max(0, w.width), height: Math.max(0, w.height) };
}

/** A page's words as a file gives them, checked; `undefined` for anything that is not. */
export function normalizeInkText(raw: unknown): InkText | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || typeof r.by !== 'string' || !Array.isArray(r.words)) return undefined;
  const words: InkWord[] = [];
  for (const w of r.words.slice(0, MAX_INK_WORDS)) {
    const word = toInkWord(w);
    if (word) words.push(word);
  }
  return { key: r.key.slice(0, 64), by: r.by.slice(0, 200), words };
}

/**
 * Words into lines, top to bottom, each left to right. A word belongs to a line when most of its height overlaps
 * the line's; recognisers usually hand words back in this order already, but nothing promises it.
 */
export function inkLines(words: readonly InkWord[]): InkWord[][] {
  const byTop = [...words].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  const lines: { top: number; bottom: number; words: InkWord[] }[] = [];
  for (const word of byTop) {
    const top = word.y;
    const bottom = word.y + word.height;
    const line = lines.find((l) => {
      const overlap = Math.min(bottom, l.bottom) - Math.max(top, l.top);
      return overlap > 0.5 * Math.min(Math.max(1, word.height), Math.max(1, l.bottom - l.top));
    });
    if (line) {
      line.words.push(word);
      line.top = Math.min(line.top, top);
      line.bottom = Math.max(line.bottom, bottom);
    } else {
      lines.push({ top, bottom, words: [word] });
    }
  }
  return lines.sort((a, b) => a.top - b.top).map((l) => l.words.sort((a, b) => a.x - b.x));
}

/** Words in reading order. */
export function inReadingOrder(words: readonly InkWord[]): InkWord[] {
  return inkLines(words).flat();
}

/** A word and where it is in the page's text. */
export interface InkSpan {
  readonly start: number;
  readonly end: number;
  readonly word: InkWord;
}

/** A page's handwriting as one text — words with spaces, lines with line breaks — and where each word is in it. */
export function inkPageText(words: readonly InkWord[]): { readonly text: string; readonly spans: readonly InkSpan[] } {
  let text = '';
  const spans: InkSpan[] = [];
  inkLines(words).forEach((line, i) => {
    if (i > 0) text += '\n';
    line.forEach((word, j) => {
      if (j > 0) text += ' ';
      spans.push({ start: text.length, end: text.length + word.text.length, word });
      text += word.text;
    });
  });
  return { text, spans };
}

/** The word a match starting at `offset` of the page's text falls in. */
export function wordAt(spans: readonly InkSpan[], offset: number): InkWord | null {
  for (const span of spans) if (offset >= span.start && offset < span.end) return span.word;
  return null;
}

/** How far reading a note has got: pages with handwriting, and how many of them are read as they are now. */
export function handwritingProgress(pages: readonly { readonly strokes: readonly Stroke[]; readonly inkText?: InkText }[], by: string): { readonly read: number; readonly total: number } {
  let read = 0;
  let total = 0;
  for (const page of pages) {
    if (inkKey(page.strokes) === '') continue;
    total += 1;
    if (inkTextIsCurrent(page, by)) read += 1;
  }
  return { read, total };
}

/** A recogniser's name without what every one of them says ("Microsoft …", "… Handwriting Recognizer"). */
export function recognizerLabel(name: string): string {
  const short = name.replace(/^Microsoft\s+/i, '').replace(/\s+Handwriting Recogni[sz]er$/i, '').trim();
  return short || name;
}
