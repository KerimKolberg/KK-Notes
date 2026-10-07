/**
 * The editor's document model: paragraphs (with the attributes a `RichBlock` has), text, line breaks, and the
 * marks a `RichRun` can carry. Drawn with `richDom.ts`'s styles, so a box looks the same being edited as not.
 *
 * Marks are nested in the order they are declared, outermost first, which matters for one thing: a superscript
 * inside a size is three quarters of *that* size, as the static view computes it.
 *
 * What is pasted from elsewhere keeps its bold, italic, underline, strikethrough, superscript and subscript, its
 * headings and its lists — but not its fonts, sizes and colours, which on a web page are the page's and would
 * look like a ransom note here. Text copied from another box keeps everything (`data-rt-*`).
 */
import { Schema, type Attrs, type DOMOutputSpec, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import { clampIndent } from '../../document/richText';
import type { RichAlign, RichBlockKind, RichList, RichScript, TextFontId } from '../../document/types';
import { blockCss, blockData, cssText, RT_BLOCK, runCss, type BlockLook } from '../richDom';

export interface BlockAttrs {
  readonly kind: RichBlockKind;
  readonly list: RichList | null;
  readonly indent: number;
  readonly checked: boolean;
  readonly align: RichAlign | null;
  readonly cont: boolean;
  readonly pageBreak: boolean;
}

export const DEFAULT_BLOCK: BlockAttrs = { kind: 'p', list: null, indent: 0, checked: false, align: null, cont: false, pageBreak: false };

export function lookOf(attrs: Attrs): BlockLook {
  const a = attrs as BlockAttrs;
  return {
    ...(a.kind !== 'p' ? { kind: a.kind } : {}),
    ...(a.list ? { list: a.list } : {}),
    ...(a.indent > 0 ? { indent: a.indent } : {}),
    ...(a.checked ? { checked: true } : {}),
    ...(a.align ? { align: a.align } : {}),
    ...(a.cont ? { cont: true } : {}),
    ...(a.pageBreak ? { pageBreak: true } : {}),
  };
}

const KINDS: readonly RichBlockKind[] = ['p', 'h1', 'h2', 'h3'];
const LISTS: readonly RichList[] = ['bullet', 'number', 'check'];
const ALIGNS: readonly RichAlign[] = ['left', 'center', 'right', 'justify'];

/** A paragraph copied from a box, by the attributes it was written with. */
function parseOwn(el: HTMLElement): Partial<BlockAttrs> {
  const kind = el.dataset.rtKind as RichBlockKind | undefined;
  const list = el.dataset.rtList as RichList | undefined;
  const align = (el.dataset.rtAlign ?? el.style.textAlign) as RichAlign | undefined;
  return {
    ...(kind && KINDS.includes(kind) ? { kind } : {}),
    ...(list && LISTS.includes(list) ? { list } : {}),
    ...(el.dataset.rtIndent ? { indent: clampIndent(Number(el.dataset.rtIndent)) } : {}),
    ...(el.dataset.rtChecked !== undefined ? { checked: true } : {}),
    ...(align && ALIGNS.includes(align) ? { align } : {}),
  };
}

/** A list item from a web page or a word processor: its list's kind, and how deep it is nested. */
function parseItem(li: HTMLElement): Partial<BlockAttrs> {
  let depth = -1;
  let list: RichList = 'bullet';
  for (let el: HTMLElement | null = li.parentElement; el; el = el.parentElement) {
    if (el.tagName === 'UL' || el.tagName === 'OL') {
      if (depth < 0) list = el.tagName === 'OL' ? 'number' : 'bullet';
      depth += 1;
    }
  }
  const box = li.querySelector('input[type="checkbox"]');
  if (box || li.getAttribute('role') === 'checkbox' || li.dataset.checked !== undefined) {
    return {
      list: 'check',
      indent: clampIndent(Math.max(0, depth)),
      checked: (box as HTMLInputElement | null)?.checked === true || li.getAttribute('aria-checked') === 'true' || li.dataset.checked === 'true',
    };
  }
  return { list, indent: clampIndent(Math.max(0, depth)) };
}

const paragraph: NodeSpec = {
  content: 'inline*',
  group: 'block',
  attrs: {
    kind: { default: 'p' },
    list: { default: null },
    indent: { default: 0 },
    checked: { default: false },
    align: { default: null },
    cont: { default: false },
    pageBreak: { default: false },
  },
  parseDOM: [
    { tag: 'li > p', getAttrs: (p) => ({ ...parseItem((p as HTMLElement).parentElement!), ...parseOwn(p as HTMLElement) }) },
    // An item holding paragraphs of its own is read through them.
    { tag: 'li', getAttrs: (li) => ((li as HTMLElement).querySelector(':scope > p') ? false : parseItem(li as HTMLElement)) },
    { tag: 'h1', attrs: { kind: 'h1' } },
    { tag: 'h2', attrs: { kind: 'h2' } },
    { tag: 'h3', attrs: { kind: 'h3' } },
    { tag: 'h4', attrs: { kind: 'h3' } },
    { tag: 'h5', attrs: { kind: 'h3' } },
    { tag: 'h6', attrs: { kind: 'h3' } },
    { tag: 'p', getAttrs: (p) => parseOwn(p as HTMLElement) },
  ],
  toDOM(node): DOMOutputSpec {
    const look = lookOf(node.attrs);
    const a = node.attrs as BlockAttrs;
    return [
      'p',
      {
        class: RT_BLOCK,
        style: cssText(blockCss(look)),
        ...blockData(look, null),
        // What a paragraph is, for when it is copied into another box.
        ...(a.kind !== 'p' ? { 'data-rt-kind': a.kind } : {}),
        ...(a.list && !a.cont ? { 'data-rt-list': a.list } : {}),
        ...(a.indent > 0 ? { 'data-rt-indent': String(a.indent) } : {}),
        ...(a.checked ? { 'data-rt-checked': '' } : {}),
        ...(a.align ? { 'data-rt-align': a.align } : {}),
      },
      0,
    ];
  },
};

/** A mark with a value, drawn as a styled span, read back only from text copied out of a box. */
function valueMark(name: 'font' | 'size' | 'color' | 'highlight', read: (raw: string) => unknown, extra: MarkSpec['parseDOM'] = []): MarkSpec {
  const attr = `data-rt-${name}`;
  return {
    attrs: { value: {} },
    parseDOM: [
      {
        tag: `span[${attr}]`,
        getAttrs: (el) => {
          const value = read((el as HTMLElement).getAttribute(attr) ?? '');
          return value === null || value === undefined ? false : { value };
        },
      },
      ...extra,
    ],
    toDOM: (mark) => ['span', { style: cssText(runCss({ [name]: mark.attrs.value })), [attr]: String(mark.attrs.value) }, 0],
  };
}

const FONTS: readonly TextFontId[] = ['sans', 'serif', 'mono'];

export const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph,
    text: { group: 'inline' },
    hard_break: {
      inline: true,
      group: 'inline',
      selectable: false,
      parseDOM: [{ tag: 'br' }],
      toDOM: () => ['br'],
    },
  },
  marks: {
    font: valueMark('font', (raw) => (FONTS.includes(raw as TextFontId) ? raw : null)),
    size: valueMark('size', (raw) => (Number(raw) > 0 ? Number(raw) : null)),
    color: valueMark('color', (raw) => raw || null),
    highlight: valueMark('highlight', (raw) => raw || null, [{ tag: 'mark', attrs: { value: '#fde68a' } }]),
    bold: {
      parseDOM: [
        { tag: 'strong' },
        // Google Docs wraps everything in <b style="font-weight: normal">.
        { tag: 'b', getAttrs: (el) => ((el as HTMLElement).style.fontWeight !== 'normal' ? null : false) },
        { style: 'font-weight', getAttrs: (value) => (/^(bold(er)?|[6-9]\d\d)$/.test(value) ? null : false) },
      ],
      toDOM: () => ['strong', 0],
    },
    italic: {
      parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
      toDOM: () => ['em', 0],
    },
    underline: {
      parseDOM: [{ tag: 'u' }, { style: 'text-decoration', getAttrs: (v) => (v.includes('underline') ? null : false) }],
      toDOM: () => ['u', 0],
    },
    strike: {
      parseDOM: [
        { tag: 's' },
        { tag: 'del' },
        { tag: 'strike' },
        { style: 'text-decoration', getAttrs: (v) => (v.includes('line-through') ? null : false) },
      ],
      toDOM: () => ['s', 0],
    },
    script: {
      attrs: { value: {} },
      // Superscript and subscript at once makes no sense: one takes the other's place.
      excludes: 'script',
      parseDOM: [
        { tag: 'sup', attrs: { value: 'sup' } },
        { tag: 'sub', attrs: { value: 'sub' } },
      ],
      toDOM: (mark) => [mark.attrs.value as RichScript, { style: cssText(runCss({ script: mark.attrs.value as RichScript })) }, 0],
    },
  },
});
