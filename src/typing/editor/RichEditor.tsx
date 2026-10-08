/**
 * A text box being typed in: a ProseMirror editor over the box's rich text.
 *
 * The note's store is the one copy of the text. Every change the editor makes is handed up as rich text
 * (`onChange`), and a change that comes down from the store — an Undo, text flowing in from the next page — is
 * taken in by replacing the editor's document, with the caret kept where it was relative to the text around it.
 * The editor keeps no history of its own: Undo is the note's (`store.editText`), so typing, formatting and
 * text flowing between pages all come back as one.
 */
import 'prosemirror-view/style/prosemirror.css';
import { baseKeymap, chainCommands } from 'prosemirror-commands';
import { undoInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Command, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLatestRef } from '../../inking/hooks/useLatestRef';
import { useDocumentStore, type TextEditKind } from '../../document/store';
import { richBaseOf, richOf, type RichBase } from '../../document/richText';
import type { RichText, TextBox } from '../../document/types';
import type { FormatCommand } from '../format';
import { rootCss, cssText, RT_ROOT } from '../richDom';
import { shortcutActions, type ShortcutAction } from '../shortcuts';
import {
  releaseController,
  setController,
  showShortcuts,
  showWordCount,
  takeFocusRequest,
  useTypingStore,
  type CaretTarget,
  type EditorController,
} from '../typingStore';
import {
  endEmptyItem,
  formatStateOf,
  liftAtStart,
  lineBreak,
  runFormat,
  selectedText,
  splitParagraph,
  tab,
  tick,
} from './commands';
import { clickAndType } from './clickType';
import { fromDoc, toDoc } from './convert';
import { markers, ticking, typingRules } from './plugins';

/** What happens at the edges of a page's text, which continues on the pages before and after it (`flow/`). */
export interface EditorEdges {
  /** Backspace with the caret at the very start of the text. */
  backspaceAtStart(): boolean;
  /** Delete with the caret at the very end. */
  deleteAtEnd(): boolean;
  /** The caret leaving the text: past its first or last line, or a page up or down. */
  leave(direction: 'back' | 'forward', how: 'char' | 'line' | 'page'): boolean;
  /** Ctrl+Enter: what is after the caret starts the next page. */
  pageBreak(pos: number): boolean;
  /** The caret has left the text: empty lines at its end that nothing was typed on go (`clickType.ts`). */
  trimEnd(): void;
}

export interface RichEditorProps {
  readonly box: TextBox;
  readonly pageId: string;
  readonly editable: boolean;
  readonly placeholder: string;
  /** The text changed; `height` is how tall it is now, page px. */
  readonly onChange: (rich: RichText, kind: TextEditKind, height: number) => void;
  readonly edges?: EditorEdges;
}

/**
 * `fill`: page text, which takes the whole of its box, so that a tap below its last line is a tap in it — the caret
 * goes to the end, as a word processor's page does — rather than on nothing.
 */
function attributesFor(base: RichBase, placeholder: string, editable: boolean, fill: boolean) {
  return (state: EditorState): Record<string, string> => {
    const empty = state.doc.childCount === 1 && state.doc.firstChild!.content.size === 0;
    return {
      class: RT_ROOT,
      style: cssText(rootCss(base)) + (fill ? ';min-height:100%' : ''),
      spellcheck: 'true',
      'aria-label': 'Text',
      'data-text-content': '',
      ...(empty && editable && placeholder ? { 'data-empty': '', 'data-placeholder': placeholder } : {}),
    };
  };
}

function editKind(tr: Transaction): TextEditKind {
  if (tr.getMeta('format')) return 'format';
  const ui = tr.getMeta('uiEvent') as string | undefined;
  if (tr.getMeta('paste') || ui === 'paste' || ui === 'drop' || ui === 'cut') return 'paste';
  return 'type';
}

/** Where a position lands after the document changed from `a` to `b` around it. */
function mapAcross(a: PMNode, b: PMNode, pos: number, prefer: 'before' | 'after'): number {
  const start = a.content.findDiffStart(b.content);
  if (start === null) return Math.min(pos, b.content.size);
  const end = a.content.findDiffEnd(b.content);
  if (!end) return Math.min(pos, b.content.size);
  let { a: endA, b: endB } = end;
  // Repeated text can make the two ends overlap the start; move them past it.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  if (pos < start || (pos === start && prefer === 'before')) return pos;
  if (pos >= endA) return pos + (endB - endA);
  return prefer === 'before' ? start : endB;
}

