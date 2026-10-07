/**
 * Typed text with its formatting — the model behind a text box once it can be formatted in parts.
 *
 * A box's text is a list of **blocks** (paragraphs), each a list of **runs** (stretches of text in one style).
 * It is flat on purpose, the way Google Docs keeps it rather than the way HTML nests it: a list item is a
 * paragraph that says which list it is in and how far in it is, a heading is a paragraph that says it is one.
 * Flat is what makes the rest simple — laying it out on a canvas or into a PDF, splitting it where a page is
 * full and joining it again (`flow.ts`), and counting it — and nothing a word processor offers needs more.
 *
 * Marks on a run are *differences* from the box: a run with no `size` is in the box's size, so changing the
 * box's size changes every run that was not given its own. Bold, italic, underline and strikethrough are
 * marks only; a box written before runs existed carries them for the whole box, and is read as runs that all
 * have them ({@link richOf}).
 *
 * The box keeps the plain words too (`TextBox.text`), always in step ({@link richPatch}): search reads those.
 */
import { textStyleOf } from './media';
import type {
  RichBlock,
  RichBlockKind,
  RichList,
  RichMarks,
  RichRun,
  RichScript,
  RichText,
  TextAlign,
  TextBox,
  TextFontId,
  TextStyle,
} from './types';

/** How far a list can nest, or a paragraph be indented. */
export const MAX_INDENT = 6;
/** One step of indent, as a multiple of the box's font size. */
export const INDENT_STEP = 1.6;
/** How much larger a heading is than the box's text. */
export const HEADING_SCALE: Readonly<Record<RichBlockKind, number>> = { p: 1, h1: 1.75, h2: 1.4, h3: 1.2 };
/** Space above and below a paragraph, as a multiple of its own font size (CSS margins: they collapse). */
export const BLOCK_SPACING: Readonly<Record<RichBlockKind | 'item', { readonly before: number; readonly after: number }>> = {
  p: { before: 0, after: 0.4 },
  item: { before: 0, after: 0.15 },
  h1: { before: 0.6, after: 0.3 },
  h2: { before: 0.6, after: 0.3 },
  h3: { before: 0.5, after: 0.25 },
};
/** Superscript and subscript: smaller, and moved off the line by this much of the text's size. */
export const SCRIPT_SCALE = 0.75;

export const EMPTY_RICH: RichText = { blocks: [{ runs: [] }] };

const MARK_KEYS = ['bold', 'italic', 'underline', 'strike', 'color', 'highlight', 'size', 'font', 'script'] as const;
type MarkKey = (typeof MARK_KEYS)[number];

/** Just the marks of a run. */
export function marksOf(run: RichMarks): RichMarks {
  const out: Record<string, unknown> = {};
  for (const key of MARK_KEYS) {
    const value = run[key];
    if (value !== undefined && value !== false) out[key] = value;
  }
  return out as RichMarks;
}

export function sameMarks(a: RichMarks, b: RichMarks): boolean {
  return MARK_KEYS.every((key: MarkKey) => (a[key] || undefined) === (b[key] || undefined));
}

/** Runs without empty ones, and with neighbours in the same style made one. */
export function normalizeRuns(runs: readonly RichRun[]): RichRun[] {
  const out: RichRun[] = [];
  for (const run of runs) {
    if (run.text === '') continue;
    const last = out[out.length - 1];
    if (last && sameMarks(last, run)) out[out.length - 1] = { ...marksOf(last), text: last.text + run.text };
    else out.push({ ...marksOf(run), text: run.text });
  }
  return out;
}

export function blockText(block: RichBlock): string {
  let text = '';
  for (const run of block.runs) text += run.text;
  return text;
}

/** How many characters a block holds — its positions, as an editor counts them (a line break is one). */
export function blockLength(block: RichBlock): number {
  let n = 0;
  for (const run of block.runs) n += run.text.length;
  return n;
}

/** The words, one line per paragraph: what search reads, and what an older version of the app shows. */
export function plainText(rich: RichText): string {
  return rich.blocks.map(blockText).join('\n');
}

export function isRichEmpty(rich: RichText): boolean {
  return rich.blocks.every((block) => block.runs.every((run) => run.text === ''));
}

/** Text written before it could be formatted in parts: a paragraph per line, in the box's style throughout. */
export function richFromPlain(text: string, style: Partial<Pick<TextStyle, 'bold' | 'italic' | 'underline' | 'strikethrough'>> = {}): RichText {
  const marks: RichMarks = marksOf({
    bold: style.bold === true,
    italic: style.italic === true,
    underline: style.underline === true,
    strike: style.strikethrough === true,
  });
  const blocks = text.split(/\r?\n/).map((line): RichBlock => ({ runs: line === '' ? [] : [{ ...marks, text: line }] }));
  return { blocks: blocks.length > 0 ? blocks : EMPTY_RICH.blocks };
}

