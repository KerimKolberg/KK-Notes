/**
 * What the format bar needs to know about typing: which box is being typed in (and how to run a command in it),
 * how its selection is set, and requests to put the caret in a box — a new one, or the next page's when text
 * flows on (`flow/`).
 *
 * The box being typed in stays "current" while the focus is briefly elsewhere — a font picked from a list takes
 * the focus away — and stops being it when another box is, or when nothing is selected any more.
 */
import { create } from 'zustand';
import type { ToolType } from '../inking/types';
import type { FormatCommand, FormatState } from './format';

export interface EditorController {
  readonly pageId: string;
  readonly mediaId: string;
  /** Run a command on the selection, and give the editor its focus back. */
  exec(command: FormatCommand): void;
  focus(): void;
  /** The selection, as the editor counts positions. */
  selection(): { readonly anchor: number; readonly head: number };
}

/**
 * Where to put the caret: the start, the end, a position in the box's text (the editor's), or the place in it
 * nearest a point on the screen — where a page was tapped.
 */
export type CaretTarget = 'start' | 'end' | number | { readonly x: number; readonly y: number };

export interface FocusRequest {
  readonly mediaId: string;
  readonly at: CaretTarget;
  /** Select from here to `at`, rather than putting the caret there. */
  readonly anchor?: number;
}

interface TypingState {
  readonly controller: EditorController | null;
  /** How the selection in the box being typed in is set. */
  readonly format: FormatState | null;
  /** The selected text there, for "12 of 340 words". */
  readonly selectedText: string;
  readonly focusRequest: FocusRequest | null;
  readonly sheetOpen: boolean;
  readonly countOpen: boolean;
  /**
   * Typing with the keyboard (`typingMode.ts`): the toolbar is the text toolbar and a tap on a page puts the caret
   * there, until the pen button takes the toolbar back to drawing.
   */
  readonly keyboard: boolean;
  /** The tool the pen button goes back to: the one that was writing before the keyboard was. */
  readonly returnTool: ToolType;
}

export const useTypingStore = create<TypingState>()(() => ({
  controller: null,
  format: null,
  selectedText: '',
  focusRequest: null,
  sheetOpen: false,
  countOpen: false,
  keyboard: false,
  returnTool: 'pen',
}));

export function setController(controller: EditorController): void {
  if (useTypingStore.getState().controller === controller) return;
  useTypingStore.setState({ controller });
}

/** The box stops being typed in (if it still is). */
export function releaseController(mediaId: string): void {
  if (useTypingStore.getState().controller?.mediaId === mediaId) {
    useTypingStore.setState({ controller: null, format: null, selectedText: '' });
  }
}

export function requestFocus(mediaId: string, at: CaretTarget, anchor?: number): void {
  useTypingStore.setState({ focusRequest: { mediaId, at, ...(anchor !== undefined ? { anchor } : {}) } });
}

export function takeFocusRequest(mediaId: string): FocusRequest | null {
  const request = useTypingStore.getState().focusRequest;
  if (!request || request.mediaId !== mediaId) return null;
  useTypingStore.setState({ focusRequest: null });
  return request;
}

export function showShortcuts(open = true): void {
  useTypingStore.setState({ sheetOpen: open });
}

export function showWordCount(open = true): void {
  useTypingStore.setState({ countOpen: open });
}
