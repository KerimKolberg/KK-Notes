/**
 * Rich text laid out into lines, for the two places that draw text without a browser's layout: a page's raster
 * (thumbnails, snapshots of pages out of view) and the PDF export.
 *
 * It follows the CSS the live editor is set with (`richDom.ts`) closely enough that a page and its export line
 * up: the same spacing around paragraphs (margins, collapsing), the same indents and list markers, a line as
 * tall as 1.35 times its largest text, the baseline where a browser puts it. It cannot be exact — the screen's
 * fonts are the system's, the PDF's are the base-14 — and nothing relies on it being exact: where text breaks
 * from page to page is decided by the browser itself (`flow.ts`).
 *
 * Measuring is the caller's: a canvas context for the raster, a PDF font for the export, characters for a test.
 */
import { fontById, TEXT_LINE_HEIGHT } from './media';
import {
  BLOCK_SPACING,
  clampIndent,
  HEADING_SCALE,
  INDENT_STEP,
  listMarkers,
  SCRIPT_SCALE,
  type ListMarker,
  type RichBase,
} from './richText';
import type { RichAlign, RichBlock, RichRun, RichScript, RichText, TextFontId } from './types';

/** Everything that decides how a stretch of text is drawn. */
export interface RunStyle {
  readonly fontFamily: TextFontId;
  /** Page px, after any superscript or subscript has made it smaller. */
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly color: string;
  readonly highlight: string | null;
  readonly script: RichScript | null;
  /** How far the baseline moves for superscript (up, negative) or subscript, page px. */
  readonly shift: number;
}

export type Measure = (text: string, style: RunStyle) => number;

export interface LaidPiece {
  /** From the box's left edge. */
  readonly x: number;
  readonly width: number;
  readonly text: string;
  readonly style: RunStyle;
  /** Only spaces: on a justified line they are stretched, so they are not drawn as text. */
  readonly space: boolean;
}

export interface LaidLine {
  readonly top: number;
  readonly height: number;
  readonly baseline: number;
  readonly pieces: readonly LaidPiece[];
}

export interface LaidBlock {
  readonly top: number;
  readonly bottom: number;
  readonly lines: readonly LaidLine[];
  readonly marker: ListMarker | null;
  /** Where the marker's right edge is, and the style it is drawn in. */
  readonly markerRight: number;
  readonly markerStyle: RunStyle;
  /** A ticked checklist item: struck through and faded. */
  readonly done: boolean;
}

export interface RichLayout {
  readonly blocks: readonly LaidBlock[];
  /** The text's height, its last paragraph's space below included. */
  readonly height: number;
}

/** The share of a line's height above the baseline, for one size of text: half the leading and the ascent. */
const BASELINE = 0.8 * TEXT_LINE_HEIGHT;
/** How far superscript and subscript move off the line, as a share of the text they sit in. */
const SUP_SHIFT = -0.35;
const SUB_SHIFT = 0.15;
/** The gap between a list marker and its text, as a share of the box's size. */
export const MARKER_GAP = 0.4;

function blockSize(block: RichBlock, base: RichBase): number {
  return base.fontSize * HEADING_SCALE[block.kind ?? 'p'];
}

/** The resolved style of a run in a block. */
export function runStyle(run: RichRun, block: RichBlock, base: RichBase): RunStyle {
  const size = run.size ?? blockSize(block, base);
  const script = run.script ?? null;
  return {
    fontFamily: run.font ?? base.fontFamily,
    size: script ? size * SCRIPT_SCALE : size,
    bold: run.bold === true || (block.kind !== undefined && block.kind !== 'p'),
    italic: run.italic === true,
    underline: run.underline === true,
    strike: run.strike === true,
    color: run.color ?? base.color,
    highlight: run.highlight ?? null,
    script,
    shift: script === 'sup' ? size * SUP_SHIFT : script === 'sub' ? size * SUB_SHIFT : 0,
  };
}

