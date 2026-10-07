/**
 * Undo for changes to a note's *pages*, which the per-page stroke history cannot reach.
 *
 * Each page keeps its own undo stack of strokes, and that is what Undo has always done. But importing a PDF,
 * adding, duplicating, deleting or moving a page, and placing a snip change the list of pages (or what is on
 * one) without being a stroke, so none of them could be taken back. Each now leaves an entry here: the pages
 * as they were before.
 *
 * ## Which Undo takes back first
 *
 * The two histories are interleaved by *when*, without a shared log. An entry remembers, for every page, how
 * deep that page's stroke history was when the change was made (`depths`). Undo looks at the page in view:
 * if its stroke history is deeper than the entry remembers, a stroke was drawn after the change, so that
 * stroke is undone first; if not, the change itself is the most recent thing, and it is undone. So "import,
 * then draw, then undo" removes the stroke and "import, then go back to an older page and undo" removes the
 * import, which is what each of them means.
 *
 * Redo mirrors it: a page's own redo first (it is the newer), then a change that was undone — but only while
 * the pages are still what the undo left, so a redo can never be applied to a note that has moved on.
 */
import type { Page } from './types';

/** The most changes kept to undo (bursts of typing among them, so a writing session's worth). */
export const MAX_STRUCTURE_ENTRIES = 100;

export interface PagesSnapshot {
  readonly pages: readonly Page[];
  readonly activePageIndex: number;
}

export interface StructureEntry {
  /** What was done, as the end of "Undid …": "adding 12 pages". */
  readonly label: string;
  /** The pages as they were before it. */
  readonly before: PagesSnapshot;
  /** Each page's stroke-history depth just after it, by page id. */
  readonly depths: Readonly<Record<string, number>>;
  /**
   * A change to typed text (a burst of typing, a format): undone where it was made, without the jump to the page
   * and the lost selection a change to the pages brings.
   */
  readonly text?: true;
}

export interface RedoEntry {
  readonly label: string;
  /** The pages as they were when it was undone, to go back to. */
  readonly after: PagesSnapshot;
  /** The pages it was undone *to*, which is what must still be on screen for a redo to make sense. */
  readonly restored: readonly Page[];
  readonly depths: Readonly<Record<string, number>>;
  readonly text?: true;
}

export function depthsOf(pages: readonly Page[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const page of pages) out[page.id] = page.undoStack.length;
  return out;
}

export function pushEntry(entries: readonly StructureEntry[], entry: StructureEntry): StructureEntry[] {
  return [...entries, entry].slice(-MAX_STRUCTURE_ENTRIES);
}

export function pushRedo(entries: readonly RedoEntry[], entry: RedoEntry): RedoEntry[] {
  return [...entries, entry].slice(-MAX_STRUCTURE_ENTRIES);
}

/**
 * Whether the most recent change should be undone now, rather than a stroke on the page in view.
 * True when there is a change, and the page in view has drawn nothing since it was made.
 */
export function undoesStructureFirst(top: StructureEntry | undefined, page: Page | undefined): boolean {
  if (!top) return false;
  if (!page) return true;
  return page.undoStack.length <= (top.depths[page.id] ?? 0);
}

/** Pages that look the same: same pages in the same order with the same ink, objects and look. */
export function samePages(a: readonly Page[], b: readonly Page[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i]!;
    return (
      p === q ||
      (p.id === q.id &&
        p.strokes === q.strokes &&
        p.media === q.media &&
        p.dimensions === q.dimensions &&
        p.template === q.template &&
        p.templateConfig === q.templateConfig &&
        p.backgroundColor === q.backgroundColor &&
        p.pdf === q.pdf &&
        p.bookmark === q.bookmark)
    );
  });
}

/** Whether a change that was undone can be done again on these pages. */
export function canRedoStructure(top: RedoEntry | undefined, pages: readonly Page[]): boolean {
  return top !== undefined && samePages(pages, top.restored);
}
