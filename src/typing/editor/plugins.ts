/**
 * What the editor does beyond editing: draws list markers, says when a box is empty, ticks checklist items when
 * their box is clicked, and turns what is typed at the start of a paragraph into a list or a heading.
 */
import { InputRule, ellipsis, emDash, inputRules, smartQuotes } from 'prosemirror-inputrules';
import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { listMarkers } from '../../document/richText';
import type { RichBlock } from '../../document/types';
import { schema, type BlockAttrs } from './schema';

function markerDecorations(doc: import('prosemirror-model').Node): DecorationSet {
  const blocks: RichBlock[] = [];
  const positions: number[] = [];
  doc.forEach((node, offset) => {
    const a = node.attrs as BlockAttrs;
    blocks.push({ runs: [], ...(a.list ? { list: a.list } : {}), ...(a.indent ? { indent: a.indent } : {}), ...(a.cont ? { cont: true } : {}) });
    positions.push(offset);
  });
  const decorations: Decoration[] = [];
  listMarkers(blocks).forEach((marker, i) => {
    if (!marker || marker.kind === 'check') return;
    const pos = positions[i]!;
    decorations.push(Decoration.node(pos, pos + doc.child(i).nodeSize, { 'data-marker': marker.text }));
  });
  return DecorationSet.create(doc, decorations);
}

/** Numbers and bullets: they depend on the paragraphs around, so they are worked out for the whole text. */
export const markers = new Plugin<DecorationSet>({
  state: {
    init: (_, state) => markerDecorations(state.doc),
    apply: (tr, set) => (tr.docChanged ? markerDecorations(tr.doc) : set),
  },
  props: {
    decorations(state) {
      return this.getState(state);
    },
  },
});

/** Clicking a checklist item's box ticks it (the box is drawn before the paragraph, in its indent). */
export const ticking = new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view: EditorView, event: MouseEvent) {
        const target = event.target as HTMLElement | null;
        const block = target?.closest?.('.rt-block[data-list="check"]') as HTMLElement | null;
        if (!block || !view.editable) return false;
        const rect = block.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(block).paddingLeft) || 0;
        // The paragraph's own text starts at its padding; the box is in the indent before it.
        const scale = block.offsetWidth > 0 ? rect.width / block.offsetWidth : 1;
        if (event.clientX >= rect.left + pad * scale) return false;
        const pos = view.posAtDOM(block, 0) - 1;
        const node = view.state.doc.nodeAt(pos);
        if (!node || node.type !== schema.nodes.paragraph) return false;
        event.preventDefault();
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !(node.attrs as BlockAttrs).checked }).setMeta('format', true));
        return true;
      },
    },
  },
});

function blockRule(pattern: RegExp, attrs: (match: RegExpMatchArray) => Partial<BlockAttrs>): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const $start = state.doc.resolve(start);
    const node = $start.parent;
    if (node.type !== schema.nodes.paragraph) return null;
    const a = node.attrs as BlockAttrs;
    return state.tr.delete(start, end).setNodeMarkup($start.before(), undefined, { ...a, ...attrs(match) });
  });
}

/** "- " starts a bulleted list, "1. " a numbered one, "[] " a checklist, "# " a heading — at a paragraph's start. */
export const typingRules = inputRules({
  rules: [
    blockRule(/^\s*[-*•]\s$/, () => ({ list: 'bullet' })),
    blockRule(/^\s*\d+[.)]\s$/, () => ({ list: 'number' })),
    blockRule(/^\s*\[([ xX]?)\]\s$/, (m) => ({ list: 'check', checked: (m[1] ?? '').toLowerCase() === 'x' })),
    blockRule(/^(#{1,3})\s$/, (m) => ({ kind: (['h1', 'h2', 'h3'] as const)[(m[1]?.length ?? 1) - 1]!, list: null })),
    emDash,
    ellipsis,
    ...smartQuotes,
  ],
});
