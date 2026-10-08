/**
 * Typing with the keyboard, as Samsung Notes has it: the keyboard button at the start of the toolbar turns the
 * toolbar into the text toolbar and puts the caret in the page's text, a tap on a page then puts the caret there,
 * and the pen button at the start of the text toolbar takes the toolbar back to drawing, with the tool that was
 * writing before.
 *
 * The text toolbar also shows whenever a text box is selected with the select tool: it is the one place typed text
 * is formatted, however the text was reached.
 */
import { useEffect } from 'react';
import { createTextBox, nextZIndex } from '../document/media';
import { useDocumentStore } from '../document/store';
import { useToolStore } from '../document/toolStore';
import type { ToolType } from '../inking/types';
import { typeOnPage } from './flow/engine';
import { releaseController, requestFocus, useTypingStore } from './typingStore';

/** Tools that write or erase: the ones the pen button goes back to. Anything else, it goes back to the pen. */
const WRITING_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>([
  'pen',
  'highlighter',
  'washi-tape',
  'line',
  'coordinate-plane',
  'eraser-stroke',
  'eraser-pixel',
]);

/** The keyboard button: the text toolbar, the select tool, and the caret at the end of the page's text in view. */
export function startTyping(): void {
  const doc = useDocumentStore.getState();
  if (doc.readOnly) return;
  const tool = useToolStore.getState().settings.tool;
  useTypingStore.setState((s) => ({ keyboard: true, returnTool: WRITING_TOOLS.has(tool) ? tool : s.returnTool }));
  if (tool !== 'select') useToolStore.getState().update({ tool: 'select' });
  typeOnPage(doc.document.activePageIndex);
}

/** The pen button: out of the text (and the keyboard on a tablet goes with it), and back to the writing tool. */
export function stopTyping(): void {
  const { returnTool, controller } = useTypingStore.getState();
  useTypingStore.setState({ keyboard: false });
  if (typeof document !== 'undefined') {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest('[data-rich-editor]')) focused.blur();
  }
  if (controller) releaseController(controller.mediaId);
  useDocumentStore.getState().selectMedia(null);
  useToolStore.getState().update({ tool: returnTool });
}

/** A tap on a page while typing, not on anything placed on it: the caret goes into the page's text, nearest the tap. */
export function typeAt(pageId: string, x: number, y: number): void {
  const pages = useDocumentStore.getState().document.pages;
  const index = pages.findIndex((p) => p.id === pageId);
  if (index >= 0) typeOnPage(index, { x, y });
}

/** A new text box on the page in view, typed into straight away, as a word processor's new text box is. */
export function insertTextBox(init?: Parameters<typeof createTextBox>[3]): void {
  const state = useDocumentStore.getState();
  if (state.readOnly) return;
  const page = state.document.pages[state.document.activePageIndex];
  if (!page) return;
  const box = createTextBox(page.dimensions, nextZIndex(page.media), undefined, init);
  requestFocus(box.id, 'end');
  state.addMedia(page.id, box);
  // Typed into and moved with the select tool.
  if (useToolStore.getState().settings.tool !== 'select') useToolStore.getState().update({ tool: 'select' });
}

/**
 * Whether the toolbar is the text toolbar, and keeping typing in step with the rest of the note: another tool (a
 * shortcut, the pen's own button), a locked note or another note ends typing with the keyboard, and the box being
 * typed in stops being it once something else is selected.
 */
export function useTypingMode(): { readonly active: boolean; readonly keyboard: boolean; readonly returnTool: ToolType } {
  const keyboard = useTypingStore((s) => s.keyboard);
  const returnTool = useTypingStore((s) => s.returnTool);
  const controller = useTypingStore((s) => s.controller);
  const tool = useToolStore((s) => s.settings.tool);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const documentId = useDocumentStore((s) => s.document.id);
  const selectedId = useDocumentStore((s) => s.selectedMedia?.mediaId ?? null);
  const textSelected = useDocumentStore((s) => {
    const sel = s.selectedMedia;
    if (!sel) return false;
    return s.document.pages.find((p) => p.id === sel.pageId)?.media.find((m) => m.id === sel.mediaId)?.kind === 'text';
  });

  useEffect(() => {
    if (keyboard && (tool !== 'select' || readOnly)) useTypingStore.setState({ keyboard: false });
  }, [keyboard, tool, readOnly]);
  useEffect(() => {
    if (useTypingStore.getState().keyboard) useTypingStore.setState({ keyboard: false });
  }, [documentId]);
  useEffect(() => {
    if (controller && selectedId !== controller.mediaId) releaseController(controller.mediaId);
  }, [controller, selectedId]);

  return { active: !readOnly && tool === 'select' && (keyboard || textSelected), keyboard, returnTool };
}
