/**
 * The format bar's and the keyboard's commands, on the editor's selection, as a word processor does them:
 *
 * - a **mark** (bold, a colour, a size) on the selected text, or — with nothing selected — on what is typed next;
 * - a **paragraph style** (a heading, a list, an alignment, an indent) on every paragraph the selection touches.
 *
 * A toggle is on when all of the selection has it, so Ctrl+B on a half-bold selection makes it all bold, and
 * again makes none of it bold, as Word does.
 */
import { splitBlockAs, toggleMark } from 'prosemirror-commands';
import type { Mark, MarkType, Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { clampIndent, HEADING_SCALE, type RichBase } from '../../document/richText';
import type { RichAlign, RichList, RichScript, TextFontId } from '../../document/types';
import { nextSize, type FormatCommand, type FormatState } from '../format';
import { schema, type BlockAttrs } from './schema';

/** The paragraphs the selection touches, with their positions. */
function selectedBlocks(state: EditorState): { node: PMNode; pos: number }[] {
  const { from, to } = state.selection;
  const out: { node: PMNode; pos: number }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === schema.nodes.paragraph) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  return out;
}

function setBlocks(fn: (attrs: BlockAttrs) => Partial<BlockAttrs>): Command {
  return (state, dispatch) => {
    const blocks = selectedBlocks(state);
    if (blocks.length === 0) return false;
    if (dispatch) {
      const tr = state.tr;
      for (const { node, pos } of blocks) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...fn(node.attrs as BlockAttrs) });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Whether all the selected text has a mark (with this value, for a mark that has one). */
function allHave(state: EditorState, type: MarkType, value?: unknown): boolean {
  const matches = (marks: readonly Mark[]): boolean => marks.some((m) => m.type === type && (value === undefined || m.attrs.value === value));
  const { from, to, empty } = state.selection;
  if (empty) return matches(state.storedMarks ?? state.selection.$from.marks());
  let any = false;
  let all = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return true;
    any = true;
    if (!matches(node.marks)) all = false;
    return false;
  });
  return any && all;
}

/** Put a mark with a value on the selection (or on what is typed next), or take it off with `null`. */
function setMark(type: MarkType, value: unknown): Command {
  return (state, dispatch) => {
    if (!dispatch) return true;
    const { from, to, empty } = state.selection;
    const tr = state.tr;
    if (empty) {
      tr.removeStoredMark(type);
      if (value !== null) tr.addStoredMark(type.create({ value }));
    } else {
      tr.removeMark(from, to, type);
      if (value !== null) tr.addMark(from, to, type.create({ value }));
    }
    dispatch(tr);
    return true;
  };
}

/** The size the text at the start of the selection is in: its own, or its paragraph's. */
function sizeAt(state: EditorState, base: RichBase): number {
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const own = marks.find((m) => m.type === schema.marks.size);
  if (own) return own.attrs.value as number;
  const kind = (state.selection.$from.parent.attrs as BlockAttrs).kind;
  return base.fontSize * HEADING_SCALE[kind];
}

function toggleList(list: RichList): Command {
  return (state, dispatch) => {
    const blocks = selectedBlocks(state);
    const on = !blocks.every(({ node }) => (node.attrs as BlockAttrs).list === list);
    return setBlocks(() => (on ? { list } : { list: null, checked: false }))(state, dispatch);
  };
}

export function runFormat(command: FormatCommand, base: RichBase): Command {
  const m = schema.marks;
  switch (command.type) {
    case 'toggle':
      return toggleMark(m[command.mark]!);
    case 'script':
      return (state, dispatch) => setMark(m.script!, allHave(state, m.script!, command.value) ? null : command.value)(state, dispatch);
    case 'color':
      return setMark(m.color!, command.value);
    case 'highlight':
      return setMark(m.highlight!, command.value);
    case 'font':
      return setMark(m.font!, command.value);
    case 'size':
      return setMark(m.size!, command.value);
    case 'grow':
      return (state, dispatch) => setMark(m.size!, nextSize(sizeAt(state, base), command.by))(state, dispatch);
    case 'clear':
      return (state, dispatch) => {
        if (!dispatch) return true;
        const { from, to, empty } = state.selection;
        dispatch(empty ? state.tr.setStoredMarks([]) : state.tr.removeMark(from, to));
        return true;
      };
    case 'kind':
      return setBlocks(() => ({ kind: command.value }));
    case 'list':
      return toggleList(command.value);
    case 'indent':
      return indentBy(command.by);
    case 'align':
      return setBlocks(() => ({ align: command.value }));
  }
}

