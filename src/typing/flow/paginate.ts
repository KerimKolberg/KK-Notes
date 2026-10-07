/**
 * Page text across pages: where it breaks, as a word processor breaks it.
 *
 * Each page with page text has one box inside its margins (`TextBox.flow`). Consecutive pages with one make a
 * **chain**, and the chain's text is one text: what does not fit on a page continues on the next, splitting a
 * paragraph between lines where it has to (the part on the next page is its *continuation*, `cont`), and what
 * fits back again — after a deletion, say — comes back. Past the last page of the chain a new page is added;
 * a page the text has left, with nothing else on it, is taken away.
 *
 * This module decides it all, given a **measurer** that says how much of some paragraphs fits in a box: in the
 * app the browser lays them out exactly as the editor will (`measure.ts`), in the tests a stand-in counts
 * characters. It also follows one position through it — the caret — so the editor can follow its text to the
 * page it went to.
 */
import { renumber } from '../../document/operations';
import { blockLength, joinBlocks, splitBlock } from '../../document/richText';
import type { RichBase } from '../../document/richText';
import type { Page, RichBlock, RichText, TextBox } from '../../document/types';

/** How much of some paragraphs fits in a box. */
export interface Fit {
  /** How many paragraphs fit whole. */
  readonly blocks: number;
  /**
   * The paragraph after them, if some of its lines fit: where the first line that does not fit starts (a
   * character position in it, above 0 and below its length). `null` if not one of its lines fits.
   */
  readonly split: number | null;
}

export interface FlowMeasurer {
  fit(blocks: readonly RichBlock[], base: RichBase, width: number, height: number): Fit;
}

/** A position in a page's text: which page, which paragraph, which character. */
export interface FlowPosition {
  readonly pageId: string;
  readonly block: number;
  readonly offset: number;
}

/** A paragraph on its way through the reflow, with the caret if it is in it. */
interface Item {
  readonly block: RichBlock;
  readonly caret?: number;
}

export function flowBoxOf(page: Page | undefined): TextBox | null {
  if (!page) return null;
  for (const item of page.media) if (item.kind === 'text' && item.flow) return item;
  return null;
}

/** The first and last index of the chain of pages with page text that `index` is in. */
export function chainAround(pages: readonly Page[], index: number): [number, number] | null {
  if (!flowBoxOf(pages[index])) return null;
  let start = index;
  while (start > 0 && flowBoxOf(pages[start - 1])) start -= 1;
  let end = index;
  while (end < pages.length - 1 && flowBoxOf(pages[end + 1])) end += 1;
  return [start, end];
}

function blocksOf(box: TextBox): RichBlock[] {
  return [...(box.rich?.blocks ?? [])];
}

/** Paragraphs one after another, a continuation joined to what it continues. */
function append(into: Item[], items: readonly Item[]): void {
  for (const item of items) {
    const last = into[into.length - 1];
    if (item.block.cont && last) {
      const length = blockLength(last.block);
      const caret = last.caret ?? (item.caret !== undefined ? length + item.caret : undefined);
      into[into.length - 1] = { block: joinBlocks(last.block, item.block), ...(caret !== undefined ? { caret } : {}) };
    } else {
      into.push(item);
    }
  }
}

/** A page's text, with nothing in it: one empty paragraph. */
const EMPTY: RichBlock[] = [{ runs: [] }];

/** Text with nothing in it — a paragraph that starts a page of its own (Ctrl+Enter) is something, even empty. */
function isEmptyText(blocks: readonly RichBlock[]): boolean {
  return blocks.every((b) => blockLength(b) === 0 && !b.pageBreak);
}

/** A page with nothing on it but empty page text, which the text leaving it may take away. */
function onlyEmptyText(page: Page): boolean {
  if (page.pdf || page.strokes.length > 0 || page.bookmark !== undefined) return false;
  return page.media.every((m) => m.kind === 'text' && m.flow && isEmptyText(blocksOf(m)));
}