// ---------------------------------------------------------------------------
// Reading a box
// ---------------------------------------------------------------------------

const KINDS = new Set<RichBlockKind>(['p', 'h1', 'h2', 'h3']);
const LISTS = new Set<RichList>(['bullet', 'number', 'check']);
const ALIGNS = new Set(['left', 'center', 'right', 'justify']);
const FONTS = new Set<TextFontId>(['sans', 'serif', 'mono']);
const SCRIPTS = new Set<RichScript>(['sup', 'sub']);

function readRun(raw: unknown): RichRun | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== 'string') return null;
  const run: Record<string, unknown> = { text: r.text };
  for (const key of ['bold', 'italic', 'underline', 'strike'] as const) if (r[key] === true) run[key] = true;
  for (const key of ['color', 'highlight'] as const) if (typeof r[key] === 'string' && r[key] !== '') run[key] = r[key];
  if (typeof r.size === 'number' && Number.isFinite(r.size) && r.size > 0) run.size = Math.min(400, r.size);
  if (typeof r.font === 'string' && FONTS.has(r.font as TextFontId)) run.font = r.font;
  if (typeof r.script === 'string' && SCRIPTS.has(r.script as RichScript)) run.script = r.script;
  return run as unknown as RichRun;
}

function readBlock(raw: unknown): RichBlock | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const runs = Array.isArray(b.runs) ? b.runs.map(readRun).filter((r): r is RichRun => r !== null) : [];
  const block: Record<string, unknown> = { runs: normalizeRuns(runs) };
  if (typeof b.kind === 'string' && KINDS.has(b.kind as RichBlockKind) && b.kind !== 'p') block.kind = b.kind;
  if (typeof b.list === 'string' && LISTS.has(b.list as RichList)) block.list = b.list;
  if (typeof b.indent === 'number' && Number.isFinite(b.indent) && b.indent > 0) block.indent = clampIndent(b.indent);
  if (b.checked === true) block.checked = true;
  if (typeof b.align === 'string' && ALIGNS.has(b.align)) block.align = b.align;
  if (b.cont === true) block.cont = true;
  if (b.pageBreak === true) block.pageBreak = true;
  return block as unknown as RichBlock;
}

/** Rich text from a file, checked: anything malformed is left out rather than trusted. `null` if there is none. */
export function readRich(raw: unknown): RichText | null {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { blocks?: unknown }).blocks)) return null;
  const blocks = ((raw as { blocks: unknown[] }).blocks).map(readBlock).filter((b): b is RichBlock => b !== null);
  return { blocks: blocks.length > 0 ? blocks : EMPTY_RICH.blocks };
}

const richCache = new WeakMap<TextBox, RichText>();

/**
 * A box's text as rich text: its own, checked, or — for a box written before it had any — its plain text in its
 * style. Worked out once per box object; a box is replaced, never changed, when it is edited.
 */
export function richOf(box: TextBox): RichText {
  let rich = richCache.get(box);
  if (!rich) {
    rich = (box.rich && readRich(box.rich)) || richFromPlain(box.text ?? '', box);
    richCache.set(box, rich);
  }
  return rich;
}

/** What a box's text is set in when a run says nothing of its own. */
export interface RichBase {
  readonly fontFamily: TextFontId;
  readonly fontSize: number;
  readonly color: string;
  readonly align: TextAlign;
}

/** A box's own style, as the base its runs are set against. */
export function richBaseOf(box: TextBox): RichBase {
  const style = textStyleOf(box);
  return { fontFamily: style.fontFamily, fontSize: style.fontSize, color: style.color, align: style.align };
}

export function clampIndent(value: number): number {
  return Math.max(0, Math.min(MAX_INDENT, Math.round(value)));
}

/**
 * The change that stores new rich text in a box: the text, its plain words with it, and the box's own bold,
 * italic, underline and strikethrough off — they are marks on the runs now, and left on they would apply twice.
 */
export function richPatch(rich: RichText): Pick<TextBox, 'rich' | 'text' | 'bold' | 'italic' | 'underline' | 'strikethrough'> {
  return { rich, text: plainText(rich), bold: false, italic: false, underline: false, strikethrough: false };
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** What stands before a paragraph: a bullet, a number, a box to tick, or nothing. */
export type ListMarker =
  | { readonly kind: 'bullet'; readonly shape: 'disc' | 'circle' | 'square'; readonly text: string }
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'check'; readonly checked: boolean };

const BULLETS = [
  { shape: 'disc', text: '•' },
  { shape: 'circle', text: '◦' },
  { shape: 'square', text: '▪' },
] as const;

function letters(n: number): string {
  let out = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(97 + ((k - 1) % 26)) + out;
  return out;
}

function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let out = '';
  let rest = n;
  for (const [value, digits] of table) {
    while (rest >= value) {
      out += digits;
      rest -= value;
    }
  }
  return out;
}

