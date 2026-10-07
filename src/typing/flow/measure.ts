/**
 * How much text fits on a page, as the browser lays it out — the same layout the editor will give it.
 *
 * The paragraphs are rendered with the static view's DOM (`richDom.ts`: same classes, same styles as the
 * editor's) into a hidden box as wide as the page's text, and measured: whole paragraphs by where they end, and
 * the one that overflows line by line, to find the character its first line that does not fit starts with.
 * Nothing here guesses at font metrics, which is the point: a page breaks where the editor's lines break.
 */
import type { RichBase } from '../../document/richText';
import { blockLength } from '../../document/richText';
import type { RichBlock } from '../../document/types';
import { renderRich } from '../richDom';
import type { Fit, FlowMeasurer } from './paginate';

let host: HTMLDivElement | null = null;

function measuringHost(): HTMLDivElement {
  if (host && host.isConnected) return host;
  host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.dataset.flowMeasure = '';
  host.style.cssText = 'position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style;';
  document.body.appendChild(host);
  return host;
}

interface Line {
  top: number;
  bottom: number;
}

/** A paragraph's lines, top to bottom, from the rectangles its text is drawn in. */
function linesOf(block: HTMLElement): Line[] {
  const range = document.createRange();
  range.selectNodeContents(block);
  const rects = [...range.getClientRects()].filter((r) => r.height > 0).sort((a, b) => a.top - b.top);
  const lines: Line[] = [];
  for (const r of rects) {
    const line = lines[lines.length - 1];
    // Overlapping vertically: the same line (a superscript or larger text in it sticks out a little).
    if (line && r.top < line.bottom - 1) line.bottom = Math.max(line.bottom, r.bottom);
    else lines.push({ top: r.top, bottom: r.bottom });
  }
  return lines;
}

/** Each character position of a paragraph, as a DOM spot to measure: a text node and an offset, or a line break. */
function positions(block: HTMLElement, length: number): ((range: Range) => void)[] {
  const out: ((range: Range) => void)[] = [];
  const walk = (node: Node): void => {
    if (out.length >= length) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      for (let i = 0; i < text.length && out.length < length; i++) out.push((r) => (r.setStart(text, i), r.setEnd(text, i + 1)));
      return;
    }
    if (node.nodeName === 'BR') {
      out.push((r) => r.selectNode(node));
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(block);
  return out;
}

/** The first character on or below `top`, by bisection: lines run down the page in character order. */
function firstCharFrom(block: HTMLElement, length: number, top: number): number | null {
  const spots = positions(block, length);
  const range = document.createRange();
  const topOf = (i: number): number => {
    spots[i]!(range);
    return range.getBoundingClientRect().top;
  };
  let lo = 1;
  let hi = spots.length - 1;
  if (hi < lo || topOf(hi) < top - 0.5) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (topOf(mid) >= top - 0.5) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export const domMeasurer: FlowMeasurer = {
  fit(blocks: readonly RichBlock[], base: RichBase, width: number, height: number): Fit {
    if (blocks.length === 0) return { blocks: 0, split: null };
    const root = renderRich({ blocks }, base);
    root.style.width = `${width}px`;
    const target = measuringHost();
    target.replaceChildren(root);
    try {
      const rootTop = root.getBoundingClientRect().top;
      const elements = [...root.children] as HTMLElement[];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i]!;
        if (el.offsetTop + el.offsetHeight <= height + 0.5) continue;
        // This paragraph does not fit whole: how many of its lines do?
        const lines = linesOf(el);
        const fitting = lines.filter((l) => l.bottom - rootTop <= height + 0.5).length;
        if (lines.length > 0 && fitting >= lines.length) continue;
        const length = blockLength(blocks[i]!);
        if (fitting === 0 || length === 0) return { blocks: i, split: null };
        const split = firstCharFrom(el, length, lines[fitting]!.top);
        return { blocks: i, split: split !== null && split > 0 && split < length ? split : null };
      }
      return { blocks: blocks.length, split: null };
    } finally {
      target.replaceChildren();
    }
  },
};