export interface ReflowInput {
  readonly pages: readonly Page[];
  /** The page that changed: text before it is settled, apart from what may move back onto the page before it. */
  readonly from: number;
  /** Where the caret is, to follow. */
  readonly caret?: FlowPosition | undefined;
  readonly measurer: FlowMeasurer;
  /** A new page for text that runs past the chain's last page, after `after`. */
  readonly newPage: (after: Page) => Page;
}

export interface ReflowResult {
  readonly pages: readonly Page[];
  /** Where the caret went. */
  readonly caret: FlowPosition | null;
  readonly changed: boolean;
}

/**
 * Let a chain's text flow again after a change on page `from`: fill each page from the one before the change on,
 * pulling text back from the pages after where there is room and pushing it on where there is not, until a page
 * is reached that needs nothing.
 */
export function reflow({ pages: input, from, caret, measurer, newPage }: ReflowInput): ReflowResult {
  const pages = [...input];
  const span = chainAround(pages, from);
  if (!span) return { pages: input, caret: caret ?? null, changed: false };
  const [chainStart] = span;
  let index = Math.max(chainStart, from - 1);
  let changed = false;
  let found: FlowPosition | null = null;

  /** The paragraphs of a page's text, with the caret if it is there; none for a page with no text yet. */
  const itemsOf = (page: Page): Item[] => {
    const box = flowBoxOf(page)!;
    const blocks = blocksOf(box);
    const hasCaret = caret?.pageId === page.id;
    if (!hasCaret && blocks.length === 1 && blockLength(blocks[0]!) === 0) return [];
    return blocks.map((block, i) => (hasCaret && caret!.block === i ? { block, caret: caret!.offset } : { block }));
  };
  /** How much fits, a page break counting as the end of the room. */
  const fitOf = (content: readonly Item[], base: RichBase, box: TextBox): Fit => {
    const breakAt = content.findIndex((c, i) => i > 0 && c.block.pageBreak === true);
    const upTo = breakAt < 0 ? content : content.slice(0, breakAt);
    const fit = measurer.fit(upTo.map((c) => c.block), base, box.width, box.height);
    return breakAt >= 0 && fit.blocks >= upTo.length ? { blocks: breakAt, split: null } : fit;
  };
  /** What is still to be placed from later pages, as it is pulled forward: page index → its paragraphs. */
  const pending = new Map<number, Item[]>();
  const remaining = (i: number): Item[] => {
    let items = pending.get(i);
    if (!items) {
      items = itemsOf(pages[i]!);
      pending.set(i, items);
    }
    return items;
  };
  /** Pages emptied by this reflow, which may be taken away at the end. */
  const emptied = new Set<string>();

  let carry: Item[] = [];
  for (;;) {
    const page = pages[index];
    if (!page || !flowBoxOf(page)) {
      if (carry.length === 0) break;
      // Text runs past the chain: a new page after the last, for it.
      const previous = pages[index - 1]!;
      pages.splice(index, 0, newPage(previous));
      changed = true;
      continue;
    }
    const box = flowBoxOf(page)!;
    const base: RichBase = { fontFamily: box.fontFamily, fontSize: box.fontSize, color: box.color, align: box.align };
    const content: Item[] = [];
    append(content, carry);
    append(content, remaining(index));
    pending.delete(index);
    let pulled = false;
    let fit = fitOf(content, base, box);
    // Room left: bring text back from the pages after, a paragraph at a time, until it is full — but never a
    // paragraph that starts a page of its own.
    while (fit.blocks === content.length) {
      let next = index + 1;
      while (next < pages.length && flowBoxOf(pages[next]) && remaining(next).length === 0) next += 1;
      if (next >= pages.length || !flowBoxOf(pages[next])) break;
      const source = remaining(next);
      if (source[0]!.block.pageBreak && content.length > 0) break;
      const before = [...content];
      const lastLength = before.length > 0 ? blockLength(before[before.length - 1]!.block) : 0;
      const first = source.shift()!;
      append(content, [first]);
      const tried = fitOf(content, base, box);
      // Nothing of it fits after all (the page was full): it stays where it was, and so does the rest.
      const joined = content.length === before.length;
      const nothing = joined
        ? tried.blocks < content.length && (tried.split === null || tried.split <= lastLength)
        : tried.blocks <= before.length && tried.split === null;
      if (nothing) {
        content.splice(0, content.length, ...before);
        source.unshift(first);
        break;
      }
      if (source.length === 0) emptied.add(pages[next]!.id);
      pulled = true;
      fit = tried;
    }

    let keep: Item[];
    carry = [];
    if (fit.blocks >= content.length) {
      keep = content;
    } else {
      keep = content.slice(0, fit.blocks);
      const over = content[fit.blocks]!;
      if (fit.split !== null && fit.split > 0 && fit.split < blockLength(over.block)) {
        const [head, tail] = splitBlock(over.block, fit.split);
        const inHead = over.caret !== undefined && over.caret < fit.split;
        const inTail = over.caret !== undefined && !inHead;
        keep.push({ block: head, ...(inHead ? { caret: over.caret! } : {}) });
        carry.push({ block: tail, ...(inTail ? { caret: over.caret! - fit.split } : {}) });
      } else if (keep.length === 0) {
        // Not one line of it fits on an empty page (a picture-sized heading on a small page): it stays here
        // anyway rather than being pushed on for ever.
        keep.push(over);
      } else {
        carry.push(over);
      }
      carry.push(...content.slice(fit.blocks + 1));
    }

    const blocks = keep.length > 0 ? keep.map((k) => k.block) : [...EMPTY];
    // A page's text never starts with a continuation of nothing.
    if (index === chainStart && blocks[0]?.cont) blocks[0] = { ...blocks[0], cont: false };
    const caretIndex = keep.findIndex((k) => k.caret !== undefined);
    if (caretIndex >= 0) found = { pageId: page.id, block: caretIndex, offset: keep[caretIndex]!.caret! };
    if (!sameBlocks(blocks, blocksOf(box))) {
      pages[index] = withFlowBlocks(page, box, blocks);
      changed = true;
      if (isEmptyText(blocks)) emptied.add(page.id);
    }

    // Settled: nothing pushed on and nothing pulled from the page after, so the rest of the chain is as it was.
    if (carry.length === 0 && !pulled && index >= from) break;
    index += 1;
  }

  // Whatever was pulled forward from a page but not placed — a page the loop stopped before — goes back to it.
  for (const [i, items] of pending) {
    const page = pages[i];
    const box = flowBoxOf(page);
    if (!page || !box) continue;
    const blocks = items.map((it) => it.block);
    if (!sameBlocks(blocks, blocksOf(box))) {
      pages[i] = withFlowBlocks(page, box, blocks.length > 0 ? blocks : EMPTY);
      changed = true;
      if (blocks.length === 0) emptied.add(page.id);
    }
    const caretIndex = items.findIndex((k) => k.caret !== undefined);
    if (caretIndex >= 0) found = { pageId: page.id, block: caretIndex, offset: items[caretIndex]!.caret! };
  }

  // Pages the text has left, at the end of the chain, with nothing else on them — not the one being typed on.
  const out = pages.filter((page, i) => {
    if (!emptied.has(page.id) || !onlyEmptyText(page) || i <= chainStart || page.id === found?.pageId) return true;
    const later = pages.slice(i + 1);
    const restOfChain = later.findIndex((p) => !flowBoxOf(p));
    const tail = restOfChain < 0 ? later : later.slice(0, restOfChain);
    return !tail.every(onlyEmptyText);
  });
  if (out.length !== pages.length) changed = true;
  return { pages: changed ? renumber(out) : input, caret: found ?? (caret ?? null), changed };
}

function sameBlocks(a: readonly RichBlock[], b: readonly RichBlock[]): boolean {
  return a.length === b.length && a.every((block, i) => block === b[i] || JSON.stringify(block) === JSON.stringify(b[i]));
}

function withFlowBlocks(page: Page, box: TextBox, blocks: readonly RichBlock[]): Page {
  const rich: RichText = { blocks };
  const text = blocks.map((b) => b.runs.map((r) => r.text).join('')).join('\n');
  return { ...page, media: page.media.map((m) => (m.id === box.id ? { ...box, rich, text } : m)) };
}