export function RichEditor({ box, pageId, editable, placeholder, onChange, edges }: RichEditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useLatestRef({ box, pageId, editable, placeholder, onChange, edges });
  /** The rich text this editor last handed up: when the store's is the same object, there is nothing to take in. */
  const emitted = useRef<RichText | null>(box.rich ?? null);
  /** Why the next change from the store comes, when the editor itself asked for it. */
  const coming = useRef<'undo' | 'redo' | null>(null);
  const base = richBaseOf(box);
  const baseKey = `${base.fontFamily}|${base.fontSize}|${base.color}|${base.align}`;

  useLayoutEffect(() => {
    const view: EditorView = new EditorView(mount.current!, {
      state: EditorState.create({ doc: toDoc(richOf(latest.current.box)), plugins: plugins() }),
      editable: () => latest.current.editable,
      attributes: attributesFor(richBaseOf(latest.current.box), latest.current.placeholder, latest.current.editable, latest.current.box.flow === true),
      dispatchTransaction(tr) {
        const state = view.state.apply(tr);
        view.updateState(state);
        if (tr.docChanged) {
          const rich = fromDoc(state.doc);
          emitted.current = rich;
          latest.current.onChange(rich, editKind(tr), view.dom.offsetHeight);
        }
        publish();
      },
      handleDOMEvents: {
        // Page text: a click under the text, or on an empty line, puts the caret there (`clickType.ts`).
        mousedown: (v, event) => {
          const { box: b, editable: on } = latest.current;
          if (!b.flow || !on || event.button !== 0 || event.shiftKey || event.detail > 1) return false;
          if (!clickAndType(v, event.clientX, event.clientY, b.fontSize)) return false;
          event.preventDefault();
          return true;
        },
        blur: () => {
          // Once the focus has gone somewhere — another page's text, the same text drawn again on its other layer.
          if (latest.current.box.flow) setTimeout(() => latest.current.edges?.trimEnd(), 0);
          return false;
        },
        focus: () => {
          const { box: b, pageId: p } = latest.current;
          setController(controller);
          const selected = useDocumentStore.getState().selectedMedia;
          if (selected?.mediaId !== b.id) useDocumentStore.getState().selectMedia({ pageId: p, mediaId: b.id });
          publish();
          return false;
        },
      },
    });
    viewRef.current = view;

    function exec(command: FormatCommand): void {
      runFormat(command, richBaseOf(latest.current.box))(view.state, (tr) => view.dispatch(tr.setMeta('format', true)), view);
      view.focus();
    }

    const controller: EditorController = {
      get pageId() {
        return latest.current.pageId;
      },
      get mediaId() {
        return latest.current.box.id;
      },
      exec,
      focus: () => view.focus(),
      selection: () => ({ anchor: view.state.selection.anchor, head: view.state.selection.head }),
    };

    /** Tell the format bar how the selection is set, while this is the box being typed in. */
    function publish(): void {
      if (useTypingStore.getState().controller !== controller) return;
      useTypingStore.setState({
        format: formatStateOf(view.state, richBaseOf(latest.current.box)),
        selectedText: selectedText(view.state),
      });
    }

    function action(a: ShortcutAction): Command {
      return (state, dispatch) => {
        if (!latest.current.editable) return false;
        switch (a.type) {
          case 'undo':
          case 'redo': {
            if (!dispatch) return true;
            coming.current = a.type;
            const store = useDocumentStore.getState();
            if (a.type === 'undo') store.undoLast();
            else store.redoLast();
            coming.current = null;
            return true;
          }
          case 'wordCount':
            if (dispatch) showWordCount();
            return true;
          case 'help':
            if (dispatch) showShortcuts();
            return true;
          case 'leave':
            if (dispatch) {
              view.dom.blur();
              releaseController(latest.current.box.id);
            }
            return true;
          case 'tick':
            return tick(state, dispatch ? (tr) => dispatch(tr.setMeta('format', true)) : undefined);
          case 'pageBreak':
            return latest.current.edges?.pageBreak(state.selection.from) ?? false;
          default:
            if (!dispatch) return true;
            exec(a);
            return true;
        }
      };
    }

    function atStart(state: EditorState): boolean {
      return state.selection.empty && state.selection.from <= 1;
    }
    function atEnd(state: EditorState): boolean {
      return state.selection.empty && state.selection.to >= state.doc.content.size - 1;
    }
    /** The caret on the first or last line of the text (so an arrow would leave it). */
    function onEdgeLine(direction: 'back' | 'forward'): boolean {
      if (!view.state.selection.empty) return false;
      return view.endOfTextblock(direction === 'back' ? 'up' : 'down') &&
        (direction === 'back' ? view.state.selection.$from.index(0) === 0 : view.state.selection.$from.index(0) === view.state.doc.childCount - 1);
    }

    function plugins() {
      const actions: Record<string, Command> = {};
      for (const [key, a] of shortcutActions()) actions[key] = action(a);
      const edgeKeys: Record<string, Command> = {
        Backspace: (state) => atStart(state) && (latest.current.edges?.backspaceAtStart() ?? false),
        Delete: (state) => atEnd(state) && (latest.current.edges?.deleteAtEnd() ?? false),
        ArrowUp: () => onEdgeLine('back') && (latest.current.edges?.leave('back', 'line') ?? false),
        ArrowDown: () => onEdgeLine('forward') && (latest.current.edges?.leave('forward', 'line') ?? false),
        ArrowLeft: (state) => atStart(state) && (latest.current.edges?.leave('back', 'char') ?? false),
        ArrowRight: (state) => atEnd(state) && (latest.current.edges?.leave('forward', 'char') ?? false),
        PageUp: () => latest.current.edges?.leave('back', 'page') ?? false,
        PageDown: () => latest.current.edges?.leave('forward', 'page') ?? false,
      };
      return [
        typingRules,
        keymap(edgeKeys),
        keymap({
          ...actions,
          Enter: chainCommands(endEmptyItem, splitParagraph),
          'Shift-Enter': lineBreak,
          Backspace: chainCommands(undoInputRule, liftAtStart),
          Tab: tab(1),
          'Shift-Tab': tab(-1),
        }),
        keymap(baseKeymap),
        markers,
        ticking,
      ];
    }

    // A request to put the caret here that came before the editor did (a box just inserted, text that flowed in).
    const pageTextSize = (): number | null => (latest.current.box.flow ? latest.current.box.fontSize : null);
    const request = takeFocusRequest(latest.current.box.id);
    if (request) place(view, request.at, request.anchor, pageTextSize());

    const unsubscribe = useTypingStore.subscribe((s, prev) => {
      if (s.focusRequest === prev.focusRequest || !s.focusRequest) return;
      const r = takeFocusRequest(latest.current.box.id);
      if (r) place(view, r.at, r.anchor, pageTextSize());
    });

    return () => {
      unsubscribe();
      releaseController(latest.current.box.id);
      view.destroy();
      viewRef.current = null;
    };
    // The editor is made once; what changes is taken in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Editable or not, and the box's own style.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.setProps({ attributes: attributesFor(richBaseOf(box), placeholder, editable, box.flow === true) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, placeholder, editable]);

  // Text that changed in the store, not here: Undo, Redo, text flowing in or out.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (box.rich !== undefined && box.rich === emitted.current) return;
    const doc = toDoc(richOf(box));
    if (doc.eq(view.state.doc)) {
      emitted.current = box.rich ?? null;
      return;
    }
    const old = view.state;
    const why = coming.current;
    const { anchor, head } = old.selection;
    const prefer = why === 'redo' ? 'after' : 'before';
    const selection = TextSelection.between(
      doc.resolve(mapAcross(old.doc, doc, anchor, prefer)),
      doc.resolve(mapAcross(old.doc, doc, head, prefer)),
    );
    view.updateState(EditorState.create({ doc, plugins: old.plugins, selection }));
    emitted.current = box.rich ?? null;
  }, [box]);

  return (
    <div
      ref={mount}
      data-rich-editor
      style={box.flow ? { height: '100%' } : undefined}
      // A press in the text places the caret; it must not start dragging the box.
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}

/** The place in the text nearest a point on the screen: on the nearest line, at the nearest character of it. */
function nearest(view: EditorView, x: number, y: number): number {
  const rect = view.dom.getBoundingClientRect();
  // Brought inside the text first: a tap in the margin beside a line is a tap on that line, and one below the
  // last line a tap on it.
  const left = Math.min(Math.max(x, rect.left + 1), Math.max(rect.left + 1, rect.right - 1));
  const top = Math.min(Math.max(y, rect.top + 1), Math.max(rect.top + 1, rect.bottom - 1));
  return view.posAtCoords({ left, top })?.pos ?? view.state.doc.content.size - 1;
}

/**
 * Focus an editor and put its caret (or a selection) where it was asked for. A point in page text (`pageText`, its
 * size) below its end, or on an empty line, is Click and Type's (`clickType.ts`).
 */
function place(view: EditorView, at: CaretTarget, anchor?: number, pageText: number | null = null): void {
  if (typeof at === 'object' && anchor === undefined && pageText !== null && clickAndType(view, at.x, at.y, pageText)) return;
  const size = view.state.doc.content.size;
  const pos =
    at === 'start' ? 1 : at === 'end' ? size - 1 : typeof at === 'number' ? Math.max(0, Math.min(at, size)) : Math.max(0, Math.min(nearest(view, at.x, at.y), size));
  const from = anchor === undefined ? pos : Math.max(0, Math.min(anchor, size));
  const selection = TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(pos));
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView());
  view.focus();
}
