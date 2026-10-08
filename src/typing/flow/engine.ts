/**
 * Page text, live: letting it flow after each change, the caret following its text from page to page, and the
 * keys that cross from one page's text to the next — Backspace at the start of a page, Delete at the end of one,
 * the arrows and Page Up/Down, and Ctrl+Enter for a new page.
 *
 * A change is made in the note's store and the text flowed straight after it (`paginate.ts`, measured by the
 * browser in `measure.ts`), in the same step of Undo: undoing a keystroke that pushed a line to a new page takes
 * the page away again.
 */
import { flushSync } from 'react-dom';
import { createPage } from '../../document/operations';
import { blockLength, sliceRuns } from '../../document/richText';
import { useDocumentStore, type TextEdit } from '../../document/store';
import type { Page, RichBlock, RichText, TextBox } from '../../document/types';
import { requestFocus, useTypingStore, type CaretTarget } from '../typingStore';
import { bottomZIndex, createFlowBox } from './geometry';
import { domMeasurer } from './measure';
import { chainAround, flowBoxOf, reflow, type FlowMeasurer, type FlowPosition } from './paginate';

let measurer: FlowMeasurer = domMeasurer;

/** For tests: measure some other way than with the browser. */
export function setFlowMeasurer(next: FlowMeasurer): void {
  measurer = next;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function blocksOf(box: TextBox): readonly RichBlock[] {
  return box.rich?.blocks ?? [{ runs: [] }];
}

/** An editor position (ProseMirror's count) as a paragraph and a character in it. */
export function toBlockOffset(rich: RichText, pos: number): { block: number; offset: number } {
  let start = 0;
  for (let i = 0; i < rich.blocks.length; i++) {
    const length = blockLength(rich.blocks[i]!);
    if (pos <= start + 1 + length || i === rich.blocks.length - 1) return { block: i, offset: Math.max(0, Math.min(length, pos - start - 1)) };
    start += length + 2;
  }
  return { block: 0, offset: 0 };
}

/** A paragraph and a character in it as an editor position. */
export function toPos(rich: RichText, block: number, offset: number): number {
  let pos = 0;
  for (let i = 0; i < block && i < rich.blocks.length; i++) pos += blockLength(rich.blocks[i]!) + 2;
  return pos + 1 + offset;
}

function pageIndexOf(pages: readonly Page[], pageId: string): number {
  return pages.findIndex((p) => p.id === pageId);
}

/** Where the caret is, if it is in page text. */
function caretInPageText(pages: readonly Page[]): FlowPosition | undefined {
  const controller = useTypingStore.getState().controller;
  if (!controller) return undefined;
  const page = pages.find((p) => p.id === controller.pageId);
  const box = flowBoxOf(page);
  if (!page || !box || box.id !== controller.mediaId) return undefined;
  const { block, offset } = toBlockOffset({ blocks: blocksOf(box) }, controller.selection().head);
  return { pageId: page.id, block, offset };
}

/** Put the caret at a position in a page's text, scrolling there if the page is out of view. */
function focusAt(pages: readonly Page[], position: FlowPosition): void {
  const index = pageIndexOf(pages, position.pageId);
  const box = flowBoxOf(pages[index]);
  if (!box) return;
  focusBox(index, box, toPos({ blocks: blocksOf(box) }, position.block, position.offset));
}

function focusBox(index: number, box: TextBox, at: CaretTarget): void {
  const store = useDocumentStore.getState();
  if (store.document.activePageIndex !== index) store.setActivePage(index);
  const mounted = document.querySelector(`[data-media-id="${box.id}"] [data-text-content]`);
  if (!mounted) store.jumpToPage(index);
  requestFocus(box.id, at);
}

// ---------------------------------------------------------------------------
// Flowing
// ---------------------------------------------------------------------------

/** A page for text that runs past the last page: like that page, with page text in the same style. */
function newPageAfter(after: Page): Page {
  const page = createPage(
    {
      dimensions: after.dimensions,
      template: after.pdf ? 'blank' : after.template,
      templateConfig: after.templateConfig,
      backgroundColor: after.backgroundColor,
    },
    after.pageNumber + 1,
  );
  const box = createFlowBox(page, 0);
  return { ...page, media: [styledLike(box, flowBoxOf(after))] };
}

/** A new page's text set like the page text it continues: its style, and in front of the ink or behind it. */
function styledLike(box: TextBox, source: TextBox | null | undefined): TextBox {
  if (!source) return box;
  return {
    ...box,
    fontFamily: source.fontFamily,
    fontSize: source.fontSize,
    color: source.color,
    align: source.align,
    ...(source.aboveInk ? { aboveInk: true } : {}),
  };
}

/** Flow a chain's text again from page `pageId` on; the caret, if given (or where it is), follows its text. */
export function flowFrom(pageId: string, caret?: FlowPosition): void {
  const store = useDocumentStore.getState();
  const pages = store.document.pages;
  const from = pageIndexOf(pages, pageId);
  if (from < 0 || !flowBoxOf(pages[from])) return;
  const before = caret ?? caretInPageText(pages);
  const result = reflow({ pages, from, caret: before, measurer, newPage: newPageAfter });
  if (result.changed) store.setFlowedPages(result.pages);
  const after = result.caret;
  if (!after || !before) return;
  const moved = after.pageId !== before.pageId || after.block !== before.block || after.offset !== before.offset;
  if (caret || moved) focusAt(result.pages, after);
}

let pendingPage: string | null = null;
let frame = 0;

/** Flow after a change, once the frame's changes are in (a burst of keys is one reflow). */
export function scheduleFlow(pageId: string): void {
  const pages = useDocumentStore.getState().document.pages;
  if (pendingPage !== null) {
    // The earlier of the two pages: flowing from it covers the later one.
    if (pageIndexOf(pages, pageId) < pageIndexOf(pages, pendingPage)) pendingPage = pageId;
  } else pendingPage = pageId;
  if (frame) return;
  const run = (): void => {
    frame = 0;
    const page = pendingPage;
    pendingPage = null;
    if (page) flowFrom(page);
  };
  frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : (setTimeout(run, 0) as unknown as number);
}

/** Flow now, if a flow is waiting: before a key that crosses pages reads where the text is. */
function settle(): void {
  if (!pendingPage) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  frame = 0;
  const page = pendingPage;
  pendingPage = null;
  flowFrom(page);
}

// ---------------------------------------------------------------------------
// Keys at the edges of a page's text
// ---------------------------------------------------------------------------

function neighbours(pageId: string) {
  const pages = useDocumentStore.getState().document.pages;
  const index = pageIndexOf(pages, pageId);
  const box = flowBoxOf(pages[index]);
  const previous = index > 0 ? flowBoxOf(pages[index - 1]) : null;
  const next = flowBoxOf(pages[index + 1]);
  return { pages, index, box, previous, next };
}

function withBlocks(blocks: readonly RichBlock[]): Partial<TextBox> {
  return { rich: { blocks }, text: blocks.map((b) => b.runs.map((r) => r.text).join('')).join('\n') };
}

function without<K extends keyof RichBlock>(block: RichBlock, key: K): RichBlock {
  const { [key]: _gone, ...rest } = block;
  void _gone;
  return rest as RichBlock;
}

/**
 * Backspace at the start of a page's text: it takes away a page break if the text starts one, joins this
 * paragraph to the last one on the page before, or — when it already continues it — deletes that paragraph's
 * last character. As in a word processor, where the page edge is not there for Backspace.
 */
export function backspaceAtStart(pageId: string): boolean {
  settle();
  const { pages, index, box, previous } = neighbours(pageId);
  if (!box || !previous) return false;
  const page = pages[index]!;
  const prevPage = pages[index - 1]!;
  const blocks = [...blocksOf(box)];
  const first = blocks[0]!;
  const store = useDocumentStore.getState();
  if (first.pageBreak) {
    blocks[0] = without(first, 'pageBreak');
    store.editText(page.id, box.id, withBlocks(blocks), 'type');
    flowFrom(prevPage.id, { pageId: page.id, block: 0, offset: 0 });
    return true;
  }
  const prevBlocks = [...blocksOf(previous)];
  const last = prevBlocks.length - 1;
  const edits: TextEdit[] = [];
  let caretOffset = blockLength(prevBlocks[last]!);
  if (first.cont) {
    // The character before the caret is the last of the page before.
    if (caretOffset === 0) return false;
    caretOffset -= 1;
    prevBlocks[last] = { ...prevBlocks[last]!, runs: sliceRuns(prevBlocks[last]!.runs, 0, caretOffset) };
    edits.push({ pageId: prevPage.id, mediaId: previous.id, patch: withBlocks(prevBlocks) });
  } else {
    blocks[0] = { ...first, cont: true };
    edits.push({ pageId: page.id, mediaId: box.id, patch: withBlocks(blocks) });
  }
  store.editTexts(edits, 'type');
  flowFrom(prevPage.id, { pageId: prevPage.id, block: last, offset: caretOffset });
  return true;
}

/** Delete at the end of a page's text: the mirror of {@link backspaceAtStart}, on the page after. */
export function deleteAtEnd(pageId: string): boolean {
  settle();
  const { pages, index, box, next } = neighbours(pageId);
  if (!box || !next) return false;
  const page = pages[index]!;
  const nextPage = pages[index + 1]!;
  const nextBlocks = [...blocksOf(next)];
  const first = nextBlocks[0]!;
  const blocks = blocksOf(box);
  const caret: FlowPosition = { pageId: page.id, block: blocks.length - 1, offset: blockLength(blocks[blocks.length - 1]!) };
  if (first.pageBreak) nextBlocks[0] = without(first, 'pageBreak');
  else if (first.cont) {
    if (blockLength(first) === 0) return false;
    nextBlocks[0] = { ...first, runs: sliceRuns(first.runs, 1) };
  } else nextBlocks[0] = { ...first, cont: true };
  useDocumentStore.getState().editText(nextPage.id, next.id, withBlocks(nextBlocks), 'type');
  flowFrom(page.id, caret);
  return true;
}

/** The caret leaving a page's text: on to the next page's, or back to the one before. */
export function leave(pageId: string, direction: 'back' | 'forward', how: 'char' | 'line' | 'page'): boolean {
  settle();
  const { pages, index, previous, next } = neighbours(pageId);
  const target = direction === 'forward' ? next : previous;
  if (!target) return false;
  const targetIndex = direction === 'forward' ? index + 1 : index - 1;
  void pages;
  focusBox(targetIndex, target, direction === 'forward' || how === 'page' ? 'start' : 'end');
  return true;
}

/**
 * Ctrl+Enter: what is after the caret starts a new page. The paragraph is cut there (if the caret is inside it)
 * and the part after it marked to start a page of its own; the text flows, and the caret goes with it.
 */
export function pageBreakAt(pageId: string, pos: number): boolean {
  settle();
  const { pages, index, box } = neighbours(pageId);
  if (!box) return false;
  const page = pages[index]!;
  const blocks = [...blocksOf(box)];
  const { block, offset } = toBlockOffset({ blocks }, pos);
  const current = blocks[block]!;
  const rest = without(without(current, 'cont'), 'pageBreak');
  const after: RichBlock = { ...rest, pageBreak: true, runs: sliceRuns(current.runs, offset) };
  if (offset === 0 && !(block === 0 && !current.cont)) {
    blocks[block] = { ...current, pageBreak: true };
  } else {
    blocks.splice(block, 1, { ...current, runs: sliceRuns(current.runs, 0, offset) }, after);
  }
  const target = offset === 0 && !(block === 0 && !current.cont) ? block : block + 1;
  useDocumentStore.getState().editText(page.id, box.id, withBlocks(blocks), 'format');
  flowFrom(page.id, { pageId: page.id, block: target, offset: 0 });
  return true;
}

/** A line with nothing on it: an empty plain paragraph, not a list item, a heading, a page break or a continuation. */
function isBlankLine(block: RichBlock): boolean {
  return blockLength(block) === 0 && !block.list && !block.pageBreak && !block.cont && (block.kind ?? 'p') === 'p';
}

/**
 * The caret has left a page's text: empty lines at its end go — the ones a click under the text added for the caret
 * (`editor/clickType.ts`) that nothing was typed on, or Enter pressed and nothing after. Only where the text ends
 * there: on the last page of it, or before a page that starts a page of its own; further on they are lines of the
 * text. The first line stays, empty or not. Not a step of Undo: nothing anyone typed goes.
 */
export function trimEnd(pageId: string): void {
  const store = useDocumentStore.getState();
  if (store.readOnly) return;
  const { pages, index, box, next } = neighbours(pageId);
  if (!box) return;
  // Still being typed in — the caret came back, or the same text is being drawn again on its other layer.
  const focused = typeof document === 'undefined' ? null : document.activeElement;
  if (focused?.closest?.(`[data-media-id="${box.id}"]`)) return;
  if (next && !blocksOf(next)[0]?.pageBreak) return;
  const blocks = blocksOf(box);
  let end = blocks.length;
  while (end > 1 && isBlankLine(blocks[end - 1]!)) end--;
  if (end === blocks.length) return;
  const page = pages[index]!;
  const trimmed = { ...page, media: page.media.map((m) => (m.id === box.id ? { ...box, ...withBlocks(blocks.slice(0, end)) } : m)) };
  store.setFlowedPages(pages.map((p, i) => (i === index ? trimmed : p)));
}

// ---------------------------------------------------------------------------
// Starting page text
// ---------------------------------------------------------------------------

/**
 * Type on a page: put the caret in its page text — at its end, or nearest a point on the screen — making the text
 * first if the page has none. Returns the box.
 */
export function typeOnPage(index: number, at: CaretTarget = 'end'): TextBox | null {
  const store = useDocumentStore.getState();
  if (store.readOnly) return null;
  const page = store.document.pages[index];
  if (!page) return null;
  let box = flowBoxOf(page);
  if (!box) {
    // Next to page text already there, it is more of that text, and set like it — but it starts on this page and
    // stays on it, as text after a page break does in a word processor: what is typed here neither runs back to the
    // end of the text on the page before nor pulls up the text of the page after.
    const pages = store.document.pages;
    const before = flowBoxOf(pages[index - 1]);
    const after = flowBoxOf(pages[index + 1]);
    box = styledLike(createFlowBox(page, bottomZIndex(page)), before ?? after);
    if (before) box = { ...box, rich: { blocks: [{ runs: [], pageBreak: true }] } };
    store.addMedia(page.id, box);
    const next = pages[index + 1];
    const first = after ? blocksOf(after)[0] : undefined;
    if (next && after && first && !first.pageBreak) {
      store.updateMedia(next.id, after.id, withBlocks([{ ...without(first, 'cont'), pageBreak: true }, ...blocksOf(after).slice(1)]));
    }
  } else {
    store.selectMedia({ pageId: page.id, mediaId: box.id });
  }
  requestFocus(box.id, at);
  return box;
}

/**
 * Put typed text in front of the handwriting, or behind it: a text box on its own, or page text — all of it, every
 * page, since it is one text. One step of Undo. The text moves to the layer over the ink (or back under it) and its
 * editor starts again there, so the caret is put back where it was.
 */
export function setAboveInk(pageId: string, mediaId: string, above: boolean): void {
  const store = useDocumentStore.getState();
  if (store.readOnly) return;
  const item = store.document.pages.find((p) => p.id === pageId)?.media.find((m) => m.id === mediaId);
  if (!item || item.kind !== 'text') return;
  const boxes = item.flow ? chainBoxes(store.document.pages, pageId) : [{ pageId, box: item }];
  const edits = boxes.filter(({ box }) => (box.aboveInk === true) !== above).map(({ pageId: p, box }) => ({ pageId: p, mediaId: box.id, patch: { aboveInk: above } }));
  if (edits.length === 0) return;
  const controller = useTypingStore.getState().controller;
  const caret = controller?.mediaId === mediaId ? controller.selection() : null;
  // Drawn at once, so the request for the caret finds the new editor: asked while the old one is still there,
  // that one would take it, and go.
  flushSync(() => store.editTexts(edits, 'format'));
  if (caret) requestFocus(mediaId, caret.head, caret.anchor);
}

/** Every box of the chain of page text a page is in, in page order. */
export function chainBoxes(pages: readonly Page[], pageId: string): { pageId: string; box: TextBox }[] {
  const index = pageIndexOf(pages, pageId);
  const span = chainAround(pages, index);
  if (!span) return [];
  const out: { pageId: string; box: TextBox }[] = [];
  for (let i = span[0]; i <= span[1]; i++) out.push({ pageId: pages[i]!.id, box: flowBoxOf(pages[i])! });
  return out;
}