/** A list number as a level writes it: 1. then a. then i., and round again — as Word and Docs do. */
export function numberLabel(n: number, level: number): string {
  const style = level % 3;
  return `${style === 0 ? n : style === 1 ? letters(n) : roman(n)}.`;
}

/**
 * Each paragraph's marker. Numbers count the items of a list at their level, starting again below an item
 * further out and after anything that is not in a list; the rest of a paragraph carried over from the page
 * before (`cont`) neither shows a marker nor counts.
 */
export function listMarkers(blocks: readonly RichBlock[]): (ListMarker | null)[] {
  const counters: number[] = [];
  return blocks.map((block) => {
    if (block.cont) return null;
    if (!block.list) {
      counters.length = 0;
      return null;
    }
    const level = clampIndent(block.indent ?? 0);
    counters.length = level + 1;
    if (block.list === 'check') return { kind: 'check', checked: block.checked === true };
    if (block.list === 'bullet') {
      counters[level] = 0;
      return { kind: 'bullet', ...BULLETS[level % BULLETS.length]! };
    }
    counters[level] = (counters[level] ?? 0) + 1;
    return { kind: 'number', text: numberLabel(counters[level]!, level) };
  });
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

const HAS_WORD = /[\p{L}\p{N}]/u;
/** Scripts written without spaces between words, where Word counts each character as a word. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;

/**
 * Words, as a word processor counts them: anything between spaces with a letter or a digit in it — so a dash
 * standing alone is not one — and each character of Chinese or Japanese, which put no spaces between words.
 */
export function countWords(text: string): number {
  let n = 0;
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    const unspaced = token.match(UNSPACED);
    if (!unspaced) {
      if (HAS_WORD.test(token)) n += 1;
      continue;
    }
    n += unspaced.length;
    for (const rest of token.replace(UNSPACED, ' ').split(' ')) if (HAS_WORD.test(rest)) n += 1;
  }
  return n;
}

export interface TextStats {
  readonly words: number;
  /** With spaces, without the ends of paragraphs. */
  readonly characters: number;
  readonly charactersNoSpaces: number;
  /** Paragraphs with something in them. */
  readonly paragraphs: number;
}

export const NO_STATS: TextStats = { words: 0, characters: 0, charactersNoSpaces: 0, paragraphs: 0 };

/** Counts for some texts, each a paragraph per line. */
export function textStats(texts: readonly string[]): TextStats {
  let words = 0;
  let characters = 0;
  let charactersNoSpaces = 0;
  let paragraphs = 0;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      paragraphs += 1;
      words += countWords(line);
      for (const ch of line) {
        characters += 1;
        if (!/\s/u.test(ch)) charactersNoSpaces += 1;
      }
    }
  }
  return { words, characters, charactersNoSpaces, paragraphs };
}

export function addStats(a: TextStats, b: TextStats): TextStats {
  return {
    words: a.words + b.words,
    characters: a.characters + b.characters,
    charactersNoSpaces: a.charactersNoSpaces + b.charactersNoSpaces,
    paragraphs: a.paragraphs + b.paragraphs,
  };
}

// ---------------------------------------------------------------------------
// Cutting and joining (for text that flows from page to page)
// ---------------------------------------------------------------------------

/** The runs between two character positions of a block. */
export function sliceRuns(runs: readonly RichRun[], from: number, to = Infinity): RichRun[] {
  const out: RichRun[] = [];
  let at = 0;
  for (const run of runs) {
    const start = at;
    const end = at + run.text.length;
    at = end;
    if (end <= from || start >= to) continue;
    const text = run.text.slice(Math.max(0, from - start), Math.min(run.text.length, to - start));
    if (text !== '') out.push({ ...marksOf(run), text });
  }
  return out;
}

/**
 * A block cut in two at a character position: the first part keeps everything the paragraph is, the second is
 * its continuation (`cont`), which shows no marker of its own and joins it again with {@link joinBlocks}.
 */
export function splitBlock(block: RichBlock, offset: number): [RichBlock, RichBlock] {
  const head: RichBlock = { ...block, runs: sliceRuns(block.runs, 0, offset) };
  const { cont: _cont, pageBreak: _break, ...rest } = block;
  void _cont;
  void _break;
  const tail: RichBlock = { ...rest, cont: true, runs: sliceRuns(block.runs, offset) };
  return [head, tail];
}

/** Two blocks as one: the first's paragraph, with the second's text after its own. */
export function joinBlocks(a: RichBlock, b: RichBlock): RichBlock {
  return { ...a, runs: normalizeRuns([...a.runs, ...b.runs]) };
}

/** The blocks with each continuation joined to the paragraph it continues. */
export function mergeContinuations(blocks: readonly RichBlock[]): RichBlock[] {
  const out: RichBlock[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (block.cont && last) out[out.length - 1] = joinBlocks(last, block);
    else if (block.cont) {
      const { cont: _cont, ...rest } = block;
      void _cont;
      out.push(rest);
    } else out.push(block);
  }
  return out;
}
