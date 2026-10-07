/**
 * How typed text is set in the DOM — one set of styles for the three places it appears:
 *
 * - the **editor** (`editor/schema.ts`), whose paragraphs and marks are drawn from these;
 * - the **static view** of a box that is not being edited, or before the editor has loaded ({@link renderRich});
 * - the **measurer** that decides where text that flows from page to page breaks (`flow/measure.ts`), which has
 *   to see exactly the lines the editor will show.
 *
 * Paragraph spacing, indents and heading sizes are written in `em` and in multiples of `--rt-base` (the box's
 * size), so they follow the box's size without being written out again; the numbers are `richText.ts`'s, which
 * the canvas and PDF layout (`richLayout.ts`) use too. The rest — list markers, the checklist box, the first
 * paragraph's space above — is in `index.css`, under `.rt`.
 */
import { fontById, TEXT_LINE_HEIGHT } from '../document/media';
import { DONE_OPACITY, MARKER_GAP } from '../document/richLayout';
import {
  BLOCK_SPACING,
  clampIndent,
  HEADING_SCALE,
  INDENT_STEP,
  listMarkers,
  SCRIPT_SCALE,
  type ListMarker,
  type RichBase,
} from '../document/richText';
import type { RichBlock, RichMarks, RichText } from '../document/types';

/** The class of the element that holds a box's paragraphs. */
export const RT_ROOT = 'rt';
/** The class of a paragraph. */
export const RT_BLOCK = 'rt-block';

/** CSS declarations, by CSS's own property names. */
export type Css = Record<string, string>;

/** The box's own style, on the element that holds its paragraphs. */
export function rootCss(base: RichBase): Css {
  return {
    'font-family': fontById(base.fontFamily).css,
    'font-size': `${base.fontSize}px`,
    'line-height': String(TEXT_LINE_HEIGHT),
    color: base.color,
    'text-align': base.align,
    '--rt-base': `${base.fontSize}px`,
    '--rt-gap': `${MARKER_GAP}`,
  };
}

/** What a paragraph is: its spacing, size, indent, alignment, and a ticked item's look. */
export type BlockLook = Pick<RichBlock, 'kind' | 'list' | 'indent' | 'align' | 'checked' | 'cont' | 'pageBreak'>;

export function blockCss(block: BlockLook): Css {
  const kind = block.kind ?? 'p';
  const spacing = kind === 'p' && block.list ? BLOCK_SPACING.item : BLOCK_SPACING[kind];
  const css: Css = { margin: `${spacing.before}em 0 ${spacing.after}em` };
  if (kind !== 'p') {
    css['font-size'] = `${HEADING_SCALE[kind]}em`;
    css['font-weight'] = '700';
  }
  const steps = clampIndent(block.indent ?? 0) + (block.list ? 1 : 0);
  if (steps > 0) {
    css['--rt-pad'] = `calc(var(--rt-base) * ${steps * INDENT_STEP})`;
    css['padding-left'] = 'var(--rt-pad)';
  }
  if (block.align) css['text-align'] = block.align;
  if (block.list === 'check' && block.checked && !block.cont) {
    css.opacity = String(DONE_OPACITY);
    css['text-decoration-line'] = 'line-through';
  }
  return css;
}

/** The attributes the marker before a paragraph is drawn from (`index.css`). */
export function blockData(block: BlockLook, marker: ListMarker | null): Record<string, string> {
  const data: Record<string, string> = {};
  if (block.list && !block.cont) data['data-list'] = block.list;
  if (marker && marker.kind !== 'check') data['data-marker'] = marker.text;
  if (block.list === 'check' && block.checked && !block.cont) data['data-checked'] = '';
  return data;
}

/** A run's marks as CSS. Superscript and subscript take no room of their own in the line's height. */
export function runCss(marks: RichMarks): Css {
  const css: Css = {};
  if (marks.bold) css['font-weight'] = '700';
  if (marks.italic) css['font-style'] = 'italic';
  const rules = [marks.underline ? 'underline' : '', marks.strike ? 'line-through' : ''].filter(Boolean);
  if (rules.length > 0) css['text-decoration-line'] = rules.join(' ');
  if (marks.color) css.color = marks.color;
  if (marks.highlight) css['background-color'] = marks.highlight;
  if (marks.font) css['font-family'] = fontById(marks.font).css;
  if (marks.script) {
    css['vertical-align'] = marks.script === 'sup' ? 'super' : 'sub';
    css['line-height'] = '0';
    css['font-size'] = marks.size ? `${marks.size * SCRIPT_SCALE}px` : `${SCRIPT_SCALE}em`;
  } else if (marks.size) css['font-size'] = `${marks.size}px`;
  return css;
}

/** `prop: value; …`, for a `style` attribute. */
export function cssText(css: Css): string {
  return Object.entries(css)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');
}

function applyCss(el: HTMLElement, css: Css): void {
  for (const [key, value] of Object.entries(css)) el.style.setProperty(key, value);
}

/**
 * A box's paragraphs as DOM, as the editor would show them: what a box not being edited shows, and what the
 * measurer lays out. An empty paragraph holds a `<br>`, and a paragraph ending in a line break a second one, as
 * the editor's do, so each has the height the editor gives it.
 */
export function renderRich(rich: RichText, base: RichBase, doc: Document = document): HTMLElement {
  const root = doc.createElement('div');
  root.className = RT_ROOT;
  applyCss(root, rootCss(base));
  const markers = listMarkers(rich.blocks);
  rich.blocks.forEach((block, i) => root.appendChild(renderBlock(block, markers[i] ?? null, doc)));
  return root;
}

export function renderBlock(block: RichBlock, marker: ListMarker | null, doc: Document = document): HTMLElement {
  const p = doc.createElement('p');
  p.className = RT_BLOCK;
  applyCss(p, blockCss(block));
  for (const [key, value] of Object.entries(blockData(block, marker))) p.setAttribute(key, value);
  let endsInBreak = true;
  for (const run of block.runs) {
    const css = runCss(run);
    const target = Object.keys(css).length > 0 ? doc.createElement('span') : null;
    if (target) applyCss(target, css);
    const into = target ?? p;
    run.text.split('\n').forEach((part, k) => {
      if (k > 0) into.appendChild(doc.createElement('br'));
      if (part !== '') into.appendChild(doc.createTextNode(part));
    });
    if (target) p.appendChild(target);
    endsInBreak = run.text.endsWith('\n');
  }
  if (endsInBreak) p.appendChild(doc.createElement('br'));
  return p;
}
