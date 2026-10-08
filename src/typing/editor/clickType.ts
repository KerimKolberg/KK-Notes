/**
 * Click and Type, as Word has it, for page text: a click in the empty part of a page below the text puts the caret
 * there — not at the end of the text far above it, which left Enter to be pressed line by line to get down the page.
 * Empty paragraphs are added down to the line clicked on, and that line is set where the click was across the page:
 * indented to it, centred in the middle, set right at the right. A click on an empty line already there is set the
 * same way. The empty lines a click added and nothing was typed on go again when the caret leaves the text
 * (`flow/engine.ts`, `trimEnd`).
 *
 * The arithmetic is here, apart from the editor, so it can be tested without a page to measure.
 */
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { TEXT_LINE_HEIGHT } from '../../document/media';
import { BLOCK_SPACING, INDENT_STEP, MAX_INDENT } from '../../document/richText';
import type { RichAlign } from '../../document/types';
import { schema, type BlockAttrs } from './schema';

/** How a line is set across the page for a click `offset` px into text `width` px wide. */
export interface Placement {
  readonly align: RichAlign | null;
  readonly indent: number;
}

/**
 * Where across the text a click is, as the line there is set: in the middle quarter, centred; in the last fifth,
 * set right; otherwise indented as far as whole indent steps reach towards the click (none within the first step,
 * so a click just inside the margin is an ordinary line).
 */
export function placementAcross(offset: number, width: number, indentPx: number): Placement {
  if (width <= 0) return { align: null, indent: 0 };
  const at = offset / width;
  if (at >= 0.38 && at <= 0.62) return { align: 'center', indent: 0 };
  if (at > 0.8) return { align: 'right', indent: 0 };
  const indent = indentPx > 0 ? Math.min(MAX_INDENT, Math.max(0, Math.floor(offset / indentPx))) : 0;
  return { align: null, indent };
}

/**
 * How many empty paragraphs take the text down to a click `below` px under the end of its last paragraph (its
 * spacing after included), each a line and the space after one, `step` px: none for a click on the last paragraph
 * or in the space after it, one for a click on the line just under it, and so on.
 */
export function linesDown(below: number, step: number): number {
  if (below < 0 || step <= 0) return 0;
  return Math.floor(below / step) + 1;
}

/** An empty paragraph's line and the space after it, page px, for text `fontSize` px. */
export function emptyLineStep(fontSize: number): number {
  return fontSize * (TEXT_LINE_HEIGHT + BLOCK_SPACING.p.after);
}

/**
 * A click at (`x`, `y`) on the screen in page text: the caret put on the line there, below the text or on an empty
 * line, set across the page as the click was. False — the click left to the editor — on a line with text in it.
 */
export function clickAndType(view: EditorView, x: number, y: number, fontSize: number): boolean {
  const root = view.dom as HTMLElement;
  const rect = root.getBoundingClientRect();
  // The page is zoomed: what the screen measures, in the page's own px.
  const scale = root.offsetWidth > 0 ? rect.width / root.offsetWidth : 1;
  const left = Math.min(Math.max(x, rect.left), rect.right);
  const across = placementAcross((left - rect.left) / scale, rect.width / scale, INDENT_STEP * fontSize);
  const last = root.lastElementChild as HTMLElement | null;
  if (!last) return false;
  const lastRect = last.getBoundingClientRect();
  const after = (parseFloat(getComputedStyle(last).marginBottom) || 0) * scale;
  const below = Math.min(y, rect.bottom - 1) - (lastRect.bottom + after);
  const lines = linesDown(below, emptyLineStep(fontSize) * scale);

  const { state } = view;
  if (lines > 0) {
    const make = (placed: boolean) =>
      schema.nodes.paragraph.create(placed ? { align: across.align, indent: across.indent } : null);
    const added = Array.from({ length: lines }, (_, i) => make(i === lines - 1));
    const end = state.doc.content.size;
    const tr = state.tr.insert(end, added);
    tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 1)).scrollIntoView();
    view.dispatch(tr);
    view.focus();
    return true;
  }

  // On a line already there: an empty one is set where the click was, as a new one would be.
  const hit = view.posAtCoords({ left: Math.min(Math.max(x, rect.left + 1), rect.right - 1), top: Math.min(Math.max(y, rect.top + 1), rect.bottom - 1) });
  if (!hit) return false;
  const $pos = state.doc.resolve(hit.pos);
  const block = $pos.depth > 0 ? $pos.node(1) : null;
  if (!block || block.type !== schema.nodes.paragraph || block.content.size > 0) return false;
  const attrs = block.attrs as BlockAttrs;
  if (attrs.list) return false;
  const start = $pos.before(1);
  const tr = state.tr;
  if (attrs.align !== across.align || attrs.indent !== across.indent) {
    tr.setNodeMarkup(start, undefined, { ...attrs, align: across.align, indent: across.indent }).setMeta('format', true);
  }
  tr.setSelection(TextSelection.create(tr.doc, start + 1)).scrollIntoView();
  view.dispatch(tr);
  view.focus();
  return true;
}