/** The CSS font shorthand for a style, for a canvas. */
export function canvasFont(style: RunStyle): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 700 : 400} ${style.size}px ${fontById(style.fontFamily).css}`;
}

interface Atom {
  readonly kind: 'word' | 'space' | 'break';
  readonly text: string;
  readonly style: RunStyle;
  /** The size the line's height is reckoned from; 0 for superscript and subscript. */
  readonly lineSize: number;
  width: number;
}

function atomsOf(block: RichBlock, base: RichBase, measure: Measure): Atom[] {
  const atoms: Atom[] = [];
  for (const run of block.runs) {
    const style = runStyle(run, block, base);
    // Superscript and subscript take no room in the line's height (the editor sets them `line-height: 0`).
    const lineSize = style.script ? 0 : style.size;
    for (const token of run.text.split(/(\n|[ \t]+)/)) {
      if (token === '') continue;
      if (token === '\n') atoms.push({ kind: 'break', text: '', style, lineSize, width: 0 });
      else if (/^[ \t]+$/.test(token)) {
        // A tab is four spaces wide, as the editor's `tab-size` is.
        const spaces = token.replace(/\t/g, '    ');
        atoms.push({ kind: 'space', text: spaces, style, lineSize, width: measure(spaces, style) });
      } else atoms.push({ kind: 'word', text: token, style, lineSize, width: measure(token, style) });
    }
  }
  return atoms;
}

/** Break a block's atoms into lines no wider than `width`: whole words where they fit, characters where not. */
function breakLines(atoms: readonly Atom[], width: number, measure: Measure): Atom[][] {
  const lines: Atom[][] = [];
  let line: Atom[] = [];
  let used = 0;
  const flush = (): void => {
    lines.push(line);
    line = [];
    used = 0;
  };
  let i = 0;
  while (i < atoms.length) {
    const atom = atoms[i]!;
    if (atom.kind === 'break') {
      flush();
      i += 1;
      continue;
    }
    if (atom.kind === 'space') {
      // Spaces hang past the edge rather than starting a line.
      line.push(atom);
      used += atom.width;
      i += 1;
      continue;
    }
    // A word may be in several runs (a bold letter in it): take them all.
    let j = i;
    let wordWidth = 0;
    while (j < atoms.length && atoms[j]!.kind === 'word') wordWidth += atoms[j++]!.width;
    const word = atoms.slice(i, j);
    if (used + wordWidth <= width) {
      line.push(...word);
      used += wordWidth;
    } else if (wordWidth <= width) {
      flush();
      line.push(...word);
      used = wordWidth;
    } else {
      // Longer than a whole line: as many characters as fit, then the rest on the next.
      if (line.some((a) => a.kind === 'word')) flush();
      for (const part of word) {
        let rest = part.text;
        while (rest !== '') {
          let take = rest.length;
          while (take > 1 && used + measure(rest.slice(0, take), part.style) > width) take -= 1;
          const text = rest.slice(0, take);
          const w = measure(text, part.style);
          if (used > 0 && used + w > width) {
            flush();
            continue;
          }
          line.push({ ...part, text, width: w });
          used += w;
          rest = rest.slice(take);
        }
      }
    }
    i = j;
  }
  if (line.length > 0 || lines.length === 0 || atoms[atoms.length - 1]?.kind === 'break') lines.push(line);
  return lines;
}

function spacingOf(block: RichBlock): { before: number; after: number } {
  const kind = block.kind ?? 'p';
  return kind === 'p' && block.list ? BLOCK_SPACING.item : BLOCK_SPACING[kind];
}

function sameStyle(a: RunStyle, b: RunStyle): boolean {
  return (
    a === b ||
    (a.fontFamily === b.fontFamily &&
      a.size === b.size &&
      a.bold === b.bold &&
      a.italic === b.italic &&
      a.underline === b.underline &&
      a.strike === b.strike &&
      a.color === b.color &&
      a.highlight === b.highlight &&
      a.script === b.script)
  );
}

/** Lay out a box's text in `width` page px. */
export function layoutRich(rich: RichText, base: RichBase, width: number, measure: Measure): RichLayout {
  const markers = listMarkers(rich.blocks);
  const blocks: LaidBlock[] = [];
  let y = 0;
  let previousAfter = 0;
  rich.blocks.forEach((block, index) => {
    const size = blockSize(block, base);
    const spacing = spacingOf(block);
    const before = index === 0 ? 0 : spacing.before * size;
    // Margins collapse: the larger of the two, not both.
    y += Math.max(previousAfter, before);
    const indent = clampIndent(block.indent ?? 0);
    const left = (indent + (block.list ? 1 : 0)) * INDENT_STEP * base.fontSize;
    const available = Math.max(1, width - left);
    const align: RichAlign = block.align ?? base.align;
    const plain = runStyle({ text: '' }, block, base);
    const atomLines = breakLines(atomsOf(block, base, measure), available, measure);
    const top = y;
    const lines: LaidLine[] = atomLines.map((atoms, lineIndex) => {
      // As CSS reckons a line box: the paragraph's own size is always there (the strut), and larger text in
      // the line makes it taller.
      const largest = atoms.reduce((m, a) => Math.max(m, a.lineSize), size);
      const height = largest * TEXT_LINE_HEIGHT;
      const lineTop = y;
      y += height;
      // Trailing spaces hang: they take no room when the line is aligned.
      let end = atoms.length;
      while (end > 0 && atoms[end - 1]!.kind === 'space') end -= 1;
      const visible = atoms.slice(0, end);
      const content = visible.reduce((sum, a) => sum + a.width, 0);
      const last = lineIndex === atomLines.length - 1;
      const spaces = visible.filter((a) => a.kind === 'space').length;
      const extra = available - content;
      let offset = 0;
      let stretch = 0;
      if (align === 'center') offset = extra / 2;
      else if (align === 'right') offset = extra;
      else if (align === 'justify' && !last && spaces > 0 && extra > 0) stretch = extra / spaces;
      let x = left + Math.max(0, offset);
      const pieces: LaidPiece[] = [];
      for (const atom of visible) {
        const w = atom.width + (atom.kind === 'space' ? stretch : 0);
        const space = atom.kind === 'space';
        const last = pieces[pieces.length - 1];
        // Neighbours in one style are one piece — one stretch of text and one rule under it — unless the
        // spaces between them are stretched.
        if (last && stretch === 0 && sameStyle(last.style, atom.style)) {
          pieces[pieces.length - 1] = { ...last, width: last.width + w, text: last.text + atom.text, space: last.space && space };
        } else pieces.push({ x, width: w, text: atom.text, style: atom.style, space });
        x += w;
      }
      return { top: lineTop, height, baseline: lineTop + largest * BASELINE, pieces };
    });
    blocks.push({
      top,
      bottom: y,
      lines,
      marker: markers[index] ?? null,
      markerRight: left - MARKER_GAP * base.fontSize,
      markerStyle: { ...plain, color: block.runs[0]?.color ?? base.color },
      done: block.list === 'check' && block.checked === true && !block.cont,
    });
    previousAfter = spacing.after * size;
  });
  return { blocks, height: y + previousAfter };
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/** What laid-out text is drawn with: a canvas, a PDF page. Coordinates in the box's frame, y down. */
export interface RichPainter {
  /** Text from `x` on, or ending at `x` when `anchor` is `'right'`. */
  text(text: string, x: number, baseline: number, style: RunStyle, opacity: number, anchor?: 'left' | 'right'): void;
  rect(x: number, top: number, width: number, height: number, color: string, opacity: number): void;
  /** A circle, filled or as an outline `line` wide. */
  circle(cx: number, cy: number, r: number, color: string, filled: boolean, line: number, opacity: number): void;
  /** A polyline `line` wide (a tick). */
  polyline(points: readonly (readonly [number, number])[], color: string, line: number, opacity: number): void;
  /** A square's outline. */
  square(x: number, top: number, side: number, color: string, line: number, opacity: number): void;
}

/** A ticked item's text is faded to this. */
export const DONE_OPACITY = 0.55;

/** Draw laid-out text, markers and rules included. */
export function paintRich(layout: RichLayout, painter: RichPainter, base: RichBase): void {
  for (const block of layout.blocks) {
    const opacity = block.done ? DONE_OPACITY : 1;
    const first = block.lines[0];
    if (block.marker && first) paintMarker(block, first, painter, base, opacity);
    for (const line of block.lines) {
      for (const piece of line.pieces) {
        const s = piece.style;
        const baseline = line.baseline + s.shift;
        if (s.highlight) painter.rect(piece.x, baseline - s.size * 0.95, piece.width, s.size * 1.22, s.highlight, 1);
        if (!piece.space) painter.text(piece.text, piece.x, baseline, s, opacity);
        // Rules are drawn, not typeset: neither a canvas nor a PDF has text decoration.
        const thickness = Math.max(0.5, s.size * 0.06);
        if (s.underline) painter.rect(piece.x, baseline + s.size * 0.12, piece.width, thickness, s.color, opacity);
        if (s.strike || block.done) painter.rect(piece.x, baseline - s.size * 0.28, piece.width, thickness, s.color, opacity);
      }
    }
  }
}

function paintMarker(block: LaidBlock, line: LaidLine, painter: RichPainter, base: RichBase, opacity: number): void {
  const marker = block.marker!;
  const style = block.markerStyle;
  const size = style.size;
  const right = block.markerRight;
  const middle = line.baseline - size * 0.32;
  if (marker.kind === 'number') {
    painter.text(marker.text, right, line.baseline, style, opacity, 'right');
    return;
  }
  if (marker.kind === 'bullet') {
    const r = size * 0.16;
    const cx = right - r;
    if (marker.shape === 'square') painter.rect(cx - r, middle - r, r * 2, r * 2, style.color, opacity);
    else painter.circle(cx, middle, r, style.color, marker.shape === 'disc', Math.max(0.6, size * 0.06), opacity);
    return;
  }
  // A box to tick, and the tick.
  const side = size * 0.8;
  const x = right - side;
  const top = middle - side / 2;
  const line_ = Math.max(0.8, base.fontSize * 0.07);
  painter.square(x, top, side, '#71717a', line_, opacity);
  if (marker.checked) {
    painter.polyline(
      [
        [x + side * 0.2, top + side * 0.55],
        [x + side * 0.42, top + side * 0.78],
        [x + side * 0.82, top + side * 0.25],
      ],
      '#2563eb',
      line_ * 1.6,
      opacity,
    );
  }
}

/** Draw rich text on a canvas, in page units (the context is already scaled and placed at the box). */
export function canvasPainter(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): RichPainter {
  const alpha = (opacity: number, draw: () => void): void => {
    const previous = ctx.globalAlpha;
    ctx.globalAlpha = previous * opacity;
    draw();
    ctx.globalAlpha = previous;
  };
  return {
    text: (text, x, baseline, style, opacity, anchor = 'left') =>
      alpha(opacity, () => {
        ctx.font = canvasFont(style);
        ctx.fillStyle = style.color;
        ctx.textAlign = anchor;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(text, x, baseline);
      }),
    rect: (x, top, width, height, color, opacity) =>
      alpha(opacity, () => {
        ctx.fillStyle = color;
        ctx.fillRect(x, top, width, height);
      }),
    circle: (cx, cy, r, color, filled, line, opacity) =>
      alpha(opacity, () => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        if (filled) {
          ctx.fillStyle = color;
          ctx.fill();
        } else {
          ctx.strokeStyle = color;
          ctx.lineWidth = line;
          ctx.stroke();
        }
      }),
    polyline: (points, color, line, opacity) =>
      alpha(opacity, () => {
        ctx.beginPath();
        points.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
        ctx.strokeStyle = color;
        ctx.lineWidth = line;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }),
    square: (x, top, side, color, line, opacity) =>
      alpha(opacity, () => {
        ctx.strokeStyle = color;
        ctx.lineWidth = line;
        ctx.strokeRect(x, top, side, side);
      }),
  };
}

/** A canvas measure: the context's own widths, in the run's font. */
export function canvasMeasure(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): Measure {
  return (text, style) => {
    ctx.font = canvasFont(style);
    return ctx.measureText(text).width;
  };
}