function indentBy(by: 1 | -1): Command {
  return setBlocks((a) => {
    // Out from the first level of a list is out of the list.
    if (by < 0 && a.indent === 0 && a.list) return { list: null, checked: false };
    return { indent: clampIndent(a.indent + by) };
  });
}

/** Kept attributes of a paragraph split by Enter: a heading's next paragraph is normal text, as in Word. */
export const splitParagraph: Command = splitBlockAs((node, atEnd) => {
  const a = node.attrs as BlockAttrs;
  return {
    type: schema.nodes.paragraph!,
    attrs: { ...a, kind: atEnd && a.kind !== 'p' ? 'p' : a.kind, checked: false, cont: false, pageBreak: false },
  };
});

/** Enter on an empty list item ends the list there, rather than making another empty item. */
export const endEmptyItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  const a = $from.parent.attrs as BlockAttrs;
  if (!empty || !a.list || $from.parent.content.size > 0) return false;
  if (dispatch) {
    const pos = $from.before();
    dispatch(state.tr.setNodeMarkup(pos, undefined, { ...a, ...(a.indent > 0 ? { indent: a.indent - 1 } : { list: null, checked: false }) }));
  }
  return true;
};

/** Backspace at the start of a list item or an indented paragraph takes the marker or the indent off first. */
export const liftAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const a = $from.parent.attrs as BlockAttrs;
  if (a.cont) return false;
  if (!a.list && a.indent === 0) return false;
  if (dispatch) {
    const next: Partial<BlockAttrs> = a.list ? { list: null, checked: false } : { indent: a.indent - 1 };
    dispatch(state.tr.setNodeMarkup($from.before(), undefined, { ...a, ...next }));
  }
  return true;
};

/** Tab: a level in, in a list; otherwise a tab character. Shift+Tab: a level out. */
export function tab(by: 1 | -1): Command {
  return (state, dispatch) => {
    const blocks = selectedBlocks(state);
    const inList = blocks.some(({ node }) => (node.attrs as BlockAttrs).list);
    if (inList || by < 0) return indentBy(by)(state, dispatch);
    if (dispatch) dispatch(state.tr.insertText('\t').scrollIntoView());
    return true;
  };
}

/** Tick or untick the checklist items the selection touches. */
export const tick: Command = (state, dispatch) => {
  const blocks = selectedBlocks(state).filter(({ node }) => (node.attrs as BlockAttrs).list === 'check');
  if (blocks.length === 0) return false;
  const on = !blocks.every(({ node }) => (node.attrs as BlockAttrs).checked);
  if (dispatch) {
    const tr = state.tr;
    for (const { node, pos } of blocks) tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: on });
    dispatch(tr);
  }
  return true;
};

/** Shift+Enter: a new line in the same paragraph. */
export const lineBreak: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView());
  return true;
};

/** How the selection is set, for the format bar. */
export function formatStateOf(state: EditorState, base: RichBase): FormatState {
  const m = schema.marks;
  const marks = state.storedMarks ?? state.selection.$from.marks();
  const value = <T,>(type: MarkType): T | null => (marks.find((mk) => mk.type === type)?.attrs.value as T | undefined) ?? null;
  const a = state.selection.$from.parent.attrs as BlockAttrs;
  return {
    bold: allHave(state, m.bold!),
    italic: allHave(state, m.italic!),
    underline: allHave(state, m.underline!),
    strike: allHave(state, m.strike!),
    script: value<RichScript>(m.script!),
    color: value<string>(m.color!) ?? base.color,
    highlight: value<string>(m.highlight!),
    size: sizeAt(state, base),
    font: value<TextFontId>(m.font!) ?? base.fontFamily,
    kind: a.kind,
    list: a.list,
    align: (a.align ?? base.align) as RichAlign,
    indent: a.indent,
  };
}

/** The selected text, as plain words (a paragraph per line), for counting. */
export function selectedText(state: EditorState): string {
  const { from, to, empty } = state.selection;
  return empty ? '' : state.doc.textBetween(from, to, '\n', '\n');
}

/** Put the caret at a position, clamped into the document. */
export function caretAt(tr: Transaction, pos: number): Transaction {
  const clamped = Math.max(0, Math.min(pos, tr.doc.content.size));
  return tr.setSelection(TextSelection.near(tr.doc.resolve(clamped)));
}
